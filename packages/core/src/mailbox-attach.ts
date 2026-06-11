/**
 * mailbox-attach — composition glue for the agent-loop mailbox checker.
 *
 * Lives at the src root (composition layer) because it constructs the
 * concrete GlobalMailbox from coordination/ and hands the resulting
 * checker to core/ — core/ itself may only depend on the Mailbox
 * interface (architecture Rule 3, see tests/architecture/
 * package-boundaries.test.ts).
 *
 * @module mailbox-attach
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { GlobalMailbox, resolveProjectDir } from './coordination/global-mailbox.js';
import { mailboxSessionTag, resolveMailboxIdentity } from './coordination/mailbox-tool.js';
import type { Mailbox, MailboxMessage } from './coordination/mailbox-types.js';
import type { AgentInternals } from './core/agent-internals.js';
import { createMailboxChecker } from './core/mailbox-loop.js';

export function attachMailboxChecker(
  a: AgentInternals,
  source?: 'cli' | 'webui',
): () => Promise<MailboxMessage[]> {
  // Mailbox integration is best-effort — it must NEVER be the reason Agent
  // construction fails. Ephemeral/test contexts without a projectRoot get a
  // no-op checker, and any setup error degrades to the same.
  if (!a.ctx.projectRoot) {
    return async () => [];
  }
  try {
    return attachMailboxCheckerInner(a, source);
  } catch {
    return async () => [];
  }
}

function attachMailboxCheckerInner(
  a: AgentInternals,
  source?: 'cli' | 'webui',
): () => Promise<MailboxMessage[]> {
  const home = os.homedir();
  const projectDir = resolveProjectDir(a.ctx.projectRoot, path.join(home, '.wrongstack'));
  // Pass the agent's EventBus so GlobalMailbox can emit real-time events
  // (agent_registered, agent_heartbeat, etc.) for TUI/WebUI display.
  const mailbox: Mailbox = new GlobalMailbox(projectDir, a.events);
  const surface = source ?? ((a.ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli');
  if (!a.ctx.meta['source']) a.ctx.meta['source'] = surface;

  // SESSION-bound unique identity (`<base>@<sessionTag>`): every session
  // has its own id, so two leader sessions on the same project never
  // collide — and the identity is re-derived LIVE so an in-process session
  // swap (resume / session.new / project switch) moves the agent onto the
  // new session's identity automatically. ctx.meta.globalAgentId is kept
  // fresh for the tools and the /mailbox command.
  const baseIdOf = (): string => {
    const fieldId = a.ctx.agentId && a.ctx.agentId !== 'unknown' ? a.ctx.agentId : undefined;
    return (a.ctx.meta['agentId'] as string | undefined) ?? fieldId ?? 'leader';
  };
  let registeredAs = '';
  const ensureRegistered = (): string => {
    // Clear a stale explicit override from a previous session so the
    // resolver re-derives from the CURRENT session id.
    const derived = `${baseIdOf()}@${mailboxSessionTag(a.ctx.session.id)}`;
    if ((a.ctx.meta['globalAgentId'] as string | undefined) !== derived) {
      a.ctx.meta['globalAgentId'] = derived;
    }
    if (registeredAs !== derived) {
      registeredAs = derived;
      const identity = resolveMailboxIdentity(a.ctx);
      mailbox
        .registerAgent({
          agentId: derived,
          name: `${identity.name} [${surface}]`,
          sessionId: a.ctx.session.id,
          pid: process.pid,
          source: surface,
        })
        .catch((err: unknown) => {
          // Log but don't fail - registration errors shouldn't crash the agent
          console.debug(
            `[mailbox] Failed to register agent ${derived}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    return derived;
  };
  ensureRegistered();

  // Heartbeat keeps the registration alive (every 30 seconds) and follows
  // identity changes — after a session swap the new identity registers and
  // the old one simply goes stale (60s timeout).
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(() => {
    const id = ensureRegistered();
    mailbox.heartbeat({ agentId: id }).catch(() => {
      // Silently ignore - heartbeat failures are expected during shutdown
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Register cleanup to stop heartbeat on abort. Note: there's no unregisterAgent
  // method - agents are considered offline after their heartbeat expires (60s timeout).
  a.ctx.registerAbortHook(() => {
    clearInterval(heartbeatTimer);
  });

  // Receive on the unique id AND the bare base id (plus '*' broadcasts) —
  // "send to leader" reaches every live leader session on the project.
  // Getter form: each check re-derives identity from the CURRENT session.
  return createMailboxChecker({
    mailbox,
    agentId: () => ensureRegistered(),
    aliases: [baseIdOf()],
  });
}
