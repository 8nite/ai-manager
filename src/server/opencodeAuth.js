// opencodeAuth.js — shared secret for per-session `opencode serve` backends.
//
// v2 `opencode serve` mandates HTTP Basic auth (auto-generates a random
// password per process when OPENCODE_SERVER_PASSWORD is unset). Random
// passwords break the manager iframe (401 + manual server picker).
//
// Fix: run every opencode backend with a single stable manager-held password,
// and have the reverse proxy inject `Authorization: Basic ...` upstream.
// The browser never sees the secret; manager listens on 127.0.0.1 only and
// remote access is gated by the tunnel gateway.
//
// Resolution order:
//   1. $AI_MGR_OPENCODE_PASSWORD (explicit manager override)
//   2. ~/.ai-manager/opencode-password (generated once, chmod 600)
// NOTE: deliberately ignores $OPENCODE_SERVER_PASSWORD — that var is set
// inside opencode-hosted shells to the *outer* server's per-process password.
// Reusing it would couple backend auth to whatever session spawned the
// manager and flip secrets across restarts. Backends are still launched
// *with* OPENCODE_SERVER_PASSWORD=<manager secret> (see backends.js).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let _cached = null;

function passwordFile() {
  if (process.env.AI_MGR_OPENCODE_PASSWORD_FILE) return process.env.AI_MGR_OPENCODE_PASSWORD_FILE;
  return path.join(os.homedir(), ".ai-manager", "opencode-password");
}

function getPassword() {
  if (_cached) return _cached;
  const envPw = process.env.AI_MGR_OPENCODE_PASSWORD;
  if (envPw) {
    _cached = envPw;
    return _cached;
  }
  const file = passwordFile();
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      _cached = raw;
      return _cached;
    }
  } catch {}
  const fresh = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh + "\n", { mode: 0x180 });
    try { fs.chmodSync(file, 0x180); } catch {}
  } catch {}
  _cached = fresh;
  return _cached;
}

function authHeader() {
  return "Basic " + Buffer.from("opencode:" + getPassword(), "utf8").toString("base64");
}

// For tests: drop the in-memory cache.
function _resetForTest() {
  _cached = null;
}

module.exports = { getPassword, authHeader, passwordFile, _resetForTest };
