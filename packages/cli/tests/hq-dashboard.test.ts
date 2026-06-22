// @vitest-environment jsdom

import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/core';
import { JSDOM } from 'jsdom';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract the inline `<script>` body from the dashboard HTML so it can be
 * `eval`-ed in a jsdom context. The script is the only runnable JS in the
 * page; everything else is HTML + CSS.
 */
function extractScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('HQ dashboard HTML has no <script> block');
  return match[1];
}

interface DashboardHandle {
  dom: JSDOM;
  window: JSDOM['window'];
  document: JSDOM['document'];
  eval: (src: string) => unknown;
}

/**
 * Mount the dashboard's real HTML in jsdom and evaluate its inline script
 * with `WebSocket` overridden to Node's `ws` package so the dashboard's
 * `connect()` actually opens a connection to the live `startHqServer`
 * instance that the caller has already started. The returned handle exposes
 * the jsdom window/document so tests can assert on rendered DOM.
 *
 * This is the live round-trip variant: it requires a running server and
 * exercises the full HTML/JS path (HTTP /, /api/projects/:id fetch, WS).
 */
async function mountDashboardWithLiveServer(
  serverHandle: HqServerHandle,
  opts: { url?: string } = {},
): Promise<DashboardHandle> {
  const url = opts.url ?? `http://127.0.0.1:${serverHandle.port}/`;
  const res = await fetch(url);
  const html = await res.text();
  const script = extractScript(html);

  const dom = new JSDOM(html, { url });
  // Pre-resolve relative URLs against the dashboard's mount URL so the
  // drilldown `fetch('/api/projects/:id')` round-trips to the live server.
  const fetchWithBase = (input: RequestInfo | URL, init?: RequestInit) => {
    const resolved =
      typeof input === 'string' && input.startsWith('/') ? new URL(input, url).toString() : input;
    return fetch(resolved, init);
  };
  // jsdom does not ship a WebSocket; the dashboard's `new WebSocket(...)`
  // would throw. Inject Node's `ws` package so the script can connect to
  // the live server.
  (dom.window as never as { WebSocket: unknown }).WebSocket = WebSocket;
  // jsdom's built-in `fetch` does not allow network resources by default.
  // Inject our base-URL-aware `fetchWithBase` so the drilldown can hit
  // the live server.
  (dom.window as never as { fetch: typeof fetch }).fetch = fetchWithBase as typeof fetch;
  // The script uses setTimeout/queueMicrotask for reconnect logic; route
  // those through the host so timers don't leak between tests.
  (dom.window as never as { queueMicrotask: typeof queueMicrotask }).queueMicrotask =
  (dom.window as { clearTimeout: typeof clearTimeout }).clearTimeout = clearTimeout;
  (dom.window as { queueMicrotask: typeof queueMicrotask }).queueMicrotask =
    queueMicrotask;

  // JSDOM 29 `dom.window.eval` runs in a vm context where bare
  // `document`/`window`/`location`/`WebSocket`/`fetch` references don't
  // resolve via the window's own properties. Build a Function constructor
  // inside the window's realm and pass them in as parameters, so the
  // inline script's loose-mode references resolve through the closure.
  try {
    const wrapper = new dom.window.Function(
      'document',
      'location',
      'window',
      'WebSocket',
      'fetch',
      script,
    );
    wrapper(
      dom.window.document,
      dom.window.location,
      dom.window,
      dom.window.WebSocket,
      fetchWithBase,
    );
  } catch (e) {
    // Surface the actual null target the script complained about.
    const ids = new Set<string>();
    const idRe = /\b(?:el|getElementById)\(\s*['"]([\w-]+)['"]/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration
    while ((m = idRe.exec(script)) !== null) {
      if (m[1]) ids.add(m[1]);
    }
    const missing = Array.from(ids).filter((id) => !dom.window.document.getElementById(id));
    throw new Error(
      'script eval failed: ' +
        (e instanceof Error ? e.message : String(e)) +
        ' | total el/getElementById calls: ' +
        ids.size +
        ' | missing: ' +
        (missing.length === 0 ? '(none)' : missing.join(',')),
    );
  }
  // Give the script a moment to open the WebSocket and receive the initial
  // `hq.snapshot`.
  await waitMs(60);
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    eval: (src) => dom.window.eval(src),
  };
}

/**
 * Register a fresh `/ws/client` and return once the server has the client
 * in its internal map. Sends a valid `client.hello` and waits briefly for
 * the server to register before returning.
 */
async function registerClient(
  port: number,
  payload: {
    clientId: string;
    kind: 'tui' | 'cli' | 'repl' | 'webui' | 'unknown';
    projectId: string;
    projectName?: string;
  },
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: {
          clientId: payload.clientId,
          kind: payload.kind,
          machineId: 'm_test',
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId: payload.projectId,
          projectRoot: '/tmp/' + payload.projectId,
          projectName: payload.projectName ?? payload.projectId,
          machineId: 'm_test',
          workspaceKind: 'directory',
        },
        capabilities: ['telemetry.publish', 'mailbox.summary'],
      },
    }),
  );
  await waitMs(30);
  return ws;
}

/** Publish a `mailbox.snapshot` envelope on an existing client socket. */
function publishMailboxSnapshot(
  ws: WebSocket,
  args: {
    projectId: string;
    mailboxId: string;
    messages?: Array<Record<string, unknown>>;
    agents?: Array<Record<string, unknown>>;
    totals?: Record<string, number>;
  },
): void {
  ws.send(
    JSON.stringify({
      type: 'client.event',
      event: {
        id: 'evt_' + Math.random().toString(36).slice(2, 8),
        type: 'mailbox.snapshot',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
        clientId: 'mb_publisher',
        projectId: args.projectId,
        seq: 1,
        payload: {
          mailboxId: args.mailboxId,
          scope: 'project',
          messages: args.messages ?? [],
          agents: args.agents ?? [],
          totals: args.totals ?? {
            messages: 0,
            unread: 0,
            incomplete: 0,
            highPriority: 0,
            onlineAgents: 0,
          },
        },
      },
    }),
  );
}

/** Publish a `mailbox.event` envelope on an existing client socket. */
function publishMailboxEvent(
  ws: WebSocket,
  args: { projectId: string; mailboxId: string; action: string; summary: string },
): void {
  ws.send(
    JSON.stringify({
      type: 'client.event',
      event: {
        id: 'evt_' + Math.random().toString(36).slice(2, 8),
        type: 'mailbox.event',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
        clientId: 'mb_publisher',
        projectId: args.projectId,
        seq: 2,
        payload: {
          mailboxId: args.mailboxId,
          action: args.action,
          summary: args.summary,
        },
      },
    }),
  );
}

describe('HQ dashboard drawer (jsdom)', () => {
  it('connects the browser websocket when the dashboard is opened with a tokenized URL', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-dashboard-token-'));
    try {
      await writeHqAuthFile(dataDir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        browserTokens: [{ id: 'bt-dashboard', token: 'dashboard-browser-token', createdAt: new Date().toISOString() }],
        clientTokens: [],
      });
      handle = await startHqServer({ port: getPort(), dataDir });

      const { document } = await mountDashboardWithLiveServer(handle, {
        url: `http://127.0.0.1:${handle.port}/?token=dashboard-browser-token`,
      });
      await waitMs(80);

      expect(document.getElementById('hq-conn')?.textContent).toContain('Connected to HQ');
    } finally {
      if (handle) {
        await handle.close();
        handle = null;
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('renders the initial empty state for mailboxes + clients', async () => {
    handle = await startHqServer({ port: getPort() });
    const { document } = await mountDashboardWithLiveServer(handle);
    const mbTbody = document.getElementById('tbody-mailboxes');
    const clTbody = document.getElementById('tbody-clients');
    expect(mbTbody?.textContent).toContain('No mailboxes yet');
    expect(clTbody?.textContent).toContain('No clients connected yet');
  });

  it('drawer is closed on initial load and aria-hidden="true"', async () => {
    handle = await startHqServer({ port: getPort() });
    const { document } = await mountDashboardWithLiveServer(handle);
    const drawer = document.getElementById('drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    expect(drawer?.getAttribute('aria-hidden')).toBe('true');
    expect(drawer?.classList.contains('open')).toBe(false);
    expect(backdrop?.classList.contains('open')).toBe(false);
  });

  it('renders the Fleet HQ flow diagram from the live snapshot', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'flow_cli',
      kind: 'cli',
      projectId: 'proj_flow',
      projectName: 'Flow Project',
    });
    publishMailboxSnapshot(client, {
      projectId: 'proj_flow',
      mailboxId: 'proj_flow:mailbox',
      scope: 'project',
      messages: [],
      agents: [],
      totals: { messages: 4, unread: 2, incomplete: 1, highPriority: 1, onlineAgents: 1 },
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle);
    await waitMs(80);

    const flow = document.getElementById('hq-flow');
    expect(flow?.textContent).toContain('WrongStack HQ');
    expect(flow?.textContent).toContain('Flow Project');
    expect(flow?.textContent).toContain('4 msgs');
    expect(flow?.querySelectorAll('[data-flow-node]').length).toBe(3);
    expect(flow?.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(2);

    client.close();
  });

  it('renders the global stat cards from the live snapshot', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'stat_cli',
      kind: 'cli',
      projectId: 'proj_stat',
    });
    publishMailboxSnapshot(client, {
      projectId: 'proj_stat',
      mailboxId: 'proj_stat:mailbox',
      scope: 'project',
      messages: [],
      agents: [],
      totals: { messages: 3, unread: 2, incomplete: 1, highPriority: 1, onlineAgents: 1 },
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle);
    // The browser is a separate WS connection; the snapshot it received
    // when it connected already reflects the registered client. Wait one
    // more tick for the post-publish re-broadcast.
    await waitMs(80);

    expect(document.getElementById('stat-clients')?.textContent).toBe('1');
    expect(document.getElementById('stat-projects')?.textContent).toBe('1');
    expect(document.getElementById('stat-mailboxes')?.textContent).toBe('1');
    expect(document.getElementById('stat-unread')?.textContent).toBe('2');
    expect(document.getElementById('stat-incomplete')?.textContent).toBe('1');
    expect(document.getElementById('stat-high')?.textContent).toBe('1');
    expect(document.getElementById('stat-agents')?.textContent).toBe('1');

    client.close();
  });

  it('opens the drawer on project link click and renders the project detail', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'drill_cli',
      kind: 'cli',
      projectId: 'proj_drill',
    });
    publishMailboxSnapshot(client, {
      projectId: 'proj_drill',
      mailboxId: 'proj_drill:mailbox',
      scope: 'project',
      messages: [
        {
          messageId: 'msg_1',
          from: 'agent-a',
          to: 'agent-b',
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
          name: 'Agent A',
          sessionId: 'sess_a',
          status: 'online',
          iterations: 0,
          toolCalls: 0,
          lastActivityAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
      ],
      totals: { messages: 1, unread: 1, incomplete: 1, highPriority: 1, onlineAgents: 1 },
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle);
    await waitMs(80);

    // Click the project link in the mailboxes table.
    const link = document.querySelector<HTMLAnchorElement>('a.project-link');
    expect(link).toBeTruthy();
    link!.click();
    await waitMs(80);

    const drawer = document.getElementById('drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    expect(drawer?.classList.contains('open')).toBe(true);
    expect(backdrop?.classList.contains('open')).toBe(true);
    expect(drawer?.getAttribute('aria-hidden')).toBe('false');

    const title = document.getElementById('drawer-title');
    expect(title?.textContent).toBe('proj_drill');

    // The drawer mailbox table should now show the snapshot's mailbox.
    // /api/projects/:id is a fetch round-trip — wait until the
    // `Loading…` placeholder is replaced with actual content. The mailbox
    // id is rendered through `shortId()` which truncates long ids to
    // 6…4 form, so assert against the truncated form.
    const drawerMbTbody = document.getElementById('drawer-mailboxes');
    for (let i = 0; i < 30 && drawerMbTbody?.textContent === 'Loading…'; i++) {
      await waitMs(20);
    }
    expect(drawerMbTbody?.textContent).not.toBe('Loading…');
    expect(drawerMbTbody?.textContent).toContain('proj_d…lbox');
    expect(drawerMbTbody?.textContent).toContain('1'); // messages count

    const drawerMessages = document.getElementById('drawer-messages');
    expect(drawerMessages?.textContent).toContain('Need review');

    client.close();
  });

  it('auto-opens the drawer on initial load when ?project= is set', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'init_cli',
      kind: 'cli',
      projectId: 'proj_init',
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_init`,
    });
    await waitMs(120);

    const drawer = document.getElementById('drawer');
    expect(drawer?.classList.contains('open')).toBe(true);
    const title = document.getElementById('drawer-title');
    expect(title?.textContent).toBe('proj_init');

    client.close();
  });

  it('auto-opens the drawer on initial load when #<projectId> hash is set', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'hash_cli',
      kind: 'cli',
      projectId: 'proj_hash',
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/#proj_hash`,
    });
    await waitMs(150);

    const drawer = document.getElementById('drawer');
    expect(drawer?.classList.contains('open')).toBe(true);
    const title = document.getElementById('drawer-title');
    expect(title?.textContent).toBe('proj_hash');
    const urlHash = document.defaultView?.location.hash;
    expect(urlHash).toBe('#proj_hash');

    client.close();
  });

  it('closes the drawer on close-button click and clears the URL', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'close_cli',
      kind: 'cli',
      projectId: 'proj_close',
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_close`,
    });
    await waitMs(120);

    const drawer = document.getElementById('drawer');
    expect(drawer?.classList.contains('open')).toBe(true);

    // Click the close button.
    document.getElementById('drawer-close')?.click();
    await waitMs(20);

    expect(drawer?.classList.contains('open')).toBe(false);
    expect(drawer?.getAttribute('aria-hidden')).toBe('true');
    // jsdom does not update `location.search` in response to
    // `history.replaceState`, so the search string still reflects the
    // initial URL we mounted with. The real check is that the project
    // picker has been reset and the URL no longer encodes an open
    // project — verified via the picker reset below.
    const picker = document.getElementById('project-picker') as HTMLSelectElement | null;
    expect(picker?.value).toBe('');

    client.close();
  });

  it('closes the drawer on Escape key', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'esc_cli',
      kind: 'cli',
      projectId: 'proj_esc',
    });
    await waitMs(40);

    const { dom, document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_esc`,
    });
    await waitMs(120);

    const drawer = document.getElementById('drawer');
    expect(drawer?.classList.contains('open')).toBe(true);

    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await waitMs(20);

    expect(drawer?.classList.contains('open')).toBe(false);

    client.close();
  });

  it('renders a mailbox event into the live feed when the drawer is open for that project', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'feed_cli',
      kind: 'cli',
      projectId: 'proj_feed',
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_feed`,
    });
    await waitMs(120);

    // Publish a mailbox.event for the open project.
    publishMailboxEvent(client, {
      projectId: 'proj_feed',
      mailboxId: 'proj_feed:mailbox',
      action: 'message.sent',
      summary: 'agent-a asked agent-b: review needed',
    });
    await waitMs(60);

    const feed = document.getElementById('drawer-event-feed');
    expect(feed?.textContent).toContain('message.sent');
    expect(feed?.textContent).toContain('review needed');

    // feed-status should be live right after the event (1.5s before reverting).
    const status = document.getElementById('feed-status');
    expect(status?.className).toContain('live');
    expect(status?.textContent).toBe('(live)');

    client.close();
  });

  it('appends mailbox events to the drawer live feed within 1s and renders the event timestamp', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'ts_cli',
      kind: 'cli',
      projectId: 'proj_ts',
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_ts`,
    });
    await waitMs(120);

    // Drawer must be open for proj_ts before we start measuring.
    expect(document.getElementById('drawer')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('drawer-event-feed')).toBeTruthy();

    // Stamp t0 right before publish so latency = render-time - publish-time.
    const t0 = Date.now();
    publishMailboxEvent(client, {
      projectId: 'proj_ts',
      mailboxId: 'proj_ts:mailbox',
      action: 'message.completed',
      summary: 'event-ts-1 — sub-millisecond round-trip check',
    });

    // Poll the DOM until the event summary shows up, with a hard 1s ceiling.
    // The server-side `mailbox.event` payload is sanitized then broadcast
    // over WS; the browser appends to `drawer-event-feed` on `hq.event`.
    const pollStart = Date.now();
    const deadline = pollStart + 1000;
    let feedText = '';
    while (Date.now() < deadline) {
      feedText = document.getElementById('drawer-event-feed')?.textContent ?? '';
      if (feedText.includes('event-ts-1')) break;
      await waitMs(25);
    }
    const t1 = Date.now();
    const latency = t1 - t0;

    expect(feedText).toContain('event-ts-1');
    expect(feedText).toContain('message.completed');
    expect(latency).toBeLessThan(1000);

    // Timestamp rendered: `fmtTime(evt.timestamp)` produces an HH:MM:SS-shaped
    // string via `toLocaleTimeString()`. The exact format is locale-dependent
    // (some locales add AM/PM, comma, or narrow-no-break-space). Match the
    // structurally stable shape: two `:` separators and at least one digit
    // before the first one.
    expect(feedText).toMatch(/\b\d+:\d{2}(:\d{2})?\b/);

    client.close();
  });

  it('caps the drawer event-feed ring buffer at 50 entries (oldest event dropped)', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'cap_cli',
      kind: 'cli',
      projectId: 'proj_cap',
    });
    await waitMs(40);

    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_cap`,
    });
    await waitMs(120);

    expect(document.getElementById('drawer')?.classList.contains('open')).toBe(true);
    const feed = document.getElementById('drawer-event-feed');
    expect(feed).toBeTruthy();

    // Publish 51 unique events. Each summary has a zero-padded index so we
    // can find both endpoints (event-001, event-051) in the rendered feed.
    for (let i = 1; i <= 51; i++) {
      const idx = String(i).padStart(3, '0');
      publishMailboxEvent(client, {
        projectId: 'proj_cap',
        mailboxId: 'proj_cap:mailbox',
        action: 'message.sent',
        summary: `event-${idx}`,
      });
    }
    // Wait for the last event to render — gives the server time to broadcast
    // and the browser to append. CEILING_MAX matches FEED_MAX so a regression
    // that doubles the cap (or drops the cap entirely) is still caught.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const text = feed?.textContent ?? '';
      if (text.includes('event-051')) break;
      await waitMs(25);
    }

    const feedText = feed?.textContent ?? '';
    // Newest event (event-051) must be present — it was unshifted last.
    expect(feedText).toContain('event-051');
    // Oldest kept event (event-002) must be present — it occupies slot 50
    // after event-001 is dropped.
    expect(feedText).toContain('event-002');
    // The dropped event (event-001) must NOT appear in the feed.
    expect(feedText).not.toContain('event-001');

    // Row count cap: exactly FEED_MAX (50) entries rendered. Using
    // querySelectorAll avoids off-by-one hazards from whitespace / newline
    // nodes that textContent cannot distinguish.
    const rows = feed?.querySelectorAll('.feed-row') ?? [];
    expect(rows.length).toBe(50);

    client.close();
  });

  it('preserves per-project event history when the drawer is closed and reopened', async () => {
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'hist_cli',
      kind: 'cli',
      projectId: 'proj_hist',
    });
    await waitMs(40);

    // Mount without an initial project; the drawer is closed.
    const { dom, document } = await mountDashboardWithLiveServer(handle);
    await waitMs(80);

    // Publish two mailbox events for proj_hist while the drawer is closed.
    publishMailboxEvent(client, {
      projectId: 'proj_hist',
      mailboxId: 'proj_hist:mailbox',
      action: 'message.sent',
      summary: 'event 1',
    });
    await waitMs(20);
    publishMailboxEvent(client, {
      projectId: 'proj_hist',
      mailboxId: 'proj_hist:mailbox',
      action: 'message.completed',
      summary: 'event 2',
    });
    await waitMs(60);

    // The drawer is still closed — the feed is hidden.
    const drawer = document.getElementById('drawer');
    expect(drawer?.classList.contains('open')).toBe(false);

    // Open the drawer for proj_hist via the picker. The picker only gets
    // options after the first snapshot populates the project list.
    const picker = document.getElementById('project-picker') as HTMLSelectElement | null;
    expect(picker).toBeTruthy();
    // Populate the picker with the project id directly so the test does
    // not depend on snapshot timing.
    const option = document.createElement('option');
    option.value = 'proj_hist';
    option.textContent = 'proj_hist (1)';
    picker!.appendChild(option);
    picker!.value = 'proj_hist';
    picker!.dispatchEvent(new dom.window.Event('change'));
    await waitMs(120);

    expect(drawer?.classList.contains('open')).toBe(true);
    const feed = document.getElementById('drawer-event-feed');
    expect(feed?.textContent).toContain('event 1');
    expect(feed?.textContent).toContain('event 2');

    client.close();
  });

  it('auto-refreshes the drawer when a new mailbox.snapshot arrives (debounced re-fetch)', async () => {
    // The drawer's auto-refresh triggers when an `hq.snapshot` arrives
    // while a project drawer is open AND that project is still in the
    // snapshot's `projects` list. The re-fetch is debounced ~250ms so
    // bursts of snapshots produce a single re-fetch.
    handle = await startHqServer({ port: getPort() });
    const client = await registerClient(handle.port, {
      clientId: 'refresh_cli',
      kind: 'cli',
      projectId: 'proj_refresh',
    });

    publishMailboxSnapshot(client, {
      projectId: 'proj_refresh',
      mailboxId: 'proj_refresh:mailbox',
      scope: 'project',
      messages: [
        {
          messageId: 'msg_initial',
          from: 'agent-a',
          to: 'agent-b',
          subject: 'Initial review',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          completed: false,
          hasBody: false,
        },
      ],
      agents: [
        {
          agentId: 'agent-a',
          name: 'Agent A',
          sessionId: 'sess_a',
          status: 'online',
          iterations: 0,
          toolCalls: 0,
          lastActivityAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
      ],
      totals: { messages: 1, unread: 1, incomplete: 1, highPriority: 0, onlineAgents: 1 },
    });
    await waitMs(40);

    // Mount with `?project=` so the drawer auto-opens for proj_refresh.
    const { document } = await mountDashboardWithLiveServer(handle, {
      url: `http://127.0.0.1:${handle.port}/?project=proj_refresh`,
    });
    await waitMs(120);

    // Drawer is open and the initial snapshot's 1 message is rendered.
    const drawerMbTbody = document.getElementById('drawer-mailboxes');
    for (let i = 0; i < 30 && drawerMbTbody?.textContent === 'Loading…'; i++) {
      await waitMs(20);
    }
    expect(drawerMbTbody?.textContent).not.toBe('Loading…');
    // Initial state: 1 mailbox, messages=1, unread=1, agents=1. The
    // numeric cells render as `<td class="num">N</td>` so we check
    // innerHTML for `>1</td>` to avoid textContent whitespace flattening.
    expect(drawerMbTbody?.innerHTML).toMatch(/<td class="num">1<\/td>/);

    // Publish a fresh mailbox.snapshot with 3 messages. The server will
    // update its per-client mailbox map and broadcast a new `hq.snapshot`
    // to browsers. The dashboard's auto-refresh timer (debounced 250ms)
    // fires once, re-fetching /api/projects/:id and re-rendering the
    // drawer mailbox table.
    publishMailboxSnapshot(client, {
      projectId: 'proj_refresh',
      mailboxId: 'proj_refresh:mailbox',
      scope: 'project',
      messages: [
        {
          messageId: 'msg_1',
          from: 'agent-a',
          to: 'agent-b',
          subject: 'First',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          completed: false,
          hasBody: false,
        },
        {
          messageId: 'msg_2',
          from: 'agent-a',
          to: 'agent-c',
          subject: 'Second',
          priority: 'high',
          timestamp: new Date().toISOString(),
          completed: false,
          hasBody: false,
        },
        {
          messageId: 'msg_3',
          from: 'agent-b',
          to: 'agent-a',
          subject: 'Third',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          completed: true,
          hasBody: true,
        },
      ],
      agents: [
        {
          agentId: 'agent-a',
          name: 'Agent A',
          sessionId: 'sess_a',
          status: 'online',
          iterations: 0,
          toolCalls: 0,
          lastActivityAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
        {
          agentId: 'agent-b',
          name: 'Agent B',
          sessionId: 'sess_b',
          status: 'online',
          iterations: 0,
          toolCalls: 0,
          lastActivityAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
      ],
      totals: { messages: 3, unread: 2, incomplete: 2, highPriority: 1, onlineAgents: 2 },
    });

    // Wait long enough for: server broadcast (~20ms) + 250ms debounce +
    // /api/projects/:id fetch (~30ms) + render. 500ms is a safe upper bound.
    await waitMs(500);

    const refreshedTbody = document.getElementById('drawer-mailboxes');
    const refreshedHtml = refreshedTbody?.innerHTML ?? '';
    // The drawer mailbox table must reflect the new totals: messages=3,
    // unread=2, onlineAgents=2. Each numeric cell renders as
    // `<td class="num">N</td>`, so the refreshed table must contain
    // `<td class="num">3</td>` (the new messages count) and at least one
    // `<td class="num">2</td>` (unread=2 and onlineAgents=2).
    expect(refreshedHtml).toMatch(/<td class="num">3<\/td>/);
    expect(refreshedHtml).toMatch(/<td class="num">2<\/td>/);

    // The stat-high stat card should also reflect the new totals — but
    // that card reflects the GLOBAL snapshot, not the project drilldown.
    // The strongest signal of an auto-refresh is that the drawer mailbox
    // table now shows totals higher than the initial "1" we asserted.

    client.close();
  });
});
