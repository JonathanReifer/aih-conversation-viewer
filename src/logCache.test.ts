import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJsonlTailCache, readExactBytes } from "./logCache.js";

type Entry = { id: number; name: string };

function parseEntry(line: string): Entry | null {
  try {
    return JSON.parse(line) as Entry;
  } catch {
    return null;
  }
}

type EntryWithOffset = Entry & { byteOffset: number; byteLength: number };

function parseEntryWithOffset(line: string, byteOffset: number, byteLength: number): EntryWithOffset | null {
  try {
    return { ...(JSON.parse(line) as Entry), byteOffset, byteLength };
  } catch {
    return null;
  }
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logcache-test-"));
  file = join(dir, "log.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createJsonlTailCache", () => {
  test("ISC-2: cold read of N valid lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: i, name: `e${i}` }));
    writeFileSync(file, lines.join("\n") + "\n");
    const cache = createJsonlTailCache(parseEntry);
    const entries = cache.read(file);
    expect(entries).toHaveLength(10);
    expect(entries[0]).toEqual({ id: 0, name: "e0" });
    expect(entries[9]).toEqual({ id: 9, name: "e9" });
  });

  test("ISC-3: malformed line skipped without breaking subsequent lines", () => {
    writeFileSync(
      file,
      [JSON.stringify({ id: 1, name: "a" }), "{not valid json", JSON.stringify({ id: 2, name: "b" })].join("\n") + "\n"
    );
    const cache = createJsonlTailCache(parseEntry);
    const entries = cache.read(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
  });

  test("ISC-4: incremental append — old entries reference-identical across calls", () => {
    writeFileSync(file, JSON.stringify({ id: 1, name: "a" }) + "\n");
    const cache = createJsonlTailCache(parseEntry);
    const first = cache.read(file);
    expect(first).toHaveLength(1);

    appendFileSync(file, JSON.stringify({ id: 2, name: "b" }) + "\n");
    const second = cache.read(file);
    expect(second).toHaveLength(2);
    // Proof no re-parse happened: the object returned for entry 0 is the
    // exact same reference across calls, not a structurally-equal copy.
    expect(second[0]).toBe(first[0]);
    expect(second[1].id).toBe(2);
  });

  test("ISC-5: partial trailing line invisible until completed", () => {
    writeFileSync(file, JSON.stringify({ id: 1, name: "a" }) + "\n");
    const cache = createJsonlTailCache(parseEntry);
    expect(cache.read(file)).toHaveLength(1);

    // Append a line with no trailing newline — should not appear yet.
    appendFileSync(file, JSON.stringify({ id: 2, name: "b" }));
    expect(cache.read(file)).toHaveLength(1);

    // Complete the line.
    appendFileSync(file, "\n");
    const entries = cache.read(file);
    expect(entries).toHaveLength(2);
    expect(entries[1].id).toBe(2);
  });

  test("ISC-6: copy-truncate rotation (size < byteOffset) detected and reset", () => {
    writeFileSync(file, Array.from({ length: 5 }, (_, i) => JSON.stringify({ id: i, name: `e${i}` })).join("\n") + "\n");
    const cache = createJsonlTailCache(parseEntry);
    expect(cache.read(file)).toHaveLength(5);

    // Simulate copy-truncate: file shrinks in place (same inode on most fs).
    truncateSync(file, 0);
    writeFileSync(file, JSON.stringify({ id: 100, name: "fresh" }) + "\n");
    const entries = cache.read(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(100);
  });

  test("ISC-7: inode-change rotation detected and reset", () => {
    writeFileSync(file, Array.from({ length: 3 }, (_, i) => JSON.stringify({ id: i, name: `e${i}` })).join("\n") + "\n");
    const cache = createJsonlTailCache(parseEntry);
    expect(cache.read(file)).toHaveLength(3);

    // Simulate log rotation: new file swapped into place via rename (new inode).
    const replacement = join(dir, "log.jsonl.new");
    writeFileSync(replacement, JSON.stringify({ id: 200, name: "rotated" }) + "\n");
    renameSync(replacement, file);

    const entries = cache.read(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(200);
  });

  test("ISC-8: missing file at cold start returns [] without throwing", () => {
    const cache = createJsonlTailCache(parseEntry);
    expect(() => cache.read(join(dir, "does-not-exist.jsonl"))).not.toThrow();
    expect(cache.read(join(dir, "does-not-exist.jsonl"))).toEqual([]);
  });

  test("ISC-9: transient-missing-after-data returns last-known-good", () => {
    writeFileSync(file, JSON.stringify({ id: 1, name: "a" }) + "\n");
    const cache = createJsonlTailCache(parseEntry);
    expect(cache.read(file)).toHaveLength(1);

    rmSync(file);
    const entries = cache.read(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(1);
  });

  test("plateau: no I/O beyond stat when size unchanged", () => {
    writeFileSync(file, JSON.stringify({ id: 1, name: "a" }) + "\n");
    const cache = createJsonlTailCache(parseEntry);
    const first = cache.read(file);
    const second = cache.read(file);
    // Same array contents and same object references — proves the second
    // read did not re-open/re-parse the file.
    expect(second[0]).toBe(first[0]);
    expect(second).toHaveLength(1);
  });

  test("ISC-21: pruneEntries hook bounds retained entries on every read, including unchanged-size reads", () => {
    writeFileSync(file, Array.from({ length: 5 }, (_, i) => JSON.stringify({ id: i, name: `e${i}` })).join("\n") + "\n");
    // Prune anything with an even id — simulates a time-based cutoff without
    // depending on wall-clock time.
    const cache = createJsonlTailCache(parseEntry, undefined, (entries: Entry[]) => entries.filter((e) => e.id % 2 !== 0));
    const first = cache.read(file);
    expect(first.map((e) => e.id)).toEqual([1, 3]);

    // Re-read with no file change: prune still applies (not just on the
    // ingest path), and it's idempotent — same entries come back.
    const second = cache.read(file);
    expect(second.map((e) => e.id)).toEqual([1, 3]);
  });

  test("ISC-20: large delta spanning multiple internal read chunks is read completely and exactly", () => {
    // Force a tiny chunkSize so a normal-sized fixture exercises the same
    // multi-chunk read loop that a real multi-GB file would hit against the
    // OS's single-read cap — proves no bytes are silently dropped or
    // duplicated at chunk boundaries, including mid-line boundaries.
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ id: i, name: `entry-${i}` }));
    writeFileSync(file, lines.join("\n") + "\n");
    const cache = createJsonlTailCache(parseEntry, 17); // 17 bytes: guarantees splits land mid-line
    const entries = cache.read(file);
    expect(entries).toHaveLength(500);
    expect(entries.map((e) => e.id)).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(entries[499]).toEqual({ id: 499, name: "entry-499" });
  });

  test("multiple lines appended between two reads all appear in order", () => {
    writeFileSync(file, JSON.stringify({ id: 1, name: "a" }) + "\n");
    const cache = createJsonlTailCache(parseEntry);
    expect(cache.read(file)).toHaveLength(1);

    appendFileSync(
      file,
      [JSON.stringify({ id: 2, name: "b" }), JSON.stringify({ id: 3, name: "c" }), JSON.stringify({ id: 4, name: "d" })].join("\n") + "\n"
    );
    const entries = cache.read(file);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  test("ISC-22: byte offsets correct on cold read — readExactBytes round-trips each line", () => {
    const lines = Array.from({ length: 8 }, (_, i) => JSON.stringify({ id: i, name: `e${i}` }));
    writeFileSync(file, lines.join("\n") + "\n");
    const cache = createJsonlTailCache(parseEntryWithOffset);
    const entries = cache.read(file);
    expect(entries).toHaveLength(8);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const raw = readExactBytes(file, e.byteOffset, e.byteLength);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!.toString("utf8"))).toEqual({ id: i, name: `e${i}` });
    }
  });

  test("ISC-23: byte offsets correct across incremental appends", () => {
    writeFileSync(file, JSON.stringify({ id: 1, name: "a" }) + "\n");
    const cache = createJsonlTailCache(parseEntryWithOffset);
    const first = cache.read(file);
    expect(first).toHaveLength(1);

    appendFileSync(file, [JSON.stringify({ id: 2, name: "b" }), JSON.stringify({ id: 3, name: "c" })].join("\n") + "\n");
    const second = cache.read(file);
    expect(second).toHaveLength(3);
    for (let i = 0; i < second.length; i++) {
      const e = second[i];
      const raw = readExactBytes(file, e.byteOffset, e.byteLength);
      expect(JSON.parse(raw!.toString("utf8"))).toEqual({ id: e.id, name: e.name });
    }
  });

  test("ISC-24: multi-byte UTF-8 character straddling a chunk boundary decodes exactly, not as replacement characters", () => {
    // Chunk size of 1 byte forces every single byte to land in its own
    // internal read chunk, guaranteeing every multi-byte UTF-8 sequence in
    // the fixture straddles a chunk boundary.
    const emoji = "🔥"; // 4-byte UTF-8 sequence (U+1F525)
    const accented = "café"; // "é" is a 2-byte UTF-8 sequence
    const lines = [
      JSON.stringify({ id: 1, name: `hot ${emoji} stuff` }),
      JSON.stringify({ id: 2, name: accented }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    const cache = createJsonlTailCache(parseEntry, 1);
    const entries = cache.read(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe(`hot ${emoji} stuff`);
    expect(entries[0].name).not.toContain("�");
    expect(entries[1].name).toBe(accented);
    expect(entries[1].name).not.toContain("�");
  });

  test("ISC-25: readExactBytes valid range round-trips; out-of-bounds and missing path return null", () => {
    const content = JSON.stringify({ id: 1, name: "a" }) + "\n";
    writeFileSync(file, content);
    const exact = readExactBytes(file, 0, content.length - 1); // exclude trailing newline
    expect(exact).not.toBeNull();
    expect(JSON.parse(exact!.toString("utf8"))).toEqual({ id: 1, name: "a" });

    // Requesting more bytes than the file contains is a short read -> null.
    expect(readExactBytes(file, 0, content.length + 100)).toBeNull();
    // Offset already past EOF -> short read -> null.
    expect(readExactBytes(file, content.length + 50, 10)).toBeNull();
    // Missing file -> null, never throws.
    expect(() => readExactBytes(join(dir, "does-not-exist.jsonl"), 0, 10)).not.toThrow();
    expect(readExactBytes(join(dir, "does-not-exist.jsonl"), 0, 10)).toBeNull();
  });

  test("ISC-26: readExactBytes against a rotated file at a stale offset does not throw", () => {
    const first = JSON.stringify({ id: 1, name: "original-longer-content-here" }) + "\n";
    writeFileSync(file, first);
    const cache = createJsonlTailCache(parseEntryWithOffset);
    const entries = cache.read(file);
    const staleRef = entries[0];

    // Rotate: swap in a much shorter file at the same path (new inode).
    const replacement = join(dir, "log.jsonl.new");
    writeFileSync(replacement, JSON.stringify({ id: 2, name: "x" }) + "\n");
    renameSync(replacement, file);

    // The stale byte range may now be entirely past EOF (short read -> null)
    // or may land on unrelated bytes from the new file — either way this
    // must never throw, and a short read must come back as null.
    expect(() => readExactBytes(file, staleRef.byteOffset, staleRef.byteLength)).not.toThrow();
  });
});
