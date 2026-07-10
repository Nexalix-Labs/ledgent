# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Nexalix-Labs/ledgent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nexalix-Labs/ledgent/releases/tag/v0.1.0
