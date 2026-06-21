import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { GlobalMailbox } from '../coordination/global-mailbox.js';
import type { EventBus } from '../kernel/events.js';
import type { HqClientIdentity, HqProjectIdentity, HqRedactionPolicy } from './protocol.js';
import { HqPublisher, type HqSocketFactory } from './publisher.js';

export interface HqPublisherEnvConfig {
  url: string;
  token?: string;
  enabled?: boolean;
  rawContent?: boolean;
  projectAlias?: string;
}

export function resolveHqConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HqPublisherEnvConfig | undefined {
  const url = env['WRONGSTACK_HQ_URL']?.trim();
  if (!url) {
    if (env['WRONGSTACK_HQ_ENABLED']?.trim() === '1') {
      return { url: 'http://localhost:3499', enabled: true };
    }
    return undefined;
  }
  return {
    url,
    ...(env['WRONGSTACK_HQ_TOKEN']?.trim() ? { token: env['WRONGSTACK_HQ_TOKEN']!.trim() } : {}),
    ...(env['WRONGSTACK_HQ_ENABLED']?.trim() ? { enabled: env['WRONGSTACK_HQ_ENABLED']!.trim() !== '0' } : {}),
    ...(env['WRONGSTACK_HQ_RAW_CONTENT']?.trim() ? { rawContent: env['WRONGSTACK_HQ_RAW_CONTENT']!.trim() === '1' } : {}),
    ...(env['WRONGSTACK_HQ_PROJECT_ALIAS']?.trim() ? { projectAlias: env['WRONGSTACK_HQ_PROJECT_ALIAS']!.trim() } : {}),
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
  redactionPolicy?: Partial<HqRedactionPolicy>;
}

export function createHqPublisherFromEnv(options: CreateHqPublisherOptions): HqPublisher | undefined {
  const config = options.config ?? resolveHqConfigFromEnv();
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
