#!/bin/sh
# Ledgent self-contained installer — downloads the latest release bundle from
# GitHub, verifies its sha256 in a temp file, and only then places it under
# ~/.ledgent/bin. Same download → verify → atomic-place model as the updater.
#
#   curl -fsSL https://raw.githubusercontent.com/Nexalix-Labs/ledgent/main/install.sh | sh
set -eu

REPO="Nexalix-Labs/ledgent"
DIR="${HOME}/.ledgent/bin"
API="https://api.github.com/repos/${REPO}/releases/latest"

command -v node >/dev/null 2>&1 || { echo "ledgent needs Node.js (>=18) on PATH." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ledgent installer needs curl." >&2; exit 1; }

mkdir -p "$DIR"
tmp_bundle="${DIR}/.ledgent.mjs.$$.tmp"
tmp_sums="${DIR}/.SHA256SUMS.$$.tmp"
# Never leave an unverified partial at the trusted path.
trap 'rm -f "$tmp_bundle" "$tmp_sums"' EXIT INT TERM

json=$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")
url_for() {
  # exact-name match (dot escaped), https only
  printf '%s' "$json" \
    | grep -oE "\"browser_download_url\": *\"https://[^\"]*/$1\"" \
    | head -1 | sed -E 's/.*"(https:[^"]*)".*/\1/'
}
bundle_url=$(url_for "ledgent\\.mjs")
sums_url=$(url_for "SHA256SUMS")
[ -n "$bundle_url" ] && [ -n "$sums_url" ] || { echo "no published release found for ${REPO}." >&2; exit 1; }

# Only trust GitHub-hosted release assets.
for u in "$bundle_url" "$sums_url"; do
  case "$u" in
    https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) : ;;
    *) echo "unexpected download host: $u — aborting." >&2; exit 1 ;;
  esac
done

curl -fsSL "$bundle_url" -o "$tmp_bundle"
curl -fsSL "$sums_url" -o "$tmp_sums"

# Verify the temp bundle against the ledgent.mjs digest BEFORE placing it.
want=$(grep -E "^[0-9a-f]{64}[[:space:]]+\\*?ledgent\\.mjs$" "$tmp_sums" | head -1 | awk '{print $1}')
[ -n "$want" ] || { echo "no ledgent.mjs entry in SHA256SUMS." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp_bundle" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp_bundle" | awk '{print $1}')
else echo "no sha256 tool (sha256sum/shasum) available." >&2; exit 1
fi
[ "$want" = "$got" ] || { echo "checksum verification FAILED — aborting." >&2; exit 1; }

mv "$tmp_bundle" "${DIR}/ledgent.mjs"

# Launcher shim on PATH.
cat > "${DIR}/ledgent" <<EOF
#!/bin/sh
exec node "${DIR}/ledgent.mjs" "\$@"
EOF
chmod +x "${DIR}/ledgent"

echo "ledgent installed to ${DIR}/ledgent"
case ":${PATH}:" in
  *":${DIR}:"*) : ;;
  *) echo "Add it to your PATH:  export PATH=\"\$HOME/.ledgent/bin:\$PATH\"" ;;
esac
