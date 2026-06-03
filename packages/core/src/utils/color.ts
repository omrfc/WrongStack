import { isStdoutTTY } from './term.js';

const isColorTty = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return isStdoutTTY();
};

const COLOR = isColorTty();

const wrap =
  (open: string, close: string) =>
  (s: string): string =>
    COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const color = {
  reset: wrap('0', '0'),
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  amber: wrap('38;5;214', '39'),
  pink: wrap('38;5;205', '39'),
  bgRed: wrap('41', '49'),
  bgGreen: wrap('42', '49'),
};

export function stripAnsi(s: string): string {
  return s.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape regex
    /\x1b\[[0-9;]*[A-Za-z]/g,
    '',
  );
}
