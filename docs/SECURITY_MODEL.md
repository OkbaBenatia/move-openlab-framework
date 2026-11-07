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

### Trusted-process mode

A trusted-process plugin runs as the server user. It can read and modify everything that user can: the data
directory (all researchers' campaigns), the credential store and any reachable network service. `move-openlab serve`
marks the server process non-dumpable, which hides its environment and memory from other processes of the same user,
but this does not protect files. Use this mode only for code you would install as a Python package on the server.

## Bundles

Imports are verified completely before anything is written: archive integrity, safe member names, size limits, the
manifest digest, every file hash, every instance hash and structure, every campaign checksum, the lineage, and an
exact match of the problem specification and validator version with the local installation. Bundles contain JSON
only; importing never executes code. Imported campaigns are read-only.

Checksums are unkeyed SHA-256 values: they detect accidental or partial modification and any change to a bundle in
transit that is not accompanied by recomputed hashes; they do not authenticate the author against someone who can
rewrite both the records and their checksums. Treat a bundle's provenance as trustworthy as the channel it came from.

## Accounts and sessions

Passwords are hashed with scrypt. Sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies bound to a per-user
session version, so a password change or deactivation invalidates every older session. Failed sign-ins are
throttled per username and per client. Production mode (`MOVE_OPENLAB_ENV=production`) refuses to start without a
`SESSION_SECRET` of at least 32 characters or with trusted-process plugins, and adds HSTS. State-changing requests
with a foreign `Origin` are refused. Each user works in a private workspace; campaigns of other users are not visible.
The credential store's schema is versioned (`PRAGMA user_version`); a store written by a newer version is refused.

## Administration

Administrators create accounts (a temporary password shown once, change forced at first sign-in), reset passwords,
deactivate and reactivate accounts. They cannot deactivate themselves or the last active administrator, and cannot
reset their own password from the web interface (they use *Change password*). Deactivation and resets end every open
session of the account. Administrators have no access to other researchers' workspaces. Every action is appended to
`<data>/audit.log` (actor, action, target, time; never a password). Responses carrying a temporary password are sent
with `Cache-Control: no-store`. On the host, an operator can recover any account with
`move-openlab users reset-password <username>`.

## External services and open data

The server contacts external services only for explicit user actions, only at the configured URLs (clients can never
choose a target), and under fair-use limits. `MOVE_OPENLAB_EXTERNAL_FETCH=admin` restricts downloads to
administrators.

| Service | When it is contacted | Safeguards |
|---|---|---|
| Nominatim (place search) | when a researcher submits a search | installation-wide one request per second (a search that would wait over 5 s is refused); 30-day cache; daily quota per user (cache hits free); query ≤ 120 characters; response ≤ 512 KB; can be switched off |
| Overpass API (OpenStreetMap) | when an area's network is downloaded and no stored network matches | background job, one at a time; area within the profile limit; response ≤ 256 MB; daily quota; identifying User-Agent; raw response hashed and stored with the network |
| data.gouv.fr (RPC releases) | when releases are listed or one is ingested for an area in France | HTTPS data.gouv.fr hosts only, checked on every redirect; background job, one at a time; daily quota; streamed and hashed; only rows inside the area kept, without identifiers; partial files removed on failure or cancellation |
| Map tile server | by the browser, for map display | the Content Security Policy allows images from the configured tile origin only |

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

## Repository hygiene

`scripts/check_public_safety.py` runs in the test suite and in CI: secret patterns, archives and large binaries,
absolute home paths, global import-path changes and automated attribution trailers. Project-specific screening terms
are never stored in the repository — not even hashed, since hashes of short words are reversible by dictionary
search. They are supplied at run time with `--denylist FILE` or the `MOVE_OPENLAB_DENYLIST` environment variable (a CI
secret); matches are reported by file and line without printing the term.
