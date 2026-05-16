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
import { ensureDir } from '../utils/atomic-write.js';

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

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    await ensureDir(this.dir);
    const startedAt = new Date().toISOString();
    const id = meta.id ?? `${startedAt.replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
    const file = path.join(this.dir, `${id}.jsonl`);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
    } catch (err) {
      // Preserve cause + errno so callers can branch on EACCES vs EMFILE
      // vs ENOSPC etc. instead of substring-matching the error message.
      throw new Error(
        `Failed to open session file: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
        },
      );
    }
    try {
      return new FileSessionWriter(id, handle, startedAt, meta, { dir: this.dir, filePath: file });
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  async resume(id: string): Promise<ResumedSession> {
    const data = await this.load(id);
    const file = path.join(this.dir, `${id}.jsonl`);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
    } catch (err) {
      throw new Error(
        `Failed to open session "${id}" for append: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const writer = new FileSessionWriter(
      id,
      handle,
      new Date().toISOString(),
      {
        id,
        model: data.metadata.model,
        provider: data.metadata.provider,
      },
      { resumed: true, dir: this.dir, filePath: file },
    );
    return { writer, data };
  }

  async load(id: string): Promise<SessionData> {
    const file = path.join(this.dir, `${id}.jsonl`);
    const raw = await fsp.readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const events: SessionEvent[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        // Session JSONL is on-disk user-writable state; downstream replay
        // trusts `e.type` / `e.ts` etc. and would TypeError on a malformed
        // shape. Validate the discriminator + timestamp before pushing.
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { type?: unknown }).type === 'string' &&
          typeof (parsed as { ts?: unknown }).ts === 'string'
        ) {
          events.push(parsed as SessionEvent);
        }
        // else: skip — a hand-edited file with a partial object should not
        // crash replay, just lose that one event.
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
      const files = await fsp.readdir(this.dir);
      const ids = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
      // Read all manifests in parallel; fall back to full load only for
      // sessions that haven't been closed cleanly (or predate the manifest).
      const sessions = await Promise.all(ids.map((id) => this.summaryFor(id).catch(() => null)));
      const out = sessions.filter((s): s is SessionSummary => s !== null);
      out.sort((a, b) => {
        if (a.startedAt < b.startedAt) return 1;
        if (a.startedAt > b.startedAt) return -1;
        // Equal timestamps — use id as tiebreaker for stable sort
        return a.id.localeCompare(b.id);
      });
      return out.slice(0, limit);
    } catch {
      return [];
    }
  }

  private async summaryFor(id: string): Promise<SessionSummary> {
    const manifest = path.join(this.dir, `${id}.summary.json`);
    try {
      const raw = await fsp.readFile(manifest, 'utf8');
      return JSON.parse(raw) as SessionSummary;
    } catch {
      // Manifest missing/corrupt — fall back to a full parse and backfill
      // the manifest so the next `list()` hits the fast path.
      const full = path.join(this.dir, `${id}.jsonl`);
      const stat = await fsp.stat(full);
      const summary = await this.summarize(id, stat.mtime.toISOString());
      await fsp
        .writeFile(manifest, JSON.stringify(summary), { mode: 0o600 })
        .catch((err) => {
          // Best-effort manifest write — list() falls back to full parse
          // on next invocation, so surface the error for diagnostics but
          // don't fail the listing.
          console.warn(
            `[session-store] Failed to write manifest for "${id}":`,
            err instanceof Error ? err.message : String(err),
          );
        });
      return summary;
    }
  }

  async delete(id: string): Promise<void> {
    await fsp.unlink(path.join(this.dir, `${id}.jsonl`));
    await fsp.unlink(path.join(this.dir, `${id}.summary.json`)).catch(() => undefined);
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
          // Orphan tool_result: tool_use was never seen. Skip to avoid
          // corrupting the replayed message sequence.
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
            // Convert string content to blocks and append
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
        detail: `${openToolUses.size} tool_use blocks without matching results — replay truncated`,
      });
      // Return what we could replay instead of throwing — a damaged session
      // should not block the entire session-listing or resume path.
      return { messages, usage };
    }
    return { messages, usage };
  }
}

class FileSessionWriter implements SessionWriter {
  private closed = false;
  private manifestFile: string;
  private summary: SessionSummary;
  private tokenIn = 0;
  private tokenOut = 0;
  private readonly filePath: string;
  /** Public accessor for the JSONL path — required by SessionWriter so
   *  observability surfaces (`/fleet log`, FleetPanel) can locate the
   *  transcript without recomputing the path from session metadata. */
  get transcriptPath(): string | undefined {
    return this.filePath || undefined;
  }
  private initDone = false;
  private readonly resumed: boolean;
  private appendFailCount = 0;
  private lastAppendWarnAt = 0;

  constructor(
    public readonly id: string,
    private readonly handle: fsp.FileHandle,
    private readonly startedAt: string,
    private readonly meta: Omit<SessionMetadata, 'startedAt'>,
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
    // Session start is written lazily on first append to avoid sync I/O
    // in constructor and eliminate reliance on FileHandle.fd private property.
  }

  private async writeSessionStart(): Promise<void> {
    if (this.initDone || this.closed) return;
    this.initDone = true;
    const record = `${JSON.stringify({
      type: this.resumed ? 'session_resumed' : 'session_start',
      ts: this.startedAt,
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    })}\n`;
    try {
      if (this.filePath) {
        // Use fs.promises.writeFile directly to avoid FileHandle.fd private access
        await fsp.writeFile(this.filePath, record, { flag: 'a', mode: 0o600 });
      }
    } catch {
      // best-effort; session will still be usable without the start event logged
    }
  }

  async append(event: SessionEvent): Promise<void> {
    if (this.closed) return;
    if (!this.initDone) {
      await this.writeSessionStart();
    }
    this.observeForSummary(event);
    try {
      await this.handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      // A persistent failure (full disk, broken pipe) would otherwise log
      // once per appended event — which for a chatty agent run is a lot.
      // Debounce to one log per 5 s and surface the suppressed count.
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

  /**
   * Watch events as they're appended and keep the summary state hot, so
   * `close()` can flush a `<id>.summary.json` manifest without re-reading
   * the JSONL. `list()` reads only manifests, turning a per-session full
   * parse into a single stat+read.
   */
  private observeForSummary(event: SessionEvent): void {
    if (event.type === 'user_input' && this.summary.title === '(empty session)') {
      this.summary = { ...this.summary, title: userInputTitle(event.content) };
    } else if (event.type === 'llm_response') {
      this.tokenIn += event.usage.input;
      this.tokenOut += event.usage.output;
      this.summary = { ...this.summary, tokenTotal: this.tokenIn + this.tokenOut };
    } else if (event.type === 'session_end') {
      // session_end usage is the canonical total — prefer it if non-zero.
      const total = event.usage.input + event.usage.output;
      if (total > 0) this.summary = { ...this.summary, tokenTotal: total };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.manifestFile) {
      try {
        await fsp.writeFile(this.manifestFile, JSON.stringify(this.summary), { mode: 0o600 });
      } catch {
        // manifest write is best-effort; list() falls back to full load.
      }
    }
    try {
      await this.handle.close();
    } catch {
      // ignore
    }
  }
}

function userInputTitle(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content.slice(0, 60);
  const text = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  return (text || '(non-text input)').slice(0, 60);
}
