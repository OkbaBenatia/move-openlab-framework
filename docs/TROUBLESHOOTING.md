# Troubleshooting

Symptoms, causes and fixes, grouped by where they appear. Messages in quotes are the ones the software prints.
Installation steps are in [INSTALL.md](INSTALL.md).

## Starting

| Symptom | Cause | Fix |
|---|---|---|
| "Python 3.11 or newer is required" | no suitable interpreter on the `PATH` | install Python 3.11+ and run `./start-local.sh` again |
| "could not create .venv" | the `venv` module is missing | `sudo apt install python3-venv` |
| ".venv uses Python …; Python 3.11 or newer is required" | an old environment from another interpreter | move `.venv` aside and start again |
| "installing the Python dependencies failed" | no network on the first run, or a build failure | check the messages above it; network access is needed once |
| "Node.js … is too old" or "Node.js 20.19+ (or 22.12+) with npm is required" | the interface cannot be built | install a current Node.js; it is needed only to build |
| "the interface build failed" | a build error, printed above the message | fix it, or restore the changed files under `frontend/` |
| "port … is used by another program" | another process listens there | stop it, or `MOVE_OPENLAB_PORT=8766 ./start-local.sh` |
| "MOVE OpenLab is already running at …" | it is — the script only reports the address | open that address; stop with Ctrl+C in the terminal where it runs |
| "another ./start-local.sh is already starting for this data directory" | two terminals started at once | wait for the first |
| "start-local.sh is for local use only" | `MOVE_OPENLAB_ENV=production` is set | use `move-openlab serve` ([INSTALL.md](INSTALL.md#9-production-mode-and-reverse-proxy)) |
| The server exits with "production requires SESSION_SECRET (at least 32 characters)" | production mode without a signing key | set `SESSION_SECRET` in the service environment |
| "trusted-process plugin mode is not a sandbox and is refused in production" | that combination is not allowed | use `MOVE_OPENLAB_PLUGIN_MODE=sandbox` or `disabled` |
| "credential store schema … is newer than this version of MOVE OpenLab" | the data directory was used by a newer version | run the newer version, or restore a backup made with this one |
| After a manual installation, the address answers *not found* once signed in | the interface was not built, or the server does not find it | `cd frontend && npm ci && npm run build`; start the server from the checkout or set `MOVE_OPENLAB_FRONTEND_DIST` |

## Signing in

| Symptom | Cause | Fix |
|---|---|---|
| Every page leads to *Welcome to MOVE OpenLab* | no account exists yet (first run) | create the administrator there; the page is opened with its setup key by the launcher, `move-openlab open` or `start-local.sh` ([INSTALL.md](INSTALL.md#first-launch-create-your-administrator)) |
| "the setup link is missing or invalid" | the page was opened without its key, or from another computer | open MOVE OpenLab with its launcher or `move-openlab open` on the computer where it runs; on a computer without a browser: `move-openlab setup-link` |
| "Sign-in is not configured on this server." | production mode has no signing key | set `SESSION_SECRET` (at least 32 characters) |
| I do not know a password | no password is ever printed or stored in clear | an operator resets it on the host: `move-openlab users reset-password <username>` (temporary, changed at the next sign-in) |
| "Invalid username or password." | — | usernames are lowercase; an operator resets a password with `move-openlab users reset-password <username>` |
| "Too many attempts. Try again later." | failed sign-ins are throttled per username and per client | wait, then try again |
| Every page sends me to *Change password* | the password is temporary | choose a personal one: 12 characters or more, three of the four character classes |
| Everyone is signed out after a restart | in development the signing key is random at each start | set `SESSION_SECRET` (32 characters or more) to keep sessions across restarts |
| Sign-in succeeds but the next page asks again, in production mode | the cookie is `Secure` and the page was opened over plain HTTP | reach the server through HTTPS |
| "cross-origin request refused" | a state-changing request whose `Origin` does not name the request's `Host` | open the application at the address the server sees; behind a proxy, forward the original `Host` header |
| The interface is in the wrong language | the EN \| FR choice was kept for the session only | switch, then answer *Yes* to *Make this my default language?* |

## Plug-ins: your own methods and metrics

*+ Add method* and `GET /api/problems/{id}/methods` give the reason when plug-ins cannot be used.

| Reason shown | Fix |
|---|---|
| "no approved plugin directory is configured (MOVE_OPENLAB_PLUGIN_DIR)" | set it; `start-local.sh` uses `plugins/` |
| "plugins are disabled (MOVE_OPENLAB_PLUGIN_MODE=disabled, the default)" | set `MOVE_OPENLAB_PLUGIN_MODE=sandbox` |
| "plugins refused: bubblewrap (bwrap) is not installed" | `sudo apt install bubblewrap` |
| "plugins refused: the plugin sandbox requires Linux" | plug-ins run on Linux only; everything else works |
| "plugins refused: sandbox could not start: …" or "sandbox isolation could not be verified: …" | unprivileged user namespaces are blocked on this machine ([INSTALL.md](INSTALL.md#1-requirements)); there is no unsandboxed fallback |
| "a read-only root of the Python installation (…) contains a protected path" | the data or plug-in directory lies inside the virtual environment or the installed package; move it |

| Symptom | Cause | Fix |
|---|---|---|
| `[FAILED] metadata: version 'v1' is not a semantic version MAJOR.MINOR.PATCH` | the plug-in's `METADATA` | use `1.0.0` |
| "incompatible method: problem_id … != …" or "objective_spec_id … != …" | the method was written for another problem or objective | copy both values from the problem (`GET /api/problems/{id}`) |
| "plugin code does not match its registered SHA-256 (refusing to execute)" | the file changed after registration | raise the version and register again |
| A registered custom metric shows no value | plug-ins off, sandbox unavailable, or the file changed | `GET /api/lab/metrics?problem_id=…` gives the reason per metric |
| My plug-in cannot reach the network or read a file | by design | a method receives everything through `instance` and `config` |

## Running experiments

| Symptom | Cause | Fix |
|---|---|---|
| A run is rejected with "timeout after … s" | the worker did not answer within the run timeout | raise the experiment's timeout or lower the method's time limit; the run's diagnostics say whether the solver was busy or blocked |
| Status `TIME_LIMIT`, scope *not proven (time limit)* | the solver stopped on its own time limit | expected: a time limit is never an optimality claim; raise the limit as a new settings version |
| A run is rejected with "problem … is not installed here" | the problem is importable in the server but not installed for the worker | install the package (`pip install`), do not rely on `PYTHONPATH` |
| "locked or imported campaigns cannot be executed again; derive a new campaign" | locked results are frozen | **Run again** creates a re-execution; adding a method creates an extension |
| "a job is already running for this item; wait for it to finish" | one job per experiment or download at a time | wait, or cancel the job |
| A job reads *interrupted* | the server stopped while it ran | start it again; the experiment went back to draft, no partial result was kept |
| The Run button is disabled | hover it: it says why | — |
| "campaign … fails its checksum: the stored record was modified" | a locked record was edited on disk | restore the file from a backup; the record is refused, not repaired |
| An older experiment no longer opens in the Workspace | "the installed problem specification or validator differs from the campaign's" | the record is kept; install the problem version it was made with to open it |

## Importing and exporting

| Symptom | Cause | Fix |
|---|---|---|
| "This bundle cannot be imported." with a checksum or fingerprint reason | the file was altered or truncated | ask for the file again and compare its SHA-256 with the exporter's |
| "problem … is not installed here" | the bundle's problem package is missing here — or it is restricted and not granted to you | install the package; for a restricted one, ask an administrator ([PRIVATE_EXTENSIONS.md](PRIVATE_EXTENSIONS.md)) |
| The specification or validator differs | the two installations run different versions of the problem | align the versions |
| The format or a section is unknown | the bundle was written by a newer version | update this installation; nothing was imported |
| *Reproducible here* is not ticked | a method of the bundle is not available here | install the same plug-in (same version and code hash) and register it |
| "request body larger than … MB" | the file exceeds the route's limit: 25 MB for datasets, 64 MB for bundles | export without the replay geometry, or split the dataset |
| *Try a sample → Try an imported experiment* reads *Unavailable* | the sample bundle or its recorded check is missing from this installation | reinstall the package from an unmodified checkout |
| "lock the campaign before exporting it" | an evidence report needs locked records | use *Lock and export* |

## Areas, data and maps

| Symptom | Cause | Fix |
|---|---|---|
| "Overpass API is rate-limiting requests (HTTP 429); try again in a few minutes" | the public service limits use | wait; a network already stored for the same box and profile is reused without any request |
| "Overpass API timed out or is overloaded" | a large area or a busy service | try later, or a smaller area or the main-roads profile |
| "no routable road in this area for the selected profile" | the box holds no usable road | move or enlarge the area |
| "daily limit of … reached" | the per-user daily quota | reuse a stored resource, or wait until tomorrow; the operator sets `MOVE_OPENLAB_DAILY_*` |
| Downloads are refused for my account | `MOVE_OPENLAB_EXTERNAL_FETCH=admin` | ask an administrator to prepare the area |
| The open-data import refuses my area | the carpooling registry covers France only | use a CSV or GeoJSON file, or synthetic demand |
| "no trip has both ends inside the area …" | the dataset and the area do not overlap, or latitude and longitude are swapped | check the mapping and the area |
| "… row(s) were rejected; confirm to save the … valid trip(s)" | invalid rows are never dropped silently | read the reasons, then confirm or fix the file |
| Generate cannot build a scenario from the sample trip dataset | the area's road network is not stored yet | prepare it once (needs network access) |
| "Basemap unavailable — data still shown" | tiles cannot be loaded, or `MOVE_OPENLAB_TILE_URL=none` | the map still works; see [MAPS.md](MAPS.md#tiles) |
| Place search is missing | `MOVE_OPENLAB_GEOCODER_URL=off` | click the map or draw a box instead |

## Results and comparison

| Symptom | Cause | Fix |
|---|---|---|
| A metric reads *Not configured* | the problem or the scenarios do not carry the data it needs | expected; the reason is under the metric in *Choose metrics* ([METRICS.md](METRICS.md#when-a-metric-has-no-value)) |
| CO₂ shows a dash | a vehicle parameter has no value, and none is assumed | enter the parameter in a new scenario version |
| ML figures read *Not available* | the problem provides no labelled evaluation for this method | expected ([ML_INTEGRATION.md](ML_INTEGRATION.md#ml-evaluation)) |
| No total next to another experiment's total | the two experiments do not cover the same scenario set | compare per scenario |
| Two results read *Not comparable* | the problem, the objective or the metric definitions differ | *Why?* lists the reasons; this is a verdict, not an error |
| A negative difference against the reference | the reference is a comparison baseline, not necessarily a proven optimum | read the status row: *not proven (time limit)* explains it |
| An experiment, area or dataset disappeared from the lists | it is hidden | profile menu → *Hidden records* → *Show again* |
| The *Private Research* entry is missing | no restricted problem is granted to your account, or none is installed | ask an administrator |

## Tests and checks

| Symptom | Cause | Fix |
|---|---|---|
| Sandbox tests are skipped | no working bubblewrap on this machine | install it; `MOVE_OPENLAB_REQUIRE_SANDBOX=1` turns the skip into a failure |
| `check_public_safety.py` reports a file | a secret pattern, an archive, a large binary, a home-directory path, an attribution trailer or a screened term | remove it from the tree; the report names the file and line, never the matched term |
| `ruff` reports differently from CI | another ruff version | CI and the `dev` extra pin `ruff==0.15.0` |

## Reporting a problem

Open an issue with the version (`GET /api/health`), the steps and the message. Never attach credentials, a data
directory or unpublished data. For a suspected vulnerability, follow [SECURITY.md](../SECURITY.md) instead of opening
an issue.
