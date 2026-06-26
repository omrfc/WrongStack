/**
 * Session-shell resolution for Windows.
 *
 * `pickShell` (`_shell-pick.ts`) decides the shell *per command* — it inspects
 * each command string and routes PowerShell-looking work to PowerShell, else
 * `cmd.exe`. That keeps individual commands working, but it means the shell the
 * model is *told* about (the system-prompt Environment block) and the shell that
 * actually runs a given command can disagree, and a plain command like
 * `git status` silently lands in `cmd.exe` while `Get-ChildItem` lands in
 * PowerShell. The model has no stable target to write syntax for.
 *
 * This module resolves ONE shell for the whole session and pins it via the
 * `WRONGSTACK_SHELL` env var. Because `WRONGSTACK_SHELL` is already the top
 * precedence in `pickShell`, pinning it makes every command route to the same
 * shell with zero changes to `bash.ts` — and the system-prompt builder can read
 * the same env var to tell the model exactly which shell + syntax to use.
 *
 * Resolution (Windows only — POSIX has no fixed session shell here; `bash.ts`
 * routes through `/bin/bash -c` and honours an explicit `WRONGSTACK_SHELL` as a
 * binary path):
 *   1. A valid user-set `WRONGSTACK_SHELL` (cmd | powershell | pwsh) wins and is
 *      left untouched.
 *   2. Otherwise prefer `pwsh` (PowerShell 7+) when `pwsh.exe` is on PATH.
 *   3. Otherwise `powershell` (Windows PowerShell 5.1).
 *   4. Otherwise `cmd` (only when no PowerShell is installed — effectively never
 *      on a real Windows box).
 *
 * @see {@link ../../docs/configuration.md#windows-shell-selection-wrongstackshell}
 */

import type { BashShell } from './_shell-pick.js';
import { resolveWin32Command } from './_win32-resolve.js';

/**
 * Map a raw `WRONGSTACK_SHELL` value (which may carry a `.exe` suffix or odd
 * casing) to a canonical {@link BashShell}, or `undefined` when it is unset /
 * not a known shell. Mirrors the override parsing in `pickShell`.
 */
export function normalizeShell(value: string | undefined): BashShell | undefined {
  const v = value?.trim().toLowerCase();
  if (v === 'cmd' || v === 'cmd.exe') return 'cmd';
  if (v === 'powershell' || v === 'powershell.exe') return 'powershell';
  if (v === 'pwsh' || v === 'pwsh.exe') return 'pwsh';
  return undefined;
}

export interface ResolveSessionShellDeps {
  /**
   * Returns true when `bin` (e.g. `'pwsh.exe'`) resolves on PATH. Injectable so
   * the resolver is unit-testable off-Windows; defaults to `resolveWin32Command`
   * (which itself short-circuits to "not found" when `process.platform` is not
   * win32).
   */
  hasBinary?: ((bin: string) => boolean) | undefined;
}

/**
 * Pure decision: which single shell should the session use on `platform`?
 * Returns `undefined` on non-win32 (no fixed session shell). Does not mutate
 * anything.
 */
export function resolveSessionShell(
  platform: NodeJS.Platform,
  env: { get(key: string): string | undefined },
  deps: ResolveSessionShellDeps = {},
): BashShell | undefined {
  if (platform !== 'win32') return undefined;

  // 1. Respect an explicit, valid user override.
  const override = normalizeShell(env.get('WRONGSTACK_SHELL'));
  if (override) return override;

  // 2-4. Probe for PowerShell, prefer the modern edition.
  const hasBinary = deps.hasBinary ?? ((bin: string) => resolveWin32Command(bin) !== bin);
  if (hasBinary('pwsh.exe')) return 'pwsh';
  if (hasBinary('powershell.exe')) return 'powershell';
  return 'cmd';
}

export interface EnsureSessionShellOptions {
  /** Env to read/mutate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Platform override (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Binary-presence probe (tests). Forwarded to {@link resolveSessionShell}. */
  hasBinary?: ((bin: string) => boolean) | undefined;
}

/**
 * Resolve the session shell and pin it into `WRONGSTACK_SHELL` so the bash tool
 * and the system-prompt builder agree on one stable value. Idempotent:
 *
 *   - non-win32 → no-op, returns `undefined`.
 *   - a valid user-set `WRONGSTACK_SHELL` → returned as-is, env left untouched.
 *   - otherwise → resolves, writes the canonical value into the env, returns it.
 *
 * Call this once at process boot, before the system-prompt builder is built.
 */
export function ensureSessionShell(opts: EnsureSessionShellOptions = {}): BashShell | undefined {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return undefined;

  // User already pinned a valid shell — honour it, do not rewrite.
  const existing = normalizeShell(env['WRONGSTACK_SHELL']);
  if (existing) return existing;

  const chosen =
    resolveSessionShell(platform, { get: (k) => env[k] }, { hasBinary: opts.hasBinary }) ?? 'cmd';
  env['WRONGSTACK_SHELL'] = chosen;
  return chosen;
}
