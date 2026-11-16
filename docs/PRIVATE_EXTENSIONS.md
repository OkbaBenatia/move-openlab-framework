# Private extensions: restricted problem packages

Some research cannot be shown to every account of an installation: an unpublished formulation, licensed data, work
under review. MOVE OpenLab handles this without a second application.

**There is one application.** A group installs its own problem package next to the framework. When the package
declares itself *restricted*, an administrator grants it to named accounts. Those accounts use it through the same
Workspace, Compare and Export pages as any public problem. Every other account sees nothing of it — and an
installation without such a package shows nothing of the kind at all.

The picture is in [DIAGRAMS.md](DIAGRAMS.md#6-optional-restricted-problem-package-in-one-application).

## How it works

| Element | Where | Rule |
|---|---|---|
| The package | an installed Python distribution exposing a `Problem` under the entry-point group `move_openlab.problems` | installed by the operator of the installation; never from the interface |
| The restriction | `restricted = True` on the problem class | declared by the package itself |
| The grant | `<data>/problem-grants.json`: `{problem id: [username, ...]}`, readable by the server's user only | installation data, never code; set by an administrator |
| Enforcement | the server, at the workspace (`Workspace.problem`, `allows`, `_visible`) | on every request |

```python
from move_openlab.problem import Problem


class MyProblem(Problem):
    restricted = True          # visible only to the accounts an administrator granted it to
    ...
```

Problems shipped with the framework are not restricted: they are open to every account, and there is nothing to
grant for them.

**No role implies access.** The grant is a list of account names. An administrator who is not on the list manages
the list and sees the package's identification, and nothing else of it.

## Installing a restricted package

1. Install the package in the Python environment that runs MOVE OpenLab, from wherever the group keeps it:

   ```bash
   .venv/bin/pip install /path/to/restricted-package
   ```

2. Restart the server. Problems are discovered from installed distributions when the server starts.
3. Sign in as an administrator and open *Administration › Extensions*. The package is listed with its identifier,
   title, the distribution that provides it, its specification and validator version, and the badge *Restricted*. A
   package that failed to load is listed with its error.

Until someone is granted, nobody can use it.

## Granting accounts

| Where to click | What appears |
|---|---|
| *Administration › Extensions*, the row of the restricted package | one checkbox per account of the installation |
| Tick an account | the grant is stored at once and recorded in the audit log |
| Untick it | access ends at the next request of that account |

The same through the API, replacing the whole list:

```
PUT /api/admin/extensions/{problem_id}/access
{"usernames": ["alice", "bob"]}
```

An unknown account name is refused, and so is a grant on a problem that is not restricted. `GET
/api/admin/extensions` returns what the page shows. Both routes require the administrator role.

## What a granted account sees

One application, two explicit contexts:

- **Public Workspace** (the default at sign-in). A granted account works exactly like any other account here: the
  lists, the Workspace, Compare, the Library, the jobs and the exports show public problems and records only.
- **Private Research.** The header has a **Private Research** entry — only for an account granted at least one
  restricted problem. Clicking it enters the context: the saved study of the restricted problem opens in the Workspace
  on its featured scenario, a bar under the header says *Private Research — restricted records, shown to your account
  only*, and only restricted records are listed. *Studies and history* in that bar opens the overview: each granted
  problem with its study views — *Open on the map*, *Compare the methods* — and, folded apart, *History and advanced
  records* (earlier pilots, settings versions, extensions and drafts, kept for audit).
- **Leaving.** Clicking **Workspace** while in Private Research asks *"Exit Private Research and return to the public
  Workspace?"* with **Exit to Workspace** and **Cancel**. On confirmation the public Workspace starts again on a public
  experiment (the demonstration when there is one); private selections, map layers and results leave the screen.
  Nothing is deleted or changed. A bookmarked address of a restricted record opens in the Private Research context;
  Back to a public address returns to the public one.

The separation is enforced by the server, not only by the pages: every request made from the public context carries
`X-Move-Context: public`, and the server then leaves restricted problems and their records out of every answer —
lists, lookups, scenarios, jobs, exports — even for a granted account. The header can only narrow an answer: it gives
an account without a grant nothing, whatever its value.

Everything goes through the ordinary pages: there is no second interface and no separate storage format.

## What every other account sees

Nothing. For an account that is not granted — whatever its role — a restricted problem behaves exactly like a
problem that is **not installed**:

| Request | Answer |
|---|---|
| lists of problems (`GET /api/problems`, `GET /api/info`) | the problem is absent |
| the problem, its methods, its metrics | *not found*, with the same message as for an unknown problem |
| creating an experiment, importing results | *not found* |
| an experiment, a scenario, an export of that problem | *not found* |
| importing a bundle of that problem | refused: the problem *is not installed here* |
| the header | no *Private Research* entry |

Each refused request for a restricted problem is recorded in the audit log (`refused_restricted_problem`). Tests:
`tests/test_restricted_problems.py` — they mark the open synthetic problem as restricted for the duration of a test,
so no private package is needed to run them.

## Revoking

Unticking an account ends its access immediately. Its records of that problem are **not deleted**: they stay on
disk, in its workspace, and are no longer listed or opened. Granting the account again makes them reachable again.
A study view with a member the account can no longer read is not listed.

## What the restriction does not do

State these to the group before relying on the feature.

- **It is access control in the application, not encryption.** Records are plain files in the data directory.
  Whoever can read that directory on the host — the operator, a backup — can read them. Protect the host, the data
  directory and its backups accordingly; the server keeps them owner-only.
- **An exported bundle is a file.** A granted account can export an experiment of a restricted problem; from then on
  the `.zip` is outside the application's control. It imports only where the same package is installed and granted,
  but its JSON content is readable by anyone who holds the file.
- **Installed code is readable by plug-ins.** A sandboxed plug-in sees the Python installation read-only, and that
  includes an installed restricted package and any data file shipped inside it. Plug-in files must be placed in the
  approved plug-in directory by the operator before anyone can register them: on an installation with a restricted
  package, keep plug-ins disabled, or admit into that directory only files that have been read.
- **Administrators see that the package exists**: its identifier, title, distribution and versions.
- **The grants file fails closed**: a missing or unreadable file grants nothing.

## Keeping private code and data outside the repository

The public repository contains the framework and its public demonstrations only. A restricted package lives
elsewhere.

| Keep | Where |
|---|---|
| The package (code, model files, its tests) | its own private repository or distribution; installed with `pip`, never copied into this checkout |
| Its data | inside the package or in a location the package reads; never under `examples/`, `plugins/` or `src/` of this repository |
| The data directory of an installation | outside the checkout, or under the Git-ignored `.openlab-data/` |
| Bundles of restricted experiments | wherever the group stores confidential files; `*.zip` is ignored by Git and refused by the public-safety check |
| The names of private studies, datasets and people | out of every public file, issue, pull request and commit message |

Before every commit to the public repository, run the confidentiality gate with the screening list of your
installation, kept outside the repository:

```bash
.venv/bin/python scripts/check_public_safety.py --denylist <path-outside-the-repository>/public_denylist.txt
```

It reports matches by file and line without printing the term ([SECURITY_MODEL.md](SECURITY_MODEL.md#repository-hygiene)).
The public test suite and CI need no private asset: nothing in the repository imports, names or downloads a
restricted package.
