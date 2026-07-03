import { lookupProject } from "./project.js";
import { createJsonlTailCache } from "./logCache.js";
import {
  LOOKBACK_DAYS,
  pruneOlderThan,
  readProxyEntries,
  segmentProxySessions,
  resolveProxySessionMessages,
  deriveMessageTimestamps,
  type ProxyIndexEntry,
  type ProxySessionIndex,
} from "./proxyLog.js";

const PORT = 4446;
const LOKI_URL = process.env.LOKI_URL ?? "http://localhost:3100";
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ?? `${process.env.HOME}/.llm-privacy/audit.jsonl`;

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
  project?: string;
  // otel
  user?: string;
  totalCost?: number;
  totalTokens?: number;
  promptCount?: number;
  toolCount?: number;
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
  tsNs: string; // raw nanosecond timestamp string (for pagination)
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

// ── OTEL / Loki data layer ─────────────────────────────────────────────────

async function queryLoki(query: string, startNs: bigint, endNs: bigint, limit = 5000): Promise<LokiEntry[]> {
  const url = new URL(`${LOKI_URL}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("direction", "backward");

  // Loki is a real external dependency that can be slow, unready, or briefly
  // unavailable (observed directly: /ready flapped 503 -> ready mid-session).
  // A hung or slow fetch here must never take down the whole /api/sessions
  // response — it degrades to "no OTEL events this page," never throws.
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(4000) });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let data: { status: string; data: { result: { stream: Record<string, string>; values: [string, string][] }[] } };
  try {
    data = await res.json() as typeof data;
  } catch {
    return [];
  }
  if (data.status !== "success") return [];

  const entries: LokiEntry[] = [];
  for (const stream of data.data.result) {
    const level = (stream.stream.level ?? "info") as "info" | "error";
    for (const [tsNs, line] of stream.values) {
      try {
        const parsed = JSON.parse(line) as { body?: string; attributes?: Record<string, unknown> };
        entries.push({
          tsNs,
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

// Paginated fetch — makes multiple 5000-entry Loki queries (sliding backward) until all events are
// collected. Loki's server-side max is 5000/query; without pagination, sessions > ~2k events lose
// their earliest data because newer sessions consume the quota.
// Each sub-window is capped at 29 days to stay under Loki's 30d1h max_query_length limit —
// a 30-day UI date range (start-of-day to end-of-day) actually spans ~31 days and triggers a 400.
async function fetchOtelEvents(userFilter?: string, startTs?: string, endTs?: string): Promise<LokiEntry[]> {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const startNs = startTs
    ? BigInt(new Date(startTs).getTime()) * 1_000_000n
    : nowNs - BigInt(LOOKBACK_DAYS) * 86_400_000_000_000n;

  const PAGE = 5000;
  const MAX_PAGES = 40; // increased for sub-window pagination
  const LOKI_WINDOW_NS = 29n * 86_400_000_000_000n; // 29-day sub-windows (Loki limit: 30d1h)
  const all: LokiEntry[] = [];
  let curEnd = endTs ? BigInt(new Date(endTs + 'T23:59:59Z').getTime()) * 1_000_000n : nowNs;

  // Wall-clock budget across the whole pagination loop, independent of page count:
  // Loki being slow/unready must degrade to partial results, never make this request
  // outlast Bun.serve's own idleTimeout (10s) — a hang here previously killed the
  // entire /api/sessions response with no useful error.
  const deadline = performance.now() + 6000;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (performance.now() > deadline) break;

    // Cap each Loki call to a 29-day window; slide backward between sub-windows
    const effectiveStart = curEnd - LOKI_WINDOW_NS > startNs ? curEnd - LOKI_WINDOW_NS : startNs;

    const batch = await queryLoki(`{job="claude-code"}`, effectiveStart, curEnd, PAGE);

    if (!batch.length) {
      if (effectiveStart <= startNs) break; // exhausted the requested range
      curEnd = effectiveStart - 1n; // slide to the previous sub-window
      continue;
    }

    all.push(...batch);

    if (batch.length < PAGE) {
      // Got all events in this sub-window; move to the previous sub-window if any remain
      if (effectiveStart <= startNs) break;
      curEnd = effectiveStart - 1n;
      continue;
    }

    // Full page — slide curEnd to just before the oldest event in this page
    // Use min tsNs across all entries (multiple streams may not be globally sorted)
    let oldestNs = BigInt(batch[0].tsNs);
    for (const e of batch) {
      const ns = BigInt(e.tsNs);
      if (ns < oldestNs) oldestNs = ns;
    }
    if (oldestNs <= startNs) break;
    curEnd = oldestNs - 1n;
  }

  return userFilter ? all.filter((e) => e.attributes["user.email"] === userFilter) : all;
}

type OtelSession = {
  id: string;
  user: string;
  project?: string;
  firstTs: string;
  lastTs: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  promptCount: number;
  toolCount: number;
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
    let model = "unknown", totalCost = 0, totalTokens = 0, promptCount = 0, toolCount = 0, hasErrors = false, firstPrompt = "";
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
      if (e.body === "claude_code.tool_decision") toolCount++;
      if (e.body === "claude_code.internal_error") hasErrors = true;
    }
    return {
      id,
      user: String(sorted[0].attributes["user.email"] ?? "unknown"),
      project: lookupProject(id),
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      model, totalCost, totalTokens, promptCount, toolCount, hasErrors, firstPrompt,
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

  // Index hook_execution_complete events per hookName, sorted by sequence, for reliable pairing.
  // Using seq-1 was fragile when other events interleave between start and complete.
  const completeSeqsPerHook = new Map<string, number[]>(); // hookName → sorted seqs
  const completeBySeq = new Map<number, LokiEntry>();       // seq → complete event
  for (const e of sorted) {
    if (e.body === "claude_code.hook_execution_complete") {
      const seq = Number(e.attributes["event.sequence"] ?? 0);
      const hookName = String(e.attributes["hook_name"] ?? "");
      completeBySeq.set(seq, e);
      const arr = completeSeqsPerHook.get(hookName) ?? [];
      arr.push(seq);
      completeSeqsPerHook.set(hookName, arr);
    }
  }
  function findHookComplete(hookName: string, startSeq: number): LokiEntry | undefined {
    const seqs = completeSeqsPerHook.get(hookName) ?? [];
    // Binary-search for smallest seq > startSeq (nearest complete after this start)
    let lo = 0, hi = seqs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seqs[mid] <= startSeq) lo = mid + 1; else hi = mid; }
    return lo < seqs.length ? completeBySeq.get(seqs[lo]) : undefined;
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
        decisionSource: String(e.attributes["source"] ?? ""),
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
      const complete = findHookComplete(hookName, seq);
      timeline.push({
        kind: "hook",
        ts: e.ts,
        hookEvent: String(e.attributes["hook_event"] ?? ""),
        hookName,
        hookSource: String(e.attributes["hook_source"] ?? ""),
        numHooks: Number(e.attributes["num_hooks"] ?? 1),
        durationMs: complete ? Number(complete.attributes["total_duration_ms"] ?? 0) : 0,
        numSuccess: complete ? Number(complete.attributes["num_success"] ?? 0) : undefined,
        numBlocking: complete ? Number(complete.attributes["num_blocking"] ?? 0) : undefined,
        numErrors: complete ? Number(complete.attributes["num_non_blocking_error"] ?? 0) : undefined,
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
  proxySession?: ProxySessionIndex;
};

// ── Audit / security types ─────────────────────────────────────────────────

type AuditEntry = {
  ts: string;
  sessionId: string;
  project?: string;
  hookEvent: string;
  toolName?: string;
  matches: Array<{
    type: string;
    severity: "block" | "warn" | "info";
    token: string;
    atlasTechnique?: string;
    owaspCategory?: string;
  }>;
  decision: "block" | "ask" | "allow";
};

type AuditEntryEnriched = AuditEntry & {
  atlasTechniques: Array<{ id: string; name: string }>;
  owaspCategories: Array<{ id: string; name: string }>;
};

type SecurityStats = {
  totalAuditEvents: number;
  byDecision: Record<string, number>;
  byMatchType: Record<string, number>;
  byHookEvent: Record<string, number>;
  byAtlasTechnique: Record<string, number>;
  byOwaspCategory: Record<string, number>;
  byMonth: Record<string, number>;
  uniqueSessionsWithEvents: number;
  topRiskySessions: Array<{ sessionId: string; blockCount: number; askCount: number; matchTypes: string[] }>;
  proxyFindingsBySeverity: Record<string, number>;
  proxyFindingsByScanner: Record<string, number>;
  secrets: {
    blocked: number;
    tokenizedInFlight: number;
    piiNoise: number;
    recentBlocked: Array<{ sessionId: string; ts: string; scannerId: string }>;
  };
};

function correlate(otelSessions: OtelSession[], proxySessions: ProxySessionIndex[]): UnifiedSession[] {
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
      project: matched?.project ?? proxy.project,
      user: matched?.user,
      totalCost: matched?.totalCost,
      totalTokens: matched?.totalTokens,
      promptCount: matched?.promptCount,
      toolCount: matched?.toolCount,
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
        firstPrompt: o.firstPrompt, model: o.model, project: o.project, user: o.user,
        totalCost: o.totalCost, totalTokens: o.totalTokens, promptCount: o.promptCount, toolCount: o.toolCount,
        hasErrors: o.hasErrors, otelId: o.id, otelSession: o,
      });
    }
  }

  return unified.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// ── Audit data layer ───────────────────────────────────────────────────────

const ATLAS_TECHNIQUE_MAP: Record<string, { id: string; name: string }> = {
  api_key_anthropic: { id: "AML.T0025", name: "Exfiltration via Inference API" },
  api_key_openai:    { id: "AML.T0025", name: "Exfiltration via Inference API" },
  api_key_xai:       { id: "AML.T0025", name: "Exfiltration via Inference API" },
  api_key_github:    { id: "AML.T0025", name: "Exfiltration via Inference API" },
  api_key_aws_access:{ id: "AML.T0025", name: "Exfiltration via Inference API" },
  api_key_generic:   { id: "AML.T0025", name: "Exfiltration via Inference API" },
  pii_ssn_us:        { id: "AML.T0098", name: "Private Data Inference" },
  pii_credit_card:   { id: "AML.T0098", name: "Private Data Inference" },
  pii_email:         { id: "AML.T0098", name: "Private Data Inference" },
  pii_phone_us:      { id: "AML.T0098", name: "Private Data Inference" },
  injection_instruction_override: { id: "AML.T0051", name: "LLM Prompt Injection" },
  injection_system_tag:           { id: "AML.T0051", name: "LLM Prompt Injection" },
  injection_dan:                  { id: "AML.T0051", name: "LLM Prompt Injection" },
  injection_identity_override:    { id: "AML.T0051", name: "LLM Prompt Injection" },
};

const OWASP_CATEGORY_MAP: Record<string, { id: string; name: string }> = {
  api_key_anthropic: { id: "LLM02", name: "Sensitive Information Disclosure" },
  api_key_openai:    { id: "LLM02", name: "Sensitive Information Disclosure" },
  api_key_xai:       { id: "LLM02", name: "Sensitive Information Disclosure" },
  api_key_github:    { id: "LLM02", name: "Sensitive Information Disclosure" },
  api_key_aws_access:{ id: "LLM02", name: "Sensitive Information Disclosure" },
  api_key_generic:   { id: "LLM02", name: "Sensitive Information Disclosure" },
  pii_ssn_us:        { id: "LLM02", name: "Sensitive Information Disclosure" },
  pii_credit_card:   { id: "LLM02", name: "Sensitive Information Disclosure" },
  pii_email:         { id: "LLM02", name: "Sensitive Information Disclosure" },
  pii_phone_us:      { id: "LLM02", name: "Sensitive Information Disclosure" },
  injection_instruction_override: { id: "LLM01", name: "Prompt Injection" },
  injection_system_tag:           { id: "LLM01", name: "Prompt Injection" },
  injection_dan:                  { id: "LLM01", name: "Prompt Injection" },
  injection_identity_override:    { id: "LLM01", name: "Prompt Injection" },
};

const auditLogCache = createJsonlTailCache<AuditEntry>(
  (line) => {
    try { return JSON.parse(line) as AuditEntry; } catch { return null; }
  },
  undefined,
  pruneOlderThan
);

function readAuditEntries(startTs?: string, endTs?: string): AuditEntry[] {
  const start = startTs ? new Date(startTs).getTime() : 0;
  const end = endTs ? new Date(endTs + "T23:59:59Z").getTime() : Infinity;
  const entries = auditLogCache.read(AUDIT_LOG_PATH).filter((e) => {
    const t = new Date(e.ts).getTime();
    return t >= start && t <= end;
  });
  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}

const ATLAS_NAME_BY_ID: Record<string, string> = Object.fromEntries(
  Object.values(ATLAS_TECHNIQUE_MAP).map((t) => [t.id, t.name])
);
const OWASP_NAME_BY_ID: Record<string, string> = Object.fromEntries(
  Object.values(OWASP_CATEGORY_MAP).map((c) => [c.id, c.name])
);

function enrichAuditEntry(e: AuditEntry): AuditEntryEnriched {
  const seenAtlas = new Set<string>();
  const atlasTechniques: Array<{ id: string; name: string }> = [];
  const seenOwasp = new Set<string>();
  const owaspCategories: Array<{ id: string; name: string }> = [];
  for (const m of e.matches) {
    // Prefer the taxonomy fields persisted on the match itself (new schema);
    // fall back to the static per-type map for audit entries logged before
    // the middleware started persisting these fields.
    const atlasId = m.atlasTechnique ?? ATLAS_TECHNIQUE_MAP[m.type]?.id;
    if (atlasId && !seenAtlas.has(atlasId)) {
      seenAtlas.add(atlasId);
      atlasTechniques.push({ id: atlasId, name: ATLAS_NAME_BY_ID[atlasId] ?? atlasId });
    }
    const owaspId = m.owaspCategory ?? OWASP_CATEGORY_MAP[m.type]?.id;
    if (owaspId && !seenOwasp.has(owaspId)) {
      seenOwasp.add(owaspId);
      owaspCategories.push({ id: owaspId, name: OWASP_NAME_BY_ID[owaspId] ?? owaspId });
    }
  }
  if (e.hookEvent === "UserPromptSubmit" && e.decision === "block" && !seenAtlas.has("AML.T0054")) {
    atlasTechniques.push({ id: "AML.T0054", name: "Influence Operations" });
  }
  return { ...e, atlasTechniques, owaspCategories };
}

function aggregateSecurityStats(auditEntries: AuditEntryEnriched[], proxyEntries: ProxyIndexEntry[]): SecurityStats {
  const byDecision: Record<string, number> = {};
  const byMatchType: Record<string, number> = {};
  const byHookEvent: Record<string, number> = {};
  const byAtlasTechnique: Record<string, number> = {};
  const byOwaspCategory: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  const sessionMap = new Map<string, { blockCount: number; askCount: number; matchTypes: Set<string> }>();

  // Secrets view: "blocked" = a secret pattern (api_key_*) that tripped a
  // block decision — was about to leak, got caught. "piiNoise" = everything
  // else (background PII detections regardless of decision). "tokenizedInFlight"
  // (below, from proxy findings) is the proxy's core value prop — a secret
  // that got swapped for a token and still went out, rather than blocked.
  let secretsBlocked = 0;
  let piiNoise = 0;
  const recentBlocked: Array<{ sessionId: string; ts: string; scannerId: string }> = [];

  for (const e of auditEntries) {
    byDecision[e.decision] = (byDecision[e.decision] ?? 0) + 1;
    byHookEvent[e.hookEvent] = (byHookEvent[e.hookEvent] ?? 0) + 1;
    const month = e.ts.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
    for (const m of e.matches) {
      byMatchType[m.type] = (byMatchType[m.type] ?? 0) + 1;
      if (m.type.startsWith("api_key_") && e.decision === "block") {
        secretsBlocked++;
        recentBlocked.push({ sessionId: e.sessionId, ts: e.ts, scannerId: m.type });
      } else if (m.type.startsWith("pii_")) {
        piiNoise++;
      }
    }
    for (const t of e.atlasTechniques) byAtlasTechnique[t.id] = (byAtlasTechnique[t.id] ?? 0) + 1;
    for (const c of e.owaspCategories) byOwaspCategory[c.id] = (byOwaspCategory[c.id] ?? 0) + 1;
    if (!sessionMap.has(e.sessionId)) sessionMap.set(e.sessionId, { blockCount: 0, askCount: 0, matchTypes: new Set() });
    const ss = sessionMap.get(e.sessionId)!;
    if (e.decision === "block") ss.blockCount++;
    else if (e.decision === "ask") ss.askCount++;
    for (const m of e.matches) ss.matchTypes.add(m.type);
  }

  const proxyFindingsBySeverity: Record<string, number> = {};
  const proxyFindingsByScanner: Record<string, number> = {};
  let secretsTokenizedInFlight = 0;
  for (const pe of proxyEntries) {
    for (const f of pe.findings ?? []) {
      proxyFindingsBySeverity[f.severity] = (proxyFindingsBySeverity[f.severity] ?? 0) + 1;
      proxyFindingsByScanner[f.scannerId] = (proxyFindingsByScanner[f.scannerId] ?? 0) + 1;
      if (f.scannerId.startsWith("privacy/api_key")) secretsTokenizedInFlight++;
      else if (f.scannerId.startsWith("privacy/pii")) piiNoise++;
    }
  }

  const topRiskySessions = [...sessionMap.entries()]
    .sort((a, b) => (b[1].blockCount + b[1].askCount) - (a[1].blockCount + a[1].askCount))
    .slice(0, 5)
    .map(([sessionId, v]) => ({ sessionId, blockCount: v.blockCount, askCount: v.askCount, matchTypes: [...v.matchTypes] }));

  return {
    totalAuditEvents: auditEntries.length,
    byDecision, byMatchType, byHookEvent, byAtlasTechnique, byOwaspCategory, byMonth,
    uniqueSessionsWithEvents: sessionMap.size,
    topRiskySessions,
    proxyFindingsBySeverity, proxyFindingsByScanner,
    secrets: {
      blocked: secretsBlocked,
      tokenizedInFlight: secretsTokenizedInFlight,
      piiNoise,
      recentBlocked: recentBlocked.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20),
    },
  };
}

function getAuditEntriesForSession(allEntries: AuditEntryEnriched[], sessionId: string, firstTs: string, lastTs: string): AuditEntryEnriched[] {
  const MARGIN_MS = 5 * 60 * 1000;
  const start = new Date(firstTs).getTime() - MARGIN_MS;
  const end = new Date(lastTs).getTime() + MARGIN_MS;
  return allEntries.filter(e =>
    e.sessionId === sessionId ||
    (new Date(e.ts).getTime() >= start && new Date(e.ts).getTime() <= end)
  );
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

async function handleSecurityStats(startTs?: string, endTs?: string): Promise<Response> {
  const auditEntries = readAuditEntries(startTs, endTs).map(enrichAuditEntry);
  const proxyEntries = readProxyEntries();
  return new Response(JSON.stringify(aggregateSecurityStats(auditEntries, proxyEntries)), { headers: { "content-type": "application/json" } });
}

async function handleSecurityEvents(startTs?: string, endTs?: string, sessionId?: string, decision?: string, limit = 500): Promise<Response> {
  let entries = readAuditEntries(startTs, endTs).map(enrichAuditEntry);
  if (sessionId) entries = entries.filter(e => e.sessionId === sessionId);
  if (decision) entries = entries.filter(e => e.decision === decision);
  const total = entries.length;
  return new Response(JSON.stringify({ events: entries.slice(0, limit), total }), { headers: { "content-type": "application/json" } });
}

async function handleSessions(source: Source, userFilter?: string, startTs?: string, endTs?: string, projectFilter?: string): Promise<Response> {
  let sessions: SessionSummary[];
  let availableUsers: string[] = [];

  if (source === "otel") {
    const events = await fetchOtelEvents(userFilter, startTs, endTs);
    const otel = buildOtelSessions(events);
    availableUsers = [...new Set(events.map((e) => String(e.attributes["user.email"] ?? "")).filter(Boolean))].sort();
    sessions = otel.map((o): SessionSummary => ({ id: o.id, source: "otel", firstTs: o.firstTs, lastTs: o.lastTs, firstPrompt: o.firstPrompt, model: o.model, project: o.project, user: o.user, totalCost: o.totalCost, totalTokens: o.totalTokens, promptCount: o.promptCount, toolCount: o.toolCount, hasErrors: o.hasErrors }));
  } else if (source === "proxy") {
    const proxy = segmentProxySessions(startTs, endTs);
    sessions = proxy.map((p): SessionSummary => ({ id: p.id, source: "proxy", firstTs: p.firstTs, lastTs: p.lastTs, firstPrompt: p.firstPrompt, model: p.model, project: p.project, messageCount: p.messageCount, piiCount: p.piiCount }));
  } else {
    const [events, proxy] = await Promise.all([fetchOtelEvents(userFilter, startTs, endTs), Promise.resolve(segmentProxySessions(startTs, endTs))]);
    const otel = buildOtelSessions(events);
    availableUsers = [...new Set(events.map((e) => String(e.attributes["user.email"] ?? "")).filter(Boolean))].sort();
    sessions = correlate(otel, proxy).map(({ otelSession: _o, proxySession: _p, ...summary }) => summary as SessionSummary);
  }

  const availableProjects = [...new Set(sessions.map((s) => s.project).filter(Boolean))].sort() as string[];
  if (projectFilter) sessions = sessions.filter((s) => s.project === projectFilter);

  return new Response(JSON.stringify({ sessions, total: sessions.length, availableUsers, availableProjects }), { headers: { "content-type": "application/json" } });
}

async function handleSession(id: string, source: Source, startTs?: string, endTs?: string): Promise<Response> {
  const allAudit = readAuditEntries(startTs, endTs).map(enrichAuditEntry);

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
    const firstTs2 = sessionEvents[0].ts;
    const lastTs2 = sessionEvents[sessionEvents.length - 1].ts;
    const auditEvents = getAuditEntriesForSession(allAudit, id, firstTs2, lastTs2);
    return new Response(JSON.stringify({ id, source: "otel", user, project: lookupProject(id), model, totalCost, events: timeline, auditEvents }), { headers: { "content-type": "application/json" } });
  }

  if (source === "proxy") {
    const sessions = segmentProxySessions(startTs, endTs);
    const s = sessions.find((p) => p.id === id);
    if (!s) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const messages = resolveProxySessionMessages(s.bestRef);
    if (!messages) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const messageTimestamps = deriveMessageTimestamps(s.entryTimestamps, messages.length, s.lastTs);
    const auditEvents = getAuditEntriesForSession(allAudit, id, s.firstTs, s.lastTs);
    return new Response(JSON.stringify({ id, source: "proxy", model: s.model, project: s.project, piiCount: s.piiCount, messages, messageTimestamps, findings: s.findings ?? [], securityDecision: s.securityDecision ?? "allow", auditEvents }), { headers: { "content-type": "application/json" } });
  }

  // unified — try proxy first (has full content), enrich with OTEL
  const [events, proxySessions] = await Promise.all([fetchOtelEvents(undefined, startTs, endTs), Promise.resolve(segmentProxySessions(startTs, endTs))]);
  const otelSessions = buildOtelSessions(events);
  const unified = correlate(otelSessions, proxySessions);
  // Match on any of the three id forms: a session with a proxy match carries
  // its proxy-format ts as `id` (see correlate()), so a caller holding the
  // otel-format id (e.g. from an OTEL-only view or an audit event) would
  // otherwise 404 even though the session exists.
  const us = unified.find((u) => u.id === id || u.otelId === id || u.proxyId === id) as UnifiedSession | undefined;
  if (!us) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

  const otelTimeline = us.otelSession ? buildOtelTimeline(us.otelSession.events) : [];
  const messages = us.proxySession ? (resolveProxySessionMessages(us.proxySession.bestRef) ?? []) : [];
  const messageTimestamps = us.proxySession ? deriveMessageTimestamps(us.proxySession.entryTimestamps, messages.length, us.proxySession.lastTs) : [];
  // use otelId for exact session match when available, fall back to time window
  const sessionIdForAudit = us.otelId ?? id;
  const auditEvents = getAuditEntriesForSession(allAudit, sessionIdForAudit, us.firstTs, us.lastTs);

  return new Response(JSON.stringify({
    id: us.id, source: "unified",
    user: us.user, project: us.project, model: us.model, totalCost: us.totalCost, totalTokens: us.totalTokens,
    otelId: us.otelId, proxyId: us.proxyId,
    piiCount: us.piiCount ?? 0,
    messages,
    messageTimestamps,
    otelEvents: otelTimeline,
    findings: us.proxySession?.findings ?? [],
    securityDecision: us.proxySession?.securityDecision ?? "allow",
    auditEvents,
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
#project-filter { display: flex; gap: 5px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--border3); background: var(--bg); }
#project-filter button { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); cursor: pointer; }
#project-filter button.active { background: var(--surface3); color: var(--accent3); border-color: var(--accent3); }
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
.badge-tools { background: var(--surface3); color: var(--accent3); }
.badge-msgs { background: var(--surface3); color: var(--success-color); }
.badge-cost { background: var(--surface3); color: var(--cost-color); }
.badge-error { background: var(--error-bg); color: var(--error-color); }
.badge-user { background: var(--surface3); color: var(--accent3); }
.badge-project { background: var(--surface3); color: var(--accent2); }
.badge-pii { background: var(--error-bg); color: var(--error-color); }
.badge-sec-block { background: #7c1d1d; color: #fca5a5; }
.badge-sec-warn { background: #78350f; color: #fcd34d; }
.badge-secrets { background: #78350f; color: #fcd34d; }
.badge-linked { background: var(--surface3); color: var(--success-color); }
.badge[data-cat] { cursor: pointer; }

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

/* Category nav bar */
#cat-nav-bar { display: none; position: fixed; bottom: 18px; right: 24px; gap: 8px; align-items: center; background: var(--surface3); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font-size: 12px; color: var(--text2); box-shadow: 0 2px 10px rgba(0,0,0,0.3); z-index: 50; }
#cat-nav-bar.active { display: flex; }
#cat-nav-bar button { font-size: 12px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); cursor: pointer; }
#cat-nav-bar .cnb-count { color: var(--text3); font-size: 11px; white-space: nowrap; }

/* PII marks */
mark.pii-hit { background: #7c3aed33; color: inherit; border-radius: 2px; padding: 0 1px; }
mark.pii-active { background: #7c3aed99; outline: 2px solid #7c3aed; }
mark.search-hit { background: #fbbf2444; color: inherit; border-radius: 2px; }
mark.search-active { background: #f59e0b; color: #000; outline: 2px solid #f59e0b; }

/* Hook/system cards */
.tl-hook { background: var(--surface); border: 1px solid var(--border3); border-left: 3px solid #6366f155; border-radius: 6px; padding: 4px 10px; font-size: 11px; color: var(--text3); font-family: monospace; display: flex; gap: 8px; align-items: center; max-width: 480px; }
.tl-hook.tl-hook-blocked { border-left-color: var(--error-color); background: var(--error-bg); }
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

/* Security findings panel */
.sec-findings-panel { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
.sec-findings-title { font-size: 11px; font-weight: 600; color: var(--text3); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
.sec-finding { font-size: 12px; padding: 4px 0; display: flex; gap: 8px; align-items: baseline; }

/* Proxy conversation bubbles */
.msg { display: flex; flex-direction: column; max-width: 78%; }
.msg.user { align-self: flex-end; align-items: flex-end; }
.msg.assistant { align-self: flex-start; align-items: flex-start; }
.msg-role { font-size: 10px; color: var(--text3); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.05em; }
.msg-ts { text-transform: none; letter-spacing: normal; font-weight: normal; margin-left: 6px; color: var(--text3); }
.finding-marker { cursor: pointer; margin-left: 4px; }
.cat-active { outline: 2px solid var(--accent2); border-radius: 4px; }
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

/* ── Security dashboard ─────────────────────────────────────── */
.sec-stats-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; padding:16px 20px 8px; }
.sec-stat-card { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:12px 14px; text-align:center; }
.sec-stat-card .sv { font-size:26px; font-weight:700; color:var(--accent); line-height:1; }
.sec-stat-card .sv.red { color:var(--error-color); }
.sec-stat-card .sv.amber { color:var(--cost-color); }
.sec-stat-card .sv.green { color:var(--success-color); }
.sec-stat-card .sl { font-size:10px; color:var(--text3); margin-top:4px; text-transform:uppercase; letter-spacing:.05em; }
.sec-subtabs { display:flex; gap:6px; padding:0 20px 12px; border-bottom:1px solid var(--border); }
.sec-subtabs button { background:transparent; border:1px solid var(--border); color:var(--text2); font-size:11px; padding:4px 10px; border-radius:4px; cursor:pointer; }
.sec-subtabs button.active { background:var(--accent); border-color:var(--accent); color:#fff; }
.sec-body { padding:0 20px 20px; }
.sec-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:10px; }
.sec-table th { text-align:left; padding:6px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); border-bottom:1px solid var(--border); }
.sec-table td { padding:6px 8px; border-bottom:1px solid var(--border2); vertical-align:middle; }
.sec-table tr:hover td { background:var(--surface); }
.sec-table .target-cell { font-family:monospace; font-size:11px; color:var(--text2); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sec-table .session-link { font-family:monospace; font-size:11px; color:var(--accent); cursor:pointer; text-decoration:underline; }
.sec-atlas-row { display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--border2); }
.sec-atlas-bar { height:8px; background:var(--accent); border-radius:4px; min-width:4px; }
.sec-atlas-count { font-size:11px; color:var(--text3); margin-left:auto; flex-shrink:0; }
.sec-proxy-row { display:flex; align-items:center; gap:8px; padding:5px 0; border-bottom:1px solid var(--border2); font-size:12px; }
.sec-proxy-scanner { font-family:monospace; color:var(--text2); flex:1; }
.sec-proxy-count { color:var(--text3); font-size:11px; }
.badge-atlas { background:#1a2a1a; color:#4ade80; border:1px solid #2a4a2a; font-size:10px; padding:1px 6px; border-radius:8px; text-decoration:none; font-family:monospace; display:inline-block; }
.badge-atlas:hover { background:#1e3a1e; color:#86efac; }
.badge-owasp { background:#2a1a2e; color:#e879f9; border:1px solid #4a2a4e; font-size:10px; padding:1px 6px; border-radius:8px; text-decoration:none; font-family:monospace; display:inline-block; }
.badge-owasp:hover { background:#3a1e3e; color:#f0abfc; }
.dec-block { background:var(--error-bg,#2d0a0a); color:var(--error-color); font-size:10px; padding:1px 6px; border-radius:8px; display:inline-block; }
.dec-ask { background:#3d2700; color:#fbbf24; font-size:10px; padding:1px 6px; border-radius:8px; display:inline-block; }
.dec-allow { background:var(--surface3); color:var(--success-color); font-size:10px; padding:1px 6px; border-radius:8px; display:inline-block; }
.mt-badge { font-size:10px; padding:1px 5px; border-radius:6px; background:var(--surface3); color:var(--text2); margin:1px; display:inline-block; }
.mt-key { background:#1e2a3a; color:#93c5fd; }
.mt-pii { background:#2a1e3a; color:#c4b5fd; }
/* ── Per-session audit panel ─────────────────────────────────── */
.audit-panel { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin-bottom:12px; }
.audit-panel-title { font-size:11px; font-weight:600; color:var(--text3); text-transform:uppercase; letter-spacing:.06em; margin-bottom:8px; cursor:pointer; user-select:none; }
.audit-event-row { display:flex; gap:6px; align-items:baseline; padding:4px 0; border-bottom:1px solid var(--border2); font-size:12px; flex-wrap:wrap; }
.audit-event-row:last-child { border-bottom:none; }
.ae-time { font-size:10px; color:var(--text3); white-space:nowrap; flex-shrink:0; }
.ae-hook { font-size:10px; color:var(--accent3,#a78bfa); background:var(--surface3); padding:1px 5px; border-radius:4px; flex-shrink:0; }
.ae-tool { font-family:monospace; font-size:11px; color:var(--text2); flex-shrink:0; }
.ae-matches { display:flex; gap:2px; flex-wrap:wrap; }
.ae-atlas { display:flex; gap:3px; flex-wrap:wrap; }
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
    <button onclick="setView('security')" id="tab-security">🛡 Security</button>
  </div>
  <div id="date-range">
    <label>From</label><input type="date" id="date-from" onchange="applyDateRange()">
    <label>To</label><input type="date" id="date-to" onchange="applyDateRange()">
  </div>
  <div id="sidebar-search"><input id="sidebar-search-input" type="text" placeholder="Search conversations…" oninput="filterSessions(this.value)"></div>
  <div id="user-filter" style="display:none"></div>
  <div id="project-filter" style="display:none"></div>
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
<div id="cat-nav-bar">
  <span class="cnb-label" id="cnb-label"></span>
  <span class="cnb-count" id="cnb-count"></span>
  <button onclick="advanceCategory(-1)">‹</button>
  <button onclick="advanceCategory(1)">›</button>
  <button onclick="clearCategoryNav()">✕</button>
</div>

<script>
let activeId = null;
let activeSource = 'unified';
let activeUser = null;
let activeProject = null;
let activeView = 'conversations';
let allExpanded = false;
let allSessions = [];
let secEventsBySession = {};
localStorage.removeItem('hiddenKinds'); // clear stale toggle state from pre-fix sessions
const hiddenKinds = new Set();

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(ts) { const d=new Date(ts); return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function fmtCost(n) { if(!n||n===0) return null; return n<0.01?'<$0.01':'$'+n.toFixed(2); }
function fmtTok(n) { return n>=1000?(n/1000).toFixed(1)+'k':String(n); }

function setSource(src) {
  activeView = 'conversations';
  activeSource = src;
  activeId = null;
  ['unified','otel','proxy','security'].forEach(s => {
    document.getElementById('tab-'+s).classList.toggle('active', s===src);
  });
  document.getElementById('event-filters').style.display = '';
  document.getElementById('search-bar').style.display = '';
  document.getElementById('date-range').style.display = '';
  document.getElementById('sidebar-search').style.display = '';
  document.getElementById('thread-header').innerHTML = '<span class="info">Select a conversation</span>';
  document.getElementById('thread').innerHTML = '<div class="empty">← Select a conversation to view</div>';
  loadSessions();
}

function setView(view) {
  activeView = view;
  ['unified','otel','proxy','security'].forEach(s => {
    document.getElementById('tab-'+s).classList.toggle('active', s===view);
  });
  if (view === 'security') {
    document.getElementById('event-filters').style.display = 'none';
    document.getElementById('search-bar').style.display = 'none';
    document.getElementById('date-range').style.display = 'none';
    document.getElementById('sidebar-search').style.display = 'none';
    document.getElementById('thread-header').innerHTML = '<span class="info">Security Dashboard</span>';
    document.getElementById('thread').innerHTML = '<div class="empty">Loading security data…</div>';
    loadSecurityDashboard();
  }
}

function switchToSession(id, target) {
  setSource('unified');
  loadSession(id, target);
}

async function loadSessions() {
  const qs = new URLSearchParams({source: activeSource});
  if (activeUser) qs.set('user', activeUser);
  if (activeProject) qs.set('project', activeProject);
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

  const projectFilterEl = document.getElementById('project-filter');
  if (data.availableProjects && data.availableProjects.length > 1) {
    projectFilterEl.style.display = 'flex';
    projectFilterEl.innerHTML =
      '<button class="'+(activeProject===null?'active':'')+'" onclick="setProject(null)">All projects</button>' +
      data.availableProjects.map(p =>
        '<button class="'+(activeProject===p?'active':'')+'" onclick="setProject(\\\''+p+'\\\')" title="'+esc(p)+'">'+esc(p)+'</button>'
      ).join('');
  } else { projectFilterEl.style.display = 'none'; }

  allSessions = data.sessions;
  const sidebarQuery = document.getElementById('sidebar-search-input')?.value || '';
  if (sidebarQuery.trim()) filterSessions(sidebarQuery);
  else renderSessionList(allSessions);
}

function renderSessionList(sessions) {
  const multiUser = !!(allSessions.some(s => s.user) &&
    new Set(allSessions.map(s => s.user).filter(Boolean)).size > 1);
  const multiProject = !!(allSessions.some(s => s.project) &&
    new Set(allSessions.map(s => s.project).filter(Boolean)).size > 1);

  document.getElementById('session-list').innerHTML = sessions.map(s => {
    const cost = fmtCost(s.totalCost);
    const title = s.firstPrompt
      ? esc(s.firstPrompt.length>70 ? s.firstPrompt.slice(0,70)+'…' : s.firstPrompt)
      : '<span style="color:var(--text3);font-style:italic">No prompts</span>';

    const badges = [
      s.model&&s.model!=='unknown' ? '<span class="badge badge-model">'+esc(s.model.replace('claude-',''))+'</span>' : '',
      s.promptCount>0 ? '<span class="badge badge-prompts">'+s.promptCount+' prompts</span>' : '',
      s.toolCount>0 ? '<span class="badge badge-tools">🔧'+s.toolCount+'</span>' : '',
      s.messageCount>0 ? '<span class="badge badge-msgs">'+s.messageCount+' msgs</span>' : '',
      cost ? '<span class="badge badge-cost">'+esc(cost)+'</span>' : '',
      s.hasErrors ? '<span class="badge badge-error">errors</span>' : '',
      s.piiCount>0 ? '<span class="badge badge-pii">🔒'+s.piiCount+'</span>' : '',
      (()=>{ const sec=secEventsBySession[s.id]||secEventsBySession[s.otelId]; return sec ? (sec.blockCount>0?'<span class="badge badge-sec-block">🛡'+sec.blockCount+'</span>':sec.askCount>0?'<span class="badge badge-sec-warn">⚠'+sec.askCount+'</span>':'') : ''; })(),
      s.otelId&&s.proxyId ? '<span class="badge badge-linked">linked</span>' : '',
      multiUser&&!activeUser&&s.user ? '<span class="badge badge-user">'+esc(s.user.replace(/@.*/,''))+'</span>' : '',
      multiProject&&!activeProject&&s.project ? '<span class="badge badge-project">📁'+esc(s.project)+'</span>' : '',
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
function setProject(p) { activeProject=p; loadSessions(); }

// Mirrors renderContent's pairing logic exactly, so this count always matches
// the actual number of data-cat="tools" cards rendered from proxy messages
// (each tool_use is exactly one card whether standalone or paired with its
// result; each orphan tool_result with no matching tool_use is its own card).
function countProxyToolCards(messages) {
  if (!Array.isArray(messages)) return 0;
  const blocks = [];
  for (const m of messages) if (Array.isArray(m.content)) blocks.push(...m.content);
  const toolUseIds = new Set(blocks.filter(b => b && b.type==='tool_use' && b.id).map(b => b.id));
  let count = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_use') count++;
    else if (b.type === 'tool_result' && !toolUseIds.has(b.tool_use_id)) count++;
  }
  return count;
}

async function loadSession(id, target) {
  activeId = id;
  document.querySelectorAll('.session-row').forEach(r => {
    r.classList.toggle('active', r.getAttribute('onclick')?.includes("'"+id+"'"));
  });
  const qs = new URLSearchParams({source: activeSource});
  const dateFrom = document.getElementById('date-from')?.value;
  const dateTo = document.getElementById('date-to')?.value;
  if (dateFrom) qs.set('start', dateFrom);
  if (dateTo) qs.set('end', dateTo);
  const r = await fetch('/api/sessions/'+encodeURIComponent(id)+'?'+qs.toString());
  if (!r.ok) return;
  const data = await r.json();

  const cost = fmtCost(data.totalCost);
  const evts = data.source==='otel' ? data.events : (data.otelEvents||[]);
  const toolCnt = evts.filter(e=>e.kind==='tool').length + countProxyToolCards(data.messages);
  const hookCnt = evts.filter(e=>e.kind==='hook').length;
  const secFindings = data.findings ?? [];
  const secretsFindings = secFindings.filter(f=>f.scannerId.startsWith('privacy/api_key'));
  const secDecision = data.securityDecision ?? 'allow';
  const secBadge = secFindings.length > 0
    ? (secDecision==='block'
        ? '<span class="badge badge-sec-block" data-cat="findings" onclick="selectCategory(\\\'findings\\\')">🛡 '+secFindings.length+' blocked</span>'
        : '<span class="badge badge-sec-warn" data-cat="findings" onclick="selectCategory(\\\'findings\\\')">⚠ '+secFindings.length+' finding'+(secFindings.length>1?'s':'')+'</span>')
    : '';
  const secretsBadge = secretsFindings.length > 0
    ? '<span class="badge badge-secrets" data-cat="secrets" onclick="selectCategory(\\\'secrets\\\')">🔑'+secretsFindings.length+' secrets</span>'
    : '';
  const hdrParts = [
    data.model&&data.model!=='unknown' ? '<span class="badge badge-model">'+esc(data.model)+'</span>' : '',
    data.source==='otel' ? (evts.filter(e=>e.kind==='prompt').length+' prompts') : (data.messages?.length??0)+' msgs',
    toolCnt>0 ? '<span class="badge badge-tools" data-cat="tools" onclick="selectCategory(\\\'tools\\\')">🔧'+toolCnt+' tools</span>' : '',
    hookCnt>0 ? '<span style="color:var(--text3);font-size:11px">⚙'+hookCnt+'</span>' : '',
    cost ? '<span class="badge badge-cost">'+esc(cost)+'</span>' : '',
    data.piiCount>0 ? '<span class="badge badge-pii" data-cat="pii" onclick="selectCategory(\\\'pii\\\')">🔒'+data.piiCount+' PII</span>' : '',
    secBadge,
    secretsBadge,
    data.user ? '<span class="badge badge-user">'+esc(data.user.replace(/@.*/,''))+'</span>' : '',
    data.project ? '<span class="badge badge-project">📁'+esc(data.project)+'</span>' : '',
  ].filter(Boolean);
  document.getElementById('thread-header').innerHTML =
    hdrParts.join(' ')+
    ' <span class="session-id" title="click to copy" onclick="copyId(\\\''+id+'\\\')">'+(data.otelId||id).slice(0,8)+'…</span>'+
    (data.piiCount>0||true ? ' <button id="pii-nav-btn" class="btn" onclick="nextPii()">🔒</button>' : '')+
    ' <button class="btn" onclick="toggleSearch()">🔍</button>'+
    ' <button id="expand-btn" class="btn" onclick="toggleAll()">Expand all</button>';

  document.getElementById('event-filters').classList.toggle('active', data.source==='otel'||data.source==='unified');

  // Reset all kind filters when loading a new session so nothing is accidentally hidden
  if (hiddenKinds.size > 0) {
    hiddenKinds.clear();
    ['prompt','api','tool','hook','system','error'].forEach(k => {
      document.body.classList.remove('hide-'+k);
      const btn = document.querySelector('#event-filters [data-kind="'+k+'"]');
      if (btn) btn.classList.add('on');
    });
  }

  allExpanded = false;
  const thread = document.getElementById('thread');

  const auditEvents = data.auditEvents ?? [];
  const otelEvts = data.source === 'otel' ? data.events : (data.otelEvents || []);

  if (data.source === 'otel') {
    thread.innerHTML = renderAuditEventsPanel(auditEvents) + renderRiskPackages(otelEvts) + data.events.map(renderOtelEvent).join('');
  } else if (data.source === 'proxy') {
    thread.innerHTML = renderSecurityFindings(data.findings) + renderAuditEventsPanel(auditEvents) + data.messages.map((m,i)=>renderProxyMessage(m,null,data.messageTimestamps?.[i],i,data.findings)).join('');
  } else {
    // unified: proxy messages as base, OTEL events interleaved
    thread.innerHTML = renderSecurityFindings(data.findings) + renderAuditEventsPanel(auditEvents) + renderRiskPackages(otelEvts) + renderUnified(data);
  }
  thread.scrollTop = thread.scrollHeight;
  setTimeout(() => { scanPii(); populateCategoryHits(); if (target) jumpToTarget(target); }, 50);
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
}

function toggleAll() {
  allExpanded = !allExpanded;
  document.querySelectorAll('.tool-body').forEach(el => el.classList.toggle('open', allExpanded));
  const expandBtn = document.getElementById('expand-btn');
  if (expandBtn) expandBtn.textContent = allExpanded ? 'Collapse all' : 'Expand all';
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
    const blocking = ev.numBlocking > 0;
    const errored  = ev.numErrors > 0;
    const statusIcon = blocking ? ' 🚫' : (errored ? ' ⚠' : '');
    const successBadge = (ev.numSuccess !== undefined && ev.numSuccess > 0 && !blocking)
      ? '<span style="color:var(--success-color);font-size:10px">✓'+ev.numSuccess+'</span>' : '';
    return '<div class="tl-hook'+(blocking?' tl-hook-blocked':'')+'">'+
      '<span>⚙</span>'+
      '<span class="hk-name">'+esc(ev.hookName)+esc(statusIcon)+'</span>'+
      (ev.numHooks>1?'<span style="color:var(--text3)">×'+ev.numHooks+'</span>':'')+
      successBadge+
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

  return '<div class="'+cls+'" data-cat="tools" data-ts="'+esc(ts||'')+'">'+
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

function renderPairedCard(callBlock, resultBlock, ts) {
  if (!callBlock) {
    // Tool call is in a different message — render result-only card
    const isErr = resultBlock.is_error;
    const resultText = Array.isArray(resultBlock.content)
      ? resultBlock.content.map(b=>String(b.text||b.content||'')).join('\\n')
      : String(resultBlock.content||'');
    const uid = 'tc-'+Math.random().toString(36).slice(2);
    const preview = resultText.split('\\n')[0].slice(0,80);
    return '<div class="tl-tool'+(isErr?' tool-blocked':'')+'" data-cat="tools" data-ts="'+esc(ts||'')+'">'+
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

  return '<div class="tl-tool'+(isErr?' tool-blocked':'')+'" data-cat="tools" data-ts="'+esc(ts||'')+'">'+
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
    // tool_result uses "command"; tool_parameters (blocked/not-executed) uses "bash_command"/"full_command"
    const cmd = i.command || i.full_command || i.bash_command;
    if (cmd) sections.push(['Command', String(cmd)]);
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
  if (n==='bash') return String(i.command||i.full_command||i.bash_command||'').split('\\n')[0].slice(0,80);
  if (n==='read') return String(i.file_path||'');
  if (n==='write'||n==='edit'||n==='multiedit') return String(i.file_path||'');
  if (n==='agent') return String(i.description||'');
  if (n==='webfetch') return String(i.url||'');
  if (n==='websearch') return String(i.query||'');
  if (n==='glob'||n==='grep') return String(i.pattern||i.query||i.glob||'');
  return JSON.stringify(i).slice(0,80);
}

function fmtBytes(n) { return n>1024?(n/1024).toFixed(1)+'kb':n+'b'; }

// ── Security findings & audit rendering ───────────────────────────────────

const ATLAS_NAMES_CLIENT = {
  'AML.T0025': 'Exfiltration via Inference API',
  'AML.T0054': 'Influence Operations',
  'AML.T0098': 'Private Data Inference',
  'AML.T0010': 'Supply Chain Compromise',
  'AML.T0051.000': 'Direct Prompt Injection',
  'AML.T0051.001': 'Indirect LLM Injection',
};

const OWASP_NAMES_CLIENT = {
  'LLM01': 'Prompt Injection',
  'LLM02': 'Sensitive Information Disclosure',
  'LLM03': 'Supply Chain',
  'LLM04': 'Data and Model Poisoning',
  'LLM05': 'Improper Output Handling',
  'LLM06': 'Excessive Agency',
  'LLM07': 'System Prompt Leakage',
  'LLM08': 'Vector and Embedding Weaknesses',
  'LLM09': 'Misinformation',
  'LLM10': 'Unbounded Consumption',
};

function renderOwaspBadge(category) {
  if (!category) return '';
  const name = OWASP_NAMES_CLIENT[category] || category;
  const url = 'https://genai.owasp.org/llm-top-10/';
  return '<a class="badge badge-owasp" href="'+esc(url)+'" target="_blank" rel="noopener" title="'+esc(name)+'">'+esc(category)+'</a>';
}

function renderAtlasBadge(technique) {
  if (!technique) return '';
  const name = ATLAS_NAMES_CLIENT[technique] || technique;
  const baseId = technique.replace(/\\.\\d{3}$/, '');
  const url = 'https://atlas.mitre.org/techniques/' + encodeURIComponent(baseId);
  return '<a class="badge badge-atlas" href="'+esc(url)+'" target="_blank" rel="noopener" title="'+esc(name)+'">'+esc(technique)+'</a>';
}

function renderSecurityFindings(findings) {
  if (!findings || findings.length === 0) return '';
  const byScanner = {};
  for (const f of findings) {
    if (!byScanner[f.scannerId]) byScanner[f.scannerId] = { ...f, count: 0 };
    byScanner[f.scannerId].count++;
  }
  const rows = Object.values(byScanner).map(f => {
    const sev = f.severity === 'block' ? 'badge-sec-block' : 'badge-sec-warn';
    const atlas = f.atlasTechnique ? ' '+renderAtlasBadge(f.atlasTechnique) : '';
    const cnt = f.count > 1 ? ' <span style="color:var(--text3)">×'+f.count+'</span>' : '';
    return '<div class="sec-finding"><span class="badge '+sev+'">'+esc(f.severity)+'</span> '+
      '<span style="font-family:monospace;font-size:11px;color:var(--text3)">'+esc(f.scannerId)+'</span> '+
      esc(f.description)+cnt+atlas+'</div>';
  }).join('');
  return '<div class="sec-findings-panel"><div class="sec-findings-title">🛡 Security Findings</div>'+rows+'</div>';
}

function renderMatchTypeBadge(type) {
  const isKey = type.startsWith('api_key_');
  const cls = isKey ? 'mt-badge mt-key' : 'mt-badge mt-pii';
  const label = isKey ? '🔑 '+type.replace('api_key_','') : '📋 '+type.replace('pii_','');
  return '<span class="'+cls+'">'+esc(label)+'</span>';
}

function renderAuditEventsPanel(auditEvents) {
  if (!auditEvents || !auditEvents.length) return '';
  const rows = auditEvents.map(ev => {
    const decCls = ev.decision === 'block' ? 'dec-block' : ev.decision === 'ask' ? 'dec-ask' : 'dec-allow';
    const matchBadges = (ev.matches||[]).map(m => renderMatchTypeBadge(m.type)).join('');
    const atlasBadges = (ev.atlasTechniques||[]).map(t => renderAtlasBadge(t.id)).join(' ');
    return '<div class="audit-event-row">'+
      '<span class="ae-time">'+esc(fmtTime(ev.ts))+'</span>'+
      '<span class="'+decCls+'">'+esc(ev.decision)+'</span>'+
      '<span class="ae-hook">'+esc(ev.hookEvent)+'</span>'+
      (ev.toolName ? '<span class="ae-tool">'+esc(ev.toolName)+'</span>' : '')+
      '<span class="ae-matches">'+matchBadges+'</span>'+
      '<span class="ae-atlas">'+atlasBadges+'</span>'+
      '</div>';
  }).join('');
  return '<div class="audit-panel">'+
    '<div class="audit-panel-title" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\\'none\\'?\\'block\\':\\'none\\'">'+
    '🔐 Security Audit ('+auditEvents.length+')</div>'+
    '<div>'+rows+'</div></div>';
}

function renderRiskPackages(otelEvents) {
  if (!otelEvents || !otelEvents.length) return '';
  const pkgs = new Set();
  for (const ev of otelEvents) {
    if (ev.kind !== 'tool' || ev.toolName !== 'Bash') continue;
    const cmd = (ev.input && typeof ev.input === 'object') ? String(ev.input.command || ev.input.full_command || '') : '';
    if (!cmd) continue;
    for (const m of cmd.matchAll(/npm\\s+(?:install|i)\\s+([^\\s;&|]+)/g)) pkgs.add(m[1]);
    for (const m of cmd.matchAll(/pip3?\\s+install\\s+([^\\s;&|]+)/g)) pkgs.add(m[1]);
    if (/curl\\s+[^|]+\\|\\s*(?:ba)?sh/.test(cmd)) pkgs.add('curl|sh');
    if (/wget\\s+[^|]+\\|\\s*(?:ba)?sh/.test(cmd)) pkgs.add('wget|sh');
    if (/eval\\s*\\$\\(curl/.test(cmd)) pkgs.add('eval$(curl)');
  }
  if (!pkgs.size) return '';
  const rows = [...pkgs].map(p =>
    '<div class="sec-finding"><span class="badge badge-sec-warn">'+esc(p)+'</span> '+renderAtlasBadge('AML.T0010')+'</div>'
  ).join('');
  return '<div class="sec-findings-panel"><div class="sec-findings-title">📦 Package Installs</div>'+rows+'</div>';
}

// ── Proxy rendering ────────────────────────────────────────────────────────

function renderProxyMessage(msg, callMap, ts, idx, findings) {
  const bodyHtml = renderContent(msg.content, callMap, ts);
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
  const tsHtml = ts ? '<span class="msg-ts">'+esc(fmtTime(ts))+'</span>' : '';
  const covering = (Number.isInteger(idx) && Array.isArray(findings))
    ? findings.filter(f => idx >= f.fromMessageIndex && idx <= f.toMessageIndex)
    : [];
  const markerHtml = covering.map(f => {
    const isSecret = f.scannerId.startsWith('privacy/api_key');
    return '<span class="finding-marker" data-cat="findings" data-ts="'+esc(f.ts||'')+'" title="'+esc(f.description||'')+'">🛡</span>'+
      (isSecret ? '<span class="finding-marker" data-cat="secrets" data-ts="'+esc(f.ts||'')+'" title="'+esc(f.description||'')+'">🔑</span>' : '');
  }).join('');
  return '<div class="msg '+msg.role+'">'+
    '<div class="msg-role">'+msg.role+sourceLabel+tsHtml+markerHtml+'</div>'+
    '<div class="bubble">'+bodyHtml+'</div></div>';
}

function renderContent(content, extCallMap, ts) {
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
      return renderToolCard(block.name||'tool', block.input, 0, true, 'accept', ts, 0, undefined);
    }
    if (block.type === 'tool_result') {
      const call = toolUseById[block.tool_use_id];
      if (call) consumed.add(call.id);
      return renderPairedCard(call||null, block, ts);
    }
    return '';
  }).filter(Boolean).join('');
}

// ── Unified rendering ──────────────────────────────────────────────────────

function renderUnified(data) {
  // OTEL-only session (no proxy messages) — fall back to full OTEL timeline
  if ((!data.messages || data.messages.length === 0) && data.otelEvents && data.otelEvents.length > 0) {
    return data.otelEvents.map(renderOtelEvent).join('') || '<div class="empty">No content</div>';
  }

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
  const msgs = data.messages||[];
  for (let mi = 0; mi < msgs.length; mi++) {
    const msg = msgs[mi];
    const rendered = renderProxyMessage(msg, null, data.messageTimestamps?.[mi], mi, data.findings);
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

// ── Category navigation (pii / tools / secrets / findings) ────────────────

let categoryHits = { pii: [], tools: [], secrets: [], findings: [] };
let categoryIdx = { pii: -1, tools: -1, secrets: -1, findings: -1 };
let activeCategory = null;

const CAT_LABELS = { pii: '🔒 PII', tools: '🔧 Tools', secrets: '🔑 Secrets', findings: '🛡 Findings' };

const PII_PATTERNS = [
  /\\b[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}\\b/g,
  /\\b\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b/g,
  /\\b\\d{3}-\\d{2}-\\d{4}\\b/g,
];

function scanPii() {
  categoryHits.pii = [];
  const thread = document.getElementById('thread');
  PII_PATTERNS.forEach(pat => {
    highlightPiiInNode(thread, pat);
  });
  categoryHits.pii = [...document.querySelectorAll('mark.pii-hit')];
  const piiBtn = document.getElementById('pii-nav-btn');
  if (piiBtn) piiBtn.textContent = categoryHits.pii.length ? '🔒'+categoryHits.pii.length : '';
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

function populateCategoryHits() {
  // Header badges reuse the same data-cat attribute (for their onclick=selectCategory
  // wiring) as the actual per-message/per-tool-call markers — exclude .badge so the
  // badge itself doesn't get counted as a navigable instance and inflate "N of M".
  categoryHits.tools = [...document.querySelectorAll('[data-cat="tools"]:not(.badge)')];
  categoryHits.secrets = [...document.querySelectorAll('[data-cat="secrets"]:not(.badge)')];
  categoryHits.findings = [...document.querySelectorAll('[data-cat="findings"]:not(.badge)')];
}

function selectCategory(cat) {
  const hits = categoryHits[cat];
  if (!hits || !hits.length) return;
  activeCategory = cat;
  categoryIdx[cat] = -1;
  advanceCategory(1);
}

function advanceCategory(dir) {
  const cat = activeCategory;
  const hits = cat && categoryHits[cat];
  if (!hits || !hits.length) return;
  const prev = hits[categoryIdx[cat]];
  if (prev) prev.classList.remove('cat-active', 'pii-active');
  categoryIdx[cat] = ((categoryIdx[cat] + dir) % hits.length + hits.length) % hits.length;
  const el = hits[categoryIdx[cat]];
  if (!el) return;
  el.classList.add(cat === 'pii' ? 'pii-active' : 'cat-active');
  el.scrollIntoView({block:'center'});
  document.getElementById('cnb-label').textContent = CAT_LABELS[cat] || cat;
  document.getElementById('cnb-count').textContent = (categoryIdx[cat]+1)+' of '+hits.length;
  document.getElementById('cat-nav-bar').classList.add('active');
}

function clearCategoryNav() {
  const cat = activeCategory;
  const hits = cat && categoryHits[cat];
  const el = hits && hits[categoryIdx[cat]];
  if (el) el.classList.remove('cat-active', 'pii-active');
  activeCategory = null;
  document.getElementById('cat-nav-bar').classList.remove('active');
}

function nextPii() { selectCategory('pii'); }

// Jump straight to the hit nearest target.ts within target.cat — used by
// the Security page's row click, which only has a bare event ts to correlate
// against (no shared id between an AuditEntry row and a specific message).
function jumpToTarget(target) {
  if (!target || !target.cat) return;
  const hits = categoryHits[target.cat];
  if (!hits || !hits.length) return;
  activeCategory = target.cat;
  if (!target.ts) { categoryIdx[target.cat] = -1; advanceCategory(1); return; }
  const targetMs = new Date(target.ts).getTime();
  let bestIdx = 0, bestDelta = Infinity;
  hits.forEach((el, i) => {
    const elTs = el.dataset ? el.dataset.ts : null;
    if (!elTs) return;
    const delta = Math.abs(new Date(elTs).getTime() - targetMs);
    if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
  });
  const prev = hits[categoryIdx[target.cat]];
  if (prev) prev.classList.remove('cat-active', 'pii-active');
  categoryIdx[target.cat] = bestIdx;
  const el = hits[bestIdx];
  el.classList.add(target.cat === 'pii' ? 'pii-active' : 'cat-active');
  el.scrollIntoView({block:'center'});
  document.getElementById('cnb-label').textContent = CAT_LABELS[target.cat] || target.cat;
  document.getElementById('cnb-count').textContent = (bestIdx+1)+' of '+hits.length;
  document.getElementById('cat-nav-bar').classList.add('active');
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

// ── Security dashboard ─────────────────────────────────────────────────────

let _secDashTab = 'events';
let _secStats = null;
let _secEvents = [];

async function loadSecurityDashboard() {
  const qs = new URLSearchParams();
  const dateFrom = document.getElementById('date-from')?.value;
  const dateTo = document.getElementById('date-to')?.value;
  if (dateFrom) qs.set('start', dateFrom);
  if (dateTo) qs.set('end', dateTo);
  const [statsRes, eventsRes] = await Promise.all([
    fetch('/api/security/stats?' + qs),
    fetch('/api/security/events?limit=500&' + qs),
  ]);
  _secStats = await statsRes.json();
  const evData = await eventsRes.json();
  _secEvents = evData.events || [];
  secEventsBySession = {};
  for (const ev of _secEvents) {
    if (!secEventsBySession[ev.sessionId]) secEventsBySession[ev.sessionId] = { blockCount:0, askCount:0 };
    if (ev.decision === 'block') secEventsBySession[ev.sessionId].blockCount++;
    else if (ev.decision === 'ask') secEventsBySession[ev.sessionId].askCount++;
  }
  renderSecurityDashboard(_secStats, _secEvents);
}

function renderSecurityDashboard(stats, events) {
  const blocked = stats.byDecision?.block ?? 0;
  const asked = stats.byDecision?.ask ?? 0;
  const allowed = stats.byDecision?.allow ?? 0;
  const totalProxy = Object.values(stats.proxyFindingsBySeverity||{}).reduce((a,b)=>a+b,0);
  const topAtlas = Object.entries(stats.byAtlasTechnique||{}).sort((a,b)=>b[1]-a[1])[0];

  const cards = [
    ['sv', stats.totalAuditEvents ?? 0, 'Audit Events'],
    ['sv red', blocked, 'Blocked'],
    ['sv amber', asked, 'Flagged'],
    ['sv green', allowed, 'Allowed'],
    ['sv', stats.uniqueSessionsWithEvents ?? 0, 'Sessions'],
    ['sv', totalProxy, 'Proxy Findings'],
    topAtlas ? ['sv', topAtlas[1], 'Top: '+topAtlas[0]] : null,
  ].filter(Boolean).map(([cls, val, label]) =>
    '<div class="sec-stat-card"><div class="'+cls+'">'+val+'</div><div class="sl">'+esc(label)+'</div></div>'
  ).join('');

  const subtabs = SEC_SUBTABS.map(t =>
    '<button class="'+(t===_secDashTab?'active':'')+'" onclick="secSubTab(\\\''+t+'\\\')">'+esc(SEC_SUBTAB_LABELS[t])+'</button>'
  ).join('');

  document.getElementById('thread').innerHTML =
    '<div class="sec-stats-grid">'+cards+'</div>'+
    '<div class="sec-subtabs">'+subtabs+'</div>'+
    '<div class="sec-body" id="sec-body">'+renderSecSubTab(_secDashTab, stats, events)+'</div>';
}

function secSubTab(tab) {
  _secDashTab = tab;
  const bodyEl = document.getElementById('sec-body');
  if (!bodyEl) return;
  document.querySelectorAll('.sec-subtabs button').forEach(b =>
    b.classList.toggle('active', b.textContent === SEC_SUBTAB_LABELS[tab])
  );
  bodyEl.innerHTML = renderSecSubTab(tab, _secStats, _secEvents);
}

const SEC_SUBTABS = ['events','atlas','owasp','proxy','secrets'];
const SEC_SUBTAB_LABELS = {
  events: 'All Events',
  atlas: 'By ATLAS',
  owasp: 'By OWASP',
  proxy: 'Proxy Findings',
  secrets: 'Secrets',
};

function renderSecSubTab(tab, stats, events) {
  if (tab === 'atlas') return renderAtlasBreakdown(stats);
  if (tab === 'owasp') return renderOwaspBreakdown(stats);
  if (tab === 'proxy') return renderProxyBreakdown(stats);
  if (tab === 'secrets') return renderSecretsBreakdown(stats);
  return renderEventsTable(events);
}

function renderEventsTable(events) {
  if (!events || !events.length) return '<div style="color:var(--text3);padding:20px">No security events in this date range.</div>';
  const rows = events.map(ev => {
    const decCls = ev.decision === 'block' ? 'dec-block' : ev.decision === 'ask' ? 'dec-ask' : 'dec-allow';
    const matchBadges = (ev.matches||[]).map(m => renderMatchTypeBadge(m.type)).join('');
    const atlasBadges = (ev.atlasTechniques||[]).map(t => renderAtlasBadge(t.id)).join(' ');
    const owaspBadges = (ev.owaspCategories||[]).map(c => renderOwaspBadge(c.id)).join(' ');
    const sid = ev.sessionId ? ev.sessionId.slice(0,8) : '—';
    return '<tr>'+
      '<td style="white-space:nowrap;color:var(--text3);font-size:11px">'+esc(fmtTime(ev.ts))+'</td>'+
      '<td><span class="session-link" onclick="switchToSession(\\\''+esc(ev.sessionId)+'\\\', {cat:\\\'findings\\\', ts:\\\''+esc(ev.ts)+'\\\'})">'+esc(sid)+'…</span></td>'+
      '<td style="font-size:11px;color:var(--text3)">'+esc(ev.hookEvent||'')+'</td>'+
      '<td style="font-family:monospace;font-size:11px">'+esc(ev.toolName||'—')+'</td>'+
      '<td><span class="'+decCls+'">'+esc(ev.decision)+'</span></td>'+
      '<td>'+matchBadges+'</td>'+
      '<td>'+atlasBadges+'</td>'+
      '<td>'+owaspBadges+'</td>'+
      '</tr>';
  }).join('');
  return '<table class="sec-table"><thead><tr>'+
    '<th>Time</th><th>Session</th><th>Hook</th><th>Tool</th><th>Decision</th><th>Match Types</th><th>ATLAS</th><th>OWASP</th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderAtlasBreakdown(stats) {
  const entries = Object.entries(stats?.byAtlasTechnique||{}).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return '<div style="color:var(--text3);padding:20px">No ATLAS technique mappings found.</div>';
  const max = entries[0][1];
  return '<div style="padding-top:10px">'+entries.map(([tid, count]) => {
    const name = ATLAS_NAMES_CLIENT[tid] || tid;
    const pct = Math.round((count/max)*100);
    return '<div class="sec-atlas-row">'+
      renderAtlasBadge(tid)+
      '<span style="font-size:12px;color:var(--text2)">'+esc(name)+'</span>'+
      '<div class="sec-atlas-bar" style="width:'+pct+'px"></div>'+
      '<span class="sec-atlas-count">'+count+'</span>'+
      '</div>';
  }).join('')+'</div>';
}

function renderOwaspBreakdown(stats) {
  const entries = Object.entries(stats?.byOwaspCategory||{}).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return '<div style="color:var(--text3);padding:20px">No OWASP category mappings found.</div>';
  const max = entries[0][1];
  return '<div style="padding-top:10px">'+entries.map(([cid, count]) => {
    const name = OWASP_NAMES_CLIENT[cid] || cid;
    const pct = Math.round((count/max)*100);
    return '<div class="sec-atlas-row">'+
      renderOwaspBadge(cid)+
      '<span style="font-size:12px;color:var(--text2)">'+esc(name)+'</span>'+
      '<div class="sec-atlas-bar" style="width:'+pct+'px"></div>'+
      '<span class="sec-atlas-count">'+count+'</span>'+
      '</div>';
  }).join('')+'</div>';
}

function renderSecretsBreakdown(stats) {
  const s = stats?.secrets || { blocked: 0, tokenizedInFlight: 0, piiNoise: 0, recentBlocked: [] };
  const cards = [
    ['sv red', s.blocked, 'Secrets Blocked'],
    ['sv green', s.tokenizedInFlight, 'Tokenized In-Flight'],
    ['sv amber', s.piiNoise, 'PII Noise'],
  ].map(([cls, val, label]) =>
    '<div class="sec-stat-card"><div class="'+cls+'">'+val+'</div><div class="sl">'+esc(label)+'</div></div>'
  ).join('');

  const rows = (s.recentBlocked||[]).map(ev => {
    const sid = ev.sessionId ? ev.sessionId.slice(0,8) : '—';
    return '<tr>'+
      '<td style="white-space:nowrap;color:var(--text3);font-size:11px">'+esc(fmtTime(ev.ts))+'</td>'+
      '<td><span class="session-link" onclick="switchToSession(\\\''+esc(ev.sessionId)+'\\\', {cat:\\\'secrets\\\', ts:\\\''+esc(ev.ts)+'\\\'})">'+esc(sid)+'…</span></td>'+
      '<td>'+renderMatchTypeBadge(ev.scannerId)+'</td>'+
      '</tr>';
  }).join('');

  const table = rows
    ? '<table class="sec-table"><thead><tr><th>Time</th><th>Session</th><th>Scanner</th></tr></thead><tbody>'+rows+'</tbody></table>'
    : '<div style="color:var(--text3);padding:20px">No blocked secrets in this date range.</div>';

  return '<div class="sec-stats-grid" style="padding:10px 0">'+cards+'</div>'+table;
}

function renderProxyBreakdown(stats) {
  const entries = Object.entries(stats?.proxyFindingsByScanner||{}).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return '<div style="color:var(--text3);padding:20px">No proxy security findings in this date range.</div>';
  return '<div style="padding-top:10px">'+entries.map(([scanner, count]) => {
    const sev = (stats.proxyFindingsBySeverity || {});
    return '<div class="sec-proxy-row">'+
      '<span class="sec-proxy-scanner">'+esc(scanner)+'</span>'+
      '<span class="sec-proxy-count">×'+count+'</span>'+
      '</div>';
  }).join('')+'</div>';
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


initDateRange();
loadSessions();
setInterval(() => { if (activeView !== 'security') loadSessions(); }, 30000);
</script>
</body>
</html>`;

// ── Router ─────────────────────────────────────────────────────────────────

{
  const warmStart = performance.now();
  const proxyCount = readProxyEntries().length;
  const auditCount = readAuditEntries().length;
  const elapsedMs = Math.round(performance.now() - warmStart);
  console.log(`[logCache] pre-warm: ${proxyCount} proxy entries, ${auditCount} audit entries in ${elapsedMs}ms`);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const source = (url.searchParams.get("source") ?? "unified") as Source;
    const startTs = url.searchParams.get("start") ?? undefined;
    const endTs = url.searchParams.get("end") ?? undefined;

    if (url.pathname === "/api/sessions") {
      return handleSessions(source, url.searchParams.get("user") ?? undefined, startTs, endTs, url.searchParams.get("project") ?? undefined);
    }
    if (url.pathname.startsWith("/api/sessions/")) {
      return handleSession(decodeURIComponent(url.pathname.slice(14)), source, startTs, endTs);
    }
    if (url.pathname === "/api/security/stats") {
      return handleSecurityStats(startTs, endTs);
    }
    if (url.pathname === "/api/security/events") {
      const limit = parseInt(url.searchParams.get("limit") ?? "500");
      return handleSecurityEvents(startTs, endTs, url.searchParams.get("session_id") ?? undefined, url.searchParams.get("decision") ?? undefined, limit);
    }
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[conv-viewer] listening on http://localhost:${PORT} (Loki: ${LOKI_URL}, lookback: ${LOOKBACK_DAYS}d)`);
