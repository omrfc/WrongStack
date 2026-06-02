import { Box, type DOMElement, Text, measureElement, render } from 'ink';
import React, { useLayoutEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { ConfirmPrompt } from '../src/components/confirm-prompt.js';
import { confirmButtonsRow, pickerFirstItemRow } from '../src/hit-test.js';

// Pure-helper assertions plus a render-based ground-truth check: render the
// REAL bottom-region layout, find where each surface actually lands in the
// frame, and assert the hit-test helpers predict that exact 1-based row. This
// pins the layout contract so a future component change (e.g. dropping the
// confirm wrapper's marginY) fails here instead of silently shifting clicks.

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function makeFakeStdout(columns: number) {
  const frames: string[] = [];
  const stream = {
    columns,
    rows: 50,
    write: (s: string) => {
      frames.push(s);
      return true;
    },
    on: () => stream,
    off: () => stream,
    removeListener: () => stream,
    once: () => stream,
    emit: () => false,
  };
  return { stream: stream as unknown as NodeJS.WriteStream, frames };
}

async function renderFrame(el: React.ReactElement, columns = 120): Promise<string[]> {
  const { stream, frames } = makeFakeStdout(columns);
  const instance = render(el, { stdout: stream, patchConsole: false });
  await new Promise((r) => setTimeout(r, 30));
  instance.unmount();
  return stripAnsi(frames.join('')).split('\n');
}

describe('pickerFirstItemRow', () => {
  it('places the first item header rows below the surface top', () => {
    expect(pickerFirstItemRow(0, 1)).toBe(2); // slash/file menu (1 header row)
    expect(pickerFirstItemRow(0, 2)).toBe(3); // model/autonomy (title + hint)
    expect(pickerFirstItemRow(10, 1)).toBe(12);
  });
});

describe('confirmButtonsRow', () => {
  it('accounts for the wrapper marginTop (buttons = rowsAbove + boxHeight)', () => {
    expect(confirmButtonsRow(0, 5)).toBe(5);
    expect(confirmButtonsRow(3, 5)).toBe(8);
  });
});

describe('ground truth: hit-test helpers match the rendered layout', () => {
  it('confirm dialog button row matches confirmButtonsRow for varying rows above', async () => {
    for (const aboveRows of [1, 3]) {
      let boxHeight = -1;
      function Probe(): React.ReactElement {
        const wrapRef = useRef<DOMElement | null>(null);
        useLayoutEffect(() => {
          if (wrapRef.current) boxHeight = measureElement(wrapRef.current).height;
        });
        return React.createElement(
          Box,
          { flexDirection: 'column' },
          // pre-picker region stand-in: `aboveRows` rows of input.
          ...Array.from({ length: aboveRows }, (_v, i) =>
            React.createElement(Text, { key: `a${i}` }, `ABOVE${i}`),
          ),
          // confirm dialog, wrapped exactly like app.tsx (marginY={1}).
          React.createElement(
            Box,
            { key: 'wrap', ref: wrapRef, flexDirection: 'column', marginY: 1 },
            React.createElement(ConfirmPrompt, {
              toolName: 'write',
              input: { path: '/tmp/a.ts' },
              suggestedPattern: 'P',
              onDecision: () => {},
            }),
          ),
        );
      }
      const lines = await renderFrame(React.createElement(Probe));
      // The button row is the rendered line containing the "[y]es" button.
      const actualButtonRow0 = lines.findIndex((l) => l.includes('[y]es'));
      expect(actualButtonRow0).toBeGreaterThan(0);
      const actualButtonRow1 = actualButtonRow0 + 1; // → 1-based screen row
      const rowsAbove = aboveRows; // viewportRows + affordance = 0 in this probe
      expect(confirmButtonsRow(rowsAbove, boxHeight)).toBe(actualButtonRow1);
    }
  });

  it('picker first item row matches pickerFirstItemRow (1-row header)', async () => {
    const aboveRows = 2;
    function Probe(): React.ReactElement {
      return React.createElement(
        Box,
        { flexDirection: 'column' },
        ...Array.from({ length: aboveRows }, (_v, i) =>
          React.createElement(Text, { key: `a${i}` }, `ABOVE${i}`),
        ),
        // slash-menu-shaped picker: paddingX box, 1 header row, then items.
        React.createElement(
          Box,
          { key: 'menu', flexDirection: 'column', paddingX: 1 },
          React.createElement(Text, { key: 'h' }, 'HEADERLINE'),
          React.createElement(Text, { key: 'i0' }, 'FIRSTITEM'),
          React.createElement(Text, { key: 'i1' }, 'SECONDITEM'),
        ),
      );
    }
    const lines = await renderFrame(React.createElement(Probe));
    const firstItem0 = lines.findIndex((l) => l.includes('FIRSTITEM'));
    expect(firstItem0).toBeGreaterThan(0);
    expect(pickerFirstItemRow(aboveRows, 1)).toBe(firstItem0 + 1);
  });
});
