import { describe, expect, it } from 'vitest';
import { browserOpenCommand, openBrowser } from '../../src/server/open-browser.js';

describe('browserOpenCommand', () => {
  const url = 'http://127.0.0.1:3456';

  it('uses cmd start on Windows with an empty title slot', () => {
    expect(browserOpenCommand(url, 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', url],
    });
  });

  it('uses open on macOS', () => {
    expect(browserOpenCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
  });

  it('uses xdg-open on Linux/other', () => {
    expect(browserOpenCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
  });
});

describe('openBrowser', () => {
  it('never throws even when the opener is missing', () => {
    // Force a platform whose opener almost certainly does not exist here; the
    // spawn error must be swallowed asynchronously rather than crash.
    expect(() => openBrowser('http://127.0.0.1:65000', 'linux')).not.toThrow();
  });
});
