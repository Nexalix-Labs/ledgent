/**
 * The Ledgent callout — one box-drawing frame, three intents.
 *
 * Same geometry every time; only the border hue (tinted per intent at 0.5 alpha)
 * and the label change with meaning:
 *   accent  → neutral finding ("what is happening")
 *   success → a saving or recommendation that reduces spend
 *   danger  → a risk (concentration, cost warning, forecast)
 *
 * The framed number is the payload; the title states the kind. Pure string out.
 */
import { blend, intentColor, paintHex, visibleWidth, type Intent } from "./theme.js";

export interface Callout {
  intent: Intent;
  title: string; // e.g. "insight", "savings", "forecast" — rendered UPPER + letter-spaced
  lines: string[]; // already-colored body lines (payload numbers in intent color)
}

const WIDTH = 60; // total frame width incl. borders — within the 80-col budget
const INNER = WIDTH - 2; // content columns between │ … │

/** Letter-space a title the way the design does: "FORECAST" → "F O R E C A S T". */
function spaceTitle(title: string): string {
  return title.toUpperCase().split("").join(" ");
}

export function renderCallout(c: Callout): string {
  const borderHex = blend(intentColor(c.intent), 0.5);
  const b = (s: string) => paintHex(borderHex, s);

  const label = ` ${spaceTitle(c.title)} `;
  // top:  ┌─<label>─…─┐   (one dash before the label, dashes fill the rest)
  const topFill = Math.max(0, INNER - 1 - visibleWidth(label));
  const top = b(`┌─${label}${"─".repeat(topFill)}┐`);
  const bottom = b(`└${"─".repeat(INNER)}┘`);
  const blank = b("│") + " ".repeat(INNER) + b("│");

  const body = c.lines.map((line) => {
    const gap = Math.max(0, INNER - 2 - visibleWidth(line)); // 2 = leading "  "
    return b("│") + "  " + line + " ".repeat(gap) + b("│");
  });

  return [top, blank, ...body, blank, bottom].join("\n");
}
