import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// proxyLogCache is a module-level singleton bound to LOG_PATH at import
// time (matching server.ts's own production usage), so LOG_PATH must be set
// before the first import — a top-level await + dynamic import lets us do
// that from within a test file's own module scope.
const dir = mkdtempSync(join(tmpdir(), "proxylog-test-"));
const logPath = join(dir, "prompts.jsonl");
process.env.LOG_PATH = logPath;
process.env.LOOKBACK_DAYS = "36500"; // effectively disable date-based pruning for these tests

const { segmentProxySessions, resolveProxySessionMessages, readProxyEntries, deriveMessageTimestamps } = await import("./proxyLog.js");

type RawEntry = {
  ts: string;
  sessionId: string;
  matchCount: number;
  tokenized: string[];
  model?: string;
  decision?: "allow" | "ask" | "block";
  findings?: { scannerId: string; description: string; severity: "block" | "warn" | "info" }[];
};

let swapCount = 0;

// Rewrites the shared LOG_PATH via rename-swap (new inode), which the
// underlying tail cache detects and resets from — the same mechanism
// logCache.test.ts's ISC-7 rotation test relies on. This gives each test a
// clean slate despite the singleton cache.
function swapFixture(entries: RawEntry[]): void {
  const tmp = join(dir, `fixture-${swapCount++}.jsonl`);
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  renameSync(tmp, logPath);
}

afterEach(() => {
  // no per-test cleanup needed beyond the shared dir removed at process exit
});

describe("proxyLog: index tier never carries tokenized content", () => {
  test("ProxyIndexEntry omits tokenized entirely", () => {
    swapFixture([
      { ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", matchCount: 0, tokenized: ["hello", "world", "more content"] },
    ]);
    const entries = readProxyEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("tokenized");
    expect(entries[0].tokenizedLength).toBe(3);
  });

  test("ProxySessionIndex omits messages/tokenized, carries only a bestRef pointer", () => {
    swapFixture([
      { ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", matchCount: 2, tokenized: ["hi", "there"] },
    ]);
    const sessions = segmentProxySessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty("messages");
    expect(sessions[0]).not.toHaveProperty("tokenized");
    expect(sessions[0].bestRef).toEqual({
      byteOffset: expect.any(Number),
      byteLength: expect.any(Number),
      ts: "2026-06-01T00:00:00.000Z",
      sessionId: "s1",
    });
  });
});

describe("proxyLog: golden-diff — index + hydrate reproduces the pre-split behavior", () => {
  test("single-entry session: index metadata and hydrated messages match the raw fixture", () => {
    swapFixture([
      {
        ts: "2026-06-01T00:00:00.000Z",
        sessionId: "s1",
        matchCount: 3,
        model: "claude-sonnet-5",
        decision: "allow",
        tokenized: ["<p>first user prompt</p>", '{"type":"assistant reply"}'],
      },
    ]);
    const sessions = segmentProxySessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe("s1");
    expect(s.model).toBe("claude-sonnet-5");
    expect(s.messageCount).toBe(2);
    // piiCount/secretsCount are derived from classifyFinding(scannerId), not
    // matchCount -- this fixture has no findings array at all, so both are 0.
    expect(s.piiCount).toBe(0);
    expect(s.secretsCount).toBe(0);
    expect(s.firstPrompt).toBe("first user prompt");
    expect(s.securityDecision).toBeUndefined();

    const messages = resolveProxySessionMessages(s.bestRef);
    expect(messages).not.toBeNull();
    expect(messages).toEqual([
      { role: "user", content: "<p>first user prompt</p>" },
      { role: "assistant", content: { type: "assistant reply" } },
    ]);

    expect(s.entryTimestamps).toEqual([
      { ts: "2026-06-01T00:00:00.000Z", tokenizedLength: 2 },
    ]);
  });

  test("multi-entry session (within gap window): groups, picks longest as bestRef, classifies findings by category, worst-cases decision", () => {
    const base = new Date("2026-06-01T10:00:00.000Z").getTime();
    swapFixture([
      {
        ts: new Date(base).toISOString(),
        sessionId: "s1",
        matchCount: 1,
        decision: "allow",
        tokenized: ["short turn 1", "short reply 1"],
      },
      {
        ts: new Date(base + 5 * 60_000).toISOString(),
        sessionId: "s1",
        matchCount: 2,
        decision: "block",
        findings: [{ scannerId: "privacy/api_key_github", description: "found an api key", severity: "block" }],
        model: "claude-opus-4-8",
        tokenized: ["longer turn 2 with more content", "longer reply 2 with more content", "third turn", "third reply"],
      },
    ]);
    const sessions = segmentProxySessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Grouped as one session (5min < 90min gap).
    expect(s.firstTs).toBe(new Date(base).toISOString());
    expect(s.lastTs).toBe(new Date(base + 5 * 60_000).toISOString());
    // "best" = longest tokenized array -> the second entry.
    expect(s.messageCount).toBe(4);
    expect(s.model).toBe("claude-opus-4-8");
    // piiCount/secretsCount come from classifyFinding(scannerId), not matchCount --
    // "privacy/api_key_github" classifies as "secrets", not "pii".
    expect(s.piiCount).toBe(0);
    expect(s.secretsCount).toBe(1);
    expect(s.securityDecision).toBe("block");
    expect(s.findings).toHaveLength(1);
    // The finding was raised on the second entry (tokenizedLength 4), whose
    // snapshot added messages 2-3 over the first entry's snapshot (length 2).
    expect(s.findings![0].fromMessageIndex).toBe(2);
    expect(s.findings![0].toMessageIndex).toBe(3);
    expect(s.findings![0].ts).toBe(new Date(base + 5 * 60_000).toISOString());
    expect(s.findings![0].category).toBe("secrets");

    expect(s.entryTimestamps).toEqual([
      { ts: new Date(base).toISOString(), tokenizedLength: 2 },
      { ts: new Date(base + 5 * 60_000).toISOString(), tokenizedLength: 4 },
    ]);

    const messages = resolveProxySessionMessages(s.bestRef);
    expect(messages).toHaveLength(4);
    expect(messages![0]).toEqual({ role: "user", content: "longer turn 2 with more content" });
  });

  test("entries with different sessionIds always split, even close together in time", () => {
    const base = new Date("2026-06-01T10:00:00.000Z").getTime();
    swapFixture([
      { ts: new Date(base).toISOString(), sessionId: "s1", matchCount: 0, tokenized: ["a", "b"] },
      { ts: new Date(base + 5 * 60_000).toISOString(), sessionId: "s2", matchCount: 0, tokenized: ["c", "d"] },
    ]);
    const sessions = segmentProxySessions();
    expect(sessions).toHaveLength(2);
    // Sorted lastTs-descending: sessions[0] is the later session, sessions[1] the earlier one.
    expect(sessions[0].id).toBe("s2");
    expect(sessions[1].id).toBe("s1");
    expect(sessions[0].entryTimestamps).toEqual([{ ts: new Date(base + 5 * 60_000).toISOString(), tokenizedLength: 2 }]);
    expect(sessions[1].entryTimestamps).toEqual([{ ts: new Date(base).toISOString(), tokenizedLength: 2 }]);
  });

  test("entries sharing a sessionId group together even beyond the old 90-minute gap window", () => {
    const base = new Date("2026-06-01T10:00:00.000Z").getTime();
    swapFixture([
      { ts: new Date(base).toISOString(), sessionId: "s1", matchCount: 0, tokenized: ["a", "b"] },
      { ts: new Date(base + 100 * 60_000).toISOString(), sessionId: "s1", matchCount: 0, tokenized: ["c", "d"] },
    ]);
    const sessions = segmentProxySessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1");
    expect(sessions[0].entryTimestamps).toEqual([
      { ts: new Date(base).toISOString(), tokenizedLength: 2 },
      { ts: new Date(base + 100 * 60_000).toISOString(), tokenizedLength: 2 },
    ]);
  });

  test("entries missing sessionId (legacy log lines) fall back to grouping by their own ts", () => {
    const base = new Date("2026-06-01T10:00:00.000Z").getTime();
    swapFixture([
      { ts: new Date(base).toISOString(), sessionId: "", matchCount: 0, tokenized: ["a"] },
      { ts: new Date(base + 60_000).toISOString(), sessionId: "", matchCount: 0, tokenized: ["b"] },
    ]);
    const sessions = segmentProxySessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(new Date(base + 60_000).toISOString());
    expect(sessions[1].id).toBe(new Date(base).toISOString());
  });

  test("startTs/endTs filtering narrows the index-only pass the same way it did the old single-pass one", () => {
    swapFixture([
      { ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", matchCount: 0, tokenized: ["a"] },
      { ts: "2026-06-02T00:00:00.000Z", sessionId: "s2", matchCount: 0, tokenized: ["b"] },
      { ts: "2026-06-03T00:00:00.000Z", sessionId: "s3", matchCount: 0, tokenized: ["c"] },
    ]);
    const sessions = segmentProxySessions("2026-06-02T00:00:00.000Z", "2026-06-02");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s2");
  });
});

describe("proxyLog: hydration failure modes", () => {
  test("resolveProxySessionMessages returns null (not throw) when the file rotates out from under a stale bestRef", () => {
    swapFixture([
      { ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", matchCount: 0, tokenized: ["original longer content here"] },
    ]);
    const sessions = segmentProxySessions();
    const staleRef = sessions[0].bestRef;

    // Rotate: swap in an unrelated, much shorter file.
    swapFixture([{ ts: "2026-06-05T00:00:00.000Z", sessionId: "s2", matchCount: 0, tokenized: ["x"] }]);

    expect(() => resolveProxySessionMessages(staleRef)).not.toThrow();
    expect(resolveProxySessionMessages(staleRef)).toBeNull();
  });

  test("resolveProxySessionMessages returns null when the byte range now belongs to a different ts/sessionId (identity guard)", () => {
    swapFixture([
      { ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", matchCount: 0, tokenized: ["some content of a certain length"] },
    ]);
    const sessions = segmentProxySessions();
    const staleRef = sessions[0].bestRef;

    // Rotate in a same-size-ish file so the byte range might not short-read,
    // but the content at that range is no longer the same log line.
    swapFixture([
      { ts: "2026-06-09T00:00:00.000Z", sessionId: "different-session", matchCount: 0, tokenized: ["some content of a certain length"] },
    ]);

    expect(resolveProxySessionMessages(staleRef)).toBeNull();
  });

  test("session not found by segmentProxySessions after a genuine rotation simply isn't in the list (caller 404s upstream)", () => {
    swapFixture([{ ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", matchCount: 0, tokenized: ["a"] }]);
    swapFixture([{ ts: "2026-06-05T00:00:00.000Z", sessionId: "s2", matchCount: 0, tokenized: ["b"] }]);
    const sessions = segmentProxySessions();
    expect(sessions.find((s) => s.id === "s1")).toBeUndefined();
  });
});

describe("deriveMessageTimestamps", () => {
  test("labels each message with the earliest entry snapshot that already contained it", () => {
    const entryTimestamps = [
      { ts: "2026-06-01T00:00:00.000Z", tokenizedLength: 2 },
      { ts: "2026-06-01T00:05:00.000Z", tokenizedLength: 4 },
    ];
    const result = deriveMessageTimestamps(entryTimestamps, 4, "2026-06-01T00:05:00.000Z");
    expect(result).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:05:00.000Z",
      "2026-06-01T00:05:00.000Z",
    ]);
  });

  test("falls back to lastTs when messageCount exceeds every recorded snapshot", () => {
    const entryTimestamps = [{ ts: "2026-06-01T00:00:00.000Z", tokenizedLength: 2 }];
    const result = deriveMessageTimestamps(entryTimestamps, 3, "2026-06-01T00:10:00.000Z");
    expect(result).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:10:00.000Z",
    ]);
  });

  test("empty entryTimestamps falls back to lastTs for every message", () => {
    const result = deriveMessageTimestamps([], 2, "2026-06-01T00:10:00.000Z");
    expect(result).toEqual(["2026-06-01T00:10:00.000Z", "2026-06-01T00:10:00.000Z"]);
  });
});
