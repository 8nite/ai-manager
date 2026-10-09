// backends.js — harness definitions.
//
// Two modes:
//   web: a local HTTP server (opencode serve / dsh web) on an auto port,
//        displayed in the main window via iframe (+ reverse proxy).
//   pty: an interactive TUI (droid) on a node-pty, rendered with xterm.js.
//
// Each web backend: { mode:"web", bin, args(port), waitPath, env }
// Each pty backend: { mode:"pty", bin, args(resumeId?), env }

const BASE_PORT = parseInt(process.env.AI_MGR_HARNESS_BASE_PORT || "4100", 10);

const HARNESSES = {
  opencode: {
    label: "opencode",
    mode: "web",
    bin: () => process.env.OPENCODE_BIN || "opencode",
    args: (port) => ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    waitPath: "/",
    env: () => ({}),
  },
  dsh: {
    label: "deepseek-harness",
    mode: "web",
    // Default launcher: npx -y @deepseek-ai/dsh web --port <port>.
    // Upstream is in developer preview; if flags drift, override with
    // DSH_BIN / DSH_ARGS (DSH_ARGS supports a {port} placeholder).
    // ponytail: shell-free spawn; DSH_BIN must be a single binary path.
    bin: () => process.env.DSH_BIN || "npx",
    args: (port) => {
      if (process.env.DSH_ARGS) {
        return process.env.DSH_ARGS.split(" ").map((a) => a.replace("{port}", String(port)));
      }
      return ["-y", "@deepseek-ai/dsh", "web", "--port", String(port)];
    },
    waitPath: "/",
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
