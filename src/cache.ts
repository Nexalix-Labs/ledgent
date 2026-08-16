/**
 * Incremental parse cache — so a repeat `ledgent report` is fast.
 *
 * The first run parses every JSONL and caches each file's extracted records,
 * keyed by path and validated by (mtime, size). Subsequent runs re-parse only
 * the files that changed and read the rest from cache, turning an ~8s scan of a
 * multi-hundred-MB corpus into a sub-second re-run. Stored under ~/.ledgent
 * (local, no network). A stale or unreadable cache is simply ignored and rebuilt.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "./parse.js";

const CACHE_DIR = join(homedir(), ".ledgent");
const CACHE_FILE = join(CACHE_DIR, "cache.json");
// v2 added the fast-mode flag; v1 entries predate it and would read back as
// standard speed, understating an Opus fast turn by half. Bump = full re-parse.
const CACHE_VERSION = 2;

/** Compact on-disk record — short keys keep the cache file small. */
interface SerRecord {
  u: string;
  s: string;
  p: string;
  m: string;
  t: number; // epoch ms
  x: boolean; // isSidechain
  f: boolean; // fast mode
  i: number;
  o: number;
  cr: number;
  c5: number;
  c1: number;
}

export interface FileEntry {
  mtimeMs: number;
  size: number;
  records: SerRecord[];
}

export interface Cache {
  v: number;
  files: Record<string, FileEntry>;
}

export function loadCache(): Cache {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Cache;
    if (c && c.v === CACHE_VERSION && c.files) return c;
  } catch {
    /* missing / stale / corrupt — rebuild */
  }
  return { v: CACHE_VERSION, files: {} };
}

export function saveCache(files: Record<string, FileEntry>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = join(CACHE_DIR, `.cache-${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files }), { flag: "wx" });
    renameSync(tmp, CACHE_FILE);
  } catch {
    /* best-effort */
  }
}

export function serialize(r: UsageRecord): SerRecord {
  return {
    u: r.uuid,
    s: r.sessionId,
    p: r.project,
    m: r.model,
    t: r.ts.getTime(),
    x: r.isSidechain,
    f: r.fast,
    i: r.input,
    o: r.output,
    cr: r.cacheRead,
    c5: r.cacheWrite5m,
    c1: r.cacheWrite1h,
  };
}

export function deserialize(s: SerRecord): UsageRecord {
  return {
    uuid: s.u,
    sessionId: s.s,
    project: s.p,
    model: s.m,
    ts: new Date(s.t),
    isSidechain: s.x,
    fast: s.f === true,
    input: s.i,
    output: s.o,
    cacheRead: s.cr,
    cacheWrite5m: s.c5,
    cacheWrite1h: s.c1,
  };
}
