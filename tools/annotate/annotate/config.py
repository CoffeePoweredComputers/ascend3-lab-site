"""Where things live. Read through functions so tests can repoint the data dir."""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent

# nginx strips this prefix before proxying, so routes are declared from "/" and
# only the links we render need it.
ROOT_PATH = os.environ.get("TOOL_ROOT_PATH", "").rstrip("/")


def data_dir() -> Path:
    return Path(os.environ.get("ANNOTATE_DATA_DIR", "/data"))


def db_path() -> Path:
    return data_dir() / "annotate.db"


def raw_dir() -> Path:
    return data_dir() / "raw"


def derived_dir() -> Path:
    return data_dir() / "derived"


def backup_dir() -> Path:
    return data_dir() / "backups"


def dev_admin() -> bool:
    """Developer machines only: treat the developer as a site admin."""
    return os.environ.get("ANNOTATE_DEV_ADMIN", "") == "1"


def dev_user() -> str:
    """Set only on a developer's machine. The deploy runner never sets it, so in
    production identity can come from nothing but the gate's headers."""
    return os.environ.get("ANNOTATE_DEV_USER", "").strip().lower()
