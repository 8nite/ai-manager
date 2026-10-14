---
name: MEMORY
description: Index of ai-manager durable memory notes
date_modified: 2026-10-09
tags: [index]
links: [[prod-web-testing]], [[opencode-v2-web]], [[manager-proxy-remote]], [[browser-automation]], [[harness-lifecycle]], [[sidebar-rename-race]], [[session-title-sync, [[ui-chrome-cleanup]], [[harness-switch]], [[split-screen]], [[session-switch-cache]], [[attention-dismiss]], [[narrate-mode]], [[sidebar-delete]], [[web-attention]], [[shared-backend]], [[asset-cache]], [[client-nav-switch]]
---

# ai-manager memory index

- [[prod-web-testing]] — prod gateway login via software WebAuthn + browser cookie import.
- [[opencode-v2-web]] — `opencode serve` web UI facts (passwords, routes, CSP, API).
- [[manager-proxy-remote]] — tunnel-proxy fixes (`/api` routing, route shim) + regression tests.
- [[browser-automation]] — agent-browser vs browser-harness on this machine.
- [[harness-lifecycle]] — workspace dedupe, droid resume fallback + auth wall, graceful shutdown.
- [[sidebar-rename-race]] — left-panel rename vs activation render/focus race + e2e dblclick coverage.
- [[session-title-sync]] — backend auto-title pull-back + rename write-through (opencode title agent).
- [[sidebar-delete]] — sidebar minus deletes with no confirm (workspace/bar keeps theirs).
- [[ui-chrome-cleanup]] — removed sessionBar/statusline/shortcut-tip/sidebar-heading; left panel owns session actions; e2e orphan/flake triage.
- [[harness-switch]] — top-bar harness switch owns the new-session default; one-click quickCreateSession, no modal popup.
- [[split-screen]] — main-window split panes (up to 4, persisted); proxy api-scope injection keeps concurrent web iframes on their own backends.
- [[session-switch-cache]] — fast switching: per-pane iframe cache (keep 3) + server liveness cache + respond-before-title-sync; e2e must run serialized on isolated ports.
- [[attention-dismiss]] — attention shelf per-card dismiss × (hide without delete); re-arms next waiting turn / clears on open; e2e must poll post-open (PTY resize redraw reads working ~8s).
- [[narrate-mode]] — top-right Narrate toggle reads session activity aloud (built-in speechSynthesis default; Kokoro-82M documented upgrade, Piper GPL caveat).
- [[web-attention]] — opencode working/waiting via backend polling (`/active` drain + newest-message rules + permission/form override); web-backend adoption across restarts (survive + `tryAdoptBackend`, PID-identical deploys).
- [[shared-backend]] — one `opencode serve` (`HARNESS_BASE-10`, live :4090) hosts all sessions as chats; idle-gated legacy migration, per-port `/active` batching, orphan reclaim.
- [[asset-cache]] — proxy stamps `immutable` year-cache on hashed `/_assets/*` (API untouched); cold switches over the tunnel cost doc + API only. Follow-up: 30s cache for workspace config GETs (`x-aimgr-cache` HIT/MISS), per-session state never cached.
- [[client-nav-switch]] — one live SPA per pane, same-backend switches navigate opencode's router (no reboot); verified nav + fallback, `dataset.sess` is the shown-session truth.
- [[opencode-pty]] — opencode harness runs as a PTY TUI (2026-10-14); web embedding retired, resume by chat id, chat-id backfill, shared-serve retirement, narrate/shelf e2e lessons.
