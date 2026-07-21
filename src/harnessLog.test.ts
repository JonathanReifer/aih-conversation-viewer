import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HARNESS_LOG_PATH is read at import time by harnessLog.ts — point it at a
// temp file before importing.
const root = mkdtempSync(join(tmpdir(), "harnesslog-test-"));
const LOG = join(root, "harness.jsonl");
process.env.HARNESS_LOG_PATH = LOG;

const { readHarnessEntries, buildHarnessSessions, hydrateRecord } = await import("./harnessLog.js");

const S = "aaaa1111-2222-3333-4444-555555555555";
const NOW = new Date().toISOString();
const ts = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();

function rec(o: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, harness: "claude-code", sessionId: S, ...o }) + "\n";
}

function writeFixture(lines: string[]) {
  writeFileSync(LOG, lines.join(""), "utf8");
}

const FIXTURE = [
  rec({ kind: "session_meta", ts: ts(0), project: "demo" }),
  rec({ kind: "node", ts: ts(1), uuid: "u1", parentUuid: null, role: "user", redactedText: "X".repeat(10_000) }),
  rec({ kind: "node", ts: ts(2), uuid: "a1", parentUuid: "u1", role: "assistant", model: "claude-sonnet-5", usage: { in: 100, out: 40, cacheRead: 5 }, redactedText: "Y".repeat(10_000), redactedThinking: "Z".repeat(10_000) }),
  rec({ kind: "tool_call", ts: ts(2), toolUseId: "toolu_1", name: "Agent", callerUuid: "a1", redactedInput: "Q".repeat(4000) }),
  rec({ kind: "tool_result", ts: ts(3), toolUseId: "toolu_1", callerUuid: "u2", success: true, sizeBytes: 12345, redactedPreview: "R".repeat(2000) }),
  rec({ kind: "agent_spawn", ts: ts(2), agentId: "agent-x1", agentType: "Explore", spawnDepth: 1, parentToolUseId: "toolu_1" }),
  rec({ kind: "node", ts: ts(3), uuid: "sx1", parentUuid: null, role: "user", agentId: "agent-x1", redactedText: "sub" }),
  rec({ kind: "node", ts: ts(4), uuid: "sx2", parentUuid: "sx1", role: "assistant", agentId: "agent-x1", usage: { in: 30, out: 10, cacheRead: 0 } }),
  rec({ kind: "agent_complete", ts: ts(4), agentId: "agent-x1", endTs: ts(4), nodeCount: 2, totalUsage: { in: 30, out: 10, cacheRead: 0 } }),
  rec({ kind: "node", ts: ts(5), uuid: "u2", parentUuid: "a1", role: "user", findings: [{ type: "pii_email", severity: "warn", token: "tok_abc" }] }),
  // Duplicate re-emissions (crash-recovery re-mirror) — must dedup.
  rec({ kind: "node", ts: ts(1), uuid: "u1", parentUuid: null, role: "user", redactedText: "dup" }),
  rec({ kind: "tool_call", ts: ts(2), toolUseId: "toolu_1", name: "Agent", callerUuid: "a1" }),
];

beforeEach(() => writeFixture(FIXTURE));
afterEach(() => rmSync(LOG, { force: true }));

describe("buildHarnessSessions", () => {
  it("assembles session with dedup, agent tree, and spine-edge resolution", () => {
    const sessions = buildHarnessSessions(readHarnessEntries());
    expect(sessions.length).toBe(1);
    const s = sessions[0];
    expect(s.id).toBe(S);
    expect(s.project).toBe("demo");
    expect(s.model).toBe("claude-sonnet-5");
    // Main-thread nodes: u1, a1, u2 (duplicates collapsed; agent nodes excluded).
    expect(s.nodeCount).toBe(3);
    expect(s.userTurnCount).toBe(2);
    expect(s.toolCallCount).toBe(1);
    expect(s.toolCounts["Agent"]).toBe(1);
    expect(s.findingsCount).toBe(1);
    // Agent tree with resolved caller.
    expect(s.agents.length).toBe(1);
    const a = s.agents[0];
    expect(a.agentType).toBe("Explore");
    expect(a.parentToolUseId).toBe("toolu_1");
    expect(a.callerUuid).toBe("a1"); // via toolu_1 -> tool_call.callerUuid
    expect(a.nodeCount).toBe(2);
    expect(a.usageIn).toBe(30);
  });
});

describe("memory guardrail — index tier only", () => {
  it("index entries hold no content strings and stay under 300B avg", () => {
    const entries = readHarnessEntries();
    const serialized = entries.map((e) => JSON.stringify(e));
    for (const s of serialized) {
      expect(s.includes("XXXX")).toBe(false); // redactedText
      expect(s.includes("ZZZZ")).toBe(false); // redactedThinking
      expect(s.includes("QQQQ")).toBe(false); // redactedInput
      expect(s.includes("RRRR")).toBe(false); // redactedPreview
    }
    const avg = serialized.reduce((n, s) => n + s.length, 0) / serialized.length;
    expect(avg).toBeLessThan(300);
  });
});

describe("hydration", () => {
  it("hydrates the full record on demand by byte ref", () => {
    const sessions = buildHarnessSessions(readHarnessEntries());
    const ref = sessions[0].nodeRefs.get("a1")!;
    const full = hydrateRecord(ref);
    expect(full).not.toBeNull();
    expect((full!.redactedText as string).length).toBe(10_000);
    expect((full!.redactedThinking as string).length).toBe(10_000);
  });

  it("returns null on a mismatched (rotated) ref", () => {
    const sessions = buildHarnessSessions(readHarnessEntries());
    const ref = { ...sessions[0].nodeRefs.get("a1")! };
    ref.byteOffset = 0; // points at session_meta now
    expect(hydrateRecord(ref)).toBeNull();
  });
});

describe("LOOKBACK pruning", () => {
  it("drops entries older than the lookback window", () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    writeFixture([
      rec({ kind: "node", ts: old, uuid: "ancient", parentUuid: null, role: "user" }),
      rec({ kind: "node", ts: NOW, uuid: "fresh", parentUuid: null, role: "user" }),
    ]);
    const entries = readHarnessEntries();
    expect(entries.some((e) => e.uuid === "ancient")).toBe(false);
    expect(entries.some((e) => e.uuid === "fresh")).toBe(true);
  });
});
