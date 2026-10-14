// prod-login.mjs — software WebAuthn login for the ai-manager.nexvision.cc gateway.
// Self-service flow per memory/prod-web-testing: register P-256 fmt=none,
// approve own device via kubectl, login, save opencode_sid cookie.
// Usage: node prod-login.mjs [register|login|approve-check]
//   register: begin+finish, prints deviceId
//   login: begin+finish with saved credential, prints cookie (needs CRED_FILE + DEVICE approved)
// State in /tmp/opencode/prod-cred.json (private key! 0600, ephemeral).
import crypto from "node:crypto";
import fs from "node:fs";

const BASE = process.env.PROD_BASE || "https://ai-manager.nexvision.cc";
const RPID = process.env.PROD_RPID || "ai-manager.nexvision.cc";
const ORIGIN = process.env.PROD_ORIGIN || "https://ai-manager.nexvision.cc";
const CRED_FILE = process.env.PROD_CRED_FILE || "/tmp/opencode/prod-cred.json";
const COOKIE_FILE = process.env.PROD_COOKIE_FILE || "/tmp/opencode/prod-cookie.txt";
const DEVICE_NAME = process.env.PROD_DEVICE_NAME || ("probe-" + new Date().toISOString().slice(0, 10));

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Minimal CBOR encoder (memory note: authenticator data needs 0x58+len,
// never 0x59+u16, or simplewebauthn v13 chokes on leftover bytes).
function cborEnc(v) {
  const parts = [];
  const enc = (x) => {
    if (typeof x === "number") {
      if (Number.isInteger(x) && x >= 0 && x < 24) parts.push(Buffer.from([x]));
      else if (Number.isInteger(x) && x >= 0 && x < 256) parts.push(Buffer.from([0x18, x]));
      else if (Number.isInteger(x) && x < 0 && x >= -24) parts.push(Buffer.from([0x20 + (-1 - x)]));
      else throw new Error("cbor int out of range: " + x);
      return;
    }
    if (typeof x === "string") {
      const b = Buffer.from(x, "utf8");
      if (b.length >= 24) throw new Error("cbor str too long");
      parts.push(Buffer.from([0x60 + b.length]), b);
      return;
    }
    if (Buffer.isBuffer(x)) {
      if (x.length < 24) parts.push(Buffer.from([0x40 + x.length]));
      else if (x.length < 256) parts.push(Buffer.from([0x58, x.length]));
      else throw new Error("cbor bytes too long");
      parts.push(x);
      return;
    }
    if (Array.isArray(x)) {
      if (x.length >= 24) throw new Error("cbor arr too long");
      parts.push(Buffer.from([0x80 + x.length]));
      x.forEach(enc);
      return;
    }
    if (typeof x === "object") {
      const ks = Object.keys(x);
      if (ks.length >= 24) throw new Error("cbor map too long");
      parts.push(Buffer.from([0xa0 + ks.length]));
      // COSE maps use integer labels, but JS object keys arrive stringified
      // ("-1" must encode as int 0x20, not text) — restore numerics.
      for (const k of ks) { enc(/^-?\d+$/.test(k) ? parseInt(k, 10) : k); enc(x[k]); }
      return;
    }
    throw new Error("cbor unsupported: " + typeof x);
  };
  enc(v);
  return Buffer.concat(parts);
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "aimgr-prod-probe/1" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { status: r.status, json, txt: txt.slice(0, 300), setCookie: r.headers.get("set-cookie") };
}

async function register() {
  const { deviceName } = { deviceName: DEVICE_NAME };
  const b = await post("/auth/register/begin", { deviceName });
  if (b.status !== 200) throw new Error("begin failed: " + b.status + " " + b.txt);
  const { options, challengeId } = b.json;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = unb64u(jwk.x), y = unb64u(jwk.y);
  const credId = crypto.randomBytes(32);
  const clientData = { type: "webauthn.create", challenge: options.challenge, origin: ORIGIN };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData));
  const rpHash = crypto.createHash("sha256").update(RPID).digest();
  const coseKey = cborEnc({ 1: 2, 3: -7, [-1]: 1, [-2]: x, [-3]: y });
  const authData = Buffer.concat([
    rpHash, Buffer.from([0x41]), Buffer.from([0, 0, 0, 0]),
    Buffer.alloc(16, 0),
    Buffer.from([(credId.length >> 8) & 0xff, credId.length & 0xff]), credId, coseKey,
  ]);
  const attObj = cborEnc({ fmt: "none", authData, attStmt: {} });
  const attestation = {
    id: b64u(credId), rawId: b64u(credId), type: "public-key",
    response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attObj) },
    authenticatorAttachment: "platform", clientExtensionResults: {},
  };
  const f = await post("/auth/register/finish", { attestation, deviceName, challengeId });
  if (f.status !== 200) throw new Error("finish failed: " + f.status + " " + f.txt);
  const privJwk = { ...privateKey.export({ format: "jwk" }) };
  fs.writeFileSync(CRED_FILE, JSON.stringify({ credId: b64u(credId), privJwk, deviceId: f.json.deviceId, deviceName }), { mode: 0o600 });
  console.log("REGISTERED deviceId=" + f.json.deviceId + " name=" + f.json.deviceName);
  console.log("APPROVE WITH: kubectl -n nexvision exec deploy/ai-manager-gateway -- gateway-admin pending approve " + f.json.deviceId);
}

async function login() {
  const cred = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  const b = await post("/auth/login/begin", {});
  if (b.status !== 200) throw new Error("login begin failed: " + b.status + " " + b.txt);
  const { options, challengeId } = b.json;
  if (!options.allowCredentials.some((c) => c.id === cred.credId)) {
    throw new Error("our credential not in allowCredentials (device not approved yet?)");
  }
  const clientData = { type: "webauthn.get", challenge: options.challenge, origin: ORIGIN };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData));
  const rpHash = crypto.createHash("sha256").update(RPID).digest();
  const authData = Buffer.concat([rpHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 1])]);
  const priv = crypto.createPrivateKey({ key: cred.privJwk, format: "jwk" });
  // DER signature (memory note: raw R||S fails v13 with "Too big integer").
  const sig = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]), { key: priv, dsaEncoding: "der" });
  const assertion = {
    id: cred.credId, rawId: cred.credId, type: "public-key",
    response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig) },
    authenticatorAttachment: "platform", clientExtensionResults: {},
  };
  const f = await post("/auth/login/finish", { assertion, challengeId });
  if (f.status !== 200) throw new Error("login finish failed: " + f.status + " " + f.txt);
  const m = /opencode_sid=([^;]+)/.exec(f.setCookie || "");
  if (!m) throw new Error("no opencode_sid cookie: " + f.setCookie);
  fs.writeFileSync(COOKIE_FILE, m[1]);
  console.log("LOGIN OK cookie=" + m[1].slice(0, 12) + "…");
}

const mode = process.argv[2] || "register";
if (mode === "register") await register();
else if (mode === "login") await login();
else throw new Error("usage: register|login");
