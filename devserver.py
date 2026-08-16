#!/usr/bin/env python3
"""
Development server for Steward.

Plain `python -m http.server` lets the browser cache app.js and styles.css,
so edits appear not to take effect and you end up chasing ghosts — or moving
to a new port just to get a clean load. This sends no-store on everything,
which keeps the port fixed and every reload honest.

    python3 devserver.py [port]        # defaults to 8766
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
ROOT = Path(__file__).resolve().parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # keep the console to warnings and errors
        if args and str(args[0]).startswith(("GET", "HEAD")) and str(args[1]).startswith("2"):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    handler = partial(NoCacheHandler, directory=str(ROOT))
    # bind loopback explicitly so this never collides with a server bound to
    # another interface on the same port
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    server.allow_reuse_address = True
    print(f"Steward dev server → http://localhost:{PORT}  (no-store, serving {ROOT})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
