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
    return {
      workspaces: Array.isArray(p.workspaces) ? p.workspaces : [],
      sessions: Array.isArray(p.sessions) ? p.sessions : [],
    };
  } catch {
    return blank();
  }
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
