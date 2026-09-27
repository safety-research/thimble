"""The files the code and the documents name exist: a module the backend, the plugin, the prompts or the documents name
by its bare name (`name.py`) is a file of the tree, and so is every plugin/bin/<file> they name."""
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCANNED = ("backend/app", "plugin", "prompts", "docs", "README.md", "INSTALL.md", "CONTRIBUTING.md", "CLAUDE.md")
SAMPLE = re.compile(r"^plugin/viewers/[\w-]+/sample/")  # the worked examples' invented data, which names its own files
MODULE = re.compile(r"(?<![\w/.-])[a-z_][a-z0-9_]*\.py\b")  # a bare module name, not the end of a longer path
BIN = re.compile(r"\bplugin/bin/[\w.-]*\w")


def tracked(*paths: str) -> list[str]:
    if not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z", "--", *paths], capture_output=True, check=True)
    return [p for p in out.stdout.decode().split("\0") if p]


def texts() -> list[tuple[str, str]]:
    out = []
    for rel in tracked(*SCANNED):
        if SAMPLE.match(rel):
            continue
        data = (ROOT / rel).read_bytes()
        if b"\0" not in data[:8192]:
            out.append((rel, data.decode(errors="replace")))
    return out


def test_every_module_named_by_its_bare_name_is_a_file_of_the_tree():
    names = {Path(p).name for p in tracked()}
    missing = sorted({(m, rel) for rel, text in texts() for m in MODULE.findall(text) if m not in names})
    assert missing == []


def test_every_file_of_the_plugins_bin_that_is_named_exists():
    missing = sorted({(m, rel) for rel, text in texts() for m in BIN.findall(text) if not (ROOT / m).exists()})
    assert missing == []
