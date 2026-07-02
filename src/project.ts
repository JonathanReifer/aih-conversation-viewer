// Reads the session_id -> project mapping written by aih-privacy-middleware's
// hooks (see aih-privacy-middleware/src/project.ts). This viewer has no cwd or
// hook-input visibility of its own — it only ever sees session_id — so this is
// the only way it learns which project an "otel" or "proxy" source session
// belongs to. "unified"/audit-source sessions don't need this: the middleware
// already persists `project` directly on each audit.jsonl entry.
//
// Defined locally on purpose — no shared package, matching this stack's
// zero-cross-repo-imports convention.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

function sessionProjectsPath(): string {
  return (
    process.env.LLM_PRIVACY_SESSION_PROJECTS_PATH ??
    join(process.env.HOME ?? "~", ".llm-privacy", "session-projects.jsonl")
  );
}

interface SessionProjectEntry {
  session_id: string;
  project: string;
  ts: string;
}

let cache: Map<string, string> | null = null;
let cacheMtimeMs = 0;

function loadMap(): Map<string, string> {
  const path = sessionProjectsPath();
  let mtimeMs = 0;
  try {
    mtimeMs = existsSync(path) ? require("fs").statSync(path).mtimeMs : 0;
  } catch {
    mtimeMs = 0;
  }
  if (cache && mtimeMs === cacheMtimeMs) return cache;

  const map = new Map<string, string>();
  try {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SessionProjectEntry;
          map.set(entry.session_id, entry.project); // last write wins
        } catch {
          // skip malformed line
        }
      }
    }
  } catch {
    // fall through with whatever was parsed so far
  }
  cache = map;
  cacheMtimeMs = mtimeMs;
  return map;
}

/** Looks up the project for a session_id. Never throws. */
export function lookupProject(sessionId: string): string | undefined {
  try {
    return loadMap().get(sessionId);
  } catch {
    return undefined;
  }
}
