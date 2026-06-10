import { readFileSync } from "fs";

const PORT = 4446;
const LOG_PATH = `${process.env.HOME}/.llm-privacy/prompts.jsonl`;

type LogEntry = {
  ts: string;
  sessionId: string;
  matchCount: number;
  tokenized: string[];
  model?: string;
};

type ContentBlock = { type: string; [key: string]: unknown };
type MessageContent = string | ContentBlock[];

function parseContent(s: string): MessageContent {
  try { return JSON.parse(s) as MessageContent; } catch { return s; }
}

function readLogEntries(): LogEntry[] {
  try {
    const text = readFileSync(LOG_PATH, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
      .filter(Boolean) as LogEntry[];
  } catch { return []; }
}

function groupBySessions(entries: LogEntry[]): Map<string, LogEntry[]> {
  const map = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.sessionId) ?? [];
    arr.push(e);
    map.set(e.sessionId, arr);
  }
  return map;
}

function handleSessions(): Response {
  const entries = readLogEntries();
  const sessions = groupBySessions(entries);

  const list = Array.from(sessions.entries()).map(([id, es]) => {
    const sorted = [...es].sort((a, b) => a.ts.localeCompare(b.ts));
    const last = sorted[sorted.length - 1];
    return {
      id,
      firstTs: sorted[0].ts,
      lastTs: last.ts,
      messageCount: last.tokenized.length,
      piiCount: es.reduce((n, e) => n + e.matchCount, 0),
      model: last.model ?? "unknown",
    };
  });

  list.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  return new Response(JSON.stringify({ sessions: list, total: list.length }), {
    headers: { "content-type": "application/json" },
  });
}

function handleSession(sessionId: string): Response {
  const entries = readLogEntries().filter((e) => e.sessionId === sessionId);
  if (entries.length === 0) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  const latest = entries[entries.length - 1];

  const roles = ["user", "assistant"];
  const messages = latest.tokenized.map((t, i) => ({
    role: roles[i % 2] as "user" | "assistant",
    content: parseContent(t),
  }));

  return new Response(
    JSON.stringify({ sessionId, matchCount: latest.matchCount, model: latest.model ?? "unknown", messages }),
    { headers: { "content-type": "application/json" } }
  );
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PAI Conversations</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f1a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #sidebar { width: 320px; min-width: 320px; background: #13131f; border-right: 1px solid #2a2a3e; display: flex; flex-direction: column; overflow: hidden; }
  #sidebar-header { padding: 16px; border-bottom: 1px solid #2a2a3e; }
  #sidebar-header h1 { font-size: 16px; font-weight: 600; color: #a5b4fc; }
  #sidebar-header .count { font-size: 12px; color: #64748b; margin-top: 2px; }
  #session-list { flex: 1; overflow-y: auto; }
  .session-row { padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #1e1e30; transition: background 0.1s; }
  .session-row:hover { background: #1a1a2e; }
  .session-row.active { background: #1e2a4a; border-left: 3px solid #6366f1; }
  .session-row .ts { font-size: 11px; color: #64748b; }
  .session-row .meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; }
  .badge-model { background: #1e2a4a; color: #93c5fd; }
  .badge-msgs { background: #1e2e1e; color: #86efac; }
  .badge-pii { background: #3f1a1a; color: #fca5a5; }
  #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #thread-header { padding: 12px 20px; border-bottom: 1px solid #2a2a3e; display: flex; gap: 8px; align-items: center; min-height: 48px; }
  #thread-header .info { font-size: 12px; color: #64748b; }
  #thread { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .empty { color: #4a5568; text-align: center; margin: auto; font-size: 14px; }
  .msg { display: flex; flex-direction: column; max-width: 75%; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }
  .msg-role { font-size: 10px; color: #64748b; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.05em; }
  .bubble { padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 100%; }
  .msg.user .bubble { background: #2d4a7a; color: #e2e8f0; border-bottom-right-radius: 3px; }
  .msg.assistant .bubble { background: #1e1e2e; color: #e2e8f0; border-bottom-left-radius: 3px; }
  .tool-card { background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 8px; font-size: 12px; overflow: hidden; max-width: 480px; }
  .tool-card.tool-result { border-color: #1a3a1a; }
  .tool-header { padding: 6px 10px; background: #222236; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
  .tool-header .name { color: #a78bfa; font-weight: 600; }
  .tool-header .type { color: #64748b; font-size: 10px; }
  .tool-body { padding: 8px 10px; font-family: monospace; color: #94a3b8; font-size: 11px; white-space: pre-wrap; overflow-x: auto; max-height: 200px; overflow-y: auto; display: none; }
  .tool-body.open { display: block; }
  .pii-badge { font-size: 11px; color: #fca5a5; margin-top: 4px; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2a3e; border-radius: 3px; }
</style>
</head>
<body>
<div id="sidebar">
  <div id="sidebar-header">
    <h1>Conversations</h1>
    <div class="count" id="count">Loading...</div>
  </div>
  <div id="session-list"></div>
</div>
<div id="main">
  <div id="thread-header"><span class="info">Select a conversation</span></div>
  <div id="thread"><div class="empty">← Select a conversation to view</div></div>
</div>
<script>
let activeId = null;

function fmt(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderContent(content) {
  if (typeof content === 'string') return escHtml(content);
  if (!Array.isArray(content)) return escHtml(JSON.stringify(content));
  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') return escHtml(block.text || '');
    if (block.type === 'tool_use') {
      const uid = 'tool-' + Math.random().toString(36).slice(2);
      return \`<div class="tool-card">
        <div class="tool-header" onclick="document.getElementById('\${uid}').classList.toggle('open')">
          <span class="name">🔧 \${escHtml(block.name || 'tool')}</span>
          <span class="type">tool_use ▾</span>
        </div>
        <div class="tool-body" id="\${uid}">\${escHtml(JSON.stringify(block.input, null, 2))}</div>
      </div>\`;
    }
    if (block.type === 'tool_result') {
      const uid = 'res-' + Math.random().toString(36).slice(2);
      const c = Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\\n') : (block.content || '');
      return \`<div class="tool-card tool-result">
        <div class="tool-header" onclick="document.getElementById('\${uid}').classList.toggle('open')">
          <span class="name">✅ tool result</span>
          <span class="type">tool_result ▾</span>
        </div>
        <div class="tool-body" id="\${uid}">\${escHtml(c)}</div>
      </div>\`;
    }
    return \`<div class="tool-card"><div class="tool-header"><span class="name">\${escHtml(block.type)}</span></div></div>\`;
  }).join('');
}

async function loadSessions() {
  const r = await fetch('/api/sessions');
  const data = await r.json();
  const list = document.getElementById('session-list');
  document.getElementById('count').textContent = data.total + ' conversations';
  list.innerHTML = data.sessions.map(s => \`
    <div class="session-row \${s.id === activeId ? 'active' : ''}" onclick="loadSession('\${escHtml(s.id)}')">
      <div class="ts">\${fmt(s.lastTs)}</div>
      <div class="meta">
        <span class="badge badge-model">\${escHtml(s.model)}</span>
        <span class="badge badge-msgs">\${s.messageCount} msgs</span>
        \${s.piiCount > 0 ? \`<span class="badge badge-pii">🔒 \${s.piiCount} PII</span>\` : ''}
      </div>
    </div>
  \`).join('');
}

async function loadSession(id) {
  activeId = id;
  document.querySelectorAll('.session-row').forEach(r => {
    r.classList.toggle('active', r.onclick && r.getAttribute('onclick')?.includes(id));
  });
  const r = await fetch('/api/sessions/' + encodeURIComponent(id));
  if (!r.ok) return;
  const data = await r.json();
  document.getElementById('thread-header').innerHTML =
    \`<span class="badge badge-model">\${escHtml(data.model)}</span>
     <span class="info">\${data.messages.length} messages · \${data.matchCount > 0 ? '🔒 ' + data.matchCount + ' PII tokens redacted' : 'no PII redactions'}</span>\`;
  const thread = document.getElementById('thread');
  thread.innerHTML = data.messages.map(msg => {
    const bodyHtml = renderContent(msg.content);
    return \`<div class="msg \${msg.role}">
      <div class="msg-role">\${msg.role}</div>
      <div class="bubble">\${bodyHtml}</div>
    </div>\`;
  }).join('');
  thread.scrollTop = thread.scrollHeight;
  loadSessions();
}

loadSessions();
setInterval(loadSessions, 30000);
</script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/sessions") return handleSessions();
    if (url.pathname.startsWith("/api/sessions/")) {
      return handleSession(decodeURIComponent(url.pathname.slice(14)));
    }
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});
console.log(`[conv-viewer] listening on http://localhost:${PORT}`);
