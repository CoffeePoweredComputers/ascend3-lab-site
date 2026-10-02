"""python -m annotate: serve on 0.0.0.0:$PORT, as the lab-tools runner expects."""

import os

import uvicorn

uvicorn.run("annotate.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="warning")
