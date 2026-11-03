"""The workbench's bash scripts as a person's machine runs them: the launcher's session start and its uninstall
(plugin/bin/thimble), the swap of a new page build (scripts/rebuild_ui.sh) and the dev agent's stack
(scripts/dev/dev_stack.sh). They run under `bash`, or under the bash THIMBLE_TEST_BASH names, such as the bash 3.2
that macOS has, which stops on the expansion of an empty array under set -u. `claude` and the launcher's Python are
fakes; all data is made up."""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
from pathlib import Path

TREE = Path(__file__).resolve().parents[2]
BASH = os.environ.get("THIMBLE_TEST_BASH") or "bash"

# `claude`: its arguments, one per line, and the THIMBLE_MODE it got, in the files FAKE_CLAUDE names
CLAUDE = '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$FAKE_CLAUDE"\nprintf \'%s\\n\' "${THIMBLE_MODE:-}" > "$FAKE_CLAUDE.mode"\n'
# the launcher's Python: `-m app.cli launch-args …` prints the lines FAKE_LAUNCH holds; any other call reads its stdin
PYTHON = '#!/bin/sh\nif [ "$1" = -m ]; then cat "$FAKE_LAUNCH"; else cat >/dev/null; fi\n'


def _stub(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)
    return path


def _launcher(tmp: Path) -> Path:
    """plugin/bin/thimble in a made-up tree, with thimble-app-dir and a fake thimble-python beside it."""
    tree = tmp / "tree"
    (tree / "backend").mkdir(parents=True)
    bin_ = tree / "plugin" / "bin"
    bin_.mkdir(parents=True)
    shutil.copy(TREE / "plugin" / "bin" / "thimble", bin_ / "thimble")
    _stub(bin_ / "thimble-app-dir", f'#!/bin/sh\necho "{tree}"\n')
    _stub(bin_ / "thimble-python", PYTHON)
    _stub(tmp / "fakes" / "claude", CLAUDE)
    return bin_ / "thimble"


def _env(tmp: Path, **more: str) -> dict[str, str]:
    home = tmp / "home"
    home.mkdir(exist_ok=True)
    return {"PATH": f"{tmp / 'fakes'}:/usr/bin:/bin", "HOME": str(home), "THIMBLE_HOME": str(home / ".thimble"),
            "TMPDIR": str(tmp), "LANG": "C.UTF-8", "FAKE_CLAUDE": str(tmp / "claude.args"),
            "FAKE_LAUNCH": str(tmp / "launch.txt"), **more}


def _start(tmp: Path, lines: list[str], *flags: str) -> tuple[subprocess.CompletedProcess[str], list[str], str]:
    """`thimble FLAGS…` in a folder of data, launch-args answering `lines`: what ran, the arguments claude got, and the
    THIMBLE_MODE claude saw."""
    launcher = _launcher(tmp)
    (tmp / "launch.txt").write_text("\n".join(lines))
    work = tmp / "work"
    work.mkdir(exist_ok=True)
    p = subprocess.run([BASH, str(launcher), *flags], capture_output=True, text=True, cwd=work, env=_env(tmp),
                       timeout=60, check=False)
    args = (tmp / "claude.args").read_text().splitlines() if (tmp / "claude.args").exists() else []
    mode = (tmp / "claude.args.mode").read_text().strip() if (tmp / "claude.args.mode").exists() else ""
    return p, args, mode


def test_the_launcher_starts_claude_with_what_launch_args_says_when_its_lines_hold_nothing(tmp_path):
    # no plugin folder, no flags, and a notes line of a tab alone, which reads as no fields: claude starts with the
    # settings, effort, name, session and prompt alone
    p, args, _ = _start(tmp_path, ["", "high", '{"statusLine": {}}', "", "thimble:main · work",
                                   "11111111-2222-3333-4444-555555555555", "CLAUDE_CODE_DISABLE_AGENT_VIEW=1", "", "\t",
                                   "", "main's made-up prompt"])
    assert p.returncode == 0, p.stderr
    assert args == ["--settings", '{"statusLine": {}}', "--effort", "high", "--name", "thimble:main · work",
                    "--session-id", "11111111-2222-3333-4444-555555555555", "--append-system-prompt",
                    "main's made-up prompt", "--", "/thimble"]
    assert "Resume with thimble --continue instead" in p.stderr


def test_the_launcher_passes_on_every_line_of_launch_args_and_the_analyst_s_own_flags(tmp_path):
    p, args, mode = _start(tmp_path, ["/made-up/plugin", "", "{}", "", "thimble:main · work", "", "", "",
                                      "a made-up note\tanother made-up note", "/made-up/launch.json",
                                      "made-up-last-session", "the prompt"], "-c", "--model", "opus")
    assert p.returncode == 0, p.stderr
    assert args == ["--plugin-dir", "/made-up/plugin", "--settings", "{}", "--name", "thimble:main · work",
                    "--resume", "made-up-last-session", "--append-system-prompt", "the prompt", "--model", "opus",
                    "--", "/thimble"]
    assert "a made-up note\nanother made-up note\n" in p.stderr
    assert "continuing the last thimble session in this folder" in p.stderr


def test_uninstall_takes_back_the_line_install_sh_added_and_runs_with_nothing_recorded_too(tmp_path):
    launcher = _launcher(tmp_path)
    env = _env(tmp_path)
    home = Path(env["HOME"])
    (home / ".thimble" / "data").mkdir(parents=True)
    added = 'export PATH="$HOME/.local/bin:$PATH"  # added by thimble\'s installer'
    profile = home / ".zshrc"
    profile.write_text(f"export A=1\n{added}\n")
    (home / ".thimble" / "shell-startup").write_text(f"added\t{profile}\t{added}\n")
    for _ in range(2):  # the second time, nothing is recorded: no line to take back
        p = subprocess.run([BASH, str(launcher), "uninstall", "--yes", "--keep-home"], capture_output=True, text=True,
                           cwd=home, env=env, timeout=60, check=False)
        assert p.returncode == 0, p.stdout + p.stderr
        assert "thimble uninstall: done" in p.stdout
        assert profile.read_text() == "export A=1\n"
        assert not (home / ".thimble" / "shell-startup").exists() and (home / ".thimble" / "data").is_dir()


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
        "data_dir": str(tmp_path / "data"), "workspaces_dir": str(tmp_path / "ws"), "plugin_dir": str(tmp_path / "pl")}}))
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
