---
name: ui-version-pin-restart
description: UI version bump needs a service restart to change the immutable asset pin (2026-11-16)
date_modified: 2026-11-16
tags: [ai-manager, ui, deploy, caching]
links: [[asset-cache]], [[ui-chrome-cleanup]], [[prod-web-testing]]
---

# Frontend version bump requires a restart to take effect

`src/server/index.js` caches `VERSION = require("../../package.json").version`
at boot. `managerIndexHtml()` re-reads `index.html` on mtime change but stamps
the **boot-time** VERSION into `__AI_MGR_VERSION__`. So a CSS/JS-only change
with a `package.json` version bump does NOT change the live `?v=` pin until the
service restarts.

## Consequence

Without restart, new `index.html` still references `app.css?v=<old>`, which is
served `maxAge 1y, immutable` — stale tabs keep the old bundle. This is the
exception to AGENTS.md's "UI-only: no restart": if you bumped the version to
defeat stale caches, you must restart for the bump to matter.

## Verify after restart

```
curl -s :4000/ | grep -oE 'app\.(js|css)\?v=[^"]*'   # new version
curl -s :4000/app.css?v=<new> | grep -c <marker>       # new bytes
```

Restart uses `KillMode=process`: snapshot `ps ... | grep '[o]pencode serve'`
pre/post to confirm backend PIDs unchanged (adopted, not respawned).
