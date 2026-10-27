// Harness overlay: stage a promoted harness2 tree into a workspace's AGENTS.md.
//
// Opt-in per workspace: <ws>/.ai-manager-harness contains a domain name
// (e.g. "nightly-brief"). When present and harness2-work/promoted/<domain>/
// exists, the overlay block (adopted-minus-base delta only) is inserted into
// <ws>/AGENTS.md inside marked comments — never overwriting user content,
// removable byte-identically. No marker (or kill switch AI_MGR_HARNESS_OVERLAY=0)
// means: untouched, except stripping a stale block we previously wrote.
// Every failure path returns {skipped/error} — session creation never throws.
"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = ".ai-manager-harness";
const END = "<!-- aimgr-harness:end -->";
const beginFor = (domain, fp) => `<!-- aimgr-harness:begin ${domain}@${fp} -->`;
const BLOCK_RE = /<!-- aimgr-harness:begin ([^ ]+) -->\n?[\s\S]*?<!-- aimgr-harness:end -->\n?/;
const STRIP_RE = /\n?<!-- aimgr-harness:begin [^ ]+ -->\n?[\s\S]*?<!-- aimgr-harness:end -->\n?/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9_-]*$/;

function workDir() {
  return process.env.AI_MGR_HARNESS_WORK || path.join(__dirname, "..", "..", "harness2-work");
}

function killed() {
  return process.env.AI_MGR_HARNESS_OVERLAY === "0";
}

function readMarker(wsPath) {
  try {
    const raw = fs.readFileSync(path.join(wsPath, MARKER), "utf8").trim().split("\n")[0].trim();
    return DOMAIN_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function readTreeFiles(dir) {
  // ponytail: flat relative-path -> body map, small trees only.
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

function loadPromoted(domain) {
  try {
    const dir = path.join(workDir(), "promoted", domain);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "PROMOTED.json"), "utf8"));
    return {
      meta,
      fp: String(meta.fingerprint || ""),
      adopted: readTreeFiles(path.join(dir, "tree")),
      base: readTreeFiles(path.join(dir, "base")),
    };
  } catch {
    return null;
  }
}

function buildBlock(domain, fp, adopted, base, when) {
  const chunks = [];
  const isSkillDoc = (rel) => rel.startsWith("skills/") && rel.endsWith("/SKILL.md");
  for (const [rel, body] of Object.entries(adopted)) {
    if ((base[rel] || "") === body) continue;
    if (rel === "skills/README.md" || rel.endsWith("/README.md")) continue;
    chunks.push(`### ${rel}\n${body.trim()}`);
  }
  const removed = Object.keys(base).filter(
    (rel) => !(rel in adopted) && (isSkillDoc(rel) || !rel.endsWith("README.md"))
  );
  if (!chunks.length) return "";
  const head = [
    beginFor(domain, fp),
    `# Adopted harness: ${domain}@${fp.slice(0, 12)}`,
    when ? `Promoted ${when}` : null,
    removed.length ? `Retired components (ignore their triggers): ${removed.join(", ")}` : null,
    "The sections below override same-named guidance above. Skill docs load in full —",
    "follow a skill's triggers as written.",
  ].filter((l) => l !== null);
  return head.join("\n") + "\n\n" + chunks.join("\n\n") + "\n" + END + "\n";
}

function stripOverlay(content) {
  const m = content.match(BLOCK_RE);
  if (!m) return { content, removed: false };
  return { content: content.replace(STRIP_RE, ""), removed: true };
}

function applyOverlay(agentsPath, block) {
  let current = "";
  try {
    current = fs.readFileSync(agentsPath, "utf8");
  } catch {
    current = "";
  }
  const existing = current.match(BLOCK_RE);
  if (!block) {
    if (!existing) return { changed: false, action: "absent" };
    const next = stripOverlay(current).content;
    fs.writeFileSync(agentsPath, next);
    return { changed: true, action: "removed" };
  }
  const want = block.trim() + "\n";
  if (existing && existing[0].trim() === want.trim()) return { changed: false, action: "current" };
  const stripped = stripOverlay(current).content;
  const sep = stripped.length && !stripped.endsWith("\n") ? "\n" : "";
  const pad = stripped.length && !stripped.endsWith("\n\n") ? "\n" : "";
  fs.writeFileSync(agentsPath, stripped + sep + pad + want);
  return { changed: true, action: existing ? "refreshed" : "applied" };
}

// Best-effort entry point for session bootstrap. Never throws.
function maybeApplyHarnessOverlay(wsPath) {
  try {
    if (killed()) return { applied: false, reason: "killed" };
    if (!wsPath || !fs.statSync(wsPath).isDirectory()) return { applied: false, reason: "no-dir" };
    const domain = readMarker(wsPath);
    const agentsPath = path.join(wsPath, "AGENTS.md");
    if (!domain) {
      const r = applyOverlay(agentsPath, "");
      return { applied: false, reason: r.action === "removed" ? "cleaned" : "no-marker" };
    }
    const prom = loadPromoted(domain);
    if (!prom) return { applied: false, reason: "not-promoted" };
    const when = prom.meta && prom.meta.time
      ? new Date(prom.meta.time * 1000).toISOString().slice(0, 10) : "";
    const block = buildBlock(domain, prom.fp, prom.adopted, prom.base, when);
    const r = applyOverlay(agentsPath, block);
    return { applied: r.changed, reason: block ? r.action : "no-delta", domain, fp: prom.fp };
  } catch (e) {
    return { applied: false, reason: "error", error: String((e && e.message) || e) };
  }
}

module.exports = {
  MARKER, END, beginFor, BLOCK_RE, DOMAIN_RE,
  workDir, killed, readMarker, readTreeFiles, loadPromoted,
  buildBlock, stripOverlay, applyOverlay, maybeApplyHarnessOverlay,
};
