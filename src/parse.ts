import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { deserialize, loadCache, saveCache, serialize, type FileEntry } from "./cache.js";
import type { UsageBuckets } from "./pricing.js";

export interface UsageRecord extends UsageBuckets {
  uuid: string;
  sessionId: string;
  project: string; // human path (cwd) when available, else encoded dir name
  model: string;
  ts: Date;
  isSidechain: boolean;
}

/** Default location of Claude Code session logs. Respects CLAUDE_CONFIG_DIR. */
export function defaultRoot(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  return cfg ? join(cfg, "projects") : join(homedir(), ".claude", "projects");
}

/** Every *.jsonl under root (recursive), skipping files untouched since `since`. */
async function listSessionFiles(root: string, since?: Date): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out; // missing / unreadable dir
  }
  for (const ent of entries) {
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listSessionFiles(full, since)));
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    if (since) {
      try {
        const s = await stat(full);
        if (s.mtimeMs < since.getTime()) continue; // whole file predates window
      } catch {
        continue;
      }
    }
    out.push(full);
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Pull a UsageRecord out of one assistant event, or null if not billable. */
function toRecord(o: any): UsageRecord | null {
  if (o?.type !== "assistant") return null;
  const msg = o.message;
  const usage = msg?.usage;
  if (!usage) return null;
  const model: string = msg.model ?? "";
  if (!model || model === "<synthetic>") return null;

  const cc = usage.cache_creation ?? {};
  // Prefer the 5m/1h split; fall back to lumping all cache-creation as 5m.
  let w5 = num(cc.ephemeral_5m_input_tokens);
  let w1 = num(cc.ephemeral_1h_input_tokens);
  if (w5 === 0 && w1 === 0) w5 = num(usage.cache_creation_input_tokens);

  const ts = o.timestamp ? new Date(o.timestamp) : new Date(NaN);

  return {
    uuid: o.uuid ?? `${o.requestId ?? ""}:${msg.id ?? ""}`,
    sessionId: o.sessionId ?? "unknown",
    project: typeof o.cwd === "string" && o.cwd ? o.cwd : "unknown",
    model,
    ts,
    isSidechain: o.isSidechain === true,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
  };
}

export interface ParseResult {
  records: UsageRecord[];
  filesScanned: number;
  linesRead: number;
  parseErrors: number;
}

/** Parse one JSONL file into its billable records (no window/project filtering). */
async function parseFile(file: string): Promise<{ records: UsageRecord[]; lines: number; errors: number }> {
  const records: UsageRecord[] = [];
  let lines = 0;
  let errors = 0;
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      errors++;
      continue;
    }
    const rec = toRecord(o);
    if (rec) records.push(rec);
  }
  return { records, lines, errors };
}

/**
 * Scan session logs and return billable usage records, using an incremental
 * per-file cache (keyed by path, validated by mtime+size) so repeat runs are
 * fast. `since` bounds by timestamp (and skips whole files by mtime up front).
 */
export async function collect(opts: {
  root?: string;
  since?: Date;
  projectFilter?: string;
}): Promise<ParseResult> {
  const root = opts.root ?? defaultRoot();
  const files = await listSessionFiles(root, opts.since);
  const cache = loadCache();
  const nextFiles: Record<string, FileEntry> = { ...cache.files };
  let dirty = false;

  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let linesRead = 0;
  let parseErrors = 0;

  for (const file of files) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    const hit = cache.files[file];
    let fileRecs: UsageRecord[];
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      fileRecs = hit.records.map(deserialize);
    } else {
      const parsed = await parseFile(file);
      fileRecs = parsed.records;
      linesRead += parsed.lines;
      parseErrors += parsed.errors;
      nextFiles[file] = { mtimeMs: st.mtimeMs, size: st.size, records: fileRecs.map(serialize) };
      dirty = true;
    }
    for (const rec of fileRecs) {
      if (opts.since && !(rec.ts.getTime() >= opts.since.getTime())) continue;
      if (opts.projectFilter && !rec.project.toLowerCase().includes(opts.projectFilter.toLowerCase())) {
        continue;
      }
      if (seen.has(rec.uuid)) continue; // dedup resumed/duplicated lines
      seen.add(rec.uuid);
      records.push(rec);
    }
  }

  if (dirty) saveCache(nextFiles);
  return { records, filesScanned: files.length, linesRead, parseErrors };
}
