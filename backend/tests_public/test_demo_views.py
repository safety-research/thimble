"""scripts/dev/demo_views.py, which scripts/sync_demo_views.sh runs: reviewed views go into a demo pre-cache in place of
the orientation's own, each as the server serves it, renamed, and stamped with the digest of the files written, so
install keeps that version and the view shows at once."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from app import demo, views

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "dev" / "demo_views.py"


def _script():
    spec = importlib.util.spec_from_file_location("demo_views", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _check_content():
    spec = importlib.util.spec_from_file_location("check_content", ROOT / "scripts" / "check_content.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


def precache(tmp_path: Path) -> tuple[Path, Path]:
    """A pre-cache exported from a workspace with two views of its own and their proposals: (its folder, the corpus)."""
    corpus = tmp_path / "corpus"
    write(corpus, {"a.jsonl": '{"x": 1}\n'})
    ws = tmp_path / "home" / "workspaces" / "toy"
    write(ws, {
        "orient/run.json": json.dumps({"status": "done", "chats": {"orient": "o1"}, "passes": ["views"]}),
        "chats/o1.meta.json": json.dumps({"id": "o1", "role": "orient", "status": "done"}),
        "chats/o1.jsonl": "",
        "notebooks/g1.json": json.dumps({"id": "g1", "cells": [{"id": "c1", "kind": "table", "title": "How many?"}]}),
        "extension/extension.json": json.dumps({"name": "toy"}),
        "extension/views/board/view.json": json.dumps({"name": "Board", "built": "x", "version": "000000000000"}),
        "extension/views/board/view.html": "<p>the orientation's board</p>",
        "extension/views/replay/view.json": json.dumps({"name": "Replay", "built": "x"}),
        "extension/views/replay/reader.py": "def build_index(): ...",
        "views/proposals.json": json.dumps([{"slug": "board", "name": "Board"}, {"slug": "replay", "name": "Replay"}]),
    })
    out = tmp_path / "demos" / "toy"
    demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path, user="", scan=lambda _: [])
    return out, corpus


def reviewed(tmp_path: Path, slug: str, files: dict[str, str]) -> Path:
    """A reviewed view in the review home's workspace, stamped and kept at its version as the server's gate leaves it."""
    ws = tmp_path / "review" / "workspaces" / "toy"
    d = ws / "extension" / "views" / slug
    write(d, files)
    (d / "__pycache__").mkdir()
    (d / "__pycache__" / "reader.cpython-312.pyc").write_bytes(b"\0")
    meta = json.loads((d / "view.json").read_text())
    version = views.view_digest(d)[:12]
    (d / "view.json").write_text(json.dumps({**meta, "built": "2026-10-06T20:11:54+00:00", "version": version}))
    kept = ws / "views" / ".versions" / slug / version
    write(kept, {p.name: p.read_text() for p in d.iterdir() if p.is_file()})
    return ws


def two_reviewed(tmp_path: Path) -> Path:
    reviewed(tmp_path, "board-v2", {"view.json": json.dumps({"name": "Board (v2)"}), "gate.json": "{}",
                                    "view.html": "<p>Board (v2)</p><script>const HISTORY = 'history-v2'</script>",
                                    "reader.py": "# Board (v2): pages read from view:history-v2/<page>\n"})
    return reviewed(tmp_path, "history-v2", {"view.json": json.dumps({"name": "History (v2)"}),
                                             "view.html": "<p>the history; see Board (v2)</p>"})


def test_reviewed_views_replace_the_orientation_s_own_renamed_and_stamped(tmp_path):
    dv = _script()
    pc, corpus = precache(tmp_path)
    src = two_reviewed(tmp_path)
    m = dv.sync(pc, src, [("board-v2", "board"), ("history-v2", "history")], corpus, " (v2)", say=lambda *_: None)
    root = pc / "workspace" / "extension" / "views"
    assert sorted(p.name for p in root.iterdir()) == ["board", "history"]  # the orientation's replay is gone
    board = json.loads((root / "board" / "view.json").read_text())
    assert board["name"] == "Board" and board["built"] == "2026-10-06T20:11:54+00:00"
    assert board["version"] == views.view_digest(root / "board")[:12]
    assert (root / "board" / "view.html").read_text() == "<p>Board</p><script>const HISTORY = 'history'</script>"
    assert (root / "board" / "reader.py").read_text() == "# Board: pages read from view:history/<page>\n"
    assert (root / "history" / "view.html").read_text() == "<p>the history; see Board</p>"
    assert not (root / "board" / "__pycache__").exists() and not (root / "board" / "gate.json").exists()
    props = json.loads((pc / "workspace" / "views" / "proposals.json").read_text())
    assert [p["slug"] for p in props] == ["board"]
    on_disk = {p.relative_to(pc / "workspace").as_posix() for p in (pc / "workspace").rglob("*") if p.is_file()}
    assert on_disk == {f["path"] for f in m["files"]}
    assert m["counts"]["views"] == 2 and [(v["slug"], v["from"], v["picked"]) for v in m["views"]] == [
        ("board", "board-v2", "live at " + m["views"][0]["from_version"]),
        ("history", "history-v2", "live at " + m["views"][1]["from_version"])]
    assert json.loads((pc / demo.MANIFEST).read_text()) == m
    assert "Board (`board`, from `board-v2`)" in (pc / "README.md").read_text()
    # the folder passes check_content's terms for demos/, and install keeps each view at its stamp
    cc = _check_content()
    rels = [p.relative_to(tmp_path).as_posix() for p in pc.rglob("*") if p.is_file()]
    assert cc.demo_hits(tmp_path, rels) == []
    ws = tmp_path / "installed" / "toy"
    demo.install(pc, ws, corpus)
    for slug in ("board", "history"):
        stamp = json.loads((ws / "extension" / "views" / slug / "view.json").read_text())["version"]
        assert (ws / "views" / ".versions" / slug / stamp / "view.json").is_file()


def test_a_view_being_changed_gives_the_files_its_last_gate_passed(tmp_path):
    dv = _script()
    pc, corpus = precache(tmp_path)
    src = two_reviewed(tmp_path)
    (src / "extension" / "views" / "board-v2" / "view.html").write_text("<p>half a change</p>")
    m = dv.sync(pc, src, [("board-v2", "board")], corpus, " (v2)", say=lambda *_: None)
    html = (pc / "workspace" / "extension" / "views" / "board" / "view.html").read_text()
    assert html.startswith("<p>Board</p>") and m["views"][0]["picked"].startswith("kept at")


def test_a_review_home_that_renamed_its_views_gives_them_under_their_plain_slugs(tmp_path):
    dv = _script()
    pc, corpus = precache(tmp_path)
    src = reviewed(tmp_path, "board", {"view.json": json.dumps({"name": "Board"}),
                                       "view.html": "<script>const SELF = 'board-v2'</script>"})
    reviewed(tmp_path, "board-v2", {"view.json": json.dumps({"name": "Board (v2)"}), "view.html": "<p>older</p>"})
    meta = src / "extension" / "views" / "board-v2" / "view.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text()), "built": "2026-10-06T21:00:00+00:00"}))
    assert dv.source_slug(src, "board-v2", "board") == "board-v2"  # the plain slug still the orientation's older view
    meta.write_text(json.dumps({**json.loads(meta.read_text()), "built": "2026-10-06T04:00:00+00:00"}))
    assert dv.source_slug(src, "board-v2", "board") == "board" and dv.source_slug(src, "x-v2", "x") == "x-v2"
    m = dv.sync(pc, src, [("board-v2", "board")], corpus, " (v2)", say=lambda *_: None)
    html = (pc / "workspace" / "extension" / "views" / "board" / "view.html").read_text()
    assert html == "<script>const SELF = 'board'</script>" and m["views"][0]["from"] == "board"
    # a stamp the server kept no version for (a rename not yet gated) is refused, not served from an older view's copy
    meta = src / "extension" / "views" / "board" / "view.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text()), "version": "0123456789ab"}))
    with pytest.raises(dv.Refused, match="names no version the server kept"):
        dv.sync(pc, src, [("board-v2", "board")], corpus, " (v2)", say=lambda *_: None)


def test_a_view_that_would_not_pass_the_export_s_checks_is_refused_and_nothing_written(tmp_path):
    dv = _script()
    pc, corpus = precache(tmp_path)
    before = (pc / demo.MANIFEST).read_text()
    src = reviewed(tmp_path, "board-v2", {"view.json": json.dumps({"name": "Board (v2)"}),
                                          "view.html": "<p>from /home/someone/data</p>"})
    with pytest.raises(dv.Refused, match="nothing was written"):
        dv.sync(pc, src, [("board-v2", "board")], corpus, " (v2)", say=lambda *_: None)
    assert (pc / demo.MANIFEST).read_text() == before
    assert (pc / "workspace" / "extension" / "views" / "replay" / "reader.py").is_file()
    reviewed(tmp_path, "notes-v2", {"view.json": json.dumps({"name": "Notes (v2)"}), "rows.json": "[]"})
    with pytest.raises(dv.Refused, match="not a file a pre-cache holds"):
        dv.sync(pc, src, [("notes-v2", "notes")], corpus, " (v2)", say=lambda *_: None)
    with pytest.raises(dv.Refused, match="no such view"):
        dv.sync(pc, src, [("absent-v2", "absent")], corpus, " (v2)", say=lambda *_: None)


def test_the_sync_script_maps_each_dataset_s_reviewed_views():
    text = (ROOT / "scripts" / "sync_demo_views.sh").read_text()
    for ds in ("collusion-wiki", "mythos-5", "transluce-urlquery"):
        assert f"    {ds}) echo " in text
    assert "demo_views.py" in text and "check_content.py" in text
