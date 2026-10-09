#!/usr/bin/env node
// k8s/ai-gateway/admin.js — CLI for managing the auth gateway
// Run via: kubectl -n nexvision exec deploy/ai-manager-gateway -- gateway-admin <cmd> [...]
// Uses the same JSON registry as the server (mounted at /app/data/registry.json).
const db = require("./db");

const HELP = `
gateway-admin — manage the OpenCode auth gateway

 Usage:
  gateway-admin pending list
  gateway-admin pending approve <deviceId>     ← required after every self-registration
  gateway-admin pending revoke <deviceId>
  gateway-admin device list
  gateway-admin device show <deviceId>
  gateway-admin device revoke <deviceId>
  gateway-admin device revoke-all     ⚠ wipes every device, session, and pending token
  gateway-admin device set-tunnel <deviceId> <tunnelId>   # bind device to a specific tunnel (or "" to clear)
  gateway-admin session list
  gateway-admin session revoke <sessionId>
  gateway-admin tunnel-token create --name "herbert-laptop"
  gateway-admin tunnel-token list
  gateway-admin tunnel-token revoke <tunnelId>
  gateway-admin tunnel status

Notes:
  - Users self-register at https://<rpId>/register (no token required).
    After the passkey is created, the device is PENDING and visible in
    "pending list" along with the deviceId the page shows the user.
  - Every new device requires explicit admin approval. There is no auto-approve.
  - To bind a device to a specific tunnel (instead of the first-active fallback),
    run "device set-tunnel" after approval. Bound devices' requests always go
    to that tunnel even if other tunnels are connected.
  - tunnel-token = long-lived token the local tunnel client uses to authenticate
    its WebSocket connection. Unrelated to user devices.
`;

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

function fmtTime(t) { return t ? new Date(t).toISOString() : "—"; }
function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }

const cmd = process.argv[2];
const rest = process.argv.slice(3);

(async function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "pending": {
      const sub = rest[0];
      if (sub === "list") {
        const devices = db.listDevices().filter(d => !d.approvedAt);
        console.log("Pending passkey devices (registered via /register, awaiting approval):");
        if (devices.length === 0) console.log("  (none)");
        for (const d of devices) {
          console.log(`  ${d.id}  "${d.name}"  creds=${d.credentials.length}  ua=${truncate(d.userAgent, 50)}  created=${fmtTime(d.createdAt)}`);
        }
      } else if (sub === "approve") {
        const id = rest[1];
        if (!id) throw new Error("usage: pending approve <deviceId>");
        const d = db.getDevice(id);
        if (!d) throw new Error("device not found: " + id);
        if (d.approvedAt) { console.log("device already approved at", fmtTime(d.approvedAt)); return; }
        d.approvedAt = Date.now();
        db.update(c => {
          const dd = c.devices.find(x => x.id === id);
          if (dd) dd.approvedAt = Date.now();
        });
        console.log(`Approved device ${id} ("${d.name}"). They can now log in at https://${db.get().rpId}/login`);
      } else if (sub === "revoke") {
        const id = rest[1];
        if (!id) throw new Error("usage: pending revoke <deviceId>");
        db.revokeDevice(id);
        console.log("revoked device", id);
      } else { throw new Error("unknown pending subcommand: " + sub); }
      return;
    }

    case "device": {
      const sub = rest[0];
      if (sub === "list") {
        const devices = db.listDevices();
        if (devices.length === 0) { console.log("(no devices)"); return; }
        console.log("id                                   name                  status    creds  tunnel          last seen");
        for (const d of devices) {
          const last = db.listSessions().filter(s => s.deviceId === d.id).sort((a,b)=>b.lastSeenAt-a.lastSeenAt)[0];
          const status = d.approvedAt ? "approved" : "pending";
          const tunnel = d.tunnelId ? d.tunnelId.slice(0, 8) + "…" : "(any)";
          console.log(`${d.id}  ${truncate(d.name, 20).padEnd(20)}  ${status.padEnd(8)}  ${d.credentials.length}     ${tunnel.padEnd(15)}  ${fmtTime(last?.lastSeenAt)}`);
        }
      } else if (sub === "show") {
        const id = rest[1];
        if (!id) throw new Error("usage: device show <deviceId>");
        const d = db.getDevice(id);
        if (!d) throw new Error("not found");
        console.log(JSON.stringify(d, null, 2));
      } else if (sub === "revoke") {
        const id = rest[1];
        if (!id) throw new Error("usage: device revoke <deviceId>");
        db.revokeDevice(id);
        console.log("revoked device", id);
      } else if (sub === "revoke-all") {
        // Snapshot counts so we can report them after the wipe (db is the
        // only source of truth; we can't ask it after the fact).
        const devCount = db.listDevices().length;
        const sessCount = db.listSessions().length;
        const pendCount = db.listPending().length;
        const tunCount = db.listTunnels().length;
        db.revokeAll();
        console.log(`Wiped:`);
        console.log(`  devices:   ${devCount} (all passkeys revoked)`);
        console.log(`  sessions:  ${sessCount} (all gateway-issued cookies invalidated)`);
        if (pendCount > 0) console.log(`  pending:   ${pendCount} (stale registration tokens discarded)`);
        console.log(`Kept:`);
        console.log(`  tunnels:   ${tunCount} (local-machine WS auth tokens preserved)`);
        console.log(`\nEvery user — including your own browser — must re-register.`);
        console.log(`New flow: open https://${db.get().rpId}/register → user creates passkey →`);
        console.log(`           gateway-admin pending approve <id> → user can sign in.`);
      } else if (sub === "set-tunnel") {
        const id = rest[1];
        const tunnelArg = rest[2];
        if (!id) throw new Error("usage: device set-tunnel <deviceId> <tunnelId|empty>");
        const d = db.getDevice(id);
        if (!d) throw new Error("device not found: " + id);
        if (!tunnelArg) {
          db.setDeviceTunnel(id, null);
          console.log(`Cleared tunnel binding for device ${id} ("${d.name}"). Will use first active tunnel.`);
        } else {
          // Accept either a tunnel id (UUID) or a tunnel token (hex).
          const tun = db.listTunnels().find(t => t.id === tunnelArg || t.token === tunnelArg || t.token.startsWith(tunnelArg));
          if (!tun) throw new Error("tunnel not found: " + tunnelArg + " (use `tunnel-token list` to find the id)");
          db.setDeviceTunnel(id, tun.id);
          console.log(`Bound device ${id} ("${d.name}") to tunnel ${tun.id} ("${tun.name}"). Requests will route there.`);
        }
      } else { throw new Error("unknown device subcommand: " + sub); }
      return;
    }

    case "session": {
      const sub = rest[0];
      if (sub === "list") {
        const sessions = db.listSessions();
        if (sessions.length === 0) { console.log("(no sessions)"); return; }
        console.log("id (truncated)         device                                ip           last seen            expires");
        for (const s of sessions) {
          const d = db.getDevice(s.deviceId);
          console.log(`${s.id.slice(0,16)}…  ${(s.deviceId + " \"" + (d?.name||"?") + "\"").padEnd(36)}  ${(s.ip||"?").padEnd(12)}  ${fmtTime(s.lastSeenAt)}  ${fmtTime(s.expiresAt)}`);
        }
      } else if (sub === "revoke") {
        const id = rest[1];
        if (!id) throw new Error("usage: session revoke <sessionId>");
        db.revokeSession(id);
        console.log("revoked session", id);
      } else { throw new Error("unknown session subcommand: " + sub); }
      return;
    }

    case "tunnel-token": {
      const sub = rest[0];
      if (sub === "create") {
        const name = arg("--name", "tunnel");
        const t = db.createTunnelToken({ name });
        console.log(`\nTunnel token (use as TUNNEL_TOKEN env var when starting the local tunnel client):\n`);
        console.log(`  ${t.token}\n`);
        console.log(`Name: ${t.name}`);
        console.log(`Connect URL: wss://${db.get().rpId}/tunnel?token=${t.token}\n`);
      } else if (sub === "list") {
        for (const t of db.listTunnels()) {
          console.log(`${t.id}  "${t.name}"  token=${t.token.slice(0,8)}…  lastConn=${fmtTime(t.lastConnectedAt)}  lastSeen=${fmtTime(t.lastSeenAt)}`);
        }
      } else if (sub === "revoke") {
        const id = rest[1];
        if (!id) throw new Error("usage: tunnel-token revoke <tunnelId>");
        db.revokeTunnel(id);
        console.log("revoked tunnel", id);
      } else { throw new Error("unknown tunnel-token subcommand: " + sub); }
      return;
    }

    case "tunnel": {
      const sub = rest[0];
      if (sub === "status") {
        const t = require("./tunnel");
        const live = t.listTunnels();
        const liveById = new Map(live.map(x => [x.id, x]));
        const all = db.listTunnels();
        console.log("Configured tunnels:");
        if (all.length === 0) console.log("  (none)");
        for (const tt of all) {
          const conn = liveById.get(tt.id);
          const tag = conn ? (conn.ready ? "[ACTIVE]" : "[connecting]") : "[offline]";
          const seen = conn ? fmtTime(conn.lastSeenAt) : fmtTime(tt.lastSeenAt);
          console.log(`  ${tag.padEnd(11)} ${tt.id} "${tt.name}"  lastConn=${fmtTime(tt.lastConnectedAt)}  lastSeen=${seen}`);
        }
        // Devices → tunnel bindings
        const bindings = db.listDevices().filter(d => d.approvedAt > 0 && d.tunnelId);
        if (bindings.length > 0) {
          console.log("\nDevice → tunnel bindings:");
          for (const d of bindings) {
            const tun = all.find(x => x.id === d.tunnelId);
            console.log(`  ${d.id} "${d.name}"  →  ${tun ? tun.id + ' ("' + tun.name + '")' : d.tunnelId + ' [missing]'}`);
          }
        }
        // In-flight
        console.log(`\nIn-flight requests: ${t.pending ? t.pending.size : 0}`);
      } else { throw new Error("unknown tunnel subcommand: " + sub); }
      return;
    }

    default:
      throw new Error("unknown command: " + cmd + "\n\n" + HELP);
  }
})().catch(e => { console.error("error:", e.message); process.exit(1); });
