# Installation (Ubuntu / Linux)

This guide installs MOVE OpenLab from a checkout of the repository. The short path is one command
(`./start-local.sh`); the manual path below shows each step, the configuration and what a production-mode start
requires. Everything here is local: there is no hosted service and no installer package.

## 1. Requirements

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

## 2. Quick installation

```bash
git clone https://github.com/OkbaBenatia/move-openlab-framework.git
cd move-openlab-framework
./start-local.sh
```

`start-local.sh` creates `.venv`, installs the package with its `dev` extra, runs `npm ci` and builds the interface,
creates the first administrator when the account store is empty, and starts one process (API and interface) on
`http://127.0.0.1:8765`. `./start-local.sh --check` does everything except starting. It listens on the loopback
interface only and refuses `MOVE_OPENLAB_ENV=production`.

## 3. Manual installation

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

## 4. Configuration

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

## 5. Data directory

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

## 6. First administrator

Accounts are local; there is no self-registration and no default password.

- **With `start-local.sh`.** On an empty account store it creates `admin` with a random temporary password, written
  to `<data>/dev-credentials.json` (mode `0600`), never printed. Read it there, sign in, and choose your own password
  at the forced change. The temporary password stops working once changed; the file can then be deleted.
  `scripts/dev_provision.py` (which writes that file) refuses to run in production mode.
- **By hand (and in production mode).**

  ```bash
  .venv/bin/move-openlab users add alice --display-name "Alice" --role admin
  ```

  The command prints a temporary password once; the first sign-in forces a change. To type the initial password
  yourself instead of having one printed, add `--set-password` (prompted without echo; it is still temporary).

Password rules are enforced on the server: at least 12 characters, three of the four character classes, nothing
taken from the username or display name. Further accounts are created under *Administration* in the interface.
Recovery on the host: `.venv/bin/move-openlab users reset-password <username>`.

## 7. Start, stop, health

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

## 8. Logs

The server writes its start-up line (process hardening, plug-in status) and the HTTP access log to the terminal
(standard output and standard error); it creates no log file. Redirect the output, or let your service manager keep
it. What the application records itself:

| Record | Where |
|---|---|
| Administrative actions and refused accesses to restricted problems | `<data>/audit.log`, also *Administration › Audit log* |
| Background jobs and their execution trace | `<data>/jobs/`, also *Library › Jobs and traces* |
| Diagnostics of a failed or timed-out run | in the run of the experiment record |

## 9. Production mode and reverse proxy

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

## 10. Verify the installation

```bash
MOVE_OPENLAB_REQUIRE_SANDBOX=1 .venv/bin/python -m pytest
```

Without `MOVE_OPENLAB_REQUIRE_SANDBOX=1` the sandbox tests are skipped on a machine without a working bubblewrap.
The full verification gate is in [DEVELOPMENT.md](DEVELOPMENT.md#tests); problems and their fixes are in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
