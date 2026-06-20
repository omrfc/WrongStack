import * as path from 'node:path';
import type { Context } from '../core/context.js';
import type {
  ContextEvidenceState,
  ToolOutputMetadata,
} from '../types/context-evidence.js';

const MAX_TOOL_CALLS = 80;
const MAX_FACTS = 40;
const MAX_ERRORS = 20;
const MAX_DIGEST_CHARS = 4_000;

const WRITE_TOOLS = new Set(['edit', 'write', 'replace', 'patch']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'tree']);

export function createContextEvidenceState(): ContextEvidenceState {
  return {
    sessionGoals: [],
    implicitFacts: [],
    activeErrors: [],
    toolCalls: [],
    fileGraph: {},
    repeatedReads: [],
    updatedAt: Date.now(),
  };
}

export interface RecordToolOutputEvidenceInput {
  toolUseId: string;
  toolName: string;
  input: unknown;
  content: string;
  ok: boolean;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
}

export function recordUserIntentEvidence(ctx: Context, text: string): void {
  const intent = normalizeWhitespace(text).slice(0, 700);
  if (!intent) return;
  const state = ensureEvidence(ctx);
  state.currentIntent = { text: intent, updatedAt: Date.now() };
  if (state.sessionGoals.length === 0 || isGoalish(intent)) {
    pushUniqueBounded(state.sessionGoals, intent, 8);
  }
  state.updatedAt = Date.now();
}

export function recordToolOutputEvidence(
  ctx: Context,
  input: RecordToolOutputEvidenceInput,
): ToolOutputMetadata {
  const state = ensureEvidence(ctx);
  const files = extractFiles(ctx, input.toolName, input.input, input.content);
  const symbols = extractSymbols(input.content, input.input);
  const commands = extractCommands(input.toolName, input.input);
  const errors = extractErrors(input.content);
  const summary = summarizeToolOutput(input.toolName, input.input, input.content, {
    files,
    symbols,
    errors,
    ok: input.ok,
  });

  const metadata: ToolOutputMetadata = {
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    ok: input.ok,
    inputSummary: summarizeInput(input.input),
    summary,
    files,
    symbols,
    commands,
    errors,
    status: 'seen',
    referenceCount: 0,
    seenAt: Date.now(),
    outputBytes: input.outputBytes,
    outputTokens: input.outputTokens,
    outputLines: input.outputLines,
  };

  state.toolCalls.push(metadata);
  if (state.toolCalls.length > MAX_TOOL_CALLS) {
    state.toolCalls.splice(0, state.toolCalls.length - MAX_TOOL_CALLS);
  }

  updateFileGraph(state, metadata);
  updateRepeatedReadSignals(state, metadata);
  if (errors.length > 0) {
    for (const err of errors) pushUniqueBounded(state.activeErrors, err, MAX_ERRORS);
  }
  const fact = implicitFactFor(metadata);
  if (fact) pushUniqueBounded(state.implicitFacts, fact, MAX_FACTS);
  state.updatedAt = Date.now();
  return metadata;
}

export function markAssistantReferencedEvidence(ctx: Context, text: string): void {
  const state = ensureEvidence(ctx);
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return;

  for (const tool of state.toolCalls) {
    if (!metadataReferencedByText(tool, haystack)) continue;
    tool.status = 'referenced';
    tool.referenceCount++;
    tool.referencedAt = Date.now();
    for (const file of tool.files) {
      const node = state.fileGraph[file];
      if (node) node.referenced = true;
    }
  }
  state.updatedAt = Date.now();
}

export function buildContextEvidenceDigest(ctx: Context): string {
  const state = ensureEvidence(ctx);
  const lines: string[] = [];

  if (state.currentIntent?.text) {
    lines.push(`intent: ${state.currentIntent.text}`);
  }

  const goals = state.sessionGoals.slice(-3);
  if (goals.length > 0) {
    lines.push('session_goals:');
    for (const goal of goals) lines.push(`- ${goal}`);
  }

  const activeErrors = state.activeErrors.slice(-5);
  if (activeErrors.length > 0) {
    lines.push('active_errors:');
    for (const err of activeErrors) lines.push(`- ${err}`);
  }

  const files = Object.values(state.fileGraph)
    .sort((a, b) => (b.writes - a.writes) || (b.reads - a.reads) || a.path.localeCompare(b.path))
    .slice(0, 12);
  if (files.length > 0) {
    lines.push('dependency_graph:');
    for (const file of files) {
      const actions = [
        file.reads > 0 ? `read ${file.reads}x` : '',
        file.writes > 0 ? `write ${file.writes}x` : '',
      ].filter(Boolean).join(', ');
      const refs = file.referenced ? '; referenced by assistant' : '';
      const via = file.lastToolUseId ? `; last via ${file.lastToolUseId}` : '';
      lines.push(`- ${file.path} (${actions || 'seen'}${refs}${via})`);
    }
  }

  const referenced = state.toolCalls
    .filter((tool) => tool.status === 'referenced')
    .slice(-10);
  const recentSeen = state.toolCalls
    .filter((tool) => tool.status === 'seen')
    .slice(-5);
  const trail = [...referenced, ...recentSeen];
  if (trail.length > 0) {
    lines.push('tool_trail:');
    for (const tool of trail) {
      const size = tool.outputTokens ? `; ~${tool.outputTokens} tokens` : '';
      const filesText = tool.files.length > 0 ? `; files=${tool.files.slice(0, 4).join(', ')}` : '';
      const symbolsText = tool.symbols.length > 0 ? `; symbols=${tool.symbols.slice(0, 4).join(', ')}` : '';
      lines.push(
        `- ${tool.toolUseId} ${tool.toolName} ${tool.status}: ${tool.summary}${filesText}${symbolsText}${size}`,
      );
    }
  }

  const facts = state.implicitFacts.slice(-8);
  if (facts.length > 0) {
    lines.push('implicit_facts:');
    for (const fact of facts) lines.push(`- ${fact}`);
  }

  const digest = lines.join('\n');
  if (digest.length <= MAX_DIGEST_CHARS) return digest;
  return `${digest.slice(0, MAX_DIGEST_CHARS)}... [+${digest.length - MAX_DIGEST_CHARS} chars]`;
}

export function repeatedReadPressure(ctx: Context): number {
  return ensureEvidence(ctx).repeatedReads.reduce((max, item) => Math.max(max, item.count), 0);
}

function ensureEvidence(ctx: Context): ContextEvidenceState {
  if (!ctx.contextEvidence) {
    (ctx as unknown as { contextEvidence: ContextEvidenceState }).contextEvidence =
      createContextEvidenceState();
  }
  return ctx.contextEvidence;
}

function isGoalish(text: string): boolean {
  return /\b(goal|objective|task|need|want|implement|fix|improve|refactor|add|remove|hedef|amac|istiyorum|gerekiyor|iyilestir|duzelt|ekle|kaldir)\b/i.test(text);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pushUniqueBounded(list: string[], value: string, max: number): void {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return;
  const existing = list.findIndex((item) => item.toLowerCase() === normalized.toLowerCase());
  if (existing >= 0) list.splice(existing, 1);
  list.push(normalized);
  if (list.length > max) list.splice(0, list.length - max);
}

function extractFiles(
  ctx: Context,
  toolName: string,
  input: unknown,
  content: string,
): string[] {
  const out = new Set<string>();
  for (const value of inputPathValues(input)) addPath(ctx, out, value);

  if (toolName === 'grep' || toolName === 'glob' || toolName === 'bash') {
    const re = /(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]+(?:[\\/][\w@(). -]+)+\.[A-Za-z0-9]{1,12})/g;
    for (const match of content.matchAll(re)) addPath(ctx, out, match[0]);
  }

  return [...out].slice(0, 30);
}

function inputPathValues(input: unknown): string[] {
  const values: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key && /^(path|file|files|fromFile|toFile|dir|cwd)$/i.test(key)) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
  };
  visit(input);
  return values;
}

function addPath(ctx: Context, out: Set<string>, raw: string): void {
  const clean = raw.trim().replace(/^["'`]+|["'`),;:]+$/g, '');
  if (!clean || clean.length > 260) return;
  let normalized = clean.replace(/\\/g, '/');
  try {
    const abs = path.isAbsolute(clean) ? path.resolve(clean) : null;
    if (abs) {
      const rel = path.relative(ctx.projectRoot, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        normalized = rel.replace(/\\/g, '/');
      }
    }
  } catch {
    // Keep the best-effort normalized string.
  }
  if (normalized.length > 0) out.add(normalized);
}

function extractSymbols(content: string, input: unknown): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) {
    for (const match of content.matchAll(re)) {
      if (match[1]) out.add(match[1]);
      if (out.size >= 30) break;
    }
  }

  const pattern = input && typeof input === 'object'
    ? (input as Record<string, unknown>)['pattern']
    : undefined;
  if (typeof pattern === 'string' && /^[A-Za-z_$][\w$]*$/.test(pattern)) {
    out.add(pattern);
  }

  return [...out].slice(0, 30);
}

function extractCommands(toolName: string, input: unknown): string[] {
  if (toolName !== 'bash' && toolName !== 'exec' && toolName !== 'shell') return [];
  if (!input || typeof input !== 'object') return [];
  const command = (input as Record<string, unknown>)['command'];
  if (typeof command !== 'string') return [];
  return [command.slice(0, 220)];
}

function extractErrors(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const errors: string[] = [];
  for (const line of lines) {
    if (!/\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm|typeerror|syntaxerror)\b/i.test(line)) continue;
    errors.push(normalizeWhitespace(line).slice(0, 260));
    if (errors.length >= 5) break;
  }
  return errors;
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['path', 'file', 'pattern', 'glob', 'command']) {
    const value = obj[key];
    if (typeof value === 'string') parts.push(`${key}=${value.slice(0, 160)}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizeToolOutput(
  toolName: string,
  input: unknown,
  content: string,
  opts: { files: string[]; symbols: string[]; errors: string[]; ok: boolean },
): string {
  if (!opts.ok && opts.errors.length > 0) return opts.errors[0] ?? `${toolName} failed`;
  if (toolName === 'read' && opts.files[0]) return `read ${opts.files[0]}`;
  if (toolName === 'grep') {
    const pattern = input && typeof input === 'object'
      ? (input as Record<string, unknown>)['pattern']
      : undefined;
    return `searched ${typeof pattern === 'string' ? pattern : 'pattern'} (${opts.files.length} file hint(s))`;
  }
  if ((toolName === 'edit' || toolName === 'write') && opts.files[0]) {
    return `${toolName === 'write' ? 'wrote' : 'edited'} ${opts.files[0]}`;
  }
  const firstLine = normalizeWhitespace(content.split(/\r?\n/).find((line) => line.trim()) ?? '');
  return firstLine ? firstLine.slice(0, 220) : `${toolName} returned no text`;
}

function updateFileGraph(state: ContextEvidenceState, metadata: ToolOutputMetadata): void {
  const writes = WRITE_TOOLS.has(metadata.toolName) ? 1 : 0;
  const reads = writes === 0 && (READ_TOOLS.has(metadata.toolName) || metadata.files.length > 0)
    ? 1
    : 0;
  for (const file of metadata.files) {
    const existing = state.fileGraph[file] ?? {
      path: file,
      reads: 0,
      writes: 0,
      tools: [],
      referenced: false,
    };
    existing.reads += reads;
    existing.writes += writes;
    existing.lastToolUseId = metadata.toolUseId;
    pushUniqueBounded(existing.tools, `${metadata.toolName}#${metadata.toolUseId}`, 8);
    state.fileGraph[file] = existing;
  }
}

function updateRepeatedReadSignals(state: ContextEvidenceState, metadata: ToolOutputMetadata): void {
  if (metadata.toolName !== 'read' || metadata.files.length === 0) {
    state.lastReadPath = undefined;
    return;
  }
  const file = metadata.files[0] as string;
  if (state.lastReadPath === file) {
    const existing = state.repeatedReads.find((item) => item.file === file);
    if (existing) {
      existing.count++;
      existing.lastToolUseId = metadata.toolUseId;
    } else {
      state.repeatedReads.push({ file, count: 2, lastToolUseId: metadata.toolUseId });
    }
    if (state.repeatedReads.length > 10) state.repeatedReads.shift();
  }
  state.lastReadPath = file;
}

function implicitFactFor(metadata: ToolOutputMetadata): string | undefined {
  if (metadata.errors.length > 0) return `${metadata.toolName}#${metadata.toolUseId} exposed error: ${metadata.errors[0]}`;
  if (metadata.toolName === 'read' && metadata.files[0]) {
    const size = metadata.outputLines ? ` (${metadata.outputLines} line(s) returned)` : '';
    return `read ${metadata.files[0]}${size}`;
  }
  if ((metadata.toolName === 'edit' || metadata.toolName === 'write') && metadata.files[0]) {
    return `${metadata.toolName} changed ${metadata.files[0]}`;
  }
  if (metadata.status === 'referenced') return `${metadata.toolName}#${metadata.toolUseId} was referenced`;
  return undefined;
}

function metadataReferencedByText(metadata: ToolOutputMetadata, haystack: string): boolean {
  for (const file of metadata.files) {
    const f = file.toLowerCase();
    const base = path.basename(file).toLowerCase();
    if (f && haystack.includes(f)) return true;
    if (base && haystack.includes(base)) return true;
  }
  for (const symbol of metadata.symbols) {
    if (symbol.length >= 3 && haystack.includes(symbol.toLowerCase())) return true;
  }
  for (const err of metadata.errors) {
    const head = err.slice(0, 80).toLowerCase();
    if (head.length >= 12 && haystack.includes(head)) return true;
  }
  return false;
}
