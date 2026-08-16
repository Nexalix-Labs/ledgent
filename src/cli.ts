#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { collect, defaultRoot } from "./parse.js";
import { buildReport } from "./aggregate.js";
import { renderReport, renderBrief } from "./render.js";
import { autoEnabled, noticeIfUpdated, runBackgroundUpdate, setAutoUpdate, spawnBackgroundUpdate, updateCommand } from "./update.js";
import { VERSION } from "./version.js";
import type { ModelPrice } from "./pricing.js";

interface Args {
  cmd: string;
  days: number | null; // null = all time
  project?: string;
  json: boolean;
  brief: boolean;
  prices?: string;
  root?: string;
  top: number;
  help: boolean;
  version: boolean;
  noUpdateCheck: boolean;
  yes: boolean;
  redact: boolean;
  autoSet?: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "report", days: 30, json: false, brief: false, top: 5, help: false, version: false, noUpdateCheck: false, yes: false, redact: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) a.cmd = rest.shift() as string;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    switch (t) {
      case "--all":
        a.days = null;
        break;
      case "--days":
        a.days = Number(rest[++i]);
        break;
      case "--project":
      case "-p":
        a.project = rest[++i];
        break;
      case "--json":
        a.json = true;
        break;
      case "--brief":
        a.brief = true;
        break;
      case "--redact":
        a.redact = true;
        break;
      case "--no-update-check":
        a.noUpdateCheck = true;
        break;
      case "--yes":
      case "-y":
        a.yes = true;
        break;
      case "--auto":
        a.autoSet = (rest[++i] ?? "").toLowerCase() === "on";
        break;
      case "--version":
      case "-v":
        a.version = true;
        break;
      case "--prices":
        a.prices = rest[++i];
        break;
      case "--root":
        a.root = rest[++i];
        break;
      case "--top":
        a.top = Number(rest[++i]);
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
      default:
        process.stderr.write(`unknown option: ${t}\n`);
    }
  }
  return a;
}

const HELP = `ledgent — every token accounted for

Local cost report for AI coding agents. Reads sessions already on disk.
Zero API calls, zero network.

Usage
  ledgent report [options]
  ledgent update             check GitHub & install the latest (asks first)
  ledgent update --auto on   opt in to background auto-update (default: off)

By default ledgent makes zero network calls — only 'ledgent update' reaches
the network, and only when you run it.

Options
  --brief           five-line summary
  --redact          replace project names with project-a/b/c (shareable)
  --no-update-check skip the auto-update check for this run
  --days <n>        window in days (default 30)
  --all             ignore the window, scan everything
  --project <str>   only sessions whose path contains <str>   (-p)
  --top <n>         projects to list in the full report (default 5)
  --prices <file>   JSON price overrides, keyed as in the rates footer
                    (opus-5, sonnet-4.6, opus-5:fast, ...)
  --root <dir>      session log root (default ${defaultRoot()})
  --json            machine-readable output
  --version         print version                              (-v)
  --help            this text                                 (-h)`;

async function loadOverrides(file?: string): Promise<Record<string, Partial<ModelPrice>>> {
  if (!file) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    process.stderr.write(`could not read --prices ${file}: ${(e as Error).message}\n`);
    return {};
  }
  // Validate before use — a stray string/array would make `tokens * rate` NaN and
  // silently poison every figure (Principle II). Reject bad entries loudly.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    process.stderr.write(`--prices ${file}: expected a JSON object keyed by model\n`);
    return {};
  }
  const out: Record<string, Partial<ModelPrice>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      process.stderr.write(`--prices ${file}: "${key}" must be an object of numeric rates — skipped\n`);
      continue;
    }
    const rates: Record<string, number> = {};
    let ok = true;
    for (const [field, v] of Object.entries(val as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        process.stderr.write(`--prices ${file}: "${key}.${field}" is not a finite number — skipped\n`);
        ok = false;
        break;
      }
      rates[field] = v;
    }
    if (ok) out[key] = rates as Partial<ModelPrice>;
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  // Hidden subcommand: the detached background updater (spawned by a prior run).
  if (a.cmd === "__update") {
    await runBackgroundUpdate();
    return;
  }
  if (a.version) {
    process.stdout.write(`${VERSION} (Nexalix Ledgent)\n`);
    return;
  }
  if (a.help || a.cmd === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (a.cmd === "update" || a.cmd === "upgrade") {
    if (a.autoSet !== undefined) {
      setAutoUpdate(a.autoSet);
      process.stdout.write(`  auto-update ${a.autoSet ? "enabled" : "disabled"}\n`);
      return;
    }
    process.exitCode = await updateCommand(
      (s) => process.stdout.write("  " + s + "\n"),
      (s) => process.stderr.write("  " + s + "\n"),
      { yes: a.yes },
    );
    return;
  }
  if (a.cmd !== "report") {
    process.stderr.write(`unknown command: ${a.cmd}\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }
  // Guard numeric flags: a non-numeric --days/--top yields NaN, which would
  // otherwise produce a misleading empty report instead of an error.
  if ((a.days !== null && !Number.isFinite(a.days)) || !Number.isFinite(a.top)) {
    process.stderr.write("error: --days and --top require a numeric value\n");
    process.exitCode = 2;
    return;
  }

  const since = a.days === null ? undefined : new Date(Date.now() - a.days * 86400000);
  const overrides = await loadOverrides(a.prices);

  const t0 = Date.now();
  const { records, filesScanned, parseErrors } = await collect({
    root: a.root,
    since,
    projectFilter: a.project,
  });
  // topSessions capped at 10 for --json consumers; projects display uses --top.
  const report = buildReport(records, overrides, 10);

  if (a.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  if (records.length === 0) {
    const root = a.root ?? defaultRoot();
    if (filesScanned === 0) {
      process.stdout.write(
        `\n  No Claude Code sessions found at\n    ${root}\n` +
          `  ledgent reads local session logs — nothing to scan yet.\n\n`,
      );
    } else {
      process.stdout.write(
        `\n  Scanned ${filesScanned} files at\n    ${root}\n` +
          `  but found no billable usage in this window. Try --all or --days <n>.\n\n`,
      );
    }
    return;
  }

  process.stdout.write(a.brief ? renderBrief(report, a.redact) : renderReport(report, a.top, a.redact));
  process.stderr.write(
    `  scanned ${filesScanned} files in ${Date.now() - t0}ms` +
      (parseErrors ? `, ${parseErrors} unparseable lines\n` : "\n"),
  );

  // Auto-update is opt-in (`ledgent update --auto on`). Off by default, so the
  // report path makes zero network calls unless the user asked for auto-update.
  if (autoEnabled() && !a.noUpdateCheck) {
    noticeIfUpdated((m) => process.stderr.write(`  ● ${m}\n`));
    spawnBackgroundUpdate();
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
