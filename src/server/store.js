// store.js — JSON persistence for workspaces + session definitions.
// File: $AI_MGR_DATA or ~/.ai-manager/manager.json. Plain object:
//   { workspaces: [{id, path, name, createdAt}], sessions: [{...}] }
// Consoles are ephemeral and intentionally NOT persisted.

const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultPath() {
  if (process.env.AI_MGR_DATA) return process.env.AI_MGR_DATA;
  return path.join(os.homedir(), ".ai-manager", "manager.json");
}

let _file = null;
let _cache = null;

function filePath() {
  if (!_file) _file = defaultPath();
  return _file;
}

function blank() {
  return { workspaces: [], sessions: [] };
}

function readDisk() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const p = JSON.parse(raw);
    const sessions = Array.isArray(p.sessions) ? p.sessions.map(migrateLuminaSession) : [];
    return {
      workspaces: Array.isArray(p.workspaces) ? p.workspaces : [],
      sessions,
    };
  } catch {
    return blank();
  }
}

// One-time migration (lumina → chassis, 2026-11-06): stored lumina records
// point at lumina chat ids/ports that no longer exist. Re-home them onto the
// chassis harness; the next ensure repoints the port and backfills the chat.
// Pure (no disk write here — the next persist converges the file).
function migrateLuminaSession(s) {
  if (!s || s.harness !== "lumina") return s;
  return {
    ...s,
    harness: "chassis",
    mode: "web",
    port: null,
    harnessSessionId: null,
    status: "starting",
    error: null,
    backendPid: null,
  };
}

function writeDisk(data) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const tmp = filePath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filePath());
    return true;
  } catch {
    return false;
  }
}

function cache() {
  if (!_cache) _cache = readDisk();
  return _cache;
}

function persist() {
  writeDisk(cache());
}

// For tests: point the store at a temp file.
function _resetForTest(file) {
  _file = file;
  _cache = null;
}

module.exports = {
  filePath,
  load: () => ({ ...cache() }),
  migrateLuminaSession,
  getWorkspaces: () => cache().workspaces,
  getSessions: () => cache().sessions,
  addWorkspace(w) { cache().workspaces.push(w); persist(); return w; },
  removeWorkspace(id) {
    const c = cache();
    c.workspaces = c.workspaces.filter((w) => w.id !== id);
    const dropped = c.sessions.filter((s) => s.workspaceId === id).map((s) => s.id);
    c.sessions = c.sessions.filter((s) => s.workspaceId !== id);
    persist();
    return dropped;
  },
  addSession(s) { cache().sessions.push(s); persist(); return s; },
  updateSession(id, patch) {
    const all = cache().sessions;
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, id };
    persist();
    return all[i];
  },
  removeSession(id) {
    const c = cache();
    c.sessions = c.sessions.filter((s) => s.id !== id);
    persist();
  },
  _resetForTest,
};
