"""tools/hello: the reference lab tool.

Listens on $PORT (always 8080 inside the container), keeps a visit counter in
/data to show persistence, prints the prefix it is served under and who is
asking (the X-Tool-* headers nginx sets from the gate's answer). Startup runs
twice per deploy (pre-flight, then for real), so nothing here minds running
again.
"""
import html
import http.server
import os

PORT = int(os.environ.get("PORT", "8080"))
ROOT = os.environ.get("TOOL_ROOT_PATH", "")
COUNTER = "/data/visits.txt"


def bump() -> int:
    n = 0
    try:
        with open(COUNTER) as f:
            n = int(f.read().strip() or 0)
    except (OSError, ValueError):
        pass
    n += 1
    try:
        with open(COUNTER, "w") as f:
            f.write(str(n))
    except OSError:
        pass
    return n


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        n = bump()
        who = self.headers.get("X-Tool-User", "") or "nobody (no gate in front of me)"
        role = self.headers.get("X-Tool-Role", "")
        body = (
            "<!doctype html><meta charset=utf-8><title>Hello</title>"
            "<h1>Hello from tools/hello</h1>"
            f"<p>Served under <code>{html.escape(ROOT) or '/'}</code>. "
            f"Visit #{n}, counted in <code>/data</code>.</p>"
            f"<p>You are <b>{html.escape(who)}</b>"
            + (f" ({html.escape(role)})" if role else "")
            + ", according to the <code>X-Tool-User</code> and <code>X-Tool-Role</code> headers.</p>"
            '<p><a href="/wiki/lab-tools">Back to Lab tools</a></p>'
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep the container log quiet
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
