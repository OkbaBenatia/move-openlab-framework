# MOVE OpenLab installer for Windows - installs MOVE OpenLab @VERSION@ into the current (empty) folder.
#
#   irm https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v@VERSION@/install.ps1 -OutFile install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# ("-ExecutionPolicy Bypass" applies to this one PowerShell process only: it lets it run this downloaded script and
# changes no system setting.) What it does, in this order - nothing outside this folder, the data folder and your
# own user settings is changed, and it asks before installing anything:
#   1. checks Windows (10 or 11, 64-bit) and finds Python 3.11 or newer (offers to install it for your user only with
#      winget, Microsoft's package manager, if it is missing);
#   2. downloads move-openlab-@VERSION@.zip from the same GitHub release and refuses it unless its SHA-256 is
#      @ARCHIVE_SHA256@ (the value built into this installer);
#   3. creates app\ (the application) and venv\ (its Python environment) here; Python packages are installed
#      from requirements\install.lock with --require-hashes (every file checked against its pinned SHA-256);
#   4. registers MOVE OpenLab as a background task of your user account (Task Scheduler, at sign-in, restarted after
#      a crash), adds "MOVE OpenLab" to the Start menu and opens the first-run page in your browser.
# Your data (accounts, experiments, results) lives in %LOCALAPPDATA%\MOVE OpenLab\data and is kept by updates and by
# uninstalling. Uploaded method plug-ins are not available on Windows (their sandbox needs Linux); built-in methods are.
#
# Options: -Yes -Port N -DataDir DIR -NoBrowser -NoLauncher -NoAutostart -Archive FILE (already downloaded; still checked)
[CmdletBinding()]
param([switch]$Yes, [int]$Port = 0, [string]$DataDir = "", [switch]$NoBrowser, [switch]$NoLauncher, [switch]$NoAutostart,
      [string]$Archive = "")
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Version = '@VERSION@'
$ArchiveSha256 = '@ARCHIVE_SHA256@'
$ArchiveName = "move-openlab-$Version.zip"
$ReleaseUrl = if ($env:MOVE_OPENLAB_RELEASE_URL) { $env:MOVE_OPENLAB_RELEASE_URL } else { "https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v$Version" }
$Here = (Get-Location).ProviderPath
$Log = Join-Path $Here 'install.log'

function Say($m) { Write-Host "> $m" -ForegroundColor Cyan; Add-Content -Path $Log -Value "$(Get-Date -Format s) $m" }
function Fail($m) { Write-Host "error: $m" -ForegroundColor Red; Add-Content -Path $Log -Value "$(Get-Date -Format s) error: $m"; exit 1 }
function Invoke-Logged($exe, [string[]]$argv) {
  # native programs write progress to stderr; Windows PowerShell 5.1 would turn that into errors: log it instead
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @argv *>> $Log } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}
function Ask($q) { if ($Yes) { return $true }; $a = Read-Host "$q [y/N]"; return $a -match '^(y|yes|o|oui)$' }

# ---------------------------------------------------------------- 1. system
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'a 64-bit Windows is required' }
$build = [Environment]::OSVersion.Version.Build
if ([Environment]::OSVersion.Version.Major -lt 10 -or $build -lt 17763) { Fail "Windows 10 (version 1809) or Windows 11 is required (found build $build)" }

$Update = Test-Path (Join-Path $Here 'move-openlab.json')
if (-not $Update) {
  $other = Get-ChildItem -LiteralPath $Here -Force | Where-Object { $_.Name -notin @('install.ps1', 'install.log', '.move-openlab-download') }
  if ($other) { Fail 'this folder is not empty: create a new empty folder, open PowerShell in it and run the command again' }
}
if ((Test-Path (Join-Path $Here 'app.old')) -and -not (Test-Path (Join-Path $Here 'app'))) { Move-Item (Join-Path $Here 'app.old') (Join-Path $Here 'app') }
Say "MOVE OpenLab $Version - $(if ($Update) { 'update' } else { 'installation' }) in $Here (Windows build $build, $env:PROCESSOR_ARCHITECTURE)"

# ---------------------------------------------------------------- 2. Python 3.11+
function Test-Python($exe, $extra) {
  try {
    $out = & $exe @extra -c "import sys, venv, ensurepip; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Select-Object -Last 1).Trim() }
  } catch { }
  return $null
}
function Find-Python {
  foreach ($v in @('3.13', '3.12', '3.11')) { if (Get-Command py -ErrorAction SilentlyContinue) { $p = Test-Python 'py' @("-$v"); if ($p) { return $p } } }
  foreach ($c in @('python3', 'python')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch 'WindowsApps') { $p = Test-Python $cmd.Source @(); if ($p) { return $p } }   # not the Store alias
  }
  foreach ($d in @('Python313', 'Python312', 'Python311')) {
    $exe = Join-Path $env:LOCALAPPDATA "Programs\Python\$d\python.exe"
    if (Test-Path $exe) { $p = Test-Python $exe @(); if ($p) { return $p } }
  }
  return $null
}
$Py = Find-Python
if (-not $Py) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if (-not (Ask 'Python 3.11 or newer is needed. Install Python 3.12 for your user only with: winget install --id Python.Python.3.12 --scope user ?')) {
      Fail 'Python 3.11+ is required: install it from https://www.python.org/downloads/windows/ and run this command again'
    }
    winget install --exact --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    $Py = Find-Python
  }
  if (-not $Py) { Fail 'Python 3.11 or newer is required: install it from https://www.python.org/downloads/windows/ and run this command again' }
}
Say "Python: $Py"

# ---------------------------------------------------------------- 3. application archive (verified)
$Dl = Join-Path $Here '.move-openlab-download'
New-Item -ItemType Directory -Force -Path $Dl | Out-Null
$Zip = Join-Path $Dl $ArchiveName
if ($Archive) { Copy-Item -LiteralPath $Archive -Destination $Zip -Force }
else {
  Say "Downloading $ArchiveName"
  try { Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$ArchiveName" -OutFile $Zip } catch { Fail "download failed: $ReleaseUrl/$ArchiveName" }
}
$got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLower()
if ($got -ne $ArchiveSha256) { Fail "the downloaded archive does not match this installer (SHA-256 $got, expected $ArchiveSha256): nothing was installed" }
Say "Archive verified (SHA-256 $ArchiveSha256)"
$X = Join-Path $Dl 'x'
if (Test-Path $X) { Remove-Item -Recurse -Force $X }
Expand-Archive -LiteralPath $Zip -DestinationPath $X
$Src = Join-Path $X "move-openlab-$Version"
if (-not (Test-Path (Join-Path $Src 'requirements\install.lock')) -or -not (Test-Path (Join-Path $Src 'frontend\dist'))) { Fail 'the archive is incomplete' }

$VPy = Join-Path $Here 'venv\Scripts\python.exe'
if ($Update -and (Test-Path $VPy)) { Invoke-Logged $VPy @('-m', 'move_openlab.cli', 'service', 'stop') | Out-Null }
$App = Join-Path $Here 'app'; $Old = Join-Path $Here 'app.old'
if (Test-Path $Old) { Remove-Item -Recurse -Force $Old }
if (Test-Path $App) { Move-Item $App $Old }
Move-Item $Src $App

# ---------------------------------------------------------------- 4. Python environment (hash-checked packages)
if (-not (Test-Path $VPy)) {
  Say 'Creating the Python environment (venv\)'
  if ((Invoke-Logged $Py @('-m', 'venv', (Join-Path $Here 'venv'))) -ne 0) { Fail 'could not create the Python environment' }
}
Say 'Installing the Python packages (checked against requirements\install.lock)'
if ((Invoke-Logged $VPy @('-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--no-input', '--require-hashes', '-r', (Join-Path $App 'requirements\install.lock'))) -ne 0) {
  Fail "the Python packages could not be installed (see $Log)" }
$Whl = Get-ChildItem -Path (Join-Path $App 'wheel') -Filter 'move_openlab-*.whl' | Select-Object -First 1
if ((Invoke-Logged $VPy @('-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--no-input', '--no-deps', '--force-reinstall', $Whl.FullName)) -ne 0) {
  Fail "MOVE OpenLab could not be installed (see $Log)" }
if (Test-Path $Old) { Remove-Item -Recurse -Force $Old }
Remove-Item -Recurse -Force $Dl

# ---------------------------------------------------------------- 5. background task, Start menu, first run
Say 'Registering the background task and starting MOVE OpenLab'
$argv = @('-m', 'move_openlab.cli', 'service', 'install', '--home', $Here)
if ($Port) { $argv += @('--port', "$Port") }
if ($DataDir) { $argv += @('--data-dir', $DataDir) }
if ($NoBrowser) { $argv += '--no-browser' }
if ($NoLauncher) { $argv += '--no-launcher' }
if ($NoAutostart) { $argv += '--no-autostart' }
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $VPy @argv
$code = $LASTEXITCODE; $ErrorActionPreference = $old
if ($code -ne 0) { Fail "MOVE OpenLab was installed but did not start (see: $VPy -m move_openlab.cli service logs)" }
Say 'Done. Open MOVE OpenLab any time from the Start menu ("MOVE OpenLab"), or run: venv\Scripts\move-openlab open'
if (-not $NoAutostart) { Say 'You can close this window: MOVE OpenLab keeps running in the background and starts again when you sign in.' }
