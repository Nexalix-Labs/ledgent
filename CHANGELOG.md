# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] — 2026-08-16

### Fixed

- **render:** The rates footer wraps instead of overrunning the report. One
  entry per model made that line 87 columns once the keys carried versions,
  against a 60-column layout, so the terminal broke it wherever it landed —
  usually through the middle of a rate. (0358202)

### Docs

- The README screenshot is captured from a 0.2.x report. The old one was taken
  on 0.1.0 and showed bare `opus`/`sonnet` rows with Sonnet at $3/$15 — the
  pricing this line of releases exists to correct. (1edb7d0)

## [0.2.1] — 2026-08-16

No functional change from 0.2.0. This is the first release to actually reach
npm, so `npm install -g @nexalix/ledgent` finally picks up 0.2.0's pricing
corrections — Sonnet 5 at $2/$10, per-version rates, fast-mode billing. If you
already run 0.2.0 from the GitHub release channel, there is nothing new here.

### Fixed

- **release:** npm publishing authenticates with trusted publishing (OIDC)
  rather than an `NPM_TOKEN` secret that was never configured — v0.2.0 reported
  a green run while `npm publish` died on `ENEEDAUTH`, leaving npm on 0.1.0.
  The publish step no longer runs under `continue-on-error`, so a broken
  publish is visible instead of masked, and npm now attaches a provenance
  attestation to the package. (646212e)

## [0.2.0] — 2026-08-16

### ⚠ Breaking

- **pricing:** `--prices` override files are keyed the way the rates footer
  prints them (`opus-5`, `sonnet-4.6`, `opus-5:fast`) instead of the four bare
  family names, so an existing override file no longer matches and needs its
  keys updated. (37349d8)
- The parse cache is bumped to v2 — v1 entries predate the fast-mode flag and
  would read back as standard speed, so the first run after upgrading re-parses
  the session logs once. (37349d8)

### Added

- **pricing:** Fast mode is billed. `usage.speed` is read from the session logs,
  and an Opus 5 / 4.8 fast turn — what Claude Code's `/fast` toggles — is priced
  at its $10/$50 premium on its own `opus-5:fast` row. Fast mode is the same
  model served faster, so it costs 2× while a report previously charged half of
  what such a turn was worth. (37349d8)
- **pricing:** A per-version rate catalogue keyed `family-version` (`opus-5`,
  `sonnet-4.6`, `haiku-3.5`, …), covering every model on the published pricing
  page including the retired ones. Rates are keyed by version because the price
  moves within a family, which the previous bare `opus`/`sonnet` keys could not
  express. (37349d8)
- `npm run verify` plus `test/pricing.test.ts` — 85 checks of the catalogue
  against the published rate table, including its independently published cache
  columns, which verifies the derived 0.1×/1.25×/2× multipliers rather than
  restating them. (37349d8)

### Fixed

- **pricing:** Sonnet 5 is billed at $2/$10 rather than $3/$15. Its launch rate
  became the standard price and the increase once scheduled for 2026-09-01 was
  cancelled, so every report covering Sonnet 5 turns was overstating them by
  50%. (37349d8)
- **pricing:** Opus 4.1 and Opus 4 ($15/$75) and Haiku 3.5 ($0.80/$4) are billed
  at their own published rates instead of inheriting the current generation's —
  a retired Opus turn was priced at a third of its real cost. (37349d8)
- **pricing:** A model with no catalogued rate falls back to the nearest version
  of its family, still flagged `~est`, instead of being silently billed as $0.
  Built-in rates refreshed 2026-06-24 → 2026-08-16. (37349d8)

## [0.1.0] — 2026-07-10

### Added
- **`ledgent report`** — an honest terminal cost report built from the Claude
  Code session logs already on disk, with zero API calls and zero network.
- **Five-bucket pricing** — every billable event priced across fresh input, cache
  read (0.1×), cache write 5m (1.25×), cache write 1h (2×) and output at published
  per-model rates, guaranteed to reconcile to the reported total.
- **Report sections** — a context-upkeep hero, THE BURN (cost by bucket), BY MODEL
  (with a `×N` cost-per-turn spread), BY PROJECT (with a concentration marker) and
  a FORECAST callout, rendered to the Ledgent Terminal design (JetBrains Mono, 80
  columns, an eight-colour palette, box-drawing callouts, `NO_COLOR`-aware).
- **Flags** — `--brief`, `--json`, `--days`/`--all`, `--project`, `--top`,
  `--prices`, `--root`, `--version`, `--no-update-check`.
- **Over-the-air self-update** — `ledgent upgrade` plus a detached background
  auto-update for the self-contained install, gated by sha256 (and an optional
  ed25519 signature), applied atomically with a `.bak` rollback. Fail-open,
  throttled, opt-out.
- **Distribution** — self-contained installers (`install.sh`, `install.ps1`), the
  `@nexalix/ledgent` npm package, and a tag-triggered GitHub Actions release
  pipeline that builds, bundles, checksums, signs and publishes.

[Unreleased]: https://github.com/Nexalix-Labs/ledgent/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Nexalix-Labs/ledgent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Nexalix-Labs/ledgent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Nexalix-Labs/ledgent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nexalix-Labs/ledgent/releases/tag/v0.1.0
