import { spawn } from 'node:child_process';
import { checkForUpdate } from '../../update-check.js';
import type { SubcommandHandler } from '../index.js';

/** `wrongstack update` — CLI'yi npm üzerinden günceller */
export const updateCmd: SubcommandHandler = async (args, deps) => {
  const cwd = deps.cwd;

  // --check-only: sadece kontrol et, indirme
  const checkOnly = args.includes('--check-only') || args.includes('-c');

  const info = await checkForUpdate();

  if (checkOnly) {
    if (info.outdated) {
      deps.renderer.write(`Update available: v${info.current} → v${info.latest}\n`);
    } else {
      deps.renderer.write(`You are on the latest version: v${info.current}\n`);
    }
    return 0;
  }

  if (!info.outdated) {
    deps.renderer.write(`You are already on the latest version: v${info.current}\n`);
    return 0;
  }

  deps.renderer.write(`Updating wrongstack from v${info.current} to v${info.latest}...\n`);

  // npm install -g wrongstack@latest
  try {
    const result = await new Promise<{ code: number }>((resolve, reject) => {
      const child = spawn('npm', ['install', '-g', 'wrongstack@latest'], {
        cwd,
        stdio: 'pipe',
      });
      let _stderr = '';
      child.stderr?.on('data', (d) => { _stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 0 }));
    });

    if (result.code === 0) {
      deps.renderer.write(`\nUpdated to v${info.latest}. Restart wrongstack to use the new version.\n`);
    } else {
      deps.renderer.write(`\nUpdate failed with exit code ${result.code}.\n`);
    }
    return result.code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      deps.renderer.write(`\nUpdate failed: npm not found in PATH.\n`);
      return 1;
    }
    deps.renderer.write(`\nUpdate failed: ${msg}\n`);
    return 1;
  }
};