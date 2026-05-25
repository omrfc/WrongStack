import type { AddAttachmentInput, AttachmentRef, AttachmentStore } from '../types/attachment.js';
import type { ContentBlock } from '../types/blocks.js';

export interface InputBuilderOptions {
  store: AttachmentStore;
  /**
   * Pastes ≥ this many lines collapse to a `[pasted #N]` placeholder.
   * Default: 8 lines.
   */
  pasteLineThreshold?: number;
  /**
   * Pastes ≥ this many characters collapse to a placeholder regardless of
   * line count. Default: 2000 chars.
   */
  pasteCharThreshold?: number;
}

export interface InputBuilderEvent {
  /** Current display string (with placeholders, before submit). */
  display: string;
  refs: AttachmentRef[];
}

/**
 * UI-agnostic accumulator for user input. The frontend (CLI/TUI) feeds in:
 *   - typed text via `appendText()`
 *   - large pastes via `appendPaste()` → returns placeholder string
 *   - image paste via `appendImage()` → returns placeholder string
 *   - file refs (`@path`) via `appendFile()` → returns placeholder string
 *
 * On `submit()` the builder runs the display string through AttachmentStore.expand()
 * and returns the final ContentBlock[] ready for `agent.run()`.
 *
 * The builder does not know what a "line" or "key" is — that is the
 * frontend's job. It only operates on strings and byte payloads.
 */
export class InputBuilder {
  private readonly store: AttachmentStore;
  private readonly pasteLineThreshold: number;
  private readonly pasteCharThreshold: number;
  private display = '';
  private readonly refs: AttachmentRef[] = [];

  constructor(opts: InputBuilderOptions) {
    this.store = opts.store;
    this.pasteLineThreshold = opts.pasteLineThreshold ?? 8;
    this.pasteCharThreshold = opts.pasteCharThreshold ?? 2000;
  }

  get text(): string {
    return this.display;
  }

  get attachments(): AttachmentRef[] {
    return [...this.refs];
  }

  get isEmpty(): boolean {
    return this.display.trim().length === 0;
  }

  appendText(text: string): void {
    this.display += text;
  }

  /**
   * Decide whether a chunk of pasted text is "big" enough to collapse.
   * If yes, store it and append a placeholder. If no, inline it.
   * Returns the placeholder string actually appended (or `null` if inlined).
   */
  async appendPaste(text: string): Promise<string | null> {
    if (this.shouldCollapse(text)) {
      const ref = await this.store.add({
        kind: 'text',
        data: text,
        meta: { label: paragraphLabel(text) },
      });
      const placeholder = `[pasted #${ref.seq}]`;
      this.display += placeholder;
      this.refs.push(ref);
      return placeholder;
    }
    this.display += text;
    return null;
  }

  /**
   * Always collapses to `[image #N]` — images are never inlined.
   * `dataBase64` is the raw base64 payload (no data: prefix).
   */
  async appendImage(dataBase64: string, mediaType: string): Promise<string> {
    const ref = await this.store.add({
      kind: 'image',
      data: dataBase64,
      meta: { mediaType, label: `${mediaType.split('/')[1]?.toUpperCase() ?? 'IMG'}` },
    });
    const placeholder = `[image #${ref.seq}]`;
    this.display += placeholder;
    this.refs.push(ref);
    return placeholder;
  }

  async appendFile(input: AddAttachmentInput): Promise<string> {
    const ref = await this.store.add({ ...input, kind: 'file' });
    const placeholder = `[file #${ref.seq}]`;
    this.display += placeholder;
    this.refs.push(ref);
    return placeholder;
  }

  /**
   * Whether `appendPaste(text)` would collapse the text to a placeholder
   * (rather than inlining it). Lets a frontend decide where to route a paste
   * — e.g. collapsed pastes become a pill, while inlined ones can be shown
   * in the editable input row — without calling `appendPaste` first (which
   * mutates the display buffer).
   */
  wouldCollapse(text: string): boolean {
    return this.shouldCollapse(text);
  }

  /** Reset display and ref list. Does NOT clear the store itself. */
  reset(): void {
    this.display = '';
    this.refs.length = 0;
  }

  /**
   * Resolve the current display string into ContentBlock[]. Empty
   * input returns an empty array — caller decides what to do.
   */
  async submit(): Promise<ContentBlock[]> {
    const text = this.display;
    this.reset();
    return text ? this.store.expand(text) : [];
  }

  private shouldCollapse(text: string): boolean {
    if (text.length >= this.pasteCharThreshold) return true;
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lines++;
      if (lines >= this.pasteLineThreshold) return true;
    }
    return false;
  }
}

function paragraphLabel(text: string): string {
  const lines = text.split('\n').length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1024) return `${lines} lines, ${bytes} B`;
  return `${lines} lines, ${(bytes / 1024).toFixed(1)} KB`;
}
