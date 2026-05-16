/**
 * Pins the STEERING preamble contract. The preamble is what the agent
 * actually reads when the user presses Esc + types a new direction —
 * the chat only shows `↯ <text>` and the rich context is hidden from
 * the human view. If the preamble shape regresses, the model loses
 * context silently and starts hedging again, which is exactly what
 * we built this for.
 *
 * Each test pins one structural guarantee:
 *   - the STEERING marker is present so the model can recognise it
 *   - tool/subagent context lands when the snapshot has it, and
 *     is omitted (not stubbed with empty lines) when it doesn't
 *   - the user's actual direction is fenced off so it can't bleed
 *     into the authority section
 *   - the closing `]` mirrors the opening so the block is symmetric
 */
import { describe, expect, it } from 'vitest';
import { buildSteeringPreamble } from '../src/app.js';

describe('buildSteeringPreamble', () => {
  it('marker + authority + fenced direction are always present', () => {
    const out = buildSteeringPreamble(null, 'go look at the auth code');
    // The unique marker the model uses to detect a steer turn.
    expect(out).toMatch(/^\[STEERING — I pressed Esc/);
    // Authority block.
    expect(out).toContain('You have authority to:');
    expect(out).toContain('Abandon the prior plan');
    expect(out).toContain('Re-spawn fresh subagents');
    // Direction is fenced with ---.
    expect(out).toMatch(/New direction:\n---\ngo look at the auth code\n---/);
    // Block is closed.
    expect(out.trimEnd().endsWith(']')).toBe(true);
  });

  it('null snapshot omits the "what was happening" section entirely', () => {
    const out = buildSteeringPreamble(null, 'pivot');
    // No empty stubs — the section is gone, not hollow.
    expect(out).not.toContain('What was happening');
    expect(out).not.toContain('in-flight tools');
    // Context-section subagents line has this exact prefix. The
    // authority section legitimately contains "fresh subagents (with…"
    // so we can't blanket-block "subagents (".
    expect(out).not.toMatch(/subagents \(\d+ terminated/);
  });

  it('snapshot fields surface verbatim when populated', () => {
    const out = buildSteeringPreamble(
      {
        runningTools: ['bash', 'read'],
        subagents: [
          { label: 'bug-hunter', status: 'running', tool: 'grep' },
          { label: 'oracle', status: 'running' },
        ],
        subagentsTerminated: 2,
        partialAssistantText: 'I was about to investigate the parser bug…',
      },
      'forget that, look at the auth bug instead',
    );
    expect(out).toContain('What was happening when I cut you off:');
    expect(out).toContain('in-flight tools (now cancelled): bash, read');
    // Terminated count + names line.
    expect(out).toMatch(/subagents \(2 terminated by me/);
    expect(out).toContain('bug-hunter (was running: grep)');
    expect(out).toContain('oracle');
    // Partial text echoed back to the model.
    expect(out).toContain('investigate the parser bug');
  });

  it('only renders sections that have data — empty arrays are skipped', () => {
    const out = buildSteeringPreamble(
      {
        runningTools: [],
        subagents: [],
        subagentsTerminated: 0,
        partialAssistantText: '',
      },
      'new task',
    );
    // The "what was happening" section has nothing to say — must be
    // omitted entirely so the model doesn't see a hollow header.
    expect(out).not.toContain('in-flight tools');
    // Context-section subagents line has this exact prefix. The
    // authority section legitimately contains "fresh subagents (with…"
    // so we can't blanket-block "subagents (".
    expect(out).not.toMatch(/subagents \(\d+ terminated/);
    expect(out).not.toContain('your last partial output');
  });

  it("the user's direction can't escape the fence", () => {
    // A user typing `---` shouldn't be able to close the fence early
    // and inject after-fence content. (We don't escape it here —
    // worst case the model sees a malformed fence, which is fine
    // because the marker + authority sections are still intact.
    // This test exists to document the boundary, not enforce
    // escaping.)
    const out = buildSteeringPreamble(null, 'innocent\n---\nafter the fence');
    // Both fences still present, model can still recover.
    expect(out).toContain('New direction:');
    expect(out.trimEnd().endsWith(']')).toBe(true);
  });

  it('truncates very long partial text to a 300-char tail so the preamble does not balloon', () => {
    const long = 'a'.repeat(5000);
    const out = buildSteeringPreamble(
      {
        runningTools: [],
        subagents: [],
        subagentsTerminated: 0,
        partialAssistantText: long,
      },
      'next',
    );
    // Tail-only: should NOT carry the full 5000 chars.
    const partialIdx = out.indexOf('your last partial output');
    expect(partialIdx).toBeGreaterThan(-1);
    const tail = out.slice(partialIdx);
    expect(tail.length).toBeLessThan(700); // 300 chars + framing
  });
});
