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
import type { Mailbox, MailboxMessage } from './coordination/mailbox-types.js';
import type { AgentInternals } from './core/agent-internals.js';
import { createMailboxChecker } from './core/mailbox-loop.js';

export function attachMailboxChecker(
  a: AgentInternals,
  source?: 'cli' | 'webui',
): () => Promise<MailboxMessage[]> {
  const home = os.homedir();
  const projectDir = resolveProjectDir(a.ctx.projectRoot, path.join(home, '.wrongstack'));
  // Pass the agent's EventBus so GlobalMailbox can emit real-time events
  // (agent_registered, agent_heartbeat, etc.) for TUI/WebUI display.
  const mailbox: Mailbox = new GlobalMailbox(projectDir, a.events);
  const agentId = (a.ctx.meta['agentId'] as string) ?? 'leader';
  const agentName = (a.ctx.meta['agentName'] as string) ?? 'Agent';
  const sessionId = a.ctx.session.id;

  // Auto-register this agent to the shared mailbox system
  mailbox.registerAgent({
    agentId,
    name: agentName,
    sessionId,
    pid: process.pid,
    source,
  }).catch((err: unknown) => {
    // Log but don't fail - registration errors shouldn't crash the agent
    console.debug(`[mailbox] Failed to register agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Start heartbeat timer to keep registration alive (every 30 seconds)
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(() => {
    mailbox.heartbeat({ agentId }).catch(() => {
      // Silently ignore - heartbeat failures are expected during shutdown
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Register cleanup to stop heartbeat on abort. Note: there's no unregisterAgent
  // method - agents are considered offline after their heartbeat expires (60s timeout).
  a.ctx.registerAbortHook(() => {
    clearInterval(heartbeatTimer);
  });

  return createMailboxChecker({ mailbox, agentId });
}
