---
name: harness2-local
description: harness2 running locally on installed opencode binary + current session model, no Google services (2026-10-24)
date_modified: 2026-10-24
tags: [harness2, opencode, opencode-go, recursion, no-vertex]
links: [[opencode-v2-web]], [[harness-lifecycle]], [[MEMORY]]
---

# harness2 local (no Google)

Upstream `google-research/harness2` assumes a pinned bun checkout
(`dependencies/opencode` @ v1.14.18), `HARNESS2_SOLVER_MODEL` env, and Vertex
(`gcloud`, `GOOGLE_CLOUD_PROJECT`) for solver/improver/judge. Patch
`scripts/harness2-opencode-go.patch` (reapply: `git apply` in a fresh clone)
removes all three requirements:

- `config.py`: `_current_session_model()` reads `~/.config/opencode/opencode.json`
  `"model"` as the default; explicit `HARNESS2_*` env still wins. `JUDGE_MODEL`
  defaults to the solver (was `""`). Verified: all three resolve to
  `opencode-go/muse-spark-1.3-contributor` with no env set. `validate_models`
  already skips Vertex unless the id starts with `google-vertex`.
- `core/proposer.py`: `_opencode_dir_or_none()` delegates to `_opencode_dir()`
  (keeps the isolation test's patch point working); when no checkout exists the
  installed `opencode run --standalone --model M#effort --format json` is used
  (v2 CLI has no `--dir`/`--variant`; cwd isolates, effort folds into `#`).
  XDG stays sandboxed on the bun path; the installed path shares user XDG
  (provider auth + server socket) with `--standalone` — copying `auth.json`
  into isolated XDG still 401s (`Go requires a credential`), and isolated
  `XDG_STATE_HOME` breaks the background-service link.
- `substrate/opencode.py`: `run_argv` emits the installed-binary argv when no
  checkout is present; `preflight` accepts either runtime.

## Verified 2026-10-24

- `python -m pytest tests/ -q`: 5 passed, 2 subtests passed.
- `python -m harness2.cli.demo --output runs/demo --k 1 --mode parallel`: 2/2 ok.
- Live `Proposer(ChannelSpec('opencode', <solver>)).call(...)`: `ok True`
  against `opencode-go/muse-spark-1.3-contributor`, no `GOOGLE_*` set.
- Install-binary sessions share the user `opencode.db` (visible in session
  history); FS fence is still `OPENCODE_PERMISSION` per run.

## Caveats

- `/tmp/opencode/harness2` is scratch (lost on reboot); the patch file is the
  durable artifact.
- Probe dirs under `/tmp` must never keep copied `auth.json` (credential
  hygiene) — removed after verification.
- **opencode v2 resolves its workspace from `$PWD`, not the process cwd**
  (2026-10-24): `subprocess.run(cwd=...)` alone stranded every harness2
  session in the parent dir — solver rollouts survived via absolute task
  paths, all improver sessions missed `MISSION.md` and kept base. Both
  launch sites (`scripts/harness2_local.py` `execute`, patched
  `proposer.py` installed-binary branch) now set `env["PWD"]`.
- XDG isolation breaks provider auth (`Go requires a credential` even with
  copied `auth.json`) and the background-service link — installed binary
  shares user XDG + `--standalone` (isolation-test patch point preserved
  for the bun path).

## First local adaptation (2026-10-24, k=1 agg, both tasks ok)

- `scripts/harness2_local.py`: thin `BenchmarkAdapter` over
  `harness2-tasks/<domain>/<id>/` (PROMPT.md + inputs/ + CHECKS.json),
  deterministic file/content scoring (no judge model), base harness
  exported from live opencode config (systemprompt, guardrails + trigger
  lines via `autotrigger`, 3 full skills + index, docs-manager subagent,
  `scripts/gmail_app.py` at root for the cross-skill doc ref), library at
  `harness2-work/library/` (gitignored), runs under `harness2-work/runs/`.
- nightly-brief/brief-1: INV kept base with evidence; DOM proposed a real
  `skills/nightly-brief/SKILL.md` + `calc_brief.py`, probed it; AGG
  composer dropped both (base already correct) → adopted base. Honest
  compose, not rubber-stamping.
- trading-review/ledger-1: all KEEP_BASE, base delivered correct summary.
- Scores: 5/5 and 7/7 (one CHECKS needle fixed: `77580` → `77,580`,
  prompt asks for thousands separators — check bug, not deliverable bug).
- Library empty by upstream design: k=1 selection is trivial (single
  final, no selector session) so no evidence-supported lesson is stored.
  k=2 would yield multi-final selection + library entries (~2x calls).
- Next step (not done): thin judge via `harness2-judge` on the namespace.

## Auto-use on new sessions (2026-10-24, shipped, default off)

- `scripts/harness2_local.py --promote <domain> [--task id]`: copies the
  run's chosen tree to `harness2-work/promoted/<domain>/tree/` (+`base/` and
  `PROMOTED.json` with fingerprint, score, model, time). Verified: both
  domains promoted (5/5, 7/7).
- `src/server/harnessOverlay.js` + hook in `startSession`
  (`src/server/sessions.js`): workspace opt-in via `<ws>/.ai-manager-harness`
  containing the domain name. Stages the adopted-minus-base delta as a
  marked block in `<ws>/AGENTS.md` (never overwrites user content;
  byte-identical removal; refresh on re-promote; cleans up when the marker
  goes away). No marker = untouched. `AI_MGR_HARNESS_OVERLAY=0` kills it.
  Best-effort everywhere: session bootstrap never throws because of it.
- Grounded in a live probe: workspaces all have their own `AGENTS.md`
  (hence append-block, not write), and project-local `skills/` are NOT
  picked up by opencode — so promoted skills are flattened into the block.
- Overlay is a natural no-op today (adopted == base → empty delta).
- Gate: unit 161/0 (8 new `tests/harnessOverlay.test.js`), deploy restart
  with PID-identical backend adoption, standing-ops e2e gate exit 0.
