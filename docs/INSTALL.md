# Installing MOVE OpenLab — Windows, Linux, macOS

MOVE OpenLab is one application (a local web server and its interface) that runs on your own computer and is used in
your browser. The installer puts it in a folder you choose, keeps it running in the background for your user account,
and adds a "MOVE OpenLab" launcher. Nothing is exposed beyond this computer: the server listens on `127.0.0.1` only.

The commands below install **version 0.3.2** from its GitHub release (later versions: the same commands with their
own number).

## Install with one command

Create an empty folder, open a terminal in it (PowerShell on Windows), paste the command for your system:

**Windows 10 / 11 (64-bit), PowerShell:**

```powershell
irm https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v0.3.2/install.ps1 -OutFile install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

**Linux (Ubuntu 22.04 or newer; other distributions with Python 3.11+ and systemd):**

```bash
curl -fsSL https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v0.3.2/install.sh -o install.sh && sh install.sh
```

**macOS 12 or newer (Apple silicon or Intel):**

```bash
curl -fsSL https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v0.3.2/install.sh -o install.sh && sh install.sh
```

The browser opens at the end on *Welcome to MOVE OpenLab*. `-ExecutionPolicy Bypass` applies only to that one
PowerShell process (it lets it run the downloaded script) and changes no setting of the computer.

### What the installer does

1. Checks the system (64-bit Windows 10 1809+, Linux, macOS 12+) and looks for **Python 3.11 or newer**. If it is
   missing it **asks** before installing it: `winget install Python.Python.3.12 --scope user` on Windows (no
   administrator rights), `sudo apt-get install python3 python3-venv` on Ubuntu, `brew install python@3.12` on macOS
   with Homebrew; otherwise it tells you where to get it (python.org) and stops. Node.js is **not** needed.
2. Downloads `move-openlab-0.3.2.tar.gz` (Windows: `.zip`) from the same release and **refuses it unless its SHA-256
   equals the value written into the installer**; nothing is installed from an archive that does not match.
3. Creates `app/` (the application, its interface already built) and `venv/` (its own Python environment) in your
   folder. Python packages come from `requirements/install.lock` with `--require-hashes`: every package file is
   checked against its pinned SHA-256.
4. Registers MOVE OpenLab as a background application **of your user account** (no administrator rights; it starts
   when you sign in, not at boot), creates the launcher, starts it and opens the browser.

On Linux it also offers (optional) to install `bubblewrap`, the sandbox for uploaded method plug-ins.
Options: `--port N`, `--data-dir DIR`, `--no-browser`, `--no-launcher`, `--no-autostart`, `--yes` (Windows:
`-Port`, `-DataDir`, `-NoBrowser`, `-NoLauncher`, `-NoAutostart`, `-Yes`). The installer refuses a folder that is not
empty, and refuses a second installation that would share the data of an existing one.

### Verify the installer before running it (optional)

The release lists the SHA-256 of every asset in `SHA256SUMS`. To check the installer first:

```bash
curl -fsSLO https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v0.3.2/install.sh
curl -fsSLO https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v0.3.2/SHA256SUMS
grep ' install.sh$' SHA256SUMS | sha256sum -c -        # macOS: shasum -a 256 -c
```

```powershell
irm https://github.com/OkbaBenatia/move-openlab-framework/releases/download/v0.3.2/SHA256SUMS -OutFile SHA256SUMS
(Get-FileHash install.ps1).Hash.ToLower(); Select-String ' install.ps1$' SHA256SUMS
```

## First launch: create your administrator

The browser opens **Welcome to MOVE OpenLab**: choose a username, your name and a password (at least 12 characters,
three kinds of characters; a meter shows its strength), confirm it, *Create administrator*. The Workspace opens with
the Montbéliard demonstration.

- There is no default account and no default password; nothing is written to a file or a log.
- The page works only with its **setup key**, which only your user account can read (it is in the data folder); the
  launcher and `move-openlab open` add it to the link for you. If you closed the page: open MOVE OpenLab again from its
  launcher. A computer without a browser on the same desktop: run `move-openlab setup-link` on it and open the printed
  link from there.
- After the first administrator exists, the page is gone for good; further accounts are created under
  *Administration*.

## Daily use — no terminal needed

Open **MOVE OpenLab** from the Start menu (Windows), the Applications folder (macOS) or the applications menu
(Linux), or go to the address shown at the end of the installation (default `http://127.0.0.1:8765`).

| What happens when… | |
|---|---|
| you close the terminal or PowerShell window | nothing: MOVE OpenLab keeps running in the background |
| you close the browser | nothing: open the launcher or the address again; you stay signed in for 8 hours |
| you sign out of your computer session | the server stops with your session (Linux: unless your system keeps user services running) |
| you restart the computer | it starts again when you sign in |
| it crashes | it is restarted automatically (Linux: after 5 s; macOS: after 10 s; Windows: within a minute) |

Service commands (in the installation folder; on Windows `venv\Scripts\move-openlab`):

```bash
venv/bin/move-openlab service status      # registered? running? address, data folder
venv/bin/move-openlab service stop        # stops it (it starts again at your next sign-in)
venv/bin/move-openlab service start
venv/bin/move-openlab service restart
venv/bin/move-openlab service logs        # last lines of the server log (no password or key is ever logged)
venv/bin/move-openlab open                # starts it if needed and opens the browser
```

| | Background mechanism | Data folder | Server log |
|---|---|---|---|
| Linux | `systemd --user` unit `move-openlab.service` | `~/.local/share/move-openlab` | `<data>/logs/server.log` (also `journalctl --user -u move-openlab`) |
| macOS | `launchd` agent `~/Library/LaunchAgents/io.github.okbabenatia.move-openlab.plist` | `~/Library/Application Support/MOVE OpenLab` | `<data>/logs/server.log` |
| Windows | Task Scheduler task `\MOVE OpenLab\Server` (at sign-in, your account) | `%LOCALAPPDATA%\MOVE OpenLab\data` | `<data>\logs\server.log` |

Where no `systemd --user` manager is available (some containers or minimal sessions), the Linux installer starts the
server as a detached process and adds a desktop autostart entry; it is then not restarted after a crash
(`service status` says so).

## Update, back up, uninstall

- **Update**: run the command of the newer release **in the same folder**. The installer stops the server, replaces
  `app/` and the packages, keeps `move-openlab.json` (port, data folder) and starts it again; accounts, experiments and
  results are untouched. An update interrupted while files were replaced is completed by running it again.
- **Back up**: stop the service and copy the data folder (`service status` shows it). Experiments can also be
  exported one by one as verified bundles (*Export*).
- **Uninstall**: `venv/bin/move-openlab service uninstall` removes the background service and the launcher and **keeps
  the data**; then delete the installation folder. `service uninstall --remove-data --yes` also deletes every account,
  experiment and result of this installation.

## Plug-ins (your own methods) on each system

Uploaded and registered method plug-ins always run in a **verified sandbox** and are refused, never run unsandboxed,
when it is unavailable. The sandbox uses Linux kernel isolation through `bubblewrap`:

| System | Built-in methods, demonstration, samples, import/export, reproduction | Uploaded or registered plug-ins |
|---|---|---|
| Linux with `bubblewrap` | yes | yes, in the sandbox (on Ubuntu releases that restrict unprivileged user namespaces the sandbox probe may fail: plug-ins are then refused with the reason) |
| macOS | yes | not available — refused with the reason (no equivalent sandbox is implemented) |
| Windows | yes | not available — refused with the reason (no equivalent sandbox is implemented) |

`move-openlab method new` works everywhere; `move-openlab method check` reads the metadata everywhere and runs the
self-test only where the sandbox is available.

## Developer installation and advanced configuration

For working on MOVE OpenLab itself: a Git checkout started in the foreground with `./start-local.sh` (Linux; it keeps
its data in `.openlab-data/dev` of the checkout and stops with Ctrl+C). The installed application above and a
developer checkout are separate installations with separate data.

### 1. Requirements (developer installation)

| Component | Requirement | Where it comes from |
|---|---|---|
| Operating system | Linux. CI runs on Ubuntu (`ubuntu-latest`); other platforms are not tested | `.github/workflows/ci.yml` |
| Python | 3.11 or newer (`requires-python = ">=3.11"`); CI tests 3.11 and 3.12 | `pyproject.toml` |
| Node.js and npm | Node.js 20.19+ or 22.12+ — only to build the interface | checked by `start-local.sh` |
| bubblewrap (`bwrap`) | only for plug-ins (your own methods and metrics) in `sandbox` mode | [SECURITY_MODEL.md](SECURITY_MODEL.md) |
| Network access | once, to install the Python and npm dependencies; later only for optional services (road networks, place search, open data, map tiles) | [DATASETS.md](DATASETS.md) |

There is **no database server** to install. Accounts are in one SQLite file; experiments, scenarios, datasets, jobs
and preferences are JSON and CSV files in the data directory (section 5).

System packages on Ubuntu:

```bash
sudo apt update
sudo apt install -y git curl python3 python3-venv bubblewrap
```

Install Node.js from your usual source and check the version; the build refuses anything older than 20.19 (or, on
the 22 line, older than 22.12):

```bash
node --version && npm --version
```

**Plug-in sandbox on recent Ubuntu.** The sandbox needs unprivileged user namespaces. Ubuntu releases that restrict
them through AppArmor make the isolation probe fail, and plug-ins are then refused with the reason (everything else
works). The CI workflow lifts the restriction on its runners with:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

This is a system-wide security setting: decide with the administrator of the machine. Without it, keep plug-ins off.

### 2. Developer quick start (`start-local.sh`)

```bash
git clone https://github.com/OkbaBenatia/move-openlab-framework.git
cd move-openlab-framework
./start-local.sh
```

`start-local.sh` creates `.venv`, installs the package with its `dev` extra, runs `npm ci` and builds the interface,
and starts one process (API and interface) on `http://127.0.0.1:8765`; on an empty account store it opens the
first-run page (its link, with the setup key, is shown in that terminal only). `./start-local.sh --check` does everything except starting. It listens on the loopback
interface only and refuses `MOVE_OPENLAB_ENV=production`.

### 3. Manual installation

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

The `dev` extra adds the test tools, the pinned linter and `highspy` (the HiGHS solver used by the exact reference
methods). An installation without the test tools uses the `highs` extra instead:

```bash
.venv/bin/pip install -e ".[highs]"
```

Build the interface (the server serves `frontend/dist`):

```bash
cd frontend && npm ci && npm run build && cd ..
```

### 4. Configuration

Configuration is read from environment variables when the server starts (`src/move_openlab/settings.py`). The
application does not read a `.env` file by itself: export the variables in the shell that starts the server, or let
your service manager load them. Files named `.env` are ignored by Git and refused by the public-safety check.

| Variable | Default | Meaning |
|---|---|---|
| `MOVE_OPENLAB_DATA_DIR` | `./.openlab-data` (`start-local.sh`: `.openlab-data/dev`) | data directory |
| `MOVE_OPENLAB_AUTH_DB` | `<data>/auth.sqlite3` | SQLite credential store |
| `MOVE_OPENLAB_INSTALLATION_ID` | generated once, stored in `<data>/installation.json` | fixed installation identifier |
| `MOVE_OPENLAB_ENV` | `development` | `production` enables the production checks (section 9) |
| `SESSION_SECRET` | random at each start (development) | session signing key, at least 32 characters; required in production |
| `SESSION_TTL_HOURS` | `8` | session lifetime |
| `COOKIE_SECURE` | on in production, off otherwise | force the `Secure` flag of the session cookie (`1`, `true`, `yes`) |
| `MOVE_OPENLAB_FRONTEND_DIST` | `./frontend/dist` | built interface served by the API |
| `MOVE_OPENLAB_PLUGIN_DIR` | unset | approved plug-in directory; unset = built-in methods only |
| `MOVE_OPENLAB_PLUGIN_MODE` | `disabled` | `disabled`, `sandbox` or `trusted-process` (administrators only; refused in production) |
| `MOVE_OPENLAB_WORKER_MEMORY_MB` | `4096` | address-space limit of a method worker process; `0` removes the limit |
| `MOVE_OPENLAB_TILE_URL` | OpenStreetMap standard tiles | map tile URL template; `none` = maps without a basemap |
| `MOVE_OPENLAB_TILE_ATTRIBUTION` | © OpenStreetMap contributors | attribution shown on maps |
| `MOVE_OPENLAB_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint for road networks |
| `MOVE_OPENLAB_GEOCODER_URL` | `https://nominatim.openstreetmap.org/search` | place-search endpoint; `off` disables search |
| `MOVE_OPENLAB_GEOCODER_PROVIDER` | `nominatim` | `nominatim` or `photon` |
| `MOVE_OPENLAB_EXTERNAL_FETCH` | `researcher` | who may start downloads from public services: `researcher` or `admin` |
| `MOVE_OPENLAB_DAILY_NETWORKS` | `10` | road-network downloads per user per day |
| `MOVE_OPENLAB_DAILY_RPC` | `3` | RPC release ingestions per user per day |
| `MOVE_OPENLAB_DAILY_SEARCHES` | `200` | place searches sent to the geocoder per user per day |

Read by the tools, not by the server: `MOVE_OPENLAB_PORT` (`start-local.sh`, default `8765`),
`MOVE_OPENLAB_REQUIRE_SANDBOX=1` (test suite: an unavailable sandbox fails instead of skipping) and
`MOVE_OPENLAB_DENYLIST` (`scripts/check_public_safety.py`).

Example block, without secrets:

```bash
# MOVE OpenLab — example environment. No secret belongs in a file under version control.
MOVE_OPENLAB_ENV=development
MOVE_OPENLAB_DATA_DIR=/var/lib/move-openlab
MOVE_OPENLAB_FRONTEND_DIST=/opt/move-openlab/frontend/dist
MOVE_OPENLAB_PLUGIN_DIR=/opt/move-openlab/plugins
MOVE_OPENLAB_PLUGIN_MODE=sandbox
MOVE_OPENLAB_EXTERNAL_FETCH=admin
MOVE_OPENLAB_TILE_URL=none
SESSION_TTL_HOURS=8
# SESSION_SECRET is set outside this file (section 9): at least 32 random characters.
```

### 5. Data directory

One installation is one data directory. Keep it outside the repository checkout or leave it under the Git-ignored
`.openlab-data/`.

```
<data>/installation.json                          installation identifier
<data>/auth.sqlite3                               accounts and scrypt password hashes (SQLite)
<data>/audit.log                                  administrative actions (JSON lines, no secret)
<data>/problem-grants.json                        accounts granted a restricted problem (only when one is granted)
<data>/dev-credentials.json                       development passwords written by start-local.sh / dev_provision.py
<data>/instances/<sha256>.json                    frozen scenarios, content-addressed
<data>/networks/<network_id>/                     road networks with their provenance
<data>/opendata/rpc/<dataset_key>/                cleaned open-data subsets
<data>/cache/geocode/                             cached place-search results
<data>/jobs/<user>/<job_id>.json                  background jobs: state, progress, events
<data>/workspaces/<user>/campaigns/<id>/campaign.json   one experiment record
<data>/workspaces/<user>/scenarios/ areas/ datasets/ geometry/
<data>/workspaces/<user>/methods.json  metrics.json     registered plug-ins
<data>/workspaces/<user>/studies.json  vehicles.json  preferences.json
```

The server runs with umask `077`: every file is `0600` and every directory `0700`, and entries written by earlier
versions are tightened at start ([SECURITY_MODEL.md](SECURITY_MODEL.md#owner-only-files)).

**Backup.** Stop the server and copy the data directory. There is nothing else to dump.

**Upgrade and migration.** Update the checkout, then start again: `start-local.sh` reinstalls the Python
dependencies when `pyproject.toml` changed and rebuilds the interface when its sources are newer than the build. The
data directory is used as it is — the script deletes, resets and migrates nothing. At start the server:

- migrates the credential store in place when its schema is older (`PRAGMA user_version`) and refuses a store written
  by a newer version;
- removes group and other permissions from existing files;
- marks jobs that were running when the previous process stopped as *interrupted* and returns their experiments to
  draft.

Experiment records are not rewritten by an upgrade. A record names the problem specification and validator version it
was made with; when the installed problem differs, the record stays on disk and readable as a record, but it is not
opened as an experiment of the installed problem.

### 6. First administrator

Accounts are local; there is no self-registration and no default password.

- **First-run page (every installation).** With no account, every page leads to *Welcome to MOVE OpenLab*, where you
  choose the administrator's username and password ([below](#first-launch-create-your-administrator)).
- **Headless or scripted (and in production mode).**

  ```bash
  .venv/bin/move-openlab users add alice --display-name "Alice" --role admin
  ```

  The command prints a temporary password once; the first sign-in forces a change. To type the initial password
  yourself instead of having one printed, add `--set-password` (prompted without echo; it is still temporary).

Password rules are enforced on the server: at least 12 characters, three of the four character classes, nothing
taken from the username or display name. Further accounts are created under *Administration* in the interface.
Recovery on the host: `.venv/bin/move-openlab users reset-password <username>`.

### 7. Start, stop, health

```bash
.venv/bin/move-openlab serve --host 127.0.0.1 --port 8765
```

`--host` and `--port` default to these values. Stop with **Ctrl+C** (SIGINT); jobs still running are recorded as
interrupted. Health check, without authentication:

```bash
curl -s http://127.0.0.1:8765/api/health
```

It answers `{"status": "ok", "app": "MOVE OpenLab", "version": …}`.

In development the session signing key is random at each start unless `SESSION_SECRET` is set, so a restart signs
everyone out.

### 8. Logs

The server writes its start-up line (process hardening, plug-in status) and the HTTP access log to the terminal
(standard output and standard error); it creates no log file. Redirect the output, or let your service manager keep
it. What the application records itself:

| Record | Where |
|---|---|
| Administrative actions and refused accesses to restricted problems | `<data>/audit.log`, also *Administration › Audit log* |
| Background jobs and their execution trace | `<data>/jobs/`, also *Library › Jobs and traces* |
| Diagnostics of a failed or timed-out run | in the run of the experiment record |

### 9. Production mode and reverse proxy

`MOVE_OPENLAB_ENV=production` changes what the server accepts and sends:

- it refuses to start without a `SESSION_SECRET` of at least 32 characters;
- it refuses `MOVE_OPENLAB_PLUGIN_MODE=trusted-process`;
- the session cookie is `Secure` by default, so sign-in works over HTTPS only;
- responses carry `Strict-Transport-Security`;
- the OpenAPI description (`/api/openapi.json`) is not served.

Generate the secret on the host and pass it through the environment of the service, never through a committed file:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

`start-local.sh` and `scripts/dev_provision.py` are development tools and refuse production mode: start with
`move-openlab serve` and create the first administrator with `move-openlab users add`.

The server speaks plain HTTP on the address it is given (loopback by default). The repository ships no reverse-proxy
configuration and CI does not test one. What follows from the code for a proxy in front of it:

- terminate TLS at the proxy (the cookie is `Secure`);
- forward the original `Host` header unchanged: state-changing requests whose `Origin` does not name the request's
  `Host` are refused;
- allow request bodies up to the application limits (25 MB for dataset uploads, 64 MB for bundle imports);
- keep the server itself on the loopback interface.

A public deployment must also choose its own map tile service and place-search policy
(`MOVE_OPENLAB_TILE_URL`, `MOVE_OPENLAB_GEOCODER_URL`); the defaults are for light development use
([MAPS.md](MAPS.md#tiles)).

### 10. Verify the installation

```bash
MOVE_OPENLAB_REQUIRE_SANDBOX=1 .venv/bin/python -m pytest
```

Without `MOVE_OPENLAB_REQUIRE_SANDBOX=1` the sandbox tests are skipped on a machine without a working bubblewrap.
The full verification gate is in [DEVELOPMENT.md](DEVELOPMENT.md#tests); problems and their fixes are in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
