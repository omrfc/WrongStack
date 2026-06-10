/**
 * techstack-mailbox-consumer — Auto-spawns the tech-stack agent when
 * dep-watcher messages land in the mailbox.
 *
 * This module runs a lightweight polling loop that checks the mailbox
 * for unread `assign` messages directed at the `tech-stack` agent.
 * When found, it invokes the provided `onSpawn` callback to spawn a
 * tech-stack subagent, passing the manifest path as the task.
 *
 * The consumer also records file-author entries when it detects that
 * a manifest was edited, so the tech-stack agent knows who to warn.
 *
 * @module techstack-mailbox-consumer
 */

import type { Mailbox, MailboxMessage } from './mailbox-types.js';
import {
  recordFileAction,
  type FileAuthorTrackerOptions,
} from './file-author-tracker.js';

export interface TechStackConsumerOptions {
  /** The mailbox to poll. */
  mailbox: Mailbox;
  /** Called when a tech-stack agent should be spawned. Receives the task description. */
  onSpawn: (task: string, name: string) => Promise<{ subagentId: string; taskId: string }>;
  /** Agent id that the consumer watches for. Default: 'tech-stack'. */
  targetAgent?: string | undefined;
  /** Agent id that sends the completion ack. Default: 'tech-stack-consumer'. */
  consumerAgentId?: string | undefined;
  /** Polling interval in ms. Default: 5000. */
  pollIntervalMs?: number | undefined;
  /** File-author tracker config (for recording manifest edits). */
  fileAuthorOpts?: FileAuthorTrackerOptions | undefined;
  /** Current session id (for file-author entries). */
  sessionId?: string | undefined;
  /** Current agent id (for file-author entries). */
  currentAgentId?: string | undefined;
  /** Current agent name (for file-author entries). */
  currentAgentName?: string | undefined;
  /** Called on each poll cycle for logging. */
  onLog?: ((msg: string) => void) | undefined;
  /** Called when an error occurs. */
  onError?: ((err: unknown) => void) | undefined;
}

interface ConsumerState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  processedIds: Set<string>;
}

/**
 * Start the mailbox consumer loop.
 *
 * Returns a dispose function that stops polling and cleans up.
 */
export function startTechStackConsumer(opts: TechStackConsumerOptions): () => void {
  const {
    mailbox,
    onSpawn,
    targetAgent = 'tech-stack',
    consumerAgentId = 'tech-stack-consumer',
    pollIntervalMs = 5000,
    fileAuthorOpts,
    sessionId,
    currentAgentId,
    currentAgentName,
    onLog,
    onError,
  } = opts;

  const state: ConsumerState = {
    running: true,
    timer: null,
    processedIds: new Set<string>(),
  };

  const log = (msg: string) => {
    onLog?.(msg);
  };

  const handleError = (err: unknown) => {
    onError?.(err);
  };

  async function pollOnce(): Promise<void> {
    if (!state.running) return;

    try {
      // Query for unread assign messages to the tech-stack agent
      const messages = await mailbox.query({
        to: targetAgent,
        type: 'assign',
        unreadBy: consumerAgentId,
        limit: 10,
      });

      for (const msg of messages) {
        // Skip already processed
        if (state.processedIds.has(msg.id)) continue;
        state.processedIds.add(msg.id);

        // Mark as read by consumer
        await mailbox.ack({
          messageId: msg.id,
          readerId: consumerAgentId,
          read: true,
        });

        // Extract manifest path from message body
        const manifestPath = extractManifestPath(msg);
        if (!manifestPath) {
          log(`[techstack-consumer] No manifest path in message ${msg.id}`);
          continue;
        }

        // Record file author if we have tracker config
        if (fileAuthorOpts && currentAgentId) {
          try {
            await recordFileAction(fileAuthorOpts, {
              filePath: manifestPath,
              action: 'edit',
              agentId: currentAgentId,
              agentName: currentAgentName,
              sessionId,
            });
          } catch (err) {
            handleError(err);
          }
        }

        log(`[techstack-consumer] Spawning tech-stack agent for ${manifestPath}`);

        // Spawn the tech-stack agent via callback
        try {
          const task = buildTechStackTask(msg, manifestPath);
          const name = `tech-stack-${pathBasename(manifestPath)}`;
          await onSpawn(task, name);
          log(`[techstack-consumer] Spawned tech-stack agent for ${manifestPath}`);
        } catch (err) {
          handleError(err);
          log(`[techstack-consumer] Failed to spawn tech-stack agent: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      handleError(err);
    }
  }

  // Start polling
  state.timer = setInterval(() => {
    void pollOnce();
  }, pollIntervalMs);

  // Run an immediate first poll
  void pollOnce();

  // Return dispose function
  return () => {
    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractManifestPath(msg: MailboxMessage): string | undefined {
  // Try to extract from the message body — the dep-watcher posts
  // markdown tables with a "Manifest" column.
  const body = msg.body ?? '';

  // Look for "Manifest: <path>" pattern
  const manifestMatch = body.match(/Manifest:\s*(.+)/i);
  if (manifestMatch?.[1]) {
    return manifestMatch[1].trim();
  }

  // Look for markdown table row with the manifest path
  const tableMatch = body.match(/\|\s*[^|]+\|\s*([^|]+)\|/);
  if (tableMatch?.[1]) {
    const candidate = tableMatch[1].trim();
    if (isManifestFile(candidate)) {
      return candidate;
    }
  }

  // Fallback: if the subject contains a path-like string
  const subjectPath = msg.subject?.match(/([\w/.-]+\.(json|mod|toml|lock|gradle|gemspec|csproj|fsproj))/i);
  if (subjectPath) {
    return subjectPath[1];
  }

  return undefined;
}

function isManifestFile(path: string): boolean {
  const name = pathBasename(path).toLowerCase();
  const manifests = [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'go.mod',
    'go.sum',
    'cargo.toml',
    'cargo.lock',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'poetry.lock',
    'pipfile',
    'pipfile.lock',
    'composer.json',
    'composer.lock',
    'gemfile',
    'gemfile.lock',
    '*.csproj',
    '*.fsproj',
    'packages.config',
    'mix.exs',
    'mix.lock',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'gradle.properties',
  ];
  return manifests.some((m) => {
    if (m.startsWith('*.')) {
      return name.endsWith(m.slice(1));
    }
    return name === m;
  });
}

function pathBasename(p: string): string {
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return lastSep >= 0 ? p.slice(lastSep + 1) : p;
}

function buildTechStackTask(msg: MailboxMessage, manifestPath: string): string {
  return [
    `Dependency manifest changed: ${manifestPath}`,
    '',
    `Original message from ${msg.from}:`,
    `Subject: ${msg.subject}`,
    '',
    msg.body,
    '',
    'Your task:',
    '1. Read the manifest file.',
    '2. Detect the ecosystem and extract dependency names/versions.',
    '3. For each dependency, fetch the latest stable version from the registry.',
    '4. Compare installed vs latest. Flag outdated packages.',
    '5. Send warning messages via mailbox to the agent that last edited this file.',
    '6. If the file author is unknown, broadcast to "*".',
  ].join('\n');
}
