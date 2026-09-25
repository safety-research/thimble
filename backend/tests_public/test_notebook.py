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


def test_mirror_corpus_is_idempotent_and_conservative(tmp_path):
    corpus = tmp_path / "corpus"
    (corpus / "sub").mkdir(parents=True)
    (corpus / "a.txt").write_text("a")
    (corpus / "sub" / "b.txt").write_text("b")
    scratch = tmp_path / "scratch"
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "a.txt").is_symlink() and (scratch / "sub").is_dir() and not (scratch / "sub").is_symlink()
    assert (scratch / "sub" / "b.txt").read_text() == "b"
    # a kernel-made file under a corpus file's name and a kernel-made file elsewhere are left alone
    (scratch / "sub" / "b.txt").unlink()
    (scratch / "sub" / "b.txt").write_text("mine")
    (scratch / "out.csv").write_text("1,2")
    notebook.mirror_corpus(corpus, scratch)
    assert (scratch / "sub" / "b.txt").read_text() == "mine" and (scratch / "out.csv").read_text() == "1,2"
    # a corpus file that disappears takes its dangling link with it; a new one is linked
    (corpus / "a.txt").unlink()
    (corpus / "c.txt").write_text("c")
    notebook.mirror_corpus(corpus, scratch)
    assert not (scratch / "a.txt").exists() and not (scratch / "a.txt").is_symlink()
    assert (scratch / "c.txt").is_symlink() and (scratch / "c.txt").read_text() == "c"


async def test_error_cell(client, corpus):
    r = await client.post(f"/api/ws/{corpus}/notebooks/main/run", json={"code": "x = 1\n1/0", "created_by": "user"})
    cell = r.json()
    assert cell["status"] == "error"
    assert isinstance(cell["exec_count"], int)
    assert len(cell["outputs"]) == 1
    err = cell["outputs"][0][ERR]
    assert err["ename"] == "ZeroDivisionError"
    assert err["evalue"] == "division by zero"
    assert isinstance(err["traceback"], list) and any("ZeroDivisionError" in line for line in err["traceback"])

    # the kernel is still alive and state survived the error
    cell = await notebook.run_code(corpus, "print(x)", "user")
    assert cell["status"] == "ok" and _text(cell) == "1\n"


async def test_timeout_interrupts_and_kernel_survives(corpus, monkeypatch):
    monkeypatch.setattr(notebook, "EXEC_TIMEOUT", 2.0)
    cell = await notebook.run_code(corpus, "import time\ntime.sleep(60)", "user")
    assert cell["status"] == "error"
    assert cell["outputs"][0][ERR]["ename"] == "TimeoutError"
    monkeypatch.setattr(notebook, "EXEC_TIMEOUT", 120.0)
    cell = await notebook.run_code(corpus, "print('still here')", "user")
    assert cell["status"] == "ok" and _text(cell) == "still here\n"


async def test_restart_gives_fresh_kernel(client, corpus):
    cell = await notebook.run_code(corpus, "y = 42", "user")
    assert cell["status"] == "ok" and cell["exec_count"] == 1
    r = await client.post(f"/api/ws/{corpus}/notebook/restart")
    assert r.json() == {"ok": True}
    cell = await notebook.run_code(corpus, "print(y)", "user")
    assert cell["status"] == "error"
    assert cell["outputs"][0][ERR]["ename"] == "NameError"
    assert cell["exec_count"] == 1  # counts restarted too


async def test_cell_crud(client, corpus):
    a = (await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "a"})).json()
    c = (await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "c"})).json()
    b = (await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "b", "after": a["id"]})).json()
    ids = [x["id"] for x in (await client.get(f"/api/ws/{corpus}/notebooks/main")).json()["cells"]]
    assert ids == [a["id"], b["id"], c["id"]]

    r = await client.put(f"/api/ws/{corpus}/notebooks/main/cells/{b['id']}", json={"code": "b2"})
    assert r.status_code == 200 and r.json()["code"] == "b2"

    r = await client.delete(f"/api/ws/{corpus}/notebooks/main/cells/{a['id']}")
    assert r.json() == {"ok": True}
    ids = [x["id"] for x in (await client.get(f"/api/ws/{corpus}/notebooks/main")).json()["cells"]]
    assert ids == [b["id"], c["id"]]

    assert (await client.delete(f"/api/ws/{corpus}/notebooks/main/cells/nope")).status_code == 404
    assert (await client.put(f"/api/ws/{corpus}/notebooks/main/cells/nope", json={"code": ""})).status_code == 404
    assert (await client.post(f"/api/ws/{corpus}/notebooks/main/cells/nope/run")).status_code == 404
    assert (await client.get("/api/ws/no-such-corpus/notebooks/main")).status_code == 404
    assert (await client.get("/api/ws/../notebooks/main")).status_code in (404, 422)


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


async def test_kernel_does_not_see_api_key_and_keeps_no_history(client, corpus, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-FAKE")
    code = "import os; print('ANTHROPIC_API_KEY' in os.environ, get_ipython().history_manager.enabled)"
    r = await client.post(f"/api/ws/{corpus}/notebooks/main/run", json={"code": code})
    assert r.status_code == 200
    cell = r.json()
    assert cell["status"] == "ok", cell["outputs"]
    assert _text(cell).strip() == "False False"


async def test_notebooks_crud(client, corpus, workspaces_tmp):
    ws = workspaces_tmp / corpus
    assert (await client.get(f"/api/ws/{corpus}/notebooks")).json() == []  # `main` is implicit until first written
    a = (await client.post(f"/api/ws/{corpus}/notebooks", json={})).json()
    assert set(a) == {"id", "title", "n_cells", "ts", "role", "kind", "parent", "anchor", "chat", "investigation", "finding", "pos", "order"}
    assert len(a["id"]) == 8 and a["title"] == "Notebook 1" and a["n_cells"] == 0 and a["role"] == "analyst"
    b = (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Counts"})).json()
    assert b["title"] == "Counts"
    assert [n["id"] for n in (await client.get(f"/api/ws/{corpus}/notebooks")).json()] == [a["id"], b["id"]]
    got = (await client.get(f"/api/ws/{corpus}/notebooks/{a['id']}")).json()
    assert got == {"id": a["id"], "title": "Notebook 1", "ts": a["ts"], "cells": [], "role": "analyst", "kind": "sequence",
                   "parent": None, "anchor": None, "chat": None, "investigation": None, "finding": None, "pos": None,
                   "order": None}
    assert (await client.get(f"/api/ws/{corpus}/notebooks/nope")).status_code == 404
    assert (await client.get(f"/api/ws/{corpus}/notebooks/..%2Fx")).status_code == 404

    # cells carry their notebook id
    ca = (await client.post(f"/api/ws/{corpus}/notebooks/{a['id']}/cells", json={"code": "1", "title": "one"})).json()
    assert ca["notebook"] == a["id"]
    cm = (await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "m"})).json()
    assert cm["notebook"] == "main"
    main = (await client.get(f"/api/ws/{corpus}/notebooks/main")).json()
    assert [c["id"] for c in main["cells"]] == [cm["id"]]
    assert [c["id"] for c in (await client.get(f"/api/ws/{corpus}/notebooks/{a['id']}")).json()["cells"]] == [ca["id"]]
    listed = {n["id"]: n for n in (await client.get(f"/api/ws/{corpus}/notebooks")).json()}
    assert set(listed) == {a["id"], b["id"], "main"} and listed["main"]["n_cells"] == 1 and listed["main"]["title"] == "Your work"
    assert notebook.find_cell(ws, ca["id"])[0] == a["id"] and notebook.find_cell(ws, cm["id"])[0] == "main"
    assert notebook.find_cell(ws, "nope") is None

    # a cell is addressed through its own notebook
    r = await client.put(f"/api/ws/{corpus}/notebooks/{a['id']}/cells/{ca['id']}", json={"title": "still one"})
    assert r.status_code == 200 and r.json()["title"] == "still one" and r.json()["notebook"] == a["id"]
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{b['id']}/cells/{ca['id']}", json={"title": "x"})).status_code == 404
    assert (await client.post(f"/api/ws/{corpus}/notebooks/nope/cells", json={"code": "1"})).status_code == 404
    assert (await client.post(f"/api/ws/{corpus}/notebooks/nope/run", json={"code": "1"})).status_code == 404
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/{b['id']}/cells/{ca['id']}")).status_code == 404
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/{a['id']}/cells/{ca['id']}")).json() == {"ok": True}
    assert (await client.get(f"/api/ws/{corpus}/notebooks/{a['id']}")).json()["cells"] == []

    # rename (PUT {title}); delete clears settings.active_notebook when it pointed there and moves the file to
    # notebooks/trash/, so nothing is lost
    r = await client.put(f"/api/ws/{corpus}/notebooks/{a['id']}", json={"title": "Renamed"})
    assert r.json()["title"] == "Renamed" and (await client.get(f"/api/ws/{corpus}/notebooks/{a['id']}")).json()["title"] == "Renamed"
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{a['id']}", json={"title": "  "})).json()["title"] == "Renamed"
    (ws / "settings.json").write_text(json.dumps({"run_cell_result_lines": 20, "active_notebook": a["id"]}))
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/{a['id']}")).json() == {"ok": True}
    assert (await client.get(f"/api/ws/{corpus}/notebooks/{a['id']}")).status_code == 404
    trashed = json.loads((ws / notebook.TRASH_DIR / f"{a['id']}.json").read_text())
    assert trashed["id"] == a["id"] and trashed["title"] == "Renamed" and not (ws / "notebooks" / f"{a['id']}.json").exists()
    assert notebook.find_cell(ws, ca["id"]) is None  # a trashed notebook's cells are out of the workspace's readers
    assert json.loads((ws / "settings.json").read_text()) == {"run_cell_result_lines": 20, "active_notebook": None}
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/{a['id']}")).status_code == 404
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/nope")).status_code == 404
    assert sorted(n["id"] for n in (await client.get(f"/api/ws/{corpus}/notebooks")).json()) == sorted([b["id"], "main"])
    assert (await client.get("/api/ws/no-such-corpus/notebooks")).status_code == 404


async def test_events_404_for_unknown_notebook(client, corpus):
    """Subscribing to a notebook that does not exist is a 404 like every other /notebooks/{nb}/* route; `main` may be
    subscribed before it is materialized (a client that subscribes first and creates cells later)."""
    r = await client.get(f"/api/ws/{corpus}/notebooks/nope/events")
    assert r.status_code == 404 and "no such notebook" in r.json()["detail"]


def _small_caps(monkeypatch, max_lines: int = 100, head: int = 50, tail: int = 20) -> None:
    monkeypatch.setattr(notebook, "OUTPUT_MAX_LINES", max_lines)
    monkeypatch.setattr(notebook, "OUTPUT_HEAD_LINES", head)
    monkeypatch.setattr(notebook, "OUTPUT_TAIL_LINES", tail)


async def test_oversized_stream_is_bounded_with_marker_and_side_file(client, corpus, workspaces_tmp, monkeypatch):
    _small_caps(monkeypatch)
    n = 1000
    code = f"for i in range({n}): print(f'line {{i}} value {{100000 + i}}')"
    expected = "".join(f"line {i} value {100000 + i}\n" for i in range(n))
    full_cell = await notebook.run_code(corpus, code, "chat:c1", title="q")
    # in-process callers (concepts.py parses the printed stdout; chat.py formats it) get the complete outputs
    assert full_cell["outputs"] == [{"text/plain": expected, "_stream": "stdout"}]
    # the notebook stores head + marker + tail and names the side file
    stored = notebook.get_cell(corpus, full_cell["id"])
    b = stored["outputs"][0]
    assert b["_stream"] == "stdout"
    assert b["truncated"] == {"total_lines": n, "kept_head": 50, "kept_tail": 20,
                              "path": f"notebooks/outputs/{full_cell['id']}-0.txt"}
    lines = b["text/plain"].splitlines()
    assert len(lines) == 71
    assert lines[:50] == expected.splitlines()[:50] and lines[51:] == expected.splitlines()[-20:]
    assert lines[50] == "… 930 lines omitted; full output kept …"
    side = workspaces_tmp / corpus / "notebooks" / "outputs" / f"{full_cell['id']}-0.txt"
    assert side.read_bytes() == expected.encode()  # the side file is the complete text, byte for byte
    # on disk and over GET the same bounded bundle: nothing oversized ships
    on_disk = json.loads((workspaces_tmp / corpus / "notebooks" / "main.json").read_text())
    assert [c for c in on_disk["cells"] if c["id"] == full_cell["id"]][0]["outputs"] == [b]
    got = (await client.get(f"/api/ws/{corpus}/notebooks/main")).json()
    assert [c for c in got["cells"] if c["id"] == full_cell["id"]][0]["outputs"] == [b]
    # the run route returns the stored cell as well
    r = await client.post(f"/api/ws/{corpus}/notebooks/main/run", json={"code": code})
    ran = r.json()["outputs"][0]
    assert ran["truncated"]["total_lines"] == n and len(ran["text/plain"].splitlines()) == 71
    # the full route serves the complete text; a small output falls back to the stored text; a missing output 404s
    r = await client.get(f"/api/ws/{corpus}/notebooks/main/cells/{full_cell['id']}/outputs/0/full")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain") and r.text == expected
    small = await notebook.run_code(corpus, "print('hi')", "user")
    r = await client.get(f"/api/ws/{corpus}/notebooks/main/cells/{small['id']}/outputs/0/full")
    assert r.status_code == 200 and r.text == "hi\n"
    assert (await client.get(f"/api/ws/{corpus}/notebooks/main/cells/{small['id']}/outputs/3/full")).status_code == 404
    # output_full_text / hydrate_outputs / get_cell(full_outputs=True) give the complete text back
    ws = workspaces_tmp / corpus
    assert notebook.output_full_text(ws, stored, 0) == expected
    assert notebook.hydrate_outputs(ws, stored["outputs"]) == [{"text/plain": expected, "_stream": "stdout"}]
    hydrated = notebook.get_cell(corpus, full_cell["id"], full_outputs=True)
    assert hydrated["outputs"] == [{"text/plain": expected, "_stream": "stdout"}] and hydrated["id"] == full_cell["id"]
    # the thread context and the model's add_card result are unchanged in shape (the marker is just a line of text)
    assert notebook.outputs_text(stored["outputs"]).startswith("line 0 value 100000\n")


def test_side_file_path_must_be_a_plain_name_under_outputs(workspaces_tmp):
    ws = workspaces_tmp / "mini"
    assert notebook._side_file(ws, "notebooks/outputs/abcd1234-0.txt") == ws / "notebooks" / "outputs" / "abcd1234-0.txt"
    for bad in ("../secret.txt", "notebooks/outputs/../../x.txt", "notebooks/outputs/a/b-0.txt", "/etc/passwd", None, 3):
        assert notebook._side_file(ws, bad) is None
    cell = {"outputs": [{"text/plain": "kept\n", "_stream": "stdout",
                         "truncated": {"path": "../x.txt", "total_lines": 9, "kept_head": 1, "kept_tail": 0}}]}
    assert notebook.output_full_text(ws, cell, 0) == "kept\n"  # falls back to the stored text
    assert notebook.hydrate_outputs(ws, cell["outputs"]) == cell["outputs"]
    assert notebook.output_full_text(ws, {"outputs": [{"text/html": "<p/>"}]}, 0) is None
    assert notebook.output_full_text(ws, cell, 1) is None


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


async def test_ipynb_export_shape(corpus, client):
    nb = _export_nb(corpus)
    r = await client.get(f"/api/ws/{corpus}/notebooks/{nb['id']}/ipynb")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ipynb+json")
    assert 'filename="Finding-1-the-count.ipynb"' in r.headers["content-disposition"]
    doc = r.json()
    assert doc["nbformat"] == 4 and doc["nbformat_minor"] == 5
    assert doc["metadata"]["thimble"] == {"id": nb["id"], "title": "Finding 1: the count", "role": "analyst", "kind": "split",
                                          "parent": None, "anchor": None, "chat": None}
    types = [c["cell_type"] for c in doc["cells"]]
    # the note; code1's heading, code, takeaway; code2's heading, code; the example's heading and refs; the custom raw
    # cell; the timeline's heading and dataset
    assert types == ["markdown", "markdown", "code", "markdown", "markdown", "code", "markdown", "markdown", "raw", "markdown", "markdown"]
    assert doc["cells"][0]["source"] == "How many? The count matters." and doc["cells"][0]["metadata"] == {"thimble": {"kind": "note"}}
    assert doc["cells"][1]["source"] == "### How many things?"
    code1 = doc["cells"][2]
    assert code1["source"] == "print(7)" and code1["execution_count"] == 1 and code1["metadata"] == {"thimble": {"kind": "table"}}
    assert code1["outputs"][0] == {"output_type": "stream", "name": "stdout", "text": "7\n"}
    assert code1["outputs"][1] == {"output_type": "display_data", "metadata": {},
                                   "data": {"image/png": "aGk=", "text/plain": "<Figure size 640x480 with 1 Axes>"}}
    assert doc["cells"][3] == {"cell_type": "markdown", "id": f"{nb['cells'][1]['id']}-t", "metadata": {}, "source": "Seven."}
    assert doc["cells"][5]["outputs"] == [{"output_type": "error", "ename": "ZeroDivisionError",
                                           "evalue": "division by zero", "traceback": ["tb line"]}]
    assert doc["cells"][7]["source"] == "- [[events.jsonl#L1]]"
    assert doc["cells"][8] == {"cell_type": "raw", "id": nb["cells"][4]["id"], "metadata": {"format": "text/html", "thimble": {"kind": "custom"}},
                               "source": "<b>hi</b>"}
    assert doc["cells"][10]["source"].startswith("```json\n") and '"events"' in doc["cells"][10]["source"]
    ids = [c["id"] for c in doc["cells"]]
    assert len(ids) == len(set(ids))  # every id is unique (nbformat requires it)


async def test_ipynb_404_for_missing_notebook(corpus, client):
    r = await client.get(f"/api/ws/{corpus}/notebooks/nope/ipynb")
    assert r.status_code == 404


