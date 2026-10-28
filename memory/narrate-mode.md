---
name: narrate-mode
description: Narrate-mode toggle reads session activity aloud via built-in speechSynthesis; Kokoro-82M is the documented upgrade path; autoplay-gate hardening 2026-10-12
date_modified: 2026-10-12
tags: [frontend, tts, narration, app.js, app.css, index.html]
links: [[harness-switch]], [[attention-dismiss]], [[session-switch-cache]]
---

# Narrate mode (session activity read aloud)

Shipped 2026-10-12: a `Narrate` toggle in the top-right (`#btnNarrate`,
after `#harnessSwitch`, before `#btnNewSessionTop`) that reads session
activity aloud as it happens. `aria-pressed` + `.on` reflect state; pick
persists to `localStorage` (`ai-manager.narrate`) and survives reload.

## Engine choice (voice research, Oct 2026)

Default is the browser's built-in Web Speech API (`speechSynthesis` +
`SpeechSynthesisUtterance`): zero bytes, ~50ms first audio, no key, no
server, works locally and through the tunnel. Voice auto-pick prefers
natural English voices (Google US English, Samantha, Zira, Aria) with
graceful fallback to any `en-*` then default voice.

Higher-starred GitHub TTS options were evaluated and deliberately NOT
shipped — all need a model download + sidecar/worker for what are mostly
short status lines:

- `coqui-ai/TTS` ~46k stars (XTTS v2, 16 langs, <200ms streaming) — heavy
  Python server, overkill for status narration.
- `2noise/ChatTTS` ~40k (dialogue EN+ZH), `fishaudio/fish-speech` ~31k,
  `resemble-ai/chatterbox` ~27k MIT (Nano 110M, 3x realtime on CPU).
- `hexgrad/Kokoro-82M` (Apache-2.0 weights, ~82MB, `kokoro-js` WebGPU,
  `af_heart`-class narrator voices, 1–3s/paragraph on desktop) is the
  documented UPGRADE path for a premium narrator voice, with Piper-WASM
  (30–60MB/voice, CPU-offline, 904 voices) as the non-GPU/mobile fallback.
  Note: upstream `rhasspy/piper` archived Oct 2025 → `OHF-Voice/piper1-gpl`
  (GPL-3.0 via espeak-ng) — license-check before bundling Piper.

Upgrade seam: keep `setNarrate` / `narrateTransitions` /
`maybeNarratePty` call sites; replace only `speak()` +
`pickNarrateVoice()` internals (both marked in `app.js` + `app.css`).

## What gets spoken

- Session transitions from the 8s `/api/state` poll (`narrateTransitions()`
  in `refresh()`): `waiting` → "<title> needs your input", `working` /
  `running` → "is working", `finished` → "finished", new session → "New
  <harness> session". Max 2 utterances per poll, joined; priority path
  cancels pending chatter. First poll only seeds `prevActivity` (no
  backlog burst on load/enable).
- Live PTY output (`maybeNarratePty`, hooked in `attachPaneTerm`
  `es.onmessage`): last substantive line only (stripped of ANSI/OSC +
  markdown noise, min 24 chars, capped `NARRATE_MAX_CHARS=180`), global
  30s throttle, never interrupts (`speaking||pending` → skip). Web
  (opencode) sessions are iframed — transitions only, no inside-view text.
- Enabling speaks "Narrate mode on" (user gesture unlocks autoplay);
  disabling cancels silently. Everything guards missing `speechSynthesis`
  (headless-safe).

## Autoplay gate + observability (follow-up 2026-10-12)

Debug finding: the engine + voices can be fine while nothing is heard.
Chrome gates `speechSynthesis` behind user activation — speech queued with
no gesture yet fails with an utterance `error: not-allowed` (verified
headless: synthetic `b.click()` → `not-allowed`, no audio; a real trusted
click → `start` → `end`). The first version dropped that failure silently,
which reads as "narrate does nothing".

Hardening in `app.js` (all covered by `tests/narrate.test.js` + e2e):

- `speak()` calls `synth.resume()` first (unsticks paused Chrome) and tags
  every utterance with `onstart`/`onerror`. Own-`cancel()` preemptions
  (`canceled`/`interrupted`) are ignored; real failures set
  `narrate.lastError` and repaint the toggle (amber `.err` + tooltip naming
  the block, e.g. `Narrate blocked (not-allowed) — click anywhere, then
  toggle off and on`). Next successful `onstart` clears it.
- `not-allowed` stashes the text in `narrate.retry`; a one-time
  capture-phase `pointerdown`/`keydown` listener (`installNarrateGestureFlush`)
  replays it on the user's next real gesture (verified: error → trusted
  click → `everSpoke: true`, clean toggle).
- `paintNarrateButton()` owns all toggle visuals; init paints once so a
  speech-less browser gets a disabled toggle ("no speech engine") instead
  of a dead button. `setNarrate(true)` clears stale errors; reload restores
  ON silently with a fresh speech context (pre-reload block does not leak).
- `window.__narrateDiag()` → `{ on, supported, voices, speaking, pending,
  paused, lastError, retryQueued, everSpoke, lastSpokeAt }` for console or
  `agent-browser eval` diagnosis.
- E2E asserts the whole arc headlessly: synthetic on → `not-allowed` +
  retry + err class; reload → clean toggle; reset off. Unit 117/117, e2e 0
  failures.

Triage tip when a user hears nothing: run `__narrateDiag()` in devtools.
`voices: 0` → OS/browser has no speech engine (common on bare Linux —
install speech-dispatcher/espeak or use a Chrome with Google voices);
`lastError: not-allowed` + `retryQueued: true` → click anywhere and it
replays; `everSpoke: true` + still silent → system volume/output device.
`queue` / `pendingChars` / `lastContent` show the live pipeline;
`webObservedId` names the transcript under watch (null = PTY or idle).

## Live content narration (follow-up 2026-10-12)

The narrator now reads the focused session's feedback as it updates, not
just transitions. Design (all in `app.js`, engine-agnostic):

- Feed: PTY chunks arrive via `maybeNarratePty` (SSE hook in
  `attachPaneTerm`); web sessions feed via `MutationObserver` on the
  focused iframe's transcript (`observeFrameForNarration` — opencode
  renders messages as plain same-origin DOM under `div[id^="message-"]`;
  virtualization means only live text is present, which is exactly what
  narration wants). Mutations inside `textarea`/`input`/`contenteditable`
  are skipped so keystrokes are never read back; tool-chrome rows
  ("Used N …"), prompts, spinners, and short fragments are filtered by
  `isNoiseLine`.
- Buffer → sentences: `narrateFeed` appends (focused session only;
  background sessions get transitions, never content — one audio stream),
  `flushNarrateContent()` (called on the 8s `refresh()` tick) splits the
  paused buffer via `splitIntoSentences` (punctuation + line aware, word
  trims flushed fragments, 240-char cap) into a capped queue (5, drop
  oldest — live > complete).
- Pump: `pumpNarrateQueue` speaks sequentially; `speak()` takes an `onDone`
  fired exactly once per utterance (end or error) that pumps the next.
  Priority alerts (transitions, toggle confirmation) clear the queue first.
  Focus/pane/session switches call `observeActivePane()` (re-targets the
  observer, clears stale content); `purgeSessionFrames` stops the observer
  for deleted sessions.
- Verified live: synthetic feed → buffer → flush → spoken (`lastContent`),
  background feed ignored; opencode iframe load → `webObservedId` set and
  real transcript sentences (`"Muse Spark 1.3 Contributor"`) flowed through
  the queue unprompted. E2E covers the arc with a live scratch opencode
  session (feed gating, buffer, spoken `lastContent`, queue cap, observer
  re-target after reload). Unit 121/121, e2e 0 failures (25 narrate asserts).

## Tail-word fix (follow-up 2026-10-12)

User report: "no idea what the narrator is saying". Root cause in
`splitIntoSentences` (`app.js`): the final part without terminal
punctuation had its last word stripped (`replace(/\S+$/, "")`) on the
assumption it was a mid-word streaming fragment. But `flushNarrateContent`
only runs after a 4s pause, so the buffer is settled text — every
title/status/final sentence arrived truncated ("needs your input" →
"needs your", "fix any issues" → "fix any"). Verified with a local
STT round-trip (espeak-ng synth → faster-whisper transcribe): truncated
tails transcribe as dangling fragments, whole sentences transcribe clean.

Fix: speak the final part whole; noise filtering (prompts, fragments,
non-Latin lines an English voice can't read) unchanged. Covered by a
unit regression test (`tests/narrate.test.js`: last word kept,
multi-sentence tails whole, noise still dropped; unit 128/128) and a new
e2e assert ("splitter keeps unpunctuated tail whole"; e2e 0 failures).

## Guards

- `tests/narrate.test.js` (11 tests: toggle placement/label/aria, engine
  fns + persist keys, transition strings + seed-once, queue contract +
  SSE hook, splitter/noise/observer wiring, Kokoro default + fallback +
  diag fields). Unit 121/121.
- `scripts/e2e-web-defaults.sh` "narrate toggle speaks session activity":
  toggle + persist + reload, autoplay-gate arc, neural-default + lazy
  asserts, splitter cases, focused-feed gating + spoken `lastContent` +
  queue cap, transcript-observer re-target after reload. E2E 0 failures
  (`MGR_PORT=4002 HARNESS_BASE=4470`; 4450 held by a live backend —
  scratch `allocPort` would adopt it, per [[session-switch-cache]]).

Related: [[harness-switch]] (same topbar surface), [[attention-dismiss]]
(waiting = the highest-value utterance), [[session-switch-cache]]
(e2e port discipline).
