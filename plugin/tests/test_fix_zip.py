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
