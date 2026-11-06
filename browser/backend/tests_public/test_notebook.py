"""app.notebook's kernels: a card's code runs in the workspace's scratch mirror of the corpus, one link per entry of the
corpus folder, so it reads the corpus by its relative paths while its writes never reach the corpus, and the kernel's
environment holds no credential. Each test gets a fresh workspace dir (workspaces_tmp) and shuts its kernel down at
the end."""
from __future__ import annotations

import pytest

from app import config, notebook

CORPUS = "mini"
SECRETS = {"ANTHROPIC_API_KEY": "sk-ant-FAKE", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-FAKE",
           "SOME_SERVICE_TOKEN": "t", "CLAUDE_CONFIG_DIR": "/tmp/cfg"}


@pytest.fixture(autouse=True)
async def _kernels_down():
    yield
    await notebook.shutdown_all()


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"] if "_stream" in b)


async def test_a_card_runs_in_a_mirror_of_the_corpus_writes_none_of_it_and_sees_no_credential(workspaces_tmp,
                                                                                            monkeypatch):
    for k, v in SECRETS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HARMLESS", "1")
    corpus_dir = config.corpus_dir(CORPUS)
    scratch = config.workspace_dir(CORPUS) / notebook.SCRATCH_DIR
    cell = await notebook.run_code(CORPUS, "import os, glob\n"
                                           "print(os.getcwd()); print(os.path.exists('manifest.json'))\n"
                                           "print(os.path.realpath('manifest.json'))\n"
                                           "print(len(glob.glob('agents/*')) > 0, os.path.isdir('agents'))\n"
                                           "import sqlite3; sqlite3.connect('made-by-a-cell.db').close()\n"
                                           "open('notes.txt', 'w').write('x')\n"
                                           f"print(sorted(k for k in {sorted(SECRETS)!r} if k in os.environ), "
                                           "os.environ.get('HARMLESS'))", "user")
    assert cell["status"] == "ok", cell["outputs"]
    lines = _text(cell).splitlines()
    assert lines[0] == str(scratch) and lines[1] == "True"
    assert lines[2] == str((corpus_dir / "manifest.json").resolve())  # read through the link
    assert lines[3] == "True True"  # a folder is one link, which glob reads through
    assert lines[4] == "[] 1", "the kernel's environment holds no credential"
    assert (scratch / "made-by-a-cell.db").is_file() and (scratch / "notes.txt").is_file()
    assert not (corpus_dir / "made-by-a-cell.db").exists() and not (corpus_dir / "notes.txt").exists()
