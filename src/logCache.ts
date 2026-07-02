import { closeSync, openSync, readSync, statSync } from "fs";

type TailCacheState<T> = {
  entries: T[];
  byteOffset: number;
  partial: Buffer;
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
// Linux caps a single positional read() at 0x7FFFF000 (~2.147GB) bytes; a
// naive single readSync of a multi-GB delta silently returns fewer bytes
// than requested. Chunking well under that cap keeps every read exact
// regardless of how large the pending delta (or the whole file, on a cold
// start) is.
const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

export function createJsonlTailCache<T>(
  parseLine: (line: string, byteOffset: number, byteLength: number) => T | null,
  chunkSize = DEFAULT_CHUNK_SIZE,
  pruneEntries?: (entries: T[]) => T[]
) {
  const state: TailCacheState<T> = { entries: [], byteOffset: 0, partial: Buffer.alloc(0), ino: -1 };

  function reset() {
    state.entries = [];
    state.byteOffset = 0;
    state.partial = Buffer.alloc(0);
    state.ino = -1;
  }

  // Splits on raw bytes and only UTF-8-decodes once a complete line's exact
  // byte range is known (via Buffer.concat with any leftover partial line).
  // Decoding each chunk independently before concatenating as strings — the
  // prior approach — corrupts any line whose multi-byte UTF-8 character
  // straddles a chunk boundary, since both halves decode to replacement
  // characters (U+FFFD) that never recombine.
  function ingest(chunk: Buffer, chunkStart: number) {
    const prevPartialLen = state.partial.length;
    const buf = prevPartialLen ? Buffer.concat([state.partial, chunk]) : chunk;
    const bufStart = chunkStart - prevPartialLen;
    let searchFrom = 0;
    while (true) {
      const nl = buf.indexOf(NEWLINE, searchFrom);
      if (nl === -1) break;
      const byteOffset = bufStart + searchFrom;
      const byteLength = nl - searchFrom;
      const line = buf.toString("utf8", searchFrom, nl).trim();
      if (line) {
        const parsed = parseLine(line, byteOffset, byteLength);
        if (parsed !== null) state.entries.push(parsed);
      }
      searchFrom = nl + 1;
    }
    // Copy (not a view) so the leftover bytes don't keep the whole chunk's
    // backing buffer alive until the next read.
    state.partial = searchFrom < buf.length ? Buffer.from(buf.subarray(searchFrom)) : Buffer.alloc(0);
  }

  function read(path: string): T[] {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      stat = null;
    }

    if (stat) {
      if (stat.ino !== state.ino || stat.size < state.byteOffset) {
        reset();
        state.ino = stat.ino;
      }

      if (stat.size !== state.byteOffset) {
        let fd: number | undefined;
        try {
          fd = openSync(path, "r");
          let pos = state.byteOffset;
          while (pos < stat.size) {
            const len = Math.min(chunkSize, stat.size - pos);
            const buf = Buffer.alloc(len);
            const bytesRead = readSync(fd, buf, 0, len, pos);
            if (bytesRead <= 0) break;
            ingest(bytesRead === len ? buf : buf.subarray(0, bytesRead), pos);
            pos += bytesRead;
          }
          state.byteOffset = pos;
        } catch {
          // keep last-known-good entries
        } finally {
          if (fd !== undefined) {
            try { closeSync(fd); } catch { /* ignore */ }
          }
        }
      }
    }

    // Prune runs on every read (even when the file is unchanged or
    // missing) so a time-based retention window keeps shrinking as entries
    // age out, not just when new bytes arrive.
    if (pruneEntries) state.entries = pruneEntries(state.entries);

    return state.entries.slice();
  }

  return { read };
}

/**
 * Reads an exact byte range from a file, for hydrating detail on demand from
 * a previously-recorded (byteOffset, byteLength). Never throws — returns
 * null on any I/O error or short read (e.g. the file rotated and the range
 * no longer refers to the same bytes).
 */
export function readExactBytes(path: string, byteOffset: number, byteLength: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(byteLength);
    const bytesRead = readSync(fd, buf, 0, byteLength, byteOffset);
    if (bytesRead !== byteLength) return null;
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
