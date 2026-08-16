/**
 * Pricing catalogue checks.
 *
 * The rate table is the one place where a silent error turns into a wrong
 * dollar figure on every line of every report, so it gets checked against the
 * published numbers rather than against itself. DOC below is transcribed from
 * platform.claude.com/docs/en/about-claude/pricing (read 2026-08-16), including
 * the cache columns — which the docs publish independently of the base rate, so
 * comparing against them verifies the derived 0.1x/1.25x/2x multipliers too.
 *
 * Run with `npm test`. Zero dependencies beyond tsx, already a devDependency.
 */
import { PRICES, FAST_PRICES, RATES_AS_OF, priceKey, priceFor } from "../src/pricing.js";

let fail = 0;
let pass = 0;

// Cache rates are derived (input * 0.1 and friends), so compare at float precision.
const norm = (v: unknown): unknown =>
  typeof v === "number" ? Number(v.toFixed(10)) : Array.isArray(v) ? v.map(norm) : v;

function eq(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(norm(got)) === JSON.stringify(norm(want))) {
    pass++;
    return;
  }
  fail++;
  console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

// --- priceKey: model ids as they actually appear in ~/.claude/projects -------
eq("opus 5", priceKey("claude-opus-5"), "opus-5");
eq("opus 4.8", priceKey("claude-opus-4-8"), "opus-4.8");
eq("opus 4.8 with context suffix", priceKey("claude-opus-4-8[1m]"), "opus-4.8");
eq("sonnet 5", priceKey("claude-sonnet-5"), "sonnet-5");
eq("fable 5", priceKey("claude-fable-5"), "fable-5");
eq("mythos 5", priceKey("claude-mythos-5"), "mythos-5");
eq("dated id drops the release date", priceKey("claude-haiku-4-5-20251001"), "haiku-4.5");
eq("3.x id carries its version first", priceKey("claude-3-5-haiku-20241022"), "haiku-3.5");
eq("3.7 sonnet", priceKey("claude-3-7-sonnet-20250219"), "sonnet-3.7");
eq("opus 4.1", priceKey("claude-opus-4-1-20250805"), "opus-4.1");
eq("proxied id", priceKey("anthropic:claude@opus-4.8"), "opus-4.8");
eq("bare family alias", priceKey("opus"), "opus");
eq("fast flag", priceKey("claude-opus-5", true), "opus-5:fast");

// Third-party ids share these logs and must never inherit an Anthropic rate.
for (const m of ["runware:100@1", "google:4@3", "Qwen3.5-4B-Instruct", "bytedance:seedance@2.0", ""]) {
  eq(`third-party ${m || "<empty>"} has no key`, priceKey(m), "");
}

// --- idempotency ------------------------------------------------------------
// aggregate.ts groups rows by priceKey and then prices each group by feeding
// the key back into priceFor, so the key must be a fixed point.
for (const k of [...Object.keys(PRICES), ...Object.keys(FAST_PRICES).map((k) => k + ":fast")]) {
  eq(`key ${k} is a fixed point`, priceKey(k), k);
  eq(
    `key ${k} round-trips to the same rate`,
    priceFor(k).input,
    priceFor(k.replace(":fast", ""), {}, k.endsWith(":fast")).input,
  );
}

// --- rates vs the published table -------------------------------------------
// [base input, 5m cache write, 1h cache write, cache hit, output] per 1M tokens.
const DOC: Record<string, [number, number, number, number, number]> = {
  "fable-5": [10, 12.5, 20, 1, 50],
  "mythos-5": [10, 12.5, 20, 1, 50],
  "opus-5": [5, 6.25, 10, 0.5, 25],
  "opus-4.8": [5, 6.25, 10, 0.5, 25],
  "opus-4.7": [5, 6.25, 10, 0.5, 25],
  "opus-4.6": [5, 6.25, 10, 0.5, 25],
  "opus-4.5": [5, 6.25, 10, 0.5, 25],
  "opus-4.1": [15, 18.75, 30, 1.5, 75],
  "opus-4": [15, 18.75, 30, 1.5, 75],
  "sonnet-5": [2, 2.5, 4, 0.2, 10],
  "sonnet-4.6": [3, 3.75, 6, 0.3, 15],
  "sonnet-4.5": [3, 3.75, 6, 0.3, 15],
  "sonnet-4": [3, 3.75, 6, 0.3, 15],
  "haiku-4.5": [1, 1.25, 2, 0.1, 5],
  "haiku-3.5": [0.8, 1, 1.6, 0.08, 4],
};

eq("catalogue matches the published model list", Object.keys(PRICES).sort(), Object.keys(DOC).sort());
for (const [k, [input, w5, w1, hit, output]] of Object.entries(DOC)) {
  const p = priceFor(k);
  eq(
    `${k} rates`,
    [p.input, p.cacheWrite5m, p.cacheWrite1h, p.cacheRead, p.output, p.estimated],
    [input, w5, w1, hit, output, false],
  );
}

// --- fast mode: 2x, Opus 5 / 4.8 only ---------------------------------------
const fast = (m: string) => priceFor(m, {}, true);
eq("opus 5 fast doubles", [fast("claude-opus-5").input, fast("claude-opus-5").output], [10, 50]);
eq("opus 4.8 fast doubles", [fast("claude-opus-4-8").input, fast("claude-opus-4-8").output], [10, 50]);
eq("opus 5 fast cache follows the doubled base", fast("claude-opus-5").cacheRead, 1);
// Fast mode does not exist on these; the flag must not invent a premium.
eq("sonnet fast bills standard", [fast("claude-sonnet-5").input, fast("claude-sonnet-5").estimated], [2, false]);
eq("opus 4.6 predates fast mode", fast("claude-opus-4-6").input, 5);
eq("opus 4.7 has no fast tier", fast("claude-opus-4-7").input, 5);

// --- fallbacks, every one flagged estimated ---------------------------------
const est = (m: string, f = false) => [priceFor(m, {}, f).input, priceFor(m, {}, f).estimated];
eq("bare opus takes the newest", est("opus"), [5, true]);
eq("bare sonnet takes the newest", est("sonnet"), [2, true]);
eq("bare fable takes the newest", est("fable"), [10, true]);
eq("uncatalogued newer model takes the nearest older", est("claude-opus-6"), [5, true]);
eq("uncatalogued newer model keeps its fast premium", est("claude-opus-6", true), [10, true]);
eq("pre-catalogue sonnet takes the oldest", est("claude-3-7-sonnet-20250219"), [3, true]);
eq(
  "non-Anthropic model bills nothing, flagged",
  [priceFor("Qwen3.5-4B-Instruct").input, priceFor("Qwen3.5-4B-Instruct").output, priceFor("Qwen3.5-4B-Instruct").estimated],
  [0, 0, true],
);

// --- --prices overrides, keyed as the report prints them --------------------
eq("override by key", priceFor("claude-sonnet-5", { "sonnet-5": { input: 99 } }).input, 99);
eq("override by fast key", priceFor("claude-opus-5", { "opus-5:fast": { output: 7 } }, true).output, 7);
eq("override leaves other rates alone", priceFor("claude-sonnet-5", { "sonnet-5": { input: 99 } }).output, 10);

eq("RATES_AS_OF is stamped", RATES_AS_OF, "2026-08-16");

console.log(
  fail === 0
    ? `pricing: ${pass} checks passed (${Object.keys(DOC).length} models against the published table)`
    : `pricing: ${fail} of ${fail + pass} checks FAILED`,
);
process.exit(fail === 0 ? 0 : 1);
