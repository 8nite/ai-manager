# ai-manager

Local multi-harness AI session manager with a futuristic web UI.

- **Left panel** — workspaces (each = an opened folder) grouping sessions.
  Each workspace group has a **+** button to create new sessions.
- **Main window** — the active harness session. Clicking a session in the
  left panel switches (or resumes) it here.
- **Bottom panel** — consoles (shell in the workspace dir). More panel
  tabs can be added later.

Supported harnesses (v0.1):

| Harness | Backend | How it runs |
|---|---|---|
| `opencode` | web UI | `opencode serve --port <auto>` in the workspace dir, shown in an iframe |
| `dsh` (deepseek-harness) | web UI | `dsh web --port <auto>` (via `npx -y @deepseek-ai/dsh`) in the workspace dir, shown in an iframe |
| `droid` | terminal UI | `droid` PTY in the workspace dir, rendered with xterm.js in the main window |

Remote access works exactly like `opencode.nexvision.cc`: run the tunnel
client on this machine and open `https://ai-manager.nexvision.cc`
(see [Remote access](#remote-access)). Terminal streaming uses SSE+POST
(not raw WebSocket) so it passes through the HTTP-over-WebSocket tunnel.

## Requirements

- Node.js 20+
- `opencode` on `PATH` (for opencode sessions)
- `droid` on `PATH` (for droid sessions)
- For `dsh` sessions: network access to npm (runs `npx -y @deepseek-ai/dsh`),
  plus a DeepSeek API key configured in the dsh web UI (Settings → Models)

## Run locally

```bash
npm install
npm start
# open http://127.0.0.1:4000
```

Env vars:

| Var | Default | Meaning |
|---|---|---|
| `AI_MGR_PORT` | `4000` | manager web UI port |
| `AI_MGR_DATA` | `~/.ai-manager/manager.json` | persistence file |
| `AI_MGR_HARNESS_BASE_PORT` | `4100` | first auto-allocated harness port |
| `OPENCODE_BIN` | `opencode` | opencode binary |
| `DROID_BIN` | `droid` | droid binary (+ `DROID_ARGS`) |
| `DSH_BIN` | `npx` | dsh launcher (+ `DSH_ARGS`, default `-y @deepseek-ai/dsh web`) |
| `AI_MGR_SHELL` | auto | console shell (`powershell.exe` on win32, else `bash`) |

## Remote access

The gateway code lives in `k8s/ai-gateway` (cloned from the
opencode-auth gateway, re-pointed at `ai-manager.nexvision.cc`).

1. Deploy the gateway (one time, needs kubectl + cert-manager + nginx):
   ```bash
   kubectl apply -f k8s/ai-gateway/deploy.yaml
   bash scripts/build-gateway-configmap.sh apply
   ```
2. Create a tunnel token:
   ```bash
   kubectl -n nexvision exec deploy/ai-manager-gateway -- gateway-admin tunnel-token create --name "my-laptop"
   ```
3. Start the tunnel client on this machine:
   ```bash
   TUNNEL_TOKEN=... npm run tunnel
   # or: TUNNEL_TOKEN=... LOCAL_PORT=4000 node scripts/ai-tunnel.js
   ```
4. Register + approve your device (same flow as opencode.nexvision.cc):
   open `https://ai-manager.nexvision.cc/register`, create a passkey, then
   `gateway-admin pending approve <deviceId>` (via kubectl exec as above).

## Autostart on boot (systemd user units)

Units live in `deploy/` (installed to `~/.config/systemd/user/`):

```bash
mkdir -p ~/.ai-manager ~/.config/systemd/user
printf 'TUNNEL_TOKEN=...\n' > ~/.ai-manager/tunnel.env
chmod 600 ~/.ai-manager/tunnel.env
cp deploy/ai-manager.service deploy/ai-manager-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-manager.service ai-manager-tunnel.service
loginctl enable-linger $USER   # keep running after logout
```

`ai-manager-tunnel.service` requires `ai-manager.service`; both restart
automatically. Logs: `journalctl --user -u ai-manager.service`.

## API (v0.1)

- `GET /health` → `{ ok, version, workspaces, sessions, uptime }`
- `GET /api/state` → `{ workspaces, sessions, consoles }`
- `POST /api/workspaces { path }` — open folder as workspace
- `DELETE /api/workspaces/:id` — remove workspace + its sessions
- `POST /api/sessions { workspaceId, harness, title? }`
- `GET /api/sessions`
- `POST /api/sessions/:id/ensure` — restart backend if dead (resume)
- `POST /api/sessions/:id/touch` — mark active (updates lastActiveAt)
- `DELETE /api/sessions/:id`
- `GET /harness/:id/...` — reverse proxy to a web harness backend
- `GET /s/:id/` — focus mode (same proxy, sets active-session cookie so the
  backend's root-absolute assets resolve; used by remote iframes)
- `GET /api/pty/:kind/:id/stream` — SSE terminal output (`kind`: `session|console`)
- `POST /api/pty/:kind/:id/input { data }` — write to terminal
- `POST /api/pty/:kind/:id/resize { cols, rows }`
- `POST /api/consoles { workspaceId }` / `DELETE /api/consoles/:id`

## Layout

```
src/server/  manager HTTP server (express, no build step)
  index.js     wiring: static + api + proxy + pty streams
  store.js     JSON persistence (workspaces + sessions)
  sessions.js  session/console lifecycle + port allocation
  backends.js  harness definitions (opencode web, dsh web, droid pty)
  proxy.js     /harness + /s reverse proxy (http + upgrade)
  pty.js       node-pty pool with backlog + SSE fanout
src/public/  futuristic UI (vanilla JS, xterm.js via CDN)
scripts/     ai-tunnel.js (WS tunnel client), health + gateway scripts
k8s/ai-gateway/  remote gateway (WebAuthn + tunnel multiplex)
tests/       smoke tests (node --test)
```

## Notes / limits (v0.1, honest)

- Web harnesses are iframed per session locally via direct backend ports;
  through the tunnel they go through the `/harness/:id` (or `/s/:id`
  focus-mode) proxy. Only the *active* web session's root-absolute assets
  resolve remotely — concurrent multi-session web UIs over remote are
  best-effort.
- `droid resume`: the manager keeps the PTY alive while the server runs;
  after a server restart (or PTY exit) it respawns with `droid resume --last`
  (most recent session in that folder). Pass an explicit id via a future
  session setting if the folder hosts several droid conversations.
- dsh CLI flags may drift (developer preview); override with
  `DSH_BIN`/`DSH_ARGS` if `dsh web --port` changes upstream.
