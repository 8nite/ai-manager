// k8s/opencode-auth/session.js — Express middleware that requires a valid session cookie
const db = require("./db");

function requireSession(req, res, next) {
  // Cookie parser: minimal, since we control the cookie name
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)opencode_sid=([^;]+)/);
  const isApi = req.path.startsWith("/api/");
  if (!m) return deny(req, res, isApi);
  const sid = m[1];
  const session = db.getSession(sid);
  if (!session) return deny(req, res, isApi);
  const device = db.getDevice(session.deviceId);
  if (!device || device.approvedAt === 0) {
    db.revokeSession(sid);
    return deny(req, res, isApi, "device_removed");
  }
  // Touch the session lastSeenAt lazily (no DB write per request; gc handles cleanup)
  req.session = session;
  req.device = device;
  next();
}

// Decide what kind of response to return for an unauthenticated request.
//   * API requests (path starts with /api/): always 401 JSON.
//   * Asset requests (JS, CSS, images, anything under /assets/): always 401
//     JSON.  Without this, the browser would follow a 302 to /login and try
//     to parse the HTML as JavaScript, which is the most common cause of
//     "Failed to fetch dynamically imported module" errors.
//   * Everything else: 302 to /login for the human, 401 JSON for XHR.
function isAssetRequest(req) {
  const p = req.path;
  if (p.startsWith("/assets/")) return true;
  if (p.startsWith("/lib/")) return true;
  if (/\.(js|mjs|css|map|woff2?|svg|png|jpe?g|gif|webp|ico|wasm)(\?|$)/i.test(p)) return true;
  return false;
}

function deny(req, res, isApi, reason) {
  if (isApi || isAssetRequest(req)) {
    return res.status(401).json({ error: "no_session", reason: reason || null });
  }
  const accept = req.headers.accept || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return res.status(401).json({ error: "no_session", reason: reason || null });
  }
  const url = "/login" + (reason ? "?reason=" + encodeURIComponent(reason) : "");
  res.writeHead(302, { Location: url });
  res.end();
}

function redirectToLogin(req, res, reason) {
  if (isAssetRequest(req)) {
    return res.status(401).json({ error: "no_session", reason: reason || null });
  }
  const accept = req.headers.accept || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return res.status(401).json({ error: "no_session", reason: reason || null });
  }
  const url = "/login" + (reason ? "?reason=" + encodeURIComponent(reason) : "");
  res.writeHead(302, { Location: url });
  res.end();
}

module.exports = { requireSession };
