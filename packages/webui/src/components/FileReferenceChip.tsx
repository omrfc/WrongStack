import { cn } from '@/lib/utils';
import { fileIcon, fileIconColor } from '@/lib/file-icons';
import type { FileReference } from '@/stores/file-reference-store';
import { X } from 'lucide-react';

interface FileReferenceChipProps {
  ref: FileReference;
  onRemove: () => void;
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function tooltipText(ref: FileReference): string {
  if (ref.kind === 'file') return ref.path;
  const preview = ref.kind === 'snippet' ? ref.content : ref.preview;
  const lines = preview.split('\n').slice(0, 6).join('\n');
  return `${ref.path}:${ref.startLine}-${ref.endLine}\n${lines}${preview.split('\n').length > 6 ? '\n…' : ''}`;
}

export function FileReferenceChip({ ref, onRemove }: FileReferenceChipProps) {
  const name = basename(ref.path);
  const Icon = fileIcon(name);
  const colorClass = fileIconColor(name, false);
  const label = ref.kind === 'file' ? name : `${name}:${ref.startLine}-${ref.endLine}`;
  const snippetBadge = ref.kind === 'snippet' ? `${ref.content.split('\n').length} lines` : null;

  return (
    <div
      title={tooltipText(ref)}
      className={cn(
        'inline-flex items-center gap-1.5 max-w-[180px] shrink-0',
        'rounded-full border border-border bg-muted/60 pl-2 pr-1 py-0.5',
        'text-xs text-foreground hover:bg-muted transition-colors',
      )}
    >
      <Icon className={cn('h-3 w-3 shrink-0', colorClass)} />
      <span className="truncate font-mono text-[11px]">{label}</span>
      {snippetBadge && (
        <span className="text-[9px] text-muted-foreground shrink-0">{snippetBadge}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center justify-center h-4 w-4 rounded-full text-muted-foreground hover:bg-background hover:text-foreground transition-colors shrink-0"
        title="Remove reference"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
