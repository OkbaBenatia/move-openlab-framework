#!/usr/bin/env bash
# MOVE OpenLab — start the complete application on this computer with one command.
#
#   ./start-local.sh            the whole application at http://127.0.0.1:8765 (one process: API + interface)
#   ./start-local.sh --check    check and prepare everything, then exit without starting
#
# The first run prepares what is missing (Python environment, interface build) and needs network access for that;
# later runs start in a few seconds and rebuild the interface only when its sources changed.
# Data: the local data directory .openlab-data/dev (accounts, experiments, results) is used as it is — nothing is
# deleted, reset or migrated by this script. Listens on 127.0.0.1 only. Stop with Ctrl+C.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST=127.0.0.1                                   # local only: never exposed to the network
PORT="${MOVE_OPENLAB_PORT:-8765}"
URL="http://$HOST:$PORT"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
FRONT="$ROOT/frontend"
CHECK_ONLY=0

if [[ -t 1 ]]; then B=$'\033[1m'; R=$'\033[31m'; Y=$'\033[33m'; G=$'\033[32m'; N=$'\033[0m'; else B=; R=; Y=; G=; N=; fi
say()  { printf '%s▸ %s%s\n' "$B" "$*" "$N"; }
warn() { printf '%swarning:%s %s\n' "$Y" "$N" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  --check) CHECK_ONLY=1 ;;
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) fail "unknown option '$1' (use --help)" ;;
esac

[[ "${MOVE_OPENLAB_ENV:-}" == "production" ]] && fail "start-local.sh is for local use only (MOVE_OPENLAB_ENV=production is set)."
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || fail "MOVE_OPENLAB_PORT must be a port number between 1024 and 65535 (got '$PORT')."

export MOVE_OPENLAB_DATA_DIR="${MOVE_OPENLAB_DATA_DIR:-$ROOT/.openlab-data/dev}"
export MOVE_OPENLAB_PLUGIN_DIR="${MOVE_OPENLAB_PLUGIN_DIR:-$ROOT/plugins}"
export MOVE_OPENLAB_PLUGIN_MODE="${MOVE_OPENLAB_PLUGIN_MODE:-sandbox}"
export MOVE_OPENLAB_FRONTEND_DIST="$FRONT/dist"

# --- 1. Python environment --------------------------------------------------------------------------------------
py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; }

if [[ ! -x "$PY" ]]; then
  BASE=""
  for c in python3.13 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1 && py_ok "$(command -v "$c")"; then BASE="$(command -v "$c")"; break; fi
  done
  [[ -n "$BASE" ]] || fail "Python 3.11 or newer is required (found: $(python3 --version 2>&1 || echo none)). Install it, then run ./start-local.sh again."
  say "Creating the Python environment (.venv) with $("$BASE" --version 2>&1)"
  "$BASE" -m venv "$VENV" || fail "could not create .venv — on Debian/Ubuntu install the venv module (sudo apt install python3-venv)."
fi
py_ok "$PY" || fail ".venv uses $("$PY" --version 2>&1); Python 3.11 or newer is required. Move .venv aside and run ./start-local.sh again."

STAMP="$VENV/.move-openlab-install"
WANT="$(sha256sum pyproject.toml | cut -d' ' -f1)"
installed_here() {   # the package is importable from this checkout, with the web server and the exact solver
  "$PY" - "$ROOT" <<'EOF' 2>/dev/null
import pathlib, sys
import move_openlab, uvicorn, highspy  # noqa: F401
sys.exit(0 if pathlib.Path(move_openlab.__file__).resolve().is_relative_to(pathlib.Path(sys.argv[1]).resolve()) else 1)
EOF
}
pip_install() {      # pip of the environment; an environment created by uv has none: uv itself, or ensurepip
  if "$PY" -m pip --version >/dev/null 2>&1; then "$PY" -m pip install --disable-pip-version-check -q "$@"
  elif command -v uv >/dev/null 2>&1; then uv pip install --python "$PY" -q "$@"
  else "$PY" -m ensurepip -q >/dev/null && "$PY" -m pip install --disable-pip-version-check -q "$@"; fi
}
if [[ "$(cat "$STAMP" 2>/dev/null)" != "$WANT" ]] || ! installed_here; then
  if [[ ! -f "$STAMP" ]] && installed_here; then
    : # an existing working installation from this checkout: keep it as it is
  else
    say "Installing Python dependencies (first run or pyproject.toml changed; needs network)"
    pip_install -e ".[dev]" || fail "installing the Python dependencies failed (see the messages above; network access is needed on the first run)."
  fi
  installed_here || fail "the move_openlab package is not importable from this checkout after installation."
  echo "$WANT" > "$STAMP"
fi

# --- 2. Interface (built once, rebuilt only when its sources change) ---------------------------------------------
stale_build() {
  [[ ! -f "$FRONT/dist/index.html" ]] && return 0
  [[ -n "$(find "$FRONT/src" "$FRONT/public" "$FRONT/index.html" "$FRONT/package.json" "$FRONT/package-lock.json" \
            "$FRONT/vite.config.ts" "$FRONT/tsconfig.json" -newer "$FRONT/dist/index.html" -print -quit 2>/dev/null)" ]]
}
if stale_build; then
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || fail "Node.js 20.19+ (or 22.12+) with npm is required to build the interface. Install it, then run ./start-local.sh again."
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' \
    || fail "Node.js $(node --version) is too old: the interface build needs Node.js 20.19+ or 22.12+."
  if [[ ! -f "$FRONT/node_modules/.package-lock.json" || "$FRONT/package-lock.json" -nt "$FRONT/node_modules/.package-lock.json" ]]; then
    say "Installing interface dependencies (npm ci; needs network)"
    (cd "$FRONT" && npm ci --no-audit --no-fund --loglevel=error) || fail "npm ci failed (see the messages above)."
  fi
  say "Building the interface"
  log="$(mktemp)"
  (cd "$FRONT" && npm run --silent build) >"$log" 2>&1 || { cat "$log" >&2; rm -f "$log"; fail "the interface build failed (see the messages above)."; }
  rm -f "$log"
fi

# --- 3. Already running? Port free? --------------------------------------------------------------------------------
probe="$("$PY" - "$HOST" "$PORT" <<'EOF'
import json, socket, sys, urllib.request
host, port = sys.argv[1], int(sys.argv[2])
try:
    with urllib.request.urlopen(f"http://{host}:{port}/api/health", timeout=3) as r:
        print("openlab" if json.load(r).get("app") == "MOVE OpenLab" else "other")
    sys.exit()
except Exception:
    pass
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # as the server does: closing connections do not block it
try:
    s.bind((host, port))
    s.listen()
    print("free")
except OSError:
    print("other")
finally:
    s.close()
EOF
)"
case "$probe" in
  openlab) printf '%sMOVE OpenLab is already running at %s%s — open it in your browser (stop it with Ctrl+C in the terminal where it runs).\n' "$G" "$URL" "$N"; exit 0 ;;
  other) fail "port $PORT on $HOST is used by another program. Stop it, or choose another port: MOVE_OPENLAB_PORT=8766 ./start-local.sh" ;;
esac

mkdir -p "$MOVE_OPENLAB_DATA_DIR"
if command -v flock >/dev/null 2>&1; then         # one server per data directory, even if two terminals race
  exec 9>"$MOVE_OPENLAB_DATA_DIR/.start-local.lock"
  flock -n 9 || fail "another ./start-local.sh is already starting for this data directory."
fi

# --- 4. Accounts, plug-ins -----------------------------------------------------------------------------------------
accounts="$("$PY" -c 'from move_openlab.auth import Auth; from move_openlab.settings import Settings; print(Auth(Settings.from_env()).store.count())')" \
  || fail "the account store in $MOVE_OPENLAB_DATA_DIR could not be opened."
if [[ "$accounts" == "0" ]]; then
  say "No account yet: creating the first administrator 'admin' with a temporary password"
  "$PY" scripts/dev_provision.py --admin --temporary admin >/dev/null || fail "could not create the first administrator."
  printf '  Sign in as %sadmin%s; the temporary password is in %s (never printed). You choose your own at the first sign-in.\n' \
    "$B" "$N" "${MOVE_OPENLAB_DATA_DIR#"$ROOT"/}/dev-credentials.json"
fi
if [[ "$MOVE_OPENLAB_PLUGIN_MODE" == "sandbox" ]] && ! command -v bwrap >/dev/null 2>&1 && [[ ! -x /usr/bin/bwrap ]]; then
  warn "bubblewrap (bwrap) is not installed: your own methods (plug-ins) stay off; everything else works. Install it with your package manager (e.g. sudo apt install bubblewrap)."
fi

if (( CHECK_ONLY )); then
  printf '%sReady.%s ./start-local.sh will serve MOVE OpenLab at %s (data: %s).\n' "$G" "$N" "$URL" "${MOVE_OPENLAB_DATA_DIR#"$ROOT"/}"
  exit 0
fi

# --- 5. Start (one process; Ctrl+C stops it cleanly, running jobs are recorded as interrupted) --------------------
printf '\n%sMOVE OpenLab%s · Development build\n  %s%s%s   (local only)\n  data: %s\n  Stop with Ctrl+C.\n\n' \
  "$B" "$N" "$G" "$URL" "$N" "${MOVE_OPENLAB_DATA_DIR#"$ROOT"/}"
exec "$VENV/bin/move-openlab" serve --host "$HOST" --port "$PORT"
