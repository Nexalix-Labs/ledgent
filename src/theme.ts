/**
 * Ledgent Terminal design tokens → truecolor ANSI.
 *
 * The eight fixed hex tokens from the Ledgent Terminal design spec. Saturated
 * color (accent/success/danger) is reserved for meaning; everything else stays
 * on the cold neutral scale. All escapes are stripped when stdout is not a TTY
 * or NO_COLOR is set — never emit color into a pipe.
 */

export const TOKENS = {
  bg: "#0B0D10", // the void behind everything
  fg: "#F5F7FA", // values, headings, body text
  muted: "#8B8E97", // labels, secondary text
  subtle: "#5A5E66", // footer, captions, separators
  border: "#1F242C", // box-drawing, empty bars ░
  accent: "#0098EA", // key numbers, filled bars ▓, node ●
  success: "#00C896", // savings, positive deltas
  danger: "#EF5A5A", // warnings, concentration ▲, forecast
} as const;

export type Token = keyof typeof TOKENS;
export type Intent = "accent" | "success" | "danger";

// NO_COLOR: presence disables color regardless of value (no-color.org), so test
// membership, not truthiness — NO_COLOR= (empty) must still disable.
const useColor = !!process.stdout.isTTY && !("NO_COLOR" in process.env);

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Alpha-blend `hex` over the terminal background — mirrors the design's rgba(...,0.5) borders. */
export function blend(hex: string, alpha: number, over: string = TOKENS.bg): string {
  const f = hexToRgb(hex);
  const b = hexToRgb(over);
  const mix = (x: number, y: number) => Math.round(x * alpha + y * (1 - alpha));
  const c = { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b) };
  return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Wrap text in a truecolor foreground escape (no-op when color is disabled). */
export function paintHex(hex: string, text: string): string {
  if (!useColor) return text;
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export const paint = (token: Token, text: string): string => paintHex(TOKENS[token], text);

// Token shortcuts.
export const fg = (t: string) => paint("fg", t);
export const muted = (t: string) => paint("muted", t);
export const subtle = (t: string) => paint("subtle", t);
export const border = (t: string) => paint("border", t);
export const accent = (t: string) => paint("accent", t);
export const success = (t: string) => paint("success", t);
export const danger = (t: string) => paint("danger", t);
export const intentColor = (i: Intent) => TOKENS[i];

export function bold(text: string): string {
  return useColor ? `\x1b[1m${text}\x1b[0m` : text;
}

// ── width discipline (80-col) ────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;

/** Printable width, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI, "").length;
}

/** Pad to `w` printable columns; `right` right-aligns. Truncation is never silent — callers keep ≤80. */
export function pad(s: string, w: number, right = false): string {
  const gap = Math.max(0, w - visibleWidth(s));
  return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

/** `▓▓▓░░░` proportion bar: `width` cells, filled accent, empty border. */
export function bar(fraction: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return accent("▓".repeat(filled)) + border("░".repeat(width - filled));
}

// ── number formatting ────────────────────────────────────────────────────────

export function money(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return `${n}`;
}
