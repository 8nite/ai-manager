// backends.js — harness definitions.
//
// Two modes:
//   web: a local HTTP server (opencode serve) on an auto port,
//        displayed in the main window via iframe (+ reverse proxy).
//   pty: a terminal process (droid TUI / dsh headless CLI) on a node-pty,
//        rendered with xterm.js.
//
// Each web backend: { mode:"web", bin, args(port), waitPath, env }
// Each pty backend: { mode:"pty", bin, args(resumeId?, task?), env }

const BASE_PORT = parseInt(process.env.AI_MGR_HARNESS_BASE_PORT || "4100", 10);

const HARNESSES = {
  opencode: {
    label: "opencode",
    mode: "web",
    bin: () => process.env.OPENCODE_BIN || "opencode",
    args: (port) => ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    waitPath: "/",
    // Stable manager-held password so the iframe auto-connects without a
    // manual server picker. Proxy injects it upstream (see proxy.js).
    // ponytail: single shared secret, not per-session — rotation = restart.
    env: () => {
      try {
        return { OPENCODE_SERVER_PASSWORD: require("./opencodeAuth").getPassword() };
      } catch {
        return {};
      }
    },
  },
  dsh: {
    label: "deepseek-harness",
    mode: "pty",
    // CLI mode: one-shot `dsh headless "<goal>"` in a PTY (xterm.js).
    // The session goal/title IS the task; Resume re-runs it. Upstream ships
    // no interactive TUI profile (only web/headless/acp/sdk), so a
    // persistent chat is not possible — this is run-and-read.
    // Full argv override via DSH_BIN / DSH_ARGS (e.g. a custom profile).
    // ponytail: shell-free spawn; DSH_BIN must be a single binary path.
    bin: () => process.env.DSH_BIN || "npx",
    args: (resumeId, task) => {
      if (process.env.DSH_ARGS) return process.env.DSH_ARGS.split(" ").filter(Boolean);
      const a = ["-y", "@deepseek-ai/dsh", "headless"];
      if (resumeId) a.push("--session-id", String(resumeId));
      const t = String(task || "").trim();
      if (t) a.push(t);
      return a;
    },
    env: () => ({}),
  },
  droid: {
    label: "droid",
    mode: "pty",
    bin: () => process.env.DROID_BIN || "droid",
    // Resume: `droid resume <id>` when we know the harness session id,
    // else plain interactive `droid` (shows its own picker on `resume`).
    args: (resumeId) => {
      const extra = (process.env.DROID_ARGS || "").split(" ").filter(Boolean);
      if (resumeId) return ["resume", resumeId, ...extra];
      return [...extra];
    },
    env: () => ({}),
  },
  agy: {
    label: "agy",
    mode: "pty",
    // Antigravity CLI (`agy`) interactive TUI in a PTY (xterm.js), like droid.
    // Default model is the cheap flash-low tier; override with AGY_MODEL.
    // Full argv override via AGY_BIN / AGY_ARGS.
    // Resume: `--conversation <id>` when we know the harness conversation id,
    // else `--continue` (global most-recent — see ptyArgsFor) or plain `agy`.
    // ponytail: no exit-fallback like droid — a bad --conversation id degrades
    // to a fresh session with a warning instead of exiting (verified live).
    bin: () => process.env.AGY_BIN || "agy",
    args: (resumeId) => {
      if (process.env.AGY_ARGS) return process.env.AGY_ARGS.split(" ").filter(Boolean);
      const a = ["--model", process.env.AGY_MODEL || "gemini-3.8-flash-low"];
      if (resumeId) a.push("--conversation", String(resumeId));
      return a;
    },
    env: () => ({}),
  },
};

function harnessNames() {
  return Object.keys(HARNESSES);
}

function getHarness(name) {
  const h = HARNESSES[name];
  if (!h) throw new Error(`unknown harness: ${name}`);
  return h;
}

module.exports = { HARNESSES, harnessNames, getHarness, BASE_PORT };
