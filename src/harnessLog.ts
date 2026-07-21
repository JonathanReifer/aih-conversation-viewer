// harness.jsonl ingest — the tokenized structural mirror produced by
// aih-privacy-middleware's HarnessMirror (schema:
// aih-security/docs/harness-schema.md). This stream is the viewer's
// correlation SPINE: real session uuids (exact-join to audit.jsonl and OTEL
// session.id), the uuid/parentUuid message DAG, tool call/result linkage, and
// the agent_spawn.parentToolUseId sub-agent tree edges.
//
// Memory discipline mirrors proxyLog.ts exactly: the tail cache holds an
// INDEX TIER ONLY — no redacted text is ever resident. Full records hydrate
// on demand via readExactBytes(byteOffset, byteLength).

import { createJsonlTailCache, readExactBytes } from "./logCache.js";

export const HARNESS_LOG_PATH =
  process.env.HARNESS_LOG_PATH ?? `${process.env.HOME}/.llm-privacy/harness.jsonl`;

// Own copy of the lookback prune (not imported from proxyLog.js): importing
// that module locks ITS module-level LOG_PATH at first-import time, which
// breaks test isolation for any suite that imports this file first.
const HARNESS_LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? "30");
function pruneOldHarness<T extends { ts: string }>(entries: T[]): T[] {
  const cutoff = Date.now() - HARNESS_LOOKBACK_DAYS * 86_400_000;
  return entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
}

// Index-tier record: one per harness.jsonl line, ~150-250 B serialized.
// Content fields (redactedText/redactedInput/redactedPreview/description)
// deliberately NEVER stored here.
export type HarnessIndexEntry = {
  kind: string;
  ts: string;
  sessionId: string;
  agentId?: string;
  project?: string;
  // node
  uuid?: string;
  parentUuid?: string | null;
  role?: string;
  model?: string;
  usageIn?: number;
  usageOut?: number;
  // tool_call / tool_result
  toolUseId?: string;
  name?: string;
  callerUuid?: string;
  success?: boolean;
  sizeBytes?: number;
  // agent_spawn / agent_complete
  agentType?: string;
  spawnDepth?: number;
  parentToolUseId?: string;
  nodeCount?: number;
  // shared
  findingsCount?: number;
  permissionMode?: string;
  byteOffset: number;
  byteLength: number;
};

const harnessCache = createJsonlTailCache<HarnessIndexEntry>(
  (line, byteOffset, byteLength) => {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (raw.v !== 1 || typeof raw.kind !== "string") return null;
    const e: HarnessIndexEntry = {
      kind: raw.kind,
      ts: String(raw.ts ?? ""),
      sessionId: String(raw.sessionId ?? ""),
      byteOffset,
      byteLength,
    };
    if (typeof raw.agentId === "string") e.agentId = raw.agentId;
    if (typeof raw.project === "string") e.project = raw.project;
    if (typeof raw.uuid === "string") e.uuid = raw.uuid;
    if ("parentUuid" in raw) e.parentUuid = raw.parentUuid as string | null;
    if (typeof raw.role === "string") e.role = raw.role;
    if (typeof raw.model === "string") e.model = raw.model;
    const usage = raw.usage as { in?: number; out?: number } | undefined;
    if (usage) {
      e.usageIn = Number(usage.in ?? 0);
      e.usageOut = Number(usage.out ?? 0);
    }
    if (typeof raw.toolUseId === "string") e.toolUseId = raw.toolUseId;
    if (typeof raw.name === "string") e.name = raw.name;
    if (typeof raw.callerUuid === "string") e.callerUuid = raw.callerUuid;
    if (typeof raw.success === "boolean") e.success = raw.success;
    if (typeof raw.sizeBytes === "number") e.sizeBytes = raw.sizeBytes;
    if (typeof raw.agentType === "string") e.agentType = raw.agentType;
    if (typeof raw.spawnDepth === "number") e.spawnDepth = raw.spawnDepth;
    if (typeof raw.parentToolUseId === "string") e.parentToolUseId = raw.parentToolUseId;
    if (typeof raw.nodeCount === "number") e.nodeCount = raw.nodeCount;
    if (Array.isArray(raw.findings) && raw.findings.length > 0)
      e.findingsCount = raw.findings.length;
    if (typeof raw.permissionMode === "string") e.permissionMode = raw.permissionMode;
    return e;
  },
  undefined,
  pruneOldHarness
);

export function readHarnessEntries(): HarnessIndexEntry[] {
  return harnessCache.read(HARNESS_LOG_PATH);
}

// ── Session assembly ────────────────────────────────────────────────────────

export interface HarnessAgent {
  agentId: string;
  agentType: string;
  spawnDepth?: number;
  parentToolUseId?: string;
  // Resolved via parentToolUseId → tool_call.toolUseId → callerUuid: the node
  // in the parent thread that spawned this agent.
  callerUuid?: string;
  firstTs: string;
  lastTs: string;
  nodeCount: number;
  usageIn: number;
  usageOut: number;
}

export interface HarnessSessionIndex {
  id: string; // real session uuid
  project?: string;
  firstTs: string;
  lastTs: string;
  model?: string;
  nodeCount: number; // main-thread nodes
  userTurnCount: number; // main-thread user-role nodes
  toolCallCount: number;
  toolCounts: Record<string, number>;
  agents: HarnessAgent[];
  usageIn: number;
  usageOut: number;
  findingsCount: number;
  compactionCount: number;
  // Refs for hydration, keyed by identity — deduped (first wins for nodes and
  // tool records; last wins for agent_complete).
  nodeRefs: Map<string, HarnessIndexEntry>; // uuid -> entry (all threads)
  toolCallRefs: Map<string, HarnessIndexEntry>; // toolUseId -> tool_call entry
  toolResultRefs: Map<string, HarnessIndexEntry>; // toolUseId -> tool_result entry
}

export function buildHarnessSessions(entries: HarnessIndexEntry[]): HarnessSessionIndex[] {
  const bySession = new Map<string, HarnessIndexEntry[]>();
  for (const e of entries) {
    if (!e.sessionId) continue;
    const arr = bySession.get(e.sessionId) ?? [];
    arr.push(e);
    bySession.set(e.sessionId, arr);
  }

  const out: HarnessSessionIndex[] = [];
  for (const [sessionId, group] of bySession) {
    group.sort((a, b) => a.ts.localeCompare(b.ts));
    const s: HarnessSessionIndex = {
      id: sessionId,
      firstTs: group[0].ts,
      lastTs: group[group.length - 1].ts,
      nodeCount: 0,
      userTurnCount: 0,
      toolCallCount: 0,
      toolCounts: {},
      agents: [],
      usageIn: 0,
      usageOut: 0,
      findingsCount: 0,
      compactionCount: 0,
      nodeRefs: new Map(),
      toolCallRefs: new Map(),
      toolResultRefs: new Map(),
    };
    const agentsById = new Map<string, HarnessAgent>();

    for (const e of group) {
      if (e.project && !s.project) s.project = e.project;
      if (e.findingsCount) s.findingsCount += e.findingsCount;

      if (e.kind === "node" && e.uuid) {
        if (s.nodeRefs.has(e.uuid)) continue; // dedup: first wins
        s.nodeRefs.set(e.uuid, e);
        if (e.model && !s.model) s.model = e.model;
        s.usageIn += e.usageIn ?? 0;
        s.usageOut += e.usageOut ?? 0;
        if (!e.agentId) {
          s.nodeCount++;
          if (e.role === "user") s.userTurnCount++;
        } else {
          const a = agentsById.get(e.agentId);
          if (a) {
            a.nodeCount++;
            a.usageIn += e.usageIn ?? 0;
            a.usageOut += e.usageOut ?? 0;
            if (e.ts > a.lastTs) a.lastTs = e.ts;
            if (e.ts < a.firstTs || a.firstTs === "") a.firstTs = e.ts;
          }
        }
      } else if (e.kind === "tool_call" && e.toolUseId) {
        if (s.toolCallRefs.has(e.toolUseId)) continue;
        s.toolCallRefs.set(e.toolUseId, e);
        s.toolCallCount++;
        const n = e.name ?? "unknown";
        s.toolCounts[n] = (s.toolCounts[n] ?? 0) + 1;
      } else if (e.kind === "tool_result" && e.toolUseId) {
        if (!s.toolResultRefs.has(e.toolUseId)) s.toolResultRefs.set(e.toolUseId, e);
      } else if (e.kind === "agent_spawn" && e.agentId) {
        if (!agentsById.has(e.agentId)) {
          agentsById.set(e.agentId, {
            agentId: e.agentId,
            agentType: e.agentType ?? "unknown",
            ...(e.spawnDepth !== undefined ? { spawnDepth: e.spawnDepth } : {}),
            ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}),
            firstTs: e.ts,
            lastTs: e.ts,
            nodeCount: 0,
            usageIn: 0,
            usageOut: 0,
          });
        }
      } else if (e.kind === "compaction") {
        s.compactionCount++;
      }
    }

    // Resolve each agent's spawning node via the spine edge.
    for (const a of agentsById.values()) {
      if (a.parentToolUseId) {
        const call = s.toolCallRefs.get(a.parentToolUseId);
        if (call?.callerUuid) a.callerUuid = call.callerUuid;
      }
    }
    s.agents = [...agentsById.values()].sort((a, b) => a.firstTs.localeCompare(b.firstTs));
    out.push(s);
  }
  return out.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// ── Hydration (detail tier) ─────────────────────────────────────────────────

// Hydrate one full record from disk by its index ref. Returns null on I/O
// failure or rotation race — callers treat null as "can't serve".
export function hydrateRecord(ref: HarnessIndexEntry): Record<string, unknown> | null {
  const buf = readExactBytes(HARNESS_LOG_PATH, ref.byteOffset, ref.byteLength);
  if (!buf) return null;
  try {
    const rec = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    if (rec.sessionId !== ref.sessionId || rec.kind !== ref.kind) return null;
    return rec;
  } catch {
    return null;
  }
}
