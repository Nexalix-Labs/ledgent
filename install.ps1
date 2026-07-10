# Ledgent self-contained installer (Windows) — downloads the latest release
# bundle from GitHub, verifies its sha256 in a temp file, and only then places
# it under %USERPROFILE%\.ledgent\bin. Same trust model as the built-in updater.
#
#   irm https://raw.githubusercontent.com/Nexalix-Labs/ledgent/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "Nexalix-Labs/ledgent"
$dir = Join-Path $HOME ".ledgent\bin"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "ledgent needs Node.js (>=18) on PATH."
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "ledgent-cli"; Accept = "application/vnd.github+json" }
$bundle = ($rel.assets | Where-Object name -eq "ledgent.mjs").browser_download_url
$sums = ($rel.assets | Where-Object name -eq "SHA256SUMS").browser_download_url
if (-not $bundle -or -not $sums) { Write-Error "no published release found for $repo." }

# Only trust GitHub-hosted release assets.
foreach ($u in @($bundle, $sums)) {
  if ($u -notmatch '^https://(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)/') {
    Write-Error "unexpected download host: $u — aborting."
  }
}

$tmpBundle = Join-Path $dir (".ledgent.mjs." + [guid]::NewGuid().ToString() + ".tmp")
$tmpSums = Join-Path $dir (".SHA256SUMS." + [guid]::NewGuid().ToString() + ".tmp")
try {
  Invoke-WebRequest $bundle -OutFile $tmpBundle -UseBasicParsing
  Invoke-WebRequest $sums -OutFile $tmpSums -UseBasicParsing

  # Match the SHA256SUMS line for ledgent.mjs by name, then verify BEFORE placing.
  $line = Get-Content $tmpSums | Where-Object { $_ -match '^\s*[0-9a-fA-F]{64}\s+\*?ledgent\.mjs\s*$' } | Select-Object -First 1
  if (-not $line) { Write-Error "no ledgent.mjs entry in SHA256SUMS." }
  $want = ($line.Trim() -split '\s+')[0].ToLower()
  $got = (Get-FileHash $tmpBundle -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) { Write-Error "checksum verification FAILED — aborting." }

  Move-Item $tmpBundle (Join-Path $dir "ledgent.mjs") -Force
}
finally {
  Remove-Item $tmpBundle, $tmpSums -Force -ErrorAction SilentlyContinue
}

# Launcher shim (ledgent.cmd) on PATH.
$shim = Join-Path $dir "ledgent.cmd"
$mjs = Join-Path $dir "ledgent.mjs"
Set-Content -Path $shim -Value "@echo off`r`nnode `"$mjs`" %*" -Encoding ASCII

Write-Host "ledgent installed to $shim"
if (($env:Path -split ';') -notcontains $dir) {
  Write-Host "Add it to your PATH:  setx PATH `"$dir;%PATH%`""
}
