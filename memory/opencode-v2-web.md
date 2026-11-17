---
name: opencode-v2-web
description: opencode serve (v2.0.x) web UI behavior facts learned 2026-10-09
date_modified: 2026-11-10
tags: [opencode, web-ui, spa-router, csp, auth, headroom]
links: [[manager-proxy-remote]], [[prod-web-testing]], [[shared-backend]]
---

# opencode serve web UI facts (v2.0.25/26)

- `opencode serve --hostname 127.0.0.1 --port <p>` prints `server password <43ch>`
  on stdout on every start (password rotates per spawn). ai-manager pipes it with
  a `[sess_id]` prefix, but the prefix is **lost on interleaved chunks** after mass
  restores — ambiguous mapping. Restarting one session via Ensure prints a clean line.
- Pairing links (`opencode pair --url …`) are single-use, 5-min expiry, and bind to
  the background service — not valid for per-session `serve` instances. Use password flow.
- Client route table (from bundle `Jo()`): valid cold-boot pathnames are `/`,
  `/settings`, `/connect`, `/new-session`, `/server/<key>/session/<id>`.
  **Any other pathname cold-boots to `Error: Unrecognised route!`**
  (e.g. `/s/<id>/`, `/session/<id>` singular).
- Client calls root-absolute API incl. `GET /api/event` (SSE, 401 pre-auth).
  Response CSP e.g. `script-src 'self' 'wasm-unsafe-eval' 'sha256-…'` — inline
  scripts need a hash appended to execute.
- Default model in fresh web UI was `Muse Spark 1.3 Contributor`
  (`opencode-go/muse-spark-1.3-contributor`).
- Model picker (2026-10-09, via proxied UI): opens, lists models, current
  checked. Attempted switch to `GLM-5.3-Flash` closed the menu but did not
  stick (button still showed Muse Spark) — retry before reporting upstream.
- Auth (v2.0.26, verified with curl): `serve` honors `OPENCODE_SERVER_PASSWORD`
  (Basic `opencode:<pw>` → `GET /api/info` 200); unset → random per-process
  password (journal shows distinct `server password …` per backend) and all
  API → 401. Pairing links bind to the background service only, not per-session
  `serve` instances.
- Session binding API: `POST /api/session {location: {directory}, title?}` →
  `{data: {id: ses_…}}` with correct `projectID` (no UI needed);
  `GET /api/session/<id>` verifies (404 = gone). Projects are **global** across
  `serve` backends (shared DB `~/.local/share/opencode`), so every fresh web UI
  shows the project picker — pre-create the chat to skip it (see
  [[manager-proxy-remote]] §4).
- Backend serves its SPA shell (200 text/html) at deep routes
  `/server/<base64url(server-base-url)>/session/<sesId>`; observed keys are
  unpadded base64url of the browser-visible origin
  (e.g. `http://127.0.0.1:4000`, `https://ai-manager.nexvision.cc`).
- Message send API (v2.2.6, verified with curl 2026-11-10):
  `POST /api/session/<id>/prompt {"providerID","modelID","text"}` → 200
  `{data: {id: msg_…}}`. `POST …/message` 404s (that path is GET-only list);
  `POST …/prompt` with `parts[]` body 400s (`Missing key at ["text"]`).
- Headroom routing for serve backends (2026-11-10, `src/server/backends.js`):
  opencode `env()` injects `OPENCODE_CONFIG_CONTENT` mirroring
  `headroom wrap opencode` layer 1 (native anthropic/openai `baseURL` →
  `http://127.0.0.1:<port>/v1`, `headroom` provider entry, `mcp.headroom`
  retrieve server) plus `HEADROOM_PROXY_URL` when the transport-plugin bundle
  exists on disk. Verified live: backend `environ` carries it and opencode
  spawns `headroom mcp serve` from it. Knobs: `AI_MGR_HEADROOM_OFF=1`
  disables (outer `OPENCODE_CONFIG_CONTENT` then survives);
  port = `HEADROOM_PORT` || `AI_MGR_HEADROOM_PORT` || 8787.
- Headroom traffic gap (2026-11-10): the default `opencode-go` provider
  bypasses the proxy — layer 1 covers only anthropic/openai, and the
  transport plugin (headroom-verified for opencode 1.17/1.18.5) shows zero
  interception on opencode v2.2.6 (`ss -tnp` during a turn: direct TLS to
  Cloudflare 443s, proxy log gains no `POST /v1/*`, `headroom savings`
  stays zero). Installed headroom 0.35.0 vs latest 0.43.1 — update first,
  then re-probe; if still bypassed, the `opencode-go` upstream needs the
  `--openai-api-url` treatment (see headroom docs `opencode-deepseek`).
  Probe recipe: scratch manager on free ports + repetitive `data.json` +
  one prompt + `ss -tnp | grep <backend pid>` peer capture.
- RESOLVED (2026-11-10): headroom 0.43.1's plugin is 2.x-native (dir +
  `index.js`, verified to opencode 2.0.12). After upgrade + proxy restart +
  `backends.js` dir-format fix + shared-backend respawn, probe turns flow
  `POST /v1/responses` → 200 through the proxy (log moved to
  `~/.headroom/logs/proxy-8787.log`), `headroom savings` records opencode
  client events, and the model answers correctly (300 entries). Live
  sessions route too — ~80 opencode calls / ~94k tokens saved in the first
  half hour. 0.35.0-era `entry.opencode.js` file path is dead; don't use it.
- E2E log lesson (2026-11-10): `/tmp/opencode/` was wiped externally
  mid-run, taking the e2e log with it. E2E logs now go to repo
  `.e2e-rerun.log` (`*.log` is gitignored). Rerun: 100 PASS, same 6 FAILs
  (rename/title/row UI sections — untouched by backend-env changes), then
  terminated mid-split-screen by external SIGTERM; needs a clean-room rerun.
- Headroom 0.35.0 → 0.43.1 update (2026-11-10): no `uv` or `pip` on the box —
  bootstrapped via the tool venv's own python
  (`.../tools/headroom-ai/bin/python3 -m ensurepip`, then
  `pip install --upgrade 'headroom-ai[all]'`). 0.43.x ships the opencode
  transport plugin as a **directory** (`_dist/` + `index.js`, OpenCode 2.x
  style; verified to 2.0.12) instead of the 1.x `entry.opencode.js` file —
  `backends.js` resolves either. Proxy restarted via
  `headroom install restart` (ignorable `openclaw not found in PATH` scope
  error; proxy itself restarts fine).
- Top chrome DOM (2026-10-10, from live proxied UI): the in-chat session
  header is `<div data-session-title="" class="pointer-events-none sticky top-0
  z-30 w-full pb-4">` containing the `opencode · <ws>` title (`h1
  [data-slot="session-title-child"]`), More-options / context-usage /
  session-details buttons. Hidden in embedded views via
  `div[data-session-title]{display:none!important}` (see
  [[manager-proxy-remote]] §9); hook is the stable `data-session-title` attr,
  not hashed classes. The older `header[data-slot="titlebar-v2"]` selector is
  kept alongside for backward compat.
