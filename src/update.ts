/**
 * Over-the-air self-update — the Claude Code model.
 *
 * On a normal run we fire a *detached* background process (`ledgent __update`)
 * that checks GitHub, verifies the release, and atomically swaps the installed
 * bundle. The current run is never blocked or re-exec'd; the new bundle takes
 * effect on the next invocation, which prints a one-line "updated to X" notice.
 * Fully opt-out, throttled, and fail-open.
 *
 * Security posture (this path auto-executes downloaded code, so it is strict):
 *  - Transport: HTTPS only, host allowlist, redirect target still on GitHub.
 *  - Bounded: every download has a wall-clock deadline covering the body AND a
 *    byte cap, so a stalled/oversized response can never hang or exhaust memory.
 *  - Throttle claimed BEFORE any network I/O, atomically (temp+rename), so a
 *    stuck child can never defeat the 24h throttle into a fork/RSS pileup.
 *  - Apply gate: if a signing key is configured (version.ts PUBKEY), the release
 *    SHA256SUMS must carry a valid ed25519 signature; otherwise the sha256 of the
 *    bundle must match SHA256SUMS (transport integrity — a documented accepted
 *    risk until signing is enabled). A bundle is NEVER written on any mismatch.
 *  - Writes are atomic (unpredictable temp, O_EXCL, rename) and reversible (.bak).
 *  - Auto-apply only for the self-contained install under ~/.ledgent/bin; npm and
 *    dev installs are never self-replaced. Major-version jumps require `upgrade`.
 *
 * Zero runtime dependencies: node:fs, node:crypto, node:child_process, fetch.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, createPublicKey, randomUUID, verify as edVerify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PUBKEY, REPO, VERSION } from "./version.js";

const STATE_DIR = join(homedir(), ".ledgent");
const STATE_FILE = join(STATE_DIR, "state.json");
const SELF_DIR = join(STATE_DIR, "bin");
const BUNDLE_NAME = "ledgent.mjs";
const SUMS_NAME = "SHA256SUMS";
const SIG_NAME = "SHA256SUMS.sig";
const TARGET = join(SELF_DIR, BUNDLE_NAME);
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NET_TIMEOUT_MS = 8000;
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
]);
const CAP_META = 1 << 20; // 1 MiB — API JSON / SHA256SUMS / signature
const CAP_BUNDLE = 12 << 20; // 12 MiB — the bundle (real size ~32 KiB)

interface State {
  lastCheck?: number;
  latestKnown?: string;
  lastSeenVersion?: string;
  autoUpdate?: boolean;
}

// ── state (atomic writes) ───────────────────────────────────────────────────

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(s: State): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = join(STATE_DIR, `.state-${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(s), { flag: "wx" });
    renameSync(tmp, STATE_FILE);
  } catch {
    /* best-effort */
  }
}

// ── install detection ────────────────────────────────────────────────────────

function selfPath(): string {
  const p = process.argv[1] ?? "";
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export type InstallKind = "self" | "npm" | "dev";

export function installKind(): InstallKind {
  const p = selfPath().replace(/\\/g, "/");
  const self = SELF_DIR.replace(/\\/g, "/");
  // Match only true children of ~/.ledgent/bin/ — not sibling dirs like bin-old.
  if (p === `${self}/${BUNDLE_NAME}` || p.startsWith(`${self}/`)) return "self";
  if (p.includes("/node_modules/") || p.includes("/.bin/") || /\/npm(\/|$)/.test(p)) return "npm";
  return "dev";
}

/**
 * Auto-update is OFF by default — the report path makes ZERO network calls.
 * Trust-positive by design (rustup/brew/gh model): updates are manual via
 * `ledgent update`, or opt in to background auto-update per-user with
 * `ledgent update --auto on` (persisted) or LEDGENT_AUTO_UPDATE=1.
 */
export function autoEnabled(): boolean {
  if ("LEDGENT_NO_UPDATE" in process.env || "CI" in process.env) return false;
  if (process.env.LEDGENT_AUTO_UPDATE === "1") return true;
  return readState().autoUpdate === true;
}

export function setAutoUpdate(on: boolean): void {
  const s = readState();
  s.autoUpdate = on;
  writeState(s);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise<string>((res) => rl.question(question, res));
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

// ── semver (tiny, X.Y.Z only) ──────────────────────────────────────────────────

function parse(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function gt(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function sameMajor(a: string, b: string): boolean {
  return parse(a)[0] === parse(b)[0];
}

// ── bounded, allowlisted network (fail-open) ────────────────────────────────────

function okUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && ALLOWED_HOSTS.has(x.hostname);
  } catch {
    return false;
  }
}

/** HTTPS GET to an allowlisted host, bounded by a wall-clock deadline covering the
 *  body AND a byte cap. Returns the body or null on any failure/oversize/timeout. */
async function fetchBounded(url: string, cap: number): Promise<Buffer | null> {
  if (!okUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "ledgent-cli", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    // Re-validate the FINAL url after any redirects — the body is served from here,
    // so an off-allowlist redirect target is rejected even though follow is enabled.
    if (!okUrl(res.url)) return null;
    if (!res.body) return null; // a 200 carrying a payload always exposes a body
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  } catch {
    return null; // abort, network error, malformed — all fail-open
  } finally {
    clearTimeout(timer);
  }
}

interface Latest {
  version: string;
  bundleUrl: string;
  sumsUrl: string;
  sigUrl?: string;
}

async function fetchLatest(): Promise<Latest | null> {
  const buf = await fetchBounded(API, CAP_META);
  if (!buf) return null;
  let j: any;
  try {
    j = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  const version = String(j?.tag_name ?? "").replace(/^v/, "");
  if (!version) return null;
  const assets: any[] = Array.isArray(j?.assets) ? j.assets : [];
  const urlOf = (name: string): string | undefined => {
    const a = assets.find((x) => x?.name === name);
    const u = a?.browser_download_url;
    return typeof u === "string" && okUrl(u) ? u : undefined;
  };
  const bundleUrl = urlOf(BUNDLE_NAME);
  const sumsUrl = urlOf(SUMS_NAME);
  if (!bundleUrl || !sumsUrl) return null;
  return { version, bundleUrl, sumsUrl, sigUrl: urlOf(SIG_NAME) };
}

// ── verification ─────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Verify an ed25519 signature (base64) over `data` against the pinned PUBKEY. */
function verifySignature(data: Buffer, sigB64: string): boolean {
  if (!PUBKEY) return false;
  try {
    const key = createPublicKey(PUBKEY);
    return edVerify(null, data, key, Buffer.from(sigB64.trim(), "base64"));
  } catch {
    return false;
  }
}

/** Parse `<sha256>  <name>` lines; return the digest for `name`, or null. */
function expectedSum(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && (m[2] ?? "").trim() === name) return (m[1] ?? "").toLowerCase();
  }
  return null;
}

// ── apply (verified, atomic, reversible) ────────────────────────────────────────

async function fetchVerifyApply(latest: Latest): Promise<string | null> {
  const sumsBuf = await fetchBounded(latest.sumsUrl, CAP_META);
  if (!sumsBuf) return null;

  // If signing is enabled, the signature over SHA256SUMS is the apply gate.
  if (PUBKEY) {
    if (!latest.sigUrl) return null; // signing required but release is unsigned — refuse
    const sigBuf = await fetchBounded(latest.sigUrl, CAP_META);
    if (!sigBuf || !verifySignature(sumsBuf, sigBuf.toString("utf8"))) return null;
  }

  const want = expectedSum(sumsBuf.toString("utf8"), BUNDLE_NAME);
  if (!want) return null;
  const bundle = await fetchBounded(latest.bundleUrl, CAP_BUNDLE);
  if (!bundle) return null;
  if (sha256(bundle) !== want) return null; // integrity gate — never apply on mismatch

  mkdirSync(SELF_DIR, { recursive: true });
  const tmp = join(SELF_DIR, `.ledgent-${randomUUID()}.tmp`);
  const bak = TARGET + ".bak";
  writeFileSync(tmp, bundle, { flag: "wx" }); // exclusive create — no predictable-name TOCTOU
  try {
    if (existsSync(TARGET)) copyFileSync(TARGET, bak);
    renameSync(tmp, TARGET); // atomic on same filesystem
    return latest.version;
  } catch (e) {
    try {
      if (existsSync(bak)) copyFileSync(bak, TARGET); // roll back
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(tmp)) rmSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ── public surface ──────────────────────────────────────────────────────────────

/** Fire a detached background updater if eligible. Returns immediately; never blocks. */
export function spawnBackgroundUpdate(): void {
  // Opt-in only. Default is manual + zero network. Self-contained install + TTY.
  if (!autoEnabled() || !process.stdout.isTTY) return;
  if ("LEDGENT_UPDATED" in process.env) return; // never re-spawn from the child
  if (installKind() !== "self") return; // npm/dev are never self-replaced
  const state = readState();
  if (state.lastCheck && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) return; // throttle
  // Claim the throttle slot before spawning to narrow the window where concurrent
  // runs fork off the same stale timestamp. Blast radius is bounded anyway: each
  // child re-claims before any network and is deadline- and size-capped.
  state.lastCheck = Date.now();
  writeState(state);
  try {
    const child = spawn(process.execPath, [selfPath(), "__update"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LEDGENT_UPDATED: "1" }, // marks the child so it never re-spawns
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/** The hidden `__update` subcommand body — runs in the detached child. Silent, fail-open. */
export async function runBackgroundUpdate(): Promise<void> {
  try {
    const state = readState();
    state.lastCheck = Date.now();
    writeState(state); // persist the throttle stamp BEFORE any network I/O
    const latest = await fetchLatest();
    if (!latest) return;
    state.latestKnown = latest.version;
    writeState(state);
    if (!gt(latest.version, VERSION)) return; // already current
    if (installKind() !== "self") return; // npm/dev: notice only, never self-replace
    if (!sameMajor(latest.version, VERSION)) return; // major jump: explicit `upgrade` only
    await fetchVerifyApply(latest); // new bundle is picked up next run
  } catch {
    /* fail-open — never disrupt */
  }
}

/** Print a one-line notice on the first run after a background self-update, once. */
export function noticeIfUpdated(write: (s: string) => void): void {
  const state = readState();
  const kind = installKind();
  if (kind === "self") {
    if (state.lastSeenVersion && gt(VERSION, state.lastSeenVersion)) {
      write(`updated to ${VERSION}`);
    }
    if (state.lastSeenVersion !== VERSION) {
      state.lastSeenVersion = VERSION;
      writeState(state);
    }
  } else if (kind === "npm" && state.latestKnown && gt(state.latestKnown, VERSION)) {
    write(`${state.latestKnown} available — run: npm i -g @nexalix/ledgent@latest`);
  }
}

/**
 * Explicit `ledgent update` — the ONLY command that reaches the network, and
 * only when the user runs it. Shows the target version + release-notes link,
 * asks for confirmation, then verifies and applies. Any version incl. major.
 */
export async function updateCommand(
  out: (s: string) => void,
  err: (s: string) => void,
  opts: { yes?: boolean } = {},
): Promise<number> {
  const kind = installKind();
  const latest = await fetchLatest();
  if (!latest) {
    err("could not reach GitHub to check for updates");
    return 1;
  }
  if (!gt(latest.version, VERSION)) {
    out(`already on the latest version (${VERSION})`);
    return 0;
  }
  out(`update available: ${VERSION} → ${latest.version}`);
  out(`release notes: https://github.com/${REPO}/releases/tag/v${latest.version}`);
  if (kind !== "self") {
    out("run: npm i -g @nexalix/ledgent@latest");
    return 0;
  }
  if (!opts.yes && !(await confirm("apply this update? [y/N] "))) {
    out("cancelled.");
    return 0;
  }
  out("updating …");
  try {
    const applied = await fetchVerifyApply(latest);
    if (!applied) {
      err("update failed: signature/checksum mismatch or network error");
      return 1;
    }
    out(`installed ${applied} — active on next run`);
    return 0;
  } catch (e) {
    err(`update failed: ${(e as Error).message}`);
    return 1;
  }
}
