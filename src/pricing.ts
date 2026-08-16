/**
 * Model pricing, USD per 1M tokens.
 *
 * Buckets map 1:1 to Anthropic usage fields, which are mutually exclusive:
 *   input       -> usage.input_tokens                 (fresh, uncached)
 *   output      -> usage.output_tokens
 *   cacheRead   -> usage.cache_read_input_tokens      (0.1x input)
 *   cacheWrite5m-> usage.cache_creation.ephemeral_5m  (1.25x input)
 *   cacheWrite1h-> usage.cache_creation.ephemeral_1h  (2.0x input)
 *
 * Numbers below are public Anthropic tiers where known, flagged `estimated`
 * where the model has no public price. Override any of it with a JSON file
 * passed via `--prices <file>` (same shape, partial allowed).
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  estimated?: boolean;
}

// Derive the four cache/input rates from a base input+output pair.
function tier(input: number, output: number, estimated = false): ModelPrice {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2.0,
    estimated,
  };
}

/**
 * Public Anthropic sticker prices per 1M tokens, keyed `family-version`
 * (source: platform.claude.com/docs/en/about-claude/pricing, read 2026-08-16).
 *
 * The version is part of the key because the rate moves within a family: Sonnet
 * 5 bills $2/$10 while Sonnet 4.6 bills $3/$15, and the retired Opus 4.1 is 3x
 * the current Opus. Collapsing to a bare `sonnet`/`opus` would misprice any log
 * that mixes generations — which every long-lived ~/.claude/projects does.
 *
 * Claude 4.6 and later carry the full 1M context at one flat rate (no
 * long-context premium tier); Haiku 4.5 is a 200K model. Neither affects the
 * math here — context size never changes the per-token price.
 * Cache read/write multipliers (0.1x / 1.25x / 2x) are derived in tier().
 */
export const PRICES: Record<string, ModelPrice> = {
  "fable-5": tier(10, 50),
  "mythos-5": tier(10, 50),
  "opus-5": tier(5, 25),
  "opus-4.8": tier(5, 25),
  "opus-4.7": tier(5, 25),
  "opus-4.6": tier(5, 25),
  "opus-4.5": tier(5, 25),
  "opus-4.1": tier(15, 75),
  "opus-4": tier(15, 75),
  // Sonnet 5's $2/$10 launch rate is now the standard price — the increase to
  // $3/$15 once scheduled for 2026-09-01 was cancelled, not deferred.
  "sonnet-5": tier(2, 10),
  "sonnet-4.6": tier(3, 15),
  "sonnet-4.5": tier(3, 15),
  "sonnet-4": tier(3, 15),
  "haiku-4.5": tier(1, 5),
  "haiku-3.5": tier(0.8, 4),
};

/**
 * Fast mode (`usage.speed === "fast"`, what Claude Code's /fast toggles) is the
 * same model served at higher output speed for double the rate. Opus 5 and 4.8
 * only — every other family keeps its standard rate regardless of the flag.
 */
export const FAST_PRICES: Record<string, ModelPrice> = {
  "opus-5": tier(10, 50),
  "opus-4.8": tier(10, 50),
};

/** When the built-in rates were last sourced. Prices are data with a date, not
 *  eternal constants — they have already changed more than once. Shown in output. */
export const RATES_AS_OF = "2026-08-16";

const ZERO: ModelPrice = tier(0, 0);
const FAST_SUFFIX = ":fast";
const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

/**
 * Split a model id into family + dotted version. Version digits follow the
 * family in modern ids (claude-sonnet-4-5-20250929) and precede it in the 3.x
 * era (claude-3-5-haiku-20241022); an 8-digit run is a release date, not a
 * version. Also parses the keys this module emits, keeping priceKey idempotent.
 */
function split(model: string): { family: string; version: string } | null {
  const parts = model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p && !/^\d{8}$/.test(p));
  const at = parts.findIndex((p) => FAMILIES.includes(p));
  if (at < 0) return null;
  const digits: string[] = [];
  for (let i = at + 1; i < parts.length && /^\d+$/.test(parts[i]!); i++) digits.push(parts[i]!);
  if (!digits.length) {
    for (let i = at - 1; i >= 0 && /^\d+$/.test(parts[i]!); i--) digits.unshift(parts[i]!);
  }
  return { family: parts[at]!, version: digits.join(".") };
}

/** Numeric compare of dotted versions, so 4.10 ranks above 4.9. */
function vcmp(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = Number(x[i] ?? 0) - Number(y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Collapse a raw model id to a pricing key of `family-version`, plus `:fast`
 * for fast mode.
 *   claude-opus-4-8[1m]      -> opus-4.8
 *   claude-sonnet-5          -> sonnet-5
 *   claude-3-5-haiku-2024... -> haiku-3.5
 *   claude-opus-5 (fast)     -> opus-5:fast
 *   runware:100@1            -> "" (not an Anthropic model)
 *   <synthetic>              -> "" (never billed)
 * Idempotent: the report groups rows by this key and then prices each group by
 * feeding the key straight back in, so priceKey(priceKey(x)) === priceKey(x).
 */
export function priceKey(model: string, fast = false): string {
  const p = split(model);
  if (!p) return "";
  const isFast = fast || model.toLowerCase().endsWith(FAST_SUFFIX);
  return p.family + (p.version ? "-" + p.version : "") + (isFast ? FAST_SUFFIX : "");
}

/**
 * Rate for a `family-version` key from one table: exact match, else the nearest
 * catalogued version of that family. A bare family alias (the logs do carry a
 * plain `opus`) reads as the newest; an uncatalogued version takes the nearest
 * older one. Approximations are flagged `estimated`.
 *
 * `clampOldest` decides what happens below the oldest entry. The standard table
 * clamps — a pre-catalogue Sonnet is still a Sonnet. The fast table must not:
 * a model older than the first fast-capable one never had fast mode, so it
 * falls through to its standard rate instead of inheriting a 2x premium.
 */
function lookup(
  table: Record<string, ModelPrice>,
  key: string,
  clampOldest = true,
): ModelPrice | null {
  const exact = table[key];
  if (exact) return exact;
  const dash = key.indexOf("-");
  const family = dash < 0 ? key : key.slice(0, dash);
  const version = dash < 0 ? "" : key.slice(dash + 1);
  const sibs = Object.keys(table)
    .filter((k) => k.startsWith(family + "-"))
    .sort((a, b) => vcmp(a.slice(family.length + 1), b.slice(family.length + 1)));
  if (!sibs.length) return null;
  const older = [...sibs].reverse().find((k) => vcmp(k.slice(family.length + 1), version) <= 0);
  const pick = version ? (older ?? (clampOldest ? sibs[0] : undefined)) : sibs[sibs.length - 1];
  if (!pick) return null;
  return { ...table[pick]!, estimated: true };
}

export function priceFor(
  model: string,
  overrides: Record<string, Partial<ModelPrice>> = {},
  fast = false,
): ModelPrice {
  const key = priceKey(model, fast);
  // Not an Anthropic model — third-party ids do land in these logs. No public
  // rate to apply, so bill nothing and flag it (~est) rather than invent one.
  // (<synthetic> is filtered out upstream in parse.ts and never reaches here.)
  if (!key) return { ...ZERO, estimated: true };
  const isFast = key.endsWith(FAST_SUFFIX);
  const plain = isFast ? key.slice(0, -FAST_SUFFIX.length) : key;
  // Fast mode is an Opus-only premium: no fast tier means standard rate, not a
  // doubled one.
  const base =
    (isFast ? lookup(FAST_PRICES, plain, false) : null) ?? lookup(PRICES, plain) ?? { ...ZERO, estimated: true };
  const ov = overrides[key];
  return ov ? { ...base, ...ov } : base;
}

export interface UsageBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** The five priced components for one record — the single source of the cost formula. */
export interface CostParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Per-bucket USD for one usage record. Summing these IS the record's total cost. */
export function costParts(u: UsageBuckets, p: ModelPrice): CostParts {
  return {
    input: (u.input * p.input) / 1_000_000,
    output: (u.output * p.output) / 1_000_000,
    cacheRead: (u.cacheRead * p.cacheRead) / 1_000_000,
    cacheWrite5m: (u.cacheWrite5m * p.cacheWrite5m) / 1_000_000,
    cacheWrite1h: (u.cacheWrite1h * p.cacheWrite1h) / 1_000_000,
  };
}

/** Cost in USD for one usage record under a given price. */
export function costOf(u: UsageBuckets, p: ModelPrice): number {
  const c = costParts(u, p);
  return c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h;
}
