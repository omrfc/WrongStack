/**
 * HQ server — the read-only command-center backend for `wstack --hq`.
 *
 * Single HTTP server, single port. Two WebSocket upgrade paths:
 *   /ws/client  — TUI/REPL/WebUI clients publish telemetry
 *   /ws/browser — HQ browser connects and receives snapshot + events
 *
 * Phase 1 is read-only: the HQ browser observes what clients publish. No
 * control commands are sent to clients from the browser yet.
 *
 * Mailbox aggregation: every `mailbox.snapshot` envelope from a client is
 * stored per-(client, mailbox) and merged into the global HqSnapshot on
 * each browser poll / broadcast. Mailbox events still flow through as
 * transient events; snapshots give us the authoritative rollups.
 *
 * @module hq-server
 */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import * as http from 'node:http';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  HQ_PROTOCOL_VERSION,
  type HqAuthFile,
  type HqBrowserMessage,
  type HqClientCapability,
  type HqClientRecord,
  type HqEventEnvelope,
  type HqMailboxEventPayload,
  type HqMailboxSnapshotPayload,
  type HqMailboxSummary,
  type HqProjectRecord,
  type HqRedactionPolicy,
  type HqSnapshot,
  type HqWelcomePayload,
  parseHqEventPayload,
  parseHqFrame,
  readHqAuthFile,
  resolveHqDataDir,
  scrubAndTruncateHqPreview,
  watchHqAuthFile,
} from '@wrongstack/core';
import { WebSocket, WebSocketServer } from 'ws';

export interface HqServerOptions {
  host?: string;
  port?: number;
  strictPort?: boolean;
  /**
   * HQ data directory. When omitted, the server resolves one via
   * `resolveHqDataDir()` (honoring `WRONGSTACK_HQ_DATA_DIR` then falling
   * back to `~/.wrongstack/hq`). The directory holds `auth.json` and, in
   * later phases, the persistent event log and snapshot cache.
   */
  dataDir?: string;
}

export interface HqServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  projectId: string;
  kind: string;
  connectedAt: string;
  lastSeenAt: string;
  hostname?: string;
  pid?: number;
  version?: string;
  capabilities: readonly string[];
  /**
   * Latest mailbox snapshot keyed by mailboxId — replaces (not merges) on
   * each new `mailbox.snapshot` envelope from this client.
   */
  mailboxes: Map<string, HqMailboxSnapshotPayload>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3499;
const MAX_EVENT_LOG = 500;

const HQ_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WrongStack HQ</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --dim: #6e7681;
    --accent: #58a6ff;
    --live: #3fb950;
    --warn: #d29922;
    --high: #f85149;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; }
  h1 { margin: 0 0 4px; color: var(--accent); font-size: 22px; }
  .hq-sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; display: flex; align-items: center; gap: 8px; }
  .hq-led { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .hq-led.live { background: var(--live); box-shadow: 0 0 6px var(--live); }
  .hq-led.dead { background: var(--dim); }
  .hq-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .hq-stat { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .hq-stat .num { font-size: 26px; font-weight: 700; color: #f0f6fc; line-height: 1.1; }
  .hq-stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin-top: 4px; }
  .hq-stat.warn .num { color: var(--warn); }
  .hq-stat.high .num { color: var(--high); }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  section h2 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 600; color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 10px; border-bottom: 1px solid #21262d; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: #21262d; color: var(--muted); }
  td .pill.project { background: rgba(88,166,255,0.15); color: var(--accent); }
  td .pill.global { background: rgba(63,185,80,0.15); color: var(--live); }
  .empty { color: var(--dim); font-style: italic; padding: 12px 0; font-size: 13px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #21262d; color: var(--muted); margin-right: 4px; }
  .project-link { color: var(--accent); cursor: pointer; text-decoration: none; }
  .project-link:hover { text-decoration: underline; }
  .drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; z-index: 50; }
  .drawer-backdrop.open { display: block; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(720px, 90vw); background: var(--panel); border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(0,0,0,0.5); transform: translateX(100%); transition: transform 0.18s ease; overflow-y: auto; z-index: 51; padding: 24px; }
  .drawer.open { transform: translateX(0); }
  .drawer h2 { margin: 0 0 4px; color: var(--accent); font-size: 18px; }
  .drawer .drawer-meta { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
  .drawer .drawer-close { float: right; background: transparent; border: 1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .drawer .drawer-close:hover { background: #21262d; }
  .msg-row { padding: 10px; border-bottom: 1px solid #21262d; font-size: 13px; }
  .msg-row:last-child { border-bottom: none; }
  .msg-row .msg-subject { font-weight: 600; color: #f0f6fc; }
  .msg-row .msg-meta { color: var(--dim); font-size: 11px; margin-top: 2px; }
  .msg-row .msg-preview { color: var(--muted); font-size: 12px; margin-top: 4px; font-style: italic; }
  .pill.priority-high { background: rgba(248,81,73,0.18); color: var(--high); }
  .pill.priority-normal { background: rgba(88,166,255,0.15); color: var(--accent); }
  .pill.priority-low { background: #21262d; color: var(--dim); }
  .hq-toolbar { display: flex; align-items: center; gap: 8px; margin: 12px 0 16px; padding: 8px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  .hq-toolbar label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); }
  .hq-toolbar select { background: #0d1117; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; min-width: 280px; }
  .hq-toolbar select:focus { outline: none; border-color: var(--accent); }
  .feed-status { float: right; font-size: 10px; text-transform: none; letter-spacing: 0; color: var(--dim); }
  .feed-status.live { color: var(--live); }
  .feed-row { padding: 8px 10px; border-bottom: 1px solid #21262d; font-size: 12px; animation: feed-flash 0.6s ease-out; }
  .feed-row:last-child { border-bottom: none; }
  .feed-row .feed-action { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-right: 6px; background: #21262d; color: var(--muted); font-family: ui-monospace, monospace; }
  .feed-row .feed-action.message-sent { background: rgba(88,166,255,0.18); color: var(--accent); }
  .feed-row .feed-action.message-completed { background: rgba(63,185,80,0.18); color: var(--live); }
  .feed-row .feed-action.message-read { background: rgba(139,148,158,0.18); color: var(--muted); }
  .feed-row .feed-action.agent-offline { background: rgba(248,81,73,0.18); color: var(--high); }
  .feed-row .feed-action.agent-registered { background: rgba(63,185,80,0.18); color: var(--live); }
  .feed-row .feed-meta { color: var(--dim); font-size: 10px; margin-top: 2px; }
  @keyframes feed-flash { 0% { background: rgba(88,166,255,0.25); } 100% { background: transparent; } }
</style>
</head>
<body>
<h1>📋 WrongStack HQ</h1>
<p class="hq-sub" id="hq-conn"><span class="hq-led dead" id="hq-led"></span>Connecting…</p>
<div class="hq-toolbar">
  <label for="project-picker">Project:</label>
  <select id="project-picker" aria-label="Select project">
    <option value="">— Select project —</option>
  </select>
</div>

<div class="hq-grid">
  <div class="hq-stat"><span class="num" id="stat-clients">0</span><div class="label">Active clients</div></div>
  <div class="hq-stat"><span class="num" id="stat-projects">0</span><div class="label">Projects</div></div>
  <div class="hq-stat warn"><span class="num" id="stat-mailboxes">0</span><div class="label">Mailboxes</div></div>
  <div class="hq-stat warn"><span class="num" id="stat-unread">0</span><div class="label">Unread messages</div></div>
  <div class="hq-stat warn"><span class="num" id="stat-incomplete">0</span><div class="label">Open messages</div></div>
  <div class="hq-stat high"><span class="num" id="stat-high">0</span><div class="label">High priority</div></div>
  <div class="hq-stat"><span class="num" id="stat-agents">0</span><div class="label">Online agents</div></div>
</div>

<section>
  <h2>📬 Mailboxes</h2>
  <table>
    <thead>
      <tr>
        <th>Mailbox</th>
        <th>Scope</th>
        <th>Project</th>
        <th class="num">Messages</th>
        <th class="num">Unread</th>
        <th class="num">Open</th>
        <th class="num">High</th>
        <th class="num">Agents</th>
      </tr>
    </thead>
    <tbody id="tbody-mailboxes">
      <tr><td colspan="8" class="empty">No mailboxes yet. Connect a TUI/REPL/WebUI client with WRONGSTACK_HQ_URL set.</td></tr>
    </tbody>
  </table>
</section>

<section>
  <h2>👥 Clients</h2>
  <table>
    <thead>
      <tr>
        <th>Client ID</th>
        <th>Kind</th>
        <th>Project</th>
        <th>Capabilities</th>
        <th>Last seen</th>
      </tr>
    </thead>
    <tbody id="tbody-clients">
      <tr><td colspan="5" class="empty">No clients connected yet.</td></tr>
    </tbody>
  </table>
</section>

<div class="drawer-backdrop" id="drawer-backdrop"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <button class="drawer-close" id="drawer-close">Close</button>
  <h2 id="drawer-title">Project</h2>
  <p class="drawer-meta" id="drawer-meta"></p>
  <section>
    <h2>📬 Mailboxes</h2>
    <table>
      <thead>
        <tr>
          <th>Mailbox</th>
          <th>Scope</th>
          <th class="num">Messages</th>
          <th class="num">Unread</th>
          <th class="num">Agents</th>
        </tr>
      </thead>
      <tbody id="drawer-mailboxes">
        <tr><td colspan="5" class="empty">Loading…</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h2>📨 Recent messages</h2>
    <div id="drawer-messages">
      <p class="empty">Loading…</p>
    </div>
  </section>
  <section>
    <h2>📡 Live mailbox events
      <span class="feed-status" id="feed-status">(idle)</span>
    </h2>
    <div id="drawer-event-feed">
      <p class="empty">No mailbox events yet for this project.</p>
    </div>
  </section>
  <section>
    <h2>👥 Clients</h2>
    <table>
      <thead>
        <tr>
          <th>Client ID</th>
          <th>Kind</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody id="drawer-clients">
        <tr><td colspan="3" class="empty">Loading…</td></tr>
      </tbody>
    </table>
  </section>
</aside>

<script>
  const led = document.getElementById('hq-led');
  const connText = document.getElementById('hq-conn');

  function el(id) { return document.getElementById(id); }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString();
  }

  function shortId(s) {
    if (!s) return '—';
    return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
  }

  function renderMailboxes(mailboxes) {
    const tbody = el('tbody-mailboxes');
    if (!mailboxes || mailboxes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No mailboxes yet. Connect a TUI/REPL/WebUI client with WRONGSTACK_HQ_URL set.</td></tr>';
      return;
    }
    tbody.innerHTML = mailboxes.map((m) => {
      const scopeClass = m.scope === 'global' ? 'global' : 'project';
      const projectCell = '<a href="#' + encodeURIComponent(m.projectId) + '" class="project-link" data-project="' + escapeHtml(m.projectId) + '">' + escapeHtml(shortId(m.projectId)) + '</a>';
      return '<tr>' +
        '<td><code>' + escapeHtml(shortId(m.mailboxId)) + '</code></td>' +
        '<td><span class="pill ' + scopeClass + '">' + escapeHtml(m.scope) + '</span></td>' +
        '<td>' + projectCell + '</td>' +
        '<td class="num">' + m.messageCount + '</td>' +
        '<td class="num">' + (m.unreadCount > 0 ? '<strong>' + m.unreadCount + '</strong>' : '0') + '</td>' +
        '<td class="num">' + m.incompleteCount + '</td>' +
        '<td class="num">' + (m.highPriorityCount > 0 ? '<strong style="color:var(--high)">' + m.highPriorityCount + '</strong>' : '0') + '</td>' +
        '<td class="num">' + m.onlineAgentCount + '</td>' +
      '</tr>';
    }).join('');
    wireProjectLinks();
  }

  function renderClients(clients) {
    const tbody = el('tbody-clients');
    if (!clients || clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No clients connected yet.</td></tr>';
      return;
    }
    tbody.innerHTML = clients.map((c) => {
      const caps = (c.capabilities || []).map((cap) => '<span class="badge">' + escapeHtml(cap) + '</span>').join('');
      return '<tr>' +
        '<td><code>' + escapeHtml(shortId(c.clientId)) + '</code></td>' +
        '<td>' + escapeHtml(c.kind) + '</td>' +
        '<td>' + escapeHtml(shortId(c.projectId)) + '</td>' +
        '<td>' + caps + '</td>' +
        '<td>' + fmtTime(c.lastSeenAt) + '</td>' +
      '</tr>';
    }).join('');
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function applySnapshot(s) {
    el('stat-clients').textContent = s.totals.activeClients;
    el('stat-projects').textContent = s.totals.activeProjects;
    el('stat-unread').textContent = s.totals.unreadMailboxMessages;
    el('stat-incomplete').textContent = s.totals.incompleteMailboxMessages;

    let totalMessages = 0;
    let highPriority = 0;
    let onlineAgents = 0;
    for (const m of (s.mailboxes || [])) {
      totalMessages += m.messageCount;
      highPriority += m.highPriorityCount;
      onlineAgents += m.onlineAgentCount;
    }
    el('stat-mailboxes').textContent = (s.mailboxes || []).length;
    el('stat-high').textContent = highPriority;
    el('stat-agents').textContent = onlineAgents;

    renderMailboxes(s.mailboxes || []);
    renderClients(s.clients || []);
    renderProjectPicker(s.projects || []);

    // Auto-refresh the open drawer if the open project is still active in
    // the live snapshot. Debounced so rapid burst updates trigger one fetch.
    if (currentDetailProjectId) {
      const stillActive = (s.projects || []).some((p) => p.projectId === currentDetailProjectId);
      if (stillActive) scheduleAutoRefresh();
    }
  }

  // ---------- Project drilldown drawer ----------

  // Current detail request token; if the URL changes (e.g. user picks a
  // different project) we discard stale responses.
  let currentDetailToken = 0;
  let currentDetailProjectId = null;
  let autoRefreshTimer = null;
  let lastAutoRefreshAt = null;
  // Per-project live event feed (ring buffer per project). Keyed by
  // projectId so switching drawers keeps each project's history.
  const eventFeeds = new Map();
  const FEED_MAX = 50;
  let feedIdleTimer = null;

  function parseInitialProject() {
    // Prefer ?project=ID over #ID so URL copy/paste stays predictable even
    // when fragments would otherwise be lost on server round-trips.
    const url = new URL(location.href);
    const fromQuery = url.searchParams.get('project');
    if (fromQuery) return fromQuery;
    if (location.hash.length > 1) {
      try { return decodeURIComponent(location.hash.slice(1)); } catch { return null; }
    }
    return null;
  }

  function pushProjectUrl(projectId) {
    const url = new URL(location.href);
    url.searchParams.set('project', projectId);
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
  }

  function clearProjectUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('project');
    url.hash = '';
    history.replaceState(null, '', url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : ''));
  }

  function renderProjectPicker(projects) {
    const sel = el('project-picker');
    if (!sel) return;
    const current = currentDetailProjectId || '';
    sel.innerHTML =
      '<option value="">— Select project —</option>' +
      (projects || []).map((p) =>
        '<option value="' + escapeHtml(p.projectId) + '"' +
          (p.projectId === current ? ' selected' : '') +
        '>' + escapeHtml(p.projectName || p.projectId) + ' (' + (p.activeClients || 0) + ')</option>'
      ).join('');
    sel.onchange = () => {
      const v = sel.value;
      if (v) openProject(v);
      else closeProject();
    };
  }

  function setDrawerMeta(detail) {
    if (!detail || !detail.project) return;
    const p = detail.project;
    const refreshed = lastAutoRefreshAt ? ' · Last refreshed ' + fmtTime(lastAutoRefreshAt) : '';
    el('drawer-meta').textContent =
      'Active clients: ' + (p.activeClients || 0) +
      ' · Generated: ' + fmtTime(detail.generatedAt) +
      refreshed;
  }

  function fetchProjectDetail(projectId, opts) {
    const token = ++currentDetailToken;
    const silent = opts && opts.silent;
    if (!silent) {
      el('drawer-meta').textContent = 'Refreshing…';
    }
    fetch('/api/projects/' + encodeURIComponent(projectId))
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((d) => {
        if (token !== currentDetailToken) return; // stale
        renderProjectDetail(d);
        lastAutoRefreshAt = new Date();
        setDrawerMeta(d);
      })
      .catch((err) => {
        if (token !== currentDetailToken) return;
        if (!silent) {
          el('drawer-meta').textContent = 'Failed to load: ' + escapeHtml(String(err.message || err));
        }
      });
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      autoRefreshTimer = null;
      if (currentDetailProjectId) fetchProjectDetail(currentDetailProjectId, { silent: true });
    }, 250);
  }

  function openProject(projectId) {
    if (!projectId) return;
    const drawer = el('drawer');
    const backdrop = el('drawer-backdrop');
    el('drawer-title').textContent = projectId;
    el('drawer-meta').textContent = 'Loading…';
    el('drawer-mailboxes').innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';
    el('drawer-messages').innerHTML = '<p class="empty">Loading…</p>';
    el('drawer-clients').innerHTML = '<tr><td colspan="3" class="empty">Loading…</td></tr>';
    drawer.classList.add('open');
    backdrop.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    pushProjectUrl(projectId);
    currentDetailProjectId = projectId;
    lastAutoRefreshAt = null;
    // Render any mailbox events the project received while the drawer was
    // closed so the live feed ring buffer is visible immediately on open.
    const existingFeed = eventFeeds.get(projectId);
    if (existingFeed) renderEventFeed(existingFeed);
    fetchProjectDetail(projectId, { silent: false });
  }

  function closeProject() {
    const drawer = el('drawer');
    const backdrop = el('drawer-backdrop');
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    currentDetailProjectId = null;
    currentDetailToken++;
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    lastAutoRefreshAt = null;
    clearProjectUrl();
    const sel = el('project-picker');
    if (sel) sel.value = '';
  }

  function renderProjectDetail(detail) {
    if (!detail || !detail.project) {
      el('drawer-meta').textContent = 'No data.';
      return;
    }
    setDrawerMeta(detail);

    // Mailboxes
    const mbs = detail.mailboxes || [];
    el('drawer-mailboxes').innerHTML = mbs.length === 0
      ? '<tr><td colspan="5" class="empty">No mailboxes reported for this project yet.</td></tr>'
      : mbs.map((m) => {
          const scopeClass = m.scope === 'global' ? 'global' : 'project';
          return '<tr>' +
            '<td><code>' + escapeHtml(shortId(m.mailboxId)) + '</code></td>' +
            '<td><span class="pill ' + scopeClass + '">' + escapeHtml(m.scope) + '</span></td>' +
            '<td class="num">' + m.totals.messages + '</td>' +
            '<td class="num">' + (m.totals.unread > 0 ? '<strong>' + m.totals.unread + '</strong>' : '0') + '</td>' +
            '<td class="num">' + m.totals.onlineAgents + '</td>' +
          '</tr>';
        }).join('');

    // Recent messages — flatten + sort by timestamp desc, take 20
    const allMessages = [];
    for (const m of mbs) {
      for (const msg of (m.messages || [])) allMessages.push(msg);
    }
    allMessages.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const recent = allMessages.slice(0, 20);
    el('drawer-messages').innerHTML = recent.length === 0
      ? '<p class="empty">No messages in any mailbox snapshot yet.</p>'
      : recent.map((m) => {
          const priorityClass = 'priority-' + (m.priority || 'normal');
          const preview = m.bodyPreview ? '<div class="msg-preview">' + escapeHtml(m.bodyPreview) + '</div>' : '';
          const task = m.task ? ' · task: ' + escapeHtml(m.task.status || '?') : '';
          return '<div class="msg-row">' +
            '<span class="pill ' + priorityClass + '">' + escapeHtml(m.priority || 'normal') + '</span>' +
            '<span class="pill">' + escapeHtml(m.type || '?') + '</span>' +
            '<span class="msg-subject"> ' + escapeHtml(m.subject || '(no subject)') + '</span>' +
            '<div class="msg-meta">' + escapeHtml(m.from || '?') + ' → ' + escapeHtml(m.to || '?') + ' · ' + fmtTime(m.timestamp) + (m.completed ? ' · ✓ completed' : '') + task + '</div>' +
            preview +
          '</div>';
        }).join('');

    // Clients
    const cs = detail.clients || [];
    el('drawer-clients').innerHTML = cs.length === 0
      ? '<tr><td colspan="3" class="empty">No clients for this project.</td></tr>'
      : cs.map((c) =>
          '<tr>' +
            '<td><code>' + escapeHtml(shortId(c.clientId)) + '</code></td>' +
            '<td>' + escapeHtml(c.kind) + '</td>' +
            '<td>' + fmtTime(c.lastSeenAt) + '</td>' +
          '</tr>'
        ).join('');
  }

  function wireProjectLinks() {
    const links = document.querySelectorAll('a.project-link');
    links.forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const pid = a.getAttribute('data-project') || '';
        openProject(pid);
      };
    });
  }

  el('drawer-close').onclick = closeProject;
  el('drawer-backdrop').onclick = closeProject;
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeProject();
  });

  // Respond to browser back/forward to switch projects.
  window.addEventListener('popstate', () => {
    const pid = parseInitialProject();
    if (pid) {
      if (pid !== currentDetailProjectId) openProject(pid);
    } else if (currentDetailProjectId) {
      closeProject();
    }
  });

  // Open drawer automatically if URL has ?project=ID or #projectId.
  const initialProject = parseInitialProject();
  if (initialProject) openProject(initialProject);

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws/browser');
    ws.onopen = () => {
      led.className = 'hq-led live';
      connText.innerHTML = '<span class="hq-led live"></span>Connected to HQ';
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hq.snapshot') applySnapshot(msg.snapshot);
        else if (msg.type === 'hq.event') handleHqEvent(msg.event);
      } catch {}
    };
    ws.onclose = () => {
      led.className = 'hq-led dead';
      connText.innerHTML = '<span class="hq-led dead"></span>Disconnected — reconnecting…';
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  }

  // ---------- Live mailbox event feed ----------

  function handleHqEvent(event) {
    if (!event || event.type !== 'mailbox.event') return;
    const projectId = event.projectId;
    if (!projectId) return;
    const list = eventFeeds.get(projectId) || [];
    list.unshift(event); // newest first
    if (list.length > FEED_MAX) list.length = FEED_MAX;
    eventFeeds.set(projectId, list);

    // Only re-render if the open drawer matches this project's id.
    if (projectId === currentDetailProjectId) {
      renderEventFeed(list);
      flashFeedStatus();
    }
  }

  function renderEventFeed(list) {
    const elFeed = el('drawer-event-feed');
    if (!elFeed) return;
    if (!list || list.length === 0) {
      elFeed.innerHTML = '<p class="empty">No mailbox events yet for this project.</p>';
      return;
    }
    elFeed.innerHTML = list.map((evt) => {
      const p = evt.payload || {};
      const action = escapeHtml(p.action || '?');
      let detail = '';
      if (p.summary) detail = escapeHtml(p.summary);
      else if (p.message) detail = escapeHtml((p.message.subject || '(no subject)') + ' · ' + (p.message.from || '?') + ' → ' + (p.message.to || '?'));
      else if (p.agent) detail = escapeHtml((p.agent.name || p.agent.agentId || '?') + ' (' + (p.agent.status || '?') + ')');
      else detail = '<em>no detail</em>';
      const mailboxShort = p.mailboxId ? ' · ' + escapeHtml(shortId(p.mailboxId)) : '';
      return '<div class="feed-row">' +
        '<span class="feed-action ' + action + '">' + action + '</span>' +
        '<span>' + detail + '</span>' +
        '<div class="feed-meta">' + fmtTime(evt.timestamp) + mailboxShort + '</div>' +
      '</div>';
    }).join('');
  }

  function clearEventFeed(projectId) {
    eventFeeds.delete(projectId);
  }

  function flashFeedStatus() {
    const status = el('feed-status');
    if (!status) return;
    status.textContent = '(live)';
    status.className = 'feed-status live';
    if (feedIdleTimer) clearTimeout(feedIdleTimer);
    feedIdleTimer = setTimeout(() => {
      status.textContent = '(idle)';
      status.className = 'feed-status';
      feedIdleTimer = null;
    }, 1500);
  }

  connect();
</script>
</body>
</html>`;

export function startHqServer(options: HqServerOptions = {}): Promise<HqServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = resolveHqDataDir(options.dataDir);

  // Load the operator-configured auth file (best-effort — never fail
  // startup over a missing or corrupt auth.json). The redaction policy
  // override, if present, tightens whatever publishers declare.
  return readHqAuthFile(dataDir, {
    warn: (msg: string) => console.warn(JSON.stringify({ level: 'warn', event: 'hq.auth_load_failed', message: msg, timestamp: new Date().toISOString() })),
  }).then((authFile: HqAuthFile) => startHqServerWithAuth(options, host, port, dataDir, authFile));
}

function startHqServerWithAuth(
  options: HqServerOptions,
  host: string,
  port: number,
  dataDir: string,
  authFile: HqAuthFile,
): Promise<HqServerHandle> {
  // Operator override merges over the default; publisher claims are
  // clamped against this at broadcast time (see scrubAndTruncateHqPreview
  // call sites + the welcome handshake redactionPolicy field).
  // Mutable: the file-watcher below refreshes these on auth.json change
  // (Phase 4 live reload).
  const mutableAuth: {
    operatorPolicy: HqRedactionPolicy;
    browserTokens: Set<string>;
    clientTokens: Set<string>;
  } = {
    operatorPolicy: {
      ...DEFAULT_HQ_REDACTION_POLICY,
      ...(authFile.redactionPolicy ?? {}),
    },
    browserTokens: new Set((authFile.browserTokens ?? []).map((t) => t.token)),
    clientTokens: new Set((authFile.clientTokens ?? []).map((t) => t.token)),
  };

  // Surface the resolved data directory + whether an operator override
  // is in effect. Helps the operator confirm `--data-dir` took hold.
  console.warn(JSON.stringify({
    level: 'info',
    event: 'hq.startup',
    message: 'WrongStack HQ starting',
    dataDir,
    host,
    port,
    operatorPolicyActive: authFile.redactionPolicy !== undefined,
    browserTokenMode: mutableAuth.browserTokens.size > 0,
    clientTokenMode: mutableAuth.clientTokens.size > 0,
    timestamp: new Date().toISOString(),
  }));
  void options;

  return new Promise((resolve, reject) => {
    const clients = new Map<WebSocket, ConnectedClient>();
    const browsers = new Set<WebSocket>();
    const eventLog: HqEventEnvelope[] = [];

    const httpServer: HttpServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HQ_HTML);
        return;
      }

      if (url.pathname === '/api/snapshot') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildSnapshot(clients)));
        return;
      }

      if (url.pathname.startsWith('/api/projects/')) {
        const projectId = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'projectId is required' } }),
          );
          return;
        }
        const detail = buildProjectDetail(clients, projectId);
        if (!detail) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detail));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const pathname = url.pathname;

      if (pathname !== '/ws/client' && pathname !== '/ws/browser') {
        socket.destroy();
        return;
      }

      // Token mode: each channel checks its own allowlist. Browser and
      // client tokens are separate — a browser-only token cannot be
      // replayed on /ws/client and vice versa. OPEN MODE for a channel
      // when its token set is empty (backwards compatible).
      const tokenSet = pathname === '/ws/browser' ? mutableAuth.browserTokens : mutableAuth.clientTokens;
      if (tokenSet.size > 0) {
        const supplied = url.searchParams.get('token') ?? '';
        if (!supplied || !tokenSet.has(supplied)) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Content-Type: application/json\r\n' +
              'Connection: close\r\n' +
              '\r\n' +
              JSON.stringify({
                error: {
                  code: 'INVALID_TOKEN',
                  message: `A valid ?token= is required for ${pathname} connections in token mode.`,
                },
              }),
          );
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, pathname);
      });
    });

    wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, pathname: string) => {
      if (pathname === '/ws/browser') {
        handleBrowser(ws, clients, browsers);
      } else {
        handleClient(ws, clients, browsers, eventLog, mutableAuth.operatorPolicy);
      }
    });

    // Phase 4 — live reload of auth.json. The watcher re-reads the file on
    // change and atomically swaps the in-memory token sets + operator policy.
    // No active connections are dropped; subsequent upgrades and broadcasts
    // see the new state immediately.
    const authWatcher = watchHqAuthFile(
      dataDir,
      (next) => {
        mutableAuth.operatorPolicy = {
          ...DEFAULT_HQ_REDACTION_POLICY,
          ...(next.redactionPolicy ?? {}),
        };
        mutableAuth.browserTokens = new Set((next.browserTokens ?? []).map((t) => t.token));
        mutableAuth.clientTokens = new Set((next.clientTokens ?? []).map((t) => t.token));
        console.warn(JSON.stringify({
          level: 'info',
          event: 'hq.auth.reloaded',
          message: 'HQ auth.json reloaded',
          browserTokenCount: mutableAuth.browserTokens.size,
          clientTokenCount: mutableAuth.clientTokens.size,
          timestamp: new Date().toISOString(),
        }));
      },
      {
        warn: (msg) => console.warn(JSON.stringify({
          level: 'warn',
          event: 'hq.auth.reload_failed',
          message: msg,
          timestamp: new Date().toISOString(),
        })),
      },
    );

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !options.strictPort) {
        httpServer.listen(port + 1, host);
      } else {
        reject(err);
      }
    };

    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;

      console.log(`WrongStack HQ listening on http://${host}:${actualPort}`);
      console.log(`Client endpoint:  ws://${host}:${actualPort}/ws/client`);
      console.log(`Browser endpoint: http://${host}:${actualPort}`);

      resolve({
        host,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            authWatcher.close();
            for (const ws of browsers) ws.close(1001, 'HQ shutting down');
            for (const ws of clients.keys()) ws.close(1001, 'HQ shutting down');
            wss.close();
            httpServer.close(() => res());
          }),
      });
    });
  });
}

function handleBrowser(
  ws: WebSocket,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
): void {
  browsers.add(ws);

  const snapshotMsg: HqBrowserMessage = { type: 'hq.snapshot', snapshot: buildSnapshot(clients) };
  ws.send(JSON.stringify(snapshotMsg));

  ws.on('close', () => {
    browsers.delete(ws);
  });
}

function handleClient(
  ws: WebSocket,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  eventLog: HqEventEnvelope[],
  operatorPolicy: HqRedactionPolicy,
): void {
  let registered = false;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const raw =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data
          : new TextDecoder().decode(data as ArrayBuffer);
    const parsed = parseHqFrame(raw);
    if (!parsed.ok) {
      // RFC 6455 §7.4.1: 1003 = invalid payload (not processable),
      // 1008 = policy violation (unknown type or malformed shape).
      const code = parsed.reason === 'invalid-json' ? 1003 : 1008;
      ws.close(code, `invalid frame: ${parsed.reason}`);
      return;
    }
    const frame = parsed.frame;

    if (frame.type === 'client.hello') {
      const payload = frame.payload;
      if (payload.protocolVersion !== HQ_PROTOCOL_VERSION) {
        ws.close(1008, 'protocol version mismatch');
        return;
      }

      const client: ConnectedClient = {
        ws,
        clientId: payload.client.clientId,
        projectId: payload.project.projectId,
        kind: payload.client.kind,
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ...(payload.client.hostname ? { hostname: payload.client.hostname } : {}),
        ...(payload.client.pid ? { pid: payload.client.pid } : {}),
        ...(payload.client.version ? { version: payload.client.version } : {}),
        capabilities: payload.capabilities,
        mailboxes: new Map(),
      };
      clients.set(ws, client);
      registered = true;

      // Phase 1 server-to-client acknowledgement: the client learns which
      // capabilities the server accepted and the active redaction policy.
      // Phase 2 will also use this socket to push `HqServerCommandBatchMessage`
      // frames via `client.command_poll`, but for now the welcome is a
      // one-shot handshake reply with no command queue attached.
      const welcome: HqWelcomePayload = {
        type: 'hq.welcome',
        protocolVersion: HQ_PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        acceptedCapabilities: payload.capabilities,
        // The operator-configured override (from <dataDir>/auth.json) wins
        // over the default. The client learns the *effective* policy.
        redactionPolicy: operatorPolicy,
      };
      ws.send(JSON.stringify(welcome));

      const event: HqEventEnvelope = {
        id: randomUUID(),
        type: 'client.hello',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
        clientId: payload.client.clientId,
        projectId: payload.project.projectId,
        seq: 0,
        payload: { client: payload.client, project: payload.project },
      };
      eventLog.push(event);
      if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
      broadcastSnapshot(clients, browsers);
      broadcastEvent(event, browsers);
      return;
    }

    if (!registered) return;

    if (frame.type === 'client.event') {
      const event = frame.event;
      const client = clients.get(ws);
      if (client) client.lastSeenAt = new Date().toISOString();

      // Mailbox snapshots are authoritative rollups — adopt them into the
      // per-client mailbox map and re-broadcast the global snapshot so the
      // browser counters reflect the latest rollup. We validate the
      // payload via `parseHqEventPayload` so a malformed snapshot cannot
      // poison the per-client mailbox map; other event types are not
      // validated yet and pass through unchanged.
      if (event.type === 'mailbox.snapshot' && client !== undefined) {
        const payloadResult = parseHqEventPayload(event.type, event.payload);
        if (payloadResult.ok) {
          const payload = payloadResult.payload as HqMailboxSnapshotPayload;
          client.mailboxes.set(payload.mailboxId, payload);
          eventLog.push(event);
          if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
          broadcastSnapshot(clients, browsers);
          broadcastEvent(event, browsers);
          return;
        }
        // Malformed mailbox.snapshot: drop without logging or broadcasting so
        // it cannot poison the per-client mailbox map.
        return;
      }

      // Mailbox events are transient — validate the payload so a malformed
      // envelope cannot leak garbage to the browser live feed, and scrub +
      // truncate the optional `summary` preview so unbounded or secret-laden
      // text is sanitized before being stored in the event log and
      // broadcast to browsers.
      if (event.type === 'mailbox.event') {
        const payloadResult = parseHqEventPayload(event.type, event.payload);
        if (!payloadResult.ok) {
          return;
        }
        const payload = payloadResult.payload as HqMailboxEventPayload;
        const sanitizedSummary = scrubAndTruncateHqPreview(payload.summary, 280);
        const sanitizedEvent =
          sanitizedSummary === undefined
            ? event
            : { ...event, payload: { ...payload, summary: sanitizedSummary } };
        eventLog.push(sanitizedEvent);
        if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
        broadcastEvent(sanitizedEvent, browsers);
        return;
      }

      // Other event types pass through unchanged.
      eventLog.push(event);
      if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
      broadcastEvent(event, browsers);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastSnapshot(clients, browsers);
  });
}

function buildSnapshot(clients: Map<WebSocket, ConnectedClient>): HqSnapshot {
  const now = new Date().toISOString();
  const clientRecords: HqClientRecord[] = [];
  const projectMap = new Map<string, HqProjectRecord>();
  // Mailbox summaries are keyed by (projectId, mailboxId) so a project with
  // multiple mailboxes still shows each separately, but the global rollup
  // dedupes by mailboxId across clients.
  const mailboxSummaries: HqMailboxSummary[] = [];

  for (const client of clients.values()) {
    clientRecords.push({
      clientId: client.clientId,
      kind: client.kind as HqClientRecord['kind'],
      machineId: '',
      ...(client.hostname ? { hostname: client.hostname } : {}),
      ...(client.pid ? { pid: client.pid } : {}),
      ...(client.version ? { version: client.version } : {}),
      connected: true,
      connectedAt: client.connectedAt,
      lastSeenAt: client.lastSeenAt,
      projectId: client.projectId,
      capabilities: client.capabilities as readonly HqClientCapability[],
    });

    let project = projectMap.get(client.projectId);
    if (!project) {
      project = {
        projectId: client.projectId,
        projectName: client.projectId,
        projectRootDisplay: '',
        machineIds: [],
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: now,
        status: 'active',
      };
      projectMap.set(client.projectId, project);
    }
    project.activeClients++;

    for (const snapshot of client.mailboxes.values()) {
      mailboxSummaries.push({
        mailboxId: snapshot.mailboxId,
        projectId: client.projectId,
        scope: snapshot.scope,
        messageCount: snapshot.totals.messages,
        unreadCount: snapshot.totals.unread,
        incompleteCount: snapshot.totals.incomplete,
        highPriorityCount: snapshot.totals.highPriority,
        onlineAgentCount: snapshot.totals.onlineAgents,
        lastActivityAt: now,
      });
    }
  }

  const projects = Array.from(projectMap.values());
  const totals = computeTotals({
    projects: projects.length,
    clients: clientRecords.length,
    mailboxes: mailboxSummaries,
  });
  return {
    generatedAt: now,
    clients: clientRecords,
    projects,
    sessions: [],
    fleets: [],
    mailboxes: mailboxSummaries,
    totals,
  };
}

function computeTotals(input: {
  projects: number;
  clients: number;
  mailboxes: readonly HqMailboxSummary[];
}): HqSnapshot['totals'] {
  let unread = 0;
  let incomplete = 0;
  for (const m of input.mailboxes) {
    unread += m.unreadCount;
    incomplete += m.incompleteCount;
  }
  return {
    activeProjects: input.projects,
    activeClients: input.clients,
    activeSessions: 0,
    activeSubagents: 0,
    unreadMailboxMessages: unread,
    incompleteMailboxMessages: incomplete,
    totalCostUsd: 0,
  };
}

interface ProjectDetail {
  generatedAt: string;
  project: HqProjectRecord;
  clients: readonly HqClientRecord[];
  mailboxes: readonly HqMailboxSnapshotPayload[];
}

function buildProjectDetail(
  clients: Map<WebSocket, ConnectedClient>,
  projectId: string,
): ProjectDetail | null {
  const projectClients: ConnectedClient[] = [];
  for (const c of clients.values()) {
    if (c.projectId === projectId) projectClients.push(c);
  }
  if (projectClients.length === 0) return null;

  const now = new Date().toISOString();
  const clientRecords: HqClientRecord[] = projectClients.map((c) => ({
    clientId: c.clientId,
    kind: c.kind as HqClientRecord['kind'],
    machineId: '',
    ...(c.hostname ? { hostname: c.hostname } : {}),
    ...(c.pid ? { pid: c.pid } : {}),
    ...(c.version ? { version: c.version } : {}),
    connected: true,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    projectId: c.projectId,
    capabilities: c.capabilities as readonly HqClientCapability[],
  }));

  const mailboxPayloads: HqMailboxSnapshotPayload[] = [];
  let latestActivity = now;
  for (const c of projectClients) {
    for (const snap of c.mailboxes.values()) {
      mailboxPayloads.push(snap);
      if (snap.totals.messages > 0) latestActivity = now;
    }
  }

  const project: HqProjectRecord = {
    projectId,
    projectName: projectId,
    projectRootDisplay: '',
    machineIds: [],
    activeClients: projectClients.length,
    activeSessions: 0,
    activeSubagents: 0,
    totalCostUsd: 0,
    lastActivityAt: latestActivity,
    status: 'active',
  };

  return {
    generatedAt: now,
    project,
    clients: clientRecords,
    mailboxes: mailboxPayloads,
  };
}

function broadcastSnapshot(
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
): void {
  const snapshot = buildSnapshot(clients);
  const msg: HqBrowserMessage = { type: 'hq.snapshot', snapshot };
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastEvent(event: HqEventEnvelope, browsers: Set<WebSocket>): void {
  const msg: HqBrowserMessage = { type: 'hq.event', event };
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
