# Security model

## Researcher plugins

Plugins are arbitrary Python code. They are **disabled by default** and enabled only by the operator, who sets both
an approved plugin directory (`MOVE_OPENLAB_PLUGIN_DIR`) and a plugin mode (`MOVE_OPENLAB_PLUGIN_MODE`).

| Mode | Who can register | Execution | Use it for |
|---|---|---|---|
| `disabled` (default) | nobody | none — built-in methods only | every installation that does not need plugins |
| `sandbox` | any signed-in researcher | verified bubblewrap sandbox (below); **refused** if the sandbox is unavailable or its isolation cannot be verified | shared installations, code you have not audited |
| `trusted-process` | administrators only | plain separate process with the server's permissions — **not a sandbox**; refused in production | a single administrator running their own code locally |

### The sandbox (Linux, bubblewrap)

Every plugin run — including the registration self-test — happens in a fresh sandbox:

| Property | Mechanism |
|---|---|
| No network | new network namespace: only an isolated loopback interface; the host's loopback services and the internet are unreachable |
| No server secrets | new PID namespace and private `/proc`: the server process and its environment are invisible; the sandbox environment is cleared except `PATH`, locale and thread settings |
| No other researchers' data | empty root filesystem; only `/usr` (and its compatibility links), the Python installation and the installed framework are mounted, read-only, plus the single plugin file; the data directory, the credential store, the plugin directory and home directories are not mounted; a configuration that would expose them is refused |
| Restricted processes | new PID, IPC, UTS, user and cgroup namespaces; all capabilities dropped; new session (no terminal injection); the sandbox dies with its parent |
| Resource bounds | memory and CPU-time rlimits, wall-clock timeout that kills the whole sandbox |
| Pinned code | the worker verifies the plugin's SHA-256 and executes exactly those bytes; a file changed after registration is refused |

**Fail closed.** Before plugins are used, the installation runs an isolation probe inside the exact sandbox
configuration and checks: loopback-only network, refused outbound connection, private PID namespace, minimal
environment of the sandbox init and of the worker, protected paths invisible, home contents invisible, installation
read-only. If bubblewrap is missing, the platform is not Linux, unprivileged user namespaces are blocked, or any check
fails, plugins are refused with the reason — there is no fallback to an unsandboxed process. A plugin registered
under one isolation mode must be registered again if the installation changes mode.

**Evidence.** `tests/test_plugin_security.py` replays the attacks found in the pre-release review with a probe
plugin launched from a server process that holds a secret in its environment. Without the sandbox the probe reads the
secret through `/proc/<parent>/environ`, reads another researcher's campaign, writes into the data directory, and
reaches a local service, the internet and DNS. In the sandbox all of these are blocked, and only the sandbox's own two
processes are visible. Further tests prove the fail-closed paths (bubblewrap missing, isolation unverifiable, sandbox
lost after registration, protected path inside a mounted root) and the administrator-only trusted mode.

**Remaining risks (sandbox mode).**
- No seccomp filter: the kernel attack surface reachable from an unprivileged user namespace remains; keep the
  kernel updated. A container or virtual machine adds a further layer for hostile code.
- No cgroup limits: memory and CPU are bounded by rlimits and the timeout; fork-heavy code is stopped by the timeout.
- The instance and configuration given to a plugin are visible to it by design; do not put secrets in them.
- The Python installation and framework code are readable (read-only) by plugins.

### Uploaded plug-ins

*+ Add method → Create from template → Upload the completed plug-in* (`POST /api/problems/{id}/methods/upload`)
lets a researcher add a plug-in without operator access. Uploads create plug-ins **only in the uploader's own
workspace, only in sandbox mode, and never executable outside the sandbox**:

| Rule | Enforcement (server side) |
|---|---|
| Mode | plug-ins enabled and in `sandbox` mode; in `trusted-process` mode a researcher gets 403 and even an administrator is refused (uploads only ever run in the sandbox) |
| Archive | at most 2 MB, 16 entries, 3 MB uncompressed (declared sizes and the bytes actually read are both bounded: zip-bomb guard); no absolute path, `..`, `.` or empty component, backslash, symbolic link, special file, encrypted entry, sub-directory or nested archive (by name and by content) |
| Contents | exactly one plug-in directory `<name>/` (`name`: lowercase letters, digits, `_`); `plugin.py` (at most 1 MB) plus only `test_plugin.py`, `README`, `README.md`, `README.txt`, `LICENSE`, `LICENSE.txt`, `LICENSE.md`, `NOTICE`, `AUTHORS`, `CHANGELOG.md` (UTF-8 text, at most 256 KB each); anything else is refused with the reason |
| Nothing executed | the archive is checked in memory before anything is written; `METADATA` is read statically (`ast.literal_eval`) and checked against the problem; a plug-in can never take a built-in method id |
| Storage | `<data>/workspaces/<user>/plugins/<name>@<version>/` (directory 0700, files 0600), with `upload.json` (code SHA-256, upload SHA-256, files); never the approved directory; another account gets 404 and never sees it listed |
| Identity | the same method id and version with other code is refused (bump the version); an identical re-upload changes nothing |
| Registration and runs | the same sandboxed self-test as any plug-in; the registration records `origin: "uploaded"`, the code SHA-256 and the upload SHA-256; before every run the stored file is hashed again and the worker executes exactly the verified bytes; only that one file is bound read-only at `/sandbox/plugin.py` — the data directory it lives in stays invisible |
| Audit | `plugin_uploaded`, `plugin_upload_refused` and `plugin_registered` are written to the audit log |

`tests/test_plugin_onboarding.py` covers every refusal above, isolation between accounts, hash pinning and a probe
plug-in, uploaded and run from a data directory outside `/tmp`, that cannot read the data directory, the credential
store, its own stored copy, or another account's plug-in and campaign.

### Trusted-process mode

A trusted-process plugin runs as the server user. It can read and modify everything that user can: the data
directory (all researchers' campaigns), the credential store and any reachable network service. `move-openlab serve`
marks the server process non-dumpable, which hides its environment and memory from other processes of the same user,
but this does not protect files. Use this mode only for code you would install as a Python package on the server.

## Bundles

Imports are verified completely before anything is written: archive integrity, safe member names, size limits, the
manifest digest, every file hash, every instance hash and structure, every campaign checksum, the lineage, and an
exact match of the problem specification and validator version with the local installation; for format 2, the
recomputed experiment and semantic fingerprints and the geometry members (each must belong to an instance of the
bundle, use only that instance's legs and start and end at the instance's own points). Imported geometry is stored
in the importer's workspace only, and exports rebuild it from the road network when it is installed. The sum of
uncompressed members is limited (256 MB) and a bundle may contain only the root campaign's lineage. Bundles contain JSON only; importing never executes code. Imported
campaigns are read-only. The shipped demonstration is imported through the same verified path.

Checksums are unkeyed SHA-256 values: they detect accidental or partial modification and any change to a bundle in
transit that is not accompanied by recomputed hashes; they do not authenticate the author against someone who can
rewrite both the records and their checksums. Treat a bundle's provenance as trustworthy as the channel it came from.

## Custom metrics

A registered custom metric is third-party code and gets the plug-in boundary, not the server's trust:

| Property | Mechanism |
|---|---|
| Never in the server process | metric files (`<approved plugin directory>/<name>/metric.py`) are discovered and checked statically (literal `METADATA`, `ast.literal_eval`); listing, registration, comparisons and charts never import them. Installed packages are not scanned and no `move_openlab.metrics` entry point is loaded |
| Same modes as method plug-ins | off unless plug-ins are enabled; registered per workspace; in `trusted-process` mode only administrators may register (a separate plain process, not a sandbox) |
| Isolation | every evaluation (and the registration self-test) runs in the verified bubblewrap sandbox described above: no network, no server environment, no data directory, credential store or other workspace, read-only installation |
| Fail closed | plug-ins off, sandbox unavailable or unverifiable, isolation mode changed since registration, file moved: the metric is listed with the reason and **no value**; nothing falls back to the server process |
| Pinned code | the SHA-256 is recorded at registration; the worker executes exactly the verified bytes and re-checks `METADATA` against the registration; a modified file is refused (register a new version) |
| Controlled inputs | only the inputs declared in `requires`, read from the validator's recomputed metrics, the CO₂ figures computed from validated decisions and counts of the frozen instance; read-only views |
| Validated outputs | the server accepts only a finite number (or a pair of finite numbers for `ratio-of-sums`); strings, booleans, NaN, other shapes, exceptions and timeouts give no value and are reported (`custom_issues`) |
| Resource bounds | 20 s wall-clock timeout per evaluation, 512 MB address space and CPU-time rlimits |

Built-in metrics (shipped in `move_openlab.custom_metrics`, reviewed with the framework) are the documented trusted
path: they run in the server process, with the same input filtering and output validation. An application embedding
the framework may register further in-process metrics with `custom_metrics.register()`, which is by definition code
it already runs.

**Evidence.** `tests/test_metric_security.py` registers probe metrics that try to read another researcher's
workspace, the credential store and the data directory, read the server's environment (its own and through
`/proc/*/environ`), reach a local service and the internet, write to their own file, loop forever, allocate 3 GB, return
invalid values and run after their file was modified. In the sandbox every attempt is blocked or refused, and the
same probe run in a plain process does see those resources (the probe is not vacuous). Further tests prove that
metric code never runs in the server process, that registrations belong to one workspace and that an unavailable
isolation gives no value. Remaining risks are those of the sandbox (above).

## Accounts and sessions

Passwords are hashed with scrypt. Sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies bound to a per-user
session version, so a password change or deactivation invalidates every older session. Failed sign-ins are
throttled per username and per client. Production mode (`MOVE_OPENLAB_ENV=production`) refuses to start without a
`SESSION_SECRET` of at least 32 characters or with trusted-process plugins, and adds HSTS. State-changing requests
with a foreign `Origin` are refused. Each user works in a private workspace; campaigns of other users are not visible.
The credential store's schema is versioned (`PRAGMA user_version`); a store written by a newer version is refused,
and an older store is migrated in place (schema 2 adds the supervision columns, guarded so that a partially migrated
store is completed rather than broken).

### Owner-only files

Files that hold secrets or personal data are readable and writable by the server's user only (mode `0600`), whatever
the process umask (`move_openlab.privatefiles`):

| File | Content | Creation | Existing wider file |
|---|---|---|---|
| `<data>/auth.sqlite3` (or `MOVE_OPENLAB_AUTH_DB`) | accounts, scrypt hashes | created empty with `0600` before SQLite opens it; SQLite gives its `-journal` / `-wal` / `-shm` files the database's mode | tightened when the store is opened (side files too) |
| `<data>/audit.log` | who did what to which account | appended through a descriptor opened with `0600` | tightened at server start and at the next entry |
| `<data>/problem-grants.json` | accounts granted a restricted problem | written to a `0600` temporary file, then renamed atomically | covered by the owner-only data directory (next paragraph) |
| `<data>/dev-credentials.json` | development passwords (`scripts/dev_provision.py`, `start-local.sh`) | written to a `0600` temporary file, then renamed atomically | tightened at server start; replaced by a `0600` file when rewritten |

Only the group and other permission bits are removed; contents are never touched. The rest of the data directory
(workspaces, experiments, instances, jobs, networks, datasets, caches) is owner-only too: the server runs with umask
`077`, so everything it creates is `0600` (files) or `0700` (directories), and at start it removes the group and other
bits from existing entries written by earlier versions (owner bits, including executable bits, are kept; symbolic
links are neither followed nor changed). `start-local.sh` also sets umask `077` before it creates its lock file.

### Roles and supervision

Three roles: **Administrator**, **Researcher** and **Student**. Every account works in its own isolated workspace;
roles only govern account management. An administrator may grant a researcher *Can supervise students*; such a
researcher creates student accounts (the student's supervisor is recorded on the account), resets their passwords and
deactivates or reactivates them — **only for their own students** (`/api/supervision/*`, every route checks the
supervisor column). Students have no account-management rights. Removing the flag ends the researcher's supervision
rights but keeps the students and their work; an administrator can reassign a student to another supervisor.

### Password policy

The policy is enforced on the server (`password_policy()`), and the sign-in pages only mirror it for live feedback:
at least 12 characters, three of the four character classes (lower case, upper case, digits, symbols), varied
characters, and nothing taken from the username or the display name. *Strong* means at least 16 characters with all
four classes. Accounts start with a temporary password shown once to the creator (`Cache-Control: no-store`) and must
change it at first sign-in: *New password* with a red / yellow / green strength indicator (`POST
/api/auth/password-policy`, which never stores what it checks) and *Repeat password* with a match indicator.

## Administration

Administrators create accounts of any role (a temporary password shown once, change forced at first sign-in), set
roles' supervision rights and students' supervisors, reset passwords, deactivate and reactivate accounts, grant
restricted problems to accounts (*Administration › Extensions*, below) and read the audit log (`GET /api/admin/audit`). They cannot deactivate themselves or the last active administrator, and cannot
reset their own password from the web interface (they use *Change password*). Deactivation and resets end every open
session of the account. Administrators have no access to other researchers' workspaces. Every action is appended to
`<data>/audit.log` (actor, action, target, time; never a password). Responses carrying a temporary password are sent
with `Cache-Control: no-store`. On the host, an operator can recover any account with
`move-openlab users reset-password <username>`.

## Restricted problems

A problem package may declare itself restricted (`Problem.restricted = True`): unpublished research, licensed data,
anything an installation must not show to every account. The application stays one application; the package is
installed next to it and granted per account ([PRIVATE_EXTENSIONS.md](PRIVATE_EXTENSIONS.md)).

| Property | Mechanism |
|---|---|
| Per-account grant | `<data>/problem-grants.json` maps a problem id to account names (`move_openlab.access`); written atomically with mode `0600`; it is installation data, never code |
| No role implies access | the grant is a list of names. An administrator who is not listed manages the list and sees the package's identification (identifier, title, providing distribution, versions) and nothing else |
| Enforced on the server | at the workspace (`Workspace.problem`, `allows`, `_visible`): listings omit a problem that is not granted; lookups, experiments, scenarios, result imports, exports and bundle imports answer *not found* |
| Indistinguishable from absence | the answer for a restricted problem that is not granted is the answer for a problem that is not installed, with the same message |
| Fail closed | a missing or unreadable grants file grants nothing; an invalid account name in a grant is refused; only existing accounts can be granted |
| Administrator routes | `GET /api/admin/extensions` and `PUT /api/admin/extensions/{problem_id}/access` check the administrator role on every request; a grant on an open problem is refused |
| Audited | every change of a grant (`set_problem_access`, with the resulting list) and every refused request for a restricted problem (`refused_restricted_problem`) is appended to the audit log |
| Revocation | takes effect at the account's next request; its records stay on disk and are neither listed nor opened |
| Interface | the *Private Research* entry is shown only to an account granted at least one restricted problem; it adds no access of its own |

Problems shipped with the framework are open, and an installation without a restricted package has nothing to grant.

**Evidence.** `tests/test_restricted_problems.py` marks the open synthetic problem as restricted for the duration of a
test — no private package is needed — and checks that an account without a grant, including an administrator, cannot
list the problem, read it, its methods or its metrics, create an experiment or import results; that a granted account
can run, lock and export; that another account cannot read that experiment, its scenario or its bundle, nor import
the bundle; that revocation hides the records without deleting them; and that grants and refusals are in the audit
log.

**Remaining risks.**
- It is access control in the application, not encryption at rest: whoever can read the data directory on the host
  can read the records. The data directory is owner-only ([Owner-only files](#owner-only-files)); protect the host and
  its backups.
- An exported bundle is a file outside the application's control. It imports only where the same package is installed
  and granted, but its JSON content is readable by whoever holds it.
- Plug-ins read the Python installation (read-only), which includes an installed restricted package and any data file
  shipped in it. Plug-in files reach the approved directory only through the operator, and uploaded plug-ins run
  only in the sandbox, which can still read the Python installation: on an installation with a restricted package
  keep plug-ins disabled, or admit only files that have been read.

## External services and open data

The server contacts external services only for explicit user actions, only at the configured URLs (clients can never
choose a target), and under fair-use limits. `MOVE_OPENLAB_EXTERNAL_FETCH=admin` restricts downloads to
administrators.

| Service | When it is contacted | Safeguards |
|---|---|---|
| Nominatim (place search) | when a researcher submits a search | installation-wide one request per second (a search that would wait over 5 s is refused); 30-day cache; daily quota per user (cache hits free); query ≤ 120 characters; response ≤ 512 KB; can be switched off |
| Overpass API (OpenStreetMap) | when an area's network is downloaded and no stored network matches | background job, one at a time; area within the profile limit; response ≤ 256 MB; daily quota; identifying User-Agent; raw response hashed and stored with the network |
| data.gouv.fr (RPC releases) | when releases are listed or one is ingested for an area in France | HTTPS data.gouv.fr hosts only, checked on every redirect; background job, one at a time; daily quota; streamed and hashed; only rows inside the area kept, without identifiers; partial files removed on failure or cancellation |
| Map tile server | by the browser, for map display | the Content Security Policy allows images from the configured tile origin only; tile requests send the page origin as referrer (`strict-origin-when-cross-origin`, as tile servers such as tile.openstreetmap.org require), never the path; `MOVE_OPENLAB_TILE_URL=none` disables the basemap |

Quotas are charged only when a request is really sent and refunded when a job could not start. Shared resources
(road networks, RPC subsets) record a box and a profile, never a researcher's private area name.

## Uploaded datasets

- Request bodies above the route's limit (25 MB for dataset uploads, the bundle limit for imports, 2 MB elsewhere)
  are refused before being read or spooled to disk; the streamed byte count is checked as well as Content-Length.
- Parsing runs in the server's thread pool, at most two uploads at a time; row, column, field-size and feature limits
  are enforced while reading; malformed CSV or JSON (including deeply nested JSON) is a 400 error.
- The raw file is never stored. Validated trips and a report (file name, size, SHA-256, mapping, rejections) are kept
  in the uploader's workspace only; other researchers receive 404 for them.
- Nothing is guessed silently: ambiguous time formats, unsupported coordinate systems and invalid geometries are
  refused; rejected rows are counted and saving them away requires explicit confirmation.

Scenario coordinates are snapped to the stored network (at most 1.5 km away) and a scenario holds at most 200 agents.
Areas, datasets, scenarios, instances, route playback and jobs are served only within the requesting researcher's
workspace.

Open-data records are anonymised by their publisher (no identifiers, truncated coordinates, times rounded to 10
minutes). MOVE OpenLab keeps no identifiers; a generated scenario resamples published origin–destination pairs with
re-drawn departure times, so on a small area it can closely mirror the published records. That reuse is allowed by
the licence; users remain bound by it and by personal-data law, which forbid re-identification.

## Secrets and credentials

The application needs one secret of its own, and no key for any external service: the services it contacts
(Overpass, the place search, the open-data portal, the tile server) are used without credentials.

| Item | Where it lives | Never |
|---|---|---|
| Session signing key (`SESSION_SECRET`) | the environment of the server process, set by the operator or the service manager; random at each start in development | in the repository, in a committed `.env` file, in a bundle, in a log |
| Passwords | only as scrypt hashes in `<data>/auth.sqlite3` (mode `0600`) | stored or logged in clear |
| Temporary passwords | shown once to the creator in a `no-store` response, or printed once by `move-openlab users add` / `reset-password` on the host | in the audit log |
| Development passwords | `<data>/dev-credentials.json` (mode `0600`), written by `start-local.sh` and `scripts/dev_provision.py`, which refuses production mode | printed; outside the data directory |
| Restricted-problem grants | `<data>/problem-grants.json` (mode `0600`) | in code or in the repository |
| Screening terms of the confidentiality gate | a file outside the repository, or the CI secret `PUBLIC_DENYLIST` | in the repository, even hashed |

What must never be committed: a data directory (`.openlab-data/` is ignored by Git), a credential store
(`*.sqlite3`), a `.env` file other than an example, a private key or an access token, a password or its hash, a
bundle or any other archive, unpublished data, a model file, and any name of a private study, dataset or person.

How secrets are kept away from code that should not see them:

- workers start with a minimal environment (`PATH`, hash seed, thread and locale settings): nothing of the server's
  environment is inherited by a method;
- the sandbox clears the environment and hides the server process, the data directory and the credential store;
- `move-openlab serve` marks the server process non-dumpable, so other processes of the same user cannot read its
  environment or memory;
- bundles contain records only: no password, no session, no server configuration;
- the instance and the configuration given to a method are visible to it by design — do not put secrets in them.

## Repository hygiene

`scripts/check_public_safety.py` runs in the test suite (`tests/test_public_safety.py`) and in CI. It scans every file
Git would track — tracked and untracked, honouring `.gitignore` — for:

| Check | Finds |
|---|---|
| Screened terms | project-specific terms, matched without case or accents. The list is never stored in the repository — not even hashed, since hashes of short words are reversible by dictionary search. It is supplied with `--denylist FILE` or the `MOVE_OPENLAB_DENYLIST` environment variable (a CI secret); matches are reported by file and line without printing the term |
| Secrets | private keys, common cloud and code-hosting token formats, database URLs with credentials, password hashes, non-example `.env` files |
| Archives and large binaries | archive and model file extensions, and any file above 1 MB |
| Local paths | absolute home-directory paths |
| Import-path changes | `sys.path` manipulation in Python sources |
| Attribution trailers | automated co-author or tool-attribution lines |

Exit status 0 means clean; 1 means findings, printed as `path:line: reason`.

### Confidentiality checklist before a release

- [ ] `python scripts/check_public_safety.py --require-denylist --denylist <path-outside-the-repository>/public_denylist.txt`
      exits 0 on the release branch. `--require-denylist` fails when no screening list is supplied, so the release
      check cannot pass on the generic checks alone.
- [ ] The CI secret `PUBLIC_DENYLIST` is configured; pull requests from forks run the generic checks only.
- [ ] No data directory, credential store, bundle, archive or model file is in the tree or in the history to be
      published.
- [ ] No restricted problem package, and no reference to one, is in the tree: the public tests run without any
      private asset.
- [ ] Documentation, screenshots, examples and commit messages name only the framework and its public
      demonstrations; no local path, account name or port of a particular installation.
- [ ] Example data is synthetic or openly licensed, with its licence stated
      ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).
- [ ] The licence, the citation details and the repository visibility are decided by the maintainer
      ([RELEASING.md](RELEASING.md)).
