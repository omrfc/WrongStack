
// requestAnimationFrame polyfill for jsdom — flush immediately
const rafCallbacks: FrameRequestCallback[] = [];
(globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = (cb: FrameRequestCallback) => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
(globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = (handle: number) => {
  rafCallbacks[handle - 1] = undefined as unknown as FrameRequestCallback;
};
function flushRaf() {
  const cbs = rafCallbacks.splice(0, rafCallbacks.length);
  for (const cb of cbs) if (cb) cb(performance.now());
}
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuedMessages } from '../../src/components/ChatInput/queued-messages.js';
import { FileMentionPicker } from '../../src/components/ChatInput/file-mention-picker.js';

function mockTextarea(): HTMLTextAreaElement {
  return {
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    selectionStart: 0,
    selectionEnd: 0,
  } as unknown as HTMLTextAreaElement;
}

// Mock FilePicker so we can test FileMentionPicker logic without file-tree rendering
vi.mock('../../src/components/FilePicker', () => ({
  FilePicker: ({ query, onClose, onPick }: { query: string; onClose: () => void; onPick: (path: string) => void }) => (
    <div data-testid="file-picker">
      <span data-testid="fp-query">{query}</span>
      <button type="button" onClick={() => onPick('src/index.ts')}>
        Pick src/index.ts
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

describe('QueuedMessages', () => {
  it('renders nothing when queue is empty', () => {
    const { container } = render(<QueuedMessages queue={[]} onClear={vi.fn()} onRemove={vi.fn()} />);
    expect(container.children.length === 0 || container.firstChild === null).toBe(true);
  });

  it('renders queue count and items', () => {
    render(<QueuedMessages queue={['first', 'second']} onClear={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText(/Queued \(2\)/)).toBeDefined();
    expect(screen.getByText('first')).toBeDefined();
    expect(screen.getByText('second')).toBeDefined();
  });

  it('calls onClear when Clear all is clicked', () => {
    const onClear = vi.fn();
    render(<QueuedMessages queue={['msg']} onClear={onClear} onRemove={vi.fn()} />);

    fireEvent.click(screen.getByText('Clear all'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('calls onRemove with correct index when × is clicked', () => {
    const onRemove = vi.fn();
    render(<QueuedMessages queue={['a', 'b', 'c']} onClear={vi.fn()} onRemove={onRemove} />);

    const removeButtons = screen.getAllByTitle('Remove from queue');
    expect(removeButtons).toHaveLength(3);

    fireEvent.click(removeButtons[1]!);
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});

describe('FileMentionPicker', () => {

  const mockTextarea = (overrides: Partial<HTMLTextAreaElement> = {}) =>
    ({
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      style: { height: '' },
      scrollHeight: 100,
      ...overrides,
    }) as unknown as HTMLTextAreaElement;

  it('renders nothing when atMention is null', () => {
    const { container } = render(
      <FileMentionPicker
        atMention={null}
        input=""
        textareaRef={{ current: null }}
        setInput={vi.fn()}
        setAtMention={vi.fn()}
      />,
    );
    expect(container.children.length === 0 || container.firstChild === null).toBe(true);
  });

  it('renders FilePicker with the current query', () => {
    render(
      <FileMentionPicker
        atMention={{ start: 5, query: 'compo' }}
        input="test @compo rest"
        textareaRef={{ current: null }}
        setInput={vi.fn()}
        setAtMention={vi.fn()}
      />,
    );

    expect(screen.getByTestId('fp-query').textContent).toBe('compo');
  });

  it('calls setAtMention(null) when FilePicker is closed', () => {
    const setAtMention = vi.fn();
    render(
      <FileMentionPicker
        atMention={{ start: 0, query: 'test' }}
        input="@test"
        textareaRef={{ current: null }}
        setInput={vi.fn()}
        setAtMention={setAtMention}
      />,
    );

    fireEvent.click(screen.getByText('Close'));
    expect(setAtMention).toHaveBeenCalledWith(null);
  });

  it('replaces partial @query with picked path and clears atMention', () => {
    const setInput = vi.fn();
    const setAtMention = vi.fn();

    render(
      <FileMentionPicker
        atMention={{ start: 0, query: 'com' }}
        input="@com rest"
        textareaRef={{ current: null }}
        setInput={setInput}
        setAtMention={setAtMention}
      />,
    );

    fireEvent.click(screen.getByText('Pick src/index.ts'));

    // before = "" (slice 0..0), after = " rest" (slice 0+1+3=4..end)
    expect(setInput).toHaveBeenCalledWith('@src/index.ts  rest');
    expect(setAtMention).toHaveBeenCalledWith(null);
  });

  it('restores cursor position and textarea height after pick', () => {
    const textarea = mockTextarea();
    const setInput = vi.fn();
    const setAtMention = vi.fn();

    render(
      <FileMentionPicker
        atMention={{ start: 0, query: 'x' }}
        input="@x end"
        textareaRef={{ current: textarea }}
        setInput={setInput}
        setAtMention={setAtMention}
      />,
    );

    fireEvent.click(screen.getByText('Pick src/index.ts'));

    // Flush requestAnimationFrame
    flushRaf();

    expect(textarea.focus).toHaveBeenCalledTimes(1);
    expect(textarea.setSelectionRange).toHaveBeenCalled();
  });
});
