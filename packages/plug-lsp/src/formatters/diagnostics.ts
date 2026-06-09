import type { Diagnostic } from 'vscode-languageserver-protocol';
import type { SeverityName } from '../types.js';
import { displayPath } from '../utils/uri.js';

const SEVERITY: Record<number, SeverityName> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

const LABEL: Record<SeverityName, string> = {
  error: 'ERROR',
  warning: 'WARN',
  info: 'INFO',
  hint: 'HINT',
};

export function formatDiagnostics(
  byFile: Map<string, Diagnostic[]>,
  opts: {
    cwd: string;
    severityFilter: SeverityName[];
    maxPerFile: number;
    maxTotal: number;
  },
): string {
  const allowed = new Set(opts.severityFilter);
  const sections: string[] = [];
  let total = 0;
  let files = 0;
  for (const [file, diagnostics] of byFile.entries()) {
    const filtered = diagnostics
      /* v8 ignore next -- fallback handles invalid server severity values defensively. */
      .filter((d) => allowed.has(SEVERITY[d.severity ?? 1] ?? 'error'))
      .sort(compareDiagnostics)
      .slice(0, opts.maxPerFile);
    if (filtered.length === 0) continue;
    files++;
    total += filtered.length;
    const lines = filtered.map((d) => formatDiagnostic(d));
    sections.push(
      `${displayPath(file, opts.cwd)} (${filtered.length}):\n${lines.map((l) => `  ${l}`).join('\n')}`,
    );
    if (total >= opts.maxTotal) break;
  }
  if (sections.length === 0) return 'No LSP diagnostics.';
  return `${sections.join('\n\n')}\n\nTotal: ${total} diagnostics in ${files} files.`;
}

function formatDiagnostic(d: Diagnostic): string {
  /* v8 ignore next -- fallback handles invalid server severity values defensively. */
  const sev = SEVERITY[d.severity ?? 1] ?? 'error';
  const source = d.source ? ` ${d.source}${d.code !== undefined ? `(${String(d.code)})` : ''}` : '';
  const msgRaw = typeof d.message === 'string' ? d.message : d.message.value;
  const msg = msgRaw.replace(/\s*\r?\n\s*/g, ' | ');
  return `L${d.range.start.line + 1}:${d.range.start.character + 1} ${LABEL[sev]}${source}: ${msg}`;
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    (a.severity ?? 1) - (b.severity ?? 1) ||
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character
  );
}
