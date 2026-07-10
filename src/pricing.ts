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

// Public Anthropic sticker prices per 1M tokens (source: claude-api skill,
// cached 2026-06-24). All four are 1M-context models with NO long-context
// premium tier — one flat input/output rate regardless of context size.
// Cache read/write multipliers (0.1x / 1.25x / 2x) are derived in tier().
export const PRICES: Record<string, ModelPrice> = {
  opus: tier(5, 25),
  // Sonnet 5 standard rate. Intro $2/$10 runs through 2026-08-31 — pass
  // --prices to bill the window exactly; standard kept as the stable default.
  sonnet: tier(3, 15),
  haiku: tier(1, 5),
  fable: tier(10, 50),
};

/** When the built-in rates were last sourced. Prices are data with a date, not
 *  eternal constants — they have already changed more than once. Shown in output. */
export const RATES_AS_OF = "2026-06-24";

const ZERO: ModelPrice = tier(0, 0);

/**
 * Collapse a raw model id to a pricing key.
 *   claude-opus-4-8[1m]      -> opus
 *   claude-sonnet-5          -> sonnet
 *   claude-haiku-4-5-2025... -> haiku
 *   claude-fable-5           -> fable
 *   <synthetic>              -> "" (never billed)
 */
export function priceKey(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "";
}

export function priceFor(
  model: string,
  overrides: Record<string, Partial<ModelPrice>> = {},
): ModelPrice {
  const key = priceKey(model);
  // Unknown (non-synthetic) billed model: no public rate. Flag it (~est) so the
  // omission is visible instead of silently understating the total as $0.
  // (<synthetic> is filtered out upstream in parse.ts and never reaches here.)
  if (!key) return { ...ZERO, estimated: true };
  const base = PRICES[key] ?? ZERO;
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
