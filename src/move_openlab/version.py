"""Platform identity (single source for the backend; mirrored by frontend/src/brand.ts)."""
from __future__ import annotations

from . import __version__

APP_NAME = "MOVE OpenLab"
APP_SUBTITLE = "A Reproducible Experimentation Framework for Optimization Research"
DEVELOPER = "Dr. Okba BEN ATIA"


def app_version() -> str:
    return __version__
