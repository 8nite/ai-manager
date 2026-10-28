---
name: opencode-upgrade
description: opencode binary upgrade playbook (slow-CDN parallel fetch, atomic install, deploy verify) + weekly auto-update cron
date_modified: 2026-10-25
tags: [opencode, deploy, cron, upgrade]
links: [[harness-lifecycle]], [[opencode-v2-web]], [[MEMORY]]
---

# opencode binary upgrade playbook (learned 2026-10-23, 2.0.32 → 2.1.4)

- `opencode upgrade` self-updater FAILS here: npm CDN single-stream ~40KB/s, internal downloader times out on ~109MB tarball ("Timed out", retried 2x). Don't loop it.
- Reliable path: 12-thread parallel ranged download of `https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-<ver>.tgz` (require HTTP 206 + exact byte lengths per segment; a non-strict fetch silently corrupts). Verify sha1+sha512 against `https://registry.npmjs.org/@opencode%2fcli-linux-x64/<ver>` metadata, then atomic-rename install (`mv`, NOT `cp` — writing a running binary fails with ETXTBSY "Text file busy"). Back up the old binary first.
- Repo moved `sst/opencode` → `anomalyco/opencode` (GitHub redirects); npm scope migrated `@opencode-ai/*` → `@opencode/*`. CLI 2.x is npm-only (no GitHub release assets). Latest-version source: `https://opencode.ai/update/api/latest/cli/npm` (fast JSON with version + package scope).
- Deploy verify (AGENTS.md two-path): snapshot `ps -eo pid,args | grep '[o]pencode serve'`; `opencode service restart` (respawns on new binary); `systemctl --user restart ai-manager.service`; confirm manager health + `/api/state` all running + web backends adopted with IDENTICAL pids. 2026-10-23 result: 9/9 running, unit 153/153, e2e 0 failures.
- Weekly auto-update cron (Sun 03:00, flock-guarded): `scripts/opencode-auto-update.sh` — version check → unit baseline → upgrade → verify → restart → health → serialized e2e; ANY failure hands off once to `opencode run --model opencode-go/muse-spark-1.3-contributor --auto` with logs (agent path live-tested). Log: `~/.ai-manager/opencode-auto-update.log`. Never edits crontab itself.
- 2026-10-25 lesson: `opencode --version` prints `v2.1.4` (v-prefixed) but the update API returns `2.1.4` — the cron compared them raw, so the up-to-date early-exit never fired and the post-upgrade check failed spuriously ("version still v2.1.4 after upgrade (want 2.1.4)"). Fixed with `${CURRENT#v}` / `${AFTER#v}` / `${LATEST#v}` normalization; regression covered by `tests/opencode-auto-update.test.js`. DRY_RUN=1 now exits "already up to date".
- Orphan check: live manager's environ has NO `AI_MGR_DATA`, while scratch e2e backends carry `AI_MGR_DATA=/tmp/aimgr-e2e.*` — scanning `/proc/<pid>/environ` for that prefix cleanly separates scratch orphans from live backends (all 6 live sessions share the single backend on :4090, see [[shared-backend]]). 2026-10-25: killed 3 stale scratch `opencode serve` orphans (:4440/:4450/:4460, unreferenced by manager.json); live :4090 + all sessions untouched.
- Global standing rules now in opencode settings (`~/.config/opencode/instructions/standing-ops.md`, registered in opencode.json `instructions`): post-deploy auto-spawn regression agent; end-of-conversation memory+graphify background task; free models for background work.
