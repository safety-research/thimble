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
                     "plugin/viewers/repository/x/run.jsonl": "{}\n",
                     "mods/thimble-term/viewers/repository/sample/repo.jsonl": "{}\n"})
    got = {h[0]: h[3] for h in hits(cc, tmp_path)}
    assert sorted(got) == ["a/b.db", "big.txt", "data/c/x.txt", "mods/thimble-term/viewers/repository/sample/repo.jsonl",
                           "plugin/viewers/repository/x/run.jsonl", "run.jsonl"], \
        "a worked example's sample files, in their folders, are data on purpose; a copy elsewhere is not"


# under CI, which installs gitleaks, the test runs and fails without it rather than skipping
@pytest.mark.skipif(shutil.which("gitleaks") is None and os.environ.get("CI") != "true", reason="gitleaks is not installed")
def test_a_secret_gitleaks_finds_fails_the_command(tmp_path):
    # a GitHub token made at run time, so the tree itself holds none
    token = "ghp_" + "".join(random.choices(string.ascii_letters + string.digits, k=36))
    write(tmp_path, {"deploy.py": f"TOKEN = '{token}'\n"})
    r = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 1 and "deploy.py:1: [secret]" in r.stdout, r.stdout
