/**
 * Global vitest setup — runs in EVERY worker before any test file.
 *
 * Hermetic global root: redirect ALL `~/.wrongstack` state (config, secrets
 * vault, logs, projects/, mailboxes, sessions) to a per-worker temp dir via
 * the WRONGSTACK_HOME override honored by `wstackGlobalRoot()` /
 * `resolveWstackPaths()`.
 *
 * Without this, tests that boot real runtimes (setupPlugins, repl, webui,
 * mailbox, sdd/goal stores) hit the REAL user home: they read the user's
 * real config.json (which once started a second live Telegram poller from
 * inside the test suite), append to the real wrongstack.log, and leak
 * thousands of fixture project dirs under ~/.wrongstack/projects.
 *
 * Per-PID dir: the forks pool gives each worker its own process, so workers
 * never share state; the OS temp cleaner reclaims the dirs.
 *
 * Tests that pass an explicit `userHome`/`globalRoot` to resolveWstackPaths
 * are unaffected — explicit options take precedence over the env override.
 */
import * as os from 'node:os';
import * as path from 'node:path';

if (!process.env['WRONGSTACK_HOME']) {
  process.env['WRONGSTACK_HOME'] = path.join(os.tmpdir(), `wstack-vitest-${process.pid}`);
}
