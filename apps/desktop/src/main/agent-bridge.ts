import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  DesktopConversationMessage,
  DesktopConversationSnapshot,
  DesktopConversationStatus,
} from '../shared/types.js';

interface ConversationInternal {
  runtimeId: string;
  status: DesktopConversationStatus;
  sessionId?: string | undefined;
  error?: string | undefined;
  messages: DesktopConversationMessage[];
  ws: WebSocket | null;
  connectPromise: Promise<void> | null;
  activeAssistantMessageId: string | null;
}

interface ServerMessage {
  type: string;
  payload?: Record<string, unknown> | undefined;
}

const MAX_MESSAGES = 300;

export class DesktopAgentBridge extends EventEmitter {
  private readonly conversations = new Map<string, ConversationInternal>();

  snapshot(runtimeId: string): DesktopConversationSnapshot {
    return publicConversation(this.getOrCreate(runtimeId));
  }

  async ensureConnected(runtimeId: string, wsUrl: string): Promise<DesktopConversationSnapshot> {
    const conversation = this.getOrCreate(runtimeId);
    if (conversation.ws?.readyState === WebSocket.OPEN) return publicConversation(conversation);
    if (conversation.connectPromise) {
      await conversation.connectPromise;
      return publicConversation(conversation);
    }

    conversation.status = 'connecting';
    conversation.error = undefined;
    this.emitChanged(conversation);

    conversation.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      conversation.ws = ws;

      ws.once('open', () => {
        conversation.status = 'connected';
        conversation.error = undefined;
        conversation.connectPromise = null;
        this.emitChanged(conversation);
        resolve();
      });

      ws.on('message', (data) => {
        this.handleServerMessage(conversation, data.toString());
      });

      ws.once('error', (err) => {
        conversation.status = 'error';
        conversation.error = err instanceof Error ? err.message : String(err);
        conversation.connectPromise = null;
        this.appendMessage(conversation, {
          role: 'system',
          text: `Connection error: ${conversation.error}`,
        });
        reject(err);
      });

      ws.once('close', () => {
        if (conversation.ws === ws) conversation.ws = null;
        conversation.connectPromise = null;
        if (conversation.status !== 'error') {
          conversation.status = 'disconnected';
        }
        conversation.activeAssistantMessageId = null;
        this.emitChanged(conversation);
      });
    });

    await conversation.connectPromise;
    return publicConversation(conversation);
  }

  async sendMessage(
    runtimeId: string,
    wsUrl: string,
    content: string,
  ): Promise<DesktopConversationSnapshot> {
    const trimmed = content.trim();
    if (!trimmed) return this.snapshot(runtimeId);
    await this.ensureConnected(runtimeId, wsUrl);
    const conversation = this.getOrCreate(runtimeId);
    this.appendMessage(conversation, {
      id: `user_${randomUUID()}`,
      role: 'user',
      text: trimmed,
    });
    conversation.status = 'running';
    conversation.activeAssistantMessageId = null;
    this.emitChanged(conversation);
    this.send(conversation, {
      type: 'user_message',
      payload: {
        id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}`,
        content: trimmed,
        timestamp: Date.now(),
        ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
      },
    });
    return publicConversation(conversation);
  }

  async abort(runtimeId: string, wsUrl: string): Promise<DesktopConversationSnapshot> {
    await this.ensureConnected(runtimeId, wsUrl);
    const conversation = this.getOrCreate(runtimeId);
    this.send(conversation, {
      type: 'abort',
      payload: conversation.sessionId ? { sessionId: conversation.sessionId } : {},
    });
    conversation.status = 'connected';
    this.appendMessage(conversation, { role: 'system', text: 'Abort requested.' });
    return publicConversation(conversation);
  }

  close(runtimeId: string): void {
    const conversation = this.conversations.get(runtimeId);
    if (!conversation) return;
    conversation.ws?.close();
    conversation.ws = null;
    conversation.connectPromise = null;
    conversation.status = 'disconnected';
    conversation.activeAssistantMessageId = null;
    this.emitChanged(conversation);
  }

  closeAll(): void {
    for (const runtimeId of this.conversations.keys()) {
      this.close(runtimeId);
    }
  }

  private handleServerMessage(conversation: ConversationInternal, raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    const payload = message.payload ?? {};
    switch (message.type) {
      case 'session.start': {
        const sessionId = stringValue(payload['sessionId']);
        if (sessionId) conversation.sessionId = sessionId;
        conversation.status = conversation.status === 'running' ? 'running' : 'connected';
        this.emitChanged(conversation);
        break;
      }
      case 'provider.text_delta': {
        conversation.status = 'running';
        this.appendAssistantDelta(conversation, stringValue(payload['text']) ?? '');
        break;
      }
      case 'tool.started': {
        conversation.status = 'running';
        const name = stringValue(payload['name']) ?? 'tool';
        this.appendMessage(conversation, { role: 'tool', text: `Started ${name}` });
        break;
      }
      case 'tool.executed': {
        const name = stringValue(payload['name']) ?? 'tool';
        const ok = payload['ok'] === true;
        this.appendMessage(conversation, {
          role: 'tool',
          text: `${name} ${ok ? 'completed' : 'failed'}`,
        });
        break;
      }
      case 'provider.error':
      case 'provider.stream_error':
      case 'error': {
        const text =
          stringValue(payload['message']) ??
          stringValue(payload['description']) ??
          `${message.type} received`;
        conversation.status = 'error';
        conversation.error = text;
        this.appendMessage(conversation, { role: 'system', text });
        break;
      }
      case 'run.result': {
        const finalText = stringValue(payload['finalText']);
        if (finalText && !this.lastAssistantHasText(conversation)) {
          this.appendMessage(conversation, { role: 'assistant', text: finalText });
        }
        conversation.status = payload['status'] === 'failed' ? 'error' : 'connected';
        conversation.activeAssistantMessageId = null;
        this.emitChanged(conversation);
        break;
      }
    }
  }

  private send(conversation: ConversationInternal, message: Record<string, unknown>): void {
    if (conversation.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('Runtime socket is not connected');
    }
    conversation.ws.send(JSON.stringify(message));
  }

  private appendAssistantDelta(conversation: ConversationInternal, text: string): void {
    if (!text) return;
    let message = conversation.messages.find((m) => m.id === conversation.activeAssistantMessageId);
    if (!message) {
      message = {
        id: `assistant_${randomUUID()}`,
        role: 'assistant',
        text: '',
        timestamp: Date.now(),
      };
      conversation.activeAssistantMessageId = message.id;
      conversation.messages.push(message);
    }
    message.text += text;
    this.trimMessages(conversation);
    this.emitChanged(conversation);
  }

  private appendMessage(
    conversation: ConversationInternal,
    input: Partial<DesktopConversationMessage> & Pick<DesktopConversationMessage, 'role' | 'text'>,
  ): void {
    conversation.messages.push({
      id: input.id ?? `${input.role}_${randomUUID()}`,
      role: input.role,
      text: input.text,
      timestamp: input.timestamp ?? Date.now(),
    });
    this.trimMessages(conversation);
    this.emitChanged(conversation);
  }

  private lastAssistantHasText(conversation: ConversationInternal): boolean {
    const lastAssistant = [...conversation.messages].reverse().find((m) => m.role === 'assistant');
    return Boolean(lastAssistant?.text.trim());
  }

  private trimMessages(conversation: ConversationInternal): void {
    if (conversation.messages.length <= MAX_MESSAGES) return;
    conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES);
  }

  private getOrCreate(runtimeId: string): ConversationInternal {
    let conversation = this.conversations.get(runtimeId);
    if (conversation) return conversation;
    conversation = {
      runtimeId,
      status: 'disconnected',
      messages: [],
      ws: null,
      connectPromise: null,
      activeAssistantMessageId: null,
    };
    this.conversations.set(runtimeId, conversation);
    return conversation;
  }

  private emitChanged(conversation: ConversationInternal): void {
    this.emit('changed', publicConversation(conversation));
  }
}

function publicConversation(conversation: ConversationInternal): DesktopConversationSnapshot {
  return {
    runtimeId: conversation.runtimeId,
    status: conversation.status,
    sessionId: conversation.sessionId,
    error: conversation.error,
    messages: conversation.messages.map((message) => ({ ...message })),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
