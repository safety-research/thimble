"""thimble fix and thimble update on an install from a release's zip (engine/kernel/fixes.py, find_source's zip): the
folder the archive unpacks to has no git, so thimble makes live from thimble's repository, at the release whose files
the folder has, and the folder stays as it is. The world is test_fixes.py's made-up thimble, with a made-up upstream
whose releases 0.10.2 and 0.10.3 name no version in the plugin's manifest, as thimble's releases do; `claude` is a
fake. All data here is made up."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, calls, fake, live_file, sh, world  # noqa: E402, F401  (world is the fixture)

OLD_BAR = "const words = `coverage ${n}`\n"
NEW_BAR = "const words = `read ${n}`\n"


def unzip(bare: Path, tag: str, into: Path) -> Path:
    """The release `tag` as a person has it after they unzip its archive from GitHub: thimble-0.10.2, with no git."""
    folder = into / f"thimble-{tag[1:]}"
    folder.mkdir(parents=True)
    tar = subprocess.run(["git", "archive", "--format=tar", tag], cwd=bare, capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", str(folder)], input=tar, check=True)
    return folder


def install(w, folder: Path) -> Path:
    """scripts/install.sh --local in `folder`, as Claude Code records it: a directory marketplace on the folder, and a
    copy of its plugin with no commit. What the install and a session add in the folder: the browser's packages, the
    release's version in the plugin's manifest, the types Claude Code writes beside the plugin. The copy."""
    (folder / "browser" / "backend" / ".venv").mkdir(parents=True, exist_ok=True)
    (folder / "browser" / "backend" / ".venv" / "made-up-package.txt").write_text("x\n")
    manifest = folder / "plugin" / ".claude-plugin" / "plugin.json"
    d = json.loads(manifest.read_text())
    manifest.write_text(json.dumps({"name": d.pop("name"), "version": folder.name.split("-")[1], **d}, indent=2) + "\n")
    (folder / "plugin" / ".claude-plugin" / "types").mkdir(exist_ok=True)
    (folder / "plugin" / ".claude-plugin" / "types" / "tsconfig.json").write_text("{}\n")
    src = {"source": "directory", "path": str(folder)}
    (w["cc"] / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {
        "source": src, "installLocation": str(folder)}}))
    copy = w["cc"] / "plugins" / "cache" / "thimble" / "thimble" / "unknown"
    shutil.rmtree(copy, ignore_errors=True)
    shutil.copytree(folder / "plugin", copy)
    (w["cc"] / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {"thimble@thimble": [
        {"scope": "user", "installPath": str(copy), "version": "unknown"}]}}))
    s = json.loads((w["cc"] / "settings.json").read_text())
    s["extraKnownMarketplaces"]["thimble"]["source"] = src
    (w["cc"] / "settings.json").write_text(json.dumps(s, indent=2))
    return copy


@pytest.fixture
def zipped(world, tmp_path, monkeypatch):
    """The made-up upstream (THIMBLE_UPDATE_URL) with releases v0.10.2 and v0.10.3 (a day later; its bar says read),
    and v0.10.2's zip unpacked in Downloads and installed from there; thimble runs from that folder, as the shell's
    thimble does."""
    bare = tmp_path / "upstream.git"
    sh("git", "clone", "-q", "--bare", str(world["rel"]), str(bare))
    work = tmp_path / "upstream-work"
    sh("git", "clone", "-q", str(bare), str(work))
    manifest = work / "plugin" / ".claude-plugin" / "plugin.json"
    manifest.write_text(json.dumps({"name": "thimble", "description": "made-up"}, indent=2) + "\n")
    for part, lock, _ in FX.BROWSER_LOCKS:
        (work / "browser" / part).mkdir(parents=True)
        (work / "browser" / part / lock).write_text(f"made-up {lock}\n")
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-q", "-m", "thimble 0.10.2", cwd=work)
    sh("git", "tag", "v0.10.2", cwd=work)
    v2 = sh("git", "rev-parse", "HEAD", cwd=work)
    (work / "plugin" / "bar" / "bar.tsx").write_text(NEW_BAR)
    subprocess.run(["git", "commit", "-q", "-am", "thimble 0.10.3"], cwd=work, check=True, env={
        **os.environ, "GIT_COMMITTER_DATE": f"{int(time.time()) + 86400} +0000"})
    sh("git", "tag", "v0.10.3", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", "v0.10.2", "v0.10.3", cwd=work)
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(bare))
    folder = unzip(bare, "v0.10.2", tmp_path / "Downloads")
    copy = install(world, folder)
    monkeypatch.setattr(FX, "PLUGIN", folder / "plugin")
    return {"bare": bare, "folder": folder, "copy": copy, "v2": v2, "v3": sh("git", "rev-parse", "HEAD", cwd=work)}


def files_of(folder: Path) -> dict[str, bytes]:
    return {str(p.relative_to(folder)): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}


@pytest.mark.parametrize("runs", ["shell", "session", "copy-alone"])
def test_a_request_on_a_zip_install_makes_live_from_thimbles_repository_at_the_release_the_zip_holds(
        world, zipped, monkeypatch, runs):
    folder, v2 = zipped["folder"], zipped["v2"]
    before = files_of(folder)
    if runs != "shell":
        # the session runs the copy Claude Code made of the plugin; with the folder gone, that copy alone says which
        # release it is
        monkeypatch.setattr(FX, "PLUGIN", zipped["copy"])
    if runs == "copy-alone":
        shutil.rmtree(folder)
    r = FX.new("say read, not coverage")
    live = FX.live_dir()
    # live: thimble's repository at 0.10.2, the release the zip holds (not the newest), with the fix's copy cut from it
    assert sh("git", "rev-parse", "mine", cwd=live) == v2 and r["base"] == v2
    assert sh("git", "remote", "get-url", "origin", cwd=live) == str(zipped["bare"])
    rel = FX.release()
    assert (rel["kind"], rel["base"], rel["tag"], rel["pointed"]) == ("zip", v2, "v0.10.2", False)
    assert FX.release_name() == "0.10.2" and Path(r["work"], "plugin", "bar", "bar.tsx").read_text() == OLD_BAR
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == v2
    # nothing the person runs changed: the folder as it was, with no git, and Claude Code's marketplace on it
    if runs != "copy-alone":
        assert files_of(folder) == before and not (folder / ".git").exists()
    assert not any("marketplace add" in c for c in calls(world))


def test_update_on_a_zip_install_moves_it_to_the_newest_release_and_keeps_its_settings(world, zipped, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    folder, v3 = zipped["folder"], zipped["v3"]
    before = files_of(folder)
    assert cli.main(["update"]) == 0
    assert capsys.readouterr().out.splitlines()[0] == "Updated thimble 0.10.2 → 0.10.3 (terminal plugin)"
    live = FX.live_dir()
    assert sh("git", "rev-parse", "mine", cwd=live) == v3 and live_file("plugin/bar/bar.tsx") == NEW_BAR
    assert FX.release()["base"] == v3 and FX.release()["pointed"] is True
    # Claude Code loads thimble from live now, with its other settings as they were
    assert f"plugin marketplace add {live}" in calls(world) and "plugin update thimble@thimble" in calls(world)
    s = json.loads((world["cc"] / "settings.json").read_text())
    assert s["extraKnownMarketplaces"]["thimble"]["source"] == {"source": "directory", "path": str(live)}
    assert s["theme"] == "light"
    assert files_of(folder) == before and not (folder / ".git").exists()
    # then a request works on 0.10.3, and the next update says it is the newest
    assert FX.new("say how many")["base"] == v3
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]


def test_a_zip_of_the_newest_release_is_up_to_date_and_ready_for_a_fix(world, zipped, tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    folder = unzip(zipped["bare"], "v0.10.3", tmp_path / "elsewhere")
    install(world, folder)
    monkeypatch.setattr(FX, "PLUGIN", folder / "plugin")
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    assert FX.release()["base"] == zipped["v3"] and FX.release()["pointed"] is False
    assert FX.new("say how many")["base"] == zipped["v3"]


def test_a_zip_in_a_folder_of_another_repository_is_a_zip_and_that_repository_is_left_alone(world, zipped, tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    sh("git", "init", "-q", "-b", "main", cwd=projects)
    (projects / "notes.md").write_text("made-up notes\n")
    sh("git", "add", "-A", cwd=projects)
    sh("git", "commit", "-q", "-m", "made-up notes", cwd=projects)
    refs = sh("git", "for-each-ref", cwd=projects)
    folder = unzip(zipped["bare"], "v0.10.2", projects)
    install(world, folder)
    monkeypatch.setattr(FX, "PLUGIN", folder / "plugin")
    assert FX.new("say read")["base"] == zipped["v2"] and FX.release()["kind"] == "zip"
    assert sh("git", "for-each-ref", cwd=projects) == refs and "\n" not in sh("git", "worktree", "list", cwd=projects)


def test_a_zip_whose_files_are_no_releases_stops_and_names_the_nearest_release_and_the_files(world, zipped, monkeypatch):
    bar = zipped["folder"] / "plugin" / "bar" / "bar.tsx"
    bar.write_text("const words = `mine ${n}`\n")
    with pytest.raises(FX.FixError, match=r"are not those of a thimble release \(the nearest, 0\.10\.2, differs in "
                                          r"plugin/bar/bar\.tsx\).*Put those files back as 0\.10\.2 has them"):
        FX.new("say read")
    assert not FX.live_dir().exists()
    # with the network down, it says so, and what to do
    bar.write_text(OLD_BAR)
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(zipped["bare"].parent / "no-such.git"))
    with pytest.raises(FX.FixError, match=r"could not read its releases from .*; check the network, then try again$"):
        FX.new("say read")


def from_github(w, zipped, tmp_path, monkeypatch, checkout: Path) -> None:
    """scripts/install.sh with no --local: the plugin from GitHub, where 0.10.3 is the newest (Claude Code's clone, one
    commit deep), and the browser workbench built in `checkout`, which its home names; uv and npm are fakes."""
    cc_clone = w["cc"] / "plugins" / "marketplaces" / "thimble"
    sh("git", "clone", "-q", "--depth", "1", f"file://{zipped['bare']}", str(cc_clone))
    (w["cc"] / "plugins" / "known_marketplaces.json").write_text(json.dumps({"thimble": {
        "source": {"source": "github", "repo": "made-up/thimble"}, "installLocation": str(cc_clone)}}))
    (w["cc"] / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {"thimble@thimble": [
        {"scope": "user", "installPath": str(w["cc"] / "plugins" / "cache" / "x"), "gitCommitSha": zipped["v3"]}]}}))
    monkeypatch.setattr(FX, "PLUGIN", cc_clone / "plugin")
    for part, _, pkgs in FX.BROWSER_LOCKS:
        (checkout / "browser" / part / pkgs).mkdir(parents=True, exist_ok=True)
        (checkout / "browser" / part / pkgs / "made-up-package.txt").write_text("x\n")
    bh = tmp_path / "browser-home"
    bh.mkdir(exist_ok=True)
    (bh / "checkout").write_text(f"{checkout / 'browser'}\n")
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(bh))
    for name in ("uv", "npm"):
        fake(w["bin"] / name, w["tmp"] / "pkg.log")
    monkeypatch.setenv("PATH", f"{w['bin']}:{os.environ['PATH']}")


def test_update_takes_the_browser_of_a_zip_with_the_plugin_from_github_to_the_release(world, zipped, tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    from_github(world, zipped, tmp_path, monkeypatch, zipped["folder"])
    out = FX.update()
    # the plugin from GitHub had 0.10.3 already: the browser alone moved from 0.10.2
    assert out["lines"][0] == "Updated thimble 0.10.2 → 0.10.3 (browser)"
    assert out["lines"][-1] == "Then  Terminal: /reload-plugins in Claude Code · Browser: restart thimble-browser"
    b = FX.live_dir() / "browser"
    assert (FX.home() / "browser-ready").read_text().strip() == str(b)
    assert sh("git", "rev-parse", "mine", cwd=FX.live_dir()) == zipped["v3"]
    # the packages the install built in the zip's folder, linked: the lock files are the same
    assert (b / "backend" / ".venv" / "made-up-package.txt").exists()
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]


def test_update_leaves_a_clones_browser_as_it_is_at_any_release(world, zipped, tmp_path, monkeypatch):
    """A git install with the plugin from GitHub at the newest release: thimble update behaves as before zips updated,
    whichever commit the person's clone, where the browser workbench runs, is at. The clone is theirs to pull."""
    monkeypatch.delenv("CLAUDECODE", raising=False)
    clone = tmp_path / "code" / "thimble"
    sh("git", "clone", "-q", str(zipped["bare"]), str(clone))
    from_github(world, zipped, tmp_path, monkeypatch, clone)
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    # a clone at an older release, not pulled since
    sh("git", "checkout", "-q", "v0.10.2", cwd=clone)
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    # and with a change of its own: the person's work
    (clone / "browser" / "backend" / "uv.lock").write_text("made-up uv.lock, changed\n")
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    assert not FX.live_dir().exists() and not (FX.home() / "browser-ready").exists()


def test_a_check_on_a_zip_install_says_whether_a_newer_release_is_out_and_changes_nothing(world, zipped, tmp_path, monkeypatch,
                                                                                           capsys):
    """thimble update --check on a zip installed with --local: it reads which release the folder holds in a scratch
    repository that goes after, so it makes no live, no release checkout and no record, as on a GitHub install."""
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    before = files_of(zipped["folder"])
    assert cli.main(["update", "--check"]) == 0
    assert capsys.readouterr().out == "thimble 0.10.3 is out (you have 0.10.2): thimble update in a shell\n"
    assert files_of(zipped["folder"]) == before
    assert not FX.home().exists() or not any(FX.home().iterdir())
    newest = unzip(zipped["bare"], "v0.10.3", tmp_path / "elsewhere")
    install(world, newest)
    monkeypatch.setattr(FX, "PLUGIN", newest / "plugin")
    assert cli.main(["update", "--check"]) == 0
    assert capsys.readouterr().out == "thimble 0.10.3 is the newest release.\n"
    assert not FX.home().exists() or not any(FX.home().iterdir())


def test_a_newer_zip_installed_before_the_first_fix_goes_on_moves_the_release(world, zipped, tmp_path, monkeypatch):
    assert FX.new("say read")["base"] == zipped["v2"]
    # 0.10.3's zip, unpacked and installed from another folder, while that fix waits
    folder = unzip(zipped["bare"], "v0.10.3", tmp_path / "Downloads")
    install(world, folder)
    monkeypatch.setattr(FX, "PLUGIN", folder / "plugin")
    r = FX.new("say how many")
    assert r["base"] == zipped["v3"] and FX.release()["base"] == zipped["v3"] and FX.release()["tag"] == "v0.10.3"
    assert Path(r["work"], "plugin", "bar", "bar.tsx").read_text() == NEW_BAR
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == zipped["v3"]
