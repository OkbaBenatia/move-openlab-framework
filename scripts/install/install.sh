#!/bin/sh
# MOVE OpenLab installer for Linux and macOS — installs MOVE OpenLab @VERSION@ into the current (empty) folder.
#
#   curl -fsSL https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v@VERSION@/install.sh -o install.sh && sh install.sh
#
# What it does, in this order (nothing outside this folder, the data folder and your own user settings is changed;
# it asks before anything that needs administrator rights):
#   1. checks the system (Linux or macOS, 64-bit) and finds Python 3.11 or newer (offers to install it if missing);
#   2. downloads move-openlab-@VERSION@.tar.gz from the same GitHub release and refuses it unless its SHA-256 is
#      @ARCHIVE_SHA256@ (the value built into this installer);
#   3. creates app/ (the application) and venv/ (its Python environment) here; Python packages are installed
#      from requirements/install.lock with --require-hashes (every file checked against its pinned SHA-256);
#   4. registers MOVE OpenLab as a background application of your user account (systemd --user on Linux, a launchd
#      agent on macOS), creates the "MOVE OpenLab" launcher and opens the first-run page in your browser.
# Your data (accounts, experiments, results) lives in ~/.local/share/move-openlab (Linux) or
# ~/Library/Application Support/MOVE OpenLab (macOS) and is kept by updates and by uninstalling.
#
# Options: --yes (accept prerequisite installs without asking) --port N --data-dir DIR --no-browser --no-launcher
#          --no-autostart --archive FILE (an already downloaded archive; its SHA-256 is still checked)
set -eu

VERSION="@VERSION@"
ARCHIVE_SHA256="@ARCHIVE_SHA256@"
ARCHIVE="move-openlab-$VERSION.tar.gz"
RELEASE_URL="${MOVE_OPENLAB_RELEASE_URL:-https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v$VERSION}"

YES=0; PORT=""; DATA=""; NOBROWSER=""; NOLAUNCHER=""; NOAUTO=""; LOCAL_ARCHIVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --port) PORT="$2"; shift ;;
    --data-dir) DATA="$2"; shift ;;
    --no-browser) NOBROWSER="--no-browser" ;;
    --no-launcher) NOLAUNCHER="--no-launcher" ;;
    --no-autostart) NOAUTO="--no-autostart" ;;
    --archive) LOCAL_ARCHIVE="$2"; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

HERE="$(pwd -P)"
LOG="$HERE/install.log"
say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; printf '%s error: %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; exit 1; }
ask()  { [ "$YES" = 1 ] && return 0; [ -r /dev/tty ] || return 1; printf '%s [y/N] ' "$1"; read -r a < /dev/tty || return 1; case "$a" in y|Y|yes|YES|o|O|oui) return 0 ;; esac; return 1; }

# ---------------------------------------------------------------- 1. system
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in Linux) PLATFORM=linux ;; Darwin) PLATFORM=macos ;; *) fail "unsupported system $OS: MOVE OpenLab installs on Linux, macOS and Windows (use install.ps1 there)" ;; esac
case "$ARCH" in x86_64|amd64|aarch64|arm64) ;; *) fail "unsupported processor $ARCH: a 64-bit x86 or ARM processor is required" ;; esac
if [ "$PLATFORM" = macos ]; then
  MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
  [ "$MAJOR" -ge 12 ] 2>/dev/null || fail "macOS 12 or newer is required (found $(sw_vers -productVersion))"
fi

# the folder: empty (except this installer), or an existing installation (update)
UPDATE=0
if [ -f "$HERE/move-openlab.json" ]; then
  UPDATE=1
else
  OTHER="$(ls -A "$HERE" | grep -v -x -e install.sh -e install.log -e .move-openlab-download || true)"
  [ -z "$OTHER" ] || fail "this folder is not empty: create a new empty folder, open a terminal in it and run the command again"
fi
# an update interrupted while the application files were being replaced: put the previous ones back first
if [ -d "$HERE/app.old" ] && [ ! -d "$HERE/app" ]; then mv "$HERE/app.old" "$HERE/app"; fi
say "MOVE OpenLab $VERSION — $( [ $UPDATE = 1 ] && echo update || echo installation ) in $HERE ($PLATFORM, $ARCH)"

# ---------------------------------------------------------------- 2. Python 3.11+
find_python() {
  for c in python3.13 python3.12 python3.11 python3; do
    p="$(command -v "$c" 2>/dev/null)" || continue
    "$p" -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1 && { echo "$p"; return 0; }
  done
  return 1
}
PY="$(find_python || true)"
if [ -z "$PY" ]; then
  if [ "$PLATFORM" = linux ] && command -v apt-get >/dev/null 2>&1; then
    PKGS="python3 python3-venv"
    if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
      PKGS="python3.11 python3.11-venv"                     # Ubuntu 22.04: the system Python is 3.10
    fi
    ask "Python 3.11 or newer with its venv module is needed. Install it now with: sudo apt-get install $PKGS ?" \
      || fail "Python 3.11+ is required: install it (sudo apt-get install $PKGS) and run this command again"
    sudo apt-get update -q && sudo apt-get install -y -q $PKGS || fail "could not install $PKGS"
  elif [ "$PLATFORM" = macos ] && command -v brew >/dev/null 2>&1; then
    ask "Python 3.11 or newer is needed. Install it now with: brew install python@3.12 ?" \
      || fail "Python 3.11+ is required: install it (brew install python@3.12, or from https://www.python.org/downloads/macos/) and run this command again"
    brew install python@3.12 || fail "brew could not install Python"
  else
    fail "Python 3.11 or newer is required: install it from your system's packages or https://www.python.org/downloads/ and run this command again"
  fi
  PY="$(find_python || true)"
  [ -n "$PY" ] || fail "Python 3.11+ is still not available after the installation"
fi
say "Python: $("$PY" -c 'import platform; print(platform.python_version())') ($PY)"

# bubblewrap: the sandbox for uploaded method plug-ins (Linux only; built-in methods do not need it)
if [ "$PLATFORM" = linux ] && ! command -v bwrap >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && ask "Optional: install bubblewrap (sudo apt-get install bubblewrap) so that uploaded method plug-ins can run in their sandbox?"; then
    sudo apt-get install -y -q bubblewrap || say "bubblewrap could not be installed: uploaded plug-ins stay disabled (built-in methods work)"
  else
    say "bubblewrap is not installed: uploaded method plug-ins stay disabled until it is (built-in methods work)"
  fi
fi

# ---------------------------------------------------------------- 3. application archive (verified)
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
DL="$HERE/.move-openlab-download"
mkdir -p "$DL"
if [ -n "$LOCAL_ARCHIVE" ]; then
  cp "$LOCAL_ARCHIVE" "$DL/$ARCHIVE"
else
  say "Downloading $ARCHIVE"
  if command -v curl >/dev/null 2>&1; then curl -fSL --retry 3 --proto '=https' -o "$DL/$ARCHIVE" "$RELEASE_URL/$ARCHIVE" || fail "download failed: $RELEASE_URL/$ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$DL/$ARCHIVE" "$RELEASE_URL/$ARCHIVE" || fail "download failed: $RELEASE_URL/$ARCHIVE"
  else fail "curl or wget is required to download MOVE OpenLab"; fi
fi
GOT="$(sha256_of "$DL/$ARCHIVE")"
[ "$GOT" = "$ARCHIVE_SHA256" ] || fail "the downloaded archive does not match this installer (SHA-256 $GOT, expected $ARCHIVE_SHA256): nothing was installed"
say "Archive verified (SHA-256 $ARCHIVE_SHA256)"
rm -rf "$DL/x" && mkdir -p "$DL/x"
tar -xzf "$DL/$ARCHIVE" -C "$DL/x" --no-same-owner || fail "could not unpack the archive"
SRC="$DL/x/move-openlab-$VERSION"
[ -f "$SRC/requirements/install.lock" ] && [ -d "$SRC/frontend/dist" ] || fail "the archive is incomplete"

# stop a running older version before its files are replaced
if [ $UPDATE = 1 ] && [ -x "$HERE/venv/bin/python" ]; then
  "$HERE/venv/bin/python" -m move_openlab.cli service stop >/dev/null 2>&1 || true
fi
rm -rf "$HERE/app.old"; [ -d "$HERE/app" ] && mv "$HERE/app" "$HERE/app.old"
mv "$SRC" "$HERE/app"

# ---------------------------------------------------------------- 4. Python environment (hash-checked packages)
if [ ! -x "$HERE/venv/bin/python" ] || ! "$HERE/venv/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  rm -rf "$HERE/venv"
  say "Creating the Python environment (venv/)"
  "$PY" -m venv "$HERE/venv" || fail "could not create the Python environment"
fi
VPY="$HERE/venv/bin/python"
say "Installing the Python packages (checked against requirements/install.lock)"
"$VPY" -m pip install -q --disable-pip-version-check --no-input --require-hashes -r "$HERE/app/requirements/install.lock" >> "$LOG" 2>&1 \
  || fail "the Python packages could not be installed (see $LOG)"
"$VPY" -m pip install -q --disable-pip-version-check --no-input --no-deps --force-reinstall "$HERE/app/wheel/"move_openlab-*.whl >> "$LOG" 2>&1 \
  || fail "MOVE OpenLab could not be installed (see $LOG)"
rm -rf "$HERE/app.old" "$DL"

# ---------------------------------------------------------------- 5. background service, launcher, first run
say "Registering the background service and starting MOVE OpenLab"
set -- service install --home "$HERE"
[ -n "$PORT" ] && set -- "$@" --port "$PORT"
[ -n "$DATA" ] && set -- "$@" --data-dir "$DATA"
for o in $NOBROWSER $NOLAUNCHER $NOAUTO; do set -- "$@" "$o"; done
"$VPY" -m move_openlab.cli "$@" || fail "MOVE OpenLab was installed but did not start (see: $VPY -m move_openlab.cli service logs)"
say "Done. Open MOVE OpenLab any time from your applications menu (\"MOVE OpenLab\"), or run: $HERE/venv/bin/move-openlab open"
say "You can close this terminal: MOVE OpenLab keeps running in the background and starts again when you sign in."
