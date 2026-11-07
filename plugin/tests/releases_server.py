"""A stand-in for thimble's releases on GitHub, for tests: THIMBLE_RELEASES_URL names it. It answers on 127.0.0.1, over
plain http, as GitHub answers:

    /releases/latest                  302 to /releases/tag/<the newest release>, a page: no file is read
    /releases/download/<tag>/<file>   302 to /assets/<tag>/<file>, which is the file, as GitHub keeps release files on
                                      another host
    /archive/<ref>.tar.gz             git archive of the branch or tag <ref> of thimble's repository (`bare`), under the
                                      folder GitHub names (thimble-main, thimble-0.10.8), for a ref with no release file
    anything else                     404

It serves the folder `root`: <root>/<tag>/ holds a release's files, <root>/latest names the newest release, and each
request is a line of <root>/requests.log ("GET /releases/latest"), so a test can count what was downloaded.
publish(repo, tag) builds a release's two files with scripts/release-file.sh, the build a release's Action runs, and
makes it the newest; drop(tag) takes them away; spoil(tag) changes its file's bytes while SHA256SUMS stays; refuse(code)
has the page of the latest release answer with that status (503, as when GitHub is down); stop() ends the server, so
that a request finds nothing listening.

Proxy is an HTTP proxy on 127.0.0.1 that passes each request on and logs it, as a person's network may need one.

Run as a script, it does the same from a shell, for a test by hand (python3 releases_server.py --help)."""
from __future__ import annotations

import argparse
import http.client
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
RELEASE_FILE = ROOT / "scripts" / "release-file.sh"


def publish(root: Path, repo: Path, tag: str, latest: bool = True) -> Path:
    """The release `tag` of the repository `repo` (a clone or a bare one): its file and SHA256SUMS in <root>/<tag>/,
    built by scripts/release-file.sh; with `latest`, the newest release from now on. Its folder."""
    out = root / tag
    shutil.rmtree(out, ignore_errors=True)
    subprocess.run(["bash", str(RELEASE_FILE), tag, str(out)], cwd=repo, check=True, capture_output=True, text=True)
    if latest:
        (root / "latest").write_text(tag + "\n")
    return out


def drop(root: Path, tag: str) -> None:
    """The release `tag` has no files any more (GitHub then answers 404 for them)."""
    shutil.rmtree(root / tag, ignore_errors=True)


def spoil(root: Path, tag: str) -> None:
    """The release's file has other bytes, while its SHA256SUMS stays as it was."""
    for f in (root / tag).glob("*.tar.gz"):
        f.write_bytes(f.read_bytes() + b"made-up bytes")


def refuse(root: Path, code: int) -> None:
    """The page of the latest release answers with the status `code` from now on (0: as before)."""
    (root / "latest-status").unlink(missing_ok=True)
    if code:
        (root / "latest-status").write_text(f"{code}\n")


class Handler(BaseHTTPRequestHandler):
    server: "Server"

    def log_message(self, *a) -> None:  # the requests go to requests.log, not to stderr
        pass

    def send(self, code: int, body: bytes = b"", where: str = "") -> None:
        self.send_response(code)
        if where:
            self.send_header("Location", where)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        srv = self.server
        path = self.path.split("?", 1)[0]
        with srv.lock:
            with open(srv.root / "requests.log", "a") as f:
                f.write(f"{self.command} {path}\n")
        here = f"http://127.0.0.1:{srv.server_address[1]}"
        if path == "/releases/latest":
            refused = srv.root / "latest-status"
            if refused.is_file():
                return self.send(int(refused.read_text().strip()))
            latest = srv.root / "latest"
            tag = latest.read_text().strip() if latest.is_file() else ""
            return self.send(302, b"", f"{here}/releases/tag/{tag}") if tag else self.send(404)
        if path.startswith("/releases/tag/"):
            return self.send(200, b"<html><title>a release</title></html>\n")
        m = re.fullmatch(r"/releases/download/([^/]+)/([^/]+)", path)
        if m:
            f = srv.root / m.group(1) / m.group(2)
            return self.send(302, b"", f"{here}/assets/{m.group(1)}/{m.group(2)}") if f.is_file() else self.send(404)
        m = re.fullmatch(r"/assets/([^/]+)/([^/]+)", path)
        if m and (srv.root / m.group(1) / m.group(2)).is_file():
            return self.send(200, (srv.root / m.group(1) / m.group(2)).read_bytes())
        m = re.fullmatch(r"/archive/(.+)\.tar\.gz", path)
        if m and srv.bare and ".." not in m.group(1):
            ref = m.group(1)
            folder = "thimble-" + re.sub(r"^v(?=\d)", "", ref).replace("/", "-")
            p = subprocess.run(["git", "archive", "--format=tar.gz", f"--prefix={folder}/", ref], cwd=srv.bare,
                               capture_output=True, check=False)
            return self.send(200, p.stdout) if p.returncode == 0 else self.send(404)
        self.send(404)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: Path, bare: Path | None, port: int = 0):
        super().__init__(("127.0.0.1", port), Handler)
        self.root, self.bare, self.lock = root, bare, threading.Lock()


class Releases:
    """The stand-in in a thread of the test's own process, on a free port: `url` is THIMBLE_RELEASES_URL."""

    def __init__(self, root: Path, bare: Path | None = None):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.server = Server(root, bare)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.stopped = False

    def publish(self, repo: Path, tag: str, latest: bool = True) -> Path:
        return publish(self.root, repo, tag, latest)

    def drop(self, tag: str) -> None:
        drop(self.root, tag)

    def spoil(self, tag: str) -> None:
        spoil(self.root, tag)

    def refuse(self, code: int) -> None:
        refuse(self.root, code)

    def stop(self) -> None:
        if not self.stopped:
            self.stopped = True
            self.server.shutdown()
            self.server.server_close()

    def requests(self) -> list[str]:
        log = self.root / "requests.log"
        return log.read_text().splitlines() if log.exists() else []

    def files(self) -> list[str]:
        """The release files that were downloaded, in order: each request of /releases/download/<tag>/<file>, not
        SHA256SUMS."""
        return [r.split(" ", 1)[1] for r in self.requests()
                if r.startswith("GET /releases/download/") and not r.endswith("/SHA256SUMS")]


class ProxyHandler(BaseHTTPRequestHandler):
    server: "Proxy"

    def log_message(self, *a) -> None:
        pass

    def do_GET(self) -> None:
        """A request in a proxy's form (GET http://host:port/path) is passed on as it is, with no redirect followed,
        and its answer passed back."""
        self.server.seen.append(f"{self.command} {self.path}")
        u = urlsplit(self.path)
        if u.scheme != "http" or not u.hostname:
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=60)
        c.request("GET", u.path + (f"?{u.query}" if u.query else ""))
        r = c.getresponse()
        body = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() in ("location", "content-type"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Proxy(ThreadingHTTPServer):
    """An HTTP proxy on 127.0.0.1, on a free port, in a thread of the test's own process: `url` is what https_proxy or
    git's http.proxy names, and `seen` each request it passed on."""

    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), ProxyHandler)
        self.seen: list[str] = []
        self.url = f"http://127.0.0.1:{self.server_address[1]}"
        threading.Thread(target=self.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self.shutdown()
        self.server_close()


def main() -> int:
    ap = argparse.ArgumentParser(description="A stand-in for thimble's releases on GitHub, on 127.0.0.1 (see the "
                                 "text at the top of this file). THIMBLE_RELEASES_URL=http://127.0.0.1:PORT names it.")
    ap.add_argument("--root", required=True, type=Path, help="the folder of its release files and its log")
    sub = ap.add_subparsers(dest="what", required=True)
    p = sub.add_parser("serve", help="answer on 127.0.0.1:PORT until stopped")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--bare", type=Path, help="thimble's repository, for GitHub's archives of branches")
    p = sub.add_parser("publish", help="build a release's files from its tag in REPO, and make it the newest")
    p.add_argument("repo", type=Path)
    p.add_argument("tag")
    p.add_argument("--not-latest", action="store_true", help="leave the newest release as it is")
    for name, text in (("drop", "take a release's files away"), ("spoil", "change a release file's bytes")):
        sub.add_parser(name, help=text).add_argument("tag")
    sub.add_parser("refuse", help="have the page of the latest release answer with this status (0: as before)"
                   ).add_argument("code", type=int)
    a = ap.parse_args()
    a.root.mkdir(parents=True, exist_ok=True)
    if a.what == "serve":
        srv = Server(a.root, a.bare, a.port)
        print(f"http://127.0.0.1:{srv.server_address[1]}", flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0
    if a.what == "publish":
        print(publish(a.root, a.repo, a.tag, not a.not_latest))
    elif a.what == "drop":
        drop(a.root, a.tag)
    elif a.what == "refuse":
        refuse(a.root, a.code)
    else:
        spoil(a.root, a.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
