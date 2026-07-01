import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { autoFenceCode } from './code-detect.js';
import { useFileReferenceStore } from '@/stores/file-reference-store.js';

export interface PasteHintState {
  chars: number;
  lines: number;
  /** Detected language if code was auto-fenced. */
  lang?: string | undefined;
  /** If set, the fenced version can be undone via this callback. */
  undoFence?: (() => void) | undefined;
}

interface UsePasteDropOptions {
  input: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput: (value: string) => void;
}

/** Read a File into a base64 data-URL. */
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function usePasteDrop({ input, textareaRef, setInput }: UsePasteDropOptions) {
  const [pasteHint, setPasteHint] = useState<PasteHintState | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);

  /** Accumulates base64 image data pasted while the input is focused.
   *  Cleared after each submit so images aren't re-sent accidentally. */
  const pendingImageRef = useRef<string | null>(null);
  /** State mirror of pendingImageRef so a thumbnail preview re-renders.
   *  The ref stays the submit-time source of truth; this drives the pill. */
  const [pendingImage, setPendingImageState] = useState<string | null>(null);
  const setPendingImage = (data: string | null) => {
    pendingImageRef.current = data;
    setPendingImageState(data);
  };

  /** Intercept native paste events to detect and accumulate clipboard images. */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const onPaste = async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          try {
            const blob = item.getAsFile();
            if (!blob) continue;
            const reader = new FileReader();
            reader.onload = () => {
              setPendingImage(reader.result as string);
            };
            reader.readAsDataURL(blob);
          } catch {
            // Clipboard access requires permission in some browsers; silently skip.
          }
          return;
        }
      }
    };

    textarea.addEventListener('paste', onPaste);
    return () => textarea.removeEventListener('paste', onPaste);
  }, [textareaRef]);

  const onDragEnter = (event: React.DragEvent<HTMLFormElement>): void => {
    // Only react to drags carrying files — text/uri-list drags from
    // other parts of the page shouldn't trip the overlay.
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    setDraggingOver(true);
  };

  const onDragOver = (event: React.DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
    // preventDefault on dragover is what makes the area a valid drop
    // target — without it the browser navigates to the file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: React.DragEvent<HTMLFormElement>): void => {
    // dragleave fires when crossing child boundaries too; only clear if
    // the cursor genuinely left the form (relatedTarget outside or null).
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingOver(false);
  };

  const onDrop = (event: React.DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer) return;
    const allFiles = Array.from(event.dataTransfer.files ?? []);
    if (allFiles.length === 0) {
      setDraggingOver(false);
      return;
    }
    event.preventDefault();
    setDraggingOver(false);

    // Dropped image → attach inline (same channel as a pasted image). We keep
    // a single pending image, so the first dropped image wins.
    const imageFile = allFiles.find((f) => f.type?.startsWith('image/'));
    if (imageFile) {
      void readFileAsDataURL(imageFile)
        .then((data) => setPendingImage(data))
        .catch(() => {});
    }
    const files = allFiles.filter((f) => !f.type?.startsWith('image/'));
    if (files.length === 0) {
      // Only image(s) were dropped — nothing to insert as @mentions.
      return;
    }

    // Add dropped files as reference chips. Browsers strip the full path for
    // security, so we use the basename only — the user can refine the path
    // via the @-mention picker if needed.
    const { addRef } = useFileReferenceStore.getState();
    for (const file of files) {
      addRef({ kind: 'file', path: file.name });
    }
  };

  const onTextPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text) return;

    const result = autoFenceCode(text);
    if (result) {
      event.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = input.slice(0, start);
      const after = input.slice(end);
      const fenced = result.fenced;
      const next = before + fenced + after;
      setInput(next);
      const lines = text.split('\n').length;

      const undo = () => {
        const raw = before + text + after;
        setInput(raw);
        setPasteHint(null);
        requestAnimationFrame(() => {
          if (textarea) {
            textarea.focus();
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
          }
        });
      };

      setPasteHint({ chars: text.length, lines, lang: result.lang, undoFence: undo });
      setTimeout(() => setPasteHint(null), 6000);
      requestAnimationFrame(() => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        const newPos = before.length + fenced.length;
        textarea.setSelectionRange(newPos, newPos);
      });
      return;
    }

    if (text.length > 800) {
      const lines = text.split('\n').length;
      setPasteHint({ chars: text.length, lines });
      setTimeout(() => setPasteHint(null), 4000);
    }
  };

  return {
    draggingOver,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    onTextPaste,
    pasteHint,
    pendingImageRef,
    pendingImage,
    clearPendingImage: () => setPendingImage(null),
    setPasteHint,
  };
}
