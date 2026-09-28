"""`thimble update` (app.cli, INSTALL.md "Update"): a release install brings itself up to date. `--from <zip>` hands the
zip to scripts/update.sh; with no argument the latest GitHub release and its SHA256SUMS are downloaded with the gh CLI
and handed over the same way, and a release without SHA256SUMS is not installed. subprocess is faked throughout: nothing
is downloaded or installed here."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cli, config

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture()
def release_install(monkeypatch, tmp_path):
    """The tree is an unzipped release: scripts/update.sh, plugin.json naming an invented repo, no .git, no
    RELEASE.json unless a test writes one."""
    root = tmp_path / "app"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "update.sh").write_text("#!/bin/bash\n")
    (root / "plugin" / ".claude-plugin").mkdir(parents=True)
    (root / "plugin" / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "thimble", "version": "0.9.0", "repository": "https://github.com/example/thimble"}))
    monkeypatch.setattr(config, "REPO_ROOT", root)
    return root


class _Proc:
    def __init__(self, returncode: int, stderr: str = ""):
        self.returncode, self.stderr, self.stdout = returncode, stderr, ""


def _fake_gh(monkeypatch, *, rc: int = 0, stderr: str = "HTTP 502: Bad Gateway", logged_in: bool = True,
             sees_repo: bool = True, sums: bool = True) -> list[list[str]]:
    """gh on PATH; `subprocess.run` records the command and, on success, leaves a zip in the --dir it was given, and
    the release's SHA256SUMS when `sums`. A failing download prints `stderr`; `gh auth status` and `gh repo view` answer
    by `logged_in` and `sees_repo`."""
    calls: list[list[str]] = []
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/gh" if name == "gh" else None)

    def run(cmd, **kw):
        calls.append(list(cmd))
        if cmd[1:3] == ["auth", "status"]:
            return _Proc(0 if logged_in else 1)
        if cmd[1:3] == ["repo", "view"]:
            return _Proc(0 if sees_repo else 1)
        if rc == 0:
            (Path(cmd[cmd.index("--dir") + 1]) / "thimble-0.9.0-abc1234.zip").write_bytes(b"PK")
            if sums:
                (Path(cmd[cmd.index("--dir") + 1]) / "SHA256SUMS").write_text("0" * 64 + "  thimble-0.9.0-abc1234.zip\n")
        return _Proc(rc, stderr if rc else "")

    monkeypatch.setattr(cli.subprocess, "run", run)
    return calls


def _record_update_sh(monkeypatch, rc: int = 0) -> list[list[str]]:
    calls: list[list[str]] = []

    def call(cmd, **kw):
        calls.append(list(cmd))
        return rc

    monkeypatch.setattr(cli.subprocess, "call", call)
    return calls


def test_from_hands_the_zip_to_update_sh_and_returns_its_exit_code(home, release_install, monkeypatch):
    def no_gh(*a, **k):
        raise AssertionError("--from must not download anything")

    monkeypatch.setattr(cli.subprocess, "run", no_gh)
    calls = _record_update_sh(monkeypatch, rc=3)
    assert cli.main(["update", "--from", "/tmp/thimble-0.9.0-abc1234.zip"]) == 3
    assert calls == [["bash", str(release_install / "scripts" / "update.sh"), "--from", "/tmp/thimble-0.9.0-abc1234.zip"]]
    cli.main(["update", "--from", "/tmp/x.zip", "--dry-run"])
    assert calls[-1][-3:] == ["--from", "/tmp/x.zip", "--dry-run"]


def test_no_argument_downloads_with_gh_then_runs_update_sh_from_that_zip(home, release_install, monkeypatch, capsys):
    gh = _fake_gh(monkeypatch)
    calls = _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 0
    assert gh[0][:9] == ["/usr/bin/gh", "release", "download", "--repo", "example/thimble", "--pattern", "thimble-*.zip",
                         "--pattern", "SHA256SUMS"]
    assert gh[0][9] == "--dir"
    assert len(calls) == 1 and calls[0][:3] == ["bash", str(release_install / "scripts" / "update.sh"), "--from"]
    assert calls[0][3].endswith("/thimble-0.9.0-abc1234.zip") and calls[0][3].startswith(gh[0][10])
    assert calls[0][4:] == ["--sums", f"{gh[0][10]}/SHA256SUMS"], "update.sh checks the zip against the release's digests"
    assert capsys.readouterr().out.strip() == "thimble update: downloaded thimble-0.9.0-abc1234.zip"
    cli.main(["update", "--dry-run"])
    assert calls[-1][-1] == "--dry-run"


def test_a_release_without_sha256sums_is_not_installed(home, release_install, monkeypatch, capsys):
    _fake_gh(monkeypatch, sums=False)
    calls = _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert calls == [] and len(lines) == 2, lines
    assert "has no SHA256SUMS" in lines[0] and "nothing was installed" in lines[0]
    assert "thimble update --from" in lines[1]
