/**
 * Single source of the installed version and the pinned update repo.
 * VERSION is bumped in lockstep with package.json on release (see the release
 * workflow). Keeping it a compile-time constant makes the bundle self-describing
 * without reading package.json at runtime.
 */
export const VERSION = "0.2.0";

/** Pinned GitHub repo the OTA updater trusts. Never resolved from user input. */
export const REPO = "Nexalix-Labs/ledgent";

/**
 * Ed25519 public key (PEM / SPKI) used to verify release signatures.
 * Empty string = signing not yet enabled → the updater falls back to the
 * sha256-only transport-integrity gate (an accepted, documented risk). Once a
 * key is set here AND CI signs SHA256SUMS into SHA256SUMS.sig, the signature
 * becomes the load-bearing apply gate: an unsigned/invalid release is refused.
 *
 * Generate offline (private key kept as the CI SIGNING_KEY secret, never here):
 *   openssl genpkey -algorithm ed25519 -out ledgent_signing_key.pem
 *   openssl pkey -in ledgent_signing_key.pem -pubout   # paste the PEM below
 */
export const PUBKEY = "";
