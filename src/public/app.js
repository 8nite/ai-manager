// app.js — ai-manager UI: left workspaces/sessions, main stage, bottom consoles.
//
// Main window:
//   web sessions (opencode/dsh) → iframe. Local: /harness/<id>/ (same-origin
//     proxy). Remote (non-localhost origin): /s/<id>/ focus mode + the
//     aimgr_active cookie so root-absolute assets resolve.
//   pty sessions (droid) → xterm.js fed by SSE stream + POST input.
// Bottom consoles: xterm.js tabs, same SSE+POST transport (tunnel-safe).

const $ = (id) => document.getElementById(id);
const state = {
  workspaces: [], sessions: [], consoles: [],
  activeSessionId: null,
  activeConsoleId: null,
  modalWorkspaceId: null,
  closedGroups: new Set(),
  es: null, // active main EventSource
  conEs: null, // active console EventSource
  mainTerm: null, mainFit: null,
  conTerm: null, conFit: null,
};

const REMOTE = !["127.0.0.1", "localhost", "[::1]", ""].includes(location.hostname);
const hasXterm = typeof Terminal !== "undefined";

function status(s, extra = "") {
  $("statusText").textContent = s + (extra ? " · " + extra : "");
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

async function refresh() {
  const s = await api("GET", "/api/state");
  state.workspaces = s.workspaces || [];
  state.sessions = s.sessions || [];
  state.consoles = s.consoles || [];
  if (state.activeSessionId && !state.sessions.find((x) => x.id === state.activeSessionId)) {
    teardownMain();
    state.activeSessionId = null;
  }
  if (state.activeConsoleId && !state.consoles.find((x) => x.id === state.activeConsoleId)) {
    state.activeConsoleId = null;
  }
  renderWorkspaces();
  renderSessionBar();
  renderConsoles();
}

async function health() {
  try {
    await api("GET", "/health");
    $("healthDot").className = "dot on";
  } catch {
    $("healthDot").className = "dot off";
  }
}

// ---------- left panel ----------

function fmtIdle(ms) {
  if (!ms || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `idle ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `idle ${m}m`;
  return `idle ${Math.floor(m / 60)}h`;
}

function renderWorkspaces() {
  const el = $("wsList");
  el.innerHTML = "";
  // "Needs you" shelf: pty sessions gone quiet (likely awaiting input).
  const waiting = state.sessions.filter((s) => s.activity === "waiting");
  if (waiting.length) {
    const shelf = document.createElement("div");
    shelf.className = "ws-group attention";
    const head = document.createElement("div");
    head.className = "ws-head";
    head.innerHTML = '<span class="caret">▼</span>';
    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = `NEEDS YOU (${waiting.length})`;
    head.appendChild(name);
    head.onclick = () => shelf.classList.toggle("closed");
    shelf.appendChild(head);
    const ul = document.createElement("ul");
    ul.className = "ws-sessions";
    const wsById = Object.fromEntries(state.workspaces.map((w) => [w.id, w]));
    for (const s of waiting) {
      const li = document.createElement("li");
      li.className = "sess" + (s.id === state.activeSessionId ? " active" : "");
      li.innerHTML = '<span class="sdot waiting"></span>';
      const tag = document.createElement("span");
      tag.className = "tag " + s.harness;
      tag.textContent = s.harness;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      const ws = wsById[s.workspaceId];
      lbl.textContent = `${s.title || s.id} — ${ws ? ws.name : "?"} · ${fmtIdle(s.idleMs)}`;
      li.append(tag, lbl);
      li.onclick = () => activateSession(s.id);
      ul.appendChild(li);
    }
    shelf.appendChild(ul);
    el.appendChild(shelf);
  }
  if (!state.workspaces.length) {
    el.innerHTML = '<div class="empty">No workspaces — open a folder to begin.</div>';
    return;
  }
  for (const ws of state.workspaces) {
    const group = document.createElement("div");
    group.className = "ws-group" + (state.closedGroups.has(ws.id) ? " closed" : "");
    group.dataset.ws = ws.id;
    const head = document.createElement("div");
    head.className = "ws-head";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▼";
    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = ws.name;
    const p = document.createElement("span");
    p.className = "ws-path";
    p.textContent = ws.path;
    p.title = ws.path;
    name.appendChild(document.createElement("br"));
    name.appendChild(p);
    const add = document.createElement("button");
    add.className = "ws-add";
    add.textContent = "+";
    add.title = `New session in ${ws.name}`;
    add.onclick = (e) => { e.stopPropagation(); openModal(ws.id); };
    const del = document.createElement("button");
    del.className = "ws-del";
    del.textContent = "×";
    del.title = `Remove workspace ${ws.name} (deletes its sessions)`;
    del.onclick = async (e) => {
      e.stopPropagation();
      const n = state.sessions.filter((s) => s.workspaceId === ws.id).length;
      if (!confirm(`Remove workspace "${ws.name}" and its ${n} session(s)?`)) return;
      await api("DELETE", `/api/workspaces/${ws.id}`).catch(() => {});
      const active = state.sessions.find((s) => s.id === state.activeSessionId);
      if (active && active.workspaceId === ws.id) {
        // Active session belonged to this workspace — clear the stage.
        state.activeSessionId = null;
        teardownMain();
      }
      refresh();
    };
    head.append(caret, name, add, del);
    head.onclick = () => {
      if (state.closedGroups.has(ws.id)) state.closedGroups.delete(ws.id);
      else state.closedGroups.add(ws.id);
      group.classList.toggle("closed");
    };
    group.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "ws-sessions";
    const sess = state.sessions.filter((s) => s.workspaceId === ws.id);
    if (!sess.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "no sessions yet — press +";
      ul.appendChild(li);
    }
    for (const s of sess) {
      const li = document.createElement("li");
      li.className = "sess" + (s.id === state.activeSessionId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "sdot " + (s.activity || s.status || "starting");
      dot.title = `${s.activity || s.status || "?"}${s.error ? ": " + s.error : ""}${s.idleMs ? " · " + fmtIdle(s.idleMs) : ""}`;
      const tag = document.createElement("span");
      tag.className = "tag " + s.harness;
      tag.textContent = s.harness;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = s.title || s.id;
      lbl.title = s.title || s.id;
      li.append(dot, tag, lbl);
      li.onclick = () => activateSession(s.id);
      ul.appendChild(li);
    }
    group.appendChild(ul);
    el.appendChild(group);
  }
}

// ---------- main window ----------

function renderSessionBar() {
  const s = state.sessions.find((x) => x.id === state.activeSessionId);
  $("sessionBar").classList.toggle("is-empty", !s);
  $("sessionTitle").textContent = s ? (s.title || s.id) : "Nothing open — pick a session on the left";
  $("sessionMeta").textContent = s
    ? `${s.harness} · ${s.mode} · ${s.activity || s.status || "?"}${s.idleMs ? " · " + fmtIdle(s.idleMs) : ""}`
    : "";
  $("btnEnsure").disabled = !s;
  $("btnKill").disabled = !s;
}

function teardownMain() {
  if (state.es) { try { state.es.close(); } catch {} state.es = null; }
  if (state.mainTerm) { try { state.mainTerm.dispose(); } catch {} state.mainTerm = null; state.mainFit = null; }
  $("webview").classList.add("hidden");
  $("webview").removeAttribute("src");
  $("termWrap").classList.add("hidden");
  $("termWrap").innerHTML = "";
  $("emptyStage").style.display = state.activeSessionId ? "none" : "flex";
}

async function activateSession(id) {
  teardownMain();
  state.activeSessionId = id;
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return renderSessionBar();
  status("switching", s.title || id);
  try {
    const fresh = await api("POST", `/api/sessions/${id}/ensure`);
    Object.assign(s, fresh);
  } catch (e) {
    status("ensure failed", e.message);
  }
  try { await api("POST", `/api/sessions/${id}/touch`); } catch {}
  renderWorkspaces();
  renderSessionBar();
  $("emptyStage").style.display = "none";
  if (s.mode === "web") {
    // Remote origins can't reach 127.0.0.1 backend ports — use focus-mode
    // path (sets aimgr_active cookie for asset fallback).
    $("webview").src = REMOTE ? `/s/${id}/` : `/harness/${id}/`;
    $("webview").classList.remove("hidden");
    status("attached", `${s.harness} via ${REMOTE ? "tunnel proxy" : "local proxy"}`);
  } else {
    $("termWrap").classList.remove("hidden");
    attachMainTerm(id);
  }
}

// POST terminal input; surfaces "exited" instead of failing silently.
async function postInput(kind, id, data, term) {
  try {
    const r = await fetch(`/api/pty/${kind}/${id}/input`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (r.status === 410 && term) {
      term.write("\r\n\x1b[31m[terminal exited — press \u21bb resume (sessions) or recreate the console]\x1b[0m\r\n");
    }
  } catch {}
}
function makeTerm(container) {
  if (!hasXterm) {
    container.innerHTML = '<div class="empty">xterm.js failed to load (CDN unreachable). Terminal unavailable.</div>';
    return null;
  }
  const term = new Terminal({ fontSize: 13, theme: { background: "#04050c", foreground: "#d5e2ff", cursor: "#00f0ff" } });
  term.open(container);
  let fit = null;
  try {
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    fit.fit();
  } catch {}
  return { term, fit };
}

function attachMainTerm(sessionId) {
  const wrap = $("termWrap");
  const made = makeTerm(wrap);
  if (!made) return;
  state.mainTerm = made.term;
  state.mainFit = made.fit;
  const kind = "session";
  state.mainTerm.onData((d) => postInput(kind, sessionId, d, state.mainTerm));
  const es = new EventSource(`/api/pty/${kind}/${sessionId}/stream`);
  state.es = es;
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "data") state.mainTerm.write(msg.data);
    } catch {}
  };
  es.addEventListener("exit", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      state.mainTerm.write(`\r\n\x1b[31m[process exited: ${m.exitCode} — press ↻ resume to restart]\x1b[0m\r\n`);
    } catch {}
    es.close();
  });
  es.onerror = () => status("stream error", "backend may be down — press ↻ resume");
  setTimeout(() => {
    if (state.mainFit) {
      try {
        state.mainFit.fit();
        const dims = state.mainFit.proposeDimensions();
        if (dims) fetch(`/api/pty/${kind}/${sessionId}/resize`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dims),
        }).catch(() => {});
      } catch {}
    }
  }, 300);
  state.mainTerm.focus();
}

// ---------- bottom consoles ----------

function renderConsoles() {
  const el = $("conTabs");
  el.innerHTML = "";
  $("bottom").classList.toggle("body-empty", state.consoles.length === 0);
  for (const c of state.consoles) {
    const t = document.createElement("span");
    t.className = "con-tab" + (c.id === state.activeConsoleId ? " active" : "");
    t.textContent = c.title || c.id;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.onclick = async (e) => {
      e.stopPropagation();
      await api("DELETE", `/api/consoles/${c.id}`).catch(() => {});
      if (state.activeConsoleId === c.id) { state.activeConsoleId = null; teardownConsole(); }
      refresh();
    };
    t.appendChild(x);
    t.onclick = () => activateConsole(c.id);
    el.appendChild(t);
  }
  if (!state.consoles.length) {
    const s = document.createElement("span");
    s.className = "empty";
    s.textContent = "no consoles — press ＋";
    el.appendChild(s);
  }
  if (!state.activeConsoleId && state.consoles.length) {
    activateConsole(state.consoles[0].id);
  } else if (state.activeConsoleId) {
    activateConsole(state.activeConsoleId, true);
  }
}

function teardownConsole() {
  if (state.conEs) { try { state.conEs.close(); } catch {} state.conEs = null; }
  if (state.conTerm) { try { state.conTerm.dispose(); } catch {} state.conTerm = null; state.conFit = null; }
  $("conTermWrap").innerHTML = "";
}

function activateConsole(id, soft) {
  if (soft && id === state.activeConsoleId && state.conTerm) return;
  teardownConsole();
  state.activeConsoleId = id;
  renderConsoleTabs();
  const made = makeTerm($("conTermWrap"));
  if (!made) return;
  state.conTerm = made.term;
  state.conFit = made.fit;
  state.conTerm.onData((d) => postInput("console", id, d, state.conTerm));
  const es = new EventSource(`/api/pty/console/${id}/stream`);
  state.conEs = es;
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "data") state.conTerm.write(msg.data);
    } catch {}
  };
  es.addEventListener("exit", () => { try { es.close(); } catch {} });
  setTimeout(() => { try { state.conFit && state.conFit.fit(); } catch {} state.conTerm.focus(); }, 200);
}

function renderConsoleTabs() {
  const el = $("conTabs");
  [...el.children].forEach((t, i) => {
    const c = state.consoles[i];
    if (c) t.classList.toggle("active", c.id === state.activeConsoleId);
  });
}

// ---------- modal / actions ----------

function openModal(workspaceId) {
  state.modalWorkspaceId = workspaceId;
  $("fTitle").value = "";
  $("modal").classList.remove("hidden");
  $("fHarness").focus();
}
function closeModal() { $("modal").classList.add("hidden"); }

$("fOk").onclick = submitModal;
$("fCancel").onclick = closeModal;
$("fTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") submitModal(); });
$("fHarness").addEventListener("keydown", (e) => { if (e.key === "Enter") submitModal(); });

async function submitModal() {
  const harness = $("fHarness").value;
  const title = $("fTitle").value.trim();
  closeModal();
  try {
    status("creating session", harness);
    const s = await api("POST", "/api/sessions", { workspaceId: state.modalWorkspaceId, harness, title: title || undefined });
    await refresh();
    activateSession(s.id);
  } catch (e) { status("create failed", e.message); }
}

$("btnOpenFolder").onclick = async () => {
  const p = prompt("Folder path to open as workspace:");
  if (!p) return;
  try {
    await api("POST", "/api/workspaces", { path: p.trim() });
    status("workspace added", p.trim());
    refresh();
  } catch (e) { status("open failed", e.message); }
};

$("btnEnsure").onclick = async () => {
  if (!state.activeSessionId) return;
  try {
    status("resuming", state.activeSessionId);
    await api("POST", `/api/sessions/${state.activeSessionId}/ensure`);
    await refresh();
    activateSession(state.activeSessionId);
  } catch (e) { status("resume failed", e.message); }
};

$("btnKill").onclick = async () => {
  if (!state.activeSessionId) return;
  const s = state.sessions.find((x) => x.id === state.activeSessionId);
  if (!confirm(`Delete session "${s ? s.title : state.activeSessionId}"?`)) return;
  await api("DELETE", `/api/sessions/${state.activeSessionId}`).catch(() => {});
  state.activeSessionId = null;
  teardownMain();
  refresh();
};

$("btnNewConsole").onclick = async () => {
  const s = state.sessions.find((x) => x.id === state.activeSessionId);
  const wsId = s ? s.workspaceId : (state.workspaces[0] && state.workspaces[0].id);
  if (!wsId) { status("no workspace", "open a folder first"); return; }
  try {
    const c = await api("POST", "/api/consoles", { workspaceId: wsId });
    await refresh();
    activateConsole(c.id);
  } catch (e) { status("console failed", e.message); }
};

$("btnCollapse").onclick = () => {
  const b = $("bottom");
  b.classList.toggle("collapsed");
  $("btnCollapse").textContent = b.classList.contains("collapsed") ? "▴" : "▾";
};

$("btnPalette").onclick = () => (pal.open ? closePal() : openPal());
$("btnEmptyOpen").onclick = () => $("btnOpenFolder").click();

// ---------- quick-switcher palette (ctrl/cmd+k) ----------

const pal = { open: false, items: [], sel: 0, q: "" };

// Subsequence fuzzy score: higher = better. Non-matches score -1.
function fuzzyScore(hay, needle) {
  hay = hay.toLowerCase();
  needle = needle.toLowerCase().replace(/\s+/g, "");
  if (!needle) return 1;
  let score = 0, hi = 0, streak = 0;
  for (const ch of needle) {
    const i = hay.indexOf(ch, hi);
    if (i < 0) return -1;
    streak = (i === hi) ? streak + 1 : 0;
    score += 1 + streak * 2 + (i === 0 ? 3 : 0);
    hi = i + 1;
  }
  return score - hay.length * 0.01;
}

function palItems() {
  const wsById = Object.fromEntries(state.workspaces.map((w) => [w.id, w]));
  const items = [];
  for (const s of state.sessions) {
    const ws = wsById[s.workspaceId];
    items.push({
      kind: "session",
      label: s.title || s.id,
      sub: `${s.harness} · ${ws ? ws.name : "?"} · ${s.activity || s.status || "?"}`,
      hay: `${s.title || ""} ${s.harness} ${ws ? ws.name + " " + ws.path : ""} ${s.id}`,
      run: () => activateSession(s.id),
    });
  }
  for (const w of state.workspaces) {
    items.push({
      kind: "workspace",
      label: w.name,
      sub: w.path,
      hay: `${w.name} ${w.path}`,
      run: () => {
        state.closedGroups.delete(w.id);
        renderWorkspaces();
        const el = document.querySelector(`[data-ws="${w.id}"]`);
        if (el) el.scrollIntoView({ block: "nearest" });
      },
    });
  }
  items.push(
    { kind: "action", label: "Open folder…", sub: "workspace", hay: "open folder workspace add", run: () => $("btnOpenFolder").click() },
    { kind: "action", label: "New console", sub: "terminal", hay: "new console terminal shell", run: () => $("btnNewConsole").click() },
  );
  return items;
}

function renderPal() {
  const list = $("palList");
  list.innerHTML = "";
  const scored = palItems()
    .map((it) => ({ it, score: fuzzyScore(it.hay, pal.q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  pal.items = scored.map((x) => x.it);
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  if (!pal.items.length) {
    list.innerHTML = '<div class="empty">no matches</div>';
    return;
  }
  pal.items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "pal-item" + (i === pal.sel ? " sel" : "");
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = it.kind === "session" ? "sess" : it.kind === "workspace" ? "ws" : "act";
    const lbl = document.createElement("span");
    lbl.textContent = it.label;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = it.sub || "";
    d.append(k, lbl, sub);
    d.onclick = () => { closePal(); it.run(); };
    d.onmousemove = () => { pal.sel = i; renderPal(); };
    list.appendChild(d);
  });
}

function openPal() {
  pal.open = true;
  pal.q = "";
  pal.sel = 0;
  $("palInput").value = "";
  $("palette").classList.remove("hidden");
  renderPal();
  setTimeout(() => $("palInput").focus(), 30);
}
function closePal() {
  pal.open = false;
  $("palette").classList.add("hidden");
}

$("palInput").addEventListener("input", (e) => {
  pal.q = e.target.value;
  pal.sel = 0;
  renderPal();
});
$("palInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); renderPal(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); renderPal(); }
  else if (e.key === "Enter") {
    const it = pal.items[pal.sel];
    if (it) { closePal(); it.run(); }
  } else if (e.key === "Escape") closePal();
});
$("palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePal(); });

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    pal.open ? closePal() : openPal();
  } else if (e.key === "Escape" && pal.open) closePal();
});

// ---------- boot ----------
(async function boot() {
  try {
    await refresh();
    status(REMOTE ? "connected via tunnel" : "local", location.host);
  } catch (e) {
    status("server unreachable", e.message);
  }
  health();
  setInterval(health, 15000);
  setInterval(refresh, 10000);
})();
