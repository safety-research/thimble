"""scripts/dev/demo_views.py, which scripts/sync_demo_views.sh runs: reviewed views go into a demo pre-cache in place of
the pre-cache's own, each as the server serves it, renamed, and stamped with the digest of the files written, so
install keeps that version and the view shows at once."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


from app import demo, views

ROOT = Path(__file__).resolve().parents[2]


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
        "views/proposals.json": json.dumps([{"slug": "board", "name": "Board", "review": {"state": "done", "left": []}},
                                            {"slug": "replay", "name": "Replay"}]),
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


def test_every_demo_view_is_stamped_with_the_digest_of_its_files_and_listed_as_it_is():
    """A demo view edited after its stamp shows in `thimble demo` as changed and is built again, which fails there; so
    each pre-cache's views keep their `version` equal to their files' digest, and its manifest lists every file as it
    is (scripts/sync_demo_views.sh stamps both)."""
    root = ROOT / "demos"
    manifests = sorted(root.glob("*/thimble-demo-precache.json"))
    assert manifests
    for man in manifests:
        ws = man.parent / "workspace"
        for vd in sorted((ws / "extension" / "views").iterdir()):
            stamp = json.loads((vd / "view.json").read_text())["version"]
            assert stamp == views.view_digest(vd)[:12], f"{man.parent.name}/{vd.name}: stamp {stamp} is not its digest"
        for f in json.loads(man.read_text()).get("files", []):
            p = ws / f["path"]
            if p.is_file():
                body = p.read_bytes()
                assert (f["bytes"], f["sha256"]) == (len(body), hashlib.sha256(body).hexdigest()), f"{man.parent.name}: {f['path']}"
