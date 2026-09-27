"""`thimble update` (app.cli, INSTALL.md "Update"): a release install brings itself up to date. `--from <zip>` hands
the zip to scripts/update.sh; with no argument the latest GitHub release is downloaded with the gh CLI (members are
logged in) and handed over the same way; when the download fails, two lines name the cause and the --from form. gh
answers "release not found" when no release is published, when the account cannot see the repo and when it is not logged
in, so the update asks gh which of the three it is. A git checkout runs update.sh plain (its git pull path). The repo
slug is RELEASE.json's `repo` when the install carries one, else the `repository` of plugin.json. subprocess is faked
throughout: nothing is downloaded or installed here."""
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


def test_the_parser_takes_update_with_from_and_dry_run():
    ap = cli.build_parser()
    args = ap.parse_args(["update"])
    assert args.fn is cli.cmd_update and args.from_ is None and args.dry_run is False
    args = ap.parse_args(["update", "--from", "/x.zip", "--dry-run"])
    assert (args.from_, args.dry_run) == ("/x.zip", True)
    assert "update" in ap.format_help()


def test_from_hands_the_zip_to_update_sh_and_returns_its_exit_code(home, release_install, monkeypatch):
    def no_gh(*a, **k):
        raise AssertionError("--from must not download anything")

    monkeypatch.setattr(cli.subprocess, "run", no_gh)
    calls = _record_update_sh(monkeypatch, rc=3)
    assert cli.main(["update", "--from", "/tmp/thimble-0.9.0-abc1234.zip"]) == 3
    assert calls == [["bash", str(release_install / "scripts" / "update.sh"), "--from", "/tmp/thimble-0.9.0-abc1234.zip"]]
    cli.main(["update", "--from", "/tmp/x.zip", "--dry-run"])
    assert calls[-1][-3:] == ["--from", "/tmp/x.zip", "--dry-run"]


def test_without_gh_two_lines_name_the_releases_page_and_the_from_form(home, release_install, monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    calls = _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 2 and calls == [], lines
    assert lines[0].startswith("thimble update: could not download") and "example/thimble" in lines[0]
    assert "not installed" in lines[0] and "gh auth login" not in lines[0]
    assert "https://github.com/example/thimble/releases/latest" in lines[1] and "thimble update --from" in lines[1]


def test_a_failing_gh_names_its_error_and_logs_it(home, release_install, monkeypatch, capsys):
    gh = _fake_gh(monkeypatch, rc=1, stderr="HTTP 502: Bad Gateway\nretry later")
    calls = _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 2 and calls == [] and len(gh) == 1, gh
    assert "(HTTP 502: Bad Gateway)" in lines[0] and "not installed" not in lines[0]
    assert lines[1] == cli.UPDATE_FROM_LINE.format(url="https://github.com/example/thimble/releases/latest")
    assert "retry later" in cli.log_path().read_text(), "gh's whole stderr goes to the log"


def test_release_not_found_with_no_release_published_says_so_and_offers_from(home, release_install, monkeypatch, capsys):
    gh = _fake_gh(monkeypatch, rc=1, stderr="release not found")
    calls = _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert [c[1:3] for c in gh] == [["release", "download"], ["auth", "status"], ["repo", "view"]]
    assert calls == [] and len(lines) == 2, lines
    assert lines[0] == "thimble update: example/thimble has no published release yet (gh: release not found)."
    assert "thimble update --from <path to thimble-*.zip>" in lines[1]
    assert not any("gh is missing" in ln or "not installed" in ln or "gh auth login" in ln for ln in lines)


def test_release_not_found_while_logged_out_asks_for_gh_auth_login(home, release_install, monkeypatch, capsys):
    gh = _fake_gh(monkeypatch, rc=1, stderr="release not found", logged_in=False)
    _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert [c[1:3] for c in gh] == [["release", "download"], ["auth", "status"]], "no repo check once gh is logged out"
    assert gh[1][3:] == ["--hostname", "github.com"], "only the repo's host, not every host gh knows"
    assert "gh is not logged in" in lines[0] and "`gh auth login`" in lines[0]
    assert "thimble update --from" in lines[1]


def test_release_not_found_for_a_repo_the_account_cannot_see_names_access(home, release_install, monkeypatch, capsys):
    _fake_gh(monkeypatch, rc=1, stderr="release not found", sees_repo=False)
    _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert "cannot see example/thimble" in lines[0] and "no published release" not in lines[0]
    assert "thimble update --from" in lines[1]


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


def test_the_repo_slug_comes_from_release_json_when_present(home, release_install, monkeypatch, capsys):
    assert cli.release_repo() == "example/thimble", "plugin.json's repository, with no RELEASE.json"
    (release_install / "RELEASE.json").write_text(json.dumps({"version": "0.9.0", "commit": "abc1234", "repo": "acme/thimble"}))
    assert cli.release_repo() == "acme/thimble"
    assert cli.releases_url() == "https://github.com/acme/thimble/releases/latest"
    gh = _fake_gh(monkeypatch)
    _record_update_sh(monkeypatch)
    cli.main(["update"])
    assert gh[0][3:5] == ["--repo", "acme/thimble"]
    (release_install / "RELEASE.json").write_text("not json")
    assert cli.release_repo() == "example/thimble", "a broken RELEASE.json falls back to plugin.json"


def test_the_checkout_names_its_repo_once_in_plugin_json():
    """plugin.json's `repository` is the one place the repo is named: the update, the problem report and release.sh
    read the slug from it."""
    url = json.loads((REPO / "plugin" / ".claude-plugin" / "plugin.json").read_text())["repository"]
    assert url.startswith("https://github.com/") and url.count("/") == 4 and not url.endswith((".git", "/")), url


def test_a_checkout_runs_update_sh_plain_without_a_download(home, release_install, monkeypatch, capsys):
    (release_install / ".git").mkdir()
    gh = _fake_gh(monkeypatch)
    calls = _record_update_sh(monkeypatch)
    assert cli.main(["update"]) == 0
    assert gh == [] and calls == [["bash", str(release_install / "scripts" / "update.sh")]]
    assert capsys.readouterr().out == ""


def test_the_dispatcher_and_the_alias_know_update():
    thimble = (REPO / "plugin" / "bin" / "thimble").read_text()
    line = next(ln for ln in thimble.splitlines() if ln.startswith("SUPERVISOR_COMMANDS="))
    assert " update " in line, line
    assert "update" in (REPO / "plugin" / "bin" / "thimble-server").read_text().split("usage:")[1].splitlines()[0]
