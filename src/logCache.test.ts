import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJsonlTailCache } from "./logCache.js";

type Entry = { id: number; name: string };

function parseEntry(line: string): Entry | null {
  try {
    return JSON.parse(line) as Entry;
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
});
