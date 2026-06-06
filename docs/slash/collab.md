# /collab - Live Collaboration Helpers

Shows operator-side information for the WebUI live-collaboration feature. The
CLI does not run the WebSocket observer client itself; it prints status,
invite links, recent session history, and saved annotations for the current
session.

## Usage

| Command | Effect |
|---|---|
| `/collab` | Show collaboration status |
| `/collab status` | Same as `/collab` |
| `/collab invite` | Print a WebUI join URL for the current session |
| `/collab history [N]` | Show recent session events; default count is implementation-defined |
| `/collab annotations` | Show saved collaboration annotations |
| `/collab notes` | Alias for `annotations` |
| `/collab help` | Show command help |

Observer count is currently best-effort from the CLI side. The WebUI owns the
live participant list.

## Code Reference

- `packages/cli/src/slash-commands/collab.ts`
- `packages/webui/src/server/entry.ts`
- `packages/webui/src/components/CollabPanel.tsx`
