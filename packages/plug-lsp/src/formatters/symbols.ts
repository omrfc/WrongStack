import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol';
import { displayPath, uriToPath } from '../utils/uri.js';

export function formatDocumentSymbols(path: string, symbols: DocumentSymbol[] | SymbolInformation[] | null, cwd: string): string {
  if (!symbols || symbols.length === 0) return 'No symbols found.';
  const lines = [`${displayPath(path, cwd)}:`];
  for (const sym of symbols) appendSymbol(lines, sym, 1, cwd);
  return lines.join('\n');
}

export function formatWorkspaceSymbols(symbols: SymbolInformation[] | null, query: string, cwd: string, limit = 100): string {
  if (!symbols || symbols.length === 0) return `No symbols matching "${query}".`;
  const lines = [`${symbols.length} symbols matching "${query}":`];
  for (const sym of symbols.slice(0, limit)) {
    lines.push(`  ${kindName(sym.kind)} ${sym.name} ${displayPath(uriToPath(sym.location.uri), cwd)}:${sym.location.range.start.line + 1}`);
  }
  if (symbols.length > limit) lines.push(`  ... truncated ${symbols.length - limit} more`);
  return lines.join('\n');
}

function appendSymbol(lines: string[], sym: DocumentSymbol | SymbolInformation, depth: number, cwd: string): void {
  const indent = '  '.repeat(depth);
  if ('selectionRange' in sym) {
    lines.push(`${indent}${kindName(sym.kind)} ${sym.name} (L${sym.selectionRange.start.line + 1})`);
    for (const child of sym.children ?? []) appendSymbol(lines, child, depth + 1, cwd);
  } else {
    lines.push(`${indent}${kindName(sym.kind)} ${sym.name} ${displayPath(uriToPath(sym.location.uri), cwd)}:${sym.location.range.start.line + 1}`);
  }
}

function kindName(kind: number): string {
  return [
    'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field',
    'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string',
    'number', 'boolean', 'array', 'object', 'key', 'null', 'enumMember', 'struct',
    'event', 'operator', 'typeParameter',
  ][kind - 1] ?? 'symbol';
}
