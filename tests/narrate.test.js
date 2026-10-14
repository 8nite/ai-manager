// tests/narrate.test.js — narrate mode: toggle button speaks session activity
// aloud via the built-in Web Speech API (default engine; Kokoro-82M is the
// documented upgrade path). Static contract: button + narrator module + hooks.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.css"), "utf8");

test("narrate: top bar carries a narrate toggle before New Session", () => {
  assert.ok(html.includes('id="btnNarrate"'), "missing #btnNarrate");
  const topRight = html.indexOf('class="top-right"');
  const nb = html.indexOf('id="btnNarrate"');
  const btn = html.indexOf('id="btnNewSessionTop"');
  assert.ok(topRight !== -1 && nb > topRight && btn > nb, "narrate toggle must sit top-right, before New Session");
  assert.ok(html.includes('aria-pressed="false"'), "toggle must expose aria-pressed");
  assert.ok(/id="btnNarrate"[\s\S]*?Narrate/.test(html), "toggle must be labelled Narrate");
});

test("narrate: frontend narrator engine (Web Speech API default)", () => {
  for (const fn of ["setNarrate", "isNarrateOn", "speak", "pickNarrateVoice",
    "cleanForSpeech", "narrateTransitions", "maybeNarratePty"]) {
    assert.ok(js.includes(fn), `missing ${fn}`);
  }
  assert.ok(js.includes("ai-manager.narrate"), "narrate pick must persist to localStorage");
  assert.ok(js.includes("speechSynthesis"), "narrator must use the built-in speechSynthesis engine");
  assert.ok(js.includes("SpeechSynthesisUtterance"), "narrator must speak via SpeechSynthesisUtterance");
  assert.ok(js.includes("btnNarrate"), "toggle button must be wired");
  assert.ok(js.includes("NARRATE_KEY"), "persist key constant missing");
});

test("narrate: transitions announced, first poll only seeds", () => {
  assert.ok(js.includes("needs your input"), "waiting transition must announce needs-input");
  assert.ok(js.includes("is working"), "working transition must announce");
  assert.ok(js.includes("finished"), "finished transition must announce");
  assert.ok(/seeded/.test(js), "first poll must seed silently (no backlog burst)");
  assert.ok(/refresh[\s\S]*?narrateTransitions\(\)/.test(js) || js.includes("narrateTransitions();"),
    "refresh() must diff transitions each poll");
});

test("narrate: live PTY speech is queued + hooked to the pane stream", () => {
  for (const fn of ["narrateFeed", "flushNarrateContent", "pumpNarrateQueue",
    "clearNarrateContent", "splitIntoSentences", "isNoiseLine", "engineBusy"]) {
    assert.ok(js.includes(fn), `missing ${fn}`);
  }
  assert.ok(js.includes("maybeNarratePty(sessionId, msg.data)"), "pane SSE stream must feed the narrator");
  assert.ok(js.includes("NARRATE_QUEUE_N"), "sentence queue must be capped (live > complete)");
  assert.ok(js.includes("NARRATE_FLUSH_MS"), "buffer must flush after a pause in updates");
  assert.ok(js.includes("NARRATE_SENT_MAX"), "utterances must be length-capped");
});

test("narrate: toggle styled with an on-state", () => {
  assert.ok(css.includes(".narrate-btn"), "missing .narrate-btn style");
  assert.ok(css.includes(".narrate-btn.on"), "missing narrate on-state style");
});

test("narrate: engine errors surface instead of failing silently", () => {
  for (const fn of ["paintNarrateButton", "installNarrateGestureFlush", "__narrateDiag"]) {
    assert.ok(js.includes(fn), `missing ${fn}`);
  }
  assert.ok(js.includes("lastError"), "utterance errors must be recorded");
  assert.ok(js.includes("not-allowed"), "autoplay gate must be handled explicitly");
  assert.ok(js.includes("narrate.retry"), "blocked speech must be retried on next gesture");
  assert.ok(js.includes("synth.resume()"), "speak must resume a paused engine first");
  assert.ok(css.includes(".narrate-btn.err"), "missing blocked-error style");
});

test("narrate: toggle disables itself when the browser has no speech engine", () => {
  assert.ok(/paintNarrateButton\(\); \/\/ marks the toggle disabled/.test(js) ||
    js.includes("has no speech engine"), "unsupported browsers must disable the toggle");
});

test("narrate: Kokoro neural voice is the default engine, system is fallback", () => {
  for (const fn of ["getNarrateEngine", "getNarrateVoice", "__narrateSetEngine",
    "ensureKokoro", "speakKokoro", "speakSystem", "stopKokoroAudio"]) {
    assert.ok(js.includes(fn), `missing ${fn}`);
  }
  assert.ok(js.includes("ai-manager.narrateEngine"), "engine pick must persist");
  assert.ok(js.includes("onnx-community/Kokoro-82M-v1.0-ONNX"), "must pin the Kokoro model");
  assert.ok(js.includes("kokoro-js@"), "CDN import must be version-pinned");
  assert.ok(js.includes('"af_heart"'), "default voice must be af_heart (grade A)");
  // Lazy singleton: no ~90MB download until the first utterance.
  assert.ok(js.includes("kokoroLoad"), "model load must be a singleton promise");
  assert.ok(/kokoroState = "loading"/.test(js), "loading state must repaint the toggle");
  // Failure anywhere on the neural path falls back to system speech.
  assert.ok(js.includes("kokoroFailed"), "Kokoro failure must route to system fallback");
  assert.ok(js.includes("toBlob()"), "generated audio must play via blob URL");
  assert.ok(js.includes('toggle("loading"') && css.includes(".narrate-btn.loading"),
    "loading state must repaint the toggle + needs a style");
});

test("narrate: diag reports the engine", () => {
  assert.ok(/engine: getNarrateEngine\(\)/.test(js), "diag must report the engine pick");
  assert.ok(js.includes("kokoro: narrate.kokoroState"), "diag must report Kokoro state");
  assert.ok(js.includes("voice: getNarrateVoice()"), "diag must report the voice");
  assert.ok(js.includes("kokoroError"), "Kokoro load/generate errors must be captured for diag");
  assert.ok(js.includes("kokoroDevice"), "diag must report which backend won");
});

test("narrate: Kokoro tries WebGPU then falls back to WASM", () => {
  assert.ok(js.includes('["webgpu", "wasm"]'), "must try WebGPU first, WASM second");
});

test("narrate: focused web transcript is observed, background is not", () => {
  for (const fn of ["observeFrameForNarration", "observeActivePane", "stopWebNarration",
    "insideEditable", "focusedSessionId"]) {
    assert.ok(js.includes(fn), `missing ${fn}`);
  }
  assert.ok(js.includes("MutationObserver"), "web narration must observe transcript mutations");
  assert.ok(js.includes("contentDocument"), "observer must read the same-origin frame document");
  assert.ok(js.includes("webObservedId"), "diag must report the observed session");
});

test("narrate: splitter speaks the final phrase whole (no last-word amputation)", () => {
  // Regression: the splitter dropped the last word of any final part without
  // terminal punctuation ("needs your input" -> "needs your"), so every
  // title/status/final sentence arrived truncated and unintelligible (STT
  // round-trip verified: truncated tails transcribe as dangling fragments).
  const vm = require("vm");
  const start = (name) => {
    const i = js.indexOf(`function ${name}`);
    assert.ok(i !== -1, `missing ${name} source`);
    return i;
  };
  const end = (from, names) => {
    const cuts = names.map((n) => js.indexOf(`function ${n}`, from)).filter((i) => i > from);
    return cuts.length ? Math.min(...cuts) : js.length;
  };
  const src = [
    js.match(/const NARRATE_SENT_MAX = \d+;/)?.[0] || "const NARRATE_SENT_MAX = 240;",
    js.match(/const NARRATE_PENDING_CAP = \d+;/)?.[0] || "const NARRATE_PENDING_CAP = 4000;",
    js.slice(start("cleanForSpeech"), end(start("cleanForSpeech"), ["isNoiseLine"])),
    js.slice(start("isNoiseLine"), end(start("isNoiseLine"), ["splitIntoSentences"])),
    js.slice(start("splitIntoSentences"), end(start("splitIntoSentences"), ["pickNarrateVoice"])),
  ].join("\n");
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(`${src}; globalThis.__n = { splitIntoSentences, isNoiseLine };`, sb);
  const { splitIntoSentences, isNoiseLine } = sb.__n;
  // NB: vm-realm arrays fail deepStrictEqual across realms — compare via JSON.
  const split = (x) => JSON.stringify(splitIntoSentences(x));
  // Final phrase without terminal punctuation keeps its last word.
  assert.strictEqual(
    split("sess 9cd16e403822 needs your input"),
    JSON.stringify(["sess 9cd16e403822 needs your input"]));
  assert.strictEqual(
    split("help to test the switching session seems very slow, fix any issues"),
    JSON.stringify(["help to test the switching session seems very slow, fix any issues"]));
  // Multi-sentence input: every sentence whole, including the unpunctuated tail.
  assert.strictEqual(
    split("The migration finished in twelve seconds. All three replicas are healthy now"),
    JSON.stringify(["The migration finished in twelve seconds.", "All three replicas are healthy now"]));
  // Noise contract unchanged: prompts, fragments, non-Latin lines still dropped.
  assert.ok(isNoiseLine("$ kubectl get pods"));
  assert.ok(isNoiseLine("ok"));
  assert.strictEqual(split("$ kubectl get pods"), "[]");
  assert.strictEqual(split("ok"), "[]");
});
