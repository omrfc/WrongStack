/**
 * WebUI client registration — presence + HQ telemetry for the CLI bridge.
 *
 * Registers the WebUI instance as a client in the project's global mailbox so
 * other TUIs, WebUIs, and REPLs on the same project can see it as "online",
 * starts the HQ connection (with the session-telemetry bridge attached on
 * connect), and heartbeats more frequently than agents do (15s vs 30s).
 *
 * PR 10 of Issue #30: extracted from `webui-server.ts`.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Config, EventBus } from '@wrongstack/core';
import { GlobalMailbox, resolveProjectDir, wstackGlobalRoot } from '@wrongstack/core';
import { startCliHqConnection, type CliHqConnection } from '../hq-publisher.js';

const CLIENT_HEARTBEAT_MS = 15_000;

export interface WebuiClientRegistrationDeps {
  projectRoot: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig: Config | undefined;
  events: EventBus;
  /** Stable session id recorded in HQ telemetry (the writer at startup). */
  hqSessionId: string;
  /** Live session id — session.resume swaps it, so it is read per heartbeat. */
  getSessionId: () => string;
}

export interface WebuiClientRegistration {
  /** Fire-and-forget registration; resolves to the client id (or null). */
  register(): Promise<string | null>;
  /** Stop heartbeats and tear down the HQ connection/telemetry bridge. */
  unregister(): void;
}

export function createWebuiClientRegistration(
  deps: WebuiClientRegistrationDeps,
): WebuiClientRegistration {
  let webuiClientId: string | null = null;
  let webuiHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopWebuiHqBridge: (() => void) | undefined;
  let webuiHqConnection: CliHqConnection | undefined;

  const register = async (): Promise<string | null> => {
    if (!deps.projectRoot) return null;
    try {
      const projectRoot = deps.projectRoot;
      const projectDir = resolveProjectDir(projectRoot, wstackGlobalRoot());
      webuiHqConnection = startCliHqConnection({
        clientKind: 'webui',
        projectRoot,
        projectName: path.basename(projectRoot),
        appConfig: deps.appConfig,
        onConnect: (publisher) => {
          stopWebuiHqBridge?.();
          stopWebuiHqBridge = undefined;
          void import('@wrongstack/core')
            .then(({ startSessionTelemetryBridge }) => {
              stopWebuiHqBridge = startSessionTelemetryBridge({
                publisher,
                events: deps.events,
                sessionId: deps.hqSessionId,
                projectRoot,
                projectName: path.basename(projectRoot),
                startedAt: new Date().toISOString(),
              });
            })
            .catch(() => {
              // telemetry optional
            });
        },
      });
      const mailbox = new GlobalMailbox(projectDir, deps.events, () =>
        webuiHqConnection?.getPublisher(),
      );
      webuiClientId = `webui@${crypto.randomUUID().slice(0, 8)}`;
      const projectName = path.basename(projectRoot);
      await mailbox.registerClient({
        clientId: webuiClientId,
        sessionId: deps.getSessionId(),
        name: `WebUI [${projectName}]`,
        source: 'webui',
        pid: process.pid,
      });

      webuiHeartbeatTimer = setInterval(() => {
        mailbox
          .clientHeartbeat({
            clientId: webuiClientId!,
            sessionId: deps.getSessionId(),
          })
          .catch(() => {
            // best-effort — ignore heartbeat failures during shutdown
          });
      }, CLIENT_HEARTBEAT_MS);
      webuiHeartbeatTimer.unref();

      return webuiClientId;
    } catch {
      // best-effort — client registration errors should not block WebUI startup
      return null;
    }
  };

  const unregister = (): void => {
    if (webuiHeartbeatTimer) {
      clearInterval(webuiHeartbeatTimer);
      webuiHeartbeatTimer = null;
    }
    if (stopWebuiHqBridge) {
      stopWebuiHqBridge();
      stopWebuiHqBridge = undefined;
    }
    webuiHqConnection?.stop();
    webuiHqConnection = undefined;
  };

  return { register, unregister };
}
