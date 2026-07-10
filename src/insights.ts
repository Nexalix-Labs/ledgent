/**
 * Derive the report's insights from the numbers — never hard-coded (Principle V).
 * Some render inline (hero, model spread, concentration); the forecast renders as
 * a callout box.
 */
import type { Report } from "./aggregate.js";
import type { Callout } from "./callout.js";
import { danger, fg, money, muted } from "./theme.js";

export interface HeroInsight {
  upkeepPct: number;
  cacheReadPct: number;
  cacheWritePct: number;
  outputPct: number;
}

export interface ModelSpread {
  hi: string;
  lo: string;
  factor: number;
}

export interface Concentration {
  project: string;
  pct: number;
}

export interface Insights {
  hero: HeroInsight;
  modelSpread?: ModelSpread;
  concentration?: Concentration;
  forecast: Callout;
  /** Fable's projected monthly spend — real usage credits (0 if no Fable use). */
  forecastFable: number;
  /** API-equivalent annual run-rate — a labelled counterfactual, never a bill. */
  forecastAnnual: number;
}

export function deriveInsights(r: Report): Insights {
  const pct = (key: string) => r.buckets.find((b) => b.key === key)?.pct ?? 0;
  const hero: HeroInsight = {
    upkeepPct: r.contextUpkeepPct,
    cacheReadPct: pct("cacheRead"),
    cacheWritePct: pct("cacheWrite1h") + pct("cacheWrite5m"),
    outputPct: pct("output"),
  };

  // Cost-per-1k-turns spread between the priciest and cheapest billed model.
  let modelSpread: ModelSpread | undefined;
  const perK = r.byModel
    .filter((m) => m.turns > 0 && m.cost > 0)
    .map((m) => ({ model: m.model, v: (m.cost / m.turns) * 1000 }));
  if (perK.length >= 2) {
    const hi = perK.reduce((a, b) => (b.v > a.v ? b : a));
    const lo = perK.reduce((a, b) => (b.v < a.v ? b : a));
    if (lo.v > 0 && hi.model !== lo.model) {
      // Compute the factor from the ROUNDED $/1k values shown in the table, so a
      // reader dividing the visible figures reproduces the ×N exactly.
      const hiR = Math.round(hi.v);
      const loR = Math.max(1, Math.round(lo.v));
      modelSpread = { hi: hi.model, lo: lo.model, factor: hiR / loR };
    }
  }

  // A single project holding the majority of spend is a concentration risk.
  const top = r.byProject[0];
  const concentration = top && top.pct > 50 ? { project: top.project, pct: top.pct } : undefined;

  // Forecast: lead with the number that is a real bill, not a model. Fable is
  // billed as usage (not covered by a subscription), so its monthly run-rate is
  // money actually owed; the all-model annual is only an API-equivalent
  // counterfactual and is labelled as such — never presented as a bill.
  const annualEquiv = (r.totalCost / r.windowDays) * 365;
  const fableRow = r.byModel.find((m) => m.model === "fable");
  const fableMonthly = fableRow ? (fableRow.cost / r.windowDays) * 30 : 0;

  const forecast: Callout =
    fableMonthly > 0
      ? {
          intent: "danger",
          title: "forecast",
          lines: [
            fg("Fable is billed as usage, not subscription —"),
            fg("projected real spend:   ") + danger(`~${money(fableMonthly)}/mo`),
            muted(`API-equivalent run-rate:  ~${money(annualEquiv)}/yr`),
          ],
        }
      : {
          intent: "danger",
          title: "forecast",
          lines: [
            fg("API-equivalent run-rate — what these"),
            fg("tokens cost at API rates:   ") + danger(`~${money(annualEquiv)}/yr`),
          ],
        };

  return { hero, modelSpread, concentration, forecast, forecastFable: fableMonthly, forecastAnnual: annualEquiv };
}
