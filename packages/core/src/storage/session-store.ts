import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type {
  ResumedSession,
  SessionData,
  SessionEvent,
  SessionMetadata,
  SessionStore,
  SessionSummary,
  SessionWriter,
} from '../types/session.js';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';

export interface SessionStoreOptions {
  dir: string;
  /** Optional EventBus for emitting session diagnostics. */
  events?: EventBus;
}

export class DefaultSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly events?: EventBus;

  constructor(opts: SessionStoreOptions) {
    this.dir = opts.dir;
    this.events = opts.events;
  }

  /**
   * Compute the shard directory for a session ID.
   * Session IDs start with a timestamp (e.g. `2026-05-30T10-00-00-00000000-a1b2`).
   * Shards by year/month to keep readdir fast with large session counts.
   * Returns a path relative to this.dir, e.g. `2026/05`.
   */
  private shardPath(id: string): string {
    // id format: YYYY-MM-DDTHH-mm-ss-ffffff-XX
    const parts = id.split('-');
    if (parts.length >= 2) {
      const year = parts[0];
      const month = parts[1];
      return `${year}/${month}`;
    }
    return 'misc';
  }

  /** Join session ID to a shard-aware absolute path. */
  private sessionPath(id: string, ext: '.jsonl' | '.summary.json'): string {
    return path.join(this.dir, this.shardPath(id), `${id}${ext}`);
  }

  private async ensureShardDir(id: string): Promise<string> {
    const shard = path.join(this.dir, this.shardPath(id));
    await ensureDir(shard);
    return shard;
  }

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    const startedAt = new Date().toISOString();
    const id = meta.id ?? `${startedAt.replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
    const shardDir = await this.ensureShardDir(id);
    const file = path.join(shardDir, `${id}.jsonl`);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
    } catch (err) {
      throw new Error(
        `Failed to open session file: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    try {
      return new FileSessionWriter(id, handle, startedAt, meta, this.events, { dir: shardDir, filePath: file });
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  async resume(id: string): Promise<ResumedSession> {
    const file = this.sessionPath(id, '.jsonl');
    const data = await this.load(id);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'r+', 0o600);
    } catch (err) {
      throw new Error(
        `Failed to open session "${id}" for append: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    try {
      const writer = new FileSessionWriter(
        id,
        handle,
        new Date().toISOString(),
        {
          id,
          model: data.metadata.model,
          provider: data.metadata.provider,
        },
        this.events,
        { resumed: true, dir: path.join(this.dir, this.shardPath(id)), filePath: file },
      );
      return { writer, data };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  async load(id: string): Promise<SessionData> {
    const file = this.sessionPath(id, '.jsonl');
    const raw = await fsp.readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const events: SessionEvent[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { type?: unknown }).type === 'string' &&
          typeof (parsed as { ts?: unknown }).ts === 'string'
        ) {
          events.push(parsed as SessionEvent);
        }
      } catch {
        // skip malformed JSON
      }
    }
    const meta = this.metaFromEvents(id, events);
    const { messages, usage } = this.replay(events, id);
    return { metadata: meta, events, messages, usage };
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    try {
      await ensureDir(this.dir);
      const ids = await this.collectSessionIds(this.dir);
      const sessions = await Promise.all(ids.map((id) => this.summaryFor(id).catch(() => null)));
      const out = sessions.filter((s): s is SessionSummary => s !== null);
      out.sort((a, b) => {
        if (a.startedAt < b.startedAt) return 1;
        if (a.startedAt > b.startedAt) return -1;
        return a.id.localeCompare(b.id);
      });
      return out.slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Recursively collect all session IDs from shard subdirectories. */
  private async collectSessionIds(dir: string): Promise<string[]> {
    const ids: string[] = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        ids.push(...(await this.collectSessionIds(full)));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        ids.push(entry.name.replace(/\.jsonl$/, ''));
      }
    }
    return ids;
  }

  private async summaryFor(id: string): Promise<SessionSummary> {
    const manifest = this.sessionPath(id, '.summary.json');
    try {
      const raw = await fsp.readFile(manifest, 'utf8');
      return JSON.parse(raw) as SessionSummary;
    } catch {
      const full = this.sessionPath(id, '.jsonl');
      const stat = await fsp.stat(full);
      const summary = await this.summarize(id, stat.mtime.toISOString());
      await atomicWrite(manifest, JSON.stringify(summary), { mode: 0o600 })
        .catch((err) => {
          console.warn(
            `[session-store] Failed to write manifest for "${id}":`,
            err instanceof Error ? err.message : String(err),
          );
        });
      return summary;
    }
  }

  async delete(id: string): Promise<void> {
    await fsp.unlink(this.sessionPath(id, '.jsonl'));
    await fsp.unlink(this.sessionPath(id, '.summary.json')).catch(() => undefined);
  }

  async clearHistory(id: string): Promise<void> {
    await this.ensureShardDir(id);
    const file = this.sessionPath(id, '.jsonl');
    const meta = this.sessionPath(id, '.summary.json');
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id,
      model: 'unknown',
      provider: 'unknown',
    })}\n`;
    await fsp.writeFile(file, record, 'utf8');
    await fsp.unlink(meta).catch(() => undefined);
  }

  private async summarize(id: string, mtime: string): Promise<SessionSummary> {
    try {
      const data = await this.load(id);
      const firstUser = data.events.find((e) => e.type === 'user_input');
      const title =
        firstUser && firstUser.type === 'user_input'
          ? userInputTitle(firstUser.content)
          : '(empty session)';
      return {
        id,
        title,
        startedAt: data.metadata.startedAt,
        model: data.metadata.model ?? 'unknown',
        provider: data.metadata.provider ?? 'unknown',
        tokenTotal: data.usage.input + data.usage.output,
      };
    } catch {
      return {
        id,
        title: '(damaged)',
        startedAt: mtime,
        model: 'unknown',
        provider: 'unknown',
        tokenTotal: 0,
      };
    }
  }

  private metaFromEvents(id: string, events: SessionEvent[]): SessionMetadata {
    const start = events.find((e) => e.type === 'session_start');
    const end = events.find((e) => e.type === 'session_end');
    return {
      id,
      startedAt: start?.ts ?? new Date(0).toISOString(),
      endedAt: end?.ts,
      model: start?.model,
      provider: start?.provider,
      pendingToolUses: end?.pendingToolUses,
    };
  }

  private replay(
    events: SessionEvent[],
    sessionId = 'unknown',
  ): { messages: Message[]; usage: SessionData['usage'] } {
    const messages: Message[] = [];
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const openToolUses = new Set<string>();
    for (const e of events) {
      if (e.type === 'user_input') {
        openToolUses.clear();
        messages.push({ role: 'user', content: e.content });
      } else if (e.type === 'llm_response') {
        messages.push({ role: 'assistant', content: e.content });
        for (const b of e.content) {
          if (b.type === 'tool_use') openToolUses.add(b.id);
        }
        usage = {
          input: usage.input + (e.usage.input ?? 0),
          output: usage.output + (e.usage.output ?? 0),
          cacheRead: (usage.cacheRead ?? 0) + (e.usage.cacheRead ?? 0),
          cacheWrite: (usage.cacheWrite ?? 0) + (e.usage.cacheWrite ?? 0),
        };
      } else if (e.type === 'tool_result') {
        if (!openToolUses.has(e.id)) {
          this.events?.emit('session.damaged', {
            sessionId,
            detail: `Orphan tool_result "${e.id}" has no matching tool_use`,
          });
          continue;
        }
        openToolUses.delete(e.id);
        const content: ContentBlock[] = [
          {
            type: 'tool_result',
            tool_use_id: e.id,
            content: typeof e.content === 'string' ? e.content : JSON.stringify(e.content),
            is_error: e.isError,
          },
        ];
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          if (Array.isArray(last.content)) {
            last.content.push(...content);
          } else if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content }, ...content];
          } else {
            messages.push({ role: 'user', content });
          }
        } else {
          messages.push({ role: 'user', content });
        }
      }
    }
    if (openToolUses.size > 0) {
      this.events?.emit('session.damaged', {
        sessionId,
        detail: `${openToolUses.size} tool_use blocks without matching results - replay repaired`,
      });
    }
    const repaired = repairToolUseAdjacency(messages);
    if (repaired.report.changed) {
      this.events?.emit('session.damaged', {
        sessionId,
        detail:
          `Repaired replay adjacency: removed ${repaired.report.removedToolUses.length} tool_use, ` +
          `${repaired.report.removedToolResults.length} tool_result, ` +
          `${repaired.report.removedMessages} empty messages`,
      });
    }
    return { messages: repaired.messages, usage };
  }
}

class FileSessionWriter implements SessionWriter {
  private closed = false;
  private closing = false;
  private manifestFile: string;
  private summary: SessionSummary;
  private tokenIn = 0;
  private tokenOut = 0;
  private readonly filePath: string;
  get transcriptPath(): string | undefined {
    return this.filePath || undefined;
  }
  private initDone = false;
  private readonly resumed: boolean;
  private appendFailCount = 0;
  private lastAppendWarnAt = 0;

  private promptIndex = 0;
  private pendingFileSnapshots: Array<{
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }> = [];
  /** Tracks open tool_use IDs during the current run to serialize on close for resume. */
  private openToolUses = new Set<string>();

  recordFileChange(input: { path: string; action: 'created' | 'modified' | 'deleted'; before: string | null; after: string | null }): void {
    this.pendingFileSnapshots.push(input);
  }

  constructor(
    public readonly id: string,
    private handle: fsp.FileHandle,
    private readonly startedAt: string,
    private readonly meta: Omit<SessionMetadata, 'startedAt'>,
    private readonly events?: EventBus,
    opts: { resumed?: boolean; dir?: string; filePath?: string } = {},
  ) {
    this.resumed = opts.resumed ?? false;
    this.manifestFile = opts.dir ? path.join(opts.dir, `${id}.summary.json`) : '';
    this.filePath = opts.filePath ?? '';
    this.summary = {
      id,
      title: '(empty session)',
      startedAt,
      model: meta.model ?? 'unknown',
      provider: meta.provider ?? 'unknown',
      tokenTotal: 0,
    };
  }

  get pendingToolUses(): string[] {
    return Array.from(this.openToolUses);
  }

  private async writeSessionStartLazy(): Promise<void> {
    const record = `${JSON.stringify({
      type: this.resumed ? 'session_resumed' : 'session_start',
      ts: this.startedAt,
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    })}\n`;
    try {
      if (this.filePath) {
        await fsp.writeFile(this.filePath, record, { flag: 'a', mode: 0o600 });
      }
    } catch {
      // best-effort
    }
  }

  async append(event: SessionEvent): Promise<void> {
    if (this.closed) return;
    if (!this.initDone) {
      this.initDone = true;
      await this.writeSessionStartLazy();
    }
    this.observeForSummary(event);
    try {
      await this.handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      this.appendFailCount++;
      const now = Date.now();
      if (now - this.lastAppendWarnAt > 5000) {
        const suppressed = this.appendFailCount - 1;
        const tail = suppressed > 0 ? ` (+${suppressed} suppressed)` : '';
        console.warn(
          '[session] append failed:',
          err instanceof Error ? err.message : String(err),
          tail,
        );
        this.lastAppendWarnAt = now;
        this.appendFailCount = 0;
      }
    }
  }

  private observeForSummary(event: SessionEvent): void {
    // Track open tool uses so we can serialize them on close for resume.
    if (event.type === 'tool_use') {
      this.openToolUses.add(event.id);
    } else if (event.type === 'tool_result') {
      this.openToolUses.delete(event.id);
    }
    if (event.type === 'user_input' && this.summary.title === '(empty session)') {
      this.summary = { ...this.summary, title: userInputTitle(event.content) };
    } else if (event.type === 'llm_response') {
      this.tokenIn += event.usage.input;
      this.tokenOut += event.usage.output;
      this.summary = { ...this.summary, tokenTotal: this.tokenIn + this.tokenOut };
    } else if (event.type === 'session_end') {
      const total = event.usage.input + event.usage.output;
      if (total > 0) this.summary = { ...this.summary, tokenTotal: total };
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.closed = true;
    if (this.manifestFile) {
      try {
        await atomicWrite(this.manifestFile, JSON.stringify(this.summary), { mode: 0o600 });
      } catch {
        // manifest write is best-effort
      }
    }
    try {
      await this.handle.close();
    } catch {
      // ignore
    }
  }

  async writeCheckpoint(promptIndex: number, promptPreview: string): Promise<void> {
    const fileCount = this.pendingFileSnapshots.length;
    if (fileCount > 0) {
      await this.writeFileSnapshot(promptIndex, [...this.pendingFileSnapshots]);
      this.pendingFileSnapshots = [];
    }
    this.promptIndex = promptIndex + 1;
    await this.append({
      type: 'checkpoint',
      ts: new Date().toISOString(),
      promptIndex,
      promptPreview,
    });
    this.events?.emit('checkpoint.written', {
      promptIndex,
      promptPreview,
      ts: new Date().toISOString(),
      fileCount,
    });
  }

  async writeFileSnapshot(
    promptIndex: number,
    files: import('../types/session.js').FileSnapshot[],
  ): Promise<void> {
    await this.append({
      type: 'file_snapshot',
      ts: new Date().toISOString(),
      promptIndex,
      files,
    });
  }

  async truncateToCheckpoint(targetPromptIndex: number): Promise<number> {
    if (!this.filePath) return 0;
    const raw = await fsp.readFile(this.filePath, 'utf8');
    const lines = raw.split('\n');
    const kept: string[] = [];
    let removedCount = 0;

    let targetCheckpointLine = -1;
    let afterTarget = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;

      let event: { type?: string; promptIndex?: number };
      try {
        event = JSON.parse(line);
      } catch {
        kept.push(line);
        continue;
      }

      if (event.type === 'checkpoint') {
        if ((event as { promptIndex: number }).promptIndex === targetPromptIndex) {
          targetCheckpointLine = kept.length;
          afterTarget = true;
        } else if ((event as { promptIndex: number }).promptIndex > targetPromptIndex) {
          afterTarget = true;
        }
      }

      if (event.promptIndex !== undefined && event.promptIndex > targetPromptIndex) {
        removedCount++;
      } else if (event.promptIndex === undefined) {
        if (!afterTarget || targetCheckpointLine === -1) {
          kept.push(line);
        } else {
          removedCount++;
        }
      } else {
        kept.push(line);
      }
    }

    const truncated = kept.join('\n');
    // Windows EPERM fix: close the append-mode handle, write via temp file
    // and rename, then reopen. This is needed because rename() fails on
    // Windows when the target has an open file handle.
    const tmpPath = `${this.filePath}.rewind.tmp`;
    await fsp.writeFile(tmpPath, truncated + '\n', 'utf8');
    try {
      await this.handle.close();
      await fsp.rename(tmpPath, this.filePath);
      // Re-open in append mode for continued use of this file.
      this.handle = await fsp.open(this.filePath, 'a', 0o600);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    await this.append({
      type: 'rewound',
      ts: new Date().toISOString(),
      toPromptIndex: targetPromptIndex,
      revertedFiles: [],
    });

    this.events?.emit('session.rewound', {
      toPromptIndex: targetPromptIndex,
      revertedFiles: [],
      removedEvents: removedCount,
    });

    return removedCount;
  }

  async clearSession(): Promise<void> {
    if (!this.filePath) return;
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    })}\n`;
    await fsp.writeFile(this.filePath, record, 'utf8');
  }
}

function userInputTitle(content: string | ContentBlock[]): string {
  const text = typeof content === 'string'
    ? content
    : content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
  return (text || '(non-text input)').slice(0, 60);
}