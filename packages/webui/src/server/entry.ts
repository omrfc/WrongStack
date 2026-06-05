// Server entry point for standalone WebUI.
// Bind defaults: 127.0.0.1:3457 (loopback only). Override with WS_HOST / WS_PORT.
// HTTP frontend defaults to 3456 (override with PORT). Run several instances on
// different PORT/WS_PORT pairs — `webui --list` shows which are open for which
// project (registry: ~/.wrongstack/webui-instances.json).
import { startWebUI } from './index.js';
import { formatInstances, listInstances } from './instance-registry.js';

const argv = process.argv.slice(2);

// `webui --list` / `webui ls` — print running instances and exit. Cheap,
// side-effect-free (it only prunes dead pids), so it never boots a server.
if (argv.includes('--list') || argv.includes('-l') || argv[0] === 'ls') {
  listInstances()
    .then((instances) => {
      console.log(formatInstances(instances));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[WebUI] Could not read instance registry:', err);
      process.exit(1);
    });
} else {
  const wsPort = Number.parseInt(process.env['WS_PORT'] ?? '3457', 10);
  const wsHost = process.env['WS_HOST'] ?? '127.0.0.1';
  const open =
    argv.includes('--open') || argv.includes('-o') || process.env['WEBUI_OPEN'] === '1';

  console.log(`[WebUI] Starting standalone server on ${wsHost}:${wsPort}...`);

  startWebUI({ wsPort, wsHost, open }).catch((err) => {
    console.error('[WebUI] Fatal error:', err);
    process.exit(1);
  });
}
