"""Point the databases at a throwaway directory before any app module loads."""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ["GENAI_DATA_DIR"] = tempfile.mkdtemp(prefix="genai-log-tests-")
