# Security policy

## Supported versions

MOVE OpenLab is pre-1.0. Security fixes are made on `develop` and released in the next version; the latest release
is the only supported version.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting for this repository
(*Security* tab → *Report a vulnerability*). Do not open a public issue, pull request or discussion for a suspected
vulnerability.

Include the affected component, a reproduction on a local installation and the impact. Never include real
credentials or private data. Reports are acknowledged and handled on a best-effort basis by the maintainer; a fix is
coordinated with the reporter before public disclosure.

## Scope

In scope, in particular:
- escapes from the plugin sandbox or bypasses of its fail-closed checks;
- authentication, session or workspace-isolation flaws;
- bundle import accepting tampered or unsafe content;
- leaks of secrets or other researchers' data through the API or the web interface.

Trusted-process plugin mode is documented as not being a sandbox; code execution by an administrator-approved
trusted plugin is expected behaviour, not a vulnerability.

The security design and its known limitations are described in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).
