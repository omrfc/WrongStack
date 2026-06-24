/**
 * PersistentProcessRegistry — filesystem-backed process registry that survives
 * process restarts and coordinates protection across multiple WrongStack instances
 * running in different terminals.
 *
 * Key features:
 * - PIDs stored in ~/.wrongstack/process-registry.json
 * - File locking for cross-instance coordination
 * - Heartbeat mechanism to detect stale entries
 * - Protection whitelist that blocks kill commands targeting WrongStack processes
 * - Multi-instance awareness: all instances share the same protection state
 */

// Note: spawn imported for potential future use with child process tracking
import * as fs from 'node:fs/promises';
// Note: fsSync imported for potential future use with synchronous file operations
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getProcessRegistry, type ProcessRegistryImpl } from './process-registry.js';

const REGISTRY_FILE = '.wrongstack/process-registry.json';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitStructuredLog(level: 'debug' | 'info' | 'warn' | 'error', event: string, message: string, error?: unknown): void {
  const payload: { level: 'debug' | 'info' | 'warn' | 'error'; event: string; message: string; error?: string; timestamp: string } = {
    level,
    event,
    message,
    timestamp: new Date().toISOString(),
  };

  if (error !== undefined) {
    payload.error = toErrorMessage(error);
  }

  console.log(JSON.stringify(payload));
}
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_THRESHOLD_MS = 30_000;
const LOCKFILE = '.wrongstack/.process-registry.lock';

export interface PersistentProcessEntry {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  lastHeartbeat: number;
  sessionId?: string;
  instanceId: string;
  /** Hostname where this process is running */
  hostname: string;
  protected: boolean;
  /** How this process was spawned: 'fork' (child_process.fork), 'spawn' (child_process.spawn), 'main' (the main WrongStack process itself) */
  spawnMode: 'fork' | 'spawn' | 'main';
  /** Parent PID if spawned via fork/spawn */
  parentPid?: number;
  /** OS platform where this entry was created */
  platform: string;
}

export interface PersistentRegistryData {
  version: 1;
  instances: Map<string, PersistentProcessEntry>;
  protectedPatterns: string[];
  lastCleanup: number;
}

/**
 * Generate a unique instance ID for this WrongStack process.
 * Combines hostname + pid + random suffix for uniqueness across restarts.
 */
function generateInstanceId(): string {
  const hostname = os.hostname();
  const pid = process.pid;
  const random = Math.random().toString(36).slice(2, 8);
  return `${hostname}:${pid}:${random}`;
}

/**
 * Acquire a file lock using flock-style locking.
 * On Windows, uses a separate lockfile with atomic rename.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

async function acquireLock(lockfilePath: string, timeoutMs = 5000): Promise<() => Promise<void>> {
  const start = Date.now();
  const pidStr = String(process.pid);
  const hostStr = os.hostname();

  while (Date.now() - start < timeoutMs) {
    try {
      // Try to create the lock file exclusively
      await fs.writeFile(lockfilePath, `${pidStr}:${hostStr}:${Date.now()}`, { flag: 'wx' });
      return async () => {
        try {
          await fs.unlink(lockfilePath);
        } catch {
          // Lock file may have been cleaned up by another process
        }
      };
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        // Lock exists - check if the holder is still alive
        try {
          const content = await fs.readFile(lockfilePath, 'utf-8');
          const parts = content.split(':');
          const lockPidStr = parts[0] ?? '0';
          const lockPid = parseInt(lockPidStr, 10);

          // On Unix, check if process is still running
          if (process.platform !== 'win32') {
            try {
              process.kill(lockPid, 0); // Signal 0 just checks if process exists
            } catch {
              // Lock holder is dead - steal the lock
              await fs.unlink(lockfilePath);
              continue;
            }
          }
        } catch {
          // Can't read lock file - assume stale, try to steal
          try {
            await fs.unlink(lockfilePath);
          } catch {
            /* ignore */
          }
        }

        // Wait before retrying
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to acquire lock after ${timeoutMs}ms`);
}

/**
 * Read and parse the persistent registry file.
 * Returns empty data if file doesn't exist or is corrupted.
 */
async function readRegistryFile(filePath: string): Promise<PersistentRegistryData> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Convert instances array back to Map
    if (parsed.instances && Array.isArray(parsed.instances)) {
      parsed.instances = new Map(parsed.instances);
    }

    return parsed;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {
        version: 1,
        instances: new Map(),
        protectedPatterns: ['wrongstack', 'node'],
        lastCleanup: Date.now(),
      };
    }
    throw err;
  }
}

/**
 * Write the registry file atomically using rename.
 */
async function writeRegistryFile(filePath: string, data: PersistentRegistryData): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const content = JSON.stringify(data, (_k, v) => {
    if (v instanceof Map) {
      return Array.from(v.entries());
    }
    return v;
  }, 2);

  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * PersistentProcessRegistry wraps the in-memory ProcessRegistryImpl and
 * synchronizes entries to a filesystem-backed store for cross-instance coordination.
 */
export class PersistentProcessRegistry {
  private readonly instanceId: string;
  private readonly registryPath: string;
  private readonly lockPath: string;
  private readonly baseRegistry: ProcessRegistryImpl;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;

  constructor(baseRegistry?: ProcessRegistryImpl) {
    this.instanceId = generateInstanceId();
    const homeDir = os.homedir();
    this.registryPath = path.join(homeDir, REGISTRY_FILE);
    this.lockPath = path.join(homeDir, LOCKFILE);
    this.baseRegistry = baseRegistry ?? getProcessRegistry();

    // Ensure the .wrongstack directory exists
    this.ensureDirectory().catch((err) => {
      emitStructuredLog('warn', 'process_registry.dir_create_failed', 'PersistentProcessRegistry: failed to create .wrongstack directory', err);
    });
  }

  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.registryPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'EEXIST') throw err;
    }
  }

  /**
   * Start the heartbeat and periodic cleanup tasks.
   */
  start(): void {
    if (this.heartbeatInterval) return;

    // Register this instance's processes with the persistent registry
    this.syncToPersistent();

    // Heartbeat every 5 seconds to mark entries as alive
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();

    // Cleanup stale entries every 30 seconds
    setInterval(() => {
      this.cleanupStaleEntries();
    }, STALE_THRESHOLD_MS).unref?.();

    // Register main process on startup
    this.registerMainProcess();

    // Sync on significant events
    process.on('exit', () => this.syncToPersistent());
  }

  /**
   * Stop the heartbeat and clean up.
   */
  stop(): void {
    this.isShuttingDown = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.syncToPersistent();
  }

  /**
   * Register the main WrongStack process as protected.
   */
  registerMainProcess(): void {
    const mainPid = process.pid;

    this.updatePersistentEntry({
      pid: mainPid,
      name: 'wrongstack-main',
      command: process.argv.slice(0, 3).join(' '),
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      instanceId: this.instanceId,
      hostname: os.hostname(),
      protected: true,
      spawnMode: 'main',
      parentPid: process.ppid,
      platform: process.platform,
    });
  }

  /**
   * Register a spawned child process with the persistent registry.
   */
  registerChildProcess(pid: number, name: string, command: string, sessionId?: string, spawnMode: 'spawn' | 'fork' = 'spawn'): void {
    const entry: PersistentProcessEntry = {
      pid,
      name,
      command,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      instanceId: this.instanceId,
      hostname: os.hostname(),
      protected: true, // All WrongStack child processes are protected by default
      spawnMode,
      parentPid: process.pid,
      platform: process.platform,
    };
    if (sessionId) {
      entry.sessionId = sessionId;
    }
    this.updatePersistentEntry(entry);
  }

  /**
   * Update or add an entry in the persistent registry.
   */
  private async updatePersistentEntry(entry: PersistentProcessEntry): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);

      // Update or insert
      data.instances.set(String(entry.pid), entry);

      // Also update the in-memory registry
      const child: ChildProcess = null as unknown as ChildProcess;
      this.baseRegistry.register({
        pid: entry.pid,
        name: entry.name,
        command: entry.command,
        startedAt: entry.startedAt,
        sessionId: entry.sessionId,
        protected: entry.protected,
        child,
      });

      await writeRegistryFile(this.registryPath, data);
    } finally {
      await release();
    }
  }

  /**
   * Unregister a process from the persistent registry.
   */
  async unregister(pid: number): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      data.instances.delete(String(pid));
      await writeRegistryFile(this.registryPath, data);
    } finally {
      await release();
    }
  }

  /**
   * Send heartbeat to mark all this instance's processes as alive.
   */
  private heartbeat(): void {
    if (this.isShuttingDown) return;

    this.syncToPersistent();
  }

  /**
   * Sync this instance's processes to the persistent registry.
   */
  private async syncToPersistent(): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();

      // Update heartbeat for all processes belonging to this instance
      const updatedInstances = new Map<string, PersistentProcessEntry>();

      for (const [_pidStr, entry] of data.instances) {
        if (entry.instanceId === this.instanceId) {
          entry.lastHeartbeat = now;
        }
        // Only keep non-stale entries (or entries from this instance)
        if (entry.instanceId === this.instanceId || (now - entry.lastHeartbeat) < STALE_THRESHOLD_MS) {
          updatedInstances.set(_pidStr, entry);
        }
      }

      data.instances = updatedInstances;
      data.lastCleanup = now;
      await writeRegistryFile(this.registryPath, data);
    } catch (err) {
      emitStructuredLog('warn', 'process_registry.sync_failed', 'PersistentProcessRegistry: sync failed', err);
    } finally {
      await release();
    }
  }

  /**
   * Remove entries for processes that are no longer running.
   */
  private async cleanupStaleEntries(): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();
      const stalePids: string[] = [];

      for (const [_pidStr, entry] of data.instances) {
        const age = now - entry.lastHeartbeat;

        if (age > STALE_THRESHOLD_MS) {
          // Check if process is actually dead
          try {
            if (process.platform !== 'win32') {
              process.kill(entry.pid, 0);
            } else {
              // On Windows, try to open the process
              emitStructuredLog(
                'debug',
                'process_registry.stale_pid_check',
                `PersistentProcessRegistry: checking stale pid ${entry.pid} (${age}ms old)`,
              );            }
          } catch {
            // Process is dead - mark for removal
            stalePids.push(_pidStr);
          }
        }
      }

      if (stalePids.length > 0) {
        for (const pidStr of stalePids) {
          data.instances.delete(pidStr);
        }
        await writeRegistryFile(this.registryPath, data);
      }
    } catch (err) {
      emitStructuredLog('warn', 'process_registry.cleanup_failed', 'PersistentProcessRegistry: cleanup failed', err);
    } finally {
      await release();
    }
  }

  /**
   * Check if a PID belongs to a WrongStack process and should be protected.
   */
  async isProtectedPid(pid: number): Promise<boolean> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const entry = data.instances.get(String(pid));

      if (!entry) return false;

      // Check if stale
      if ((Date.now() - entry.lastHeartbeat) > STALE_THRESHOLD_MS) {
        return false;
      }

      return entry.protected;
    } finally {
      await release();
    }
  }

  /**
   * Get all protected PIDs from all WrongStack instances.
   */
  async getAllProtectedPids(): Promise<number[]> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();
      const protectedPids: number[] = [];

      for (const [_pidStr, entry] of data.instances) {
        if (entry.protected && (now - entry.lastHeartbeat) < STALE_THRESHOLD_MS) {
          protectedPids.push(entry.pid);
        }
      }

      return protectedPids;
    } finally {
      await release();
    }
  }

  /**
   * Get complete status of all tracked processes across all instances.
   */
  async getGlobalStatus(): Promise<{
    instances: Map<string, PersistentProcessEntry[]>;
    totalProcesses: number;
    protectedCount: number;
    staleCount: number;
  }> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();
      const instances = new Map<string, PersistentProcessEntry[]>();
      let protectedCount = 0;
      let staleCount = 0;

      for (const [_pidStr, entry] of data.instances) {
        const instanceEntries = instances.get(entry.instanceId) ?? [];
        instanceEntries.push(entry);
        instances.set(entry.instanceId, instanceEntries);

        if (entry.protected) protectedCount++;
        if ((now - entry.lastHeartbeat) > STALE_THRESHOLD_MS) staleCount++;
      }

      return {
        instances,
        totalProcesses: data.instances.size,
        protectedCount,
        staleCount,
      };
    } finally {
      await release();
    }
  }

  /**
   * Get the instance ID for this process.
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Check if a kill command should be blocked.
   * Returns true if the kill should be blocked (target is a WrongStack process).
   */
  async shouldBlockKill(pid: number): Promise<boolean> {
    const protectedPids = await this.getAllProtectedPids();
    return protectedPids.includes(pid);
  }

  /**
   * Add a pattern-based protection rule.
   * Processes whose command matches any protected pattern are protected.
   */
  async addProtectedPattern(pattern: string): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      if (!data.protectedPatterns.includes(pattern)) {
        data.protectedPatterns.push(pattern);
        await writeRegistryFile(this.registryPath, data);
      }
    } finally {
      await release();
    }
  }
}

// Singleton instance
let _persistentRegistry: PersistentProcessRegistry | undefined;

export function getPersistentProcessRegistry(): PersistentProcessRegistry {
  if (!_persistentRegistry) {
    _persistentRegistry = new PersistentProcessRegistry();
  }
  return _persistentRegistry;
}

export function resetPersistentProcessRegistry(): void {
  if (_persistentRegistry) {
    _persistentRegistry.stop();
    _persistentRegistry = undefined;
  }
}
