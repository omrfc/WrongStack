import { describe, expect, it } from 'vitest';
import { hasSgrMouse, parseSgrMouse, stripSgrMouse } from '../src/mouse.js';

const ESC = '\x1b';

describe('parseSgrMouse', () => {
  it('decodes a left-button press with 1-based coords', () => {
    const events = parseSgrMouse(`${ESC}[<0;12;5M`);
    expect(events).toEqual([
      {
        type: 'press',
        button: 'left',
        x: 12,
        y: 5,
        shift: false,
        alt: false,
        ctrl: false,
        drag: false,
      },
    ]);
  });

  it('decodes a left-button release (lowercase terminator)', () => {
    const [ev] = parseSgrMouse(`${ESC}[<0;12;5m`);
    expect(ev?.type).toBe('release');
    expect(ev?.button).toBe('left');
  });

  it('decodes wheel up (64) and wheel down (65)', () => {
    expect(parseSgrMouse(`${ESC}[<64;1;1M`)[0]).toMatchObject({ type: 'wheel', button: 'wheelUp' });
    expect(parseSgrMouse(`${ESC}[<65;1;1M`)[0]).toMatchObject({
      type: 'wheel',
      button: 'wheelDown',
    });
  });

  it('decodes middle and right buttons', () => {
    expect(parseSgrMouse(`${ESC}[<1;3;4M`)[0]?.button).toBe('middle');
    expect(parseSgrMouse(`${ESC}[<2;3;4M`)[0]?.button).toBe('right');
  });

  it('decodes modifier flags (shift/alt/ctrl) and drag motion', () => {
    // left button (0) + shift(4) + alt(8) + ctrl(16) = 28
    const [mods] = parseSgrMouse(`${ESC}[<28;9;9M`);
    expect(mods).toMatchObject({ shift: true, alt: true, ctrl: true, button: 'left', drag: false });
    // left button held + motion (32) = 32
    const [drag] = parseSgrMouse(`${ESC}[<32;9;9M`);
    expect(drag).toMatchObject({ drag: true, type: 'press' });
  });

  it('parses multiple sequences in one chunk, in order (fast wheel spin)', () => {
    const chunk = `${ESC}[<64;1;1M${ESC}[<64;1;1M${ESC}[<65;1;1M`;
    const events = parseSgrMouse(chunk);
    expect(events.map((e) => e.button)).toEqual(['wheelUp', 'wheelUp', 'wheelDown']);
  });

  it('tolerates a stripped ESC byte (bare [<…)', () => {
    const [ev] = parseSgrMouse('[<0;7;3M');
    expect(ev).toMatchObject({ type: 'press', button: 'left', x: 7, y: 3 });
  });

  it('ignores non-mouse bytes and returns [] when there is no sequence', () => {
    expect(parseSgrMouse('hello world')).toEqual([]);
    expect(parseSgrMouse(`${ESC}[200~pasted${ESC}[201~`)).toEqual([]);
  });

  it('decodes a mouse sequence embedded between keyboard bytes', () => {
    const events = parseSgrMouse(`ab${ESC}[<0;2;2Mcd`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ x: 2, y: 2 });
  });
});

describe('hasSgrMouse', () => {
  it('is true for a mouse chunk and false otherwise, statelessly across calls', () => {
    expect(hasSgrMouse(`${ESC}[<0;1;1M`)).toBe(true);
    expect(hasSgrMouse('plain text')).toBe(false);
    // Repeated calls must not be affected by the global regex lastIndex.
    expect(hasSgrMouse(`${ESC}[<0;1;1M`)).toBe(true);
    expect(hasSgrMouse(`${ESC}[<0;1;1M`)).toBe(true);
  });
});

describe('stripSgrMouse', () => {
  it('removes mouse sequences and keeps keyboard bytes', () => {
    expect(stripSgrMouse(`ab${ESC}[<0;2;2Mcd`)).toBe('abcd');
    expect(stripSgrMouse(`${ESC}[<64;1;1M${ESC}[<65;1;1M`)).toBe('');
  });

  it('leaves non-mouse input untouched', () => {
    expect(stripSgrMouse('hello')).toBe('hello');
    expect(stripSgrMouse(`${ESC}[200~x${ESC}[201~`)).toBe(`${ESC}[200~x${ESC}[201~`);
  });
});
