const PORT = 4446;
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? "30");

// ── Types ──────────────────────────────────────────────────────────────────

type LokiEntry = {
  ts: string;
  body: string;
  attributes: Record<string, unknown>;
  level: "info" | "error";
};

type Session = {
  id: string;
  user: string;
  firstTs: string;
  lastTs: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  promptCount: number;
  hasErrors: boolean;
  firstPrompt: string;
};

type TimelineEvent =
  | { kind: "prompt"; ts: string; text: string; sequence: number }
  | { kind: "api"; ts: string; model: string; cost: number; inputTokens: number; outputTokens: number; durationMs: number; cacheReadTokens: number }
  | { kind: "error"; ts: string; code: string; message: string }
  | { kind: "hook"; ts: string; hookEvent: string; durationMs: number };

type SessionDetail = {
  id: string;
  user: string;
  model: string;
  totalCost: number;
  events: TimelineEvent[];
};

// ── Loki Client ────────────────────────────────────────────────────────────

async function queryLoki(query: string, startNs: bigint, endNs: bigint, limit = 5000): Promise<LokiEntry[]> {
  const url = new URL(`${LOKI_URL}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("direction", "forward");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];

  const data = await res.json() as { status: string; data: { result: { stream: Record<string,string>; values: [string, string][] }[] } };
  if (data.status !== "success") return [];

  const entries: LokiEntry[] = [];
  for (const stream of data.data.result) {
    const level = (stream.stream.level ?? "info") as "info" | "error";
    for (const [tsNs, line] of stream.values) {
      try {
        const parsed = JSON.parse(line) as { body?: string; attributes?: Record<string, unknown> };
        entries.push({
          ts: new Date(Number(BigInt(tsNs) / 1_000_000n)).toISOString(),
          body: String(parsed.body ?? ""),
          attributes: parsed.attributes ?? {},
          level,
        });
      } catch {
        // skip malformed lines
      }
    }
  }
  return entries;
}

async function fetchAllEvents(userFilter?: string): Promise<LokiEntry[]> {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const startNs = nowNs - BigInt(LOOKBACK_DAYS) * 86_400_000_000_000n;
  const events = await queryLoki(`{job="claude-code"}`, startNs, nowNs);
  if (!userFilter) return events;
  return events.filter((e) => e.attributes["user.email"] === userFilter);
}

// ── Session Building ───────────────────────────────────────────────────────

function buildSessions(events: LokiEntry[]): Session[] {
  const map = new Map<string, LokiEntry[]>();
  for (const e of events) {
    const sid = String(e.attributes["session.id"] ?? "unknown");
    const arr = map.get(sid) ?? [];
    arr.push(e);
    map.set(sid, arr);
  }

  const sessions: Session[] = [];
  for (const [id, es] of map.entries()) {
    const sorted = [...es].sort((a, b) => a.ts.localeCompare(b.ts));
    const user = String(sorted[0].attributes["user.email"] ?? "unknown");

    let model = "unknown";
    let totalCost = 0;
    let totalTokens = 0;
    let promptCount = 0;
    let hasErrors = false;
    let firstPrompt = "";

    for (const e of sorted) {
      if (e.body === "claude_code.api_request") {
        model = String(e.attributes["model"] ?? model);
        totalCost += Number(e.attributes["cost_usd"] ?? 0);
        totalTokens += Number(e.attributes["input_tokens"] ?? 0) + Number(e.attributes["output_tokens"] ?? 0);
      }
      if (e.body === "claude_code.user_prompt") {
        promptCount++;
        if (!firstPrompt) firstPrompt = String(e.attributes["prompt"] ?? "");
      }
      if (e.body === "claude_code.internal_error") hasErrors = true;
    }

    sessions.push({
      id,
      user,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      model,
      totalCost,
      totalTokens,
      promptCount,
      hasErrors,
      firstPrompt: firstPrompt.slice(0, 120),
    });
  }

  sessions.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  return sessions;
}

function buildTimeline(events: LokiEntry[]): TimelineEvent[] {
  const sorted = [...events].sort((a, b) => {
    const sa = Number(a.attributes["event.sequence"] ?? 0);
    const sb = Number(b.attributes["event.sequence"] ?? 0);
    return sa !== sb ? sa - sb : a.ts.localeCompare(b.ts);
  });

  const timeline: TimelineEvent[] = [];
  for (const e of sorted) {
    if (e.body === "claude_code.user_prompt") {
      timeline.push({
        kind: "prompt",
        ts: e.ts,
        text: String(e.attributes["prompt"] ?? ""),
        sequence: Number(e.attributes["event.sequence"] ?? 0),
      });
    } else if (e.body === "claude_code.api_request") {
      timeline.push({
        kind: "api",
        ts: e.ts,
        model: String(e.attributes["model"] ?? "unknown"),
        cost: Number(e.attributes["cost_usd"] ?? 0),
        inputTokens: Number(e.attributes["input_tokens"] ?? 0),
        outputTokens: Number(e.attributes["output_tokens"] ?? 0),
        durationMs: Number(e.attributes["duration_ms"] ?? 0),
        cacheReadTokens: Number(e.attributes["cache_read_tokens"] ?? 0),
      });
    } else if (e.body === "claude_code.internal_error") {
      timeline.push({
        kind: "error",
        ts: e.ts,
        code: String(e.attributes["error_code"] ?? e.body),
        message: String(e.attributes["error_name"] ?? ""),
      });
    }
    // all other event types (hook_execution_complete, tool_result, etc.) are silently skipped
  }
  return timeline;
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleSessions(userFilter?: string): Promise<Response> {
  const events = await fetchAllEvents(userFilter);
  const sessions = buildSessions(events);

  const allUsers = [...new Set(
    events.map((e) => String(e.attributes["user.email"] ?? "")).filter(Boolean)
  )].sort();

  return new Response(
    JSON.stringify({ sessions, total: sessions.length, availableUsers: allUsers }),
    { headers: { "content-type": "application/json" } }
  );
}

async function handleSession(sessionId: string): Promise<Response> {
  const events = await fetchAllEvents();
  const sessionEvents = events.filter((e) => String(e.attributes["session.id"] ?? "") === sessionId);
  if (sessionEvents.length === 0) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }

  const timeline = buildTimeline(sessionEvents);
  const user = String(sessionEvents[0].attributes["user.email"] ?? "unknown");
  let model = "unknown";
  let totalCost = 0;
  for (const e of sessionEvents) {
    if (e.body === "claude_code.api_request") {
      model = String(e.attributes["model"] ?? model);
      totalCost += Number(e.attributes["cost_usd"] ?? 0);
    }
  }

  const detail: SessionDetail = { id: sessionId, user, model, totalCost, events: timeline };
  return new Response(JSON.stringify(detail), { headers: { "content-type": "application/json" } });
}

// ── HTML ───────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation Viewer</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f0f1a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; height: 100vh; overflow: hidden; }

/* Sidebar */
#sidebar { width: 320px; min-width: 320px; background: #13131f; border-right: 1px solid #2a2a3e; display: flex; flex-direction: column; overflow: hidden; }
#sidebar-header { padding: 14px 16px 10px; border-bottom: 1px solid #2a2a3e; }
#sidebar-header h1 { font-size: 15px; font-weight: 600; color: #a5b4fc; }
#sidebar-header .count { font-size: 11px; color: #64748b; margin-top: 2px; }
#user-filter { display: flex; gap: 5px; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid #1e1e30; background: #0f0f1a; }
#user-filter button { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid #2a2a3e; background: #1a1a2e; color: #94a3b8; cursor: pointer; transition: all 0.1s; }
#user-filter button.active { background: #1e2a4a; color: #93c5fd; border-color: #3b5cb8; }
#user-filter button:hover { background: #1e2a4a; }
#session-list { flex: 1; overflow-y: auto; }

/* Session rows */
.session-row { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #1a1a2e; transition: background 0.1s; }
.session-row:hover { background: #1a1a2e; }
.session-row.active { background: #1e2a4a; border-left: 3px solid #6366f1; padding-left: 11px; }
.session-row .ts { font-size: 10px; color: #64748b; }
.session-row .title { font-size: 12px; color: #c4cfd9; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; line-height: 1.4; }
.session-row .meta { display: flex; gap: 5px; align-items: center; margin-top: 5px; flex-wrap: wrap; }

/* Badges */
.badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; white-space: nowrap; }
.badge-model { background: #1e2a4a; color: #93c5fd; }
.badge-prompts { background: #1e2e1e; color: #86efac; }
.badge-cost { background: #252016; color: #fbbf24; }
.badge-error { background: #3f1a1a; color: #fca5a5; }
.badge-user { background: #1e1e36; color: #a78bfa; }

/* Main area */
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#thread-header { padding: 10px 18px; border-bottom: 1px solid #2a2a3e; display: flex; gap: 10px; align-items: center; min-height: 46px; flex-wrap: wrap; }
#thread-header .session-id { font-size: 11px; color: #4a5568; font-family: monospace; cursor: pointer; user-select: all; }
#thread-header .session-id:hover { color: #64748b; }
#thread-header .info { font-size: 12px; color: #64748b; }
#thread-header .btn { font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid #2a2a3e; background: #1a1a2e; color: #94a3b8; cursor: pointer; margin-left: auto; }
#thread-header .btn:hover { background: #222236; }
#thread { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: #4a5568; text-align: center; margin: auto; font-size: 14px; }

/* Timeline events */
.tl-prompt { display: flex; flex-direction: column; align-items: flex-end; }
.tl-prompt .bubble { background: #2d4a7a; color: #e2e8f0; padding: 9px 13px; border-radius: 12px 12px 3px 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 76%; }
.tl-prompt .evt-meta { font-size: 10px; color: #4a5568; margin-top: 3px; text-align: right; }

.tl-api { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.tl-api .api-line { flex: 1; height: 1px; background: #1e1e30; }
.tl-api .api-badge { font-size: 11px; color: #64748b; background: #161622; border: 1px solid #1e1e30; padding: 2px 8px; border-radius: 10px; white-space: nowrap; font-family: monospace; }
.tl-api .api-badge .model-name { color: #a78bfa; }
.tl-api .api-badge .cost { color: #fbbf24; }

.tl-error { background: #1f0f0f; border: 1px solid #4a1a1a; border-radius: 8px; padding: 7px 12px; font-size: 12px; color: #fca5a5; font-family: monospace; }
.tl-error .err-ts { font-size: 10px; color: #64748b; margin-bottom: 2px; }

.tl-hook { font-size: 11px; color: #374151; text-align: center; padding: 2px 0; font-family: monospace; }

/* Scrollbar */
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2a2a3e; border-radius: 3px; }

/* Copy feedback */
.copied { animation: fade 0.8s ease; }
@keyframes fade { 0% { opacity: 1; } 100% { opacity: 0.4; } }
</style>
</head>
<body>
<div id="sidebar">
  <div id="sidebar-header">
    <h1>Conversations</h1>
    <div class="count" id="count">Loading…</div>
  </div>
  <div id="user-filter" style="display:none"></div>
  <div id="session-list"></div>
</div>
<div id="main">
  <div id="thread-header"><span class="info">Select a conversation</span></div>
  <div id="thread"><div class="empty">← Select a conversation to view</div></div>
</div>
<script>
let activeId = null;
let activeUser = null;
let showAllUsers = true;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

function fmtCost(n) {
  if (n === 0) return null;
  return n < 0.01 ? '<$0.01' : '$' + n.toFixed(2);
}

function fmtTokens(n) {
  return n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n);
}

async function loadSessions() {
  const url = '/api/sessions' + (activeUser ? '?user=' + encodeURIComponent(activeUser) : '');
  const r = await fetch(url);
  const data = await r.json();

  document.getElementById('count').textContent = data.total + ' sessions';

  // User filter
  const filterEl = document.getElementById('user-filter');
  if (data.availableUsers && data.availableUsers.length > 1) {
    filterEl.style.display = 'flex';
    filterEl.innerHTML =
      '<button class="' + (showAllUsers ? 'active' : '') + '" onclick="setUser(null)">All</button>' +
      data.availableUsers.map(u => {
        const short = u.replace(/@.*/, '') + '@…';
        const active = (!showAllUsers && activeUser === u) ? 'active' : '';
        return '<button class="' + active + '" onclick="setUser(' + JSON.stringify(u) + ')" title="' + esc(u) + '">' + esc(short) + '</button>';
      }).join('');
  } else {
    filterEl.style.display = 'none';
  }

  const multiUser = data.availableUsers && data.availableUsers.length > 1;

  document.getElementById('session-list').innerHTML = data.sessions.map(s => {
    const cost = fmtCost(s.totalCost);
    const title = s.firstPrompt
      ? esc(s.firstPrompt.length > 72 ? s.firstPrompt.slice(0, 72) + '…' : s.firstPrompt)
      : '<span style="color:#4a5568;font-style:italic">No prompts</span>';
    return \`<div class="session-row \${s.id === activeId ? 'active' : ''}" onclick="loadSession('\${esc(s.id)}')">
      <div class="ts">\${fmt(s.lastTs)}</div>
      <div class="title">\${title}</div>
      <div class="meta">
        \${s.model !== 'unknown' ? \`<span class="badge badge-model">\${esc(s.model.replace('claude-',''))}</span>\` : ''}
        \${s.promptCount > 0 ? \`<span class="badge badge-prompts">\${s.promptCount} prompts</span>\` : ''}
        \${cost ? \`<span class="badge badge-cost">\${esc(cost)}</span>\` : ''}
        \${s.hasErrors ? '<span class="badge badge-error">errors</span>' : ''}
        \${multiUser && showAllUsers ? \`<span class="badge badge-user">\${esc(s.user.replace(/@.*/, ''))}</span>\` : ''}
      </div>
    </div>\`;
  }).join('');
}

function setUser(user) {
  activeUser = user;
  showAllUsers = user === null;
  loadSessions();
}

async function loadSession(id) {
  activeId = id;
  document.querySelectorAll('.session-row').forEach(r => {
    r.classList.toggle('active', r.getAttribute('onclick')?.includes(id));
  });

  const r = await fetch('/api/sessions/' + encodeURIComponent(id));
  if (!r.ok) return;
  const data = await r.json();

  const cost = fmtCost(data.totalCost);
  document.getElementById('thread-header').innerHTML =
    \`<span class="badge badge-model">\${esc(data.model)}</span>
     <span class="info">\${data.events.filter(e=>e.kind==='prompt').length} prompts</span>
     \${cost ? \`<span class="badge badge-cost">\${esc(cost)}</span>\` : ''}
     <span class="session-id" title="Click to copy" onclick="copyId('\${esc(id)}')">\${esc(id.slice(0,8))}…</span>
     <button class="btn" onclick="toggleAll()">Expand all</button>\`;

  let expanded = false;
  window._toggleAll = function() {
    expanded = !expanded;
    document.querySelectorAll('.tool-body').forEach(el => el.classList.toggle('open', expanded));
    document.querySelector('#thread-header .btn').textContent = expanded ? 'Collapse all' : 'Expand all';
  };

  const thread = document.getElementById('thread');
  thread.innerHTML = data.events.map(ev => renderEvent(ev)).join('');
  thread.scrollTop = thread.scrollHeight;
  loadSessions();
}

function toggleAll() { window._toggleAll && window._toggleAll(); }

function copyId(id) {
  navigator.clipboard.writeText(id);
  const el = document.querySelector('.session-id');
  if (el) { el.textContent = 'copied!'; setTimeout(() => el.textContent = id.slice(0,8) + '…', 1200); }
}

function renderEvent(ev) {
  if (ev.kind === 'prompt') {
    return \`<div class="tl-prompt">
      <div class="bubble">\${esc(ev.text)}</div>
      <div class="evt-meta">\${fmtTime(ev.ts)}</div>
    </div>\`;
  }
  if (ev.kind === 'api') {
    const parts = [
      \`<span class="model-name">\${esc(ev.model.replace('claude-',''))}</span>\`,
      ev.durationMs ? (ev.durationMs/1000).toFixed(1) + 's' : null,
      ev.inputTokens + ev.outputTokens > 0 ? fmtTokens(ev.inputTokens + ev.outputTokens) + ' tok' : null,
      ev.cacheReadTokens > 0 ? fmtTokens(ev.cacheReadTokens) + ' cached' : null,
      fmtCost(ev.cost) ? \`<span class="cost">\${esc(fmtCost(ev.cost))}</span>\` : null,
    ].filter(Boolean);
    return \`<div class="tl-api">
      <div class="api-line"></div>
      <div class="api-badge">✦ \${parts.join(' · ')}</div>
      <div class="api-line"></div>
    </div>\`;
  }
  if (ev.kind === 'error') {
    return \`<div class="tl-error">
      <div class="err-ts">\${fmtTime(ev.ts)}</div>
      ⚠ \${esc(ev.code)}\${ev.message ? ' · ' + esc(ev.message) : ''}
    </div>\`;
  }
  if (ev.kind === 'hook') {
    return \`<div class="tl-hook">⚙ \${esc(ev.hookEvent)} · \${ev.durationMs}ms</div>\`;
  }
  return '';
}

loadSessions();
setInterval(loadSessions, 30000);
</script>
</body>
</html>`;

// ── Router ─────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/sessions") {
      const user = url.searchParams.get("user") ?? undefined;
      return handleSessions(user);
    }
    if (url.pathname.startsWith("/api/sessions/")) {
      return handleSession(decodeURIComponent(url.pathname.slice(14)));
    }
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[conv-viewer] listening on http://localhost:${PORT} (Loki: ${LOKI_URL}, lookback: ${LOOKBACK_DAYS}d)`);
