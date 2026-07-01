import { beforeEach, describe, expect, it } from 'vitest';
import {
  refsToMarkdown,
  refLabel,
  useFileReferenceStore,
} from '../../src/stores/file-reference-store';

function resetStore() {
  useFileReferenceStore.setState({ refs: [] });
}

describe('file-reference-store', () => {
  beforeEach(() => resetStore());

  describe('addRef', () => {
    it('adds a file ref and assigns an id', () => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      const state = useFileReferenceStore.getState();
      expect(state.refs).toHaveLength(1);
      expect(state.refs[0]?.kind).toBe('file');
      expect(state.refs[0]?.path).toBe('src/a.ts');
      expect(state.refs[0]?.id).toBeTruthy();
    });

    it('adds a snippet ref with line range and content', () => {
      useFileReferenceStore.getState().addRef({
        kind: 'snippet',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        content: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      });
      const state = useFileReferenceStore.getState();
      expect(state.refs).toHaveLength(1);
      expect(state.refs[0]).toMatchObject({
        kind: 'snippet',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 3,
      });
    });

    it('skips exact-duplicate file refs', () => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      expect(useFileReferenceStore.getState().refs).toHaveLength(1);
    });

    it('allows the same file as both a file ref and a snippet ref', () => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      useFileReferenceStore.getState().addRef({
        kind: 'snippet',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        content: 'x',
      });
      expect(useFileReferenceStore.getState().refs).toHaveLength(2);
    });
  });

  describe('removeRef', () => {
    it('removes only the ref with the matching id', () => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/b.ts' });
      const id = useFileReferenceStore.getState().refs[0]?.id;
      if (id) useFileReferenceStore.getState().removeRef(id);
      const remaining = useFileReferenceStore.getState().refs;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.path).toBe('src/b.ts');
    });

    it('is a no-op for an unknown id', () => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      useFileReferenceStore.getState().removeRef('does-not-exist');
      expect(useFileReferenceStore.getState().refs).toHaveLength(1);
    });
  });

  describe('clearRefs', () => {
    it('empties the refs array', () => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/b.ts' });
      useFileReferenceStore.getState().clearRefs();
      expect(useFileReferenceStore.getState().refs).toHaveLength(0);
    });
  });

  describe('refsToMarkdown', () => {
    it('returns empty string for no refs', () => {
      expect(refsToMarkdown([])).toBe('');
    });

    it('serializes a file ref as an @-mention', () => {
      expect(
        refsToMarkdown([{ id: '1', kind: 'file', path: 'src/a.ts' }]),
      ).toBe('@src/a.ts');
    });

    it('serializes a snippet ref as a fenced code block with a path header', () => {
      const md = refsToMarkdown([
        {
          id: '1',
          kind: 'snippet',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
          content: 'const a = 1;\nconst b = 2;',
        },
      ]);
      expect(md).toContain('```typescript');
      expect(md).toContain('// src/a.ts:1-2');
      expect(md).toContain('const a = 1;');
      expect(md).toContain('const b = 2;');
      expect(md).toContain('```');
    });

    it('truncates very long snippet content', () => {
      const long = 'line\n'.repeat(100);
      const md = refsToMarkdown([
        {
          id: '1',
          kind: 'snippet',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 100,
          content: long,
        },
      ]);
      expect(md).toContain('…');
      expect(md.length).toBeLessThan(long.length);
    });

    it('joins multiple refs with blank-line separators', () => {
      const md = refsToMarkdown([
        { id: '1', kind: 'file', path: 'src/a.ts' },
        { id: '2', kind: 'file', path: 'src/b.ts' },
      ]);
      expect(md).toBe('@src/a.ts\n\n@src/b.ts');
    });
  });

  describe('refLabel', () => {
    it('labels a file ref with its basename', () => {
      expect(refLabel({ id: '1', kind: 'file', path: 'packages/webui/src/a.ts' })).toBe('a.ts');
    });

    it('labels a snippet ref with basename and line range', () => {
      expect(
        refLabel({
          id: '1',
          kind: 'snippet',
          path: 'packages/webui/src/a.ts',
          startLine: 12,
          endLine: 34,
          content: 'x',
        }),
      ).toBe('a.ts:12-34');
    });
  });
});
