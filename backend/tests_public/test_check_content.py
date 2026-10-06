"""scripts/check_content.py, the content step of scripts/check.sh: files of kinds that never belong in the tree are
refused, gitleaks' findings are reported, and the command fails on a hit."""
import importlib.util
import os
import random
import shutil
import string
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_content.py"


@pytest.fixture()
def cc():
    spec = importlib.util.spec_from_file_location("check_content", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write(root: Path, files: dict[str, str | bytes]) -> Path:
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(text if isinstance(text, bytes) else text.encode())
    return root


def hits(cc, root: Path) -> list[tuple[str, int, str, str]]:
    return cc.scan(root, cc.files_of(root))


def test_files_of_kinds_that_never_belong_are_refused(cc, tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "MAX_BYTES", 100)
    write(tmp_path, {"data/c/x.txt": "", "a/b.db": b"\0", "run.jsonl": "{}\n", "big.txt": "x" * 101, "ok.txt": "ok\n",
                     "plugin/viewers/repository/sample/repo.jsonl": "{}\n", "plugin/viewers/repository/sample/x/run.jsonl": "{}\n",
                     "plugin/viewers/repository/x/run.jsonl": "{}\n"})
    assert sorted(h[0] for h in hits(cc, tmp_path)) == ["a/b.db", "big.txt", "data/c/x.txt",
                                                        "plugin/viewers/repository/x/run.jsonl", "run.jsonl"], \
        "a worked example's sample files, in their folders, are data on purpose"


def test_the_command_fails_on_a_hit_and_passes_a_clean_tree(tmp_path):
    clean = write(tmp_path / "clean", {"a.py": "print('ok')\n"})
    dirty = write(tmp_path / "dirty", {"a.db": b"\0"})
    run = [sys.executable, str(SCRIPT), "--no-gitleaks"]
    assert subprocess.run([*run, str(clean)], capture_output=True).returncode == 0
    r = subprocess.run([*run, str(dirty)], capture_output=True, text=True)
    assert r.returncode == 1 and "a.db:0: [path]" in r.stdout


# under CI, which installs gitleaks, the test runs and fails without it rather than skipping
@pytest.mark.skipif(shutil.which("gitleaks") is None and os.environ.get("CI") != "true", reason="gitleaks is not installed")
def test_a_secret_gitleaks_finds_fails_the_command(tmp_path):
    # a GitHub token made at run time, so the tree itself holds none
    token = "ghp_" + "".join(random.choices(string.ascii_letters + string.digits, k=36))
    write(tmp_path, {"deploy.py": f"TOKEN = '{token}'\n"})
    r = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 1 and "deploy.py:1: [secret]" in r.stdout, r.stdout



def precache(root: Path, name: str = "toy", **extra) -> dict[str, str]:
    """A pre-cache folder as `thimble demo --export` writes one: its manifest lists each file it keeps."""
    import json  # noqa: PLC0415

    manifest = {"schema": "thimble-demo-precache", "version": 3,
                "files": [{"path": "labels/l.jsonl"}, {"path": "orient/run.json"}, {"path": "chats/o1.jsonl"}],
                "flagged": ["workspace/orient/run.json: /home/kept"], **extra}
    return {f"demos/{name}/thimble-demo-precache.json": json.dumps(manifest), f"demos/{name}/README.md": "> Notice\n",
            f"demos/{name}/workspace/labels/l.jsonl": '{"x": "' + "a" * 200 + '"}\n',
            f"demos/{name}/workspace/orient/run.json": '{"p": "/home/kept"}',
            f"demos/{name}/workspace/chats/o1.jsonl": ""}


def test_a_precache_folder_is_allowed_on_the_terms_of_its_exception_only(cc, tmp_path, monkeypatch):
    import json  # noqa: PLC0415

    monkeypatch.setattr(cc, "MAX_BYTES", 100)
    monkeypatch.setattr(cc.getpass, "getuser", lambda: "maintainer")
    write(tmp_path, precache(tmp_path))
    # .jsonl files, one over MAX_BYTES, and a path the manifest's `flagged` kept: allowed
    assert hits(cc, tmp_path) == [] and cc.demo_hits(tmp_path, cc.files_of(tmp_path)) == []
    listed = precache(tmp_path)
    man = json.loads(listed["demos/toy/thimble-demo-precache.json"])
    man["files"] += [{"path": "orient/work/rows.json"}, {"path": "extension/views/v/cache/index.json"}]
    write(tmp_path, {"demos/toy/thimble-demo-precache.json": json.dumps(man),
                     "demos/toy/workspace/extra.json": "{}",
                     "demos/toy/workspace/orient/run.json": '{"p": "/home/kept", "by": "maintainer", "q": "/mnt/d/x"}',
                     "demos/toy/workspace/orient/work/rows.json": "[]",
                     "demos/toy/workspace/extension/views/v/cache/index.json": "{}",
                     "demos/toy/transcripts/orient.jsonl": '{"type":"user"}\n',
                     "demos/toy/workspace/labels/l.db": b"\0",
                     "demos/other/workspace/a.jsonl": "{}\n",
                     "demos/old/thimble-demo-precache.json": json.dumps({"schema": "thimble-demo-precache", "version": 2}),
                     "elsewhere/run.jsonl": "{}\n"})
    rels = cc.files_of(tmp_path)
    got = {(h[0], h[3]) for h in hits(cc, tmp_path) + cc.demo_hits(tmp_path, rels)}
    unlisted = "a file the pre-cache's thimble-demo-precache.json does not list"
    not_output = "not one of the orientation's outputs the export writes"
    assert got == {
        ("demos/toy/workspace/extra.json", unlisted),
        ("demos/toy/workspace/orient/run.json", "the export's scrub check: the user name 'maintainer'"),
        ("demos/toy/workspace/orient/run.json", "the export's scrub check: /mnt/d"),
        ("demos/toy/workspace/orient/work/rows.json", not_output),
        ("demos/toy/workspace/extension/views/v/cache/index.json", not_output),
        ("demos/toy/transcripts/orient.jsonl", unlisted),
        ("demos/toy/workspace/labels/l.db", "a file of a kind that never belongs in the tree"),
        ("demos/toy/workspace/labels/l.db", unlisted),
        ("demos/other/workspace/a.jsonl", "demos/other has no thimble-demo-precache.json of the export"),
        ("demos/old/thimble-demo-precache.json",
         "demos/old is a pre-cache of version 2, not 3 (the outputs alone, with no transcript)"),
        ("elsewhere/run.jsonl", "a file of a kind that never belongs in the tree")}


def test_a_precache_has_size_caps_of_its_own(cc, tmp_path, monkeypatch):
    write(tmp_path, precache(tmp_path))
    monkeypatch.setattr(cc, "DEMO_FILE_MAX", 100)
    monkeypatch.setattr(cc, "DEMO_TOTAL_MAX", 150)
    got = {(h[0], h[3].split(", over")[0]) for h in cc.demo_hits(tmp_path, cc.files_of(tmp_path))}
    assert ("demos/toy/workspace/labels/l.jsonl", "210 bytes") in got
    assert any(a == "demos/toy/" and b.endswith("bytes in all") for a, b in got)
