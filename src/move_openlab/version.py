"""Platform identity (single source for the backend; mirrored by frontend/src/brand.ts)."""
from __future__ import annotations

from . import __version__

APP_NAME = "MOVE OpenLab"
APP_SUBTITLE = "A Reproducible Experimentation Framework for Optimization Research"
DEVELOPER = "Dr. Okba BEN ATIA"


def app_version() -> str:
    return __version__


def display_version() -> str:
    """What the interface shows: the version once 1.0.0 is reached, "Development build" before (internal 0.x
    numbers are not product versions)."""
    return __version__ if int(__version__.split(".")[0]) >= 1 else "Development build"
