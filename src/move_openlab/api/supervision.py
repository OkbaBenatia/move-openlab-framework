"""Student supervision — researchers with *Can supervise students*, enforced on every request.

A supervisor sees and manages only the students whose ``supervisor`` is their own username: create (temporary
password shown once), reset password, deactivate, reactivate. Nothing here reaches another researcher, an
administrator, or any workspace: students work in their own isolated workspace like everyone else. Actions are
recorded in the installation's audit log.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .admin import audit, no_store, user_rows

router = APIRouter(prefix="/api/supervision")


def _supervisor(request: Request):
    ses = request.state.session
    if ses is None or not ses.is_supervisor:
        raise HTTPException(403, "student supervision is not enabled for this account")
    return ses


class CreateStudent(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    display_name: str = Field(min_length=2, max_length=80)


@router.get("/students")
def list_students(request: Request):
    ses = _supervisor(request)
    return dict(students=user_rows(request, request.app.state.auth.store.list(supervisor=ses.username)))


@router.post("/students")
def create_student(body: CreateStudent, request: Request):
    ses = _supervisor(request)
    auth = request.app.state.auth
    try:
        user, temp = auth.create_user(body.username, body.display_name, "student", created_by=ses.username, supervisor=ses.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    audit(request, ses.username, "create_student", user.username)
    return no_store(dict(user=auth.public_user(user), temporary_password=temp))


def _own(request: Request, username: str):
    ses = _supervisor(request)
    try:
        return ses, request.app.state.auth.own_student(ses.username, username)
    except KeyError:
        raise HTTPException(404, "unknown student") from None


@router.post("/students/{username}/reset-password")
def reset_student_password(username: str, request: Request):
    ses, student = _own(request, username)
    user, temp = request.app.state.auth.reset_password(student.username)
    audit(request, ses.username, "reset_student_password", user.username)
    return no_store(dict(user=request.app.state.auth.public_user(user), temporary_password=temp))


def _set_active(username: str, request: Request, active: bool):
    ses, student = _own(request, username)
    try:
        user = request.app.state.auth.set_active(ses.username, student.username, active)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    audit(request, ses.username, "reactivate_student" if active else "deactivate_student", user.username)
    return dict(user=request.app.state.auth.public_user(user))


@router.post("/students/{username}/deactivate")
def deactivate_student(username: str, request: Request):
    return _set_active(username, request, False)


@router.post("/students/{username}/reactivate")
def reactivate_student(username: str, request: Request):
    return _set_active(username, request, True)
