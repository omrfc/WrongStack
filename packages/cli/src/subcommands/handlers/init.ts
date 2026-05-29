import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type Config, atomicWrite, color } from '@wrongstack/core';
import {
  DefaultSecretVault,
  encryptConfigSecrets,
} from '@wrongstack/core/security';
import { detectProjectFacts, renderAgentsTemplate } from '../../slash-commands/helpers.js';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

export const initCmd: SubcommandHandler = async (_args, deps) => {
  deps.renderer.write(color.bold('WrongStack init\n'));
  deps.renderer.writeInfo('Loading provider catalog from models.dev (cached locally)…');
  let providers;
  try {
    providers = await deps.modelsRegistry.listProviders();
  } catch (err) {
    deps.renderer.writeError(
      `Failed to load provider catalog: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
  const detected = providers
    .filter((p: { family: string; envVars: string[] }) => p.family !== 'unsupported')
    .filter((p: { envVars: string[] }) => p.envVars.some((v: string) => process.env[v]));
  const ranked =
    detected.length > 0
      ? detected
      : providers.filter((p: { id: string }) => ['anthropic', 'openai', 'google'].includes(p.id));
  if (detected.length > 0)
    deps.renderer.write(
      `Detected API keys for: ${detected.map((p: { name: string }) => p.name).join(', ')}\n`,
    );
  const defaultId = ranked[0]?.id ?? 'anthropic';
  const providerAnswer = (await deps.reader.readLine(`Provider [${defaultId}]: `)).trim();
  if (providerAnswer === 'q') {
    deps.renderer.write(color.dim('Cancelled.\n'));
    return 0;
  }
  const providerId = providerAnswer || defaultId;
  const provider = await deps.modelsRegistry.getProvider(providerId);
  if (!provider) {
    deps.renderer.writeError(`Provider "${providerId}" not found in models.dev catalog.`);
    return 1;
  }
  if (provider.family === 'unsupported') {
    deps.renderer.writeError(
      `Provider "${providerId}" uses ${provider.npm} which has no built-in transport. Install a plugin to enable it.`,
    );
    return 1;
  }
  const suggestedModel = (await deps.modelsRegistry.suggestModel(providerId)) ?? '';
  const modelHint = suggestedModel ? ` [${suggestedModel}]` : '';
  const modelAnswer = (await deps.reader.readLine(`Model${modelHint}: `)).trim();
  if (modelAnswer === 'q') {
    deps.renderer.write(color.dim('Cancelled.\n'));
    return 0;
  }
  const modelId = modelAnswer || suggestedModel;
  if (!modelId) {
    deps.renderer.writeError('No model selected. Aborting.');
    return 1;
  }
  const envHit = provider.envVars.map((v: string) => process.env[v]).find(Boolean);
  let apiKey = '';
  if (!envHit) {
    apiKey = (
      await deps.reader.readLine(
        `API key (stored in ${deps.paths.globalConfig}; empty = expect ${provider.envVars[0] ?? 'env var'}): `,
      )
    ).trim();
  } else {
    deps.renderer.writeInfo(`Found API key in env (${provider.envVars.join(' / ')}).`);
  }
  await fs.mkdir(deps.paths.globalRoot, { recursive: true });
  const config: Partial<Config> = { version: 1, provider: providerId, model: modelId };
  if (apiKey) config.apiKey = apiKey;
  // Encrypt secret fields before writing to disk.
  const vault = new DefaultSecretVault({ keyFile: deps.paths.secretsKey });
  const encrypted = encryptConfigSecrets(config, vault);
  // mode 0o600: the global config holds (encrypted) secrets — owner-only.
  await atomicWrite(deps.paths.globalConfig, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  await fs.mkdir(path.join(deps.projectRoot, '.wrongstack'), { recursive: true });
  const agentsFile = path.join(deps.projectRoot, '.wrongstack', 'AGENTS.md');
  const projectFacts = await detectProjectFacts(deps.projectRoot);
  await atomicWrite(agentsFile, renderAgentsTemplate(projectFacts));
  deps.renderer.writeInfo(`Wrote ${deps.paths.globalConfig}`);
  deps.renderer.writeInfo(`Project state lives in ${deps.paths.projectDir}`);
  deps.renderer.writeInfo('Try: wstack "<task>"  or  wstack');
  return 0;
};
