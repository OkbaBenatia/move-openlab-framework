"""Account administration — administrators only, enforced on every request (the interface only hides the entry).

Roles: ``admin`` (manages every account), ``researcher`` (own workspace; with *Can supervise students* may create and
manage their own students — see :mod:`.supervision`), ``student`` (own isolated workspace, no administration).
Temporary passwords are generated server-side, returned once in a ``no-store`` response, never logged and never
stored (only scrypt hashes are kept). Every administrative action is appended to ``<data>/audit.log`` (JSON lines:
time, actor, action, target — no secrets); administrators can read it. Administrators manage accounts; they do not
gain access to other users' workspaces.
"""
from __future__ import annotations

import json
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import privatefiles
from ..auth.store import ROLE_LABELS, ROLES

router = APIRouter(prefix="/api/admin")
_audit_lock = threading.Lock()


def _admin(request: Request):
    ses = request.state.session
    if ses is None or not ses.is_admin:
        raise HTTPException(403, "administrator role required")
    return ses


def audit(request: Request, actor: str, action: str, target: str) -> None:
    f = request.app.state.settings.data_dir / "audit.log"
    with _audit_lock:                                # owner-only (0600): who did what to which account
        privatefiles.append(f, json.dumps(dict(t=int(time.time()), actor=actor, action=action, target=target)) + "\n")


def no_store(body: dict) -> JSONResponse:
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


class CreateUser(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    display_name: str = Field(min_length=2, max_length=80)
    role: str = Field("researcher")
    supervisor: str | None = Field(None, max_length=32)       # students only
    can_supervise: bool = False                              # researchers only


class Supervision(BaseModel):
    can_supervise: bool


class Supervisor(BaseModel):
    supervisor: str | None = Field(None, max_length=32)


def user_rows(request: Request, users) -> list[dict]:
    auth, inst = request.app.state.auth, request.app.state.installation
    out = []
    for u in users:
        d = inst.data / "workspaces" / u.username / "campaigns"
        out.append(dict(auth.public_user(u), campaigns=sum(1 for _ in d.glob("*/campaign.json")) if d.is_dir() else 0))
    return out


@router.get("/users")
def list_users(request: Request):
    _admin(request)
    return dict(users=user_rows(request, request.app.state.auth.store.list()), roles=list(ROLES), role_labels=ROLE_LABELS)


@router.post("/users")
def create_user(body: CreateUser, request: Request):
    ses = _admin(request)
    auth = request.app.state.auth
    try:
        user, temp = auth.create_user(body.username, body.display_name, body.role, created_by=ses.username,
                                      supervisor=body.supervisor if body.role == "student" else None)
        if body.role == "researcher" and body.can_supervise:
            user = auth.set_supervision(user.username, True)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    audit(request, ses.username, "create_user", user.username)
    return no_store(dict(user=auth.public_user(user), temporary_password=temp))


@router.post("/users/{username}/reset-password")
def reset_password(username: str, request: Request):
    ses = _admin(request)
    if username == ses.username:            # would end this session before the one-time password could be shown
        raise HTTPException(409, "use Change password for your own account")
    try:
        user, temp = request.app.state.auth.reset_password(username)
    except KeyError:
        raise HTTPException(404, "unknown user") from None
    audit(request, ses.username, "reset_password", user.username)
    return no_store(dict(user=request.app.state.auth.public_user(user), temporary_password=temp))


def _set_active(username: str, request: Request, active: bool):
    ses = _admin(request)
    try:
        user = request.app.state.auth.set_active(ses.username, username, active)
    except KeyError:
        raise HTTPException(404, "unknown user") from None
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    audit(request, ses.username, "reactivate" if active else "deactivate", user.username)
    return dict(user=request.app.state.auth.public_user(user))


@router.post("/users/{username}/deactivate")
def deactivate(username: str, request: Request):
    return _set_active(username, request, False)


@router.post("/users/{username}/reactivate")
def reactivate(username: str, request: Request):
    return _set_active(username, request, True)


@router.put("/users/{username}/supervision")
def set_supervision(username: str, body: Supervision, request: Request):
    """Grant or withdraw *Can supervise students* for a researcher."""
    ses = _admin(request)
    try:
        user = request.app.state.auth.set_supervision(username, body.can_supervise)
    except KeyError:
        raise HTTPException(404, "unknown user") from None
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    audit(request, ses.username, "grant_supervision" if body.can_supervise else "revoke_supervision", user.username)
    return dict(user=request.app.state.auth.public_user(user))


@router.put("/users/{username}/supervisor")
def set_supervisor(username: str, body: Supervisor, request: Request):
    """Assign (or clear) the supervising researcher of a student."""
    ses = _admin(request)
    try:
        user = request.app.state.auth.set_supervisor(username, body.supervisor)
    except KeyError:
        raise HTTPException(404, "unknown user") from None
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    audit(request, ses.username, "set_supervisor", f"{user.username}<-{user.supervisor or '-'}")
    return dict(user=request.app.state.auth.public_user(user))


class AccessBody(BaseModel):
    usernames: list[str] = Field(default_factory=list, max_length=200)


@router.get("/extensions")
def extensions(request: Request):
    """The problem packages installed here (identifier, title, providing distribution) and, for restricted ones, the
    accounts granted access. Identification only: what a restricted package contains is shown to granted accounts."""
    _admin(request)
    from .. import registry
    inst = request.app.state.installation
    st = inst.plugin_status()
    return dict(problems=[dict(problem_id=p.problem_id, title=p.title, synthetic=p.synthetic, restricted=bool(p.restricted),
                               specification=p.problem_spec_version, validator=p.validator_version,
                               granted=inst.access.granted(p.problem_id) if p.restricted else None,
                               **registry.origin(p.problem_id)) for p in registry.all_problems()],
                load_errors=registry.load_errors(), group=registry.GROUP,
                plugins=dict(mode=st["mode"], enabled=st["enabled"], reason=st["reason"]))


@router.put("/extensions/{problem_id}/access")
def set_access(problem_id: str, body: AccessBody, request: Request):
    """Replace the accounts that may use a restricted problem. No role implies access: only listed accounts get it."""
    ses = _admin(request)
    from .. import registry
    try:
        p = registry.get(problem_id)
    except registry.UnknownProblem as e:
        raise HTTPException(404, str(e)) from None
    if not p.restricted:
        raise HTTPException(400, "this problem is open to every account of the installation; there is nothing to grant")
    store = request.app.state.auth.store
    unknown = [u for u in body.usernames if store.get(u) is None]
    if unknown:
        raise HTTPException(404, f"unknown account: {unknown[0]}")
    try:
        users = request.app.state.installation.access.set(problem_id, body.usernames)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    audit(request, ses.username, "set_problem_access", f"{problem_id}: {', '.join(users) or '(nobody)'}")
    return dict(problem_id=problem_id, granted=users)


@router.get("/audit")
def audit_log(request: Request, limit: int = 200):
    """The most recent administrative actions (time, actor, action, target; never a secret)."""
    _admin(request)
    f = request.app.state.settings.data_dir / "audit.log"
    rows = []
    if f.exists():
        for line in f.read_text().splitlines()[-max(1, min(limit, 2000)):]:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return dict(entries=list(reversed(rows)))
