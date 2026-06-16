/**
 * EnsembleRegistry — discovery layer for ACP-supporting agents.
 *
 * Combines the static catalog (`agents.catalog.ts`) with a runtime
 * `$PATH` probe to report which agents are installed on this machine.
 * The result feeds `wstack acp list`, the `/spawn` picker, and the
 * ensemble UI.
 *
 * Why probe on demand rather than cache at module load
 * ─────────────────────────────────────────────────────
 * The maintainer installs a new agent mid-session. Caching at module
 * load means the cache is stale for the rest of the run. A 5-second
 * per-process cache (`cachedAt`) keeps the common case cheap and the
 * fresh case correct.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { AGENTS_CATALOG } from './agents.catalog.js';

/** Vendor classification — used to filter the catalog by family. */
export type ACPAgentVendor =
  | 'anthropic'
  | 'google'
  | 'openai'
  | 'github'
  | 'community';

/** How the agent is integrated into ACP. */
export type ACPIntegration =
  /** Agent ships with a documented ACP entry flag. */
  | 'native'
  /** Runs through Zed's SDK adapter or similar wrapper. */
  | 'adapter'
  /** Community-maintained wrapper (e.g. @agentify/cline, bub-acp-server). */
  | 'community'
  /** Listed by ACP but no public ACP entry yet; may not work. */
  | 'experimental';

/** Static metadata for a known agent. */
export interface ACPAgentDescriptor {
  /** Stable identifier used as the spawn key. Lowercase, hyphenated. */
  id: string;
  /** Display name shown in the TUI / WebUI / CLI. */
  displayName: string;
  vendor: ACPAgentVendor;
  /** argv to detect installation. Exits 0 with stdout on success. */
  probe: { command: string; args?: readonly string[] };
  /** argv to start the agent in ACP mode. */
  acp: { command: string; args?: readonly string[]; env?: Record<string, string> };
  /** Capability hints — used to fail fast when the binary predates ACP. */
  supports: {
    loadSession: boolean;
    promptImages: boolean;
    terminal: boolean;
    fs: boolean;
  };
  integration: ACPIntegration;
  /** Documentation URL — shown in `wstack acp list` and the ensemble UI. */
  docs: string;
}

/** A descriptor with its runtime detection result attached. */
export interface DetectedAgent extends ACPAgentDescriptor {
  installed: boolean;
  /** Absolute path to the binary, if discovered. */
  path?: string;
  /** Captured version string, if `probe` produced one. */
  version?: string;
  /**
   * When `installed: false`, a short reason — typically "binary not
   * found", "binary predates ACP", or "probe timed out".
   */
  reason?: string;
}

/** A single probe failure — never thrown, always returned. */
interface ProbeFailure {
  ok: false;
  reason: string;
  /** Wall-clock duration of the failed probe in ms. */
  durationMs: number;
}

interface ProbeSuccess {
  ok: true;
  version: string;
  path?: string;
  durationMs: number;
}

type ProbeResult = ProbeSuccess | ProbeFailure;

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_MS = 5_000;

export interface EnsembleRegistryOptions {
  /** Override the catalog (mostly for tests). */
  catalog?: readonly ACPAgentDescriptor[];
  /** Override the probe timeout (ms). */
  probeTimeoutMs?: number;
  /** Inject a custom probe function (used by tests). */
  probeFn?: (descriptor: ACPAgentDescriptor) => Promise<ProbeResult>;
}

/**
 * Probe a single descriptor by running its `probe` argv. Resolves with
 * a structured result rather than throwing — a failed probe is data, not
 * an error.
 */
async function defaultProbe(
  desc: ACPAgentDescriptor,
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already dead
      }
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(desc.probe.command, [...(desc.probe.args ?? [])], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // On Windows, `claude`, `gemini`, `npx`, etc. are typically
        // installed as `.cmd` shims under AppData\Roaming\npm\. Node's
        // spawn() will not find them without shell-mode unless the
        // extension is present. `shell: true` resolves this for the
        // common case. The probe argv is always from our static
        // catalog, never user input, so shell-expansion is bounded.
        shell: process.platform === 'win32',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ ok: false, reason: `spawn failed: ${msg}`, durationMs: 0 });
      return;
    }

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'probe timed out', durationMs: Date.now() - start });
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        reason: `binary not found: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const out = (stdout + stderr).trim();

      // With `shell: true` on Windows, spawn() never ENOENTs — the
      // cmd shell launches, prints "<command> is not recognized", and
      // exits non-zero. Detect that specific shape and treat the binary
      // as not-installed. The literal string is locale-stable for
      // Windows cmd.exe English (the only locale we ship in CI).
      const isWindowsShellMiss =
        process.platform === 'win32' &&
        out.toLowerCase().includes('is not recognized');

      if (isWindowsShellMiss) {
        finish({
          ok: false,
          reason: 'binary not found',
          durationMs,
        });
        return;
      }

      if (out.length > 0) {
        // The binary ran and produced output. We don't gate on exit
        // code: some agents print version info but exit non-zero; some
        // print to stderr. If we got here without a shell-miss, the
        // binary is installed.
        finish({
          ok: true,
          version: out.split('\n')[0]?.trim() ?? '',
          path: desc.probe.command,
          durationMs,
        });
        return;
      }
      // Empty output: the binary didn't behave as a version probe.
      // Treat as not-installed with the exit code as the reason.
      finish({
        ok: false,
        reason: `exit code ${code ?? 'null'}; no output`,
        durationMs,
      });
    });
  });
}

export class EnsembleRegistry {
  private readonly catalog: readonly ACPAgentDescriptor[];
  private readonly timeoutMs: number;
  private readonly probe: (d: ACPAgentDescriptor) => Promise<ProbeResult>;
  private cache: { at: number; result: readonly DetectedAgent[] } | null = null;

  constructor(options: EnsembleRegistryOptions = {}) {
    this.catalog = options.catalog ?? AGENTS_CATALOG;
    this.timeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.probe = options.probeFn ?? ((d) => defaultProbe(d, this.timeoutMs));
  }

  /** Return the full catalog (no probe), in catalog order. */
  listAll(): readonly ACPAgentDescriptor[] {
    return this.catalog;
  }

  /**
   * Probe every catalog entry in parallel and return the detection
   * results. Results are cached for `PROBE_CACHE_MS`.
   */
  async list(): Promise<readonly DetectedAgent[]> {
    if (this.cache && Date.now() - this.cache.at < PROBE_CACHE_MS) {
      return this.cache.result;
    }
    const result = await Promise.all(
      this.catalog.map((d) => this.detect(d)),
    );
    this.cache = { at: Date.now(), result };
    return result;
  }

  /** Probe a single descriptor. Always returns a `DetectedAgent`. */
  async detect(desc: ACPAgentDescriptor): Promise<DetectedAgent> {
    const result = await this.probe(desc);
    if (result.ok) {
      const detected: DetectedAgent = {
        ...desc,
        installed: true,
        version: result.version,
      };
      if (result.path !== undefined) detected.path = result.path;
      return detected;
    }
    return { ...desc, installed: false, reason: result.reason };
  }

  /** Invalidate the per-process cache. */
  invalidate(): void {
    this.cache = null;
  }

  /** Convenience: just the installed agents. */
  async listInstalled(): Promise<readonly DetectedAgent[]> {
    const all = await this.list();
    return all.filter((a) => a.installed);
  }
}
