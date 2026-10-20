"""`thimble-browser [FOLDER]`: open a folder of files in thimble browser.

Starts the server on 127.0.0.1, prints a sign-in link and opens it in the browser. Press Enter in this window for a
new link (a link works once, for 15 minutes); Ctrl-C stops the server.
"""
from __future__ import annotations

import argparse
import logging
import socket
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn

from . import home, llm, sandbox_note, settings
from .app import build

DEFAULT_PORT = 8420


def free_port(want: int) -> int:
    for port in [want, *range(want + 1, want + 50)]:
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("thimble browser found no free port")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="thimble-browser", description=__doc__.splitlines()[0])
    ap.add_argument("folder", nargs="?", default=".", help="the folder of files to open (default: this folder)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true", help="print the link, do not open a browser")
    ap.add_argument("--no-sandbox", action="store_true",
                    help="run card code without a sandbox where none is found (not recommended)")
    ap.add_argument("--wif", metavar="FILE",
                    help="sign in to Claude with Workload Identity Federation, configured in FILE (saved in Settings)")
    ap.add_argument("--model", help="the model every agent runs on (saved in Settings), such as claude-opus-5-5")
    ap.add_argument("--check-sandbox", action="store_true",
                    help="test the sandbox card code runs in, print one line per check, and exit")
    a = ap.parse_args(argv)
    # the credentials are only the ones Settings names: no ANTHROPIC_* variable of this shell may stand in for them
    llm.scrub_env()
    if a.check_sandbox:
        from . import sandbox_check

        return sandbox_check.main()
    try:
        if a.wif:
            settings.write({"credentials": {"source": "wif", "file": a.wif}})
        if a.model:
            settings.write({"model": a.model})
    except ValueError as e:
        print(f"thimble browser: {e}", file=sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for noisy in ("httpx", "httpx2", "anthropic", "google"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    folder = Path(a.folder).expanduser().resolve()
    try:
        ws = home.open_folder(folder)
    except NotADirectoryError:
        print(f"thimble browser: {folder} is not a folder", file=sys.stderr)
        return 2
    port = free_port(a.port)
    app, auth, sessions = build(port, unsandboxed=a.no_sandbox)
    print(sandbox_note.line(a.no_sandbox))
    s = settings.read()
    print(f"  Claude: {s['model']} at {s['effort']} effort, signed in with {llm.describe()}"
          + ("" if s["credentials"] else " (choose credentials in Settings, or start with --wif FILE)"))

    def link() -> str:
        return f"http://127.0.0.1:{port}/?ws={ws}#p={auth.mint()}"

    first = link()
    print(f"thimble browser: {folder}\n  open {first}\n  (Enter: a new link · Ctrl-C: stop)", flush=True)
    if not a.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(first)).start()

    def on_enter() -> None:
        for _ in sys.stdin:
            print(f"  open {link()}", flush=True)

    if sys.stdin and sys.stdin.isatty():
        threading.Thread(target=on_enter, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
