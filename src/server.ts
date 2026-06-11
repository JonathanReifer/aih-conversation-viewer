import { readFileSync } from "fs";

const PORT = 4446;
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? "30");
const LOG_PATH = process.env.LOG_PATH ?? `${process.env.HOME}/.llm-privacy/prompts.jsonl`;

// ── Shared types ───────────────────────────────────────────────────────────

type Source = "otel" | "proxy" | "unified";

// Session summary returned by /api/sessions for all sources
type SessionSummary = {
  id: string;
  source: Source;
  firstTs: string;
  lastTs: string;
  firstPrompt: string;
  model: string;
  // otel
  user?: string;
  totalCost?: number;
  totalTokens?: number;
  promptCount?: number;
  hasErrors?: boolean;
  // proxy
  messageCount?: number;
  piiCount?: number;
  // unified — either or both may be set
  otelId?: string;
  proxyId?: string;
};

// ── OTEL / Loki types ──────────────────────────────────────────────────────

type LokiEntry = {
  ts: string;
  body: string;
  attributes: Record<string, unknown>;
  level: "info" | "error";
};

type OtelTimelineEvent =
  | { kind: "prompt"; ts: string; text: string; sequence: number }
  | { kind: "api"; ts: string; model: string; cost: number; inputTokens: number; outputTokens: number; durationMs: number; cacheReadTokens: number }
  | { kind: "tool"; ts: string; toolName: string; toolUseId: string; input: unknown; decision: string; executed: boolean; resultSizeBytes: number; success: boolean; durationMs: number }
  | { kind: "hook"; ts: string; hookEvent: string; hookName: string; hookSource: string; numHooks: number; durationMs: number }
  | { kind: "system"; ts: string; subkind: string; detail: Record<string, unknown> }
  | { kind: "error"; ts: string; code: string; message: string };

// ── Proxy / JSONL types ────────────────────────────────────────────────────

type ProxyLogEntry = {
  ts: string;
  sessionId: string;
  matchCount: number;
  tokenized: string[];
  model?: string;
};

type ContentBlock = { type: string; [key: string]: unknown };
type MessageContent = string | ContentBlock[];

type ProxyMessage = {
  role: "user" | "assistant";
  content: MessageContent;
};

// ── Proxy data layer ───────────────────────────────────────────────────────

function parseContent(s: string): MessageContent {
  try { return JSON.parse(s) as MessageContent; } catch { return s; }
}

function readProxyEntries(): ProxyLogEntry[] {
  try {
    return readFileSync(LOG_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as ProxyLogEntry; } catch { return null; } })
      .filter(Boolean) as ProxyLogEntry[];
  } catch { return []; }
}

type ProxySession = {
  id: string;
  firstTs: string;
  lastTs: string;
  model: string;
  messageCount: number;
  piiCount: number;
  firstPrompt: string;
  messages: ProxyMessage[];
};

function extractFirstPrompt(messages: ProxyMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const c = msg.content;
    if (typeof c === "string") return c.replace(/<[^>]+>/g, " ").trim().slice(0, 120);
    if (Array.isArray(c)) {
      const txt = (c as ContentBlock[]).find((b) => b.type === "text");
      if (txt) return String(txt.text ?? "").replace(/<[^>]+>/g, " ").trim().slice(0, 120);
    }
  }
  return "";
}

function segmentProxySessions(startTs?: string, endTs?: string): ProxySession[] {
  let entries = readProxyEntries().sort((a, b) => a.ts.localeCompare(b.ts));
  if (startTs) entries = entries.filter(e => e.ts >= startTs);
  if (endTs) entries = entries.filter(e => e.ts <= endTs + 'Z');

  const GAP_MS = 90 * 60 * 1000;
  const groups: ProxyLogEntry[][] = [];
  let current: ProxyLogEntry[] = [];

  for (const e of entries) {
    const prevTs = current.length ? new Date(current[current.length - 1].ts).getTime() : 0;
    if (current.length > 0 && (new Date(e.ts).getTime() - prevTs) > GAP_MS) {
      groups.push(current);
      current = [e];
    } else {
      current.push(e);
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group): ProxySession => {
    const best = group.reduce((a, b) => a.tokenized.length >= b.tokenized.length ? a : b);
    const sorted = [...group].sort((a, b) => a.ts.localeCompare(b.ts));
    const roles: Array<"user" | "assistant"> = ["user", "assistant"];
    const messages: ProxyMessage[] = best.tokenized.map((t, i) => ({
      role: roles[i % 2],
      content: parseContent(t),
    }));
    return {
      id: sorted[0].ts,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      model: best.model ?? "unknown",
      messageCount: messages.length,
      piiCount: group.reduce((n, e) => n + e.matchCount, 0),
      firstPrompt: extractFirstPrompt(messages),
      messages,
    };
  }).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// ── OTEL / Loki data layer ─────────────────────────────────────────────────

async function queryLoki(query: string, startNs: bigint, endNs: bigint, limit = 5000): Promise<LokiEntry[]> {
  const url = new URL(`${LOKI_URL}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("direction", "backward");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const data = await res.json() as { status: string; data: { result: { stream: Record<string, string>; values: [string, string][] }[] } };
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
      } catch { /* skip */ }
    }
  }
  return entries;
}

async function fetchOtelEvents(userFilter?: string, startTs?: string, endTs?: string): Promise<LokiEntry[]> {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const startNs = startTs
    ? BigInt(new Date(startTs).getTime()) * 1_000_000n
    : nowNs - BigInt(LOOKBACK_DAYS) * 86_400_000_000_000n;
  const endNs = endTs ? BigInt(new Date(endTs + 'T23:59:59Z').getTime()) * 1_000_000n : nowNs;
  const events = await queryLoki(`{job="claude-code"}`, startNs, endNs);
  return userFilter ? events.filter((e) => e.attributes["user.email"] === userFilter) : events;
}

type OtelSession = {
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
  events: LokiEntry[];
};

function buildOtelSessions(events: LokiEntry[]): OtelSession[] {
  const map = new Map<string, LokiEntry[]>();
  for (const e of events) {
    const sid = String(e.attributes["session.id"] ?? "unknown");
    const arr = map.get(sid) ?? [];
    arr.push(e);
    map.set(sid, arr);
  }

  return Array.from(map.entries()).map(([id, es]): OtelSession => {
    const sorted = [...es].sort((a, b) => a.ts.localeCompare(b.ts));
    let model = "unknown", totalCost = 0, totalTokens = 0, promptCount = 0, hasErrors = false, firstPrompt = "";
    for (const e of sorted) {
      if (e.body === "claude_code.api_request") {
        model = String(e.attributes["model"] ?? model);
        totalCost += Number(e.attributes["cost_usd"] ?? 0);
        totalTokens += Number(e.attributes["input_tokens"] ?? 0) + Number(e.attributes["output_tokens"] ?? 0);
      }
      if (e.body === "claude_code.user_prompt") {
        promptCount++;
        if (!firstPrompt) firstPrompt = String(e.attributes["prompt"] ?? "").slice(0, 120);
      }
      if (e.body === "claude_code.internal_error") hasErrors = true;
    }
    return {
      id,
      user: String(sorted[0].attributes["user.email"] ?? "unknown"),
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      model, totalCost, totalTokens, promptCount, hasErrors, firstPrompt,
      events: es,
    };
  }).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

function buildOtelTimeline(events: LokiEntry[]): OtelTimelineEvent[] {
  const sorted = [...events].sort((a, b) => {
    const sa = Number(a.attributes["event.sequence"] ?? 0);
    const sb = Number(b.attributes["event.sequence"] ?? 0);
    return sa !== sb ? sa - sb : a.ts.localeCompare(b.ts);
  });

  // Pass 1: index tool_result events by tool_use_id
  const resultByToolUseId = new Map<string, LokiEntry>();
  for (const e of sorted) {
    if (e.body === "claude_code.tool_result") {
      resultByToolUseId.set(String(e.attributes["tool_use_id"] ?? ""), e);
    }
  }

  // Index hook_execution_complete by (hookName + "_" + seq) for duration lookup
  const hookCompleteByKey = new Map<string, LokiEntry>();
  for (const e of sorted) {
    if (e.body === "claude_code.hook_execution_complete") {
      const seq = Number(e.attributes["event.sequence"] ?? 0);
      const hookName = String(e.attributes["hook_name"] ?? "");
      hookCompleteByKey.set(hookName + "_" + (seq - 1), e);
    }
  }

  const timeline: OtelTimelineEvent[] = [];
  for (const e of sorted) {
    if (e.body === "claude_code.user_prompt") {
      timeline.push({ kind: "prompt", ts: e.ts, text: String(e.attributes["prompt"] ?? ""), sequence: Number(e.attributes["event.sequence"] ?? 0) });
    } else if (e.body === "claude_code.api_request") {
      timeline.push({ kind: "api", ts: e.ts, model: String(e.attributes["model"] ?? "unknown"), cost: Number(e.attributes["cost_usd"] ?? 0), inputTokens: Number(e.attributes["input_tokens"] ?? 0), outputTokens: Number(e.attributes["output_tokens"] ?? 0), durationMs: Number(e.attributes["duration_ms"] ?? 0), cacheReadTokens: Number(e.attributes["cache_read_tokens"] ?? 0) });
    } else if (e.body === "claude_code.tool_decision") {
      // tool_decision fires for every invocation (approved/blocked/rejected/auto)
      // Merge tool_result data when available (executed tools)
      const toolUseId = String(e.attributes["tool_use_id"] ?? "");
      const result = resultByToolUseId.get(toolUseId);
      let inputParsed: unknown = result
        ? result.attributes["tool_input"]
        : e.attributes["tool_parameters"];
      try { inputParsed = JSON.parse(String(inputParsed)); } catch { /* keep string */ }
      timeline.push({
        kind: "tool",
        ts: e.ts,
        toolName: String(e.attributes["tool_name"] ?? "tool"),
        toolUseId,
        decision: String(e.attributes["decision"] ?? "accept"),
        input: inputParsed,
        executed: !!result,
        resultSizeBytes: result ? Number(result.attributes["tool_result_size_bytes"] ?? 0) : 0,
        success: result ? String(result.attributes["success"]) === "true" : false,
        durationMs: result ? Number(result.attributes["duration_ms"] ?? 0) : 0,
      });
      // tool_result is consumed via the map — not emitted separately
    } else if (e.body === "claude_code.hook_execution_start") {
      const seq = Number(e.attributes["event.sequence"] ?? 0);
      const hookName = String(e.attributes["hook_name"] ?? "");
      const complete = hookCompleteByKey.get(hookName + "_" + seq);
      timeline.push({
        kind: "hook",
        ts: e.ts,
        hookEvent: String(e.attributes["hook_event"] ?? ""),
        hookName,
        hookSource: String(e.attributes["hook_source"] ?? ""),
        numHooks: Number(e.attributes["num_hooks"] ?? 1),
        durationMs: complete ? Number(complete.attributes["total_duration_ms"] ?? 0) : 0,
      });
    } else if (e.body === "claude_code.compaction") {
      timeline.push({ kind: "system", ts: e.ts, subkind: "compaction", detail: {
        preTokens: Number(e.attributes["pre_tokens"] ?? 0),
        postTokens: Number(e.attributes["post_tokens"] ?? 0),
        durationMs: Number(e.attributes["duration_ms"] ?? 0),
      }});
    } else if (e.body === "claude_code.skill_activated") {
      timeline.push({ kind: "system", ts: e.ts, subkind: "skill", detail: {
        skillName: String(e.attributes["skill.name"] ?? ""),
        trigger: String(e.attributes["invocation_trigger"] ?? ""),
      }});
    } else if (e.body === "claude_code.subagent_completed") {
      timeline.push({ kind: "system", ts: e.ts, subkind: "subagent", detail: {
        agentType: String(e.attributes["agent_type"] ?? ""),
        model: String(e.attributes["model"] ?? ""),
        totalTokens: Number(e.attributes["total_tokens"] ?? 0),
        durationMs: Number(e.attributes["duration_ms"] ?? 0),
      }});
    } else if (e.body === "claude_code.permission_mode_changed") {
      timeline.push({ kind: "system", ts: e.ts, subkind: "permission", detail: {
        fromMode: String(e.attributes["from_mode"] ?? ""),
        toMode: String(e.attributes["to_mode"] ?? ""),
        trigger: String(e.attributes["trigger"] ?? ""),
      }});
    } else if (e.body === "claude_code.internal_error") {
      timeline.push({ kind: "error", ts: e.ts, code: String(e.attributes["error_code"] ?? e.body), message: String(e.attributes["error_name"] ?? "") });
    }
  }
  return timeline;
}

// ── Unified correlation ────────────────────────────────────────────────────

type UnifiedSession = SessionSummary & {
  otelSession?: OtelSession;
  proxySession?: ProxySession;
};

function correlate(otelSessions: OtelSession[], proxySessions: ProxySession[]): UnifiedSession[] {
  const TOLERANCE_MS = 10 * 60 * 1000; // 10-minute overlap tolerance
  const used = new Set<string>();

  const unified: UnifiedSession[] = proxySessions.map((proxy): UnifiedSession => {
    const pStart = new Date(proxy.firstTs).getTime() - TOLERANCE_MS;
    const pEnd = new Date(proxy.lastTs).getTime() + TOLERANCE_MS;
    const matched = otelSessions.find((o) => {
      if (used.has(o.id)) return false;
      const oStart = new Date(o.firstTs).getTime();
      const oEnd = new Date(o.lastTs).getTime();
      return Math.max(pStart, oStart) <= Math.min(pEnd, oEnd);
    });
    if (matched) used.add(matched.id);

    return {
      id: proxy.id,
      source: "unified",
      firstTs: matched ? (proxy.firstTs < matched.firstTs ? proxy.firstTs : matched.firstTs) : proxy.firstTs,
      lastTs: matched ? (proxy.lastTs > matched.lastTs ? proxy.lastTs : matched.lastTs) : proxy.lastTs,
      firstPrompt: proxy.firstPrompt,
      model: matched?.model ?? proxy.model,
      user: matched?.user,
      totalCost: matched?.totalCost,
      totalTokens: matched?.totalTokens,
      promptCount: matched?.promptCount,
      hasErrors: matched?.hasErrors,
      messageCount: proxy.messageCount,
      piiCount: proxy.piiCount,
      otelId: matched?.id,
      proxyId: proxy.id,
      otelSession: matched,
      proxySession: proxy,
    };
  });

  // Append OTEL-only sessions (no proxy match)
  for (const o of otelSessions) {
    if (!used.has(o.id)) {
      unified.push({
        id: o.id, source: "unified", firstTs: o.firstTs, lastTs: o.lastTs,
        firstPrompt: o.firstPrompt, model: o.model, user: o.user,
        totalCost: o.totalCost, totalTokens: o.totalTokens, promptCount: o.promptCount,
        hasErrors: o.hasErrors, otelId: o.id, otelSession: o,
      });
    }
  }

  return unified.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

async function handleSessions(source: Source, userFilter?: string, startTs?: string, endTs?: string): Promise<Response> {
  let sessions: SessionSummary[];
  let availableUsers: string[] = [];

  if (source === "otel") {
    const events = await fetchOtelEvents(userFilter, startTs, endTs);
    const otel = buildOtelSessions(events);
    availableUsers = [...new Set(events.map((e) => String(e.attributes["user.email"] ?? "")).filter(Boolean))].sort();
    sessions = otel.map((o): SessionSummary => ({ id: o.id, source: "otel", firstTs: o.firstTs, lastTs: o.lastTs, firstPrompt: o.firstPrompt, model: o.model, user: o.user, totalCost: o.totalCost, totalTokens: o.totalTokens, promptCount: o.promptCount, hasErrors: o.hasErrors }));
  } else if (source === "proxy") {
    const proxy = segmentProxySessions(startTs, endTs);
    sessions = proxy.map((p): SessionSummary => ({ id: p.id, source: "proxy", firstTs: p.firstTs, lastTs: p.lastTs, firstPrompt: p.firstPrompt, model: p.model, messageCount: p.messageCount, piiCount: p.piiCount }));
  } else {
    const [events, proxy] = await Promise.all([fetchOtelEvents(userFilter, startTs, endTs), Promise.resolve(segmentProxySessions(startTs, endTs))]);
    const otel = buildOtelSessions(events);
    availableUsers = [...new Set(events.map((e) => String(e.attributes["user.email"] ?? "")).filter(Boolean))].sort();
    sessions = correlate(otel, proxy).map(({ otelSession: _o, proxySession: _p, ...summary }) => summary as SessionSummary);
  }

  return new Response(JSON.stringify({ sessions, total: sessions.length, availableUsers }), { headers: { "content-type": "application/json" } });
}

async function handleSession(id: string, source: Source, startTs?: string, endTs?: string): Promise<Response> {
  if (source === "otel") {
    const events = await fetchOtelEvents(undefined, startTs, endTs);
    const sessionEvents = events.filter((e) => String(e.attributes["session.id"] ?? "") === id);
    if (!sessionEvents.length) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const timeline = buildOtelTimeline(sessionEvents);
    let model = "unknown", totalCost = 0;
    for (const e of sessionEvents) {
      if (e.body === "claude_code.api_request") { model = String(e.attributes["model"] ?? model); totalCost += Number(e.attributes["cost_usd"] ?? 0); }
    }
    const user = String(sessionEvents[0].attributes["user.email"] ?? "unknown");
    return new Response(JSON.stringify({ id, source: "otel", user, model, totalCost, events: timeline }), { headers: { "content-type": "application/json" } });
  }

  if (source === "proxy") {
    const sessions = segmentProxySessions(startTs, endTs);
    const s = sessions.find((p) => p.id === id);
    if (!s) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id, source: "proxy", model: s.model, piiCount: s.piiCount, messages: s.messages }), { headers: { "content-type": "application/json" } });
  }

  // unified — try proxy first (has full content), enrich with OTEL
  const [events, proxySessions] = await Promise.all([fetchOtelEvents(undefined, startTs, endTs), Promise.resolve(segmentProxySessions(startTs, endTs))]);
  const otelSessions = buildOtelSessions(events);
  const unified = correlate(otelSessions, proxySessions);
  const us = unified.find((u) => u.id === id) as UnifiedSession | undefined;
  if (!us) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

  const otelTimeline = us.otelSession ? buildOtelTimeline(us.otelSession.events) : [];
  const messages = us.proxySession?.messages ?? [];

  return new Response(JSON.stringify({
    id, source: "unified",
    user: us.user, model: us.model, totalCost: us.totalCost, totalTokens: us.totalTokens,
    otelId: us.otelId, proxyId: us.proxyId,
    piiCount: us.piiCount ?? 0,
    messages,       // full proxy content
    otelEvents: otelTimeline, // OTEL overlay
  }), { headers: { "content-type": "application/json" } });
}

// ── Embedded HTML ──────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation Viewer</title>
<style>
:root {
  --bg: #0f0f1a;
  --bg2: #13131f;
  --surface: #1a1a2e;
  --surface2: #1e1e2e;
  --surface3: #1e1e38;
  --border: #2a2a3e;
  --border2: #1a1a2e;
  --border3: #1e1e30;
  --text: #e2e8f0;
  --text2: #94a3b8;
  --text3: #64748b;
  --accent: #a5b4fc;
  --accent2: #6366f1;
  --accent3: #a78bfa;
  --user-bubble: #2d4a7a;
  --asst-bubble: #1e1e2e;
  --cost-color: #fbbf24;
  --error-color: #fca5a5;
  --error-bg: #3f1a1a;
  --success-color: #34d399;
}
body.light {
  --bg: #f0f2f5;
  --bg2: #f8f9fa;
  --surface: #ffffff;
  --surface2: #f0f0f0;
  --surface3: #e8e8f0;
  --border: #d0d5dd;
  --border2: #e2e8f0;
  --border3: #e2e8f0;
  --text: #1a202c;
  --text2: #4a5568;
  --text3: #718096;
  --accent: #4f46e5;
  --accent2: #4f46e5;
  --accent3: #6d28d9;
  --user-bubble: #3b82f6;
  --asst-bubble: #f1f5f9;
  --cost-color: #d97706;
  --error-color: #dc2626;
  --error-bg: #fef2f2;
  --success-color: #059669;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; height: 100vh; overflow: hidden; }

#sidebar { width: 320px; min-width: 320px; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
#sidebar-header { position: relative; padding: 12px 14px 8px; border-bottom: 1px solid var(--border); }
#sidebar-header h1 { font-size: 14px; font-weight: 600; color: var(--accent); }
#sidebar-header .count { font-size: 11px; color: var(--text3); margin-top: 1px; }

/* Source tabs */
#source-tabs { display: flex; border-bottom: 1px solid var(--border); }
#source-tabs button { flex: 1; padding: 7px 4px; font-size: 11px; border: none; background: transparent; color: var(--text3); cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.1s; }
#source-tabs button:hover { color: var(--text2); background: var(--surface); }
#source-tabs button.active { color: var(--accent); border-bottom-color: var(--accent2); background: var(--surface); }

#user-filter { display: flex; gap: 5px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--border3); background: var(--bg); }
#user-filter button { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); cursor: pointer; }
#user-filter button.active { background: var(--surface3); color: var(--accent); border-color: var(--accent2); }
#session-list { flex: 1; overflow-y: auto; }

.session-row { padding: 9px 13px; cursor: pointer; border-bottom: 1px solid var(--border2); transition: background 0.1s; }
.session-row:hover { background: var(--surface); }
.session-row.active { background: var(--surface3); border-left: 3px solid var(--accent2); padding-left: 10px; }
.session-row .ts { font-size: 10px; color: var(--text3); }
.session-row .title { font-size: 12px; color: var(--text); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; line-height: 1.4; }
.session-row .meta { display: flex; gap: 4px; margin-top: 5px; flex-wrap: wrap; }

.badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; white-space: nowrap; }
.badge-model { background: var(--surface3); color: var(--accent); }
.badge-prompts { background: var(--surface3); color: var(--success-color); }
.badge-msgs { background: var(--surface3); color: var(--success-color); }
.badge-cost { background: var(--surface3); color: var(--cost-color); }
.badge-error { background: var(--error-bg); color: var(--error-color); }
.badge-user { background: var(--surface3); color: var(--accent3); }
.badge-pii { background: var(--error-bg); color: var(--error-color); }
.badge-linked { background: var(--surface3); color: var(--success-color); }

/* Theme toggle */
#theme-btn { position: absolute; right: 12px; top: 10px; font-size: 16px; background: none; border: none; cursor: pointer; opacity: 0.7; }
#theme-btn:hover { opacity: 1; }

/* Search */
#search-bar { display: none; padding: 6px 10px; border-bottom: 1px solid var(--border3); background: var(--bg2); }
#search-bar.open { display: flex; gap: 6px; align-items: center; }
#search-input { flex: 1; background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 6px; font-size: 12px; }
#search-count { font-size: 11px; color: var(--text3); white-space: nowrap; }
#search-bar button { font-size: 11px; padding: 3px 7px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); border-radius: 5px; cursor: pointer; }

/* Sidebar search */
#sidebar-search { padding: 6px 10px; border-bottom: 1px solid var(--border3); }
#sidebar-search input { width: 100%; background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 6px; font-size: 12px; }
#sidebar-search input::placeholder { color: var(--text3); }

/* Date range */
#date-range { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--border3); align-items: center; }
#date-range label { font-size: 10px; color: var(--text3); }
#date-range input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 3px 5px; border-radius: 5px; font-size: 11px; flex: 1; }

/* Event filter bar */
#event-filters { display: none; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--border3); flex-wrap: wrap; }
#event-filters.active { display: flex; }
#event-filters button { font-size: 10px; padding: 2px 7px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); cursor: pointer; transition: all 0.1s; }
#event-filters button.on { background: var(--surface3); color: var(--accent); border-color: var(--accent2); }

/* PII marks */
mark.pii-hit { background: #7c3aed33; color: inherit; border-radius: 2px; padding: 0 1px; }
mark.pii-active { background: #7c3aed99; outline: 2px solid #7c3aed; }
mark.search-hit { background: #fbbf2444; color: inherit; border-radius: 2px; }
mark.search-active { background: #f59e0b; color: #000; outline: 2px solid #f59e0b; }

/* Hook/system cards */
.tl-hook { background: var(--surface); border: 1px solid var(--border3); border-left: 3px solid #6366f155; border-radius: 6px; padding: 4px 10px; font-size: 11px; color: var(--text3); font-family: monospace; display: flex; gap: 8px; align-items: center; max-width: 480px; }
.tl-hook .hk-name { color: var(--accent3); font-weight: 500; }
.tl-hook .hk-dur { color: var(--text3); margin-left: auto; }
.tl-system { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.tl-system .sys-line { flex: 1; height: 1px; background: var(--border3); }
.tl-system .sys-badge { font-size: 10px; color: var(--text3); background: var(--bg); border: 1px solid var(--border3); padding: 1px 7px; border-radius: 8px; font-family: monospace; white-space: nowrap; }

/* Input source labels */
.msg-source { font-size: 9px; padding: 1px 5px; border-radius: 4px; margin-left: 4px; font-weight: 500; }
.msg-source.typed { background: #1e3a1e; color: #4ade80; }
.msg-source.context { background: #1e2a3a; color: #93c5fd; }

#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#thread-header { padding: 9px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: center; min-height: 44px; flex-wrap: wrap; }
#thread-header .session-id { font-size: 11px; color: var(--text3); font-family: monospace; cursor: pointer; }
#thread-header .session-id:hover { color: var(--text2); }
#thread-header .info { font-size: 12px; color: var(--text3); }
#thread-header .btn { font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); cursor: pointer; margin-left: auto; }
#thread { flex: 1; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--text3); text-align: center; margin: auto; font-size: 14px; }

/* OTEL timeline */
.tl-prompt { display: flex; flex-direction: column; align-items: flex-end; }
.tl-prompt .bubble { background: var(--user-bubble); color: var(--text); padding: 9px 13px; border-radius: 12px 12px 3px 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 76%; }
.tl-prompt .evt-meta { font-size: 10px; color: var(--text3); margin-top: 3px; text-align: right; }

.tl-api { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.tl-api .api-line { flex: 1; height: 1px; background: var(--border3); }
.tl-api .api-badge { font-size: 11px; color: var(--text3); background: var(--surface); border: 1px solid var(--border3); padding: 2px 8px; border-radius: 10px; white-space: nowrap; font-family: monospace; }
.tl-api .api-badge .model-name { color: var(--accent3); }
.tl-api .api-badge .cost { color: var(--cost-color); }

.tl-tool { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; font-size: 12px; overflow: hidden; max-width: 560px; }
.tl-tool.tool-blocked { border-color: var(--error-bg); opacity: 0.8; }
.tl-tool.tool-not-executed { opacity: 0.65; }
.tl-tool .tool-header { padding: 5px 10px; background: var(--surface3); cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.tl-tool .tool-name { color: var(--accent3); font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-tool .tool-decision { font-size: 10px; padding: 1px 5px; border-radius: 6px; white-space: nowrap; flex-shrink: 0; }
.tl-tool .tool-decision.auto { background: var(--surface3); color: var(--success-color); }
.tl-tool .tool-decision.approved { background: var(--surface3); color: #67e8f9; }
.tl-tool .tool-decision.blocked { background: var(--error-bg); color: var(--error-color); }
.tl-tool .tool-decision.rejected { background: var(--error-bg); color: var(--error-color); }
.tl-tool .tool-preview { color: var(--text3); font-size: 11px; font-family: monospace; flex: 2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-tool .tool-toggle { color: var(--text3); font-size: 10px; flex-shrink: 0; }
.tl-tool .tool-body { padding: 8px 10px; display: none; }
.tl-tool .tool-body.open { display: block; }
.tl-tool .tool-footer { padding: 4px 10px; font-size: 10px; color: var(--text3); border-top: 1px solid var(--border); display: flex; gap: 8px; }
.tb-section { margin-bottom: 8px; }
.tb-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text3); margin-bottom: 3px; }
.tb-value { margin: 0; font-size: 11px; font-family: monospace; color: var(--text2); white-space: pre-wrap; word-break: break-all; background: var(--bg); border: 1px solid var(--border3); border-radius: 4px; padding: 6px 8px; max-height: 200px; overflow-y: auto; display: block; }

.tl-error { background: var(--error-bg); border: 1px solid var(--error-color); border-radius: 8px; padding: 7px 12px; font-size: 12px; color: var(--error-color); font-family: monospace; }
.tl-error .err-ts { font-size: 10px; color: var(--text3); margin-bottom: 2px; }

/* Proxy conversation bubbles */
.msg { display: flex; flex-direction: column; max-width: 78%; }
.msg.user { align-self: flex-end; align-items: flex-end; }
.msg.assistant { align-self: flex-start; align-items: flex-start; }
.msg-role { font-size: 10px; color: var(--text3); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.05em; }
.bubble { padding: 9px 13px; border-radius: 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 100%; }
.msg.user .bubble { background: var(--user-bubble); color: var(--text); border-bottom-right-radius: 3px; }
.msg.assistant .bubble { background: var(--asst-bubble); color: var(--text); border-bottom-left-radius: 3px; }

/* Unified OTEL cost overlay */
.otel-cost-bar { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.otel-cost-bar .ocb-line { flex: 1; height: 1px; background: var(--border3); }
.otel-cost-bar .ocb-badge { font-size: 10px; color: var(--success-color); background: var(--surface); border: 1px solid var(--border3); padding: 1px 7px; border-radius: 8px; font-family: monospace; white-space: nowrap; }

::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* Event kind visibility toggles — applied via body.hide-* classes */
body.hide-prompt .tl-prompt,
body.hide-prompt .msg.user { display: none !important; }
body.hide-api .tl-api,
body.hide-api .otel-cost-bar { display: none !important; }
body.hide-tool .tl-tool { display: none !important; }
body.hide-hook .tl-hook { display: none !important; }
body.hide-system .tl-system { display: none !important; }
body.hide-error .tl-error { display: none !important; }
</style>
</head>
<body>
<div id="sidebar">
  <div id="sidebar-header">
    <h1>Conversation Viewer</h1>
    <div class="count" id="count">Loading…</div>
    <button id="theme-btn" onclick="toggleTheme()" title="Toggle theme">☀</button>
  </div>
  <div id="source-tabs">
    <button onclick="setSource('unified')" id="tab-unified" class="active">⬡ Unified</button>
    <button onclick="setSource('otel')" id="tab-otel">⚡ OTEL</button>
    <button onclick="setSource('proxy')" id="tab-proxy">🔍 LLM Proxy</button>
  </div>
  <div id="date-range">
    <label>From</label><input type="date" id="date-from" onchange="applyDateRange()">
    <label>To</label><input type="date" id="date-to" onchange="applyDateRange()">
  </div>
  <div id="sidebar-search"><input id="sidebar-search-input" type="text" placeholder="Search conversations…" oninput="filterSessions(this.value)"></div>
  <div id="user-filter" style="display:none"></div>
  <div id="session-list"></div>
</div>
<div id="main">
  <div id="thread-header"><span class="info">Select a conversation</span></div>
  <div id="event-filters">
    <button class="on" data-kind="prompt" onclick="toggleKind('prompt',this)">Prompts</button>
    <button class="on" data-kind="api" onclick="toggleKind('api',this)">API</button>
    <button class="on" data-kind="tool" onclick="toggleKind('tool',this)">Tools</button>
    <button class="on" data-kind="hook" onclick="toggleKind('hook',this)">Hooks</button>
    <button class="on" data-kind="system" onclick="toggleKind('system',this)">System</button>
    <button class="on" data-kind="error" onclick="toggleKind('error',this)">Errors</button>
  </div>
  <div id="search-bar">
    <input id="search-input" type="text" placeholder="Search in conversation…" oninput="runSearch(this.value)">
    <span id="search-count"></span>
    <button onclick="navSearch(1)">↓</button>
    <button onclick="navSearch(-1)">↑</button>
    <button onclick="closeSearch()">✕</button>
  </div>
  <div id="thread"><div class="empty">← Select a conversation to view</div></div>
</div>

<script>
let activeId = null;
let activeSource = 'unified';
let activeUser = null;
let allExpanded = false;
let allSessions = [];
const hiddenKinds = new Set(JSON.parse(localStorage.getItem('hiddenKinds')||'[]'));

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(ts) { const d=new Date(ts); return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function fmtCost(n) { if(!n||n===0) return null; return n<0.01?'<$0.01':'$'+n.toFixed(2); }
function fmtTok(n) { return n>=1000?(n/1000).toFixed(1)+'k':String(n); }

function setSource(src) {
  activeSource = src;
  activeId = null;
  ['unified','otel','proxy'].forEach(s => {
    document.getElementById('tab-'+s).classList.toggle('active', s===src);
  });
  document.getElementById('thread-header').innerHTML = '<span class="info">Select a conversation</span>';
  document.getElementById('thread').innerHTML = '<div class="empty">← Select a conversation to view</div>';
  loadSessions();
}

async function loadSessions() {
  const qs = new URLSearchParams({source: activeSource});
  if (activeUser) qs.set('user', activeUser);
  const dateFrom = document.getElementById('date-from')?.value;
  const dateTo = document.getElementById('date-to')?.value;
  if (dateFrom) qs.set('start', dateFrom);
  if (dateTo) qs.set('end', dateTo);
  const r = await fetch('/api/sessions?' + qs);
  const data = await r.json();
  document.getElementById('count').textContent = data.total + ' sessions';

  const filterEl = document.getElementById('user-filter');
  if (data.availableUsers && data.availableUsers.length > 1) {
    filterEl.style.display = 'flex';
    filterEl.innerHTML =
      '<button class="'+(activeUser===null?'active':'')+'" onclick="setUser(null)">All</button>' +
      data.availableUsers.map(u => {
        const short = u.replace(/@.*/,'')+'@…';
        return '<button class="'+(activeUser===u?'active':'')+'" onclick="setUser(\\\''+u+'\\\')" title="'+esc(u)+'">'+esc(short)+'</button>';
      }).join('');
  } else { filterEl.style.display = 'none'; }

  allSessions = data.sessions;
  const sidebarQuery = document.getElementById('sidebar-search-input')?.value || '';
  if (sidebarQuery.trim()) filterSessions(sidebarQuery);
  else renderSessionList(allSessions);
}

function renderSessionList(sessions) {
  const multiUser = !!(allSessions.some(s => s.user) &&
    new Set(allSessions.map(s => s.user).filter(Boolean)).size > 1);

  document.getElementById('session-list').innerHTML = sessions.map(s => {
    const cost = fmtCost(s.totalCost);
    const title = s.firstPrompt
      ? esc(s.firstPrompt.length>70 ? s.firstPrompt.slice(0,70)+'…' : s.firstPrompt)
      : '<span style="color:var(--text3);font-style:italic">No prompts</span>';

    const badges = [
      s.model&&s.model!=='unknown' ? '<span class="badge badge-model">'+esc(s.model.replace('claude-',''))+'</span>' : '',
      s.promptCount>0 ? '<span class="badge badge-prompts">'+s.promptCount+' prompts</span>' : '',
      s.messageCount>0 ? '<span class="badge badge-msgs">'+s.messageCount+' msgs</span>' : '',
      cost ? '<span class="badge badge-cost">'+esc(cost)+'</span>' : '',
      s.hasErrors ? '<span class="badge badge-error">errors</span>' : '',
      s.piiCount>0 ? '<span class="badge badge-pii">🔒'+s.piiCount+'</span>' : '',
      s.otelId&&s.proxyId ? '<span class="badge badge-linked">linked</span>' : '',
      multiUser&&!activeUser&&s.user ? '<span class="badge badge-user">'+esc(s.user.replace(/@.*/,''))+'</span>' : '',
    ].filter(Boolean).join('');

    return '<div class="session-row '+(s.id===activeId?'active':'')+'" onclick="loadSession(\\\''+s.id+'\\\')">' +
      '<div class="ts">'+fmt(s.lastTs)+'</div>'+
      '<div class="title">'+title+'</div>'+
      (badges?'<div class="meta">'+badges+'</div>':'')+
      '</div>';
  }).join('');
}

function filterSessions(q) {
  const filtered = q ? allSessions.filter(s => (s.firstPrompt||'').toLowerCase().includes(q.toLowerCase())) : allSessions;
  renderSessionList(filtered);
}

function applyDateRange() {
  activeId = null;
  document.getElementById('thread-header').innerHTML = '<span class="info">Select a conversation</span>';
  document.getElementById('thread').innerHTML = '<div class="empty">← Select a conversation to view</div>';
  loadSessions();
}

function initDateRange() {
  const now = new Date();
  const past = new Date(now - 30*24*60*60*1000);
  document.getElementById('date-to').value = now.toISOString().slice(0,10);
  document.getElementById('date-from').value = past.toISOString().slice(0,10);
}

function setUser(u) { activeUser=u; loadSessions(); }

async function loadSession(id) {
  activeId = id;
  document.querySelectorAll('.session-row').forEach(r => {
    r.classList.toggle('active', r.getAttribute('onclick')?.includes("'"+id+"'"));
  });
  const r = await fetch('/api/sessions/'+encodeURIComponent(id)+'?source='+activeSource);
  if (!r.ok) return;
  const data = await r.json();

  const cost = fmtCost(data.totalCost);
  const hdrParts = [
    data.model&&data.model!=='unknown' ? '<span class="badge badge-model">'+esc(data.model)+'</span>' : '',
    data.source==='otel' ? (data.events.filter(e=>e.kind==='prompt').length+' prompts') : (data.messages?.length??0)+' msgs',
    cost ? '<span class="badge badge-cost">'+esc(cost)+'</span>' : '',
    data.piiCount>0 ? '<span class="badge badge-pii">🔒'+data.piiCount+' PII</span>' : '',
    data.user ? '<span class="badge badge-user">'+esc(data.user.replace(/@.*/,''))+'</span>' : '',
  ].filter(Boolean);
  document.getElementById('thread-header').innerHTML =
    hdrParts.join(' ')+
    ' <span class="session-id" title="click to copy" onclick="copyId(\\\''+id+'\\\')">'+(data.otelId||id).slice(0,8)+'…</span>'+
    (data.piiCount>0||true ? ' <button id="pii-nav-btn" class="btn" onclick="nextPii()">🔒</button>' : '')+
    ' <button class="btn" onclick="toggleSearch()">🔍</button>'+
    ' <button class="btn" onclick="toggleAll()">Expand all</button>';

  document.getElementById('event-filters').classList.toggle('active', data.source==='otel'||data.source==='unified');

  allExpanded = false;
  const thread = document.getElementById('thread');

  if (data.source === 'otel') {
    thread.innerHTML = data.events.map(renderOtelEvent).join('');
  } else if (data.source === 'proxy') {
    thread.innerHTML = data.messages.map(m=>renderProxyMessage(m,null)).join('');
  } else {
    // unified: proxy messages as base, OTEL events interleaved
    thread.innerHTML = renderUnified(data);
  }
  thread.scrollTop = thread.scrollHeight;
  setTimeout(() => { scanPii(); }, 50);
  loadSessions();
}

function toggleKind(kind, btn) {
  const cls = 'hide-' + kind;
  if (hiddenKinds.has(kind)) {
    hiddenKinds.delete(kind);
    document.body.classList.remove(cls);
    btn.classList.add('on');
  } else {
    hiddenKinds.add(kind);
    document.body.classList.add(cls);
    btn.classList.remove('on');
  }
  localStorage.setItem('hiddenKinds', JSON.stringify([...hiddenKinds]));
}

function toggleAll() {
  allExpanded = !allExpanded;
  document.querySelectorAll('.tool-body').forEach(el => el.classList.toggle('open', allExpanded));
  document.querySelector('#thread-header .btn').textContent = allExpanded ? 'Collapse all' : 'Expand all';
}

function toggleTool(id) { document.getElementById(id).classList.toggle('open'); }

function copyId(id) {
  navigator.clipboard.writeText(id);
  const el = document.querySelector('.session-id');
  if (el) { el.textContent='copied!'; setTimeout(()=>el.textContent=id.slice(0,8)+'…',1200); }
}

// ── OTEL rendering ─────────────────────────────────────────────────────────

function renderOtelEvent(ev) {
  if (ev.kind === 'prompt') {
    return '<div class="tl-prompt"><div class="bubble">'+esc(ev.text)+'</div><div class="evt-meta">'+fmtTime(ev.ts)+'</div></div>';
  }
  if (ev.kind === 'api') {
    const parts = [
      '<span class="model-name">'+esc(ev.model.replace('claude-',''))+'</span>',
      ev.durationMs ? (ev.durationMs/1000).toFixed(1)+'s' : null,
      (ev.inputTokens+ev.outputTokens)>0 ? fmtTok(ev.inputTokens+ev.outputTokens)+' tok' : null,
      ev.cacheReadTokens>0 ? fmtTok(ev.cacheReadTokens)+' cached' : null,
      fmtCost(ev.cost) ? '<span class="cost">'+esc(fmtCost(ev.cost))+'</span>' : null,
    ].filter(Boolean);
    return '<div class="tl-api"><div class="api-line"></div><div class="api-badge">✦ '+parts.join(' · ')+'</div><div class="api-line"></div></div>';
  }
  if (ev.kind === 'tool') {
    return renderToolCard(ev.toolName, ev.input, ev.resultSizeBytes, ev.success, ev.decision, ev.ts, ev.durationMs, ev.executed);
  }
  if (ev.kind === 'hook') {
    const dur = ev.durationMs > 0 ? (ev.durationMs).toFixed(0)+'ms' : '';
    return '<div class="tl-hook">'+
      '<span>⚙</span>'+
      '<span class="hk-name">'+esc(ev.hookName)+'</span>'+
      (ev.numHooks>1?'<span style="color:var(--text3)">×'+ev.numHooks+'</span>':'')+
      (dur?'<span class="hk-dur">'+esc(dur)+'</span>':'')+
      '</div>';
  }
  if (ev.kind === 'system') {
    let label = '';
    const d = ev.detail || {};
    if (ev.subkind==='compaction') {
      label = '◈ compaction '+fmtTok(d.preTokens||0)+'→'+fmtTok(d.postTokens||0)+' tok';
    } else if (ev.subkind==='skill') {
      label = '◈ skill '+esc(d.skillName||'')+(d.trigger?' ('+esc(d.trigger)+')':'');
    } else if (ev.subkind==='subagent') {
      label = '◈ subagent '+esc(d.agentType||'')+(d.totalTokens?' '+fmtTok(d.totalTokens)+' tok':'')+(d.durationMs?' '+(d.durationMs/1000).toFixed(1)+'s':'');
    } else if (ev.subkind==='permission') {
      label = '◈ '+esc(d.fromMode||'')+'→'+esc(d.toMode||'');
    } else {
      label = '◈ '+esc(ev.subkind);
    }
    return '<div class="tl-system"><div class="sys-line"></div><div class="sys-badge">'+label+'</div><div class="sys-line"></div></div>';
  }
  if (ev.kind === 'error') {
    return '<div class="tl-error"><div class="err-ts">'+fmtTime(ev.ts)+'</div>⚠ '+esc(ev.code)+(ev.message?' · '+esc(ev.message):'')+'</div>';
  }
  return '';
}

function renderToolCard(toolName, input, resultSizeBytes, success, decision, ts, durationMs, executed) {
  const uid = 'tc-'+Math.random().toString(36).slice(2);
  const preview = extractToolPreview(toolName, input);
  const d = (decision||'').toLowerCase();
  const isBlocked = d==='block'||d==='reject'||d==='blocked'||d==='rejected';
  const notExecuted = executed===false;
  const decisionLabel = d==='auto'||d===''||d==='accept' ? 'auto'
    : d==='block'||d==='blocked' ? 'blocked'
    : d==='reject'||d==='rejected' ? 'rejected'
    : d;
  const icon = isBlocked ? '🚫' : (notExecuted ? '⏸' : (success===false ? '❌' : '🔧'));

  const footer = [
    ts ? fmtTime(ts) : null,
    durationMs>0 ? (durationMs/1000).toFixed(2)+'s' : null,
    resultSizeBytes>0 ? fmtBytes(resultSizeBytes)+' result' : null,
  ].filter(Boolean).join(' · ');

  const cls = 'tl-tool'+(isBlocked?' tool-blocked':'')+(!executed&&executed!==undefined?' tool-not-executed':'');
  const showDecisionBadge = decisionLabel!=='auto';

  return '<div class="'+cls+'">'+
    '<div class="tool-header" onclick="toggleTool(\\\''+uid+'\\\')">'+
    '<span class="tool-name">'+icon+' '+esc(toolName)+'</span>'+
    (showDecisionBadge ? '<span class="tool-decision '+esc(decisionLabel)+'">'+esc(decisionLabel)+'</span>' : '')+
    '<span class="tool-preview">'+esc(preview)+'</span>'+
    '<span class="tool-toggle">▾</span>'+
    '</div>'+
    '<div class="tool-body" id="'+uid+'">'+renderToolBody(toolName, input, null)+'</div>'+
    (footer?'<div class="tool-footer">'+esc(footer)+'</div>':'')+
    '</div>';
}

function renderPairedCard(callBlock, resultBlock) {
  if (!callBlock) {
    // Tool call is in a different message — render result-only card
    const isErr = resultBlock.is_error;
    const resultText = Array.isArray(resultBlock.content)
      ? resultBlock.content.map(b=>String(b.text||b.content||'')).join('\\n')
      : String(resultBlock.content||'');
    const uid = 'tc-'+Math.random().toString(36).slice(2);
    const preview = resultText.split('\\n')[0].slice(0,80);
    return '<div class="tl-tool'+(isErr?' tool-blocked':'')+'">'+
      '<div class="tool-header" onclick="toggleTool(\\\''+uid+'\\\')">'+
      '<span class="tool-name">'+(isErr?'❌':'📤')+' result</span>'+
      '<span class="tool-preview">'+esc(preview)+'</span>'+
      '<span class="tool-toggle">▾</span>'+
      '</div>'+
      '<div class="tool-body" id="'+uid+'">'+
      '<div class="tb-section"><div class="tb-label">Result</div>'+
      '<pre class="tb-value">'+esc(resultText||'(empty)')+'</pre>'+
      '</div>'+
      '</div>'+
      '</div>';
  }
  const uid = 'tc-'+Math.random().toString(36).slice(2);
  const preview = extractToolPreview(callBlock.name||'tool', callBlock.input);
  const isErr = resultBlock.is_error;
  const resultText = Array.isArray(resultBlock.content)
    ? resultBlock.content.map(b=>String(b.text||b.content||'')).join('\\n')
    : String(resultBlock.content||'');
  const icon = isErr ? '❌' : '🔧';

  return '<div class="tl-tool'+(isErr?' tool-blocked':'')+'">'+
    '<div class="tool-header" onclick="toggleTool(\\\''+uid+'\\\')">'+
    '<span class="tool-name">'+icon+' '+esc(callBlock.name||'tool')+'</span>'+
    '<span class="tool-preview">'+esc(preview)+'</span>'+
    '<span class="tool-toggle">▾</span>'+
    '</div>'+
    '<div class="tool-body" id="'+uid+'">'+renderToolBody(callBlock.name||'tool', callBlock.input, resultText)+'</div>'+
    '</div>';
}

function renderToolBody(toolName, input, resultText) {
  const sections = [];
  const i = input && typeof input==='object' ? input : {};

  const n = (toolName||'').toLowerCase();
  if (n==='bash') {
    if (i.command) sections.push(['Command', String(i.command)]);
    if (i.description) sections.push(['Description', String(i.description)]);
  } else if (n==='read') {
    if (i.file_path) sections.push(['File', String(i.file_path)]);
    if (i.offset!=null) sections.push(['Offset', String(i.offset)]);
    if (i.limit!=null) sections.push(['Limit', String(i.limit)]);
  } else if (n==='write') {
    if (i.file_path) sections.push(['File', String(i.file_path)]);
    if (i.content) sections.push(['Content', String(i.content)]);
  } else if (n==='edit'||n==='multiedit') {
    if (i.file_path) sections.push(['File', String(i.file_path)]);
    if (i.old_string) sections.push(['Find', String(i.old_string)]);
    if (i.new_string) sections.push(['Replace', String(i.new_string)]);
  } else if (n==='agent') {
    if (i.description) sections.push(['Description', String(i.description)]);
    if (i.prompt) sections.push(['Prompt', String(i.prompt)]);
  } else if (n==='webfetch') {
    if (i.url) sections.push(['URL', String(i.url)]);
    if (i.prompt) sections.push(['Prompt', String(i.prompt)]);
  } else if (n==='websearch') {
    if (i.query) sections.push(['Query', String(i.query)]);
  } else if (n==='glob'||n==='grep') {
    const pat = i.pattern||i.query||i.glob||'';
    if (pat) sections.push(['Pattern', String(pat)]);
    if (i.path) sections.push(['Path', String(i.path)]);
    if (i.include) sections.push(['Include', String(i.include)]);
  } else if (n==='todoread'||n==='todowrite') {
    if (i.todos) sections.push(['Todos', typeof i.todos==='string'?i.todos:JSON.stringify(i.todos,null,2)]);
  } else {
    // Generic: each top-level key as a labeled field
    for (const [k,v] of Object.entries(i)) {
      sections.push([k, typeof v==='string'?v:JSON.stringify(v,null,2)]);
    }
    // If input was a raw string
    if (typeof input==='string'&&input) sections.push(['Input', input]);
  }

  if (resultText!=null) sections.push(['Result', resultText||'(empty)']);

  if (!sections.length) return '<span style="color:#4a5568;font-style:italic">no detail</span>';

  return sections.map(([label,val]) =>
    '<div class="tb-section">'+
    '<div class="tb-label">'+esc(String(label))+'</div>'+
    '<pre class="tb-value">'+esc(String(val))+'</pre>'+
    '</div>'
  ).join('');
}

function extractToolPreview(name, input) {
  if (!input || typeof input !== 'object') return String(input||'').slice(0,80);
  const i = input;
  const n = (name||'').toLowerCase();
  if (n==='bash') return String(i.command||'').split('\\n')[0].slice(0,80);
  if (n==='read') return String(i.file_path||'');
  if (n==='write'||n==='edit'||n==='multiedit') return String(i.file_path||'');
  if (n==='agent') return String(i.description||'');
  if (n==='webfetch') return String(i.url||'');
  if (n==='websearch') return String(i.query||'');
  if (n==='glob'||n==='grep') return String(i.pattern||i.query||i.glob||'');
  return JSON.stringify(i).slice(0,80);
}

function fmtBytes(n) { return n>1024?(n/1024).toFixed(1)+'kb':n+'b'; }

// ── Proxy rendering ────────────────────────────────────────────────────────

function renderProxyMessage(msg, callMap) {
  const bodyHtml = renderContent(msg.content, callMap);
  if (!bodyHtml.trim()) return '';
  let sourceLabel = '';
  if (msg.role === 'user') {
    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter(b=>b&&b.type==='text').map(b=>String(b.text||'')).join(' ')
      : '';
    const isLong = text.length > 1000;
    const hasHeaders = /^#{1,3} /m.test(text);
    const hasPaiHeaders = /════|NATIVE MODE|ALGORITHM|PAI \\||@PAI\\//m.test(text);
    if (isLong && (hasHeaders || hasPaiHeaders)) {
      sourceLabel = '<span class="msg-source context">context</span>';
    } else if (text.length > 0 && text.length < 300 && !hasHeaders) {
      sourceLabel = '<span class="msg-source typed">typed</span>';
    }
  }
  return '<div class="msg '+msg.role+'">'+
    '<div class="msg-role">'+msg.role+sourceLabel+'</div>'+
    '<div class="bubble">'+bodyHtml+'</div></div>';
}

function renderContent(content, extCallMap) {
  if (typeof content === 'string') return esc(content);
  if (!Array.isArray(content)) return esc(JSON.stringify(content));

  // Build lookup of tool_use blocks by id — seed from cross-message map if provided
  const toolUseById = Object.assign({}, extCallMap||{});
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.id) toolUseById[block.id] = block;
  }
  // Track which tool_use ids have been rendered as part of a pair
  const consumed = new Set();

  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') {
      const t = String(block.text||'');
      if (!t.trim()) return '';
      return '<span>'+esc(t)+'</span>';
    }
    if (block.type === 'tool_use') {
      if (consumed.has(block.id)) return ''; // already rendered inside its paired result card
      // No result found yet — render as standalone call card
      return renderToolCard(block.name||'tool', block.input, 0, true, 'accept', null, 0, undefined);
    }
    if (block.type === 'tool_result') {
      const call = toolUseById[block.tool_use_id];
      if (call) consumed.add(call.id);
      return renderPairedCard(call||null, block);
    }
    return '';
  }).filter(Boolean).join('');
}

// ── Unified rendering ──────────────────────────────────────────────────────

function renderUnified(data) {
  let html = '';

  // Group OTEL api events by rough time for cost overlay
  const apiByMinute = {};
  if (data.otelEvents) {
    for (const ev of data.otelEvents) {
      if (ev.kind==='api') {
        const min = new Date(ev.ts).toISOString().slice(0,16);
        if (!apiByMinute[min]) apiByMinute[min] = {cost:0,tok:0,model:ev.model};
        apiByMinute[min].cost += ev.cost;
        apiByMinute[min].tok += ev.inputTokens+ev.outputTokens;
      }
    }
  }

  // Tool decisions from OTEL (keyed by tool_use_id or name+sequence for overlay)
  const toolDecisions = {};
  if (data.otelEvents) {
    for (const ev of data.otelEvents) {
      if (ev.kind==='tool') toolDecisions[ev.toolName+'_'+ev.ts] = ev;
    }
  }

  // Render proxy messages; inject OTEL cost bars after assistant turns
  let lastAssistantMin = null;
  for (const msg of data.messages||[]) {
    const rendered = renderProxyMessage(msg, null);
    if (!rendered) continue;
    html += rendered;

    if (msg.role==='assistant') {
      // Check if there's an OTEL api event near this message's time
      // (approximate: find any api events whose minute bucket hasn't been emitted)
      const costParts = Object.entries(apiByMinute)
        .filter(([,v]) => v.cost>0)
        .slice(0,1); // emit first unshown
      if (costParts.length) {
        const [min, info] = costParts[0];
        delete apiByMinute[min];
        const parts = [
          esc(info.model.replace('claude-','')),
          info.tok>0?fmtTok(info.tok)+' tok':null,
          fmtCost(info.cost)?esc(fmtCost(info.cost)):null,
        ].filter(Boolean);
        html += '<div class="otel-cost-bar"><div class="ocb-line"></div><div class="ocb-badge">'+parts.join(' · ')+'</div><div class="ocb-line"></div></div>';
      }
    }
  }

  // Any remaining OTEL api events not yet shown
  for (const [,info] of Object.entries(apiByMinute)) {
    const parts = [esc(info.model.replace('claude-','')), fmtCost(info.cost)?esc(fmtCost(info.cost)):null].filter(Boolean);
    html += '<div class="otel-cost-bar"><div class="ocb-line"></div><div class="ocb-badge">'+parts.join(' · ')+'</div><div class="ocb-line"></div></div>';
  }

  // OTEL errors if any
  if (data.otelEvents) {
    for (const ev of data.otelEvents) {
      if (ev.kind==='error') html += renderOtelEvent(ev);
    }
  }

  return html || '<div class="empty">No content</div>';
}

// ── Search ─────────────────────────────────────────────────────────────────

let searchHits = [];
let searchIdx = -1;

function toggleSearch() {
  const bar = document.getElementById('search-bar');
  bar.classList.toggle('open');
  if (bar.classList.contains('open')) document.getElementById('search-input').focus();
  else closeSearch();
}

function closeSearch() {
  document.getElementById('search-bar').classList.remove('open');
  document.getElementById('search-input').value = '';
  clearSearchHighlights();
  searchHits = []; searchIdx = -1;
  document.getElementById('search-count').textContent = '';
}

function clearSearchHighlights() {
  document.querySelectorAll('mark.search-hit,mark.search-active').forEach(m => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
}

function runSearch(q) {
  clearSearchHighlights();
  searchHits = []; searchIdx = -1;
  if (!q.trim()) { document.getElementById('search-count').textContent = ''; return; }
  const thread = document.getElementById('thread');
  highlightTextInNode(thread, q.toLowerCase());
  searchHits = [...document.querySelectorAll('mark.search-hit')];
  document.getElementById('search-count').textContent = searchHits.length ? '1 of '+searchHits.length : 'no matches';
  if (searchHits.length) { searchIdx = 0; activateHit(0); }
}

function highlightTextInNode(node, q) {
  if (node.nodeType === 3) {
    const txt = node.textContent;
    const lower = txt.toLowerCase();
    let idx = 0, result = '', pos;
    while ((pos = lower.indexOf(q, idx)) !== -1) {
      result += esc(txt.slice(idx, pos)) + '<mark class="search-hit">'+esc(txt.slice(pos, pos+q.length))+'</mark>';
      idx = pos + q.length;
    }
    if (idx > 0) {
      const span = document.createElement('span');
      span.innerHTML = result + esc(txt.slice(idx));
      node.parentNode.replaceChild(span, node);
    }
    return;
  }
  if (node.nodeName === 'MARK' || node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE') return;
  [...node.childNodes].forEach(child => highlightTextInNode(child, q));
}

function activateHit(i) {
  document.querySelectorAll('mark.search-hit').forEach((m,j) => {
    m.className = j===i ? 'search-active' : 'search-hit';
  });
  searchHits = [...document.querySelectorAll('mark.search-hit,mark.search-active')];
  if (searchHits[i]) searchHits[i].scrollIntoView({block:'center'});
  document.getElementById('search-count').textContent = (i+1)+' of '+searchHits.length;
}

function navSearch(dir) {
  if (!searchHits.length) return;
  searchIdx = (searchIdx + dir + searchHits.length) % searchHits.length;
  activateHit(searchIdx);
}

// ── PII navigation ─────────────────────────────────────────────────────────

let piiHits = [];
let piiIdx = -1;
const PII_PATTERNS = [
  /\\b[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}\\b/g,
  /\\b\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b/g,
  /\\b\\d{3}-\\d{2}-\\d{4}\\b/g,
];

function scanPii() {
  piiHits = []; piiIdx = -1;
  const thread = document.getElementById('thread');
  PII_PATTERNS.forEach(pat => {
    highlightPiiInNode(thread, pat);
  });
  piiHits = [...document.querySelectorAll('mark.pii-hit')];
  const piiBtn = document.getElementById('pii-nav-btn');
  if (piiBtn) piiBtn.textContent = piiHits.length ? '🔒'+piiHits.length : '';
}

function highlightPiiInNode(node, pattern) {
  if (node.nodeType === 3) {
    const txt = node.textContent;
    pattern.lastIndex = 0;
    let match, result = '', last = 0;
    while ((match = pattern.exec(txt)) !== null) {
      result += esc(txt.slice(last, match.index)) + '<mark class="pii-hit">'+esc(match[0])+'</mark>';
      last = match.index + match[0].length;
    }
    if (last > 0) {
      const span = document.createElement('span');
      span.innerHTML = result + esc(txt.slice(last));
      node.parentNode.replaceChild(span, node);
    }
    return;
  }
  if (node.nodeName === 'MARK' || node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE') return;
  [...node.childNodes].forEach(child => highlightPiiInNode(child, pattern));
}

function nextPii() {
  if (!piiHits.length) return;
  piiIdx = (piiIdx + 1) % piiHits.length;
  document.querySelectorAll('mark.pii-hit').forEach((m,i) => m.className = i===piiIdx?'pii-active':'pii-hit');
  piiHits = [...document.querySelectorAll('mark.pii-hit,mark.pii-active')];
  if (piiHits[piiIdx]) piiHits[piiIdx].scrollIntoView({block:'center'});
}

// ── Theme ──────────────────────────────────────────────────────────────────

function toggleTheme() {
  const light = document.body.classList.toggle('light');
  localStorage.setItem('theme', light ? 'light' : 'dark');
  document.getElementById('theme-btn').textContent = light ? '🌙' : '☀';
}

// Apply saved theme on load
if (localStorage.getItem('theme') === 'light') {
  document.body.classList.add('light');
  document.getElementById('theme-btn').textContent = '🌙';
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='f') { e.preventDefault(); toggleSearch(); }
  if (e.key==='Escape') closeSearch();
  if (e.key==='Enter' && document.getElementById('search-bar').classList.contains('open')) {
    e.preventDefault(); navSearch(e.shiftKey?-1:1);
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

// Apply saved hidden kinds on load — set body classes and update button state
hiddenKinds.forEach(kind => {
  document.body.classList.add('hide-' + kind);
  const btn = document.querySelector('#event-filters button[data-kind="' + kind + '"]');
  if (btn) btn.classList.remove('on');
});

initDateRange();
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
    const source = (url.searchParams.get("source") ?? "unified") as Source;
    const startTs = url.searchParams.get("start") ?? undefined;
    const endTs = url.searchParams.get("end") ?? undefined;

    if (url.pathname === "/api/sessions") {
      return handleSessions(source, url.searchParams.get("user") ?? undefined, startTs, endTs);
    }
    if (url.pathname.startsWith("/api/sessions/")) {
      return handleSession(decodeURIComponent(url.pathname.slice(14)), source, startTs, endTs);
    }
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[conv-viewer] listening on http://localhost:${PORT} (Loki: ${LOKI_URL}, lookback: ${LOOKBACK_DAYS}d)`);
