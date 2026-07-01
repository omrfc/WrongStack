import { describe, expect, it } from 'vitest';
import { stripDesktopLauncherArgs } from '../src/boot/short-circuit-desktop.js';

describe('desktop short-circuit', () => {
  it('strips the flag form before forwarding args to the desktop package', () => {
    expect(stripDesktopLauncherArgs(['--desktop', '--open'])).toEqual(['--open']);
  });

  it('strips the subcommand form before forwarding args to the desktop package', () => {
    expect(stripDesktopLauncherArgs(['desktop', '--inspect'])).toEqual(['--inspect']);
  });
});
