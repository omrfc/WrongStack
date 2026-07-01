import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileReferenceChip } from '../../src/components/FileReferenceChip';
import { useFileReferenceStore } from '../../src/stores/file-reference-store';
import type { FileReference } from '../../src/stores/file-reference-store';

// The chip uses the shared file-icon helper which imports lucide-react icons.
// Those render fine under jsdom as SVG components, so no mock is needed.

describe('FileReferenceChip', () => {
  beforeEach(() => {
    useFileReferenceStore.setState({ refs: [] });
  });

  it('renders the basename for a file ref', () => {
    const ref: FileReference = { id: '1', kind: 'file', path: 'src/foo/bar.ts' };
    render(<FileReferenceChip ref={ref} onRemove={() => {}} />);
    expect(screen.getByText('bar.ts')).toBeTruthy();
  });

  it('renders basename + line range for a snippet ref', () => {
    const ref: FileReference = {
      id: '2',
      kind: 'snippet',
      path: 'src/foo/bar.ts',
      startLine: 10,
      endLine: 20,
      content: 'const x = 1;',
    };
    render(<FileReferenceChip ref={ref} onRemove={() => {}} />);
    expect(screen.getByText('bar.ts:10-20')).toBeTruthy();
  });

  it('shows a line-count badge for snippet refs', () => {
    const ref: FileReference = {
      id: '3',
      kind: 'snippet',
      path: 'src/foo/bar.ts',
      startLine: 1,
      endLine: 3,
      content: 'a\nb\nc',
    };
    render(<FileReferenceChip ref={ref} onRemove={() => {}} />);
    expect(screen.getByText('3 lines')).toBeTruthy();
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    const ref: FileReference = { id: '4', kind: 'file', path: 'src/foo/bar.ts' };
    render(<FileReferenceChip ref={ref} onRemove={onRemove} />);
    const removeBtn = screen.getByTitle('Remove reference');
    fireEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
