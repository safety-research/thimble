"""app.notebook's kernels: a cell runs in the workspace's scratch mirror of the corpus, so its writes never reach the
corpus; the kernel's environment holds no credential; a timeout interrupts and the kernel survives; outputs are
bounded; side files stay under the cell's outputs; the ipynb export.

Each test gets a fresh workspace dir (workspaces_tmp) and shuts its kernel down at the end. Kernel startup takes a
second or two, so timeouts are generous.
"""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI

from app import config, notebook

ERR = notebook.ERROR_MIME


@pytest.fixture()
def corpus(workspaces_tmp) -> str:
    """The corpus to run against: the synthetic `mini`, with the test's own workspaces."""
    return "mini"


@pytest.fixture(autouse=True)
async def _kernels_down():
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def app() -> FastAPI:
    # only our router, so these tests do not depend on other owners' modules importing cleanly
    a = FastAPI()
    a.include_router(notebook.router, prefix="/api")
    return a


@pytest.fixture()
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"] if "_stream" in b)


async def test_create_and_run_print(client, corpus, workspaces_tmp):
    r = await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "print(1+1)"})
    assert r.status_code == 200
    cell = r.json()
    assert len(cell["id"]) == 8 and cell["status"] == "idle" and cell["exec_count"] is None
    assert cell["created_by"] == "user" and cell["outputs"] == []

    r = await client.post(f"/api/ws/{corpus}/notebooks/main/cells/{cell['id']}/run")
    assert r.status_code == 200
    ran = r.json()
    assert ran["id"] == cell["id"]
    assert ran["status"] == "ok"
    assert ran["exec_count"] == 1
    assert ran["outputs"] == [{"text/plain": "2\n", "_stream": "stdout"}]

    # persisted as plain json in the workspace dir (notebooks/<id>.json)
    on_disk = json.loads((workspaces_tmp / corpus / "notebooks" / "main.json").read_text())
    assert on_disk["cells"][0]["outputs"] == ran["outputs"] and on_disk["id"] == "main"
    assert ran["notebook"] == "main" and cell["notebook"] == "main"
    assert (await client.get(f"/api/ws/{corpus}/notebooks/main")).json() == on_disk


async def test_kernel_cwd_is_the_scratch_mirror_and_writes_never_reach_the_corpus(corpus):
    """The kernel starts in workspaces/<c>/scratch, a symlink mirror of the corpus, so relative
    reads work while every file a cell creates lands in scratch — never in the corpus directory."""
    corpus_dir = config.corpus_dir(corpus)
    scratch = config.workspace_dir(corpus) / notebook.SCRATCH_DIR
    cell = await notebook.run_code(corpus, "import os, glob\n"
                                           "print(os.getcwd()); print(os.path.exists('manifest.json'))\n"
                                           "print(os.path.realpath('manifest.json'))\n"
                                           "print(len(glob.glob('agents/*')) > 0, os.path.isdir('agents'))\n"
                                           "import sqlite3; sqlite3.connect('made-by-a-cell.db').close()\n"
                                           "open('notes.txt', 'w').write('x')", "user")
    assert cell["status"] == "ok", cell["outputs"]
    lines = _text(cell).splitlines()
    assert lines[0] == str(scratch) and lines[1] == "True"
    assert lines[2] == str((corpus_dir / "manifest.json").resolve())  # read through the link
    assert lines[3] == "True True"  # directories are real (walk/glob descend), files are links
    assert (scratch / "made-by-a-cell.db").is_file() and (scratch / "notes.txt").is_file()
    assert not (corpus_dir / "made-by-a-cell.db").exists() and not (corpus_dir / "notes.txt").exists()
    # the mirror is rebuilt on the next kernel start and leaves what the cell made alone
    await notebook.shutdown_all()
    cell = await notebook.run_code(corpus, "import os; print(os.path.exists('notes.txt'), os.path.islink('manifest.json'))", "user")
    assert _text(cell).strip() == "True True"


def test_kernel_env_drops_secrets(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-FAKE")
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_x")
    monkeypatch.setenv("CI_ACCESS_TOKEN", "ci_x")
    monkeypatch.setenv("SOME_SERVICE_TOKEN", "t")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-FAKE")  # the CLI's long-lived token: CLAUDE_* and TOKEN both catch it
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/cfg")
    monkeypatch.setenv("HARMLESS", "1")
    env = notebook.kernel_env()
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID", "CI_ACCESS_TOKEN", "SOME_SERVICE_TOKEN",
              "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"):
        assert k not in env
    assert env["HARMLESS"] == "1" and "PATH" in env


def _small_caps(monkeypatch, max_lines: int = 100, head: int = 50, tail: int = 20) -> None:
    monkeypatch.setattr(notebook, "OUTPUT_MAX_LINES", max_lines)
    monkeypatch.setattr(notebook, "OUTPUT_HEAD_LINES", head)
    monkeypatch.setattr(notebook, "OUTPUT_TAIL_LINES", tail)


# ----------------------------------------------------------------------------- .ipynb export


def _export_nb(c: str) -> dict:
    ws = config.workspace_dir(c)
    nb = notebook.create_notebook(ws, "Finding 1: the count", role="analyst", kind="split")
    note = notebook.new_cell("note", "chat:c1", "", nb["id"], payload={"text": "How many? The count matters."})
    code1 = notebook.new_cell("table", "chat:c1", "How many things?", nb["id"], code="print(7)")
    code1.update(status="ok", exec_count=1, takeaway="Seven.",
                 outputs=[{"text/plain": "7\n", "_stream": "stdout"},
                          {"image/png": "aGk=", "text/plain": "<Figure size 640x480 with 1 Axes>"}])
    code2 = notebook.new_cell("code", "chat:c1", "What breaks?", nb["id"], code="1/0")
    code2.update(status="error", exec_count=2,
                 outputs=[{notebook.ERROR_MIME: {"ename": "ZeroDivisionError", "evalue": "division by zero",
                                                 "traceback": ["tb line"]}}])
    example = notebook.new_cell("example", "chat:c1", "One record", nb["id"], payload={"refs": ["events.jsonl#L1"]})
    custom = notebook.new_cell("custom", "chat:c1", "", nb["id"], payload={"html": "<b>hi</b>"})
    timeline = notebook.new_cell("timeline", "chat:c1", "When?", nb["id"], payload={"dataset": {"events": [1]}})
    nb["cells"] = [note, code1, code2, example, custom, timeline]
    notebook.write_notebook(ws, nb)
    return nb
