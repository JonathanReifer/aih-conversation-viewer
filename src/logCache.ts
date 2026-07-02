import { closeSync, openSync, readSync, statSync } from "fs";

type TailCacheState<T> = {
  entries: T[];
  byteOffset: number;
  partial: string;
  ino: number;
};

/**
 * Incremental byte-offset tail cache for append-only JSONL logs.
 *
 * A cold/first read parses the whole file once; every subsequent read only
 * pulls and parses bytes appended since the last read (O(new bytes), not
 * O(file size)). Handles copy-truncate rotation (size < byteOffset) and
 * inode-change rotation by resetting from scratch. Never throws — on any
 * I/O failure it returns the last-known-good entries (or [] on a true cold
 * start with no prior state).
 */
export function createJsonlTailCache<T>(parseLine: (line: string) => T | null) {
  const state: TailCacheState<T> = { entries: [], byteOffset: 0, partial: "", ino: -1 };

  function reset() {
    state.entries = [];
    state.byteOffset = 0;
    state.partial = "";
    state.ino = -1;
  }

  function ingest(chunk: string) {
    const text = state.partial + chunk;
    const lines = text.split("\n");
    state.partial = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseLine(trimmed);
      if (parsed !== null) state.entries.push(parsed);
    }
  }

  function read(path: string): T[] {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // File missing: true cold start returns [], but if we already have
      // data, a transient miss should not wipe the cache.
      return state.entries.slice();
    }

    if (stat.ino !== state.ino || stat.size < state.byteOffset) {
      reset();
      state.ino = stat.ino;
    }

    if (stat.size === state.byteOffset) {
      return state.entries.slice();
    }

    const len = stat.size - state.byteOffset;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, state.byteOffset);
      ingest(buf.toString("utf8"));
      state.byteOffset = stat.size;
    } catch {
      return state.entries.slice();
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    return state.entries.slice();
  }

  return { read };
}
