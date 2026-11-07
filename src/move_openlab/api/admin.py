"""Account administration — administrators only, enforced on every request (the interface only hides the entry).

Temporary passwords are generated server-side, returned once in a ``no-store`` response, never logged and never
stored (only scrypt hashes are kept). Every administrative action is appended to ``<data>/audit.log`` (JSON lines:
time, actor, action, target — no secrets). Administrators manage accounts; they do not gain access to other users'
workspaces.
"""
from __future__ import annotations

import json
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..auth.store import ROLES

router = APIRouter(prefix="/api/admin")
_audit_lock = threading.Lock()


def _admin(request: Request):
    ses = request.state.session
    if ses is None or not ses.is_admin:
        raise HTTPException(403, "administrator role required")
    return ses


def _audit(request: Request, actor: str, action: str, target: str) -> None:
    f = request.app.state.settings.data_dir / "audit.log"
    f.parent.mkdir(parents=True, exist_ok=True)
    with _audit_lock, f.open("a") as fh:
        fh.write(json.dumps(dict(t=int(time.time()), actor=actor, action=action, target=target)) + "\n")


def _no_store(body: dict) -> JSONResponse:
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


class CreateUser(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    display_name: str = Field(min_length=2, max_length=80)
    role: str = Field("researcher")


@router.get("/users")
def list_users(request: Request):
    _admin(request)
    auth, inst = request.app.state.auth, request.app.state.installation
    users = []
    for u in auth.store.list():
        d = inst.data / "workspaces" / u.username / "campaigns"
        users.append(dict(auth.public_user(u), campaigns=sum(1 for _ in d.glob("*/campaign.json")) if d.is_dir() else 0))
    return dict(users=users, roles=list(ROLES))


@router.post("/users")
def create_user(body: CreateUser, request: Request):
    ses = _admin(request)
    try:
        user, temp = request.app.state.auth.create_user(body.username, body.display_name, body.role, created_by=ses.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    _audit(request, ses.username, "create_user", user.username)
    return _no_store(dict(user=request.app.state.auth.public_user(user), temporary_password=temp))


@router.post("/users/{username}/reset-password")
def reset_password(username: str, request: Request):
    ses = _admin(request)
    if username == ses.username:            # would end this session before the one-time password could be shown
        raise HTTPException(409, "use Change password for your own account")
    try:
        user, temp = request.app.state.auth.reset_password(username)
    except KeyError:
        raise HTTPException(404, "unknown user") from None
    _audit(request, ses.username, "reset_password", user.username)
    return _no_store(dict(user=request.app.state.auth.public_user(user), temporary_password=temp))


def _set_active(username: str, request: Request, active: bool):
    ses = _admin(request)
    try:
        user = request.app.state.auth.set_active(ses.username, username, active)
    except KeyError:
        raise HTTPException(404, "unknown user") from None
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    _audit(request, ses.username, "reactivate" if active else "deactivate", user.username)
    return dict(user=request.app.state.auth.public_user(user))


@router.post("/users/{username}/deactivate")
def deactivate(username: str, request: Request):
    return _set_active(username, request, False)


@router.post("/users/{username}/reactivate")
def reactivate(username: str, request: Request):
    return _set_active(username, request, True)
