import type { UsageRecord } from "./parse.js";
import { costParts, priceFor, priceKey, type ModelPrice } from "./pricing.js";

export interface Bucketed {
  cost: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionRow extends Bucketed {
  sessionId: string;
  project: string;
  model: string; // dominant model
  start: Date;
  end: Date;
}

/** One priced component of the total — THE BURN row. */
export type BucketKey = "cacheRead" | "cacheWrite1h" | "output" | "cacheWrite5m" | "input";
export interface BucketSlice {
  key: BucketKey;
  label: string;
  cost: number;
  tokens: number;
  pct: number; // share of total cost
}

export interface ProjectRow {
  project: string;
  cost: number;
  turns: number;
  pct: number;
}

export interface Report {
  from: Date;
  to: Date;
  windowDays: number;
  totalCost: number;
  turns: number;
  sessions: number;
  projects: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  /** Cost split across the five priced buckets, sorted by cost desc. Sums to totalCost. */
  buckets: BucketSlice[];
  /** Share of total cost that is cache read + cache write — the "context upkeep" number. */
  contextUpkeepPct: number;
  byModel: Array<{ model: string; estimated: boolean } & Bucketed>;
  /** Effective per-model input/output rates used (reflects --prices) — auditability. */
  rates: Record<string, { input: number; output: number; estimated: boolean }>;
  byProject: ProjectRow[];
  topSessions: SessionRow[];
  mainCost: number;
  subagentCost: number;
  usedEstimatedPrice: boolean;
}

function empty(): Bucketed {
  return { cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function add(b: Bucketed, r: UsageRecord, cost: number): void {
  b.cost += cost;
  b.turns += 1;
  b.input += r.input;
  b.output += r.output;
  b.cacheRead += r.cacheRead;
  b.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
}

const BUCKET_LABEL: Record<BucketKey, string> = {
  cacheRead: "cache read",
  cacheWrite1h: "cache write 1h",
  output: "output",
  cacheWrite5m: "cache write 5m",
  input: "fresh input",
};

export function buildReport(
  records: UsageRecord[],
  overrides: Record<string, Partial<ModelPrice>> = {},
  topN = 10,
): Report {
  const byModel = new Map<string, Bucketed>();
  const bySession = new Map<string, SessionRow>();
  const sessionModelTokens = new Map<string, Map<string, number>>();
  const sessionProjectTurns = new Map<string, Map<string, number>>();
  // Per-bucket dollars and tokens — accumulated from the single cost formula.
  const bCost: Record<BucketKey, number> = { cacheRead: 0, cacheWrite1h: 0, output: 0, cacheWrite5m: 0, input: 0 };
  const bTok: Record<BucketKey, number> = { cacheRead: 0, cacheWrite1h: 0, output: 0, cacheWrite5m: 0, input: 0 };
  let totalCost = 0;
  let mainCost = 0;
  let subagentCost = 0;
  let usedEstimatedPrice = false;
  let from = Infinity;
  let to = -Infinity;

  for (const r of records) {
    const price = priceFor(r.model, overrides);
    if (price.estimated) usedEstimatedPrice = true;
    const parts = costParts(r, price);
    const cost = parts.input + parts.output + parts.cacheRead + parts.cacheWrite5m + parts.cacheWrite1h;
    totalCost += cost;
    if (r.isSidechain) subagentCost += cost;
    else mainCost += cost;

    bCost.input += parts.input;
    bCost.output += parts.output;
    bCost.cacheRead += parts.cacheRead;
    bCost.cacheWrite5m += parts.cacheWrite5m;
    bCost.cacheWrite1h += parts.cacheWrite1h;
    bTok.input += r.input;
    bTok.output += r.output;
    bTok.cacheRead += r.cacheRead;
    bTok.cacheWrite5m += r.cacheWrite5m;
    bTok.cacheWrite1h += r.cacheWrite1h;

    const t = r.ts.getTime();
    if (Number.isFinite(t)) {
      if (t < from) from = t;
      if (t > to) to = t;
    }

    const mk = priceKey(r.model) || r.model;
    let mb = byModel.get(mk);
    if (!mb) byModel.set(mk, (mb = empty()));
    add(mb, r, cost);

    let sr = bySession.get(r.sessionId);
    if (!sr) {
      bySession.set(
        r.sessionId,
        (sr = {
          sessionId: r.sessionId,
          project: r.project,
          model: mk,
          start: r.ts,
          end: r.ts,
          ...empty(),
        }),
      );
    }
    add(sr, r, cost);
    if (Number.isFinite(t)) {
      if (t < sr.start.getTime()) sr.start = r.ts;
      if (t > sr.end.getTime()) sr.end = r.ts;
    }
    // Track dominant model (by output tokens) and project (by turns) per session.
    let smt = sessionModelTokens.get(r.sessionId);
    if (!smt) sessionModelTokens.set(r.sessionId, (smt = new Map()));
    smt.set(mk, (smt.get(mk) ?? 0) + r.output);

    let spt = sessionProjectTurns.get(r.sessionId);
    if (!spt) sessionProjectTurns.set(r.sessionId, (spt = new Map()));
    spt.set(r.project, (spt.get(r.project) ?? 0) + 1);
  }

  // Resolve each session's dominant model + project, then roll cost up by project.
  const projectAgg = new Map<string, { cost: number; turns: number }>();
  for (const [sid, sr] of bySession) {
    const smt = sessionModelTokens.get(sid);
    if (smt) {
      let best = sr.model;
      let bestTok = -1;
      for (const [m, tok] of smt) if (tok > bestTok) ((bestTok = tok), (best = m));
      sr.model = best;
    }
    const spt = sessionProjectTurns.get(sid);
    if (spt) {
      let best = sr.project;
      let bestN = -1;
      for (const [p, n] of spt) if (n > bestN) ((bestN = n), (best = p));
      sr.project = best;
    }
    const pa = projectAgg.get(sr.project) ?? { cost: 0, turns: 0 };
    pa.cost += sr.cost;
    pa.turns += sr.turns;
    projectAgg.set(sr.project, pa);
  }

  const modelRows = [...byModel.entries()]
    .map(([model, b]) => ({ model, estimated: priceFor(model, overrides).estimated === true, ...b }))
    .sort((a, b) => b.cost - a.cost);

  const rates: Record<string, { input: number; output: number; estimated: boolean }> = {};
  for (const m of modelRows) {
    const p = priceFor(m.model, overrides);
    rates[m.model] = { input: p.input, output: p.output, estimated: p.estimated === true };
  }

  const byProject: ProjectRow[] = [...projectAgg.entries()]
    .map(([project, v]) => ({ project, cost: v.cost, turns: v.turns, pct: totalCost ? (v.cost / totalCost) * 100 : 0 }))
    .sort((a, b) => b.cost - a.cost);

  const topSessions = [...bySession.values()].sort((a, b) => b.cost - a.cost).slice(0, topN);

  const buckets: BucketSlice[] = (Object.keys(bCost) as BucketKey[])
    .map((key) => ({
      key,
      label: BUCKET_LABEL[key],
      cost: bCost[key],
      tokens: bTok[key],
      pct: totalCost ? (bCost[key] / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Mandatory reconciliation (Principle II): the five buckets MUST sum to the
  // total, or a mispricing would ship silently — the exact class of bug that
  // once inflated the headline 3×. Tolerance absorbs float non-associativity.
  const bucketSum = buckets.reduce((a, b) => a + b.cost, 0);
  if (Math.abs(bucketSum - totalCost) > 1e-6 * Math.max(1, totalCost)) {
    throw new Error(`bucket reconciliation failed: buckets ${bucketSum} != total ${totalCost}`);
  }

  const cacheCost = bCost.cacheRead + bCost.cacheWrite5m + bCost.cacheWrite1h;
  const contextUpkeepPct = totalCost ? (cacheCost / totalCost) * 100 : 0;

  const fromMs = Number.isFinite(from) ? from : Date.now();
  const toMs = Number.isFinite(to) ? to : Date.now();
  const windowDays = Math.max(1, Math.round((toMs - fromMs) / 86400000));

  return {
    from: new Date(fromMs),
    to: new Date(toMs),
    windowDays,
    totalCost,
    turns: modelRows.reduce((s, m) => s + m.turns, 0),
    sessions: bySession.size,
    projects: projectAgg.size,
    totalInput: bTok.input,
    totalOutput: bTok.output,
    totalCacheRead: bTok.cacheRead,
    totalCacheWrite: bTok.cacheWrite5m + bTok.cacheWrite1h,
    buckets,
    contextUpkeepPct,
    byModel: modelRows,
    rates,
    byProject,
    topSessions,
    mainCost,
    subagentCost,
    usedEstimatedPrice,
  };
}
