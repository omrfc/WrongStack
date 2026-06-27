/**
 * Bash Kill Guard — Intercepts bash kill commands and prevents them from
 * terminating WrongStack processes (either the agent itself or child processes
 * it has spawned).
 *
 * This module hooks into the bash tool's command parsing to detect and block
 * dangerous kill commands targeting protected PIDs.
 *
 * Handles:
 * - Direct kill commands: kill -9 12345
 * - Shell -c wrapped: bash -c "kill -9 12345"
 * - Full path kills: /bin/kill -9 12345
 * - Name-based kills: pkill, killall, pgrep
 * - Windows equivalents: taskkill
 */

import * as os from 'node:os';
import { getPersistentProcessRegistry, type PersistentProcessEntry } from './process-registry-persistent.js';

const isWin = os.platform() === 'win32';

export interface KillCommand {
  pid?: number;
  name?: string;
  signal?: string;
  isGroupKill: boolean;
  isAllKill: boolean;
  originalCommand: string;
}

export interface KillCheckResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Extract the actual kill command from a shell-wrapped command.
 * e.g., "bash -c 'kill -9 12345'" -> "kill -9 12345"
 * e.g., "/bin/bash -c \"pkill node\"" -> "pkill node"
 *
 * P2 #10 (before-release.md): the path pattern now matches any executable
 * followed by `-c`, not just `/bin` and `/usr/bin`. Real systems often have
 * bash at `/usr/local/bin/bash`, `/opt/homebrew/bin/bash`, or invoke it via
 * `/usr/bin/env bash`. Previously these bypassed the guard entirely.
 */
function extractKillCommand(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();

  // Pattern: <any executable path or name> -c "kill ..." or 'kill ...'
  // Matches /bin/bash, /usr/local/bin/bash, /opt/homebrew/bin/bash,
  // /usr/bin/env bash, plain bash/sh/zsh, etc. The executable is any run of
  // non-whitespace, optionally followed by a space and a second token (for
  // the `/usr/bin/env bash` form) before `-c`.
  const shellCMatch = normalized.match(
    /^(?:\S+(?:\s+\S+)?)?\s+-c\s+['"](.+?)['"]$/,
  );
  if (shellCMatch?.[1]) {
    const inner = shellCMatch[1].trim();
    // Recursively check the inner command
    return isKillRelatedCommand(inner) ? inner : null;
  }

  // Pattern: <executable> -c kill -9 12345 (without quotes)
  const shellCUnquoted = normalized.match(
    /^(?:\S+(?:\s+\S+)?)?\s+-c\s+(kill(?:\s+-[a-zA-Z]+)?(?:\s+\d+)+)$/,
  );
  if (shellCUnquoted?.[1]) {
    return shellCUnquoted[1];
  }

  return null;
}

/**
 * Check if a command string is kill-related (for filtering).
 */
function isKillRelatedCommand(cmd: string): boolean {
  const normalized = cmd.toLowerCase().replace(/\s+/g, ' ').trim();

  // P3 #25 (before-release.md): filter by platform so each platform only
  // checks the kill commands it can actually encounter. On Windows, POSIX
  // kill/pkill/killall are dead code (they don't exist on cmd.exe/pwsh); on
  // POSIX, taskkill/tskill are dead code. This lets a single test suite
  // pass on both platforms without platform-conditional assertions.
  if (isWin) {
    // Windows taskkill
    if (/^taskkill\s/i.test(normalized)) return true;
    // Windows tskill
    if (/^tskill\s/i.test(normalized)) return true;
    return false;
  }

  // POSIX
  // Direct kill commands
  if (/^kill(\s|$)/.test(normalized)) return true;

  // Name-based kills
  if (/^(pkill|killall|pgrep|skill)\s/.test(normalized)) return true;

  // Process-related commands that might target specific PIDs
  if (/^\/proc\/\d+\/(?:kill|fd)/.test(normalized)) return true;

  return false;
}

/**
 * Parse a kill command string to extract PID and signal.
 */
export function parseKillCommand(command: string): KillCommand | null {
  const normalized = command.replace(/\s+/g, ' ').trim();

  // P3 #25 (before-release.md): skip parsing commands that don't exist on
  // the current platform. On Windows, kill/pkill/killall/pgrep are dead
  // branches; on POSIX, taskkill/tskill are dead branches. Filtering them
  // out here (not just in isKillRelatedCommand) avoids the regex match cost
  // and makes the test suite platform-independent.
  if (isWin) {
    // taskkill /PID 1234 or taskkill /F /PID 1234
    const taskkillMatch = normalized.match(/^taskkill\s+(?:\/[a-zA-Z]+\s+)*\/PID\s+(\d+)/i);
    if (taskkillMatch?.[1]) {
      const pidStr = taskkillMatch[1];
      return {
        pid: parseInt(pidStr, 10),
        signal: normalized.includes('/F') ? 'FORCE' : 'TERM',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // tskill PID
    const tskillMatch = normalized.match(/^tskill\s+(\d+)/i);
    if (tskillMatch?.[1]) {
      const pidStr = tskillMatch[1];
      return {
        pid: parseInt(pidStr, 10),
        signal: 'TERM',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    return null;
  }

  // POSIX
  // Simple: kill -9 12345 or kill 12345
  const simpleMatch = normalized.match(/^kill\s+(?:(-[a-zA-Z]+)\s+)?(\d+|-?\d+)$/);
  if (simpleMatch) {
    const signal = simpleMatch[1] ?? '-TERM';
    const pidOrGroup = simpleMatch[2];
    if (!pidOrGroup) return null;
    const isGroupKill = pidOrGroup.startsWith('-');
    const pid = isGroupKill ? parseInt(pidOrGroup.slice(1), 10) : parseInt(pidOrGroup, 10);

    return {
      pid,
      signal: signal.slice(1),
      isGroupKill,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // pkill name or pkill -signal name
  const pkillMatch = normalized.match(/^pkill\s+(?:(-[a-zA-Z]+)\s+)?(.+)$/);
  if (pkillMatch?.[2]) {
    const name = pkillMatch[2];
    const signalMatch = pkillMatch[1];
    return {
      name,
      signal: signalMatch ? signalMatch.slice(1) : 'TERM',
      isGroupKill: false,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // killall name or killall -signal name
  const killallMatch = normalized.match(/^killall\s+(?:(-[a-zA-Z]+)\s+)?(.+)$/);
  if (killallMatch?.[2]) {
    const name = killallMatch[2];
    const signalMatch = killallMatch[1];
    return {
      name,
      signal: signalMatch ? signalMatch.slice(1) : 'TERM',
      isGroupKill: false,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // pgrep returns PIDs (not a kill, but could be used with kill)
  const pgrepMatch = normalized.match(/^pgrep\s+(.+)$/);
  if (pgrepMatch) {
    // pgrep by itself isn't dangerous, but log it
    return null;
  }

  return null;
}

/**
 * Get all protected process entries from the registry.
 */
async function getProtectedEntries(): Promise<PersistentProcessEntry[]> {
  const registry = getPersistentProcessRegistry();
  const status = await registry.getGlobalStatus();
  const entries: PersistentProcessEntry[] = [];

  for (const instanceEntries of status.instances.values()) {
    for (const entry of instanceEntries) {
      if (entry.protected && (Date.now() - entry.lastHeartbeat) < 30_000) {
        entries.push(entry);
      }
    }
  }

  return entries;
}

/**
 * Check if a parsed kill command targets a protected WrongStack process.
 */
export async function isKillProtected(kill: KillCommand): Promise<boolean> {
  const registry = getPersistentProcessRegistry();

  // For name-based kills, check if any protected process matches the name
  if (kill.name) {
    const entries = await getProtectedEntries();
    const killNameLower = kill.name.toLowerCase();

    for (const entry of entries) {
      if (entry.name?.toLowerCase().includes(killNameLower)) {
        return true;
      }
    }

    // Also check against our own hostname/process name patterns
    if (killNameLower.includes('wrongstack')) {
      return true;
    }
    if (killNameLower.includes('node') && entries.length > 0) {
      // Conservative: block pkill node if we have protected node processes
      return true;
    }
    return false;
  }

  // For group kills, block if any protected processes exist
  if (kill.isGroupKill) {
    const protectedPids = await registry.getAllProtectedPids();
    return protectedPids.length > 0;
  }

  // Single process kill - check if the target PID is protected
  if (kill.pid !== undefined) {
    return registry.shouldBlockKill(kill.pid);
  }

  return false;
}

/**
 * Main entry point: Check if a bash command contains a kill operation targeting protected PIDs.
 * Returns a result indicating whether to block and why.
 */
export async function checkAndBlockKillCommand(command: string): Promise<KillCheckResult> {
  const normalized = command.replace(/\s+/g, ' ').trim();

  // First, extract any kill command from shell-wrapped commands
  const killCmd = extractKillCommand(normalized) || (isKillRelatedCommand(normalized) ? normalized : null);

  if (!killCmd) {
    return { blocked: false };
  }

  const parsed = parseKillCommand(killCmd);
  if (!parsed) {
    // It's kill-related but couldn't parse - conservative approach
    // e.g., complex pipelines involving kill
    if (killCmd.includes('kill') && /kill\s+.*\|/.test(killCmd)) {
      // kill piped to something - might be "pkill node | xargs kill"
      return {
        blocked: true,
        reason: `Blocked: complex kill pipeline detected — "${killCmd.slice(0, 50)}..."`,
      };
    }
    return { blocked: false };
  }

  if (await isKillProtected(parsed)) {
    let target: string;
    if (parsed.name) {
      target = `process name "${parsed.name}"`;
    } else if (parsed.pid !== undefined) {
      target = `PID ${parsed.pid}`;
    } else {
      target = '(unknown target)';
    }

    const signal = parsed.signal ? ` (${parsed.signal})` : '';
    const groupNote = parsed.isGroupKill ? ' (process group)' : '';
    return {
      blocked: true,
      reason: `Blocked: kill${signal} ${target}${groupNote} targets a protected WrongStack process.`,
    };
  }

  return { blocked: false };
}

/**
 * Get a safe error message for blocked kill commands.
 */
export function getBlockedKillMessage(pid: number, signal?: string): string {
  return (
    `Kill command blocked: PID ${pid}${signal ? ` (signal ${signal})` : ''} is a protected WrongStack process. ` +
    `Use 'exit' or Ctrl+C to gracefully terminate a WrongStack session.`
  );
}
