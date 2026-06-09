import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * On Windows, Node.js `spawn()` without a shell does NOT resolve .cmd/.bat
 * extensions through PATHEXT — it only auto-resolves .exe. Most Node.js CLI
 * tools (npx, pnpm, biome, tsc, vitest, etc.) ship as .cmd wrappers on
 * Windows. This function resolves the command name to its full path so spawn
 * can find it without relying on shell-mode argument concatenation.
 *
 * On non-Windows, returns the command unchanged.
 */
export function resolveWin32Command(cmd: string): string {
  if (process.platform !== 'win32') return cmd;

  // Already has a path or extension — use as-is
  if (cmd.includes('/') || cmd.includes('\\') || path.extname(cmd)) {
    return cmd;
  }

  const pathext = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC')
    .toLowerCase()
    .split(';');

  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter);

  for (const dir of pathDirs) {
    const base = path.join(dir, cmd);
    // Check extensions in PATHEXT order. .EXE should win first because
    // it's typically listed first, and .exe doesn't need shell: true.
    for (const ext of pathext) {
      const full = `${base}${ext}`;
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // Not found with this extension — try next
      }
    }
  }

  // Not found — return original; let spawn report ENOENT with the
  // expected error message so tools can surface it properly.
  return cmd;
}
