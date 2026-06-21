import { getWSClient } from '@/lib/ws-client';
import { useFileStore } from '@/stores';
import type { TreeNode } from '@/stores/file-store';
import { useMailboxStore, type MailboxAgent, type MailboxMessage } from '@/stores/mailbox-store';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';

function queryMailbox() {
  const ws = getWSClient();
  ws?.send?.({ type: 'mailbox.messages', payload: { limit: 30, incompleteOnly: true } });
  ws?.send?.({ type: 'mailbox.agents', payload: {} });
}

export { queryMailbox };

export function handleFilesTree(msg: WSServerMessage) {
  const p = msg.payload as { root: string; tree: TreeNode[]; error?: string | undefined };
  if (p.error) {
    useFileStore.getState().setError(p.error);
    return;
  }
  useFileStore.getState().setTree(p.root, p.tree);
}

export function handleFilesRead(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; content: string; error?: string | undefined };
  if (p.error) {
    useFileStore.getState().setError(p.error);
    return;
  }
  useFileStore.getState().openFile(p.filePath, p.content);
}

export function handleFilesWritten(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; success: boolean; error?: string | undefined };
  if (p.success) {
    useFileStore.getState().markSaved(p.filePath);
  } else if (p.error) {
    useFileStore.getState().setError(`Save failed: ${p.error}`);
  }
}

export function handleMailboxEvent(msg: WSServerMessage) {
  const vizEv = wsToVizEvent('mailbox.event', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
  queryMailbox();
}

export function handleMailboxMessages(msg: WSServerMessage) {
  const p = msg.payload as { messages?: MailboxMessage[] } | undefined;
  if (p?.messages) useMailboxStore.getState().setMessages(p.messages);
}

export function handleMailboxAgents(msg: WSServerMessage) {
  const p = msg.payload as { agents?: MailboxAgent[] } | undefined;
  if (p?.agents) useMailboxStore.getState().setAgents(p.agents);
}

export function handleMailboxReceived(msg: WSServerMessage) {
  const vizEv = wsToVizEvent('mailbox.received', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
  queryMailbox();
}

export function handleMailboxAgentRegistered(_msg: WSServerMessage) {
  queryMailbox();
}

export function handleMailboxCleared(_msg: WSServerMessage) {
  useMailboxStore.getState().setMessages([]);
  queryMailbox();
}

export function handleMailboxPurged(_msg: WSServerMessage) {
  queryMailbox();
}

export const filesMailboxHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'files.tree': handleFilesTree,
  'files.read': handleFilesRead,
  'files.written': handleFilesWritten,
  'mailbox.event': handleMailboxEvent,
  'mailbox.messages': handleMailboxMessages,
  'mailbox.agents': handleMailboxAgents,
  'mailbox.received': handleMailboxReceived,
  'mailbox.agent_registered': handleMailboxAgentRegistered,
  'mailbox.cleared': handleMailboxCleared,
  'mailbox.purged': handleMailboxPurged,
};
