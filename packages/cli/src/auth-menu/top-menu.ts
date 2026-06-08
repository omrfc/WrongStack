import { color } from '@wrongstack/core';
import { addCustomProvider, addFromCatalog } from './add-provider.js';
import { loadProviders } from './helpers.js';
import { manageProvider } from './provider-menu.js';
import { renderTopMenu } from './shared.js';
import type { AuthMenuDeps } from './types.js';

/**
 * Interactive auth manager. Shows saved providers + keys, lets the user
 * add/manage providers, and loops until they exit.
 *
 * The legacy single-key `apiKey` field is migrated to `apiKeys[]` lazily
 * on first edit, so users who set up under the old schema upgrade
 * transparently the first time they open this menu.
 */
export async function runTopMenu(deps: AuthMenuDeps): Promise<number> {
  for (;;) {
    const providers = await loadProviders(deps);
    renderTopMenu(deps.renderer, providers);

    const ids = Object.keys(providers).sort();
    const choice = (await deps.reader.readLine(`\n${color.amber('?')} Pick: `))
      .trim()
      .toLowerCase();

    // Quit
    if (!choice || choice === 'q' || choice === 'quit' || choice === 'exit') {
      deps.renderer.write(color.dim('Done.\n'));
      return 0;
    }

    // Add from catalog
    if (choice === 'a' || choice === 'add') {
      await addFromCatalog(deps);
      continue;
    }

    // Custom provider
    if (choice === 'c' || choice === 'custom') {
      await addCustomProvider(deps);
      continue;
    }

    // Numeric selection
    const idx = Number.parseInt(choice, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= ids.length) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by bounds check above
      const pid = ids[idx - 1]!;
      await manageProvider(pid, deps);
      continue;
    }

    // Match by provider id directly
    const byId = ids.find((id) => id.toLowerCase() === choice);
    if (byId) {
      await manageProvider(byId, deps);
      continue;
    }

    deps.renderer.writeError(`Unknown selection: "${choice}"`);
  }
}
