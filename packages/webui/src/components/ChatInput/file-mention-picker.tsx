import type React from 'react';
import { FilePicker } from '../FilePicker';

export interface FileMentionState {
  start: number;
  query: string;
}

interface FileMentionPickerProps {
  atMention: FileMentionState | null;
  input: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput: (value: string) => void;
  setAtMention: (value: FileMentionState | null) => void;
}

export function FileMentionPicker({
  atMention,
  input,
  textareaRef,
  setInput,
  setAtMention,
}: FileMentionPickerProps) {
  if (!atMention) return null;

  return (
    <FilePicker
      query={atMention.query}
      onClose={() => setAtMention(null)}
      onPick={(path) => {
        // Replace the partial `@query` with `@<path> `, then move
        // the cursor after the inserted space so typing continues
        // naturally.
        const before = input.slice(0, atMention.start);
        const after = input.slice(atMention.start + 1 + atMention.query.length);
        const inserted = `@${path} `;
        const next = before + inserted + after;
        setInput(next);
        setAtMention(null);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (textarea) {
            const pos = before.length + inserted.length;
            textarea.focus();
            textarea.setSelectionRange(pos, pos);
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
          }
        });
      }}
    />
  );
}
