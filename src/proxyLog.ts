import { createJsonlTailCache, readExactBytes } from "./logCache.js";
import { lookupProject } from "./project.js";

export const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? "30");
export const LOG_PATH = process.env.LOG_PATH ?? `${process.env.HOME}/.llm-privacy/prompts.jsonl`;

export type ProxyLogFinding = {
  scannerId: string;
  description: string;
  severity: "block" | "warn" | "info";
  atlasTechnique?: string;
  owaspCategory?: string;
};

// Shape of a raw JSONL line on disk. Only ever materialized transiently —
// during ingest (to build the index entry) or during on-demand hydration
// (to extract `tokenized` for one requested session) — never held resident.
type ProxyLogEntryRaw = {
  ts: string;
  sessionId: string;
  matchCount: number;
  tokenized: string[];
  model?: string;
  decision?: "allow" | "ask" | "block";
  findings?: ProxyLogFinding[];
};

export type ContentBlock = { type: string; [key: string]: unknown };
export type MessageContent = string | ContentBlock[];

export type ProxyMessage = {
  role: "user" | "assistant";
  content: MessageContent;
};

// Index-tier entry: everything list/stats views need, without `tokenized`
// (~87KB avg per line) — the field only the detail endpoint ever reads.
export type ProxyIndexEntry = {
  ts: string;
  sessionId: string;
  matchCount: number;
  model?: string;
  decision?: "allow" | "ask" | "block";
  findings?: ProxyLogFinding[];
  tokenizedLength: number;
  firstPromptFragment: string;
  byteOffset: number;
  byteLength: number;
};

// Reference sufficient to hydrate a session's full messages on demand via
// readExactBytes. ts/sessionId let resolveProxySessionMessages detect a
// rotation race (the byte range no longer refers to the same log line) and
// fail cleanly instead of returning wrong content.
export type ProxyMessagesRef = {
  byteOffset: number;
  byteLength: number;
  ts: string;
  sessionId: string;
};

// A finding attributed to the message range that was newly added between the
// previous log snapshot and the one this finding was raised on — a raw entry
// is a snapshot of the whole conversation so far, not a single new message,
// so "which message triggered this" is a range, collapsing to one message
// when only one was added since the prior entry.
export type ProxySessionFinding = ProxyLogFinding & {
  fromMessageIndex: number;
  toMessageIndex: number;
  ts: string;
};

export type ProxySessionIndex = {
  id: string;
  firstTs: string;
  lastTs: string;
  model: string;
  messageCount: number;
  piiCount: number;
  firstPrompt: string;
  findings?: ProxySessionFinding[];
  securityDecision?: "allow" | "ask" | "block";
  project?: string;
  bestRef: ProxyMessagesRef;
  // Per-entry (ts, tokenizedLength) snapshots, ts-ascending — lets
  // deriveMessageTimestamps label each message with the earliest snapshot
  // that already contained it.
  entryTimestamps: { ts: string; tokenizedLength: number }[];
};

// Labels each message index with the earliest entry snapshot that already
// contained it ("became visible no later than this ts") — exact per-message
// timestamps don't exist since one log entry snapshots the whole
// conversation at once. Single forward two-pointer walk: both messageCount's
// index and entryTimestamps are monotonic, so `j` never needs to reset.
export function deriveMessageTimestamps(
  entryTimestamps: { ts: string; tokenizedLength: number }[],
  messageCount: number,
  lastTs: string
): string[] {
  const result: string[] = [];
  let j = 0;
  for (let i = 0; i < messageCount; i++) {
    while (j < entryTimestamps.length && entryTimestamps[j].tokenizedLength <= i) j++;
    result.push(j < entryTimestamps.length ? entryTimestamps[j].ts : lastTs);
  }
  return result;
}

export function parseContent(s: string): MessageContent {
  try { return JSON.parse(s) as MessageContent; } catch { return s; }
}

function messagesFromTokenized(tokenized: string[]): ProxyMessage[] {
  const roles: Array<"user" | "assistant"> = ["user", "assistant"];
  return tokenized.map((t, i) => ({ role: roles[i % 2], content: parseContent(t) }));
}

export function extractFirstPrompt(messages: ProxyMessage[]): string {
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

// Bounds steady-state memory as the log grows without limit: entries older
// than LOOKBACK_DAYS are dropped from the in-memory cache (not from disk),
// matching the retention window /api/security/stats already applies to the
// OTEL query path. Trade-off: /api/sessions/:id lookups for sessions older
// than the window will 404 instead of returning stale-but-present data.
export function pruneOlderThan<T extends { ts: string }>(entries: T[]): T[] {
  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;
  return entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
}

const proxyLogCache = createJsonlTailCache<ProxyIndexEntry>(
  (line, byteOffset, byteLength) => {
    let raw: ProxyLogEntryRaw;
    try { raw = JSON.parse(line) as ProxyLogEntryRaw; } catch { return null; }
    const tokenized = raw.tokenized ?? [];
    return {
      ts: raw.ts,
      sessionId: raw.sessionId,
      matchCount: raw.matchCount,
      model: raw.model,
      decision: raw.decision,
      findings: raw.findings,
      tokenizedLength: tokenized.length,
      firstPromptFragment: extractFirstPrompt(messagesFromTokenized(tokenized)),
      byteOffset,
      byteLength,
    };
  },
  undefined,
  pruneOlderThan
);

export function readProxyEntries(): ProxyIndexEntry[] {
  return proxyLogCache.read(LOG_PATH);
}

export function segmentProxySessions(startTs?: string, endTs?: string): ProxySessionIndex[] {
  let entries = readProxyEntries().sort((a, b) => a.ts.localeCompare(b.ts));
  if (startTs) entries = entries.filter(e => e.ts >= startTs);
  if (endTs) entries = entries.filter(e => e.ts <= endTs + 'Z');

  const GAP_MS = 90 * 60 * 1000;
  const groups: ProxyIndexEntry[][] = [];
  let current: ProxyIndexEntry[] = [];

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

  return groups.map((group): ProxySessionIndex => {
    const best = group.reduce((a, b) => a.tokenizedLength >= b.tokenizedLength ? a : b);
    const sorted = [...group].sort((a, b) => a.ts.localeCompare(b.ts));
    const entryTimestamps = sorted.map(e => ({ ts: e.ts, tokenizedLength: e.tokenizedLength }));

    // Each entry is a snapshot of the whole conversation so far; attribute
    // its findings to whatever message range is newly added since the prior
    // entry's snapshot (prevLength..tokenizedLength-1), not to the whole group.
    let prevLength = 0;
    const allFindings: ProxySessionFinding[] = [];
    for (const e of sorted) {
      const from = prevLength;
      const to = Math.max(from, e.tokenizedLength - 1);
      if (e.findings) {
        for (const f of e.findings) allFindings.push({ ...f, fromMessageIndex: from, toMessageIndex: to, ts: e.ts });
      }
      prevLength = e.tokenizedLength;
    }

    const worstDecision = group.reduce((worst: "allow" | "ask" | "block", e) => {
      if (e.decision === "block" || worst === "block") return "block";
      if (e.decision === "ask" || worst === "ask") return "ask";
      return worst;
    }, "allow");
    return {
      id: sorted[0].ts,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      model: best.model ?? "unknown",
      messageCount: best.tokenizedLength,
      piiCount: group.reduce((n, e) => n + e.matchCount, 0),
      firstPrompt: best.firstPromptFragment,
      entryTimestamps,
      ...(allFindings.length > 0 ? { findings: allFindings, securityDecision: worstDecision } : {}),
      project: lookupProject(sorted[0].sessionId),
      bestRef: { byteOffset: best.byteOffset, byteLength: best.byteLength, ts: best.ts, sessionId: best.sessionId },
    };
  }).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// Hydrates one session's full messages on demand via a seek into LOG_PATH.
// Since segmentProxySessions already picks one "best" entry per session
// group, this is one seek per session detail request, not one per group
// member. Returns null (never throws) on I/O failure or on a rotation race
// (the byte range no longer identifies the same log line) — callers must
// treat null as "can't serve this," not as empty content.
export function resolveProxySessionMessages(ref: ProxyMessagesRef): ProxyMessage[] | null {
  const buf = readExactBytes(LOG_PATH, ref.byteOffset, ref.byteLength);
  if (!buf) return null;
  let raw: ProxyLogEntryRaw;
  try { raw = JSON.parse(buf.toString("utf8")) as ProxyLogEntryRaw; } catch { return null; }
  if (raw.ts !== ref.ts || raw.sessionId !== ref.sessionId) return null;
  return messagesFromTokenized(raw.tokenized ?? []);
}
