import { describe, expect, it } from 'vitest';
import { firstSelectable, skipDivider } from '../src/app-reducer.js';
import type { ProjectPickerItem } from '../src/components/project-picker.js';

function item(key: string, over: Partial<ProjectPickerItem> = {}): ProjectPickerItem {
  return { key, label: over.label ?? key, kind: over.kind ?? 'project', ...over };
}

function div(): ProjectPickerItem {
  return { key: '__divider__', label: '───', kind: 'action' };
}

// ── firstSelectable ──────────────────────────────────────────────────────

describe('firstSelectable', () => {
  it('returns 0 for an empty list', () => {
    expect(firstSelectable([])).toBe(0);
  });

  it('returns first index when list has no dividers', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(firstSelectable(items)).toBe(0);
  });

  it('skips leading dividers and returns first project item', () => {
    const items = [div(), div(), item('project-a'), item('project-b')];
    expect(firstSelectable(items)).toBe(2);
  });

  it('returns 0 when every item is a divider', () => {
    const items = [div(), div(), div()];
    expect(firstSelectable(items)).toBe(0);
  });

  it('returns 0 when first item is not a divider even with dividers later', () => {
    const items = [item('first'), div(), item('second')];
    expect(firstSelectable(items)).toBe(0);
  });

  it('finds the first project in a realistic picker list', () => {
    const items = [
      div(),
      item('new-session', { label: '+ Start new session', kind: 'action' }),
      item('quit', { label: 'q Quit', kind: 'action' }),
      item('my-project', { label: '● My Project' }),
    ];
    // First non-divider is 'new-session' at index 1
    expect(firstSelectable(items)).toBe(1);
  });
});

// ── skipDivider ──────────────────────────────────────────────────────────

describe('skipDivider', () => {
  it('returns same index when item is not a divider', () => {
    const items = [item('a'), item('b')];
    expect(skipDivider(items, 0, 1)).toBe(0);
    expect(skipDivider(items, 1, -1)).toBe(1);
  });

  it('skips forward over consecutive dividers', () => {
    const items = [div(), div(), item('project-a'), item('project-b')];
    expect(skipDivider(items, 0, 1)).toBe(2);
    expect(skipDivider(items, 1, 1)).toBe(2);
  });

  it('skips backward over consecutive dividers', () => {
    const items = [item('project-a'), div(), div(), item('project-b')];
    // Start at index 2 (divider), skip backward to 0 (project-a)
    expect(skipDivider(items, 2, -1)).toBe(0);
    // Start at index 1 (divider), skip backward to 0 (project-a)
    expect(skipDivider(items, 1, -1)).toBe(0);
  });

  it('wraps around when all items past a point are dividers', () => {
    const items = [item('a'), item('b'), div(), div()];
    // Start at index 2 (divider), forward → wraps to 0
    expect(skipDivider(items, 2, 1)).toBe(0);
    // Start at index 3 (divider), forward → wraps to 0
    expect(skipDivider(items, 3, 1)).toBe(0);
  });

  it('wraps backward when backed into start with dividers', () => {
    const items = [div(), div(), item('c'), item('d')];
    // Start at index 0 (divider), backward → wraps to 3 (item d)
    expect(skipDivider(items, 0, -1)).toBe(3);
    // Start at index 1 (divider), backward → wraps to 3
    expect(skipDivider(items, 1, -1)).toBe(3);
  });

  it('stays put when all items are dividers', () => {
    const items = [div(), div(), div()];
    expect(skipDivider(items, 0, 1)).toBe(0);
    expect(skipDivider(items, 1, -1)).toBe(1);
  });

  it('skips single divider in the middle of the list', () => {
    const items = [item('a'), div(), item('b')];
    // From divider at 1, forward → 2
    expect(skipDivider(items, 1, 1)).toBe(2);
    // From divider at 1, backward → 0
    expect(skipDivider(items, 1, -1)).toBe(0);
  });

  it('handles realistic picker layout with actions after divider', () => {
    const items = [
      item('proj-1', { label: '● Project One', subtitle: '/home/p1' }),
      item('proj-2', { label: '  Project Two', subtitle: '/home/p2' }),
      div(),
      item('new-session', { label: '+ Start new session', kind: 'action' }),
      item('prev-sessions', { label: '⏱ Previous sessions', kind: 'action' }),
      item('quit', { label: 'q Quit', kind: 'action' }),
    ];
    // From divider at 2, forward → 3 (new-session)
    expect(skipDivider(items, 2, 1)).toBe(3);
    // From divider at 2, backward → 1 (Project Two)
    expect(skipDivider(items, 2, -1)).toBe(1);
    // From new-session at 3, backward stays since it's not a divider
    expect(skipDivider(items, 3, -1)).toBe(3);
  });

  it('correctly navigates a list with many projects + divider + actions', () => {
    const projects = Array.from({ length: 20 }, (_, i) =>
      item(`proj-${i}`, { label: `Project ${i}`, subtitle: `/home/p${i}` }),
    );
    const items = [...projects, div(), item('quit', { label: 'q Quit', kind: 'action' })];

    // Arrow down from last project (index 19) → skip divider at 20 → quit at 21
    expect(skipDivider(items, 19, 1)).toBe(19); // 19 is project, stays

    // Arrow down from quit (index 21) → wrap to 0 (Project 0)
    // Actually, quit is not a divider. Let's test from the divider:
    expect(skipDivider(items, 20, 1)).toBe(21); // divider → quit
    expect(skipDivider(items, 20, -1)).toBe(19); // divider → last project
  });
});

// ── Stress: 50+ projects ─────────────────────────────────────────────────

describe('project picker with 50+ projects', () => {
  /** Build a realistic picker list with N projects + divider + 3 action items. */
  function makeList(projectCount: number): ProjectPickerItem[] {
    const projects = Array.from({ length: projectCount }, (_, i) =>
      item(`proj-${i}`, {
        label: `  Project ${String(i).padStart(2, '0')}`,
        subtitle: `/home/user/projects/project-${String(i).padStart(2, '0')}`,
        meta: `${i + 1}d ago`,
      }),
    );
    return [
      ...projects,
      div(),
      item('new-session', { label: '+ Start new session', kind: 'action' }),
      item('prev-sessions', { label: '⏱ Previous sessions', kind: 'action' }),
      item('quit', { label: 'q Quit', kind: 'action' }),
    ];
  }

  it('firstSelectable returns 0 for a 50-item list with no leading dividers', () => {
    const items = makeList(50);
    expect(firstSelectable(items)).toBe(0);
  });

  it('navigates down through all 50 projects without landing on dividers', () => {
    const items = makeList(50);
    let idx = 0;
    // Walk forward through all items, verifying we never stop on a divider
    for (let step = 0; step < items.length; step++) {
      expect(items[idx]?.key).not.toBe('__divider__');
      idx = skipDivider(items, (idx + 1) % items.length, 1);
    }
  });

  it('navigates up through all 50 projects without landing on dividers', () => {
    const items = makeList(50);
    let idx = 0;
    for (let step = 0; step < items.length; step++) {
      expect(items[idx]?.key).not.toBe('__divider__');
      idx = skipDivider(items, (idx - 1 + items.length) % items.length, -1);
    }
  });

  it('wraps around at boundaries smoothly', () => {
    const items = makeList(50);
    const lastProjectIdx = 49;

    // From last project (project item, not a divider) → stays put
    expect(skipDivider(items, lastProjectIdx, 1)).toBe(lastProjectIdx);

    // From divider at 50, forward → new-session at 51
    expect(skipDivider(items, 50, 1)).toBe(51);

    // From new-session at 51 → stays (not a divider)
    expect(skipDivider(items, 51, 1)).toBe(51);

    // From prev-sessions at 52 → stays (not a divider)
    expect(skipDivider(items, 52, 1)).toBe(52);

    // From quit at 53, forward → stays (not a divider — wrapping happens in
    // the move handler which computes (idx + delta) % items.length first)
    expect(skipDivider(items, 53, 1)).toBe(53);

    // Simulate the move handler's wrap: (53 + 1) % 54 = 0, then skipDivider
    expect(skipDivider(items, (53 + 1) % items.length, 1)).toBe(0);

    // From first project (0), backward → simulate move handler wrap
    // (−1 + 54) % 54 = 53, then skipDivider from 53 forward (but direction is -1)
    // The move handler passes a direction derived from delta sign.
    // skipDivider(53, -1) → 53 (not a divider, stays)
    expect(skipDivider(items, 0, -1)).toBe(0);
    // Wrap: (0 − 1 + 54) % 54 = 53, then skipDivider(53, -1) → 53
    const wrapped = (0 - 1 + items.length) % items.length;
    expect(skipDivider(items, wrapped, -1)).toBe(53);
  });

  it('firstSelectable finds the first item in a 100-item list', () => {
    const items = makeList(100);
    expect(firstSelectable(items)).toBe(0);
  });

  it('skipDivider handles a 200-item list without performance issues', () => {
    const items = makeList(200);
    const start = Date.now();
    // Make 200 calls — should complete in well under 10ms
    let idx = 0;
    for (let i = 0; i < 200; i++) {
      idx = skipDivider(items, idx, 1);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // generous upper bound
  });
});
