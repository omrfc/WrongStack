import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { GlobalMailbox } from '../coordination/global-mailbox.js';
import type { EventBus } from '../kernel/events.js';
import type { HqClientConfig } from '../types/config.js';
import { hqAuthFilePath, readHqRuntimeFileSync, resolveHqDataDir, type HqAuthFile } from './auth-store.js';
import type { HqClientIdentity, HqProjectIdentity, HqRedactionPolicy } from './protocol.js';
import { HqPublisher, type HqSocketFactory } from './publisher.js';

export interface HqPublisherEnvConfig {
  url: string;
  token?: string;
  enabled?: boolean;
  rawContent?: boolean;
  projectAlias?: string;
}

function readFirstClientTokenFromAuthFile(dataDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(hqAuthFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as HqAuthFile;
    return parsed.clientTokens?.find((t) => t.token.trim().length > 0)?.token;
  } catch {
    return undefined;
  }
}

export function resolveHqConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HqPublisherEnvConfig | undefined {
  return resolveHqConfig({ env });
}

export function resolveHqConfig(options: {
  env?: NodeJS.ProcessEnv | undefined;
  config?: HqClientConfig | undefined;
} = {}): HqPublisherEnvConfig | undefined {
  const env = options.env ?? process.env;
  const fileConfig = options.config;
  const envUrl = env['WRONGSTACK_HQ_URL']?.trim();
  const envToken = env['WRONGSTACK_HQ_TOKEN']?.trim();
  const configUrl = fileConfig?.url?.trim();
  const configToken = fileConfig?.token?.trim();
  const envEnabledRaw = env['WRONGSTACK_HQ_ENABLED']?.trim();
  const enabled = envEnabledRaw !== undefined && envEnabledRaw.length > 0
    ? envEnabledRaw !== '0'
    : fileConfig?.enabled;
  const dataDir = resolveHqDataDir(fileConfig?.dataDir, env);
  const token = envToken || configToken || readFirstClientTokenFromAuthFile(dataDir);
  const runtimeUrl = readHqRuntimeFileSync(dataDir)?.url.trim();
  const url = envUrl || configUrl;

  if (!url) {
    if (enabled === false) return undefined;
    if (enabled === true || token) {
      return {
        url: runtimeUrl || 'http://127.0.0.1:3499',
        enabled: true,
        ...(token ? { token } : {}),
      };
    }
    return undefined;
  }

  const rawContentEnv = env['WRONGSTACK_HQ_RAW_CONTENT']?.trim();
  const projectAliasEnv = env['WRONGSTACK_HQ_PROJECT_ALIAS']?.trim();
  return {
    url,
    ...(token ? { token } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(rawContentEnv ? { rawContent: rawContentEnv === '1' } : fileConfig?.rawContent !== undefined ? { rawContent: fileConfig.rawContent } : {}),
    ...(projectAliasEnv ? { projectAlias: projectAliasEnv } : fileConfig?.projectAlias ? { projectAlias: fileConfig.projectAlias } : {}),
  };
}

function stableMachineId(): string {
  return createHash('sha256').update(`${hostname()}:${process.pid}`).digest('hex').slice(0, 12);
}

function deriveProjectId(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
}

export interface CreateHqPublisherOptions {
  clientKind: HqClientIdentity['kind'];
  projectRoot: string;
  projectName?: string;
  machineId?: string;
  hostnameOverride?: string;
  socketFactory?: HqSocketFactory;
  config?: HqPublisherEnvConfig;
  appConfig?: { hq?: HqClientConfig | undefined } | undefined;
  redactionPolicy?: Partial<HqRedactionPolicy>;
}

export function createHqPublisherFromEnv(options: CreateHqPublisherOptions): HqPublisher | undefined {
  const config = options.config ?? resolveHqConfig({ config: options.appConfig?.hq });
  if (!config || config.enabled === false) return undefined;

  const machineId = options.machineId ?? stableMachineId();
  const host = options.hostnameOverride ?? hostname();
  const projectName = options.projectName ?? config.projectAlias ?? (basename(options.projectRoot) || 'unknown');

  const client: HqClientIdentity = {
    clientId: `${machineId}:${options.clientKind}:${process.pid}`,
    kind: options.clientKind,
    machineId,
    ...(host ? { hostname: host } : {}),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  const project: HqProjectIdentity = {
    projectId: deriveProjectId(options.projectRoot),
    projectRoot: options.projectRoot,
    projectName,
    machineId,
    workspaceKind: 'git',
  };

  const redactionPolicy: Partial<HqRedactionPolicy> | undefined =
    options.redactionPolicy || config.rawContent !== undefined
      ? {
          ...(config.rawContent !== undefined ? { rawContent: config.rawContent } : {}),
          ...(options.redactionPolicy ?? {}),
        }
      : undefined;

  return new HqPublisher({
    url: config.url,
    ...(config.token ? { token: config.token } : {}),
    client,
    project,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(redactionPolicy !== undefined ? { redactionPolicy } : {}),
  });
}

export interface CreateGlobalMailboxOptions {
  projectDir: string;
  events?: EventBus;
  hqPublisher?: HqPublisher;
}

export function createGlobalMailbox(options: CreateGlobalMailboxOptions): GlobalMailbox {
  return new GlobalMailbox(options.projectDir, options.events, options.hqPublisher);
}
