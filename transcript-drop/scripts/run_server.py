#!/usr/bin/env python3
"""Start the submission server without depending on the inherited cwd.

Launchers do not always hand a process a working directory it is allowed to
read -- on macOS a subprocess started under a sandbox inherits a cwd inside a
protected folder (Desktop, Documents) and the first os.getcwd() call fails with
EPERM. Setting the cwd explicitly from this file's own location sidesteps that.

    python scripts/run_server.py            # port 8000
    PORT=8011 python scripts/run_server.py
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402  (import after sys.path is set)

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )
