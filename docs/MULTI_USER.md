# Several users on one installation

One installation serves several accounts. Each account works in its own workspace; roles decide who manages
accounts, never who sees whose experiments. This page describes the roles, what is private and what is shared, how
two researchers exchange and reproduce an experiment, the administration pages and the audit log.

## Accounts and roles

Accounts are local to an installation. There is no self-registration: an account is created by an administrator, by
a supervising researcher (students only), or on the host with `move-openlab users add`.

| Role | Own isolated workspace | Account management |
|---|---|---|
| **Administrator** | yes | creates accounts of any role, resets passwords, deactivates and reactivates, grants supervision, assigns supervisors, grants restricted problems, reads the audit log |
| **Researcher** | yes | none — unless granted *Can supervise students*: then creates, resets and deactivates **their own** students |
| **Student** | yes | none |

Three statements that follow from the code and are worth reading twice:

- **Roles govern account management only.** In a workspace, a student can do what a researcher can do.
- **An administrator has no access to other accounts' workspaces.** Managing an account does not open its
  experiments.
- **No role implies access to a restricted problem** — including the administrator role
  ([PRIVATE_EXTENSIONS.md](PRIVATE_EXTENSIONS.md)).

A username has 2 to 32 characters: lowercase letters, digits, `.`, `_`, `-`. A student account records the
supervising researcher (or administrator) it belongs to.

**Passwords.** Every new account starts with a temporary password, shown once to its creator, and must change it at
the first sign-in. The policy is enforced on the server: at least 12 characters, three of the four character classes,
nothing taken from the username or the display name. Passwords are stored as scrypt hashes only.

**Sessions.** A session lasts 8 hours by default (`SESSION_TTL_HOURS`). A password change, a reset or a deactivation
ends every open session of the account.

**Language and preferences.** The interface is in English by default and in French with the **EN | FR** switch in
the header; the sign-in and change-password pages carry the same switch. A switch applies at once for the current
browser session, and the question *Make this my default language?* keeps it for the account when answered *Yes*. The
language, the appearance (light or dark), the chosen metrics, hidden records, the working area and the last Workspace
view are stored per account.

## What is private, what is shared

| Private to one account (its workspace) | Shared by the installation |
|---|---|
| experiments and their runs | the installed problems that are not restricted |
| scenarios in the scenario library | road networks, identified by box and profile — never by a private area name |
| areas | open-data subsets (read-only) |
| uploaded datasets | the place-search cache |
| registered method plug-ins and custom metrics | the approved plug-in directory (files; a registration is per workspace) |
| study views, vehicle profiles, preferences, hidden records | |
| background jobs and their traces | |
| replay geometry imported with bundles | |

Isolation is enforced on the server, on every request: an experiment, scenario, dataset, job or route of another
account answers *not found*, as if it did not exist. Frozen scenarios are stored once per installation by their
content hash, but a scenario is served only to an account whose experiments or scenario library use it.

Plug-ins never cross this boundary either: a sandboxed method or metric sees the one scenario it is given and no
workspace, no data directory and no credential store ([SECURITY_MODEL.md](SECURITY_MODEL.md)).

**Per-user limits.** Downloads from public services are counted per user and per day (road networks, open-data
ingestions, place searches), and each external service receives one request at a time for the whole installation.
`MOVE_OPENLAB_EXTERNAL_FETCH=admin` reserves downloads for administrators.

## Hidden records

Hiding is a per-account way to tidy lists. An experiment, area, dataset or scenario is hidden with the eye button
next to it; it leaves the normal lists, their counts and the comparison candidates. Nothing is deleted: *Hidden
records*, in the profile menu, lists everything hidden, by kind, with *Show again*.

## Export → import → reproduce between two researchers

Workspaces are isolated, so two researchers share an experiment the same way whether they use one installation or
two: through a bundle.

| # | Who | Where to click | What appears |
|---|---|---|---|
| 1 | Researcher A | open the experiment → **Export** → **Lock and export** | one `.zip` and its SHA-256 |
| 2 | A → B | send the file and the SHA-256 by any channel | — |
| 3 | Researcher B | **Import ▾ → Import a bundle file…** | the inspection report; nothing stored yet; compare the SHA-256 |
| 4 | B | **Import experiment** | the experiment, marked *Imported*, read-only, *Integrity verified* |
| 5 | B | **Run again** | a re-execution in B's workspace; *Reproduced* when every validated metric is equal |
| 6 | B | **+ Add method** → run | an extension on the same frozen scenarios; the imported original unchanged |
| 7 | B | **Compare** | methods side by side; under *Experiments*, validation, reproducibility and comparability claim by claim |
| 8 | B → A | **Export** the extension | a bundle with the whole lineage, which A imports in turn |

What B needs for step 5: the same problem installed with the same specification and validator version, and the same
methods. A built-in method comes with the problem package. A plug-in is never carried by a bundle: B installs the
same file — same version, same code hash — in the approved plug-in directory and registers it. Runtimes are reported
and never required to match: they depend on the machine. The sequence is drawn in
[DIAGRAMS.md](DIAGRAMS.md#4-export-import-and-reproduction-between-two-researchers) and can be tried alone with the
sample bundle ([IMPORT_EXPORT.md](IMPORT_EXPORT.md#b--experiment-bundle-the-sample-bundle)).

A bundle's checksums detect corruption and inconsistent edits; they do not authenticate its author. Treat a bundle
as trustworthy as the channel it came through, and reproduce the results to check them independently.

## Study views

A study view shows methods of several **experiments of one workspace** together, because they were evaluated on
the same scenarios — for example a reference method from one experiment and a method added later in another.

- Nothing is merged or rewritten: every row keeps its own experiment, origin and provenance, and names the
  experiment it comes from.
- Members must have results on the same scenarios, under the same problem specification and validator version; an
  experiment that does not match is refused, never adapted.
- A study is presentation only. It is stored next to the experiments (`studies.json` of the workspace), never inside
  a record; deleting it deletes nothing else. A study with a member the account can no longer read is not listed.
- An experiment that belongs to a study opens in that study's view by default; *History* switches to the
  experiment's own records (`GET /api/lab/experiments/{id}?view=records`).

Studies are saved through the API — `PUT /api/lab/studies` with a title, an optional description and 1 to 12 members
`{campaign_id, method_id, label?, note?}`; `GET /api/lab/studies` lists them and
`DELETE /api/lab/studies/{study_id}` removes one. The interface displays saved studies; it has no form to create
one. Tests: `tests/test_studies.py`.

## Administration

*Administration*, in the profile menu of an administrator, has three tabs.

| Tab | What it does |
|---|---|
| **Accounts** | list and filter accounts; *New account* (role, supervisor for a student, *Can supervise students* for a researcher) shows the temporary password once; reset a password; deactivate or reactivate; change supervision rights and supervisors |
| **Extensions** | the problem packages installed here, the distribution providing each, its specification and validator version, packages that failed to load, the plug-in mode; for a restricted package, the accounts granted access |
| **Audit log** | the most recent administrative actions |

Safeguards: an administrator cannot deactivate themselves or the last active administrator, and cannot reset their
own password from this page (they use *Change password*). Responses that carry a temporary password are sent with
`Cache-Control: no-store`. A researcher allowed to supervise sees *My students* in the profile menu, limited to
their own students. On the host, `move-openlab users reset-password <username>` recovers any account.

Every route under `/api/admin` checks the administrator role on the server; hiding the menu entry is not the
protection.

## Audit log

`<data>/audit.log` is an append-only file of JSON lines, readable and writable by the server's user only:

```json
{"t": 1760000000, "actor": "alice", "action": "create_user", "target": "bob"}
```

| Action | Recorded when |
|---|---|
| `create_user`, `reset_password`, `deactivate`, `reactivate` | an administrator manages an account |
| `grant_supervision`, `revoke_supervision`, `set_supervisor` | supervision rights or a student's supervisor change |
| `create_student`, `reset_student_password`, `deactivate_student`, `reactivate_student` | a supervising researcher manages one of their students |
| `set_problem_access` | the accounts granted a restricted problem are replaced (the target lists them) |
| `refused_restricted_problem` | an account asked for a restricted problem it is not granted |

It never contains a password or another secret. Administrators read the latest entries under *Administration ›
Audit log* (`GET /api/admin/audit`).
