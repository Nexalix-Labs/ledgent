/**
 * The Ledgent Terminal report — rendered to the design spec.
 *
 * Sections in order: wordmark → header stat → hero → THE BURN → BY MODEL →
 * BY PROJECT → FORECAST → footer. 80-column discipline, the eight-token palette,
 * saturated color reserved for accent / success / danger.
 */
import type { Report } from "./aggregate.js";
import type { Insights } from "./insights.js";
import { deriveInsights } from "./insights.js";
import { renderCallout } from "./callout.js";
import { RATES_AS_OF } from "./pricing.js";
import {
  accent,
  bar,
  bold,
  danger,
  fg,
  money,
  muted,
  pad,
  subtle,
  success,
  visibleWidth,
} from "./theme.js";

const IND = "  "; // body indent
const W = 60; // content width (within the 80-col budget)

/** Section header: `TITLE ───────────  note`. */
function head(title: string, note: string): string {
  const left = accent(bold(title));
  const right = subtle(note);
  const fill = Math.max(1, W - visibleWidth(left) - visibleWidth(right) - 2);
  return IND + left + " " + subtle("─".repeat(fill)) + " " + right;
}

/** Right-align a colored cell to width w (measured on visible glyphs). */
const r = (s: string, w: number) => pad(s, w, true);
const l = (s: string, w: number) => pad(s, w);

function wordmark(): string[] {
  const mark =
    IND +
    subtle("·") + " " + subtle("·") + " " + accent("●") + " " +
    bold(fg("ledgent")) + "   " + subtle("every token accounted for");
  return [mark];
}

function headerStat(rep: Report): string[] {
  const dot = subtle(" · ");
  const line =
    IND +
    accent(bold(money(rep.totalCost))) + dot +
    fg(rep.sessions.toLocaleString("en-US")) + " " + muted("sessions") + dot +
    fg(rep.turns.toLocaleString("en-US")) + " " + muted("turns") + dot +
    fg(String(rep.projects)) + " " + muted("projects");
  return [IND + muted(`LAST ${rep.windowDays} DAYS`), line];
}

function heroLine(ins: Insights): string {
  const big = accent(bold(`${ins.hero.upkeepPct.toFixed(0)}%`));
  return IND + big + " " + muted("of your spend is context upkeep, not intelligence");
}

function heroSplit(rep: Report, ins: Insights): string {
  const get = (k: string) => rep.buckets.find((b) => b.key === k);
  const cr = get("cacheRead");
  const cw = (get("cacheWrite1h")?.cost ?? 0) + (get("cacheWrite5m")?.cost ?? 0);
  const out = get("output");
  const seg = (label: string, cost: number, pct: number) =>
    muted(label + " ") + fg(money(cost)) + " " + subtle(`(${pct.toFixed(0)}%)`);
  return (
    IND +
    seg("cache read", cr?.cost ?? 0, ins.hero.cacheReadPct) +
    subtle(" + ") +
    seg("cache write", cw, ins.hero.cacheWritePct) +
    subtle(" vs ") +
    seg("output", out?.cost ?? 0, ins.hero.outputPct)
  );
}

function burn(rep: Report): string[] {
  // Bars scaled relative to the largest bucket so the top bar reads full-ish
  // (~12/16), matching the design — proportional-to-total would leave even the
  // top bucket under half and the small ones invisible.
  const maxCost = Math.max(1, ...rep.buckets.map((b) => b.cost));
  const rows = rep.buckets.map((b) => {
    const frac = (b.cost / maxCost) * 0.75;
    return (
      IND +
      l(muted(b.label), 15) + "  " +
      r(fg(money(b.cost)), 8) + "  " +
      r(muted(`${b.pct.toFixed(0)}%`), 4) + "  " +
      bar(frac, 16)
    );
  });
  return [head("THE BURN", "cost by bucket"), ...rows];
}

function models(rep: Report, ins: Insights): string[] {
  const header =
    IND +
    l(subtle("model"), 9) + "  " +
    r(subtle("spend"), 9) + "  " +
    r(subtle("share"), 6) + "   " +
    subtle("$ / 1k turns");
  const rows = rep.byModel.map((m) => {
    const perK = m.turns > 0 ? (m.cost / m.turns) * 1000 : 0;
    const perKCell =
      m.turns > 0 && m.cost > 0 ? muted(`$${Math.round(perK).toLocaleString("en-US")}`) : subtle("—");
    const flag = m.estimated ? " " + danger("~est") : "";
    const share = rep.totalCost ? (m.cost / rep.totalCost) * 100 : 0;
    return (
      IND +
      l(fg(m.model), 9) + "  " +
      r(fg(money(m.cost)), 9) + "  " +
      r(muted(`${share.toFixed(0)}%`), 6) + "   " +
      perKCell + flag
    );
  });
  const out = [head("BY MODEL", "where intelligence is billed"), header, ...rows];
  if (ins.modelSpread) {
    const s = ins.modelSpread;
    out.push(
      IND + subtle("↳ ") +
        success(`×${s.factor.toFixed(0)} cost-per-turn spread`) +
        muted(` between ${s.hi} and ${s.lo}`),
    );
  }
  return out;
}

function projects(rep: Report, ins: Insights, topN: number, redact: boolean): string[] {
  const shown = rep.byProject.slice(0, topN);
  const rows = shown.map((p) => {
    const mark = ins.concentration && p.project === ins.concentration.project ? " " + danger("▲") : "";
    const name = redact ? aliasOf(rep, p.project) : clip(shortProject(p.project), 20);
    return (
      IND +
      l(fg(name), 20) + "  " +
      r(fg(money(p.cost)), 9) + "  " +
      r(muted(`${p.pct.toFixed(0)}%`), 5) +
      mark
    );
  });
  const rest = rep.byProject.length - shown.length;
  if (rest > 0) rows.push(IND + subtle(`+${rest} more`));
  const out = [head("BY PROJECT", `top ${shown.length} of ${rep.byProject.length}`), ...rows];
  if (ins.concentration) {
    out.push(
      IND + danger("▲ ") +
        muted(`${ins.concentration.pct.toFixed(0)}% of spend concentrated in a single project`),
    );
  }
  return out;
}

function shortProject(p: string): string {
  if (p === "unknown") return p;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Truncate a raw (uncolored) string to w visible columns with an ellipsis. */
function clip(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}

function forecast(ins: Insights): string[] {
  return renderCallout(ins.forecast)
    .split("\n")
    .map((line) => IND + line);
}

function footer(): string[] {
  const left = success("●") + " " + subtle("ledgent · every token accounted for");
  const right = subtle("github.com/Nexalix-Labs/ledgent");
  const rule = subtle("─".repeat(W));
  return [IND + rule, IND + left + "  " + right];
}

/** Auditable, dated rate note — the exact per-model rates the numbers used. */
function ratesLines(rep: Report): string[] {
  const models = rep.byModel
    .filter((m) => rep.rates[m.model])
    .map((m) => {
      const rt = rep.rates[m.model]!;
      return `${m.model} $${rt.input}/$${rt.output}${rt.estimated ? "~" : ""}`;
    })
    .join(" · ");
  return [
    IND + subtle(`rates as of ${RATES_AS_OF} (USD per 1M tokens)`),
    IND + subtle(models),
    IND + subtle("cache read ×0.1 · write 5m ×1.25 · write 1h ×2"),
  ];
}

/** Stable redaction alias for a project, by its rank in the report. */
function aliasOf(rep: Report, project: string): string {
  const i = rep.byProject.findIndex((p) => p.project === project);
  if (i < 0) return "project-x";
  return "project-" + (i < 26 ? String.fromCharCode(97 + i) : String(i + 1));
}

function estNote(rep: Report): string[] {
  if (!rep.usedEstimatedPrice) return [];
  return [IND + danger("~est") + subtle(" = no public price; override with --prices <file.json>")];
}

/** Full report — the P1 view. */
export function renderReport(rep: Report, topN = 5, redact = false): string {
  const ins = deriveInsights(rep);
  const blocks: string[][] = [
    wordmark(),
    headerStat(rep),
    [heroLine(ins), heroSplit(rep, ins)],
    burn(rep),
    models(rep, ins),
    projects(rep, ins, topN, redact),
    forecast(ins),
    footer(),
    ratesLines(rep),
    estNote(rep),
  ];
  return "\n" + blocks.filter((b) => b.length).map((b) => b.join("\n")).join("\n\n") + "\n";
}

/** Compact brief — the P2 view. Five labelled rows, figures identical to the full report. */
export function renderBrief(rep: Report, redact = false): string {
  const ins = deriveInsights(rep);
  const top = rep.byProject[0];
  const topModel = rep.byModel[0];
  const label = (s: string) => l(muted(s), 13);
  const rows = [
    label("last " + rep.windowDays + " days") + accent(bold(money(rep.totalCost))) + " " + subtle("total"),
    label("insight") + accent(bold(`${ins.hero.upkeepPct.toFixed(0)}%`)) + " " + fg("context upkeep,") + " " + muted("not intelligence"),
    topModel
      ? label("top model") + fg(topModel.model) + " " + fg(money(topModel.cost)) + " " + subtle(`(${((topModel.cost / rep.totalCost) * 100).toFixed(0)}%)`)
      : "",
    top
      ? label("top project") + fg(redact ? aliasOf(rep, top.project) : shortProject(top.project)) + " " + fg(money(top.cost)) + " " + subtle(`(${top.pct.toFixed(0)}%)`) + (ins.concentration ? " " + danger("▲") : "")
      : "",
    ins.forecastFable > 0
      ? label("forecast") + danger(`~${money(ins.forecastFable)}/mo`) + " " + subtle("Fable credits")
      : label("forecast") + danger(`~${money(ins.forecastAnnual)}/yr`) + " " + subtle("API-equiv"),
  ].filter(Boolean);
  return "\n" + wordmark()[0] + "\n\n" + rows.map((x) => IND + x).join("\n") + "\n";
}
