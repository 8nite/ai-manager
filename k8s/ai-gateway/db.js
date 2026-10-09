// k8s/opencode-auth/db.js — JSON-file device & session registry
// Persistence: one JSON file, atomic writes via temp+rename. No native deps.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "registry.json");

const DEFAULT = {
  // Server-side state
  rpId: process.env.RP_ID || "ai-manager.nexvision.cc",
  rpName: process.env.RP_NAME || "AI Manager Gateway",
  // Pending: {id, token (used once at /register?token=...), name, createdAt, expiresAt}
  // Pending devices are created when admin runs `pending-token create` (or
  // for tunnel: `tunnel-token create`). They become a real device only after
  // `pending approve <id>`. For WebAuthn the device entry stores the passkey
  // credential; for tunnel clients there is no credential, just a token.
  pending: [],
  devices: [],   // {id, name, credentials: [{id, publicKey, counter, transports}], createdAt, approvedAt, userAgent, tunnelId?}
  sessions: [],  // {id, deviceId, createdAt, lastSeenAt, expiresAt, userAgent, ip}
  tunnels: [],   // {id, name, token, createdAt, lastConnectedAt, lastSeenAt}
};

let cache = null;
let writeQueue = Promise.resolve();

// Read the file from disk every time. The file is tiny (<10 KB even for
// thousands of devices/sessions) and the admin CLI runs in a separate
// process (kubectl exec) — any in-memory cache would go stale on every
// admin operation. If perf ever becomes a concern, swap this for a proper
// database; for our scale, sync fs.readFileSync on every operation is fine.
function load() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      // Fill in any missing top-level keys (forward-compat with older files)
      for (const k of Object.keys(DEFAULT)) {
        if (!(k in parsed)) parsed[k] = DEFAULT[k];
      }
      cache = parsed;
      return cache;
    }
    cache = JSON.parse(JSON.stringify(DEFAULT));
    save();
    return cache;
  } catch (e) {
    console.error("[db] load failed, starting fresh:", e.message);
    cache = cache || JSON.parse(JSON.stringify(DEFAULT));
    return cache;
  }
}

function save() {
  // Synchronous write — the file is tiny (a few KB) and the admin CLI needs
  // to see the write on disk before it returns. The previous async design
  // was a footgun: callers assumed the write was durable when createX()
  // returned, but it was still queued.
  const tmp = DATA_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("[db] save failed:", e.message);
    throw e;
  }
}

function get() { return load(); }

function update(fn) {
  // Re-read from disk so we don't overwrite admin CLI writes made between
  // our last read and now. Then apply the mutation and save.
  const c = load();
  fn(c);
  return save();
}

function uuid() { return crypto.randomUUID(); }
function randToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function now() { return Date.now(); }

// -------- Pending tokens (issued by admin for new device registration) --------
// These are one-time tokens the user receives and pastes into /register?token=...
// Every registration is PENDING on creation; the admin must run
// `pending approve <id>` to enable login. (Pre-2026-06-28 had an autoApprove
// option — removed; auto-approval is no longer a supported path.)
function createPendingToken({ name, ttlMs = 24 * 3600 * 1000, tunnelId = null }) {
  const c = load();
  const p = {
    id: uuid(),
    token: randToken(16),  // 32 hex chars, single-use
    name: name || "device",
    tunnelId,
    createdAt: now(),
    expiresAt: now() + ttlMs,
  };
  c.pending.push(p);
  save();
  return p;
}

function consumePendingToken(token) {
  const c = load();
  const idx = c.pending.findIndex(p => p.token === token);
  if (idx < 0) return null;
  const p = c.pending[idx];
  if (p.expiresAt < now()) return null;
  c.pending.splice(idx, 1);
  save();
  return p;
}

function listPending() { return load().pending.slice(); }

// -------- Devices --------
// A device is a registered browser. It can have one or more passkey credentials
// (most have one, but a user might register multiple browsers for the same device).
function createDevice({ name, credential, userAgent }) {
  const c = load();
  const d = {
    id: uuid(),
    name: name || "device",
    credentials: [credential],
    createdAt: now(),
    approvedAt: now(),         // pending→approved transition: we only create devices after approval
    userAgent: userAgent || "",
  };
  c.devices.push(d);
  save();
  return d;
}

function getDevice(id) { return load().devices.find(d => d.id === id) || null; }
function listDevices() { return load().devices.slice(); }

function revokeDevice(id) {
  return update(c => {
    c.devices = c.devices.filter(d => d.id !== id);
    c.sessions = c.sessions.filter(s => s.deviceId !== id);
  });
}

// Emergency wipe: drop every device (and its passkey credentials), every
// session issued by the gateway, and every unspent pending registration
// token. Tunnel tokens are PRESERVED — they authenticate the local
// machine's outbound WebSocket, not a human user, and killing them
// would also kill the only path that can serve /auth/* until a new
// tunnel reconnects. Use after a security incident (e.g. compromised
// admin credentials) to force every user to re-register under the
// current approval policy.
function revokeAll() {
  return update(c => {
    c.devices = [];
    c.sessions = [];
    c.pending = [];
  });
}

function addCredentialToDevice(deviceId, credential) {
  return update(c => {
    const d = c.devices.find(x => x.id === deviceId);
    if (d) d.credentials.push(credential);
  });
}

// Bind a device to a specific tunnel. The auth-gateway will route that
// device's requests to the named tunnel instead of the first-active fallback.
// Pass null/undefined to clear the binding.
function setDeviceTunnel(deviceId, tunnelId) {
  return update(c => {
    const d = c.devices.find(x => x.id === deviceId);
    if (!d) return;
    if (tunnelId) d.tunnelId = tunnelId;
    else delete d.tunnelId;
  });
}

// -------- Sessions --------
// Long-lived (default 30 days) HttpOnly cookies. Revocable per-session or per-device.
function createSession({ deviceId, userAgent, ip, ttlMs = 30 * 24 * 3600 * 1000 }) {
  const c = load();
  const s = {
    id: randToken(32),  // 64 hex chars
    deviceId,
    createdAt: now(),
    lastSeenAt: now(),
    expiresAt: now() + ttlMs,
    userAgent: userAgent || "",
    ip: ip || "",
  };
  c.sessions.push(s);
  save();
  return s;
}

function getSession(id) {
  const c = load();
  const s = c.sessions.find(x => x.id === id);
  if (!s) return null;
  if (s.expiresAt < now()) return null;
  return s;
}

function touchSession(id) {
  return update(c => {
    const s = c.sessions.find(x => x.id === id);
    if (s) s.lastSeenAt = now();
  });
}

function revokeSession(id) {
  return update(c => { c.sessions = c.sessions.filter(s => s.id !== id); });
}

function listSessions() { return load().sessions.slice(); }

// Cleanup expired sessions (called lazily — sessions are also checked on read)
function gc() {
  return update(c => {
    const t = now();
    c.sessions = c.sessions.filter(s => s.expiresAt > t);
    c.pending = c.pending.filter(p => p.expiresAt > t);
  });
}

// -------- Tunnel tokens --------
// The local tunnel client uses one of these to authenticate the inbound WS.
function createTunnelToken({ name }) {
  const c = load();
  const t = {
    id: uuid(),
    name: name || "tunnel",
    token: randToken(24),  // 48 hex chars
    createdAt: now(),
    lastConnectedAt: 0,
    lastSeenAt: 0,
  };
  c.tunnels.push(t);
  save();
  return t;
}

function getTunnelByToken(token) {
  return load().tunnels.find(t => t.token === token) || null;
}

function listTunnels() { return load().tunnels.slice(); }
function revokeTunnel(id) {
  return update(c => { c.tunnels = c.tunnels.filter(t => t.id !== id); });
}
function markTunnelConnected(id) {
  return update(c => {
    const t = c.tunnels.find(x => x.id === id);
    if (t) t.lastConnectedAt = now();
  });
}
function markTunnelSeen(id) {
  // High-frequency: don't save every time, just touch in memory
  const c = load();
  const t = c.tunnels.find(x => x.id === id);
  if (t) t.lastSeenAt = now();
}

module.exports = {
  load, save, get, update, gc,
  uuid, randToken, now,
  // pending
  createPendingToken, consumePendingToken, listPending,
  // devices
  createDevice, getDevice, listDevices, revokeDevice, revokeAll, addCredentialToDevice, setDeviceTunnel,
  // sessions
  createSession, getSession, touchSession, revokeSession, listSessions,
  // tunnels
  createTunnelToken, getTunnelByToken, listTunnels, revokeTunnel,
  markTunnelConnected, markTunnelSeen,
};
