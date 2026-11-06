"""The workbench's bash scripts as a person's machine runs them: the swap of a new page build (scripts/rebuild_ui.sh)
and the dev agent's stack (scripts/dev/dev_stack.sh). They run under `bash`, or under the bash THIMBLE_TEST_BASH names,
such as the bash 3.2 that macOS has, which stops on the expansion of an empty array under set -u. All data is made
up."""
from __future__ import annotations

import json
import os
import socket
import subprocess
from pathlib import Path

TREE = Path(__file__).resolve().parents[2]
BASH = os.environ.get("THIMBLE_TEST_BASH") or "bash"


def _stub(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)
    return path


def test_rebuild_ui_puts_a_new_build_in_place_and_its_dry_run_changes_nothing(tmp_path):
    front = tmp_path / "frontend"
    dist, new = front / "dist", front / "dist.new"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("the old page")
    (dist / "assets" / "old.js").write_text("a chunk an open page names")
    (dist / "stale.txt").write_text("a file the new build lacks")
    (new / "assets").mkdir(parents=True)
    (new / "index.html").write_text("the new page")
    (new / "assets" / "new.js").write_text("the new chunk")
    script = TREE / "scripts" / "rebuild_ui.sh"
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "LANG": "C.UTF-8"}
    p = subprocess.run([BASH, str(script), "--swap", str(new), str(dist)], capture_output=True, text=True, env=env,
                       timeout=60, check=False)
    assert p.returncode == 0, p.stderr
    assert (dist / "index.html").read_text() == "the new page"
    assert sorted(f.name for f in (dist / "assets").iterdir()) == ["new.js", "old.js"]
    assert not (dist / "stale.txt").exists() and not new.exists()
    assert "1 earlier chunk(s) kept for open pages" in p.stdout
    (front / "package.json").write_text("{}")
    (front / "node_modules").mkdir()
    p = subprocess.run([BASH, str(script), "--frontend", str(front), "--dry-run"], capture_output=True, text=True,
                       env=env, timeout=60, check=False)
    assert p.returncode == 0, p.stderr
    assert "npx vite build --outDir dist.new --emptyOutDir" in p.stdout and not new.exists()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


# the stack's backend: a made-up uvicorn that answers /api/health on the port after --port, for at most 2 minutes
UVICORN = """#!/bin/sh
port=""; prev=""
for a in "$@"; do [ "$prev" = --port ] && port=$a; prev=$a; done
exec python3 -c '
import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")
    def log_message(self, *a):
        pass
s = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H)
s.timeout = 1
end = time.time() + 120
while time.time() < end:
    s.handle_request()
' "$port" uvicorn app.main:app
"""
# Vite: a made-up one that waits, for at most 2 minutes
NPX = '#!/bin/sh\nexec python3 -c "import time; time.sleep(120)" vite "$@"\n'


def test_dev_stack_starts_says_its_status_and_stops_its_servers(tmp_path):
    script = TREE / "scripts" / "dev" / "dev_stack.sh"
    th, wt = tmp_path / "th", tmp_path / "wt"
    _stub(wt / "backend" / ".venv" / "bin" / "python", UVICORN)
    (wt / "frontend" / "node_modules").mkdir(parents=True)
    _stub(tmp_path / "fakes" / "npx", NPX)
    th.mkdir()
    (th / "server.json").write_text(json.dumps({"repo": str(wt), "env": {
        "data_dir": str(tmp_path / "data"), "workspaces_dir": str(tmp_path / "ws")}}))
    env = {"PATH": f"{tmp_path / 'fakes'}:/usr/bin:/bin", "HOME": str(tmp_path), "LANG": "C.UTF-8", "THIMBLE_HOME": str(th),
           "THIMBLE_STACK_PORT": str(_free_port()), "THIMBLE_STACK_UI_PORT": str(_free_port()), "THIMBLE_STACK_WAIT": "30"}

    def stack(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([BASH, str(script), *args], capture_output=True, text=True, env=env, timeout=90, check=False)

    assert stack("stop").stdout.strip() == "dev stack: not running"
    try:
        p = stack("start", "--worktree", str(wt))
        assert p.returncode == 0, p.stdout + p.stderr
        assert json.loads(p.stdout.splitlines()[-1])["healthy"] is True
        assert stack("status").returncode == 0
    finally:
        p = stack("stop")
    assert p.returncode == 0 and "stack backend: pid" in p.stdout and "stack vite: pid" in p.stdout, p.stdout + p.stderr
    p = stack("status")
    assert p.returncode == 1 and json.loads(p.stdout)["healthy"] is False
