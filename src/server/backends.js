// backends.js — harness definitions.
//
// Two modes:
//   web: a local HTTP server (opencode/chassis serve) on an auto port,
//        displayed in the main window via iframe (+ reverse proxy).
//   pty: a terminal process (droid/agy TUI) on a node-pty,
//        rendered with xterm.js.
//
// Each web backend: { mode:"web", bin, args(port), waitPath, env }
// Each pty backend: { mode:"pty", bin, args(resumeId?), env }

const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_PORT = parseInt(process.env.AI_MGR_HARNESS_BASE_PORT || "4100", 10);

// Headroom routing for opencode serve backends. Mirrors
// `headroom wrap opencode` layer 1 (native-provider baseURL override via
// OPENCODE_CONFIG_CONTENT) + headroom provider + MCP retrieve tool. The
// transport plugin (layer 2, covers non-Anthropic/OpenAI providers) is added
// when its bundle exists on disk; otherwise layer 1 still routes
// anthropic/openai (the proxy's current --backend anthropic path).
// Opt-out: AI_MGR_HEADROOM_OFF=1 (keeps the server password; an outer
// OPENCODE_CONFIG_CONTENT from process.env then survives).
function headroomProxyPort() {
  const raw = process.env.HEADROOM_PORT || process.env.AI_MGR_HEADROOM_PORT || "8787";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}

function findHeadroomOpencodePlugin() {
  // Headroom >=0.43 ships the opencode transport plugin as a directory
  // (`.../providers/opencode/_dist/` with `index.js`; OpenCode 2.x loads
  // local plugins from a directory). Older headroom shipped a single
  // `entry.opencode.js` file (1.x); accept either, preferring the dir.
  const override = (process.env.HEADROOM_OPENCODE_PLUGIN_PATH || "").trim();
  if (override) {
    try {
      const st = fs.statSync(override);
      if (st.isDirectory()) return override;
      if (st.isFile()) return path.dirname(override); // 1.x-style file → its dir
    } catch { /* fall through to omit */ }
    return null;
  }
  try {
    const libDir = path.join(os.homedir(), ".local/share/uv/tools/headroom-ai/lib");
    for (const entry of fs.readdirSync(libDir)) {
      if (!entry.startsWith("python3")) continue;
      const base = path.join(
        libDir, entry, "site-packages/headroom/providers/opencode");
      try {
        const dist = path.join(base, "_dist");
        if (fs.statSync(dist).isDirectory()
          && fs.existsSync(path.join(dist, "index.js"))) return dist;
      } catch { /* try legacy file */ }
      try {
        const legacy = path.join(base, "_dist", "entry.opencode.js");
        if (fs.statSync(legacy).isFile()) return path.dirname(legacy);
      } catch { /* try next */ }
    }
  } catch { /* headroom not installed → no plugin */ }
  return null;
}

function headroomOpencodeConfig(port) {
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const config = {
    provider: {
      anthropic: { options: { baseURL } },
      openai: { options: { baseURL } },
      headroom: {
        npm: "@ai-sdk/openai-compatible",
        name: "Headroom Proxy",
        options: { baseURL },
        models: {
          "gpt-4o": { name: "GPT-4o", limit: { context: 128000, output: 16384 } },
          "gpt-4.1": { name: "GPT-4.1", limit: { context: 1048576, output: 32768 } },
        },
      },
    },
  };
  if (process.env.AI_MGR_HEADROOM_NO_MCP !== "1") {
    config.mcp = {
      headroom: { type: "local", command: ["headroom", "mcp", "serve"], enabled: true },
    };
  }
  const plugin = findHeadroomOpencodePlugin();
  if (plugin) config.plugin = [plugin];
  return config;
}

function headroomOpencodeEnv() {
  if (process.env.AI_MGR_HEADROOM_OFF === "1") return {};
  const port = headroomProxyPort();
  const config = headroomOpencodeConfig(port);
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  if (config.plugin) env.HEADROOM_PROXY_URL = `http://127.0.0.1:${port}`;
  return env;
}

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
    // Plus Headroom routing (OPENCODE_CONFIG_CONTENT) so backend LLM calls
    // compress via the local proxy; OFF with AI_MGR_HEADROOM_OFF=1.
    env: () => {
      let env = {};
      try {
        env = { OPENCODE_SERVER_PASSWORD: require("./opencodeAuth").getPassword() };
      } catch {
        env = {};
      }
      return { ...env, ...headroomOpencodeEnv() };
    },
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
  chassis: {
    label: "chassis",
    mode: "web",
    bin: () => process.env.CHASSIS_BIN || "chassis",
    args: (port) => ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    waitPath: "/",
    // Stable manager-held password so the iframe auto-connects without a
    // manual server picker. Proxy injects it upstream (see proxy.js).
    // ponytail: single shared secret, not per-session — rotation = restart.
    env: () => {
      try {
        return { CHASSIS_SERVER_PASSWORD: require("./chassisAuth").getPassword() };
      } catch {
        return {};
      }
    },
  },
  agy: {
    label: "agy",
    mode: "pty",
    // Antigravity CLI (`agy`) interactive TUI in a PTY (xterm.js), like droid.
    // Default model is flash-high tier; override with AGY_MODEL.
    // Full argv override via AGY_BIN / AGY_ARGS.
    // Resume: `--conversation <id>` when we know the harness conversation id,
    // else `--continue` (global most-recent — see ptyArgsFor) or plain `agy`.
    // ponytail: no exit-fallback like droid — a bad --conversation id degrades
    // to a fresh session with a warning instead of exiting (verified live).
    bin: () => process.env.AGY_BIN || "agy",
    args: (resumeId) => {
      if (process.env.AGY_ARGS) return process.env.AGY_ARGS.split(" ").filter(Boolean);
      const a = ["--model", process.env.AGY_MODEL || "gemini-3.8-flash-high"];
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

module.exports = { HARNESSES, harnessNames, getHarness, BASE_PORT, headroomOpencodeEnv, headroomOpencodeConfig, headroomProxyPort };
