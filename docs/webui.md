# Web UI

The Web UI (`@wrongstack/webui`) is a React + Radix + Tailwind frontend backed by
a Node `ws` server that drives the same agent kernel as the CLI and TUI.

There are **two ways** to run it, and they differ in one important way — whether a
terminal REPL shares the browser's agent:

| Launch | Terminal REPL | Browser UI | Agent |
|---|---|---|---|
| `webui` (standalone binary) | — | ✅ | boots its **own** agent for the cwd |
| `wrongstack --webui` | ✅ | ✅ | **same** live agent/session as the terminal |

Use the standalone binary for a pure browser experience; use `wrongstack --webui`
when you want to drive one session from both the terminal and the browser at once
(handy for pair-programming or watching tool output in a richer view).

## Ports

The Web UI listens on **two** ports:

| Port | Env var | Default | Purpose |
|---|---|---|---|
| HTTP | `PORT` | `3456` | serves the built React app (`index.html` + assets) |
| WebSocket | `WS_PORT` | `3457` | the agent backend (messages, tool stream, provider/key mgmt) |

Bind host is `WS_HOST` (default `127.0.0.1`). On loopback the server also listens on
the IPv6 loopback `::1` for the same WS port, so browsers that resolve `localhost`
to IPv6 first don't flap. Set `WS_HOST=0.0.0.0` to expose on the LAN (this also
requires the auth token for non-loopback clients — see Security).

The frontend learns the **real** WS port from a `<meta name="wrongstack-ws-port">`
tag the HTTP server injects into the served HTML — it is *not* hardcoded. This is
what makes multiple instances work.

### Running multiple instances

Both ports **auto-advance** to the next free port if the requested one is taken, so
you can start several instances without picking ports by hand:

```bash
cd /path/A && webui            # → http 3456 / ws 3457
cd /path/B && webui            # → http 3458 / ws 3459 (auto)
cd /path/C && webui            # → http 3460 / ws 3461 (auto)
```

Each instance:

- serves HTML stamped with **its own** WS port, so the browser dials the right backend;
- boots against its own `cwd` (project-scoped sessions/goal/config);
- registers itself in the instance registry (below).

To pin ports instead (e.g. behind a reverse proxy), set them explicitly and disable
auto-advance:

```bash
PORT=8080 WS_PORT=8081 WEBUI_STRICT_PORT=1 webui   # fail loudly if 8080/8081 are taken
```

## Running-instance registry

Every live instance records itself in **`~/.wrongstack/webui-instances.json`** so you
can see which ports are open for which project:

```jsonc
{
  "version": 1,
  "instances": [
    { "pid": 12345, "httpPort": 3456, "wsPort": 3457, "host": "127.0.0.1",
      "projectRoot": "/path/A", "projectName": "A",
      "startedAt": "2026-06-05T09:12:00.000Z", "url": "http://127.0.0.1:3456" }
  ]
}
```

List them without booting a server:

```bash
webui --list      # or: webui ls / webui -l
```

```
Running WebUI instances (2):

  • http://127.0.0.1:3456  ·  ws:3457  ·  pid 12345
      project: A  (/path/A)
      since:   2026-06-05T09:12:00.000Z
  • http://127.0.0.1:3458  ·  ws:3459  ·  pid 23456
      project: B  (/path/B)
      since:   2026-06-05T09:14:30.000Z
```

The registry is **self-healing**: every register/unregister/list prunes entries whose
PID is no longer alive, so a crashed instance that never unregistered is cleaned up on
the next call. Writes are atomic. Instances launched via `wrongstack --webui` appear in
the same registry as standalone ones.

## CLI flags & env vars

| Flag (CLI `--webui`) | Standalone equiv. | Effect |
|---|---|---|
| `--webui` | `webui` | start the server |
| `--port <n>` | `WS_PORT=<n>` | WebSocket port (HTTP auto-resolves) |
| `--open` | `webui --open` / `WEBUI_OPEN=1` | open the browser after the server is ready |
| — | `webui --list` | print running instances and exit |

| Env var | Default | Effect |
|---|---|---|
| `PORT` | `3456` | HTTP port |
| `WS_PORT` | `3457` | WebSocket port |
| `WS_HOST` | `127.0.0.1` | bind host (`0.0.0.0` for LAN) |
| `WEBUI_STRICT_PORT` | unset | `1` disables port auto-advance (fail on conflict) |
| `WEBUI_OPEN` | unset | `1` opens the browser on start (standalone) |

## Security

- The server binds loopback by default. **Loopback** clients connect without a token.
- A random per-process **auth token** is generated and sent to the page via the
  `session.start` payload; **non-loopback** clients (e.g. when `WS_HOST=0.0.0.0`) must
  present it as `?token=…`.
- DNS-rebinding defense: the WS upgrade rejects non-loopback `Host` headers; the HTTP
  responses set a strict CSP whose `connect-src` only allows the loopback WS port.
- Inbound WS frames are size-capped and per-connection rate-limited.

## UI surfaces

- **Theme** — a segmented Light / Dark / System toggle lives in the chat header
  (`ThemeToggle`). The design system ("Engineering Instrument Deck": IBM Plex
  type, warm-graphite/​warm-paper surfaces, signal-amber accent, status LEDs) is
  defined entirely with HSL CSS variables in `src/index.css`, so both modes stay
  in lockstep. The sidebar brand plate carries a live connection LED.
- **Plan / todos** — the sidebar renders the backend's live `todos.updated`
  snapshot as a progress rail (amber while a task is in flight, green at 100%)
  with the in-progress task highlighted.
- **Live fleet roster** (`FleetPanel`) — during a multi-agent run the leader's
  spawned subagents appear as a collapsible strip of cards above the chat, each
  showing the nickname, model, live `L{iter} · {tools} tools · ${cost}` counters,
  current tool, a context-fill bar, self-extension count, and terminal
  status/error. It's driven by a `subagent.event` WS stream that **both** servers
  (standalone `startWebUI` and CLI-embedded `runWebUI`) flatten from the kernel's
  `subagent.*` catalog (spawn → task → per-tool → periodic summary → completion)
  and reduced in `useFleetStore`. The panel self-hides when no fleet is running,
  so solo sessions are unaffected.

## Internals (for contributors)

- Standalone server: `packages/webui/src/server/index.ts` (`startWebUI`) + `entry.ts` (bin).
- CLI-embedded server: `packages/cli/src/webui-server.ts` (`runWebUI`) — reuses the
  webui package's `createHttpServer`, `findFreePort`, `openBrowser`, and the instance
  registry via the `@wrongstack/webui/server` export so the static-serve / port / meta
  injection logic lives in one place.
- Static serve + WS-port `<meta>` injection + CSP: `packages/webui/src/server/http-server.ts`.
- Free-port discovery: `port-utils.ts`. Instance registry: `instance-registry.ts`.
  Browser opener: `open-browser.ts`. Frontend WS-URL resolution: `src/lib/ws-client.ts`.
