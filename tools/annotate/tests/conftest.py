"""Point the tool at a throwaway data directory before any app module loads."""

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["ANNOTATE_DATA_DIR"] = tempfile.mkdtemp(prefix="annotate-tests-")
os.environ.pop("ANNOTATE_DEV_USER", None)
os.environ["ANNOTATE_JOBS"] = "inline"  # model jobs run in the request's thread, so a test sees the result
os.environ.pop("ANNOTATE_LLM_BASE_URL", None)


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    """A fresh, migrated data directory for one test."""
    monkeypatch.setenv("ANNOTATE_DATA_DIR", str(tmp_path))
    from annotate import db

    db.init()
    return tmp_path


@pytest.fixture()
def seeded(data_dir):
    """The synthetic dataset: 12 diagrams, 24 reflections, a lead and two coders."""
    from annotate import seed

    seed.run()
    return data_dir


@pytest.fixture()
def client(seeded):
    from fastapi.testclient import TestClient

    from annotate.main import app

    return TestClient(app, follow_redirects=False)


def as_user(email: str) -> dict:
    """The headers nginx sets from the gate's answer."""
    return {"X-Tool-User": email, "X-Tool-Uid": "uid-" + email, "X-Tool-Role": "member"}


LEAD = as_user("lead@example.edu")
CODER1 = as_user("coder1@example.edu")
CODER2 = as_user("coder2@example.edu")
OUTSIDER = as_user("outsider@example.edu")
