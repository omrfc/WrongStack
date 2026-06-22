import {
  GlobalMailbox,
  HQ_AUTH_FILE_VERSION,
  HQ_PROTOCOL_VERSION,
  createHqPublisherFromEnv,
  type HqSocketLike,
  writeHqAuthFile,
} from '@wrongstack/core';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-server-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function startOpenHqServer(options: Omit<Parameters<typeof startHqServer>[0], 'dataDir'> = {}): Promise<HqServerHandle> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  return startHqServer({ ...options, dataDir });
}

function getPort(): number {
  // Use a random high port to avoid conflicts with running services.
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function occupyPort(port: number): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function waitForOpen(ws: WebSocket, timeout = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface HqSnapshotMessage {
  type: 'hq.snapshot';
  snapshot: {
    totals: {
      activeClients: number;
      unreadMailboxMessages: number;
      incompleteMailboxMessages: number;
    };
    mailboxes: { mailboxId: string; unreadCount: number }[];
  };
}

type BrowserMessage =
  | HqSnapshotMessage
  | { type: 'hq.event'; event: unknown }
  | { type: 'hq.alert' };

/**
 * Create a queue-based browser message collector. Resolves the next message
 * matching `predicate` (or re-queues messages that don't match).
 */
function makeBrowserCollector(ws: WebSocket) {
  const queue: BrowserMessage[] = [];
  let resolver: ((msg: BrowserMessage) => void) | null = null;

  const collector = (raw: unknown) => {
    let parsed: BrowserMessage | null = null;
    try {
      parsed = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Buffer),
      ) as BrowserMessage;
    } catch {
      return;
    }
    if (resolver) {
      // Resolver (armResolver) decides whether to clear itself based on
      // whether the predicate matched. We don't clear here.
      resolver(parsed);
      return;
    }
    queue.push(parsed);
  };
  ws.on('message', collector);

  const nextMessage = (
    predicate: (m: BrowserMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<BrowserMessage> =>
    new Promise((resolve, reject) => {
      const existing = queue.findIndex(predicate);
      if (existing >= 0) {
        const [msg] = queue.splice(existing, 1);
        resolve(msg);
        return;
      }
      const timer = setTimeout(() => {
        if (resolver === armResolver) resolver = null;
        reject(new Error('WS message timeout'));
      }, timeoutMs);
      const armResolver = (msg: BrowserMessage) => {
        if (!predicate(msg)) {
          queue.push(msg);
          return;
        }
        clearTimeout(timer);
        resolver = null;
        resolve(msg);
      };
      resolver = armResolver;
    });

  return {
    nextMessage,
    queueSnapshot: () => queue.slice(),
    dispose: () => ws.off('message', collector),
  };
}

describe('HQ server', () => {
  it('writes and clears the runtime endpoint marker for same-machine discovery', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const runtimePath = path.join(dataDir, 'runtime.json');

    const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8')) as { url: string; pid: number };
    expect(runtime).toMatchObject({ url: `http://127.0.0.1:${handle.port}`, pid: process.pid });

    await handle.close();
    await handle.close();
    handle = null;
    await expect(fs.access(runtimePath)).rejects.toThrow();
  });

  it('prints tokenized browser and client links on every token-mode startup', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [{ id: 'bt-existing', token: 'existing-browser-token', createdAt: new Date().toISOString() }],
      clientTokens: [{ id: 'ct-existing', token: 'existing-client-token', createdAt: new Date().toISOString() }],
    });
    const port = getPort();

    handle = await startHqServer({ port, dataDir });

    expect(handle.firstRunSetup).toMatchObject({
      dataDir,
      browserUrl: `http://127.0.0.1:${handle.port}/?token=existing-browser-token`,
      clientUrl: `ws://127.0.0.1:${handle.port}/ws/client?token=existing-client-token`,
      clientEnv: {
        WRONGSTACK_HQ_URL: `http://127.0.0.1:${handle.port}`,
        WRONGSTACK_HQ_TOKEN: 'existing-client-token',
      },
      createdAuth: false,
    });
  });

  it('rejects with EADDRINUSE when strictPort is true and the port is busy', async () => {
    const port = getPort();
    const blocker = await occupyPort(port);
    try {
      await expect(startOpenHqServer({ port, strictPort: true })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await closeHttpServer(blocker);
    }
  });

  it('auto-advances past multiple busy ports when strictPort is false', async () => {
    const port = getPort();
    const blockers = [await occupyPort(port), await occupyPort(port + 1)];
    try {
      handle = await startOpenHqServer({ port, strictPort: false });
      expect(handle.port).toBe(port + 2);
    } finally {
      await Promise.all(blockers.map((server) => closeHttpServer(server)));
    }
  });

  it('starts on a single port, serves HTML and /api/snapshot', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('WrongStack HQ');
    // Dashboard must expose the new mailbox table and clients table sections.
    expect(html).toContain('id="tbody-mailboxes"');
    expect(html).toContain('id="tbody-clients"');
    // Stat cards for mailbox rollups.
    expect(html).toContain('id="stat-mailboxes"');
    expect(html).toContain('id="stat-high"');
    expect(html).toContain('id="stat-agents"');
    // Mailbox table headers.
    expect(html).toContain('Mailboxes');
    expect(html).toContain('High priority');
    // JS-side applySnapshot reads snapshot.mailboxes + snapshot.clients.
    expect(html).toContain('renderMailboxes');
    expect(html).toContain('renderClients');

    const snapRes = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`);
    expect(snapRes.status).toBe(200);
    const snapshot = (await snapRes.json()) as {
      totals: {
        activeClients: number;
        unreadMailboxMessages: number;
        incompleteMailboxMessages: number;
      };
      mailboxes: unknown[];
      clients: unknown[];
    };
    expect(snapshot.totals.activeClients).toBe(0);
    expect(snapshot.mailboxes).toEqual([]);
    expect(snapshot.clients).toEqual([]);
  });

  it('accepts client connections on /ws/client and pushes snapshots to /ws/browser', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const browserCol = makeBrowserCollector(browser);

    const snapshotPromise = browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' && (m as HqSnapshotMessage).snapshot.totals.activeClients === 1,
    );

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'test-client-1',
            kind: 'tui',
            machineId: 'test-machine',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'test-project',
            projectRoot: '/test',
            projectName: 'Test Project',
            machineId: 'test-machine',
            gitBranch: 'main',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );

    const snapshot = (await snapshotPromise) as HqSnapshotMessage;
    expect(snapshot.snapshot.totals.activeClients).toBe(1);
    // The HqProjectRecord rollup is also produced by buildSnapshot — confirm
    // it surfaces the project count too.
    const snapshotBody = snapshot.snapshot as {
      totals: { activeProjects: number };
      projects: Array<{ projectName: string; projectRootDisplay: string; machineIds: string[]; gitBranch?: string }>;
    };
    expect(snapshotBody.totals.activeProjects).toBe(1);
    expect(snapshotBody.projects[0]).toMatchObject({
      projectName: 'Test Project',
      projectRootDisplay: '/test',
      machineIds: ['test-machine'],
      gitBranch: 'main',
    });

    browserCol.dispose();
    browser.close();
    client.close();
  });

  it('shows a same-process publisher registered through GlobalMailbox as an HQ project', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const browserCol = makeBrowserCollector(browser);

    const publisher = createHqPublisherFromEnv({
      clientKind: 'tui',
      projectRoot: path.join(dataDir, 'project-root'),
      projectName: 'HQ Integration Project',
      config: { url: `http://127.0.0.1:${handle.port}`, enabled: true },
      socketFactory: (url) => new WebSocket(url) as HqSocketLike,
    });
    expect(publisher).toBeDefined();
    publisher!.connect();

    const mailbox = new GlobalMailbox(dataDir, undefined, publisher);
    await mailbox.registerClient({
      clientId: 'tui@integration',
      sessionId: 'session-integration',
      name: 'TUI Integration',
      source: 'tui',
      pid: process.pid,
    });

    const snapshot = (await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' &&
        (m as HqSnapshotMessage).snapshot.totals.activeClients === 1,
    )) as HqSnapshotMessage;
    const body = snapshot.snapshot as {
      projects: Array<{ projectName: string; activeClients: number }>;
      clients: Array<{ kind: string }>;
      mailboxes: Array<{ mailboxId: string }>;
    };

    expect(body.projects[0]).toMatchObject({ projectName: 'HQ Integration Project', activeClients: 1 });
    expect(body.clients[0]).toMatchObject({ kind: 'tui' });
    expect(body.mailboxes.length).toBeGreaterThanOrEqual(1);

    publisher!.close();
    browserCol.dispose();
    browser.close();
  });

  it('rejects wrong protocol version on /ws/client', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    const closePromise = new Promise<number>((resolve) => {
      client.on('close', (code) => resolve(code));
    });

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: 999,
          client: {
            clientId: 'bad',
            kind: 'cli',
            machineId: 'm',
            startedAt: '2026-01-01T00:00:00Z',
          },
          project: {
            projectId: 'p',
            projectRoot: '/',
            projectName: 'p',
            machineId: 'm',
            workspaceKind: 'git',
          },
          capabilities: [],
        },
      }),
    );

    const code = await closePromise;
    expect(code).toBe(1008);
  });

  it('aggregates mailbox.snapshot envelopes into global totals for browsers', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);

    // Drain the initial snapshot.
    await browserCol.nextMessage((m) => m.type === 'hq.snapshot');

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'telemetry-client-1',
            kind: 'cli',
            machineId: 'machine-1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-1',
            projectRoot: '/tmp/proj-1',
            projectName: 'proj-1',
            machineId: 'machine-1',
            workspaceKind: 'directory',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );

    // Wait for the post-hello snapshot (activeClients === 1). A short delay
    // ensures the server has registered before the client sends the next
    // event, mirroring how the publisher batches snapshots in practice.
    await new Promise((r) => setTimeout(r, 20));
    await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' && (m as HqSnapshotMessage).snapshot.totals.activeClients === 1,
    );

    // Publish a mailbox.snapshot event so the HQ aggregates it.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-1',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'telemetry-client-1',
          projectId: 'proj-1',
          seq: 1,
          payload: {
            mailboxId: 'proj-1:mailbox',
            scope: 'project',
            messages: [],
            agents: [],
            totals: { messages: 5, unread: 3, incomplete: 2, highPriority: 1, onlineAgents: 1 },
          },
        },
      }),
    );

    // Now wait for the snapshot triggered by the mailbox.snapshot event.
    const aggregated = (await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' &&
        (m as HqSnapshotMessage).snapshot.totals.unreadMailboxMessages === 3,
    )) as HqSnapshotMessage;

    expect(aggregated.snapshot.totals.unreadMailboxMessages).toBe(3);
    expect(aggregated.snapshot.totals.incompleteMailboxMessages).toBe(2);
    expect(aggregated.snapshot.mailboxes[0]?.mailboxId).toBe('proj-1:mailbox');
    expect(aggregated.snapshot.mailboxes[0]?.unreadCount).toBe(3);

    browserCol.dispose();
    browser.close();
    client.close();
  });

  it('serves /api/projects/:id with project, clients, and mailbox snapshots', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    // Connect a client and publish a mailbox.snapshot envelope so the
    // server has actual mailbox payloads to surface in the drilldown.
    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'drill-client',
            kind: 'cli',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-drill',
            projectRoot: '/r',
            projectName: 'proj-drill',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );

    // Wait briefly so the server processes the hello before we send the
    // mailbox snapshot (handleClient rejects events until registered=true).
    await new Promise((r) => setTimeout(r, 20));

    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-1',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'drill-client',
          projectId: 'proj-drill',
          seq: 1,
          payload: {
            mailboxId: 'proj-drill:mailbox',
            scope: 'project',
            messages: [
              {
                mailId: 'm-1',
                messageId: 'm-1',
                from: 'agent-a',
                to: 'agent-b',
                type: 'ask',
                subject: 'Need review',
                priority: 'high',
                timestamp: new Date().toISOString(),
                completed: false,
                hasBody: false,
              },
            ],
            agents: [
              {
                agentId: 'agent-a',
                name: 'A',
                sessionId: 's-1',
                status: 'idle',
                iterations: 0,
                toolCalls: 0,
                lastActivityAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                online: true,
              },
            ],
            totals: { messages: 1, unread: 1, incomplete: 1, highPriority: 1, onlineAgents: 1 },
          },
        },
      }),
    );

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/projects/proj-drill`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      project: { projectId: string; activeClients: number };
      clients: { clientId: string; kind: string }[];
      mailboxes: {
        mailboxId: string;
        messages: { messageId: string }[];
        agents: { agentId: string }[];
      }[];
    };
    expect(detail.project.projectId).toBe('proj-drill');
    expect(detail.project.activeClients).toBe(1);
    expect(detail.clients).toHaveLength(1);
    expect(detail.clients[0]?.clientId).toBe('drill-client');
    expect(detail.clients[0]?.kind).toBe('cli');
    expect(detail.mailboxes).toHaveLength(1);
    expect(detail.mailboxes[0]?.mailboxId).toBe('proj-drill:mailbox');
    expect(detail.mailboxes[0]?.messages[0]?.messageId).toBe('m-1');
    expect(detail.mailboxes[0]?.agents[0]?.agentId).toBe('agent-a');

    client.close();
  });

  it('returns 404 for unknown projects on /api/projects/:id', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/projects/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('renders drawer markup and project-link wiring in the dashboard HTML', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    const html = await res.text();
    expect(html).toContain('id="drawer"');
    expect(html).toContain('id="drawer-mailboxes"');
    expect(html).toContain('id="drawer-messages"');
    expect(html).toContain('id="drawer-event-feed"');
    expect(html).toContain('id="drawer-clients"');
    expect(html).toContain('id="project-picker"');
    expect(html).toContain('id="feed-status"');
    expect(html).toContain('openProject');
    expect(html).toContain('renderProjectDetail');
    expect(html).toContain('renderProjectPicker');
    expect(html).toContain('wireProjectLinks');
    expect(html).toContain('fetchProjectDetail');
    expect(html).toContain('scheduleAutoRefresh');
    expect(html).toContain('renderEventFeed');
    expect(html).toContain('handleHqEvent');
    expect(html).toContain('/api/projects/');
    expect(html).toContain('class="project-link"');
    // URL deep-link must support both ?project= and #projectId forms.
    expect(html).toContain("searchParams.get('project')");
    expect(html).toContain('popstate');
  });

  it('surfaces fresh mailbox.snapshot data through /api/projects/:id (powers drawer auto-refresh)', async () => {
    // The dashboard's auto-refresh is implemented in the browser JS:
    //   applySnapshot() → scheduleAutoRefresh() → fetchProjectDetail() → fetch(/api/projects/:id)
    // We can't drive a real browser from a unit test, so this test exercises
    // the server-side contract that auto-refresh depends on: each new
    // mailbox.snapshot envelope must show up in the next /api/projects/:id
    // response.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'auto-client',
            kind: 'tui',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-auto',
            projectRoot: '/r',
            projectName: 'proj-auto',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // First snapshot: 1 unread.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-init',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'auto-client',
          projectId: 'proj-auto',
          seq: 1,
          payload: {
            mailboxId: 'proj-auto:mailbox',
            scope: 'project',
            messages: [],
            agents: [],
            totals: { messages: 1, unread: 1, incomplete: 1, highPriority: 0, onlineAgents: 0 },
          },
        },
      }),
    );

    const first = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/projects/proj-auto`)
    ).json()) as {
      mailboxes: { totals: { unread: number; messages: number } }[];
    };
    expect(first.mailboxes).toHaveLength(1);
    expect(first.mailboxes[0]?.totals.unread).toBe(1);
    expect(first.mailboxes[0]?.totals.messages).toBe(1);

    // Second snapshot: 5 unread, 5 messages. The dashboard's auto-refresh
    // would re-call this endpoint on the next applySnapshot tick and the
    // browser should see the new numbers without any server restart.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-2',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'auto-client',
          projectId: 'proj-auto',
          seq: 2,
          payload: {
            mailboxId: 'proj-auto:mailbox',
            scope: 'project',
            messages: [],
            agents: [],
            totals: { messages: 5, unread: 5, incomplete: 5, highPriority: 0, onlineAgents: 0 },
          },
        },
      }),
    );

    const second = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/projects/proj-auto`)
    ).json()) as {
      mailboxes: { totals: { unread: number; messages: number } }[];
    };
    expect(second.mailboxes[0]?.totals.unread).toBe(5);
    expect(second.mailboxes[0]?.totals.messages).toBe(5);

    client.close();
  });

  it('forwards mailbox.event envelopes to browsers as hq.event messages (powers live drawer feed)', async () => {
    // The dashboard's "Live mailbox events" feed is fed by the browser's
    // WS handler: on every hq.event whose event.type === 'mailbox.event'
    // and projectId === currentDetailProjectId, a row is prepended. This
    // test verifies the server-side contract: client-side mailbox.event
    // envelopes must be broadcast to /ws/browser sockets as hq.event.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);

    // Drain the initial post-hello snapshot that the browser receives
    // once the client connects below. We pre-wire the event listener.
    const eventPromise = browserCol.nextMessage(
      (m) =>
        m.type === 'hq.event' && (m as { event: { type: string } }).event.type === 'mailbox.event',
      5_000,
    );

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'feed-client',
            kind: 'webui',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-feed',
            projectRoot: '/r',
            projectName: 'proj-feed',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-feed-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'feed-client',
          projectId: 'proj-feed',
          seq: 1,
          payload: {
            mailboxId: 'proj-feed:mailbox',
            action: 'message.sent',
            summary: 'New ask from agent-a to agent-b: Need review',
          },
        },
      }),
    );

    const evt = (await eventPromise) as {
      type: 'hq.event';
      event: { type: string; projectId: string; payload: { action: string; summary?: string } };
    };
    expect(evt.event.type).toBe('mailbox.event');
    expect(evt.event.projectId).toBe('proj-feed');
    expect(evt.event.payload.action).toBe('message.sent');
    expect(evt.event.payload.summary).toContain('Need review');

    browserCol.dispose();
    browser.close();
    client.close();
  });
});

describe('HQ server frame validation', () => {
  /**
   * Open a client socket, send `payload`, then resolve with the WS close
   * code the server returns. Resolves to `null` if the socket closes without
   * a numeric code (e.g. connection reset).
   */
  function sendAndAwaitClose(
    port: number,
    path: string,
    payload: string,
    timeoutMs = 2_000,
  ): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS close timeout'));
      }, timeoutMs);
      ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('open', () => {
        ws.send(payload);
      });
    });
  }

  it('closes the client socket with 1003 (invalid-json) on non-JSON payloads', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const code = await sendAndAwaitClose(port, '/ws/client', '{not json');
    expect(code).toBe(1003);
  });

  it('closes the client socket with 1008 (policy violation) on unknown frame types', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const code = await sendAndAwaitClose(
      port,
      '/ws/client',
      JSON.stringify({ type: 'hq.snapshot', snapshot: {} }),
    );
    expect(code).toBe(1008);
  });

  it('closes the client socket with 1008 (policy violation) on a malformed client.hello', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    // payload.client is missing the required `kind`, `machineId`, `startedAt`
    // fields, so parseHqFrame rejects it as `malformed`.
    const code = await sendAndAwaitClose(
      port,
      '/ws/client',
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: { clientId: 'cli_1' },
          project: {
            projectId: 'p_1',
            projectRoot: '/tmp/p',
            projectName: 'p',
            machineId: 'm',
            workspaceKind: 'directory',
          },
          capabilities: [],
        },
      }),
    );
    expect(code).toBe(1008);
  });

  it('rejects pre-hello frames (drops them without closing the connection)', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/client`);
    await waitForOpen(client);

    // Send a valid-looking client.event before sending client.hello. The
    // server must drop it (no broadcast, no error) because the client is
    // not registered yet.
    const beforeSnapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((r) =>
      r.json(),
    );
    expect(beforeSnapshot.totals.activeClients).toBe(0);

    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-pre',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'cli_1',
          projectId: 'p_1',
          seq: 1,
          payload: { mailboxId: 'p_1:mailbox', messages: [], agents: [], totals: {} },
        },
      }),
    );
    // Give the server a tick to process the dropped frame.
    await new Promise((r) => setTimeout(r, 30));

    const afterPre = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((r) => r.json());
    expect(afterPre.totals.activeClients).toBe(0);
    expect(afterPre.totals.unreadMailboxMessages).toBe(0);

    // Now send a valid client.hello and confirm the client is accepted.
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'cli_1',
            kind: 'cli',
            machineId: 'm_1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'p_1',
            projectRoot: '/tmp/p',
            projectName: 'p',
            machineId: 'm_1',
            workspaceKind: 'directory',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const afterHello = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((r) => r.json());
    expect(afterHello.totals.activeClients).toBe(1);

    client.close();
  });

  it('drops malformed mailbox.event envelopes (does not broadcast them to browsers)', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);
    // Drain the initial browser snapshot so we are guaranteed to be
    // observing only post-connect traffic.
    await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' &&
        (m as { snapshot: { totals: { activeClients: number } } }).snapshot.totals.activeClients ===
          0,
      5_000,
    );

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'malformed-feed-client',
            kind: 'cli',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-malformed',
            projectRoot: '/r',
            projectName: 'proj-malformed',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Publish a malformed mailbox.event (unknown action). Server must drop it
    // silently — the browser must NOT see an hq.event for it. The connection
    // itself stays open so legitimate future events still flow.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-malformed-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'malformed-feed-client',
          projectId: 'proj-malformed',
          seq: 1,
          payload: {
            mailboxId: 'proj-malformed:mailbox',
            action: 'not.a.real.action',
          },
        },
      }),
    );

    // Browser should not receive any mailbox.event. Wait a beat and assert.
    let receivedMalformed = false;
    const checker = setTimeout(() => {}, 150);
    await new Promise((r) => setTimeout(r, 150));
    void checker;
    // Use the queue — anything that arrived in the meantime would be there.
    const queued = browserCol.queueSnapshot();
    receivedMalformed = queued.some(
      (m) =>
        m.type === 'hq.event' && (m as { event: { id: string } }).event.id === 'evt-malformed-1',
    );
    expect(receivedMalformed).toBe(false);

    // The connection is still open: a follow-up well-formed event must broadcast.
    const followupPromise = browserCol.nextMessage(
      (m) =>
        m.type === 'hq.event' &&
        (m as { event: { type: string } }).event.type === 'mailbox.event' &&
        (m as { event: { id: string } }).event.id === 'evt-ok-1',
      5_000,
    );
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-ok-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'malformed-feed-client',
          projectId: 'proj-malformed',
          seq: 2,
          payload: {
            mailboxId: 'proj-malformed:mailbox',
            action: 'message.sent',
            summary: 'a well-formed follow-up',
          },
        },
      }),
    );
    const followup = await followupPromise;
    expect(followup).toBeDefined();

    client.close();
  });

  it('scrubs and truncates long or secret-laden mailbox.event summaries before broadcasting', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);
    await browserCol.nextMessage((m) => m.type === 'hq.snapshot', 5_000);

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'scrub-client',
            kind: 'cli',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-scrub',
            projectRoot: '/r',
            projectName: 'proj-scrub',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const longSecret = `[REDACTED:long_github_pat]`;
    const filler = 'x'.repeat(400);
    const summaryText = `attached ${longSecret} ${filler}`;
    const evtPromise = browserCol.nextMessage(
      (m) => m.type === 'hq.event' && (m as { event: { id: string } }).event.id === 'evt-scrub-1',
      5_000,
    );
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-scrub-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'scrub-client',
          projectId: 'proj-scrub',
          seq: 1,
          payload: {
            mailboxId: 'proj-scrub:mailbox',
            action: 'message.sent',
            summary: summaryText,
          },
        },
      }),
    );

    const evt = (await evtPromise) as {
      type: 'hq.event';
      event: { id: string; payload: { summary?: string } };
    };
    const summary = evt.event.payload.summary;
    expect(typeof summary).toBe('string');
    // Truncated: must not exceed 280 chars + "[truncated:N]" suffix length.
    expect(summary!.length).toBeLessThan(summaryText.length);
    // The original 40-char PAT must not appear verbatim anywhere in the
    // broadcast summary. DefaultSecretScrubber replaces it with a placeholder
    // such as `[REDACTED:github_pat]` — that placeholder IS expected, but
    // the secret literal itself must be gone.
    expect(summary!.toLowerCase()).not.toContain(
      'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.toLowerCase(),
    );

    client.close();
  
  });
});
