---
name: opencode-v2-web
description: opencode serve (v2.0.x) web UI behavior facts learned 2026-10-09
date_modified: 2026-10-10
tags: [opencode, web-ui, spa-router, csp, auth]
links: [[manager-proxy-remote]], [[prod-web-testing]]
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
- Top chrome DOM (2026-10-10, from live proxied UI): the in-chat session
  header is `<div data-session-title="" class="pointer-events-none sticky top-0
  z-30 w-full pb-4">` containing the `opencode · <ws>` title (`h1
  [data-slot="session-title-child"]`), More-options / context-usage /
  session-details buttons. Hidden in embedded views via
  `div[data-session-title]{display:none!important}` (see
  [[manager-proxy-remote]] §9); hook is the stable `data-session-title` attr,
  not hashed classes. The older `header[data-slot="titlebar-v2"]` selector is
  kept alongside for backward compat.
