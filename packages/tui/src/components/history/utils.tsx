import { Box, Text } from '../../ink.js';
import React, { useEffect, useState } from 'react';
import { theme } from '../../theme.js';

// ============================================
// Utility functions used across history components
// ============================================

export function shortenPath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(p.length - (max - 1))}`;
}

const MAX_PREVIEW = 120;

export function previewArgs(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return collapse(s, MAX_PREVIEW);
}

export function previewOutput(output: string): string {
  return collapse(output, MAX_PREVIEW);
}

function collapse(s: string, max: number): string {
  const oneLine = s.replace(/\r?\n/g, '↵').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function tryParseJson(s: string): unknown {
  const t = s.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function scanNumberedRange(text: string): { first?: number | undefined; last?: number | undefined; count: number } {
  let first: number | undefined;
  let last: number | undefined;
  let count = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)→/);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) {
        if (first === undefined) first = n;
        last = n;
        count++;
      }
    }
  }
  return { first, last, count };
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

export function firstNonEmpty(text: string): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n').find((l) => l.trim());
  return line ? line.replace(/\s+/g, ' ').trim() : undefined;
}

export function formatMatchHit(hit: unknown): string | undefined {
  if (typeof hit === 'string') return truncMid(hit, 70);
  if (hit && typeof hit === 'object') {
    const o = hit as Record<string, unknown>;
    const file = stringOf(o['file']) ?? stringOf(o['path']);
    const line = numOf(o['line']) ?? numOf(o['lineNumber']);
    const snippet = stringOf(o['text']) ?? stringOf(o['match']) ?? stringOf(o['preview']);
    if (file) {
      const head = line !== undefined ? `${shortenPath(file, 40)}:${line}` : shortenPath(file, 50);
      return snippet ? `${head}  ${truncMid(snippet.replace(/\s+/g, ' '), 40)}` : head;
    }
    if (snippet) return truncMid(snippet, 70);
  }
  return undefined;
}

// ============================================
// Tool argument formatting
// ============================================

const ARG_BUDGET = 60;

/**
 * Render the most useful single-line description of a tool call's arguments.
 */
export function formatToolArgs(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
    case 'patch':
    case 'document':
    case 'list_dir':
    case 'ls':
    case 'tree': {
      const p = stringOf(obj['path']) ?? stringOf(obj['file']);
      return p ? shortenPath(p, ARG_BUDGET) : '';
    }
    case 'grep':
    case 'search':
    case 'replace': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['query']);
      const scope = stringOf(obj['path']) ?? stringOf(obj['glob']);
      const head = pat ? `"${truncMid(pat, 36)}"` : '';
      const tail = scope ? ` in ${shortenPath(scope, 28)}` : '';
      return `${head}${tail}` || (stringOf(obj['command']) ?? '');
    }
    case 'glob': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['glob']);
      return pat ? `"${truncMid(pat, ARG_BUDGET - 2)}"` : '';
    }
    case 'bash':
    case 'shell':
    case 'exec':
    case 'install':
    case 'git': {
      const cmd = stringOf(obj['command']) ?? stringOf(obj['args']);
      return cmd ? truncMid(cmd, ARG_BUDGET) : '';
    }
    case 'diff': {
      const files = Array.isArray(obj['files']) ? (obj['files'] as unknown[]) : undefined;
      if (files && files.length > 0) {
        const head = stringOf(files[0]) ?? '';
        const rest = files.length > 1 ? ` (+${files.length - 1})` : '';
        return head ? `${shortenPath(head, 50)}${rest}` : '';
      }
      const mode = stringOf(obj['mode']);
      return mode ? `mode: ${mode}` : '';
    }
    case 'fetch':
    case 'webfetch':
    case 'web_fetch': {
      const u = stringOf(obj['url']);
      return u ? truncMid(u, ARG_BUDGET) : '';
    }
    case 'todo': {
      const list = obj['todos'];
      if (Array.isArray(list)) return `${list.length} item${list.length === 1 ? '' : 's'}`;
      return '';
    }
    case 'lint':
    case 'format':
    case 'typecheck':
    case 'test':
    case 'audit':
    case 'outdated': {
      const files = obj['files'];
      if (Array.isArray(files) && files.length > 0) {
        const first = stringOf(files[0]);
        const more = files.length > 1 ? ` (+${files.length - 1})` : '';
        return first ? `${shortenPath(first, 50)}${more}` : `${files.length} files`;
      }
      const filter = stringOf(obj['filter']) ?? stringOf(obj['pattern']);
      return filter ? `"${truncMid(filter, ARG_BUDGET - 2)}"` : '';
    }
    case 'json': {
      const file = stringOf(obj['file']);
      const q = stringOf(obj['query']);
      if (file) return q ? `${shortenPath(file, 40)}  ${q}` : shortenPath(file, ARG_BUDGET);
      return q ? truncMid(q, ARG_BUDGET) : '';
    }
    case 'scaffold': {
      const tmpl = stringOf(obj['template']) ?? stringOf(obj['type']);
      const name = stringOf(obj['name']);
      if (tmpl && name) return `${tmpl} → ${truncMid(name, ARG_BUDGET - tmpl.length - 4)}`;
      return name ?? tmpl ?? '';
    }
    case 'remember':
    case 'forget':
    case 'memory': {
      const key = stringOf(obj['key']) ?? stringOf(obj['name']);
      return key ? truncMid(key, ARG_BUDGET) : '';
    }
    case 'mode': {
      const m = stringOf(obj['mode']) ?? stringOf(obj['name']);
      return m ? truncMid(m, ARG_BUDGET) : '';
    }
    case 'logs': {
      const target = stringOf(obj['target']) ?? stringOf(obj['service']) ?? stringOf(obj['path']);
      return target ? truncMid(target, ARG_BUDGET) : '';
    }
  }

  for (const key of ['path', 'file', 'url', 'name', 'query', 'pattern', 'command']) {
    const v = stringOf(obj[key]);
    if (v) return truncMid(v, ARG_BUDGET);
  }
  try {
    return truncMid(JSON.stringify(obj), ARG_BUDGET);
  } catch {
    return '';
  }
}

// ============================================
// Tool output formatting
// ============================================

const OUT_BUDGET = 80;
const GENERIC_BUDGET = 240;

function summarizeJsonObject(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  const priority = [
    'ok', 'status', 'timedOut', 'stopReason', 'reason', 'error', 'message',
    'result', 'summary', 'iterations', 'toolCalls', 'durationMs', 'subagentId', 'taskId',
  ];
  const ordered = [
    ...priority.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !priority.includes(k)),
  ];
  const parts: string[] = [];
  let used = 0;
  for (const key of ordered) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const rendered =
      typeof v === 'string'
        ? `${key}="${truncMid(v.replace(/\s+/g, ' '), 80)}"`
        : typeof v === 'number' || typeof v === 'boolean'
          ? `${key}=${v}`
          : Array.isArray(v)
            ? `${key}=[${v.length}]`
            : `${key}={…}`;
    if (used + rendered.length > GENERIC_BUDGET) {
      parts.push('…');
      break;
    }
    parts.push(rendered);
    used += rendered.length + 3;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Distil a tool's result text into 0–N digest lines the renderer can stack.
 */
export function formatToolOutput(
  toolName: string,
  output: string | undefined,
  ok: boolean,
  _outputBytes?: number | undefined,
  outputLines?: number | undefined,
): string[] {
  if (!output) return ok ? [] : ['failed'];
  const text = output.trim();
  if (!text) return ok ? [] : ['failed'];

  const json = tryParseJson(text);

  if (toolName === 'write' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const bytes = numOf(o['bytes_written']) ?? numOf(o['bytes']);
    const created = o['created'] === true;
    const tag = created ? 'created' : 'updated';
    return bytes !== undefined ? [`${tag} · ${fmtBytes(bytes)}`] : [tag];
  }

  if (toolName === 'edit' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const reps = numOf(o['replacements']);
    if (reps !== undefined) return [`${reps} replacement${reps === 1 ? '' : 's'}`];
  }

  if (toolName === 'patch' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const applied = numOf(o['applied']);
    const rejected = numOf(o['rejected']);
    const files = Array.isArray(o['files']) ? (o['files'] as unknown[]) : undefined;
    const lines: string[] = [];
    if (applied !== undefined || rejected !== undefined) {
      const parts = [];
      if (applied !== undefined) parts.push(`${applied} applied`);
      if (rejected !== undefined && rejected > 0) parts.push(`${rejected} rejected`);
      lines.push(parts.join(' · '));
    }
    if (files && files.length > 0) {
      const first = stringOf(files[0]) ?? '';
      const more = files.length > 1 ? ` (+${files.length - 1})` : '';
      lines.push(`${shortenPath(first, 60)}${more}`);
    }
    if (lines.length > 0) return lines;
  }

  if (toolName === 'replace' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const files = numOf(o['files_modified']);
    const reps = numOf(o['total_replacements']);
    if (files !== undefined && reps !== undefined) {
      return [`${reps} replacement${reps === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`];
    }
  }

  // diff
  if (toolName === 'diff' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const diffFiles = Array.isArray(o['files']) ? (o['files'] as unknown[]) : undefined;
    const truncated = o['truncated'] === true;
    const mode = stringOf(o['mode']);
    const diff = stringOf(o['diff']);
    if (!diff) return [diffFiles && diffFiles.length === 0 ? 'no changes' : 'empty diff'];
    const head: string[] = [];
    if (mode) head.push(mode);
    if (diffFiles && diffFiles.length > 0)
      head.push(`${diffFiles.length} file${diffFiles.length === 1 ? '' : 's'}`);
    if (truncated) head.push('truncated');
    return head.length > 0 ? [head.join(' · ')] : [];
  }

  // read
  if (toolName === 'read') {
    if (outputLines !== undefined) return [];
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const bytes = numOf(o['bytes']);
      if (bytes !== undefined) return [`${fmtBytes(bytes)} read`];
    }
    const range = scanNumberedRange(text);
    if (range.count > 0 && range.first !== undefined && range.last !== undefined) {
      if (range.first === range.last) return [`L${range.first} · ${fmtBytes(text.length)}`];
      const contiguous = range.count === range.last - range.first + 1;
      const head = `L${range.first}–${range.last}`;
      const tail = contiguous
        ? `${range.count} line${range.count === 1 ? '' : 's'}`
        : `${range.count} lines (gaps)`;
      return [`${head} · ${tail} · ${fmtBytes(text.length)}`];
    }
  }

  // grep / glob
  if (toolName === 'grep' || toolName === 'glob') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const matches = Array.isArray(o['matches']) ? (o['matches'] as unknown[]) : undefined;
      const count = numOf(o['count']) ?? matches?.length;
      const truncated = o['truncated'] === true;
      if (count !== undefined) {
        if (count === 0) return ['no matches'];
        const lines: string[] = [
          `${count} match${count === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`,
        ];
        const firstHit = matches && matches.length > 0 ? formatMatchHit(matches[0]) : undefined;
        if (firstHit) lines.push(firstHit);
        return lines;
      }
    }
  }

  // bash / shell
  if (toolName === 'bash' || toolName === 'shell') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
      const stdout = stringOf(o['stdout']) ?? '';
      const stderr = stringOf(o['stderr']) ?? '';
      const stdoutLines = countLines(stdout);
      const stderrLines = countLines(stderr);
      const head: string[] = [];
      if (exit !== undefined) head.push(`exit ${exit}`);
      const lineParts: string[] = [];
      if (stdoutLines > 0) lineParts.push(`${stdoutLines} out`);
      if (stderrLines > 0) lineParts.push(`${stderrLines} err`);
      if (lineParts.length > 0) head.push(lineParts.join(' · '));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      const stdoutPreview = firstNonEmpty(stdout);
      const stderrPreview = firstNonEmpty(stderr);
      if (stdoutPreview) lines.push(`"${truncMid(stdoutPreview, 70)}"`);
      if (stderrPreview && stderrPreview !== stdoutPreview) {
        lines.push(`! "${truncMid(stderrPreview, 70)}"`);
      }
      if (lines.length > 0) return lines;
    }
  }

  // todo
  if (toolName === 'todo') return ok ? [] : [text.split('\n')[0] ?? ''];

  // fetch / webfetch
  if (toolName === 'fetch' || toolName === 'webfetch' || toolName === 'web_fetch') {
    if (json && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      const status = numOf(o['status']);
      const ct = stringOf(o['content_type']);
      const url = stringOf(o['url']);
      const content = stringOf(o['content']);
      const head: string[] = [];
      if (status !== undefined) head.push(`HTTP ${status}`);
      if (ct) head.push(ct.split(';')[0] ?? ct);
      if (content) head.push(fmtBytes(Buffer.byteLength(content, 'utf8')));
      const lines: string[] = [];
      if (head.length > 0) lines.push(head.join(' · '));
      if (url && status !== undefined && (status < 200 || status >= 400)) {
        lines.push(shortenPath(url, 70));
      }
      if (lines.length > 0) return lines;
    }
  }

  // git
  if (toolName === 'git' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const exit = numOf(o['exitCode']) ?? numOf(o['exit_code']);
    const stdout = stringOf(o['stdout']) ?? '';
    const stderr = stringOf(o['stderr']) ?? '';
    const head: string[] = [];
    if (exit !== undefined) head.push(`exit ${exit}`);
    const stdoutLines = countLines(stdout);
    const stderrLines = countLines(stderr);
    const lparts: string[] = [];
    if (stdoutLines > 0) lparts.push(`${stdoutLines} out`);
    if (stderrLines > 0) lparts.push(`${stderrLines} err`);
    if (lparts.length > 0) head.push(lparts.join(' · '));
    const lines: string[] = [];
    if (head.length > 0) lines.push(head.join(' · '));
    const preview = firstNonEmpty(stdout) ?? firstNonEmpty(stderr);
    if (preview) lines.push(`"${truncMid(preview, 70)}"`);
    if (lines.length > 0) return lines;
  }

  // lint
  if (toolName === 'lint' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const linter = stringOf(o['linter']);
    const files = numOf(o['files_checked']);
    const errors = numOf(o['errors']) ?? 0;
    const warnings = numOf(o['warnings']) ?? 0;
    const fix = o['fix_applied'] === true;
    const head: string[] = [];
    if (linter && linter !== 'none') head.push(linter);
    head.push(`${errors} error${errors === 1 ? '' : 's'}`);
    head.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    if (files !== undefined) head.push(`${files} file${files === 1 ? '' : 's'}`);
    if (fix) head.push('fixed');
    return [head.join(' · ')];
  }

  // format
  if (toolName === 'format' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const fixer = stringOf(o['fixer']);
    const checked = numOf(o['files_checked']);
    const changed = numOf(o['files_changed']);
    const head: string[] = [];
    if (fixer && fixer !== 'none') head.push(fixer);
    if (changed !== undefined && checked !== undefined) {
      head.push(`${changed}/${checked} changed`);
    } else if (changed !== undefined) {
      head.push(`${changed} changed`);
    }
    return head.length > 0 ? [head.join(' · ')] : [];
  }

  // typecheck
  if (toolName === 'typecheck' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
    const errors = numOf(o['errors']);
    const head: string[] = [];
    if (errors !== undefined) head.push(`${errors} error${errors === 1 ? '' : 's'}`);
    if (exit !== undefined) head.push(`exit ${exit}`);
    const stdout = stringOf(o['output']) ?? stringOf(o['stdout']) ?? '';
    const lines: string[] = [];
    if (head.length > 0) lines.push(head.join(' · '));
    const preview = firstNonEmpty(stdout);
    if (preview && (!errors || errors > 0)) lines.push(`"${truncMid(preview, 70)}"`);
    if (lines.length > 0) return lines;
  }

  // test
  if (toolName === 'test' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const runner = stringOf(o['runner']);
    const total = numOf(o['tests_run']) ?? 0;
    const passed = numOf(o['passed']) ?? 0;
    const failed = numOf(o['failed']) ?? 0;
    const duration = numOf(o['duration_ms']);
    const head: string[] = [];
    if (runner && runner !== 'none') head.push(runner);
    head.push(`${passed}/${total} passed`);
    if (failed > 0) head.push(`${failed} failed`);
    if (duration !== undefined) head.push(fmtDuration(duration));
    return [head.join(' · ')];
  }

  // audit
  if (toolName === 'audit' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const total = numOf(o['total']) ?? 0;
    const summary = stringOf(o['summary']);
    if (total === 0) return ['no vulnerabilities'];
    const head = `${total} vulnerabilit${total === 1 ? 'y' : 'ies'}`;
    return summary && summary.toLowerCase() !== head.toLowerCase()
      ? [head, truncMid(summary, OUT_BUDGET)]
      : [head];
  }

  // outdated
  if (toolName === 'outdated' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const total = numOf(o['total']) ?? 0;
    const pkgs = Array.isArray(o['packages']) ? (o['packages'] as unknown[]) : undefined;
    if (total === 0) return ['all up to date'];
    const lines: string[] = [`${total} outdated`];
    if (pkgs && pkgs.length > 0) {
      const first = pkgs[0];
      if (first && typeof first === 'object') {
        const p = first as Record<string, unknown>;
        const name = stringOf(p['name']) ?? stringOf(p['package']);
        const cur = stringOf(p['current']);
        const wanted = stringOf(p['wanted']) ?? stringOf(p['latest']);
        if (name && cur && wanted) lines.push(`${name}: ${cur} → ${wanted}`);
        else if (name) lines.push(name);
      }
    }
    return lines;
  }

  // tree
  if (toolName === 'tree' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const files = numOf(o['total_files']);
    const dirs = numOf(o['total_dirs']);
    const truncated = o['truncated'] === true;
    const parts: string[] = [];
    if (files !== undefined) parts.push(`${files} file${files === 1 ? '' : 's'}`);
    if (dirs !== undefined) parts.push(`${dirs} dir${dirs === 1 ? '' : 's'}`);
    if (truncated) parts.push('truncated');
    return parts.length > 0 ? [parts.join(' · ')] : [];
  }

  // json
  if (toolName === 'json' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const err = stringOf(o['error']);
    if (err) return [truncMid(err, OUT_BUDGET)];
    const type = stringOf(o['type']);
    const keys = Array.isArray(o['keys']) ? (o['keys'] as unknown[]) : undefined;
    const parts: string[] = [];
    if (type) parts.push(type);
    if (keys) parts.push(`${keys.length} key${keys.length === 1 ? '' : 's'}`);
    return parts.length > 0 ? [parts.join(' · ')] : [];
  }

  // install
  if (toolName === 'install' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const exit = numOf(o['exit_code']) ?? numOf(o['exitCode']);
    const added = numOf(o['added']);
    const removed = numOf(o['removed']);
    const head: string[] = [];
    if (exit !== undefined) head.push(`exit ${exit}`);
    if (added !== undefined) head.push(`+${added}`);
    if (removed !== undefined) head.push(`-${removed}`);
    const stdout = stringOf(o['stdout']) ?? stringOf(o['output']) ?? '';
    const lines: string[] = [];
    if (head.length > 0) lines.push(head.join(' · '));
    const preview = firstNonEmpty(stdout);
    if (preview) lines.push(`"${truncMid(preview, 70)}"`);
    if (lines.length > 0) return lines;
  }

  // scaffold
  if (toolName === 'scaffold' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const created = Array.isArray(o['created']) ? (o['created'] as unknown[]) : undefined;
    const skipped = Array.isArray(o['skipped']) ? (o['skipped'] as unknown[]) : undefined;
    const parts: string[] = [];
    if (created !== undefined) parts.push(`${created.length} created`);
    if (skipped !== undefined && skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (parts.length > 0) return [parts.join(' · ')];
  }

  // remember / forget / memory
  if (toolName === 'remember' || toolName === 'forget' || toolName === 'memory') {
    return ok ? [toolName === 'forget' ? 'removed' : 'saved'] : [text.split('\n')[0] ?? ''];
  }

  // mode
  if (toolName === 'mode' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const mode = stringOf(o['mode']) ?? stringOf(o['active']) ?? stringOf(o['name']);
    if (mode) return [`mode: ${mode}`];
  }

  // search
  if (toolName === 'search' && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const matches = Array.isArray(o['matches'])
      ? (o['matches'] as unknown[])
      : Array.isArray(o['results'])
        ? (o['results'] as unknown[])
        : undefined;
    const count = numOf(o['count']) ?? matches?.length;
    if (count !== undefined) {
      if (count === 0) return ['no results'];
      const lines: string[] = [`${count} result${count === 1 ? '' : 's'}`];
      const firstHit = matches && matches.length > 0 ? formatMatchHit(matches[0]) : undefined;
      if (firstHit) lines.push(firstHit);
      return lines;
    }
  }

  // logs
  if (toolName === 'logs') {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return [];
    const head = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    const lastLine = lines[lines.length - 1];
    return lastLine ? [head, `"${truncMid(lastLine.trim(), 70)}"`] : [head];
  }

  // Generic fallback
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const summary = summarizeJsonObject(json as Record<string, unknown>);
    if (summary) return [summary];
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return [truncMid(collapsed, GENERIC_BUDGET)];
}

// ============================================
// Streaming tool output component
// ============================================

export const MAX_STREAM_DISPLAY_CHARS = 480;
const MAX_STREAM_LINES = 8;

/**
 * Build the CONSTANT-height content block for the live tool-stream box: always
 * exactly `maxLines` rows, newest-pinned-to-bottom, every line truncated to
 * `contentWidth` so nothing wraps. Holding the row count fixed is what stops the
 * live region from growing (and thus scrolling the terminal + leaking the header
 * into scrollback) as output streams in. Pure + exported for testing.
 */
export function streamBoxRows(
  text: string,
  maxLines: number,
  contentWidth: number,
): Array<{ text: string; italic?: boolean | undefined }> {
  const trunc = (line: string) =>
    line.length > contentWidth ? `${line.slice(0, contentWidth - 1)}…` : line;
  const lines = text.split('\n');
  const totalLines = lines.length;
  const hidden = Math.max(0, totalLines - maxLines);
  const rows: Array<{ text: string; italic?: boolean | undefined }> = [];
  if (hidden > 0) {
    rows.push({ text: `  … ${hidden} more line${hidden === 1 ? '' : 's'} above`, italic: true });
    for (const line of lines.slice(totalLines - (maxLines - 1))) rows.push({ text: trunc(line) });
  } else {
    for (let i = 0; i < maxLines - totalLines; i++) rows.push({ text: '' });
    for (const line of lines) rows.push({ text: trunc(line) });
  }
  return rows;
}

export const ToolStreamBox = React.memo(function ToolStreamBox({
  name,
  text,
  startedAt,
  termWidth,
}: {
  name: string;
  text: string;
  startedAt: number;
  termWidth: number;
}): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  void tick;

  const elapsedMs = Date.now() - startedAt;
  const totalLines = text.split('\n').length;
  const hidden = Math.max(0, totalLines - MAX_STREAM_LINES);
  const contentWidth = Math.max(20, Math.min(termWidth - 4, 100));
  // Constant-height content block (see streamBoxRows): the live region must not
  // grow row-by-row as output streams, or it scrolls the terminal and leaks the
  // "◆ <tool> ⏱ …" header into scrollback on every update in inline mode.
  const rows = streamBoxRows(text, MAX_STREAM_LINES, contentWidth);

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box flexDirection="row">
        <Text color={theme.warn}>◆ </Text>
        <Text bold color={theme.tool}>{name}</Text>
        <Text dimColor>{`  ⏱ ${fmtDuration(elapsedMs)}`}</Text>
        {hidden > 0 ? (
          <Text dimColor>{`  (${totalLines} lines, showing last ${MAX_STREAM_LINES})`}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-height block, index is the row
          <Text key={i} dimColor italic={Boolean(r.italic)}>{r.text || ' '}</Text>
        ))}
      </Box>
    </Box>
  );
});

export function tailForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const nl = text.indexOf('\n', cut);
  if (nl !== -1 && nl < cut + 80) {
    return `… ${text.slice(nl + 1)}`;
  }
  return `… ${text.slice(cut)}`;
}
