import { color } from '@wrongstack/core';
import { addCustomProvider, addFromCatalog } from './add-provider.js';
import { runClaudeOAuthLogin } from './anthropic-oauth.js';
import { runCopilotOAuthLogin } from './github-copilot-oauth.js';
import { loadProviders } from './helpers.js';
import { runCodexOAuthLogin } from './openai-codex-oauth.js';
import { manageProvider } from './provider-menu.js';
import { renderTopMenu } from './shared.js';
import type { AuthMenuDeps } from './types.js';

/** Sub-menu: pick a subscription to sign in with (OAuth). */
async function runSignInMenu(deps: AuthMenuDeps): Promise<void> {
  deps.renderer.write(
    `\n  ${color.bold('Sign in with a subscription:')}\n` +
      `    ${color.bold('1')}  ChatGPT Plus/Pro  ${color.dim('(→ openai-codex)')}\n` +
      `    ${color.bold('2')}  Claude Pro/Max    ${color.dim('(→ anthropic-oauth)')}\n` +
      `    ${color.bold('3')}  GitHub Copilot    ${color.dim('(→ github-copilot)')}\n`,
  );
  const pick = (await deps.reader.readLine(`  ${color.amber('?')} Pick ${color.dim('(or b to go back)')}: `))
    .trim()
    .toLowerCase();
  if (pick === '1' || pick === 'chatgpt' || pick === 'openai' || pick === 'codex') {
    await runCodexOAuthLogin(deps);
  } else if (pick === '2' || pick === 'claude' || pick === 'anthropic') {
    await runClaudeOAuthLogin(deps);
  } else if (pick === '3' || pick === 'copilot' || pick === 'github') {
    await runCopilotOAuthLogin(deps);
  }
}

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

    // Sign in with a subscription (OAuth)
    if (choice === 's' || choice === 'signin' || choice === 'login') {
      await runSignInMenu(deps);
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
