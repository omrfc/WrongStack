import type { Hover, MarkedString, MarkupContent } from 'vscode-languageserver-protocol';

export function formatHover(hover: Hover | null, maxChars = 4096): string {
  if (!hover) return 'No hover information.';
  const text = hoverContentsToString(hover.contents).trim();
  if (!text) return 'No hover information.';
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function hoverContentsToString(contents: Hover['contents']): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(markedStringToString).join('\n\n');
  if ('kind' in contents && 'value' in contents) return (contents as MarkupContent).value;
  return markedStringToString(contents as MarkedString);
}

function markedStringToString(value: MarkedString): string {
  if (typeof value === 'string') return value;
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}
