import { beforeEach, describe, expect, it, vi } from 'vitest';

// ws-handlers reaches for the live socket — stub it so handlers run server-less.
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn() }),
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { useGitChangesStore } from '../../src/stores/git-changes-store';

const FILES = [
  { path: 'src/a.ts', status: 'M', added: 4, deleted: 2, staged: true },
  { path: 'new.txt', status: '?', added: 1, deleted: 0, staged: false },
];

describe('git.changes / git.diff ws-handlers', () => {
  beforeEach(() => {
    useGitChangesStore.getState().clear();
  });

  it('git.changes populates the file list', () => {
    WS_HANDLERS['git.changes']?.({ type: 'git.changes', payload: { files: FILES } });
    expect(useGitChangesStore.getState().files).toEqual(FILES);
    expect(useGitChangesStore.getState().error).toBeNull();
  });

  it('git.changes surfaces an error and defaults files to []', () => {
    WS_HANDLERS['git.changes']?.({
      type: 'git.changes',
      payload: { files: undefined as unknown as [], error: 'boom' },
    });
    expect(useGitChangesStore.getState().files).toEqual([]);
    expect(useGitChangesStore.getState().error).toBe('boom');
  });

  it('git.diff writes content for the currently selected file', () => {
    useGitChangesStore.getState().select('src/a.ts');
    WS_HANDLERS['git.diff']?.({
      type: 'git.diff',
      payload: { path: 'src/a.ts', oldText: 'old', newText: 'new' },
    });
    const diff = useGitChangesStore.getState().diff;
    expect(diff?.path).toBe('src/a.ts');
    expect(diff?.oldText).toBe('old');
    expect(diff?.newText).toBe('new');
    expect(useGitChangesStore.getState().loadingDiff).toBe(false);
  });

  it('git.diff ignores a reply for a file the user navigated away from', () => {
    useGitChangesStore.getState().select('src/a.ts'); // now viewing a.ts
    WS_HANDLERS['git.diff']?.({
      type: 'git.diff',
      payload: { path: 'other.ts', oldText: 'x', newText: 'y' },
    });
    // Stale reply dropped — still loading a.ts, no diff set.
    expect(useGitChangesStore.getState().diff).toBeNull();
    expect(useGitChangesStore.getState().loadingDiff).toBe(true);
  });

  it('git.diff carries binary / tooLarge / error flags through', () => {
    useGitChangesStore.getState().select('img.png');
    WS_HANDLERS['git.diff']?.({
      type: 'git.diff',
      payload: { path: 'img.png', binary: true },
    });
    const diff = useGitChangesStore.getState().diff;
    expect(diff?.binary).toBe(true);
    expect(diff?.oldText).toBe('');
    expect(diff?.newText).toBe('');
  });
});
