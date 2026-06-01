import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export interface UpdateInfo {
  current: string;
  latest: string;
  outdated: boolean;
  checkFailed: boolean;
}

type HomeDirFn = () => string;
const defaultHomeDir: HomeDirFn = () => os.homedir();

/** Cache dosyasının path'i — test için inject edilebilir homeFn */
export function cachePath(homeFn: HomeDirFn = defaultHomeDir): string {
  return path.join(homeFn(), '.wrongstack', 'update-cache.json');
}

/** 24 saat TTL */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  timestamp: number;
  latestVersion: string;
  error?: string;
}

/** Mevcut CLI versiyonunu package.json'den oku */
export function currentVersion(): string {
  const req = createRequire(import.meta.url);
  const candidates = ['../package.json', '../../package.json'];
  for (const rel of candidates) {
    try {
      const pkg = req(rel) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // try next
    }
  }
  return 'dev';
}

/** Semver comparison — returns true if a > b */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((p) => Number.parseInt(p, 10) || 0);
  const [ap, bp] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const ai = ap[i] ?? 0;
    const bi = bp[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/** Cache oku — süresi geçmişse null döner */
async function readCache(homeFn: HomeDirFn = defaultHomeDir): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(cachePath(homeFn), 'utf8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Cache yaz */
async function writeCache(entry: CacheEntry, homeFn: HomeDirFn = defaultHomeDir): Promise<void> {
  try {
    const dir = path.dirname(cachePath(homeFn));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cachePath(homeFn), JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

/** npm registry'den latest versiyonu çek */
async function fetchLatestFromNpm(timeoutMs = 3000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://registry.npmjs.org/wrongstack/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`npm registry responded ${res.status}`);
    const data = await res.json() as { version?: unknown };
    if (typeof data.version === 'string') return data.version;
    throw new Error('No version field in npm response');
  } finally {
    clearTimeout(timer);
  }
}

/** Update bilgisini döner — cache-first, network fallback */
export async function checkForUpdate(
  signal?: AbortSignal,
  homeFn?: HomeDirFn,
): Promise<UpdateInfo> {
  const current = currentVersion();
  const aborted = () => signal?.aborted ?? false;
  const hf = homeFn ?? defaultHomeDir;

  // Already aborted before we even start — skip network entirely
  if (aborted()) {
    return { current, latest: current, outdated: false, checkFailed: true };
  }

  // Cache'e bak
  const cached = await readCache(hf);
  if (cached && !cached.error) {
    return {
      current,
      latest: cached.latestVersion,
      outdated: isNewer(cached.latestVersion, current),
      checkFailed: false,
    };
  }

  // Network kontrolü
  try {
    const latest = await fetchLatestFromNpm();
    await writeCache({ timestamp: Date.now(), latestVersion: latest }, hf);

    return {
      current,
      latest,
      outdated: isNewer(latest, current),
      checkFailed: false,
    };
  } catch (_err) {
    // Network hatası — sessiz devam, cache'e yazma
    if (aborted()) {
      return { current, latest: current, outdated: false, checkFailed: true };
    }

    // Prior cache varsa onu kullan (eski data ama en azından birşey var)
    if (cached?.latestVersion) {
      return {
        current,
        latest: cached.latestVersion,
        outdated: isNewer(cached.latestVersion, current),
        checkFailed: true,
      };
    }

    return { current, latest: current, outdated: false, checkFailed: true };
  }
}

/** Update varsa notification string'i döner, yoksa null */
export async function getUpdateNotification(
  signal?: AbortSignal,
  homeFn?: HomeDirFn,
): Promise<string | null> {
  const info = await checkForUpdate(signal, homeFn);
  if (info.outdated) {
    return `Update available: v${info.current} → v${info.latest}`;
  }
  return null;
}