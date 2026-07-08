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

// Three disjoint buckets for a ProxyLogFinding, by scannerId:
// - "pii": privacy/pii_* -- a PII pattern got tokenized
// - "secrets": every other privacy/* scannerId except privacy/orphaned-token
//   (api keys, ssh/tls private keys, db connection strings, jwts, npm tokens,
//   etc.) -- a non-PII secret got tokenized
// - "finding": everything else -- genuine detections (ATLAS/OWASP
//   injection/adversarial scanners) plus privacy/orphaned-token (an
//   un-detokenized token leaking into a response, not itself a tokenized-secret
//   pattern match)
export type FindingCategory = "pii" | "secrets" | "finding";

export function classifyFinding(scannerId: string): FindingCategory {
  if (scannerId.startsWith("privacy/pii")) return "pii";
  if (scannerId.startsWith("privacy/") && scannerId !== "privacy/orphaned-token") return "secrets";
  return "finding";
}

// Same pii/secrets split as classifyFinding, but for the audit.jsonl data
// source (aih-privacy-middleware's hook-based match records), which carries
// bare PatternType strings (e.g. "api_key_github", "ssh_private_key",
// "pii_email") with no "privacy/" scannerId prefix and no genuine-finding
// types mixed in -- so it's a two-way split, not three-way.
export function classifyPatternType(type: string): "pii" | "secrets" {
  return type.startsWith("pii_") ? "pii" : "secrets";
}

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
  category: FindingCategory;
  // How many raw per-request finding rows collapsed into this one. The proxy
  // re-scans the whole cumulative snapshot on every request, so a single PII
  // value re-reports on every subsequent request; without dedup a session
  // shows thousands of identical findings.
  occurrences: number;
};

export type ProxySessionIndex = {
  id: string;
  firstTs: string;
  lastTs: string;
  model: string;
  messageCount: number;
  piiCount: number;
  secretsCount: number;
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

  // Group by sessionId rather than a time-gap heuristic -- ProxyLogEntry
  // already carries the real session identity, and a gap heuristic
  // incorrectly split or merged long/paused sessions. Legacy entries
  // missing sessionId (empty string) fall back to grouping by their own ts.
  const sessionMap = new Map<string, ProxyIndexEntry[]>();
  for (const e of entries) {
    const sid = e.sessionId || e.ts;
    const arr = sessionMap.get(sid) ?? [];
    arr.push(e);
    sessionMap.set(sid, arr);
  }

  return Array.from(sessionMap.entries()).map(([sid, group]): ProxySessionIndex => {
    const best = group.reduce((a, b) => a.tokenizedLength >= b.tokenizedLength ? a : b);
    const sorted = [...group].sort((a, b) => a.ts.localeCompare(b.ts));
    const entryTimestamps = sorted.map(e => ({ ts: e.ts, tokenizedLength: e.tokenizedLength }));

    // Each entry is a snapshot of the whole conversation so far; attribute
    // its findings to whatever message range is newly added since the prior
    // entry's snapshot (prevLength..tokenizedLength-1), not to the whole group.
    // Only `best`'s own tokenized array ever gets hydrated into `messages`
    // (see resolveProxySessionMessages), so every range must be clamped into
    // best's index space -- real traffic isn't always one steadily-growing
    // conversation (many short, independent proxy calls can land in the same
    // session with non-monotonic tokenizedLength), which otherwise
    // produces indices beyond the messages array actually served.
    const maxIdx = Math.max(0, best.tokenizedLength - 1);
    let prevLength = 0;
    // Dedup findings to their distinct identity. A finding carries no
    // per-occurrence value (only scannerId/description/severity), and the proxy
    // re-scans the cumulative snapshot on every request, so the same match
    // re-reports across thousands of entries. Collapse to the first occurrence
    // (kept for jump-to navigation) and count the rest as `occurrences`.
    const findingByKey = new Map<string, ProxySessionFinding>();
    for (const e of sorted) {
      const from = Math.min(prevLength, maxIdx);
      const to = Math.min(Math.max(from, e.tokenizedLength - 1), maxIdx);
      if (e.findings) {
        for (const f of e.findings) {
          const key = `${f.scannerId}|${f.description ?? ""}|${f.severity ?? ""}`;
          const existing = findingByKey.get(key);
          if (existing) {
            existing.occurrences++;
          } else {
            findingByKey.set(key, { ...f, fromMessageIndex: from, toMessageIndex: to, ts: e.ts, category: classifyFinding(f.scannerId), occurrences: 1 });
          }
        }
      }
      prevLength = e.tokenizedLength;
    }
    const allFindings: ProxySessionFinding[] = Array.from(findingByKey.values());
    const piiCount = allFindings.filter(f => f.category === "pii").length;
    const secretsCount = allFindings.filter(f => f.category === "secrets").length;

    const worstDecision = group.reduce((worst: "allow" | "ask" | "block", e) => {
      if (e.decision === "block" || worst === "block") return "block";
      if (e.decision === "ask" || worst === "ask") return "ask";
      return worst;
    }, "allow");
    return {
      id: sid,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      model: best.model ?? "unknown",
      messageCount: best.tokenizedLength,
      piiCount,
      secretsCount,
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
