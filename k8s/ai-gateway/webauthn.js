// k8s/opencode-auth/webauthn.js — WebAuthn registration & authentication
// Uses @simplewebauthn/server. The RP ID is the public hostname (no port, no scheme).
//
// Challenge model:
//   loginBegin returns { options, challengeId } where challengeId is the
//   server-side key under which the challenge is stored. The client echoes
//   challengeId back in loginFinish so the server can find the right challenge.
//   (Storing it server-side and referencing by id avoids relying on the
//   challenge bytes being roundtripped intact through clientDataJSON.)
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const crypto = require("crypto");
const db = require("./db");

// In-memory challenge store. Single-instance gateway so this is safe.
const challenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function storeChallenge(type, payload) {
  const id = crypto.randomUUID();
  challenges.set(id, { type, payload, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return id;
}
function consumeChallenge(id, type) {
  const c = challenges.get(id);
  if (!c) return null;
  challenges.delete(id);
  if (c.type !== type) return null;
  if (c.expiresAt < Date.now()) return null;
  return c.payload;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, c] of challenges) if (c.expiresAt < t) challenges.delete(k);
}, 60_000).unref();

function rpId() { return db.get().rpId; }
function rpName() { return db.get().rpName; }

function originFromReq(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// ---------------- Registration ----------------
//
// Tokenless self-service flow (since 2026-06-28):
//   1. Client POST /auth/register/begin { deviceName? }
//      → server generates a WebAuthn userId, stores a 5-min challenge,
//        and returns PublicKeyCredentialCreationOptions + challengeId.
//      → NO token. The user is initiating their own registration; the
//        only gate is the kube-pod admin's `pending approve` afterwards.
//   2. Browser does navigator.credentials.create(...).
//   3. Client POST /auth/register/finish { attestation, deviceName, challengeId }
//      → verifies the attestation, creates a device with approvedAt=0
//        (pending admin approval), returns the deviceId.
//   4. Browser page polls /auth/pending-status/<deviceId> and tells the
//      user to ask the admin to approve that id.
//
// The deviceId is NOT generated until finish — only devices that actually
// have a passkey are persisted. This means an admin reviewing `pending list`
// sees only real, sign-in-capable devices to approve.

async function registerBegin(req, res) {
  const { deviceName } = req.body || {};
  const userId = crypto.randomBytes(32);
  const userName = (deviceName || "device").slice(0, 64);
  const userIdHex = userId.toString("hex");

  const opts = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    userID: userId,
    userName,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  // Store the challenge under the user's hex userId (per-attempt unique)
  // so finish can verify. No token to track — the userId is the join key.
  const challengeId = storeChallenge("register", { challenge: opts.challenge, userIdHex, name: userName });

  res.json({
    options: {
      ...opts,
      challenge: opts.challenge,    // simplewebauthn returns base64url string
      user: { id: opts.user.id, name: opts.user.name, displayName: opts.user.displayName },
    },
    challengeId,
  });
}

async function registerFinish(req, res) {
  const { attestation, deviceName, challengeId } = req.body || {};
  if (!attestation || !challengeId) return res.status(400).json({ error: "missing attestation or challengeId" });

  const stored = consumeChallenge(challengeId, "register");
  if (!stored) return res.status(400).json({ error: "challenge expired or invalid" });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: stored.challenge,
      expectedOrigin: originFromReq(req),
      expectedRPID: rpId(),
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(400).json({ error: "attestation verification failed: " + e.message });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: "attestation not verified" });
  }
  const { credentialInfo, registrationInfo } = verification;
  const credential = {
    id: registrationInfo.credential.id,
    publicKey: Buffer.from(registrationInfo.credential.publicKey).toString("base64url"),
    counter: registrationInfo.credential.counter || 0,
    transports: credentialInfo?.transports || [],
    aaguid: registrationInfo.aaguid,
    createdAt: Date.now(),
  };

  // Create device in PENDING state. The admin must run
  //   gateway-admin pending approve <id>
  // inside the kube pod before this device can log in. This is the only
  // approval path — there is no auto-approve, no token, no shortcut.
  const device = {
    id: crypto.randomUUID(),
    name: (deviceName || stored.name || "device").slice(0, 64),
    credentials: [credential],
    createdAt: Date.now(),
    approvedAt: 0,
    userAgent: (req.headers["user-agent"] || "").slice(0, 256),
  };
  db.update(c => { c.devices.push(device); });

  res.json({
    ok: true,
    deviceId: device.id,
    deviceName: device.name,
    status: "pending_approval",
    message: `Device registered. Approve with: kubectl -n nexvision exec deploy/ai-manager-gateway -- gateway-admin pending approve ${device.id}`,
  });
}

// ---------------- Login ----------------

// Lookup a device's current approval status by id. Used by the
// post-registration page to poll until the kube-pod admin approves.
// No auth required: deviceId is a UUID, not a secret, and the response
// leaks no more than what the user could see in `gateway-admin device show`.
function pendingStatus(req, res) {
  const id = req.params.deviceId;
  if (!id || typeof id !== "string") return res.status(400).json({ error: "missing deviceId" });
  const d = db.getDevice(id);
  if (!d) return res.json({ deviceId: id, exists: false, approved: false });
  return res.json({
    deviceId: d.id,
    name: d.name,
    exists: true,
    approved: d.approvedAt > 0,
    approvedAt: d.approvedAt || null,
  });
}

async function loginBegin(req, res) {
  const devices = db.listDevices().filter(d => d.approvedAt > 0);
  const allowCredentials = devices.flatMap(d => d.credentials.map(c => ({
    id: c.id,
    transports: c.transports || [],
  })));
  if (allowCredentials.length === 0) {
    // Short-circuit before generating a challenge. The browser's
    // navigator.credentials.get() with an empty allowCredentials list
    // throws an opaque "An unknown error occurred while talking to the
    // credential manager" NotAllowedError, which is unhelpful. Tell the
    // client the real reason instead.
    return res.status(400).json({
      error: "no_approved_devices",
      message: "No approved devices are registered. Register a device first at /register.",
    });
  }
  const opts = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials,
    userVerification: "preferred",
  });
  const challengeId = storeChallenge("login", { challenge: opts.challenge });
  res.json({ options: opts, challengeId });
}

async function loginFinish(req, res) {
  const { assertion, challengeId } = req.body || {};
  if (!assertion || !challengeId) return res.status(400).json({ error: "missing assertion or challengeId" });
  const stored = consumeChallenge(challengeId, "login");
  if (!stored) return res.status(400).json({ error: "challenge expired or invalid" });

  // Find the credential across all approved devices
  const credId = assertion.id;
  let device = null, credential = null;
  for (const d of db.listDevices()) {
    if (!d.approvedAt) continue;
    const c = d.credentials.find(x => x.id === credId);
    if (c) { device = d; credential = c; break; }
  }
  if (!device || !credential) return res.status(400).json({ error: "credential not found or device not approved" });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: stored.challenge,
      expectedOrigin: originFromReq(req),
      expectedRPID: rpId(),
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, "base64url"),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(400).json({ error: "assertion verification failed: " + e.message });
  }
  if (!verification.verified) return res.status(400).json({ error: "assertion not verified" });

  // Update the credential counter (mitigates cloned-authenticator attacks)
  const newCounter = verification.authenticationInfo.newCounter;
  db.update(c => {
    const d = c.devices.find(x => x.id === device.id);
    if (d) {
      const cc = d.credentials.find(x => x.id === credential.id);
      if (cc) cc.counter = newCounter;
    }
  });

  // Create a 30-day session
  const session = db.createSession({
    deviceId: device.id,
    userAgent: (req.headers["user-agent"] || "").slice(0, 256),
    ip: ((req.headers["x-forwarded-for"] || "") + "," + (req.socket.remoteAddress || "")).split(",").map(s => s.trim()).filter(Boolean)[0] || "",
  });
  res.cookie("opencode_sid", session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 30 * 24 * 3600 * 1000,
    path: "/",
  });
  res.json({ ok: true, device: { id: device.id, name: device.name }, expiresAt: session.expiresAt });
}

module.exports = {
  registerBegin, registerFinish,
  loginBegin, loginFinish,
  pendingStatus,
  // exposed for tests
  _storeChallenge: storeChallenge,
  _consumeChallenge: consumeChallenge,
};
