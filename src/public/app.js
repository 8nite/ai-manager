// app.js — AI Manager Mission Control frontend logic
// Coordinates multi-harness sessions (opencode web, dsh web, droid PTY),
// bottom consoles, quick switcher palette, and live dashboard metrics.

const $ = (id) => document.getElementById(id);

const state = {
  workspaces: [],
  sessions: [],
  consoles: [],
  activeSessionId: null,
  activeConsoleId: null,
  closedGroups: new Set(),
  activeFilter: "all", // 'all' | 'active' | 'waiting'
  renamingId: null, // session id currently inline-renaming in the left panel
  dismissedAttention: new Set(), // session ids dismissed from the attention shelf (re-arms on next waiting turn)
  attentionCollapsed: false, // Needs Attention shelf + dashboard feed collapsed (persists)
  conEs: null,
  conTerm: null,
  conFit: null,
  // Split-screen panes: [{ pid, sessionId, term, fit, es, seq }].
  // activeSessionId mirrors the focused pane (legacy call sites keep working).
  panes: [],
  activePanePid: null,
  layout: "cols", // 'cols' (side by side) | 'rows' (stacked)
  switchingIds: new Set(), // pane pids mid-activation (refresh skips sidebar re-render)
  switchingId: null, // legacy alias: switching session of the focused pane
};

const REMOTE = !["127.0.0.1", "localhost", "[::1]", ""].includes(location.hostname);
const hasXterm = typeof Terminal !== "undefined";

// ponytail: statusline deleted — status() kept as no-op so existing call sites stay harmless.
function status() {}

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
  try {
    const s = await api("GET", "/api/state");
    state.workspaces = s.workspaces || [];
    // Newest sessions first everywhere (sidebar, dashboard, palette).
    state.sessions = (s.sessions || []).slice().sort((a, b) => {
      const ta = a.createdAt || a.lastActiveAt || 0;
      const tb = b.createdAt || b.lastActiveAt || 0;
      return tb - ta;
    });
    state.consoles = s.consoles || [];
    pruneDismissedAttention();
    syncOpencodeTabs();

    // Prune panes whose session vanished (deleted workspace/session).
    const live = new Set(state.sessions.map((x) => x.id));
    let panesChanged = false;
    for (const p of state.panes) {
      if (p.sessionId && !live.has(p.sessionId)) {
        teardownPane(p);
        p.sessionId = null;
        panesChanged = true;
      }
      // Drop cached documents for vanished sessions everywhere (the
      // sidebar-minus path purges eagerly; background polling lands here).
      if (p._frameCache) {
        for (const sid of [...p._frameCache.keys()]) {
          if (!live.has(sid)) {
            try { p._frameCache.get(sid).remove(); } catch {}
            p._frameCache.delete(sid);
          }
        }
      }
    }
    if (!state.panes.length) ensurePane();
    syncLegacyActive();
    if (panesChanged || !state.panes.length) renderPanes();
    else updatePaneHeaders();
    updateEmptyOverlay();
    if (state.activeConsoleId && !state.consoles.find((x) => x.id === state.activeConsoleId)) {
      state.activeConsoleId = null;
    }

    renderAttentionShelf();
    // Skip sidebar + session-bar re-renders mid-rename so the edit input
    // keeps focus across the 8s background refresh (data still updates;
    // applied visually on commit/cancel). Same mid-switch: activateSession
    // already painted the optimistic highlight; re-rendering here would
    // destroy click targets and flicker the active row.
    if (!state.renamingId && state.switchingIds.size === 0 && !state.switchingId) renderWorkspaces();
    renderConsoles();
    renderDash();
    updateCounts();
    updatePaneHeaders();
    narrateTransitions();
    flushNarrateContent();
  } catch (e) {
    status("sync error", e.message);
  }
}

async function health() {
  try {
    const h = await api("GET", "/health");
    $("healthDot").className = "dot on";
    $("healthLabel").textContent = "Connected";
  } catch {
    $("healthDot").className = "dot off";
    $("healthLabel").textContent = "Offline";
  }
}

function updateCounts() {
  const countEl = $("sidebarCountPill");
  if (countEl) countEl.textContent = `${state.sessions.length}`;

  const waitingCount = visibleWaiting().length;
  const waitBadge = $("filterWaitCount");
  if (waitBadge) {
    waitBadge.textContent = `${waitingCount}`;
    waitBadge.classList.toggle("hidden", waitingCount === 0);
  }
}

// Format idle / activity duration
function fmtIdle(ms) {
  if (!ms || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// ---------- SIDEBAR & ATTENTION SHELF ----------

// Dismissed attention: per-session × on the shelf hides the card without
// deleting the session. Persists to localStorage; re-arms when the session
// leaves waiting (next waiting turn shows again) and clears on open.
const DISMISSED_KEY = "ai-manager.dismissedAttention";

function loadDismissedAttention() {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) state.dismissedAttention = new Set(arr.filter((x) => typeof x === "string"));
  } catch {}
}

function saveDismissedAttention() {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...state.dismissedAttention])); } catch {}
}

function pruneDismissedAttention() {
  const waitingIds = new Set(
    state.sessions.filter((s) => s.activity === "waiting").map((s) => s.id)
  );
  let changed = false;
  for (const id of [...state.dismissedAttention]) {
    if (!waitingIds.has(id)) { state.dismissedAttention.delete(id); changed = true; }
  }
  if (changed) saveDismissedAttention();
}

function dismissAttention(id) {
  if (!id || state.dismissedAttention.has(id)) return;
  state.dismissedAttention.add(id);
  saveDismissedAttention();
  renderAttentionShelf();
  renderDash();
  updateCounts();
}

// Collapsed Needs Attention: the shelf header + dashboard feed share one
// persisted flag. Collapsed hides the cards but keeps the header (with the
// waiting count) so the shelf still signals at a glance.
const ATTENTION_COLLAPSED_KEY = "ai-manager.attentionCollapsed";

function loadAttentionCollapsed() {
  try { state.attentionCollapsed = localStorage.getItem(ATTENTION_COLLAPSED_KEY) === "1"; } catch {}
}

function saveAttentionCollapsed() {
  try { localStorage.setItem(ATTENTION_COLLAPSED_KEY, state.attentionCollapsed ? "1" : "0"); } catch {}
}

function toggleAttentionCollapsed() {
  state.attentionCollapsed = !state.attentionCollapsed;
  saveAttentionCollapsed();
  renderAttentionShelf();
  renderDash();
}

function visibleWaiting() {
  return state.sessions.filter((s) => s.activity === "waiting" && !state.dismissedAttention.has(s.id));
}

function renderAttentionShelf() {
  const shelf = $("attentionShelf");
  if (!shelf) return;

  const waiting = visibleWaiting();
  if (!waiting.length || state.activeFilter === "active") {
    shelf.classList.add("hidden");
    shelf.innerHTML = "";
    return;
  }

  shelf.classList.remove("hidden");
  shelf.classList.toggle("collapsed", state.attentionCollapsed);
  shelf.innerHTML = `
    <button class="shelf-header shelf-toggle" aria-expanded="${state.attentionCollapsed ? "false" : "true"}" title="${state.attentionCollapsed ? "Expand" : "Collapse"} Needs Attention">
      <span class="caret" aria-hidden="true">▼</span>
      <span class="pulse-spark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg></span>
      <span>Needs Attention (${waiting.length})</span>
    </button>
  `;
  shelf.querySelector(".shelf-toggle").onclick = () => toggleAttentionCollapsed();
  if (state.attentionCollapsed) return;

  const wsById = Object.fromEntries(state.workspaces.map((w) => [w.id, w]));
  for (const s of waiting) {
    const card = document.createElement("div");
    card.className = "shelf-card" + (s.id === state.activeSessionId ? " active" : "");
    card.dataset.sess = s.id;
    const ws = wsById[s.workspaceId];

    card.innerHTML = `
      <div class="shelf-card-top">
        <span class="sdot waiting"></span>
        <span class="shelf-card-title">${escapeHtml(s.title || s.id)}</span>
        <button class="shelf-dismiss" title="Dismiss" aria-label="Dismiss attention for ${escapeHtml(s.title || s.id)}">×</button>
      </div>
      <div class="shelf-card-sub">
        <span>${escapeHtml(ws ? ws.name : "Workspace")}</span>
        <span>idle ${fmtIdle(s.idleMs)}</span>
      </div>
    `;
    card.onclick = () => activateSession(s.id);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.onkeydown = (e) => { if (e.target.closest(".shelf-dismiss")) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateSession(s.id); } };
    card.querySelector(".shelf-dismiss").onclick = (e) => {
      e.stopPropagation();
      dismissAttention(s.id);
    };
    shelf.appendChild(card);
  }
}

function renderWorkspaces() {
  const el = $("wsList");
  if (!el) return;

  // Keyed reconcile: workspace groups + session rows are reused in place —
  // never a wholesale el.innerHTML rebuild — so rename inputs keep focus,
  // hover buttons keep their click targets, and the 8s poll is a no-op when
  // nothing changed.
  if (!state.workspaces.length) {
    if (!el._emptyWs) {
      el.innerHTML = `
      <div class="empty-state-text">
        <p>No workspaces open.</p>
        <p style="margin-top:4px;">Click <b>Open Folder</b> to get started.</p>
      </div>
    `;
      el._emptyWs = true;
    }
    return;
  }
  el._emptyWs = false;

  const wanted = [];
  for (const ws of state.workspaces) {
    let sess = state.sessions.filter((s) => s.workspaceId === ws.id);

    // Apply active filter
    if (state.activeFilter === "active") {
      sess = sess.filter((s) => s.activity === "working" || s.activity === "running");
    } else if (state.activeFilter === "waiting") {
      sess = sess.filter((s) => s.activity === "waiting");
    }

    // If filtering and this workspace has no matches, skip
    if (state.activeFilter !== "all" && !sess.length) continue;
    wanted.push({ ws, sess });
  }

  const live = new Map();
  [...el.children].forEach((c) => { if (c.dataset && c.dataset.ws) live.set(c.dataset.ws, c); });
  for (const [id, g] of live) {
    if (!wanted.some((w) => w.ws.id === id)) { g.remove(); live.delete(id); }
  }
  wanted.forEach(({ ws, sess }, i) => {
    let group = live.get(ws.id);
    if (!group) {
      group = document.createElement("div");
      group.dataset.ws = ws.id;
      group.innerHTML = `<div class="ws-head"></div><ul class="ws-sessions"></ul>`;
      live.set(ws.id, group);
    }
    if (el.children[i] !== group) el.insertBefore(group, el.children[i] || null);
    updateWsGroup(group, ws, sess);
  });
  // Drop trailing non-group nodes (stale empty states).
  [...el.children].forEach((c) => { if (!(c.dataset && c.dataset.ws)) c.remove(); });
}

function updateWsGroup(group, ws, sess) {
  if (!group.classList.contains("ws-group")) group.classList.add("ws-group");
  group.classList.toggle("closed", state.closedGroups.has(ws.id));

  const head = group.querySelector(":scope > .ws-head");
  const hsig = [ws.name, ws.path, sess.length].join("");
  if (head._sig !== hsig) {
    head._sig = hsig;
    head.innerHTML = `
      <span class="caret" aria-hidden="true">▼</span>
      <svg viewBox="0 0 24 24" class="svg-icon ws-folder-icon"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      <div class="ws-info">
        <span class="ws-name">${escapeHtml(ws.name)}</span>
        <span class="ws-path" title="${escapeHtml(ws.path)}">${escapeHtml(ws.path)}</span>
      </div>
      <span class="ws-count-badge">${sess.length}</span>
      <div class="ws-head-actions">
        <button class="ws-action-btn add" title="New session in ${escapeHtml(ws.name)}" aria-label="New session in ${escapeHtml(ws.name)}">+</button>
        <button class="ws-action-btn del" title="Remove workspace" aria-label="Remove workspace">×</button>
      </div>
    `;

    // Click events
    head.onclick = (e) => {
      if (e.target.closest(".ws-head-actions")) return;
      if (state.closedGroups.has(ws.id)) state.closedGroups.delete(ws.id);
      else state.closedGroups.add(ws.id);
      group.classList.toggle("closed");
    };

    const addBtn = head.querySelector(".ws-action-btn.add");
    addBtn.onclick = (e) => {
      e.stopPropagation();
      quickCreateSession(ws.id);
    };

    const delBtn = head.querySelector(".ws-action-btn.del");
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const n = state.sessions.filter((s) => s.workspaceId === ws.id).length;
      if (!confirm(`Remove workspace "${ws.name}" and delete its ${n} session(s)?`)) return;
      await api("DELETE", `/api/workspaces/${ws.id}`).catch(() => {});
      const gone = new Set(state.sessions.filter((s) => s.workspaceId === ws.id).map((s) => s.id));
      for (const p of state.panes) {
        if (p.sessionId && gone.has(p.sessionId)) {
          teardownPane(p);
          p.sessionId = null;
        }
      }
      for (const gid of gone) purgeSessionFrames(gid);
      activateSeq++;
      state.switchingIds.clear();
      state.switchingId = null;
      syncLegacyActive();
      hideStageLoader();
      renderPanes();
      updateEmptyOverlay();
      refresh();
    };
  }

  const ul = group.querySelector(":scope > .ws-sessions");
  const rows = new Map();
  [...ul.children].forEach((li) => { if (li.dataset && li.dataset.sess) rows.set(li.dataset.sess, li); });
  if (!sess.length) {
    for (const [, li] of rows) li.remove();
    if (!ul._empty) {
      ul.innerHTML = "";
      const li = document.createElement("li");
      li.className = "empty-state-text";
      li.dataset.empty = "1";
      li.textContent = "No sessions — click + to create";
      ul.appendChild(li);
      ul._empty = true;
    }
    return;
  }
  ul._empty = false;
  [...ul.children].forEach((li) => {
    if (li.dataset && li.dataset.empty) { li.remove(); return; }
    const id = li.dataset && li.dataset.sess;
    if (id && !sess.some((s) => s.id === id)) li.remove();
  });
  sess.forEach((s, i) => {
    let li = ul.querySelector(`:scope > [data-sess="${s.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.sess = s.id;
      wireSessRow(li, s.id);
    }
    const ref = ul.children[i];
    if (ref !== li) ul.insertBefore(li, ref || null);
    updateSessRow(li, s);
  });
}

function wireSessRow(li, id) {
  li.onclick = (e) => {
    if (e.target.closest(".sess-del-hover") || e.target.closest(".sess-rename-hover") || e.target.closest(".sess-split-hover") || e.target.closest(".sess-rename-input")) return;
    activateSession(id);
  };
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.ondblclick = (e) => {
    if (e.target.closest(".sess-del-hover") || e.target.closest(".sess-rename-hover") || e.target.closest(".sess-split-hover") || e.target.closest(".sess-rename-input")) return;
    startRename(id);
  };
  li.onkeydown = (e) => {
    if (e.target.closest(".sess-del-hover") || e.target.closest(".sess-rename-hover") || e.target.closest(".sess-split-hover") || e.target.closest(".sess-rename-input")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateSession(id); }
    else if (e.key === "F2") { e.preventDefault(); startRename(id); }
  };

  const splitBtn = li.querySelector(".sess-split-hover");
  if (splitBtn) splitBtn.onclick = (e) => {
    e.stopPropagation();
    openInSplit(id);
  };

  const renameBtn = li.querySelector(".sess-rename-hover");
  if (renameBtn) renameBtn.onclick = (e) => {
    e.stopPropagation();
    if (state.renamingId === id) cancelRename();
    else startRename(id);
  };

  const delSessBtn = li.querySelector(".sess-del-hover");
  if (delSessBtn) delSessBtn.onclick = async (e) => {
    e.stopPropagation();
    // No confirm: removing a session from the panel is one click by design.
    await api("DELETE", `/api/sessions/${id}`).catch(() => {});
    for (const p of state.panes) {
      if (p.sessionId === id || p.sessionId === state.switchingId) {
        teardownPane(p);
        p.sessionId = null;
      }
    }
    purgeSessionFrames(id);
    activateSeq++;
    state.switchingIds.clear();
    state.switchingId = null;
    syncLegacyActive();
    hideStageLoader();
    renderPanes();
    updateEmptyOverlay();
    refresh();
  };

  const input = li.querySelector(".sess-rename-input");
  if (input) {
    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commitRename(id, input.value);
      else if (e.key === "Escape") cancelRename();
    };
    input.onblur = () => commitRename(id, input.value);
  }
  li._wired = true;
}

function updateSessRow(li, s) {
  const inPane = state.panes.some((p) => p.sessionId === s.id);
  const dotClass = s.activity || s.status || "starting";
  const idleText = s.idleMs ? `idle ${fmtIdle(s.idleMs)}` : (s.activity === "working" ? "active" : "");
  const editing = state.renamingId === s.id;
  const cls = "sess" + (s.id === state.activeSessionId ? " active" : "") + (inPane && s.id !== state.activeSessionId ? " in-pane" : "");
  const sig = [cls, dotClass, idleText, s.title || s.id, s.error || "", editing].join("");
  if (li._sig === sig) return;
  const hadInput = !!li.querySelector(".sess-rename-input");
  if (hadInput === editing && li._wired && li.childElementCount > 0) {
    // Same structure: patch text in place, keep every node (and input focus).
    if (li.className !== cls) li.className = cls;
    const dot = li.querySelector(":scope > .sdot");
    if (dot) {
      const dc = "sdot " + dotClass;
      if (dot.className !== dc) dot.className = dc;
      dot.title = `${s.activity || s.status || "?"}${s.error ? ": " + s.error : ""}`;
    }
    if (!editing) {
      const lbl = li.querySelector(":scope > .lbl");
      if (lbl) {
        const t = s.title || s.id;
        if (lbl.textContent !== t) lbl.textContent = t;
        lbl.title = `${t} — double-click to rename`;
      }
    }
    const idle = li.querySelector(":scope > .idle");
    if (idle && idle.textContent !== idleText) idle.textContent = idleText;
    li._sig = sig;
    return;
  }
  li.className = cls;
  li.innerHTML = `
        <span class="sdot ${dotClass}" title="${s.activity || s.status || "?"}${s.error ? ": " + s.error : ""}"></span>
        ${editing
          ? `<input class="sess-rename-input" value="${escapeHtml(s.title || "")}" maxlength="120" aria-label="Rename session">`
          : `<span class="lbl" title="${escapeHtml(s.title || s.id)} — double-click to rename">${escapeHtml(s.title || s.id)}</span>`}
        <span class="idle">${idleText}</span>
        <button class="sess-split-hover" title="Open in split pane" aria-label="Open in split pane">
          <svg viewBox="0 0 24 24" class="svg-icon" style="width:12px;height:12px;"><path d="M12 4v16M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <button class="sess-rename-hover" title="Rename session" aria-label="Rename session">
          <svg viewBox="0 0 24 24" class="svg-icon" style="width:12px;height:12px;"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <button class="sess-del-hover" title="Remove session from workspace" aria-label="Remove session from workspace">−</button>
      `;
  wireSessRow(li, s.id);
  if (editing) {
    // Focus after insertion into the DOM.
    setTimeout(() => { try { const inp = li.querySelector(".sess-rename-input"); if (inp) { inp.focus(); inp.select(); } } catch {} }, 0);
  }
  li._sig = sig;
}


function startRename(id) {
  state.renamingId = id;
  renderWorkspaces();
}

function cancelRename() {
  state.renamingId = null;
  renderWorkspaces();
}

async function commitRename(id, rawTitle) {
  const next = String(rawTitle ?? "").trim().replace(/\s+/g, " ");
  // Blur fires after Enter-commit already cleared the mode — ignore the echo.
  if (state.renamingId !== id) return;
  state.renamingId = null;
  const cur = state.sessions.find((x) => x.id === id);
  if (!next || (cur && next === cur.title)) {
    renderWorkspaces();
    return;
  }
  try {
    const updated = await api("PATCH", `/api/sessions/${id}`, { title: next });
    if (cur && updated) Object.assign(cur, updated);
    status("renamed", next);
  } catch (e) {
    status("rename failed", e.message);
  }
  renderWorkspaces();
  renderDash();
  renderAttentionShelf();
}

// Setup Filter Pills
document.querySelectorAll(".filter-pill").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".filter-pill").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeFilter = btn.dataset.filter;
    renderAttentionShelf();
    renderWorkspaces();
  };
});

// ---------- MAIN STAGE ----------

// Render Dashboard when on empty stage
function renderDash() {
  const mTotal = $("mTotalSessions");
  const mBreakdown = $("mBreakdown");
  const mWorking = $("mActiveWorking");
  const mWaiting = $("mNeedsAttention");
  const mWs = $("mWorkspaces");
  const mCardWait = $("mCardWaiting");

  const total = state.sessions.length;
  const webCount = state.sessions.filter((s) => s.mode === "web").length;
  const termCount = state.sessions.filter((s) => s.mode === "pty").length;
  const working = state.sessions.filter((s) => s.activity === "working" || s.activity === "running").length;
  const waiting = visibleWaiting().length;

  if (mTotal) mTotal.textContent = `${total}`;
  if (mBreakdown) mBreakdown.textContent = `${webCount} web · ${termCount} terminal`;
  if (mWorking) mWorking.textContent = `${working}`;
  if (mWaiting) mWaiting.textContent = `${waiting}`;
  if (mWs) mWs.textContent = `${state.workspaces.length}`;

  if (mCardWait) {
    mCardWait.style.borderColor = waiting > 0 ? "rgba(245, 158, 11, 0.5)" : "";
  }

  // Attention Feed Section in Dashboard
  const attSection = $("dashAttentionSection");
  const attList = $("dashAttentionList");
  if (attSection && attList) {
    const waitingSessions = visibleWaiting();
    if (waitingSessions.length > 0) {
      attSection.classList.remove("hidden");
      attSection.classList.toggle("collapsed", state.attentionCollapsed);
      const attToggle = $("dashAttentionToggle");
      if (attToggle) attToggle.setAttribute("aria-expanded", state.attentionCollapsed ? "false" : "true");
      attList.innerHTML = "";
      const wsById = Object.fromEntries(state.workspaces.map((w) => [w.id, w]));

      for (const s of waitingSessions) {
        const ws = wsById[s.workspaceId];
        const card = document.createElement("div");
        card.className = "dash-att-card";
        card.innerHTML = `
          <div class="dash-att-card-head">
            <span class="tag ${s.harness}">${s.harness}</span>
            <span class="dash-att-ws">${escapeHtml(ws ? ws.name : "Workspace")} · idle ${fmtIdle(s.idleMs)}</span>
          </div>
          <div class="dash-att-title">${escapeHtml(s.title || s.id)}</div>
        `;
        card.onclick = () => activateSession(s.id);
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateSession(s.id); } };
        attList.appendChild(card);
      }
    } else {
      attSection.classList.add("hidden");
    }
  }

  // Workspaces Grid in Dashboard
  const grid = $("dashGrid");
  if (!grid) return;
  grid.innerHTML = "";

  if (!state.workspaces.length) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 30px; text-align: center; color: var(--text-faint);">
        No workspaces opened yet. Click <b>Open Workspace Folder</b> above to begin.
      </div>
    `;
    return;
  }

  for (const ws of state.workspaces) {
    const card = document.createElement("div");
    card.className = "dash-ws-card";
    const sess = state.sessions.filter((s) => s.workspaceId === ws.id);

    let sessionChipsHtml = "";
    if (sess.length) {
      sessionChipsHtml = sess.slice(0, 4).map((s) => `
        <div class="dash-sess-chip" data-id="${s.id}">
          <span class="sdot ${s.activity || s.status || "starting"}"></span>
          <span class="tag ${s.harness}">${s.harness}</span>
          <span class="lbl">${escapeHtml(s.title || s.id)}</span>
          <span class="idle">${fmtIdle(s.idleMs)}</span>
        </div>
      `).join("");
      if (sess.length > 4) {
        sessionChipsHtml += `<span style="font-size:11px;color:var(--text-faint);padding-left:4px;">+ ${sess.length - 4} more sessions</span>`;
      }
    } else {
      sessionChipsHtml = `<div style="font-size:11.5px;color:var(--text-faint);padding:6px 0;">No active sessions in this workspace.</div>`;
    }

    card.innerHTML = `
      <div class="dash-ws-top">
        <div>
          <div class="dash-ws-name">${escapeHtml(ws.name)}</div>
          <div class="dash-ws-path" title="${escapeHtml(ws.path)}">${escapeHtml(ws.path)}</div>
        </div>
        <span class="ws-count-badge">${sess.length}</span>
      </div>
      <div class="dash-ws-sessions-list">${sessionChipsHtml}</div>
      <div class="dash-ws-card-actions">
        <button class="primary-btn btn-card-add">+ Session</button>
      </div>
    `;

    // Event listeners on card buttons
    card.querySelector(".btn-card-add").onclick = () => quickCreateSession(ws.id);

    card.querySelectorAll(".dash-sess-chip").forEach((chip) => {
      chip.onclick = () => activateSession(chip.dataset.id);
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateSession(chip.dataset.id); } };
    });

    grid.appendChild(card);
  }
}

// ---------- SPLIT-SCREEN PANES ----------
// Each pane owns one session view (web iframe or pty xterm). Concurrent web
// panes work because the proxy injects a per-session API scope
// (see proxy.js injectApiScope): every iframe routes its /api + WS traffic
// to /s/:id/* explicitly instead of sharing the aimgr_active cookie.
const PANES_KEY = "ai-manager.panes";
const LAYOUT_KEY = "ai-manager.layout";
// Session-switch cache: keep the last few web views alive per pane so
// switching back is instant (show/hide, no reload). Evicted iframes are
// removed from the DOM; the live backend keeps running either way.
const FRAME_CACHE_N = 3;

function ensureFrameCache(p) {
  if (!p._frameCache) p._frameCache = new Map();
  return p._frameCache;
}

// Drop every cached iframe for a deleted session (all panes).
function purgeSessionFrames(id) {
  if (!id) return;
  if (narrate.webObservedId === id) stopWebNarration();
  for (const p of state.panes) {
    if (!p._frameCache) continue;
    const f = p._frameCache.get(id);
    if (f) {
      try { f.remove(); } catch {}
      p._frameCache.delete(id);
    }
  }
}

function attachFrameListeners(p, frame) {
  frame.addEventListener("focus", () => focusPane(p.pid));
  frame.addEventListener("load", () => {
    // Ignore the initial about:blank commit: appending a fresh iframe fires
    // load for its blank document (~10ms) before the backend document
    // arrives. Acting on it hides the stage loader instantly and narrates an
    // empty page. Same-origin (proxied) frames expose location; anything
    // unreadable falls through to the legacy handling below.
    try {
      const w = frame.contentWindow;
      const href = w && w.location && w.location.href;
      if (href === "about:blank") return;
    } catch {}
    if (p.sessionId && getActivePane() && getActivePane().pid === p.pid) {
      const s = state.sessions.find((x) => x.id === p.sessionId);
      if (s && s.mode === "web") hideStageLoader();
      observeActivePane(); // (re)target transcript narration on every document load
    }
  });
}

function forceFrameReload(frame, sessionId) {
  // Always reload via the session-root prefix (/s/:id/) so the proxy
  // re-injects the route shim, web defaults, no-titlebar CSS, and api-scope:
  // after the SPA route shim rewrites location to /server/:key/session/:hid,
  // a bare location.reload() would hit fallbackMiddleware without shims.
  try {
    frame.src = `/s/${sessionId}/`;
    return;
  } catch {}
  try {
    if (frame.contentWindow && frame.contentWindow.location) {
      frame.contentWindow.location.reload();
    }
  } catch {}
}

function paneUid() {
  try {
    if (window.crypto && crypto.randomUUID) return "pane_" + crypto.randomUUID().slice(0, 8);
  } catch {}
  return "pane_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function getPane(pid) {
  return state.panes.find((p) => p.pid === pid) || null;
}

function getActivePane() {
  return getPane(state.activePanePid) || state.panes[0] || null;
}

function ensurePane() {
  if (!state.panes.length) {
    const p = { pid: paneUid(), sessionId: null, term: null, fit: null, es: null, seq: 0 };
    state.panes.push(p);
    state.activePanePid = p.pid;
  } else if (!getPane(state.activePanePid)) {
    state.activePanePid = state.panes[0].pid;
  }
  return getActivePane();
}

function syncLegacyActive() {
  const a = getActivePane();
  state.activePanePid = a ? a.pid : null;
  state.activeSessionId = a ? a.sessionId : null;
  const sw = [...state.switchingIds][0];
  state.switchingId = sw ? (getPane(sw) ? getPane(sw).sessionId : null) : state.switchingId;
  if (!state.switchingIds.size) state.switchingId = null;
}

function savePaneLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, state.layout);
    localStorage.setItem(PANES_KEY, JSON.stringify(state.panes.map((p) => ({ pid: p.pid, sessionId: p.sessionId }))));
  } catch {}
}

function restorePaneLayout() {
  try {
    const l = localStorage.getItem(LAYOUT_KEY);
    if (l === "cols" || l === "rows") state.layout = l;
    const raw = localStorage.getItem(PANES_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return;
    state.panes = arr.slice(0, 4).map((x) => ({
      pid: (x && x.pid) || paneUid(),
      sessionId: (x && x.sessionId) || null,
      term: null, fit: null, es: null, seq: 0,
    }));
    state.activePanePid = state.panes[0].pid;
  } catch {}
}

function teardownPane(p) {
  if (!p) return;
  if (p.es) { try { p.es.close(); } catch {} p.es = null; }
  if (p.term) { try { p.term.dispose(); } catch {} p.term = null; p.fit = null; }
}

function teardownMain() {
  // Legacy entry point (brand home, workspace/session delete): reset to a
  // single empty pane. Per-pane teardown keeps concurrent views independent.
  for (const p of state.panes) teardownPane(p);
  state.panes = [{ pid: paneUid(), sessionId: null, term: null, fit: null, es: null, seq: 0 }];
  state.activePanePid = state.panes[0].pid;
  state.switchingIds.clear();
  state.switchingId = null;
  syncLegacyActive();
  hideStageLoader();
  renderPanes();
  updateEmptyOverlay();
  savePaneLayout();
}

// Non-destructive loading pill over the stage: old content stays visible
// underneath until the new session commits (no blank teardown gap).
function ensureStageLoader() {
  let el = $("stageLoader");
  if (el) return el;
  el = document.createElement("div");
  el.id = "stageLoader";
  el.className = "hidden";
  el.innerHTML = `<span class="stage-loader-spin" aria-hidden="true"></span><span id="stageLoaderText">switching…</span>`;
  $("stage").appendChild(el);
  return el;
}

function showStageLoader(text) {
  const el = ensureStageLoader();
  const t = $("stageLoaderText");
  if (t && text) t.textContent = text;
  el.classList.remove("hidden");
}

function hideStageLoader() {
  const el = $("stageLoader");
  if (el) el.classList.add("hidden");
}

function focusActiveView() {
  try {
    const a = getActivePane();
    if (a && a.term) a.term.focus();
  } catch {}
}

// Monotonic activation token: rapid clicks interleave async ensure/touch,
// so stale activations must not overwrite the newest selection.
let activateSeq = 0;

// Mobile drawer: selecting a session/shelf item dismisses the overlay
// sidebar so the stage is visible (no backdrop — just remove .open).
function dismissMobileSidebar() {
  try {
    if (window.matchMedia("(max-width: 768px)").matches) $("left").classList.remove("open");
  } catch {}
}

// Pane grid rendering. Each pane keeps its own iframe/xterm nodes across
// re-renders keyed by data-pane, so typing/scroll state survives sidebar
// polls; only headers + empty overlay repaint on refresh.
function renderPanes() {
  ensurePane();
  const grid = $("paneGrid");
  if (!grid) return;
  const keep = new Map();
  [...grid.children].forEach((el) => { if (el.dataset && el.dataset.pane) keep.set(el.dataset.pane, el); });
  grid.innerHTML = "";
  grid.classList.toggle("rows", state.layout === "rows");
  grid.classList.toggle("cols", state.layout !== "rows");
  grid.style.gridTemplateColumns = state.layout === "rows" ? "" : `repeat(${state.panes.length}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = state.layout === "rows" ? `repeat(${state.panes.length}, minmax(0, 1fr))` : "";

  for (const p of state.panes) {
    let el = keep.get(p.pid);
    if (!el) {
      el = document.createElement("div");
      el.className = "pane";
      el.dataset.pane = p.pid;
      el.innerHTML = `
        <div class="pane-header">
          <select class="pane-select" aria-label="Session for this pane"></select>
          <button class="pane-x" title="Close this pane" aria-label="Close this pane">×</button>
        </div>
        <div class="pane-body">
          <iframe class="pane-frame hidden" title="Harness Web UI"></iframe>
          <div class="pane-term hidden"></div>
          <div class="pane-empty hidden">
            <div class="pane-empty-title">No session in this pane</div>
            <div class="pane-empty-sub">Pick from the sidebar or the dropdown above.</div>
          </div>
        </div>`;
      el.querySelector(".pane-x").onclick = (e) => { e.stopPropagation(); closePane(p.pid); };
      el.querySelector(".pane-select").onchange = (e) => {
        const v = e.target.value;
        focusPane(p.pid);
        if (v) setPaneSession(p, v);
        else { teardownPane(p); p.sessionId = null; syncLegacyActive(); paintPane(p); updateEmptyOverlay(); savePaneLayout(); renderWorkspaces(); }
      };
      el.addEventListener("pointerdown", () => focusPane(p.pid));
      // NB: web views live in the per-pane frame cache (see paintPane /
      // attachFrameListeners), which wires its own focus tracking — the
      // static iframe above stays hidden once caching takes over.
      el.querySelector(".pane-frame").addEventListener("load", () => {
        try {
          const w = el.querySelector(".pane-frame").contentWindow;
          const href = w && w.location && w.location.href;
          if (href === "about:blank") return;
        } catch {}
        if (p.sessionId && getActivePane() && getActivePane().pid === p.pid) {
          const s = state.sessions.find((x) => x.id === p.sessionId);
          if (s && s.mode === "web") hideStageLoader();
        }
      });
    }
    el.classList.toggle("focused", p.pid === state.activePanePid);
    grid.appendChild(el);
    p._el = el;
    paintPane(p);
  }
  updatePaneHeaders();
  updateEmptyOverlay();
  const pc = $("paneCount");
  if (pc) pc.textContent = `${state.panes.length}`;
  const cb = $("btnClosePane");
  if (cb) cb.disabled = state.panes.length <= 1;
}

function paneSessionLabel(s) {
  if (!s) return "";
  return `${s.title || s.id} · ${s.harness}`;
}

function updatePaneHeaders() {
  const grid = $("paneGrid");
  if (!grid) return;
  for (const p of state.panes) {
    const el = p._el || grid.querySelector(`[data-pane="${p.pid}"]`);
    if (!el) continue;
    const sel = el.querySelector(".pane-select");
    if (!sel) continue;
    // Rebuild options only when the session list changed (cheap: compare ids).
    const sig = state.sessions.map((s) => s.id).join(",") + "|" + (p.sessionId || "");
    if (sel._sig === sig) continue;
    sel._sig = sig;
    sel.innerHTML = `<option value="">— No session —</option>` + state.sessions.map((s) =>
      `<option value="${s.id}"${s.id === p.sessionId ? " selected" : ""}>${escapeHtml(paneSessionLabel(s))}</option>`
    ).join("");
  }
  const pc = $("paneCount");
  if (pc) pc.textContent = `${state.panes.length}`;
}

function paintPane(p) {
  const el = p._el;
  if (!el) return;
  const cache = ensureFrameCache(p);
  const body = el.querySelector(".pane-body") || el;
  // Adopt the static iframe from renderPanes into the cache once (back-compat
  // with existing DOM); afterwards all web views live in the cache.
  if (!cache.size) {
    const staticFrame = el.querySelector(".pane-frame");
    if (staticFrame && staticFrame.dataset && staticFrame.dataset.sess) {
      cache.set(staticFrame.dataset.sess, staticFrame);
    }
  }
  const s = p.sessionId ? state.sessions.find((x) => x.id === p.sessionId) : null;
  const termBox = el.querySelector(".pane-term");
  const empty = el.querySelector(".pane-empty");
  const sel = el.querySelector(".pane-select");
  if (sel && sel.value !== (p.sessionId || "")) {
    // Keep dropdown in sync when activation came from the sidebar/palette.
    sel._sig = null;
  }
  if (!s) {
    for (const f of cache.values()) f.classList.add("hidden");
    termBox.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  if (s.mode === "web") {
    syncOpencodeTabs();
    termBox.classList.add("hidden");
    let frame = cache.get(p.sessionId);
    if (!frame || !frame.isConnected) {
      const samePort = s.harnessSessionId ? clientSwitchFrame(p, s) : null;
      if (samePort) {
        frame = samePort;
        retargetFrameCache(p, frame, p.sessionId);
        clientSwitchSession(frame, s.harnessSessionId);
      } else {
        frame = document.createElement("iframe");
        frame.className = "pane-frame hidden";
        frame.title = "Harness Web UI";
        frame.dataset.sess = p.sessionId;
        attachFrameListeners(p, frame);
        body.appendChild(frame);
        frame.src = `/s/${p.sessionId}/`;
        cache.set(p.sessionId, frame);
      }
    } else {
      // Refresh LRU order: recent use moves to the end.
      cache.delete(p.sessionId);
      cache.set(p.sessionId, frame);
      if (s.harnessSessionId) {
        try {
          if (frame.contentWindow && !String(frame.contentWindow.location.href).includes(String(s.harnessSessionId))) {
            clientSwitchSession(frame, s.harnessSessionId);
          }
        } catch {}
      }
    }
    for (const [sid, f] of cache) {
      if (sid === p.sessionId) f.classList.remove("hidden");
      else f.classList.add("hidden");
    }
    // Evict oldest beyond the keep-N budget (never the active view).
    while (cache.size > FRAME_CACHE_N) {
      const oldest = cache.keys().next().value;
      if (oldest === p.sessionId) break;
      const f = cache.get(oldest);
      try { f && f.remove(); } catch {}
      cache.delete(oldest);
    }
  } else {
    for (const f of cache.values()) f.classList.add("hidden");
    termBox.classList.remove("hidden");
    if (!p.term) attachPaneTerm(p, p.sessionId);
  }
}

// True when this pane can show the session without any load: cached web
// iframe + locally healthy. Used to skip the stage loader entirely.
function isFrameCached(p, id) {
  const f = p && p._frameCache && p._frameCache.get(id);
  return !!(f && f.isConnected);
}

// Sync manager opencode sessions into opencode web's window-tab store
// (`opencode.window.browser.dat:tabs` + `tabs.info`).
//
// Opencode web's titlebar (<AA> in index-*.js, mounted even when hidden via
// CSS) pre-syncs `session.sync(id, {children:true})`, permissions, forms,
// pending inbox, and ComposerState for every tab in `tabs`. Seeding all
// manager opencode chats here means `m.session.info[id]` (incl.
// `location.directory`) is already warm before a route switch — so
// <Show when={directory}> in TargetSessionRouteContent never unmounts/reinits
// the session view tree when switching sessions.
const OC_TABS_KEY = "opencode.window.browser.dat:tabs";
const OC_TABS_INFO_KEY = "opencode.window.browser.dat:tabs.info";

function syncOpencodeTabs() {
  try {
    const key = opencodeServerKey();
    const srv = location.origin;
    if (!key || !srv) return;
    const wsById = Object.fromEntries((state.workspaces || []).map((w) => [w.id, w]));
    const opSessions = (state.sessions || []).filter(
      (s) => s && s.harness === "opencode" && s.mode === "web" && s.harnessSessionId
    );
    if (!opSessions.length) return;
    let existing = [];
    try {
      const raw = localStorage.getItem(OC_TABS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) existing = parsed;
    } catch {}
    const drafts = existing.filter((t) => t && t.type === "draft");
    const tabs = [
      ...opSessions.map((s) => ({
        type: "session",
        server: srv,
        sessionId: s.harnessSessionId,
      })),
      ...drafts,
    ];
    localStorage.setItem(OC_TABS_KEY, JSON.stringify(tabs));

    let info = {};
    try {
      const rawInfo = localStorage.getItem(OC_TABS_INFO_KEY);
      const parsedInfo = rawInfo ? JSON.parse(rawInfo) : {};
      if (parsedInfo && typeof parsedInfo === "object" && !Array.isArray(parsedInfo)) info = parsedInfo;
    } catch {}
    const liveKeys = new Set();
    for (const s of opSessions) {
      const ws = wsById[s.workspaceId];
      const dir = (ws && ws.path) || "";
      if (!dir) continue;
      const tk = `${srv}\n/server/${key}/session/${s.harnessSessionId}`;
      liveKeys.add(tk);
      const prev = info[tk];
      info[tk] = {
        title: s.title || (prev && prev.title) || s.id,
        directory: dir,
        prompted: !!(prev && prev.prompted),
      };
    }
    for (const k of Object.keys(info)) {
      if (!liveKeys.has(k)) delete info[k];
    }
    localStorage.setItem(OC_TABS_INFO_KEY, JSON.stringify(info));
  } catch {}
}

// Client-side web session switching: one live SPA per pane.
//
// The opencode SPA owns a client router (/server/:key/session/:id): pushing
// it to another chat swaps the view with data fetches only — no document
// reload, no bundle re-parse, no new SSE stream. The manager therefore keeps
// ONE live web frame per pane and navigates it on same-backend switches
// (always true while all opencode sessions share one backend port); anything
// else (unreadable frame, missing chat binding, backend mismatch, unverified
// nav) falls back to the full document load.
function frameSessionPort(pane, frame) {
  try {
    const sid = frame && frame.dataset && frame.dataset.sess;
    const rec = sid && state.sessions.find((x) => x.id === sid);
    return (rec && rec.port) || null;
  } catch { return null; }
}

function visibleWebFrame(pane) {
  try {
    const el = pane && pane._el;
    let f = el && [...el.querySelectorAll(".pane-frame")].find((x) => !x.classList.contains("hidden"));
    // Also recover the cached web frame when the pane temporarily showed a
    // PTY session (which hid all .pane-frame nodes without destroying them).
    if (!f && pane && pane._frameCache) {
      f = [...pane._frameCache.values()].reverse().find((x) => x && x.isConnected);
    }
    if (!f || !f.isConnected) return null;
    const href = f.contentWindow && f.contentWindow.location && f.contentWindow.location.href;
    if (!href || href === "about:blank") return null;
    return f;
  } catch { return null; }
}

function clientSwitchFrame(pane, target) {
  if (!target || target.mode !== "web" || !target.port) return null;
  const f = visibleWebFrame(pane);
  if (!f) return null;
  if (frameSessionPort(pane, f) !== target.port) return null; // cross-backend: full load
  return f;
}

function opencodeServerKey() {
  try {
    return btoa(location.origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch { return null; }
}

// True when the live opencode SPA in `w` has settled on `hid`: either a fresh
// backend fetch for `hid` arrived (cold chat) OR opencode's reactive Tabs +
// Router marked `hid` active with the session chat mounted (warm switch-back
// or SSE-created chat where opencode's one-shot message store makes zero
// repeat network requests).
function isSpaRoutedTo(w, hid, seenMsg, seenSess) {
  try {
    const doc = w.document;
    if (!doc || !doc.body) return false;
    if (String(doc.body.innerText || "").includes("Unrecognised route!")) return false;
    const msgUrl = `/api/session/${hid}/message`;
    const sessUrl = `/api/session/${hid}`;
    const entries = w.performance.getEntriesByType("resource");
    let curMsg = 0, curSess = 0;
    for (const r of entries) {
      const u = String(r.name || "");
      if (u.includes(msgUrl)) curMsg++;
      else if (u.endsWith(sessUrl) || u.includes(`${sessUrl}?`)) curSess++;
    }
    if ((seenMsg >= 0 && curMsg > seenMsg) || (seenSess >= 0 && curSess > seenSess)) return true;
    const activeTab = doc.querySelector(
      `[data-titlebar-tab-slot][data-active="true"] a[data-slot="tab-link"][href$="/session/${hid}"]`
    );
    const chatMounted = doc.querySelector(
      '[data-slot="session-chat-panel"], [data-component="session-composer-dock"], [data-session-title]'
    );
    if (activeTab && chatMounted) return true;
    if (chatMounted && !doc.querySelector("[data-titlebar-tab-slot]")) return true;
    return false;
  } catch { return false; }
}

// Push the live SPA to another chat; verify the router actually switched
// (no new document navigation), else false. Never throws.
async function clientSwitchSession(frame, hid, timeoutMs) {
  const key = opencodeServerKey();
  if (!frame || !key || !hid) return false;
  try {
    syncOpencodeTabs();
    const w = frame.contentWindow;
    const navsBefore = w.performance.getEntriesByType("navigation").length;
    const msgUrl = `/api/session/${hid}/message`;
    const sessUrl = `/api/session/${hid}`;
    const countRes = (needle, exact) => {
      try {
        return w.performance.getEntriesByType("resource").reduce((n, r) => {
          const u = String(r.name || "");
          return n + ((exact ? (u.endsWith(needle) || u.includes(`${needle}?`)) : u.includes(needle)) ? 1 : 0);
        }, 0);
      } catch { return -1; }
    };
    const seen = countRes(msgUrl, false);
    const seenSess = countRes(sessUrl, true);
    const targetPath = `/server/${key}/session/${hid}`;
    // Prefer opencode's native tab-select handler when the tab link is
    // already mounted (updates Tabs.recent + Solid Router in one batch);
    // always ensure location + popstate converge onto targetPath.
    try {
      const tabLink = w.document && w.document.querySelector(`a[data-slot="tab-link"][href$="/session/${hid}"]`);
      if (tabLink) {
        tabLink.dispatchEvent(new w.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
      }
    } catch {}
    if (!String(w.location && w.location.pathname).endsWith(`/session/${hid}`)) {
      w.history.pushState(null, "", targetPath);
      w.dispatchEvent(new w.PopStateEvent("popstate"));
    }
    const deadline = Date.now() + (timeoutMs || 6000);
    // Fresh chats (never fetched in this document: just created, no tab link
    // yet) may mount with zero network — seeded tabs.info + the session sync
    // cache mean no fresh fetch fires and no tab is marked active, so the
    // strict verify above would burn the full ~6s and fall back to a second
    // document (the "new session takes forever" blank-loader gap). Fast-accept
    // instead: once the route holds the hid with a chat view mounted across a
    // short settle (a stale previous-chat panel swaps out within frames of
    // popstate), stay in the live SPA. Bad routes still fail via the
    // navigation + href + Unrecognised-route guards, on a shorter cap.
    const isFresh = seen === 0 && seenSess === 0;
    const freshDeadline = Date.now() + Math.min(timeoutMs || 6000, 2000);
    let step = 0;
    let settled = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, step++ < 4 ? 25 : 100));
      try {
        if (w.performance.getEntriesByType("navigation").length !== navsBefore) return false;
        if (!String(w.location.href).includes(String(hid))) return false;
        if (isSpaRoutedTo(w, hid, seen, seenSess)) return true;
        if (isFresh) {
          let freshMounted = false;
          try {
            const doc = w.document;
            freshMounted = !!doc && !!doc.body &&
              !String(doc.body.innerText || "").includes("Unrecognised route!") &&
              !!doc.querySelector('[data-slot="session-chat-panel"], [data-component="session-composer-dock"], [data-session-title]');
          } catch { return false; }
          if (freshMounted) {
            if (++settled >= 5) return true;
          } else {
            settled = 0;
          }
        }
      } catch { return false; }
      if (Date.now() > (isFresh ? freshDeadline : deadline)) return false;
    }
  } catch { return false; }
}

// Re-key the frame cache onto the navigated session and drop every other
// cached document: with route switching there is exactly one live SPA per
// pane, and hidden ones only burn memory + SSE streams.
function retargetFrameCache(pane, frame, id) {
  try {
    const cache = ensureFrameCache(pane);
    for (const [sid, f] of [...cache]) {
      if (f !== frame) { try { f.remove(); } catch {} cache.delete(sid); continue; }
      if (sid !== id) cache.delete(sid);
    }
    frame.dataset.sess = id;
    frame.classList.remove("hidden");
    cache.set(id, frame);
    if (pane && pane._el) {
      const termBox = pane._el.querySelector(".pane-term");
      const empty = pane._el.querySelector(".pane-empty");
      if (termBox) termBox.classList.add("hidden");
      if (empty) empty.classList.add("hidden");
    }
    if (pane && pane.es) { try { pane.es.close(); } catch {} pane.es = null; }
    if (pane && pane.term) { try { pane.term.dispose(); } catch {} pane.term = null; pane.fit = null; }
  } catch {}
}

// Client-side switch lane for setPaneSession — extracted as a helper so the
// switch-speed structural asserts on setPaneSession keep their shape.
// Navigates the live SPA when possible, else false (caller falls through to
// the full document load). Re-targets narration explicitly: route switches
// fire no document load for the frame handler to catch.
async function tryClientSwitch(pane, s, id, stale) {
  const navFrame = clientSwitchFrame(pane, s);
  if (!navFrame || !s.harnessSessionId) return false;
  showStageLoader(`switching ${s.title || s.harness}…`);
  // Re-key immediately so concurrent paints/double-clicks and the iframe's
  // dynamic api-scope prefix see the target session while verify runs.
  const prevSid = navFrame.dataset && navFrame.dataset.sess;
  retargetFrameCache(pane, navFrame, id);
  const switched = await clientSwitchSession(navFrame, s.harnessSessionId);
  if (stale() || !switched || pane.sessionId !== id) {
    if (!switched && pane._frameCache && pane._frameCache.get(id) === navFrame) {
      pane._frameCache.delete(id);
      if (prevSid && prevSid !== id) {
        navFrame.dataset.sess = prevSid;
        pane._frameCache.set(prevSid, navFrame);
      }
    }
    return false;
  }
  retargetFrameCache(pane, navFrame, id);
  hideStageLoader();
  observeActivePane();
  if (!state.renamingId) renderWorkspaces();
  state.switchingIds.delete(pane.pid);
  syncLegacyActive();
  updatePaneHeaders();
  savePaneLayout();
  return true;
}

function updateEmptyOverlay() {
  const ov = $("emptyStage");
  if (!ov) return;
  const singleEmpty = state.panes.length <= 1 && !getActivePane()?.sessionId;
  ov.style.display = singleEmpty ? "flex" : "none";
  const grid = $("paneGrid");
  if (grid) grid.style.visibility = singleEmpty ? "hidden" : "visible";
}

function focusPane(pid) {
  if (!getPane(pid) || state.activePanePid === pid) return;
  // A stale iframe may still hold DOM focus while an outer control (sidebar
  // row, palette, pane dropdown) moves pane focus elsewhere: programmatic
  // .click() never moves focus the way a real mousedown does. Blur it so the
  // activeElement poll below doesn't drag focus back to the wrong pane.
  // Skipped when the target owns the focused iframe, so real iframe taps keep
  // typing focus exactly where the user put it.
  try {
    const ae = document.activeElement;
    if (ae && ae.tagName === "IFRAME") {
      const owner = ae.closest ? ae.closest(".pane") : null;
      const ownerPid = owner && owner.dataset && owner.dataset.pane;
      if (ownerPid && ownerPid !== pid) ae.blur();
    }
  } catch {}
  state.activePanePid = pid;
  state.activePanePid = pid;
  syncLegacyActive();
  document.querySelectorAll("#paneGrid .pane").forEach((el) => {
    el.classList.toggle("focused", el.dataset.pane === pid);
  });
  // Left panel tracks the focused pane: rows + attention shelf repaint so
  // the selected session is always the active window's session.
  renderWorkspaces();
  renderAttentionShelf();
  observeActivePane(); // content narration follows the focused session
  savePaneLayout();
}

// Same iframe-focus gap, event-driven from the other side: focusing iframe
// content blurs the outer window. On blur, adopt the pane whose iframe took
// focus. Guarded: alt-tabs and sidebar clicks leave activeElement off
// iframes, so those never steal focus.
window.addEventListener("blur", () => {
  setTimeout(() => {
    try {
      const ae = document.activeElement;
      if (!ae || ae.tagName !== "IFRAME") return;
      const paneEl = ae.closest ? ae.closest(".pane") : null;
      const pid = paneEl && paneEl.dataset && paneEl.dataset.pane;
      if (pid) focusPane(pid);
    } catch {}
  }, 0);
});

// Iframe-to-iframe taps fire neither window blur nor a focus event on the
// iframe element (verified live: outer activeElement moves silently), so the
// listeners above go blind after the first switch and alternating taps get
// stuck on the second switch. Poll the one signal that always moves.
// focusPane early-returns when already active, so steady-state cost is one
// property read per tick.
setInterval(() => {
  try {
    const ae = document.activeElement;
    if (!ae || ae.tagName !== "IFRAME") return;
    const paneEl = ae.closest ? ae.closest(".pane") : null;
    const pid = paneEl && paneEl.dataset && paneEl.dataset.pane;
    if (pid) focusPane(pid);
  } catch {}
}, 250);

function addSplitPane(sessionId) {
  if (state.panes.length >= 4) { status("split limit", "max 4 panes"); return null; }
  const p = { pid: paneUid(), sessionId: null, term: null, fit: null, es: null, seq: 0 };
  state.panes.push(p);
  state.activePanePid = p.pid;
  renderPanes();
  if (sessionId) setPaneSession(p, sessionId);
  else { syncLegacyActive(); updateEmptyOverlay(); savePaneLayout(); }
  return p;
}

function closePane(pid) {
  if (state.panes.length <= 1) return;
  const i = state.panes.findIndex((p) => p.pid === pid);
  if (i < 0) return;
  teardownPane(state.panes[i]);
  state.panes.splice(i, 1);
  if (state.activePanePid === pid) state.activePanePid = state.panes[Math.max(0, i - 1)].pid;
  state.switchingIds.delete(pid);
  syncLegacyActive();
  renderPanes();
  renderWorkspaces();
  savePaneLayout();
}

function openInSplit(id) {
  dismissMobileSidebar();
  const active = getActivePane();
  if (active && !active.sessionId) {
    activateSession(id);
    return;
  }
  // If the session is already open in another pane, just focus it.
  const existing = state.panes.find((p) => p.sessionId === id);
  if (existing) { focusPane(existing.pid); return; }
  addSplitPane(id);
}

async function activateSession(id) {
  dismissMobileSidebar();
  if (id && state.dismissedAttention.has(id)) {
    state.dismissedAttention.delete(id);
    saveDismissedAttention();
    renderAttentionShelf();
    renderDash();
    updateCounts();
  }
  ensurePane();
  // Session already live in another pane: focus it instead of duplicating.
  // Keeps the invariant both ways (sidebar selection == active window).
  const live = state.panes.find((p) => p.sessionId === id);
  const focused = getActivePane();
  if (live && focused && live.pid !== focused.pid) {
    focusPane(live.pid);
    return;
  }
  const pane = getActivePane();
  if (pane.sessionId !== id) {
    // Optimistic highlight so the sidebar responds instantly, even though
    // the background refresh skips re-rendering mid-switch (see refresh()).
    // The paint is skipped when the client-side nav lane is eligible: the
    // live SPA navigates to the target with no new document, and painting
    // first would materialize a blank iframe that the lane then pointlessly
    // navigates instead of the live app (verified live: row-click switches
    // stalled on the blank while dropdown switches flew). setPaneSession
    // paints on every lane that needs a document (warm cache, full load).
    const pre = state.sessions.find((x) => x.id === id);
    const navFirst = !!(pre && pre.mode === "web" && clientSwitchFrame(pane, pre));
    pane.sessionId = id;
    state.activePanePid = pane.pid;
    syncLegacyActive();
    renderWorkspaces();
    if (!navFirst) paintPane(pane);
    updateEmptyOverlay();
    updatePaneHeaders();
  } else {
    focusPane(pane.pid);
    paintPane(pane);
    updateEmptyOverlay();
    if (!state.renamingId) renderWorkspaces();
    const cur0 = state.sessions.find((x) => x.id === id);
    if (cur0 && cur0.mode !== "web" && pane.term) { focusActiveView(); return; }
    if (cur0 && cur0.mode === "web") {
      const f = pane._frameCache && pane._frameCache.get(id);
      if (f && f.isConnected && f.getAttribute("src")) return;
      const single = pane._el && pane._el.querySelector(".pane-frame");
      if (single && single.getAttribute("src")) return;
    }
  }
  setPaneSession(pane, id);
}

async function setPaneSession(pane, id) {
  // Dedupe rapid re-activates of the same session in one pane (double-click
  // fires two activates + startRename): the first switch already owns the
  // ensure + iframe boot, so a second concurrent one only doubles backend
  // load and frame churn for an identical end state. Just focus instead.
  if (pane.sessionId === id && state.switchingIds.has(pane.pid)) { focusPane(pane.pid); return; }
  const my = ++activateSeq;
  pane.seq = my;
  const stale = () => pane.seq !== my;
  state.switchingIds.add(pane.pid);
  pane.sessionId = id;
  state.activePanePid = pane.pid;
  syncLegacyActive();
  state.switchingId = id;
  // Stuck-gate insurance (see finally): any throw/rejection below must still
  // clear this switch's flag, or refresh() skips the sidebar forever.
  // Seq-guarded so a stale switch never clears a newer switch's flag early.
  try {
  // Snapshot BEFORE paintPane (see below).
  const s0 = state.sessions.find((x) => x.id === id);
  const wasCached = !!s0 && s0.mode === "web" && isFrameCached(pane, id);
  // Client-side switch lane, decided BEFORE paint: painting a miss would
  // materialize a second document and defeat the lane (the visible frame is
  // what gets navigated). Only bound same-backend targets qualify; unbound
  // or cross-backend targets take the full load below. The lane itself runs
  // after ensure (which may backfill the chat binding).
  const navLane = !!(s0 && s0.mode === "web" && clientSwitchFrame(pane, s0));
  renderWorkspaces();
  if (!navLane) paintPane(pane);
  updateEmptyOverlay();
  // Narration follows the switch intent synchronously: the slow path below
  // awaits ensure first, and deferring this until after would wipe content
  // fed in between (observe clears the buffer). The iframe load handler
  // re-targets on the real document commit.
  observeActivePane();

  const s = state.sessions.find((x) => x.id === id);
  if (!s) { state.switchingIds.delete(pane.pid); syncLegacyActive(); return; }

  // Instant path: cached web view + locally healthy → show it now, heal in
  // the background. No loader, no blocking ensure. A replaced backend
  // (pid changed) forces a reload of the stale document.
  // wasCached is captured above because painting a cache miss creates +
  // connects the new frame — checking after paint would always "hit" and
  // the loader path below would be dead code (cold switches showed a blank
  // frame with zero feedback). Cold misses take the slow path with a loader
  // + awaited ensure; warm hits stay instant.
  if (s.mode === "web" && wasCached && s.status === "running") {
    if (navLane) paintPane(pane); // skipped above; the cached view still needs showing
    hideStageLoader();
    status("attached", `${s.harness} via ${REMOTE ? "tunnel proxy" : "local proxy"}`);
    const prevPid = s.backendPid;
    if (pane.es) { try { pane.es.close(); } catch {} pane.es = null; }
    if (pane.term) { try { pane.term.dispose(); } catch {} pane.term = null; pane.fit = null; }
    api("POST", `/api/sessions/${id}/ensure`)
      .then((fresh) => {
        if (stale() || pane.sessionId !== id) return;
        if (fresh) Object.assign(s, fresh);
        if (prevPid && fresh && fresh.backendPid && fresh.backendPid !== prevPid) {
          const f = pane._frameCache && pane._frameCache.get(id);
          if (f) forceFrameReload(f, id);
        }
      })
      .catch(() => {});
    api("POST", `/api/sessions/${id}/touch`).catch(() => {});
    if (!state.renamingId) renderWorkspaces();
    updatePaneHeaders();
    state.switchingIds.delete(pane.pid);
    syncLegacyActive();
    savePaneLayout();
    // Narration already follows the switch (synchronous observe above).
    return;
  }

  const wasDead = s.status !== "running";
  const prevPid = s.backendPid;
  // Fire ensure + touch now (shared by both lanes below): the server dedupes
  // concurrent ensures per session, so firing early never duplicates work.
  const ensureP = api("POST", `/api/sessions/${id}/ensure`);
  const touchP = api("POST", `/api/sessions/${id}/touch`);
  // Fast nav lane for cold same-backend switches: the live SPA routes to the
  // target chat with no ensure round-trip on the critical path (ensure heals
  // in the background). Previously this lane ran only AFTER the awaited
  // ensure, so every cold same-backend switch paid ensure latency before any
  // visual change. Unbound targets skip: ensure must backfill the chat
  // binding first (covered by the post-ensure lane below).
  let navTried = false;
  if (navLane && s.mode === "web" && s.harnessSessionId) {
    navTried = true;
    status("switching", s.title || id);
    showStageLoader(`switching ${s.title || s.harness}…`);
    if (await tryClientSwitch(pane, s, id, stale)) {
      ensureP.then((fresh) => {
        if (stale() || pane.sessionId !== id) return;
        if (fresh) Object.assign(s, fresh);
        if (prevPid && fresh && fresh.backendPid && fresh.backendPid !== prevPid) {
          const f = pane._frameCache && pane._frameCache.get(id);
          if (f) forceFrameReload(f, id);
        }
      }).catch(() => {});
      touchP.catch(() => {});
      return;
    }
    if (stale()) return;
  } else {
    status("switching", s.title || id);
    showStageLoader(`connecting ${s.title || s.harness}…`);
  }

  let fresh = null;
  try {
    // Await the already-in-flight ensure (fired above): a restarted backend
    // gets a fresh document instead of a stale cached one.
    fresh = await ensureP;
    if (stale()) return;
    if (fresh) Object.assign(s, fresh);
    await touchP.catch(() => {});
  } catch (e) {
    if (stale()) return;
    status("ensure failed", e.message);
  }

  if (stale()) return;

  // Client-side switch lane (see tryClientSwitch): same-backend web
  // switches navigate the live SPA instead of booting a second document.
  // paintPane was skipped above for this lane; on any failure the flow
  // falls through to the full document load (which paints). Skipped when the
  // fast lane above already tried (its verify just failed — retrying would
  // burn a second ~6s poll); still runs for bindings ensure just backfilled.
  if (!navTried && navLane && s.mode === "web" && s.harnessSessionId && await tryClientSwitch(pane, s, id, stale)) return;

  // An inline left-panel rename may have opened mid-activation (double-click
  // the row = activate clicks + startRename): the keyed sidebar keeps its
  // input alive across this render (see updateSessRow), mirroring the
  // refresh() skip.
  if (!state.renamingId) renderWorkspaces();

  if (s.mode === "web") {
    // Overlap: leave the previous view up until the new document commits.
    // The iframe keeps showing old content during navigation; the loader
    // pill covers the gap and clears on `load` (wired per-frame via
    // attachFrameListeners). Per-session API scoping (proxy injectApiScope)
    // keeps concurrent panes on their own backends — no shared-cookie
    // cross-talk. A restarted backend (dead before ensure, or pid changed)
    // leaves a stale document behind — reload it so the view reconnects.
    if (pane.es) { try { pane.es.close(); } catch {} pane.es = null; }
    if (pane.term) { try { pane.term.dispose(); } catch {} pane.term = null; pane.fit = null; }
    paintPane(pane);
    if (wasDead || (prevPid && s.backendPid && s.backendPid !== prevPid)) {
      const f = pane._frameCache && pane._frameCache.get(id);
      if (f) forceFrameReload(f, id);
    }
    showStageLoader(`loading ${s.title || s.harness}…`);
    // Fallback: some backends never fire iframe load (auth wall, error
    // page). Clear the pill after a bounded wait so it never sticks.
    setTimeout(() => { if (!stale() && pane.sessionId === id) hideStageLoader(); }, 15000);
    status("attached", `${s.harness} via ${REMOTE ? "tunnel proxy" : "local proxy"}`);
  } else {
    // Overlap for PTY too: dispose + rebuild only after ensure resolved,
    // and paint "connecting" immediately so the stage never sits blank.
    if (pane.es) { try { pane.es.close(); } catch {} pane.es = null; }
    if (pane.term) { try { pane.term.dispose(); } catch {} pane.term = null; pane.fit = null; }
    paintPane(pane); // single PTY attach point (attaches when !p.term) — no
    // second attachPaneTerm here: it would orphan the stream just opened.
    // Loader clears on first terminal data (see attachPaneTerm); bounded
    // fallback here in case the backend is silent.
    setTimeout(() => { if (pane.sessionId === id) hideStageLoader(); }, 8000);
  }
  if (!stale()) {
    state.switchingIds.delete(pane.pid);
    syncLegacyActive();
    updatePaneHeaders();
    savePaneLayout();
    // No re-observe here: narration already follows the switch intent
    // (synchronous observe above), and observing again now would wipe
    // content fed since. The iframe load handler re-targets on commit.
  }
  } finally {
    if (pane.seq === my) {
      state.switchingIds.delete(pane.pid);
      syncLegacyActive();
    }
  }
}

// POST terminal input
async function postInput(kind, id, data, term) {
  try {
    const r = await fetch(`/api/pty/${kind}/${id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (r.status === 410 && term) {
      term.write("\r\n\x1b[31m[process exited — press \u21bb resume to restart]\x1b[0m\r\n");
    }
  } catch {}
}

function makeTerm(container) {
  if (!hasXterm) {
    container.innerHTML = '<div class="empty-state-text">xterm.js failed to load. Terminal unavailable.</div>';
    return null;
  }
  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"JetBrains Mono", monospace',
    theme: {
      background: "#08090d",
      foreground: "#e2e8f0",
      cursor: "#06b6d4",
      selectionBackground: "rgba(6, 182, 212, 0.3)",
      black: "#1e293b",
      brightBlack: "#475569",
      red: "#f87171",
      brightRed: "#ef4444",
      green: "#34d399",
      brightGreen: "#10b981",
      yellow: "#fbbf24",
      brightYellow: "#f59e0b",
      blue: "#60a5fa",
      brightBlue: "#3b82f6",
      magenta: "#c084fc",
      brightMagenta: "#a855f7",
      cyan: "#38bdf8",
      brightCyan: "#06b6d4",
      white: "#f8fafc",
      brightWhite: "#ffffff",
    },
  });
  term.open(container);
  let fit = null;
  try {
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    fit.fit();
  } catch {}
  return { term, fit };
}

function attachPaneTerm(pane, sessionId) {
  const box = pane._el && pane._el.querySelector(".pane-term");
  if (!box) { hideStageLoader(); return; }
  box.innerHTML = "";
  box.classList.remove("hidden");
  const made = makeTerm(box);
  if (!made) { hideStageLoader(); return; }

  pane.term = made.term;
  pane.fit = made.fit;
  const kind = "session";

  pane.term.onData((d) => postInput(kind, sessionId, d, pane.term));
  const es = new EventSource(`/api/pty/${kind}/${sessionId}/stream`);
  pane.es = es;

  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "data") { try { pane.term.write(msg.data); } catch {} hideStageLoader(); maybeNarratePty(sessionId, msg.data); }
    } catch {}
  };

  es.addEventListener("exit", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      pane.term.write(`\r\n\x1b[31m[process exited: code ${m.exitCode} — press \u21bb resume to restart]\x1b[0m\r\n`);
    } catch {}
    es.close();
  });

  es.onerror = () => status("stream error", "backend may be down — press ↻ resume");

  setTimeout(() => {
    if (pane.fit) {
      try {
        pane.fit.fit();
        const dims = pane.fit.proposeDimensions();
        if (dims) {
          fetch(`/api/pty/${kind}/${sessionId}/resize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(dims),
          }).catch(() => {});
        }
      } catch {}
    }
  }, 250);

  // Don't steal focus from an in-progress left-panel rename (double-click
  // the row = activate + startRename): focusing the terminal would blur the
  // edit input and silently cancel it via blur-commit.
  if (!state.renamingId && getActivePane() && getActivePane().pid === pane.pid) {
    try { pane.term.focus(); } catch {}
  }
}

// Legacy alias (single-view call sites): attach to the focused pane.
function attachMainTerm(sessionId) {
  const pane = ensurePane();
  return attachPaneTerm(pane, sessionId);
}

// ---------- BOTTOM DRAWER (CONSOLES) ----------

function renderConsoles() {
  const el = $("conTabs");
  if (!el) return;
  el.innerHTML = "";

  $("bottom").classList.toggle("body-empty", state.consoles.length === 0);

  for (const c of state.consoles) {
    const t = document.createElement("span");
    t.className = "con-tab" + (c.id === state.activeConsoleId ? " active" : "");

    t.innerHTML = `
      <svg viewBox="0 0 24 24" class="svg-icon" style="width:12px;height:12px;"><polyline points="4 17 10 11 4 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="19" x2="20" y2="19" stroke="currentColor" stroke-width="2"/></svg>
      <span>${escapeHtml(c.title || c.id)}</span>
      <button class="x" title="Close terminal" aria-label="Close terminal">×</button>
    `;

    t.querySelector(".x").onclick = async (e) => {
      e.stopPropagation();
      await api("DELETE", `/api/consoles/${c.id}`).catch(() => {});
      if (state.activeConsoleId === c.id) {
        state.activeConsoleId = null;
        teardownConsole();
      }
      refresh();
    };

    t.onclick = () => activateConsole(c.id);
    t.tabIndex = 0;
    t.setAttribute("role", "tab");
    t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateConsole(c.id); } };
    el.appendChild(t);
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

  setTimeout(() => {
    try { state.conFit && state.conFit.fit(); } catch {}
    state.conTerm.focus();
  }, 200);
}

function renderConsoleTabs() {
  const el = $("conTabs");
  if (!el) return;
  [...el.children].forEach((t, i) => {
    const c = state.consoles[i];
    if (c) t.classList.toggle("active", c.id === state.activeConsoleId);
  });
}

// ---------- ONE-CLICK SESSION CREATE (no modal popup) ----------
// Every New Session entry point creates directly: workspace resolves
// explicit > active session's workspace > first workspace; harness comes
// from the top-bar switch; the backend assigns its default title
// (`<harness> · <ws>`). With no workspace yet, fall through to the folder
// picker so there is somewhere to create into.
async function quickCreateSession(workspaceId) {
  dismissMobileSidebar();
  const active = state.sessions.find((x) => x.id === state.activeSessionId);
  const wsId = workspaceId || (active && active.workspaceId)
    || (state.workspaces[0] && state.workspaces[0].id);
  if (!wsId) {
    openFolderModal();
    return;
  }
  const harness = getSelectedHarness();
  // Instant feedback: the POST below boots a backend (seconds for a cold
  // opencode) and status() is a no-op, so without this the click appears
  // dead until the session lands. activateSession replaces this text.
  showStageLoader(`starting ${harness}…`);
  try {
    const s = await api("POST", "/api/sessions", { workspaceId: wsId, harness });
    // Merge directly so activation doesn't wait for the next 8s poll or a
    // blocking refresh round-trip; refresh() still runs to converge the rest.
    if (s && s.id && !state.sessions.some((x) => x.id === s.id)) {
      state.sessions.unshift(s);
    }
    refresh();
    activateSession(s.id);
  } catch (e) {
    hideStageLoader();
    status("create failed", e.message);
  }
}

// ---------- TOP-BAR HARNESS SWITCH (default for new sessions) ----------
// Single source of truth for the harness quick-create uses. Persists to
// localStorage so reloads keep the pick.
const HARNESS_KEY = "ai-manager.harness";
const HARNESS_NAMES = ["opencode", "droid", "dsh", "agy"];

function getSelectedHarness() {
  try {
    const v = localStorage.getItem(HARNESS_KEY);
    if (HARNESS_NAMES.includes(v)) return v;
  } catch {}
  return "opencode";
}

function setSelectedHarness(name, persist = true) {
  if (!HARNESS_NAMES.includes(name)) return;
  if (persist) { try { localStorage.setItem(HARNESS_KEY, name); } catch {} }
  document.querySelectorAll("#harnessSwitch .hs-btn").forEach((b) => {
    const on = b.dataset.harness === name;
    b.classList.toggle("sel", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

document.querySelectorAll("#harnessSwitch .hs-btn").forEach((b) => {
  b.onclick = () => setSelectedHarness(b.dataset.harness);
});
setSelectedHarness(getSelectedHarness(), false);

// ---------- NARRATE MODE (session activity read aloud) ----------
// Engine: built-in Web Speech API (speechSynthesis) — zero bytes, ~50ms
// first audio, works locally + through the tunnel, no key, no server.
// Voice research (GitHub stars, Oct 2026): coqui-ai/TTS ~46k (XTTS v2,
// 16 langs, heavy Python sidecar — overkill for status lines);
// 2noise/ChatTTS ~40k (dialogue EN+ZH); fishaudio/fish-speech ~31k;
// resemble-ai/chatterbox ~27k MIT (Nano 110M runs 3x realtime on CPU);
// Kokoro-82M (Apache-2.0 weights, ~82MB, kokoro-js WebGPU, af_heart-class
// narrator voices, 1–3s/paragraph desktop) is the natural upgrade for a
// premium narrator, with Piper-WASM (30–60MB/voice, CPU-offline, 904
// voices) as the non-GPU fallback. All need a model download + worker;
// Default engine is now the Kokoro-82M neural voice (human-grade, af_heart)
// with the built-in speechSynthesis as instant fallback. Engine-agnostic
// call sites (setNarrate/narrateTransitions/maybeNarratePty) stay put;
// only ensureKokoro()/speakKokoro()/speakSystem() know the engines.
// What gets spoken: session transitions (needs-input / working /
// finished / new session) always; live PTY output only as throttled
// one-line summaries so chatter never drowns the signal.
const NARRATE_KEY = "ai-manager.narrate";
const NARRATE_ENGINE_KEY = "ai-manager.narrateEngine"; // "kokoro" | "system"
const NARRATE_VOICE_KEY = "ai-manager.narrateVoice";
const KOKORO_CDN = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_VOICE = "af_heart"; // grade-A female voice (see kokoro voice table)
const narrate = {
  on: false,
  prevActivity: new Map(), // sessionId -> "activity|status"
  seeded: false,
  lastError: null, // last utterance error code (e.g. "not-allowed") — surfaced on the toggle
  retry: null, // utterance blocked by the autoplay gate, replayed on next gesture
  spokeOk: false, // any onstart seen — clears the error state
  kokoroState: "idle", // "idle" | "loading" | "ready" | "failed"
  kokoroLoad: null, // singleton model-load promise (lazy: no download until first speak)
  kokoroTts: null,
  kokoroAudio: null, // live <audio> element while Kokoro speech plays
  kokoroBusy: false, // generation or playback in flight
  kokoroSeq: 0, // invalidates stale generations preempted by priority speech
  kokoroFailed: false, // load/generate failed this session → route to system
  kokoroError: null, // last Kokoro load/generate error (surfaced in diag)
  kokoroDevice: null, // "webgpu" | "wasm" — whichever backend won
  kokoroPct: 0, // model-download progress for the button tooltip
  // Live content narration: PTY chunks + web-iframe mutations accumulate in
  // pendingText, flush to sentences on pause, then speak sequentially.
  // Only the FOCUSED pane's session is content-narrated (one audio stream);
  // background sessions are covered by transition announcements.
  pendingText: "",
  pendingAt: 0,
  contentQueue: [],
  lastContent: "",
  webObs: null, // live MutationObserver on the focused web frame
  webObservedId: null,
};
const NARRATE_FLUSH_MS = 4000; // speak accumulated text after this pause in updates
const NARRATE_PENDING_CAP = 4000; // chars of unflushed text kept (drop oldest)
const NARRATE_QUEUE_N = 5; // sentences queued max (live > complete)
const NARRATE_SENT_MIN = 30; // min sentence chars (also see isNoiseLine)
const NARRATE_SENT_MAX = 240; // max sentence chars (word-boundary cut)

function getNarrateEngine() {
  try {
    const v = localStorage.getItem(NARRATE_ENGINE_KEY);
    if (v === "system" || v === "kokoro") return v;
  } catch {}
  return "kokoro";
}

function getNarrateVoice() {
  try {
    const v = localStorage.getItem(NARRATE_VOICE_KEY);
    if (v && /^[a-z]{2}_[a-z]+$/.test(v)) return v;
  } catch {}
  return KOKORO_VOICE;
}

// Test/power-user hook: __narrateSetEngine("system"|"kokoro").
function __narrateSetEngine(which) {
  const next = which === "system" ? "system" : "kokoro";
  try { localStorage.setItem(NARRATE_ENGINE_KEY, next); } catch {}
  if (next === "kokoro") narrate.kokoroFailed = false;
  stopKokoroAudio();
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  paintNarrateButton();
  return next;
}
try { window.__narrateSetEngine = __narrateSetEngine; } catch {}

// Toggle visuals in one place: on/off, loading, blocked-error, unsupported.
function paintNarrateButton() {
  const b = $("btnNarrate");
  if (!b) return;
  const sysSupported = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  const engine = getNarrateEngine();
  const loading = engine === "kokoro" && narrate.kokoroState === "loading";
  b.classList.toggle("on", narrate.on);
  b.classList.toggle("err", !!narrate.lastError);
  b.classList.toggle("loading", loading);
  b.setAttribute("aria-pressed", narrate.on ? "true" : "false");
  const voiceTag = engine === "kokoro" ? ` · neural voice (Kokoro ${getNarrateVoice()})` : " · system voice";
  if (!sysSupported && engine !== "kokoro") {
    b.disabled = true;
    b.title = "Narrate unavailable — this browser has no speech engine";
  } else if (loading) {
    b.title = `Downloading neural voice (${narrate.kokoroPct}% of ~90MB — cached after first load)`;
  } else if (narrate.lastError) {
    b.title = `Narrate blocked (${narrate.lastError}) — click anywhere on the page, then toggle Narrate off and on${voiceTag}`;
  } else {
    b.title = `Narrate session activity aloud (toggle)${voiceTag}`;
  }
  const lbl = b.querySelector("span");
  if (lbl) lbl.textContent = loading ? "Loading voice…" : "Narrate";
}

// Chrome gates speechSynthesis behind user activation: poll-driven speech
// with no gesture yet fails with "not-allowed". Stash it and replay on the
// next real click/keypress instead of dropping it silently.
function installNarrateGestureFlush() {
  if (installNarrateGestureFlush.done) return;
  installNarrateGestureFlush.done = true;
  const flush = () => {
    if (!narrate.retry || !narrate.on) return;
    const msg = narrate.retry;
    narrate.retry = null;
    speak(msg, true);
  };
  try {
    document.addEventListener("pointerdown", flush, true);
    document.addEventListener("keydown", flush, true);
  } catch {}
}
const NARRATE_MAX_CHARS = 180;

function narrateKey(s) {
  return `${s.activity || ""}|${s.status || ""}`;
}

function cleanForSpeech(raw, max) {
  if (!raw) return "";
  let t = String(raw)
    .replace(/\x1b\][^\x07]*\x07/g, " ")   // OSC sequences
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ") // ANSI CSI
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/[`*_#{}\[\]<>|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > (max || NARRATE_MAX_CHARS)) {
    const cut = t.slice(0, max || NARRATE_MAX_CHARS);
    const sp = cut.lastIndexOf(" ");
    t = (sp > 40 ? cut.slice(0, sp) : cut).trim() + "…";
  }
  return t;
}

// Pure content helpers (also exercised headless via eval in e2e).
function isNoiseLine(l) {
  if (!l || l.length < 24) return true;
  const letters = (l.match(/[a-zA-Z]/g) || []).length;
  if (letters < 12) return true;
  const sym = (l.match(/[^a-zA-Z0-9\s.,!?;:'"()\-]/g) || []).length;
  if (sym / l.length > 0.35) return true; // box-drawing / spinner frames
  if (/^\s*[$#>❯➜*•\-–—]\s/.test(l)) return true; // shell prompts / bullets
  if (/^(used|using)\s+\d+\s/i.test(l)) return true; // tool-chrome rows ("Used 12 Shell")
  return false;
}

function splitIntoSentences(raw, max) {
  if (!raw) return [];
  const cap = max || NARRATE_SENT_MAX;
  // Split on sentence punctuation AND line breaks, then drop terminal noise.
  // The final part is spoken whole even without trailing punctuation: flush
  // only runs after a pause in updates, so it is settled text (titles,
  // status lines, last sentences), not a mid-word streaming fragment.
  // Stripping its last word garbled every such utterance ("needs your
  // input" -> "needs your").
  const parts = String(raw).split(/(?<=[.!?])\s+|\r?\n/)
    .map((s) => cleanForSpeech(s, NARRATE_PENDING_CAP)).filter((s) => s);
  const out = [];
  parts.forEach((t) => {
    if (isNoiseLine(t)) return;
    out.push(t.length > cap ? t.slice(0, cap).replace(/\s+\S*$/, "") + "…" : t);
  });
  return out;
}

function pickNarrateVoice() {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return null;
    const vs = synth.getVoices ? synth.getVoices() : [];
    if (!vs || !vs.length) return null;
    const en = vs.filter((v) => /^en([-_ ]|$)/i.test(v.lang || ""));
    const pool = en.length ? en : vs;
    const prefer = [/google us english/i, /samantha/i, /zira/i, /aria/i, /natural/i, /neural/i];
    for (const re of prefer) {
      const hit = pool.find((v) => re.test(v.name || ""));
      if (hit) return hit;
    }
    return pool.find((v) => v.default) || pool[0] || null;
  } catch { return null; }
}

// Engine router: Kokoro neural voice by default, system speech on
// explicit pick or when Kokoro failed this session. onDone fires exactly
// once per utterance (end or error) so the content queue can pump.
function speak(text, priority, onDone) {
  if (!narrate.on) return;
  const msg = cleanForSpeech(text, NARRATE_MAX_CHARS);
  if (!msg) return;
  if (getNarrateEngine() === "kokoro" && !narrate.kokoroFailed) speakKokoro(msg, priority, onDone);
  else speakSystem(msg, priority, onDone);
}

function speakSystem(msg, priority, onDone) {
  const done = (() => { let c = false; return () => { if (!c) { c = true; try { onDone && onDone(); } catch {} } }; })();
  try {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) return;
    try { synth.resume(); } catch {} // resume first: Chrome stalls speech while paused
    if (priority) { try { synth.cancel(); } catch {} }
    else if (synth.speaking || synth.pending) return;
    const u = new SpeechSynthesisUtterance(msg);
    const v = pickNarrateVoice();
    if (v) u.voice = v;
    u.rate = 1.05;
    u.volume = 1;
    u.onstart = () => {
      narrate.spokeOk = true;
      if (narrate.lastError) { narrate.lastError = null; narrate.retry = null; paintNarrateButton(); }
    };
    u.onend = () => done();
    u.onerror = (ev) => {
      const code = (ev && ev.error) || "error";
      // Our own cancel() fires "canceled"/"interrupted" on the utterance it
      // preempts — not a failure, never surface or retry those.
      if (code === "canceled" || code === "interrupted") { done(); return; }
      narrate.lastError = code;
      if (code === "not-allowed") narrate.retry = msg;
      else clearNarrateContent(); // blocked queue would backlog: drop it, keep the retry
      paintNarrateButton();
      done();
    };
    synth.speak(u);
    narrate.lastSpokeAt = Date.now();
  } catch {}
}

// Lazy Kokoro load (singleton): no ~90MB download until the first utterance.
// Tries WebGPU first when present, falls back to WASM (headless/quirky GPUs
// reject the WebGPU session after downloading); q8 keeps it ~90MB.
function ensureKokoro() {
  if (narrate.kokoroTts) return Promise.resolve(narrate.kokoroTts);
  if (narrate.kokoroLoad) return narrate.kokoroLoad;
  narrate.kokoroState = "loading";
  narrate.kokoroPct = 0;
  narrate.kokoroError = null;
  paintNarrateButton();
  narrate.kokoroLoad = (async () => {
    const { KokoroTTS } = await import(KOKORO_CDN);
    const devices = (typeof navigator !== "undefined" && navigator.gpu) ? ["webgpu", "wasm"] : ["wasm"];
    let lastErr = null;
    for (const device of devices) {
      try {
        const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
          dtype: "q8",
          device,
          progress_callback: (p) => {
            try {
              if (p && typeof p.progress === "number") {
                narrate.kokoroPct = Math.round(p.progress);
                paintNarrateButton();
              }
            } catch {}
          },
        });
        narrate.kokoroTts = tts;
        narrate.kokoroDevice = device;
        narrate.kokoroState = "ready";
        paintNarrateButton();
        return tts;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("kokoro load failed");
  })().catch((e) => {
    narrate.kokoroLoad = null;
    narrate.kokoroState = "failed";
    narrate.kokoroFailed = true;
    try { narrate.kokoroError = String((e && e.message) || e).slice(0, 160); } catch {}
    paintNarrateButton();
    return null;
  });
  return narrate.kokoroLoad;
}

function stopKokoroAudio() {
  narrate.kokoroSeq++;
  const el = narrate.kokoroAudio;
  narrate.kokoroAudio = null;
  narrate.kokoroBusy = false;
  if (el) {
    try { el.pause(); } catch {}
    try { el.removeAttribute("src"); } catch {}
    try { el.load(); } catch {}
  }
  if (el && el._kokoroUrl) { try { URL.revokeObjectURL(el._kokoroUrl); } catch {} }
}

function noteKokoroStart() {
  narrate.spokeOk = true;
  if (narrate.lastError) { narrate.lastError = null; narrate.retry = null; paintNarrateButton(); }
}

function noteKokoroError(code, msg) {
  if (code === "canceled" || code === "interrupted" || code === "abort") return;
  narrate.lastError = code || "error";
  if (narrate.lastError === "not-allowed" && msg) narrate.retry = msg;
  else clearNarrateContent(); // blocked queue would backlog: drop it, keep the retry
  paintNarrateButton();
}

function speakKokoro(msg, priority, onDone) {
  const done = (() => { let c = false; return () => { if (!c) { c = true; try { onDone && onDone(); } catch {} } }; })();
  if (priority) stopKokoroAudio();
  else if (narrate.kokoroBusy) return;
  narrate.kokoroBusy = true;
  const my = narrate.kokoroSeq;
  ensureKokoro().then(async (tts) => {
    // Load failed (kokoroFailed set in ensureKokoro): fall back to system.
    if (!tts) {
      if (narrate.on && my === narrate.kokoroSeq) { narrate.kokoroBusy = false; speakSystem(msg, priority, done); }
      else done();
      return;
    }
    if (!narrate.on || my !== narrate.kokoroSeq) { done(); return; } // preempted / disabled mid-load
    try {
      const audio = await tts.generate(msg, { voice: getNarrateVoice() });
      if (!narrate.on || my !== narrate.kokoroSeq) { done(); return; } // preempted mid-generate
      const blob = audio.toBlob();
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      el._kokoroUrl = url;
      narrate.kokoroAudio = el;
      el.onplay = () => noteKokoroStart();
      el.onended = () => {
        try { URL.revokeObjectURL(url); } catch {}
        if (narrate.kokoroAudio === el) narrate.kokoroAudio = null;
        narrate.kokoroBusy = false;
        noteKokoroStart();
        done();
      };
      el.onerror = () => {
        try { URL.revokeObjectURL(url); } catch {}
        if (narrate.kokoroAudio === el) narrate.kokoroAudio = null;
        narrate.kokoroBusy = false;
        noteKokoroError("error", msg);
        done();
      };
      await el.play();
      narrate.lastSpokeAt = Date.now();
    } catch (e) {
      if (my !== narrate.kokoroSeq) { done(); return; }
      narrate.kokoroBusy = false;
      const name = (e && e.name) || "";
      if (name === "NotAllowedError" || /not-allowed/i.test(String((e && e.message) || ""))) {
        noteKokoroError("not-allowed", msg);
        done();
      } else {
        // Generation blew up mid-flight: record it, fall back to system.
        narrate.kokoroFailed = true;
        try { narrate.kokoroError = String((e && e.message) || e).slice(0, 160); } catch {}
        paintNarrateButton();
        speakSystem(msg, priority, done);
      }
    }
  });
}

function isNarrateOn() { return narrate.on; }

// Console/devtools readout: __narrateDiag() → { on, engine, kokoro, voice,
// voices, speaking, pending, lastError, retryQueued, everSpoke, lastSpokeAt }.
function __narrateDiag() {
  try {
    const synth = window.speechSynthesis;
    return {
      on: narrate.on,
      engine: getNarrateEngine(),
      kokoro: narrate.kokoroState,
      kokoroBusy: narrate.kokoroBusy,
      kokoroDevice: narrate.kokoroDevice,
      kokoroError: narrate.kokoroError,
      voice: getNarrateVoice(),
      supported: !!(synth && window.SpeechSynthesisUtterance),
      voices: synth && synth.getVoices ? synth.getVoices().length : 0,
      speaking: !!(synth && synth.speaking),
      pending: !!(synth && synth.pending),
      paused: !!(synth && synth.paused),
      lastError: narrate.lastError,
      retryQueued: !!narrate.retry,
      everSpoke: narrate.spokeOk,
      lastSpokeAt: narrate.lastSpokeAt || 0,
      queue: narrate.contentQueue.length,
      pendingChars: (narrate.pendingText || "").length,
      webObservedId: narrate.webObservedId,
      lastContent: narrate.lastContent || "",
    };
  } catch (e) { return { diagError: String((e && e.message) || e) }; }
}
try { window.__narrateDiag = __narrateDiag; } catch {}

function setNarrate(on, opts) {
  narrate.on = !!on;
  try { localStorage.setItem(NARRATE_KEY, narrate.on ? "1" : "0"); } catch {}
  if (!narrate.on) {
    narrate.retry = null;
    clearNarrateContent();
    stopWebNarration();
    stopKokoroAudio();
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  } else {
    narrate.lastError = null;
    narrate.kokoroFailed = false; // retry the neural upgrade on every enable
    narrate.kokoroError = null;
    installNarrateGestureFlush();
    clearNarrateContent();
    observeActivePane();
  }
  paintNarrateButton();
  if (narrate.on && !(opts && opts.silent)) speak("Narrate mode on", true);
}

// Diff the polled session list against the last poll; announce one line per
// changed session (max 2 per poll, joined). First poll only seeds.
function narrateTransitions() {
  const cur = new Map(state.sessions.map((s) => [s.id, narrateKey(s)]));
  if (!narrate.seeded) {
    narrate.prevActivity = cur;
    narrate.seeded = true;
    return;
  }
  const notes = [];
  for (const s of state.sessions) {
    const before = narrate.prevActivity.get(s.id);
    const after = narrateKey(s);
    if (before === undefined) {
      notes.push(`New ${s.harness} session, ${s.title || "untitled"}`);
    } else if (before !== after) {
      const name = s.title || s.harness || "Session";
      if (s.activity === "waiting") notes.push(`${name} needs your input`);
      else if (s.activity === "working" || s.activity === "running") notes.push(`${name} is working`);
      else if (s.activity === "finished" || s.status === "finished") notes.push(`${name} finished`);
      else if (s.status === "error") notes.push(`${name} hit an error`);
    }
    if (notes.length >= 2) break;
  }
  narrate.prevActivity = cur;
  if (notes.length && narrate.on) { clearNarrateContent(); speak(notes.join(". "), true); }
}

// Live content narration: session feedback spoken as it updates.
// PTY chunks arrive via maybeNarratePty (SSE hook); web sessions feed via
// a MutationObserver on the focused iframe (observeFrameForNarration).
// Both funnel into narrateFeed → flush (on pause) → sentence queue → pump.
function focusedSessionId() {
  const a = typeof getActivePane === "function" ? getActivePane() : null;
  return a ? a.sessionId : null;
}

function narrateFeed(sessionId, text) {
  if (!narrate.on || !sessionId || !text) return;
  if (sessionId !== focusedSessionId()) return; // background: transitions only
  narrate.pendingText = (narrate.pendingText + "\n" + String(text)).slice(-NARRATE_PENDING_CAP);
  narrate.pendingAt = Date.now();
}

// refresh() tick: sentence-split the paused buffer and queue it.
function flushNarrateContent() {
  if (!narrate.on || !narrate.pendingText) return;
  if (Date.now() - narrate.pendingAt < NARRATE_FLUSH_MS) return;
  const sentences = splitIntoSentences(narrate.pendingText);
  narrate.pendingText = "";
  for (const s of sentences) {
    narrate.contentQueue.push(s);
    while (narrate.contentQueue.length > NARRATE_QUEUE_N) narrate.contentQueue.shift();
  }
  if (sentences.length) pumpNarrateQueue();
}

function clearNarrateContent() {
  narrate.contentQueue = [];
  narrate.pendingText = "";
}

function engineBusy() {
  if (narrate.kokoroBusy) return true;
  try {
    if (window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) return true;
  } catch {}
  return false;
}

function pumpNarrateQueue() {
  if (!narrate.on || engineBusy() || !narrate.contentQueue.length) return;
  const next = narrate.contentQueue.shift();
  narrate.lastContent = String(next).slice(0, 120);
  speak(next, false, () => pumpNarrateQueue());
}

// PTY hook (wired in attachPaneTerm's SSE handler): raw chunk in, queue out.
function maybeNarratePty(sessionId, chunk) {
  if (!chunk) return;
  narrateFeed(sessionId, chunk);
}

// True when el sits inside something the user typed in — keystrokes must
// never be narrated back (prompt box, inputs, editors).
function insideEditable(el) {
  let n = el, depth = 0;
  while (n && depth < 8) {
    if (n.tagName === "TEXTAREA" || n.tagName === "INPUT") return true;
    try { if (n.getAttribute && n.getAttribute("contenteditable") === "true") return true; } catch {}
    n = n.parentElement;
    depth++;
  }
  return false;
}

function stopWebNarration() {
  if (narrate.webObs) { try { narrate.webObs.disconnect(); } catch {} narrate.webObs = null; }
  narrate.webObservedId = null;
}

// Watch the focused web session's transcript: opencode renders messages as
// plain same-origin DOM (virtualized — only live text is present, which is
// exactly what narration wants). Added text buffers into narrateFeed.
function observeFrameForNarration(frame, sessionId) {
  stopWebNarration();
  if (!frame || !sessionId) return;
  let doc = null;
  try { doc = frame.contentDocument; } catch { return; }
  if (!doc || !doc.body) return;
  try {
    const obs = new MutationObserver((muts) => {
      if (!narrate.on || sessionId !== focusedSessionId()) return;
      let buf = "";
      for (const m of muts) {
        if (m.type === "characterData") {
          if (insideEditable(m.target && m.target.parentElement)) continue;
          buf += String((m.target && m.target.data) || "").slice(-500) + "\n";
        } else {
          const added = m.addedNodes || [];
          for (const n of added) {
            if (!n || n.nodeType !== 1) continue;
            if (insideEditable(n)) continue;
            try {
              const t = n.innerText;
              if (t) buf += String(t).slice(0, 2000) + "\n";
            } catch {}
          }
        }
        if (buf.length > 3000) break;
      }
      if (buf) narrateFeed(sessionId, buf);
    });
    obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
    narrate.webObs = obs;
    narrate.webObservedId = sessionId;
  } catch {}
}

// Re-target the transcript observer at the focused pane (call after focus
// changes, session switches, and web-frame loads). Clears stale content.
function observeActivePane() {
  stopWebNarration();
  clearNarrateContent();
  const a = typeof getActivePane === "function" ? getActivePane() : null;
  if (!a || !a.sessionId || !narrate.on) return;
  const s = state.sessions.find((x) => x.id === a.sessionId);
  if (!s || s.mode !== "web") return;
  const f = a._frameCache && a._frameCache.get(a.sessionId);
  if (f && f.isConnected && f.classList && !f.classList.contains("hidden")) {
    observeFrameForNarration(f, a.sessionId);
  }
}

if ($("btnNarrate")) $("btnNarrate").onclick = () => setNarrate(!narrate.on);
paintNarrateButton(); // marks the toggle disabled when the browser has no speech engine
try {
  const saved = localStorage.getItem(NARRATE_KEY);
  if (saved === "1") setNarrate(true, { silent: true });
} catch {}
try {
  if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => pickNarrateVoice();
  }
} catch {}

// ---------- PATH AUTOCOMPLETE (open-folder picker) ----------
// Attaches a directory pick-list to a path <input>. Fetches matches from
// GET /api/paths/complete?q=... , supports mouse pick + Arrow/Enter/Tab/Esc.
// Picking a directory fills input with "dir/" and immediately lists children
// so the user can drill down. Enter/Tab while the list is open picks instead
// of submitting (capture phase + stopPropagation wins over submit handlers).
function attachPathAutocomplete(input) {
  if (!input || input._pathAutoAttached) return;
  input._pathAutoAttached = true;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  const wrap = input.parentElement;
  if (wrap) wrap.classList.add("autocomplete-wrap");
  const list = document.createElement("div");
  list.className = "autocomplete-list hidden";
  (wrap || input.parentNode).appendChild(list);

  let items = [];
  let sel = 0;
  let timer = null;
  let seq = 0;

  function hide() {
    list.classList.add("hidden");
    list.innerHTML = "";
    items = [];
    sel = 0;
    input._pathAutoOpen = false;
  }
  function isOpen() {
    return !list.classList.contains("hidden") && items.length > 0;
  }
  function updateSel() {
    [...list.children].forEach((el, i) => el.classList.toggle("sel", i === sel));
    const active = list.children[sel];
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function pick(i) {
    const it = items[i];
    if (!it) return;
    input.value = it.path + "/";
    hide();
    input.focus();
    schedule(true);
  }
  function render() {
    if (!items.length) { hide(); return; }
    list.innerHTML = "";
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "autocomplete-item" + (i === sel ? " sel" : "");
      b.innerHTML = `<span class="autocomplete-name">${escapeHtml(it.name)}</span>` +
        `<span class="autocomplete-path">${escapeHtml(it.path)}</span>`;
      // mousedown (not click) fires before input blur hides the list.
      b.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
      list.appendChild(b);
    });
    list.classList.remove("hidden");
    input._pathAutoOpen = true;
  }
  async function fetchComplete(q, mySeq) {
    try {
      const r = await fetch(`/api/paths/complete?q=${encodeURIComponent(q)}`);
      if (!r.ok) return;
      const data = await r.json();
      if (mySeq !== seq) return;
      // Guard: input may have changed while fetching — drop stale results.
      if (input.value !== q) return;
      items = (data.entries || []).slice(0, 20);
      sel = 0;
      render();
    } catch {}
  }
  function schedule(immediate) {
    clearTimeout(timer);
    const run = () => { seq++; fetchComplete(input.value, seq); };
    if (immediate) run();
    else timer = setTimeout(run, 150);
  }

  input.addEventListener("input", () => schedule(false));
  input.addEventListener("focus", () => schedule(true));
  input.addEventListener("blur", () => setTimeout(hide, 150));
  input.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation();
      sel = Math.min(sel + 1, items.length - 1);
      updateSel();
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      sel = Math.max(sel - 1, 0);
      updateSel();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault(); e.stopPropagation();
      pick(sel);
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      hide();
    }
  }, true);

  input._pathAutoHide = hide;
}

function openFolderModal() {
  dismissMobileSidebar();
  $("fPath").value = "";
  $("folderModal").classList.remove("hidden");
  $("fPath").focus();
}

function closeFolderModal() {
  $("folderModal").classList.add("hidden");
  try { $("fPath")._pathAutoHide && $("fPath")._pathAutoHide(); } catch {}
}

async function submitFolder() {
  const p = $("fPath").value.trim();
  if (!p) return closeFolderModal();
  closeFolderModal();

  try {
    await api("POST", "/api/workspaces", { path: p });
    status("workspace added", p);
    await refresh();
  } catch (e) {
    status("open failed", e.message);
    alert(`Could not open workspace: ${e.message}`);
  }
}

$("btnSideOpen").onclick = openFolderModal;
$("fPathOk").onclick = submitFolder;
$("fPathCancel").onclick = closeFolderModal;
$("fPath").addEventListener("keydown", (e) => { if (e.key === "Enter") submitFolder(); });
$("folderModal").addEventListener("click", (e) => { if (e.target.id === "folderModal") closeFolderModal(); });

// Directory autocomplete on the folder picker input.
attachPathAutocomplete($("fPath"));

// Home navigation (brand logo returns to dashboard)
$("brandHome").onclick = () => {
  activateSeq++;
  state.switchingIds.clear();
  state.switchingId = null;
  hideStageLoader();
  teardownMain();
  renderWorkspaces();
  renderDash();
};

// Split-screen toolbar wiring
$("btnSplitCols").onclick = () => {
  state.layout = "cols";
  addSplitPane();
  savePaneLayout();
  renderPanes();
};
$("btnSplitRows").onclick = () => {
  state.layout = "rows";
  addSplitPane();
  savePaneLayout();
  renderPanes();
};
$("btnClosePane").onclick = () => {
  const a = getActivePane();
  if (a) closePane(a.pid);
};

$("btnNewSessionTop").onclick = () => quickCreateSession();
$("btnHeroNewSession").onclick = () => quickCreateSession();
$("btnHeroOpenFolder").onclick = openFolderModal;

$("btnNewConsole").onclick = async () => {
  const s = state.sessions.find((x) => x.id === state.activeSessionId);
  const wsId = s ? s.workspaceId : (state.workspaces[0] && state.workspaces[0].id);
  if (!wsId) {
    status("no workspace", "open a folder first");
    return;
  }
  try {
    const c = await api("POST", "/api/consoles", { workspaceId: wsId });
    await refresh();
    activateConsole(c.id);
  } catch (e) {
    status("console failed", e.message);
  }
};

$("btnCollapse").onclick = () => {
  const b = $("bottom");
  b.classList.toggle("collapsed");
};

$("btnMaximizeConsole").onclick = () => {
  const b = $("bottom");
  b.classList.toggle("maximized");
  try { state.conFit && state.conFit.fit(); } catch {}
};

// Drag handle resizes console drawer
$("resizeHandle").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const onMove = (ev) => {
    const h = window.innerHeight - ev.clientY - $("bottom").offsetHeight + $("consoleBody").offsetHeight;
    $("consoleBody").style.height = Math.min(Math.max(h, 80), window.innerHeight * 0.75) + "px";
    try { state.conFit && state.conFit.fit(); } catch {}
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    try { state.conFit && state.conFit.fit(); } catch {}
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// Drag handle resizes left sidebar (persists to localStorage)
(function initSidebarResize() {
  const MIN = 200, MAX = 560, DEF = 290, KEY = "ai-manager.sidebarWidth";
  const left = $("left"), handle = $("sideResize"), middle = $("middle");
  if (!left || !handle || !middle) return;

  const saved = parseInt(localStorage.getItem(KEY) || "", 10);
  if (saved >= MIN && saved <= MAX) left.style.width = saved + "px";

  function applyWidth(px) {
    const w = Math.min(MAX, Math.max(MIN, px));
    left.style.width = w + "px";
    try { for (const p of state.panes) p.fit && p.fit.fit(); } catch {}
    try { state.conFit && state.conFit.fit(); } catch {}
    return w;
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    document.body.classList.add("side-resizing");
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width;
    const onMove = (ev) => applyWidth(startW + ev.clientX - startX);
    let finalW = startW;
    const track = (ev) => { finalW = startW + ev.clientX - startX; onMove(ev); };
    const onUp = () => {
      document.removeEventListener("mousemove", track);
      document.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      document.body.classList.remove("side-resizing");
      try { localStorage.setItem(KEY, String(Math.min(MAX, Math.max(MIN, Math.round(finalW))))); } catch {}
      try { for (const p of state.panes) p.fit && p.fit.fit(); } catch {}
      try { state.conFit && state.conFit.fit(); } catch {}
    };
    document.addEventListener("mousemove", track);
    document.addEventListener("mouseup", onUp);
  });

  // Double-click resets to default width
  handle.addEventListener("dblclick", () => {
    applyWidth(DEF);
    try { localStorage.setItem(KEY, String(DEF)); } catch {}
  });

  // Touch support
  handle.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (!t) return;
    handle.classList.add("dragging");
    const startX = t.clientX;
    const startW = left.getBoundingClientRect().width;
    const onMove = (ev) => {
      const tt = ev.touches[0];
      if (tt) applyWidth(startW + tt.clientX - startX);
    };
    const onEnd = (ev) => {
      const tt = ev.changedTouches && ev.changedTouches[0];
      const w = tt ? startW + tt.clientX - startX : startW;
      try { localStorage.setItem(KEY, String(Math.min(MAX, Math.max(MIN, Math.round(w))))); } catch {}
      handle.classList.remove("dragging");
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
  }, { passive: true });
})();

$("btnSide").onclick = () => {
  if (window.matchMedia("(max-width: 768px)").matches) $("left").classList.toggle("open");
  else $("left").classList.toggle("collapsed");
};
$("btnPalette").onclick = () => (pal.open ? closePal() : openPal());

// ---------- COMMAND PALETTE (CTRL+K) ----------

const pal = { open: false, items: [], sel: 0, q: "" };

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

  // Attention sessions first!
  for (const s of state.sessions) {
    if (s.activity === "waiting") {
      const ws = wsById[s.workspaceId];
      items.push({
        kind: "attention",
        kTag: "ATTN",
        kClass: "k-att",
        label: `Needs Attention: ${s.title || s.id}`,
        sub: `${s.harness} · ${ws ? ws.name : ""} · idle ${fmtIdle(s.idleMs)}`,
        hay: `attention waiting needs you ${s.title || ""} ${s.harness} ${ws ? ws.name : ""}`,
        sessId: s.id,
        run: () => activateSession(s.id),
      });
    }
  }

  // All Sessions
  for (const s of state.sessions) {
    const ws = wsById[s.workspaceId];
    items.push({
      kind: "session",
      kTag: "SESS",
      kClass: "k-sess",
      label: s.title || s.id,
      sub: `${s.harness} · ${ws ? ws.name : ""} · ${s.activity || s.status || "?"}`,
      hay: `${s.title || ""} ${s.harness} ${ws ? ws.name + " " + ws.path : ""} ${s.id}`,
      sessId: s.id,
      run: () => activateSession(s.id),
    });
  }

  // Workspaces
  for (const w of state.workspaces) {
    items.push({
      kind: "workspace",
      kTag: "WS",
      kClass: "k-ws",
      label: w.name,
      sub: w.path,
      hay: `${w.name} ${w.path} workspace folder`,
      run: () => {
        state.closedGroups.delete(w.id);
        renderWorkspaces();
        const el = document.querySelector(`[data-ws="${w.id}"]`);
        if (el) el.scrollIntoView({ block: "nearest" });
      },
    });
  }

  // Actions
  items.push(
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "Launch New Session…", sub: "agent", hay: "new session start agent create", run: () => quickCreateSession() },
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "Open Folder as Workspace…", sub: "folder", hay: "open folder workspace add dir", run: () => openFolderModal() },
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "New Terminal Shell", sub: "terminal", hay: "new console terminal shell pty bash", run: () => $("btnNewConsole").click() },
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "Go to Mission Control Home", sub: "overview", hay: "home mission control overview dash", run: () => $("brandHome").click() },
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "Split vertically (side by side)", sub: "split", hay: "split vertical side by side panes columns", run: () => $("btnSplitCols").click() },
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "Split horizontally (stacked)", sub: "split", hay: "split horizontal stacked panes rows", run: () => $("btnSplitRows").click() },
    { kind: "action", kTag: "ACT", kClass: "k-act", label: "Close split pane", sub: "split", hay: "close split pane unsplit single", run: () => $("btnClosePane").click() },
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
    .slice(0, 14);

  pal.items = scored.map((x) => x.it);
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));

  if (!pal.items.length) {
    list.innerHTML = '<div class="empty-state-text">No matching sessions, workspaces, or actions.</div>';
    return;
  }

  pal.items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "pal-item" + (i === pal.sel ? " sel" : "");

    d.innerHTML = `
      <span class="k ${it.kClass}">${it.kTag}</span>
      <span class="lbl">${escapeHtml(it.label)}</span>
      <span class="sub">${escapeHtml(it.sub || "")}</span>
    `;

    d.onclick = () => { closePal(); it.run(); };
    d.onmousemove = () => { pal.sel = i; updatePalSelection(); };
    list.appendChild(d);
  });
}

function updatePalSelection() {
  const items = document.querySelectorAll(".pal-item");
  items.forEach((el, idx) => el.classList.toggle("sel", idx === pal.sel));
}

function openPal() {
  pal.open = true;
  pal.q = "";
  pal.sel = 0;
  $("palInput").value = "";
  $("palette").classList.remove("hidden");
  renderPal();
  setTimeout(() => $("palInput").focus(), 40);
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
  if (e.key === "ArrowDown") {
    e.preventDefault();
    pal.sel = Math.min(pal.sel + 1, pal.items.length - 1);
    updatePalSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    pal.sel = Math.max(pal.sel - 1, 0);
    updatePalSelection();
  } else if (e.key === "Enter") {
    const it = pal.items[pal.sel];
    if (it) {
      closePal();
      // Shift+Enter opens a session side by side instead of switching.
      if (e.shiftKey && it.sessId) openInSplit(it.sessId);
      else it.run();
    }
  } else if (e.key === "Escape") {
    closePal();
  }
});

$("palette").addEventListener("click", (e) => {
  if (e.target.id === "palette") closePal();
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    pal.open ? closePal() : openPal();
  } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
    e.preventDefault();
    $("bottom").classList.toggle("collapsed");
  } else if (e.key === "Escape") {
    if (pal.open) closePal();
    if (!$("folderModal").classList.contains("hidden")) closeFolderModal();
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Window resize handler for terminals
window.addEventListener("resize", () => {
  try { for (const p of state.panes) p.fit && p.fit.fit(); } catch {}
  try { state.conFit && state.conFit.fit(); } catch {}
});

// Boot
(async function boot() {
  loadDismissedAttention();
  loadAttentionCollapsed();
  const attToggle = $("dashAttentionToggle");
  if (attToggle) attToggle.onclick = () => toggleAttentionCollapsed();
  restorePaneLayout();
  ensurePane();
  renderPanes();
  updateEmptyOverlay();
  try {
    await refresh();
    // Re-attach surviving pane sessions after state loads (prunes dead ids).
    for (const p of state.panes) {
      if (p.sessionId && state.sessions.find((x) => x.id === p.sessionId)) {
        paintPane(p);
      } else if (p.sessionId) {
        teardownPane(p);
        p.sessionId = null;
      }
    }
    syncLegacyActive();
    renderPanes();
    updateEmptyOverlay();
    status(REMOTE ? "connected via tunnel" : "local", location.host);
  } catch (e) {
    status("server unreachable", e.message);
  }
  health();
  setInterval(health, 15000);
  setInterval(refresh, 8000);
})();
