"""`thimble demo` (app/demo.py, app/demo_data.py, app/demo_verbatim.py, app/precached.py): the dataset builders on
stubbed sources, the pre-cache's export (its outputs alone, refused when it copies the corpus) and install, the
command's flow with downloads, the server, Claude Code's login and the session start stubbed, and the context a fresh
session on a pre-cached workspace starts from. No network."""
import argparse
import asyncio
import hashlib
import io
import json
import random
import re
import zipfile
from pathlib import Path

import pytest

from app import config, demo, demo_data, demo_verbatim
from app.demo_data import Built, Dataset


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def jsonl(rows, **kw) -> bytes:
    return "".join(json.dumps(r, ensure_ascii=False, **kw) + "\n" for r in rows).encode()


# --------------------------------------------------------------------------- builders


def test_mythos5_drops_the_metadata_row_and_writes_compact_json(monkeypatch):
    raw = jsonl([{"record": "metadata", "title": "names the answer"},
                 {"record": "message", "n": 1, "text": "ä"}, {"record": "message", "n": 2}])
    monkeypatch.setattr(demo_data, "M5_SHA256", sha(raw))
    monkeypatch.setattr(demo_data, "M5_MESSAGES", 2)
    want = b'{"record":"message","n":1,"text":"\xc3\xa4"}\n{"record":"message","n":2}\n'
    monkeypatch.setitem(demo_data.MYTHOS5.expected, "transcript.jsonl", sha(want))
    built = demo_data.build_mythos5(lambda url: raw)
    assert built.files == {"transcript.jsonl": want} and built.warnings == []
    with pytest.raises(demo_data.SourceError):
        demo_data.build_mythos5(lambda url: raw + b'{"record":"message"}\n')


def collusion_sources(monkeypatch):
    """A dump and a report page with the shape the collusion-wiki build expects, and the pins set to them."""
    probes = [t for t in demo_data.CW_PROBE_URLS]
    events = [{"event_id": "attacklog_raw_dse_1", "event_type": "probe", "wiki": "dse", "time": t, "label": None,
               "request": "", "round_id": 3} for t in probes]
    events += [{"event_id": "e-revert", "event_type": "revert", "wiki": "dse", "time": "2026-05-01T00:00:00Z"},
               {"event_id": "d1", "event_type": "delete", "wiki": "dse", "time": "2026-05-02T00:00:00Z",
                "actor_label": "[Admin1]", "time_grade": "A"}]
    raw = {
        "pages.jsonl": jsonl([{"page_id": "P[Person20]", "labels": ["[Admin2]x", "[User3]"], "bucket": "b"}]),
        "revisions.jsonl": jsonl([{"rev_id": "r1", "label": "[Admin2]", "body": "hi [Person5]", "hunks": 2}]),
        "events.jsonl": jsonl(events),
        "labels.jsonl": jsonl([{"label": "[Person7]", "is_human_handle": True}]),
    }
    sums = "".join(f"{sha(v)}  {k}\n" for k, v in raw.items())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for k, v in raw.items():
            zf.writestr(k, v)
        zf.writestr("SHA256SUMS", sums)
    archive = buf.getvalue()
    xss = "https://wikiservice.at/dse/wiki.cgi?form_editprefs=1&action=form_editprefs&old_plist='><script>(function(){var d=JSON.parse(atob(\"e30=\"))})()</script>"
    mod = "https://wikiservice.at/dse/wiki.cgi?form_editprefs=1&action=form_editprefs&p_username=[RedactedModName]"
    page = (f"<p><code>{xss.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</code>"
            f"<code>{mod.replace('&', '&amp;')}</code></p>").encode()
    monkeypatch.setattr(demo_data, "CW_ARCHIVE_SHA256", sha(archive))
    monkeypatch.setattr(demo_data, "CW_REPORT_LINES", {
        "xss_chain": (demo_data.CW_REPORT_LINES["xss_chain"][0], sha(xss.encode())),
        "mod_prefs": ("[RedactedModName]", sha(mod.encode()))})
    return {demo_data.CW_ARCHIVE_URL: archive, demo_data.CW_REPORT_URL: page}, xss


def test_collusion_wiki_strips_analysis_attaches_the_report_and_renames_tokens(monkeypatch):
    sources, xss = collusion_sources(monkeypatch)
    built = demo_data.build_collusion_wiki(sources.__getitem__)
    rows = {k: [json.loads(x) for x in v.splitlines()] for k, v in built.files.items()}
    assert rows["revisions.jsonl"] == [{"rev_id": "r1", "label": "Friеdrich1982", "body": "hi AnjaWeber"}]
    assert rows["pages.jsonl"] == [{"page_id": "PUlrichBach", "labels": ["Friеdrich1982x", "SabineK"]}]
    assert rows["labels.jsonl"][0] == {"label": "JoergWinkler"}
    assert rows["labels.jsonl"][-1]["label"] == "Friedrich1982"  # the genuine admin, Latin spelling
    events = rows["events.jsonl"]
    assert not any(e["event_type"] in ("revert", "probe") for e in events)
    assert [e["time"] for e in events] == sorted(e["time"] for e in events)
    probe = next(e for e in events if e["time"] == "2026-06-18T17:44:47Z")
    assert probe["request"] == xss and probe["label"] == "XSSChainUser" and "round_id" not in probe
    assert probe["event_id"].startswith("request:dse:")
    assert next(e for e in events if e["event_type"] == "delete")["actor_label"] == "MartinHuber"
    prefs = next(e for e in events if e["event_id"] == "request:dse:2026-06-20:0")
    assert prefs["request"].endswith("p_username=MartinHuber") and prefs["label"] == "MartinHuber"
    assert len([e for e in events if e["event_id"].startswith("request:dse:2026-")]) == 22
    assert not re.search(r"\[(Admin|Person|User)\d+\]", "".join(v.decode() for v in built.files.values()))
    # the pins are the real copy's, so this synthetic one is reported as differing
    assert len(built.warnings) == 4


def test_a_changed_report_page_stops_the_collusion_wiki_build(monkeypatch):
    sources, _ = collusion_sources(monkeypatch)
    sources[demo_data.CW_REPORT_URL] = b"<p>moved</p>"
    with pytest.raises(demo_data.SourceError, match="no longer prints"):
        demo_data.build_collusion_wiki(sources.__getitem__)


def publisher_zip(files: dict[str, bytes], top: str = "evidence-v3") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if top:
            zf.writestr(f"{top}/", b"")
        for name, data in files.items():
            zf.writestr(f"{top}/{name}" if top else name, data)
    return buf.getvalue()


TL_FILES = {"README.txt": b"Folders follow the post.\n", "01-education/arquivo-captures.csv": b"record_number,url\n1,x\n",
            "01-education/responses/ab.txt": b"Loading ..."}
TL_URL = "https://transluce.org/data/evidence.zip"


def test_a_transluce_zip_is_extracted_as_published_without_its_top_folder():
    archive = publisher_zip(TL_FILES)
    build = demo_data.zip_dataset("tl", TL_URL, "20261002015844", sha(archive), {k: sha(v) for k, v in TL_FILES.items()})
    built = build(lambda url: archive)
    assert built.files == TL_FILES and built.warnings == []


def test_a_changed_transluce_zip_is_reported_and_built_from():
    pins = {k: sha(v) for k, v in TL_FILES.items()}
    changed = {**TL_FILES, "01-education/responses/ab.txt": b"other", "16-new/x.csv": b"a\n"}
    archive = publisher_zip(changed)
    built = demo_data.zip_dataset("tl", TL_URL, "1", "0" * 64, pins)(lambda url: archive)
    assert built.files == changed
    text = " ".join(built.warnings)
    assert "is not the zip the demo was made from" in text and "building from it anyway" in text
    assert "tl/01-education/responses/ab.txt differs from the copy" in text
    assert "1 files the demo was not made with (16-new/x.csv)" in text
    # a path that would leave the dataset's folder is left out
    evil = publisher_zip({**TL_FILES, "../escape.txt": b"x"}, top="")
    built = demo_data.zip_dataset("tl", TL_URL, "1", sha(evil), pins)(lambda url: evil)
    assert "../escape.txt" not in built.files and any("outside the dataset's folder" in w for w in built.warnings)


def test_a_transluce_zip_comes_from_the_internet_archive_when_transluce_org_fails():
    archive = publisher_zip(TL_FILES)
    got = []

    def fetch(url):
        got.append(url)
        if url == TL_URL:
            raise demo_data.SourceError(f"could not download {url}: 404")
        return archive

    built = demo_data.zip_dataset("tl", TL_URL, "20261002015844", sha(archive),
                                  {k: sha(v) for k, v in TL_FILES.items()})(fetch)
    assert got == [TL_URL, f"https://web.archive.org/web/20261002015844id_/{TL_URL}"]
    assert built.files == TL_FILES and len(built.warnings) == 1 and "Internet Archive's copy" in built.warnings[0]


def test_write_dataset_writes_subfolders_and_empty_folders(tmp_path):
    pins = {k: sha(v) for k, v in TL_FILES.items()}
    ds = Dataset(name="tl", title="t", about="a", source="s", sources=(TL_URL,), download_bytes=1, expected=pins,
                 transforms="none", licence="none", folders=("13-census",),
                 build=demo_data.zip_dataset("tl", TL_URL, "1", "0" * 64, pins))
    archive = publisher_zip(TL_FILES)
    folder = tmp_path / "tl"
    warnings = demo.write_dataset(ds, folder, lambda url: archive)
    assert (folder / "01-education" / "responses" / "ab.txt").read_bytes() == b"Loading ..."
    assert (folder / "13-census").is_dir() and not list(folder.rglob(".*.part"))
    assert len(warnings) == 1  # the zip's own pin is the test's zero digest
    # a second run with every file in place fetches nothing
    assert demo.write_dataset(ds, folder, lambda url: pytest.fail("fetched again")) == []
    (folder / "mine.txt").write_text("keep")
    (folder / "01-education" / "responses" / "ab.txt").write_bytes(b"edited")
    with pytest.raises(demo.DemoError, match="holds other files"):
        demo.write_dataset(ds, folder, lambda url: archive)


def test_the_registry_pins_every_dataset_and_its_sources():
    assert list(demo_data.DATASETS) == ["collusion-wiki", "mythos-5", "transluce-gov", "transluce-urlquery"]
    for d in demo_data.DATASETS.values():
        assert d.expected and all(len(h) == 64 for h in d.expected.values())
        assert all(u.startswith("https://") for u in d.sources)
    gov, uq = demo_data.DATASETS["transluce-gov"], demo_data.DATASETS["transluce-urlquery"]
    assert len(gov.expected) == 91 and gov.folders == ("13-census",) and len(uq.expected) == 16
    for d in (gov, uq):
        assert d.sources[0].startswith("https://transluce.org/data/")
        assert "Published by Transluce" in d.credit and "does not redistribute" in d.credit
        assert d.licence.startswith("No licence stated")
    # the repository's pre-caches read as this thimble reads them
    for name in demo.precaches(demo.PRECACHES):
        assert name in demo_data.DATASETS


# --------------------------------------------------------------------------- the pre-cache

CORPUS_TEXT = ("The agents left messages for each other on the wiki page, each one naming the benchmark question it "
               "had reached, the answer it planned to submit and the time it expected the next question to arrive. ") * 8


def make_workspace(root: Path, corpus: Path, home: Path) -> Path:
    """A finished orientation's workspace: its outputs, and the conversations, work files and caches a pre-cache leaves
    out. The report cites calls 2 (lines 3-4) and 5 of the orientation's chat o1; a card cites call 2 whole."""
    ws = root / "workspaces" / "toy"
    output = "\n".join(f"line {i}" for i in range(1, 60))
    calls = [{"n": 1, "id": "t1", "chat": "o1", "name": "Bash", "input": {"command": f"head {corpus}/a.jsonl"}},
             {"n": 1, "result": CORPUS_TEXT, "is_error": False},
             {"n": 2, "id": "t2", "chat": "o1", "name": "Bash", "input": {"command": "grep -c x a.jsonl"}},
             {"n": 2, "result": output, "is_error": False},
             {"n": 5, "id": "t5", "chat": "o1", "name": "Bash", "input": {"command": "wc -l a.jsonl"}},
             {"n": 5, "result": output, "is_error": False}]
    report = {"id": "report", "title": "What the agents did", "sections": [
        {"id": "s1", "heading": "Counts", "paragraphs": [{"id": "p1", "sentences": [
            {"id": "x1", "text": "It counted [[call:o1/2#L3-L4]] and [[call:o1/5]].", "refs": []}]}]}]}
    for rel, text in {
        "notebooks/g1.json": json.dumps({"id": "g1", "title": "Orientation", "cells": [
            {"id": "c1", "kind": "table", "title": "How many?", "code": f"pd.read_csv('{ws}/orient/work/t.csv')",
             "takeaway": "two rows [[call:o1/2]]", "outputs": [{"text/plain": "a b\n1 2"}]},
            {"id": "c2", "kind": "code", "title": "Where?", "code": f"open('{corpus}/a.jsonl')",
             "outputs": [{"text": f"{home}/.claude/x"}]},
            {"id": "c3", "kind": "example", "title": "One message", "payload": {"refs": ["a.jsonl#L1"]}}]}),
        "notebooks/outputs/c1-0.txt": "long output",
        "notebooks/outputs/c1-1.parquet": "PAR1\x00binary",
        "notebooks/trash/old.json": "{}",
        "concepts/l1.json": json.dumps({"id": "l1", "name": "flag", "spec": "def label(u): ..."}),
        "labels/l1.jsonl": "".join(json.dumps(r) + "\n" for r in (
            {"clear": "a.jsonl", "from": 1, "to": 1},
            {"ref": "a.jsonl#L1", "label": "yes", "confidence": 1.0, "source": "regex", "rationale": "names a time",
             "spans": ["the time it expected"]})),
        "labels/l1.sqlite": "derived",
        "chats/o1.jsonl": json.dumps({"type": "tool_result", "summary": CORPUS_TEXT}) + "\n",
        "chats/o1.meta.json": json.dumps({"id": "o1", "kind": "agent", "role": "orient", "model": "claude-opus-5-5",
                                         "title": "Orientation", "effort": "xhigh", "ultracode": True,
                                         "status": "running", "pid": 7, "server": 8, "session": "s-1", "bg": "b1",
                                         "workspace_dir": str(ws), "follow": {"offset": 999, "session": "s-1"},
                                         "permissions": [], "group": "g1"}),
        "chats/t9.jsonl": json.dumps({"type": "user", "text": "a side question"}) + "\n",
        "chats/t9.meta.json": json.dumps({"id": "t9", "kind": "thread"}),
        "chats/main.jsonl": json.dumps({"type": "user", "text": "hello", "by": "browser"}) + "\n",
        "chats/main.meta.json": json.dumps({"id": "main", "kind": "main"}),
        "calls/o1.jsonl": "".join(json.dumps(r) + "\n" for r in calls),
        "calls/zz.jsonl": json.dumps({"n": 1, "id": "u", "chat": "zz", "name": "Bash", "input": {}}) + "\n",
        "orient/run.json": json.dumps({"status": "done", "passes": ["final", "views"], "ultracode": True, "pid": 42,
                                       "chats": {"orient": "o1"}, "session": "s-1", "groups": {"orientation": "g1"},
                                       "coverage": 1}),
        "orient/summary.md": "summary",
        "orient/work/t.csv": "a,b\n1,2\n",
        "orient/work/.claude/settings.json": "{}",
        "extension/extension.json": json.dumps({"name": "toy"}),
        "extension/views/v1/view.json": json.dumps({"name": "v1", "built": "abc"}),
        "extension/views/v1/view.html": "<p>view</p>",
        "extension/views/v1/reader.py": "def build_index(): ...",
        "extension/views/v1/cache/x.json": "{}",
        "extension/views/v1/rows.json": "[]",
        "views/proposals.json": json.dumps([{"slug": "v1", "name": "Page threads", "why": "pages as threads",
                                             "claims": ["a.jsonl"]}]),
        "views/key-refs.json": json.dumps({"view:v1/p": {"excerpt": CORPUS_TEXT[:300]}}),
        "views/.versions/v1/abc/view.html": "<p>",
        "view-indexes/v1/index.json": "{}",
        "settings.json": json.dumps({"active_group": "g1", "api_token": "zzz"}),
        "canvas-history.jsonl": "{}\n",
        "card-checks/c1/fix-before.json": "{}",
        "scratch/a.jsonl": "mirror",
        "kernels/k.log": "log",
        "telemetry.jsonl": "{}\n",
        "sessions.json": "{}",
        "investigations/main/investigation.json": json.dumps({"id": "main"}),
        "investigations/main/report.json": json.dumps(report),
        "investigations/main/events.jsonl": json.dumps({"type": "chat", "chat": "o1"}) + "\n",
    }.items():
        p = ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return ws


def no_scan(_: Path):
    return []


def made(tmp_path: Path, where: str = "a", name: str = "toy", **kw) -> tuple[Path, Path, dict]:
    """A workspace made on a corpus under tmp_path/where, exported to tmp_path/out/<name>: (the pre-cache folder, the
    corpus, the manifest)."""
    root = tmp_path / where
    corpus = root / "corpus"
    corpus.mkdir(parents=True)
    (corpus / "a.jsonl").write_text(json.dumps({"body": CORPUS_TEXT}) + "\n")
    ws = make_workspace(root, corpus, root)
    out = tmp_path / "out" / name
    m = demo.export(ws, corpus, out, name=name, home=root, user="", scan=no_scan, **kw)
    return out, corpus, m


def tree_text(folder: Path) -> str:
    return "".join(p.read_text() for p in sorted(folder.rglob("*")) if p.is_file())


def test_export_keeps_the_outputs_alone(tmp_path):
    out, corpus, m = made(tmp_path)
    names = {p.relative_to(out / "workspace").as_posix() for p in (out / "workspace").rglob("*") if p.is_file()}
    assert names == {"notebooks/g1.json", "notebooks/outputs/c1-0.txt", "concepts/l1.json", "labels/l1.jsonl",
                     "chats/o1.jsonl", "chats/o1.meta.json", "calls/o1.jsonl", "orient/run.json", "orient/summary.md",
                     "extension/extension.json", "extension/views/v1/view.json", "extension/views/v1/view.html",
                     "extension/views/v1/reader.py", "views/proposals.json", "investigations/main/investigation.json",
                     "investigations/main/report.json"}
    assert {p.name for p in out.iterdir()} == {"workspace", "README.md", demo.MANIFEST}
    # the orientation's thread is kept as its meta and an empty log: its tool results quoted the corpus
    assert (out / "workspace" / "chats" / "o1.jsonl").read_text() == ""
    meta = json.loads((out / "workspace" / "chats" / "o1.meta.json").read_text())
    assert meta["status"] == "done" and meta["model"] == "claude-opus-5-5" and meta["group"] == "g1"
    assert not {"pid", "server", "follow", "session", "bg", "workspace_dir", "permissions"} & set(meta)
    run = json.loads((out / "workspace" / "orient" / "run.json").read_text())
    assert run["chats"] == {"orient": "o1"} and run["queue"] == [] and not {"session", "pid", "coverage"} & set(run)
    # label values by record ref, without the texts a label marked
    rows = [json.loads(x) for x in (out / "workspace" / "labels" / "l1.jsonl").read_text().splitlines()]
    assert rows[1] == {"ref": "a.jsonl#L1", "label": "yes", "confidence": 1.0, "source": "regex",
                       "rationale": "names a time"}
    text = tree_text(out)
    assert str(tmp_path) not in text and "@@THIMBLE_WORKSPACE@@/orient/work/t.csv" in text
    assert "@@THIMBLE_CORPUS@@/a.jsonl" in text and "@@THIMBLE_USER_HOME@@/.claude/x" in text
    assert "api_token" not in text and "a side question" not in text and "hello" not in text
    left = {f["path"]: f["why"] for f in m["left_out"]}
    assert left["chats/main.jsonl"].startswith("a conversation") and left["chats/t9.jsonl"].startswith("a conversation")
    assert left["calls/zz.jsonl"] == "calls no card or document cites"
    assert left["orient/work/t.csv"] == "the orientation's work files"
    assert left["views/key-refs.json"].startswith("the excerpts of the records")
    assert left["extension/views/v1/rows.json"].startswith("a view's cache or data")
    assert left["investigations/main/events.jsonl"] == "not one of the orientation's outputs"
    assert left["notebooks/outputs/c1-1.parquet"] == "not text"
    assert left["notebooks/trash/old.json"].startswith("the canvas")
    assert {"labels/l1.sqlite", "scratch/a.jsonl", "telemetry.jsonl", "sessions.json", "settings.json",
            "canvas-history.jsonl", "card-checks/c1/fix-before.json", "view-indexes/v1/index.json",
            "views/.versions/v1/abc/view.html", "extension/views/v1/cache/x.json"} <= set(left)
    assert m["counts"] == {"cards": 3, "labels": 1, "views": 1, "documents": 1}
    assert m["orientation"]["model"] == "claude-opus-5-5" and m["orientation"]["chat"] == "o1"
    assert m["corpus"][0]["path"] == "a.jsonl" and m["version"] == 3 and "transcripts" not in m
    assert json.loads((out / demo.MANIFEST).read_text())["files"] == m["files"]
    assert m["verbatim"]["long"] == demo_verbatim.LONG == 400
    # a second export replaces the folder
    (out / "workspace" / "stale.json").write_text("{}")
    made(tmp_path, where="b")
    assert not (out / "workspace" / "stale.json").exists()


def test_export_keeps_the_cited_calls_cut_to_an_excerpt(tmp_path):
    out, _, m = made(tmp_path)
    assert [(c["chat"], c["n"], c["lines"]) for c in m["cited_calls"]] == [("o1", 2, None), ("o1", 5, None)]
    rows = [json.loads(x) for x in (out / "workspace" / "calls" / "o1.jsonl").read_text().splitlines()]
    assert {r["n"] for r in rows} == {2, 5}  # call 1, which nothing cites, is left out with its output
    result = next(r["result"] for r in rows if r["n"] == 2 and "result" in r).split("\n")
    assert result[0] == "line 1" and result[demo.CALL_LINES - 1] == f"line {demo.CALL_LINES}"
    assert result[-1] == demo.CALL_CUT_NOTE and len(result) == demo.CALL_LINES + 1
    # only lines cited: those lines in place, the others empty, so `#L3-L4` still names them
    out_lines, cut = demo.call_excerpt("\n".join(f"l{i}" for i in range(1, 100)), [(3, 4), (50, 50)])
    lines = out_lines.split("\n")
    assert cut and lines[2:4] == ["l3", "l4"] and lines[49] == "l50" and lines[0] == ""
    assert lines[-1] == demo.CALL_CUT_NOTE
    assert demo.citations(["[[call:o1/2#L3-L4]] [[call:o1/2#L9]]", "call:x/1"]) == {("o1", 2): [(3, 4), (9, 9)],
                                                                                    ("x", 1): None}


def test_export_refuses_a_file_that_copies_a_long_stretch_of_the_corpus(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "a.jsonl").write_text(json.dumps({"body": CORPUS_TEXT}) + "\n")
    (corpus / "b.csv").write_text("id,text\n" + "\n".join(f"{i},{CORPUS_TEXT[i:i + 80]}" for i in range(0, 900, 80)))
    ws = make_workspace(tmp_path, corpus, tmp_path)
    nb = ws / "notebooks" / "g1.json"
    cards = json.loads(nb.read_text())
    cards["cells"][0]["outputs"] = [{"text/plain": "head:\n" + CORPUS_TEXT[:500]}]
    nb.write_text(json.dumps(cards))
    out = tmp_path / "out"
    with pytest.raises(demo.DemoError) as e:  # --allow-private does not let it through
        demo.export(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan, allow_private=True)
    assert "notebooks/g1.json: 1 stretch of 400+ characters copied from the corpus" in str(e.value)
    assert "nothing was written" in str(e.value) and not out.exists()
    # an excerpt under the threshold, as a card quotes a record, passes
    cards["cells"][0]["outputs"] = [{"text/plain": "head:\n" + CORPUS_TEXT[:300]}]
    nb.write_text(json.dumps(cards))
    m = demo.export(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan)
    assert m["verbatim"]["longest"][0]["path"] == "notebooks/g1.json" and m["verbatim"]["longest"][0]["chars"] < 400
    # rows of a CSV file printed as they stand are one stretch of it
    cards["cells"][0]["outputs"] = [{"text/plain": (corpus / "b.csv").read_text()[:700]}]
    nb.write_text(json.dumps(cards))
    with pytest.raises(demo.DemoError, match="notebooks/g1.json"):
        demo.export(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan)


def test_the_verbatim_index_finds_every_long_shared_stretch():
    rng = random.Random(7)
    text = "".join(rng.choice("abcdefghij klmnopqrstuvwxyz") for _ in range(5000))
    corpus = demo_verbatim.Corpus(files=[("a.txt", text)])
    for start, n in ((0, 400), (1234, 462), (777, 1000)):
        piece = text[start:start + n].strip()
        found = demo_verbatim.scan(corpus, "card.json", json.dumps({"out": "BEFORE " + piece + " AFTER"}))
        assert found.longest >= len(piece) - 2 * (demo_verbatim.STRIDE - 1) and found.shared >= found.longest
    assert demo_verbatim.scan(corpus, "card.json", json.dumps({"out": text[10:10 + 500]})).long_runs == 1
    assert demo_verbatim.scan(corpus, "card.json", json.dumps({"out": "NOTHING OF IT " * 20})).longest == 0


def test_export_refuses_what_may_be_private(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path / "elsewhere", corpus, Path("/home/someone"))
    (ws / "orient" / "summary.md").write_text("by maintainername from /mnt/disk/x")
    out = tmp_path / "p"
    with pytest.raises(demo.DemoError) as e:
        demo.export(ws, corpus, out, name="toy", home=tmp_path / "nohome", user="maintainername",
                    scan=lambda _: ["workspace/orient/summary.md:1: generic-api-key"])
    assert "maintainername" in str(e.value) and "/mnt/disk" in str(e.value) and "generic-api-key" in str(e.value)
    assert not out.exists()
    m = demo.export(ws, corpus, out, name="toy", home=tmp_path / "nohome", user="maintainername", allow_private=True,
                    scan=no_scan)
    assert out.is_dir() and "workspace/orient/summary.md: /mnt/disk" in m["flagged"]
    (tmp_path / "mine").mkdir()
    (tmp_path / "mine" / "notes.txt").write_text("keep")
    with pytest.raises(demo.DemoError, match="not a pre-cache"):
        demo.export(ws, corpus, tmp_path / "mine", name="toy", home=tmp_path, user="", scan=no_scan)
    assert (tmp_path / "mine" / "notes.txt").read_text() == "keep"


def test_export_scrubs_the_user_name_and_paths_a_summary_cut_short(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path, corpus, tmp_path)
    cut = str(ws)[: len(str(ws)) - 4] + "…"
    (ws / "orient" / "summary.md").write_text(f"drwx maintainername maintainername x\n{cut}\n")
    out = tmp_path / "s"
    m = demo.export(ws, corpus, out, name="toy", home=tmp_path, user="maintainername", scrub_user=True, scan=no_scan)
    summary = (out / "workspace" / "orient" / "summary.md").read_text()
    assert "drwx user user x" in summary and "@@THIMBLE_WORKSPACE@@…" in summary and str(tmp_path) not in summary
    assert m["user_name_scrubbed"] == 2 and m["flagged"] == []


def test_install_fills_the_placeholders_and_marks_the_workspace_precached(tmp_path):
    out, corpus, _ = made(tmp_path)
    new_corpus = tmp_path / 'b "quoted"' / "corpus"
    new_corpus.mkdir(parents=True)
    (new_corpus / "a.jsonl").write_text('{"x": 2}\n')
    new_ws = tmp_path / "b-workspaces" / "toy-2"
    m = demo.install(out, new_ws, new_corpus, home=tmp_path / "b")
    nb = json.loads((new_ws / "notebooks" / "g1.json").read_text())
    assert nb["cells"][0]["code"] == f"pd.read_csv('{new_ws}/orient/work/t.csv')"
    assert nb["cells"][1]["code"] == f"open('{new_corpus}/a.jsonl')"
    mark = json.loads((new_ws / demo.MARKER).read_text())
    assert mark["dataset"] == "toy" and mark["folder"] == str(new_corpus) and mark["orientation"] == "o1"
    assert mark["model"] == "claude-opus-5-5" and mark["created"]
    run = json.loads((new_ws / "orient" / "run.json").read_text())
    assert run["status"] == "done" and run["precached"] == mark and "session" not in run
    meta = json.loads((new_ws / "chats" / "o1.meta.json").read_text())
    assert meta["precached"] == mark and meta["status"] == "done" and "session" not in meta
    assert (new_ws / "chats" / "o1.jsonl").read_text() == ""
    assert not (new_ws / "orient" / "work").exists()
    assert m["warnings"] == ["a.jsonl differs from the file the orientation read"]
    assert not list(new_ws.parent.glob(".toy-2.demo-*"))
    with pytest.raises(demo.DemoError):
        demo.install(out, new_ws, new_corpus)


def test_install_refuses_paths_outside_the_workspace_and_files_of_other_kinds(tmp_path):
    out, corpus, _ = made(tmp_path)
    man = json.loads((out / demo.MANIFEST).read_text())
    for bad in ("../../escape.txt", "orient/work/rows.json"):
        changed = {**man, "files": [*man["files"], {"path": bad}]}
        (out / demo.MANIFEST).write_text(json.dumps(changed))
        with pytest.raises(demo.DemoError, match="paths it may not"):
            demo.install(out, tmp_path / "ws", corpus)
        assert not (tmp_path / "ws").exists()
    (out / demo.MANIFEST).write_text(json.dumps({**man, "version": 2, "transcripts": [{"path": "t.jsonl"}]}))
    with pytest.raises(demo.DemoError, match="another format"):
        demo.install(out, tmp_path / "ws", corpus)


def test_a_precache_carries_its_sources_notice_first_in_its_readme(tmp_path):
    out, _, m = made(tmp_path, name="mythos-5")
    assert "canary GUID" in m["notice"]
    readme = (out / "README.md").read_text()
    assert readme.startswith("> Notice from the source: This document should not be included")
    assert json.loads((out / demo.MANIFEST).read_text())["notice"] == m["notice"]
    assert "session is not here" in readme and "No file shares a stretch of 400 characters" in readme
    out, _, m = made(tmp_path, where="t", name="transluce-gov")
    assert "Published by Transluce" in m["credit"] and "Published by Transluce" in (out / "README.md").read_text()


# --------------------------------------------------------------------------- the context of a fresh session


def test_a_fresh_session_on_a_precached_workspace_starts_from_the_canvas_and_the_report(tmp_path, mini_dir):
    from app import orient_session, precached

    c = "mini"
    assert precached.take_context(c, "s1") == ""  # a workspace not installed from a pre-cache
    ws = config.workspace_path(c)
    assert not ws.exists()
    out, _, _ = made(tmp_path)
    demo.install(out, ws, mini_dir)
    text = precached.take_context(c, "s1")
    assert text.startswith("This workspace was installed from a pre-cache")
    assert "card:c1" in text and "How many?" in text and "two rows" in text  # the canvas
    assert "Page threads" in text  # the views
    assert "report:report" in text and "It counted" in text  # the documents, and the report's text
    assert precached.take_context(c, "s1") == ""  # given once per session
    assert precached.take_context(c, "s2").startswith("This workspace was installed from a pre-cache")
    assert json.loads((ws / demo.MARKER).read_text())["context_given"] == ["s1", "s2"]
    # its orientation takes no message: its session was not kept
    with pytest.raises(precached.Precached):
        asyncio.run(orient_session.message(c, "more please"))


# --------------------------------------------------------------------------- the command


def fake_dataset(name: str, caution: str = "") -> Dataset:
    data = b'{"n": 1}\n'
    return Dataset(name=name, title=name, about="about", source="example.org", sources=(f"https://example.org/{name}",),
                   download_bytes=10, expected={"a.jsonl": sha(data)}, transforms="none", licence="test",
                   credit=f"Published by {name}'s authors; downloaded from example.org.", caution=caution,
                   build=lambda fetch: Built({"a.jsonl": fetch(f"https://example.org/{name}") and data}))


def args(**kw) -> argparse.Namespace:
    base = dict(names=[], yes=True, dir=None, list=False, attach=False, no_attach=False, replace=False, precaches=None,
                export=None, dataset=None, corpus=None, allow_private=False, scrub_user=False, app=None)
    return argparse.Namespace(**{**base, **kw})


@pytest.fixture()
def fake_world(tmp_path, monkeypatch):
    """Two fake datasets, an empty folder of pre-caches, a data folder and a workspaces folder of the test's own, a
    `claude` on PATH that is logged in, and no server."""
    monkeypatch.setattr(demo, "DATASETS", {n: fake_dataset(n) for n in ("one", "two")})
    monkeypatch.setattr(demo, "PRECACHES", tmp_path / "demos")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "CLI_PATH", "/usr/bin/claude")
    env = {"workspaces_dir": str(tmp_path / "workspaces"), "data_dir": str(tmp_path / "data")}
    w = {"got": [], "lines": [], "started": [], "shown": [], "root": tmp_path / "demo", "env": env,
         "auth": {"loggedIn": True}}

    def get(url: str) -> bytes:
        w["got"].append(url)
        return b"payload"

    w["get"] = get
    w["server"] = lambda say: (None, env)
    return w


def said(w) -> str:
    """What the command printed, its wrapped lines joined back."""
    return " ".join(" ".join(w["lines"]).split())


def run(w, a) -> int:
    return demo.run(a, get=w["get"], say=w["lines"].append, server=w["server"], start=w["started"].append,
                    show=lambda url: w["shown"].append(url) or True, auth=lambda: w["auth"])


def precache_for(tmp_path: Path, name: str) -> Path:
    """The pre-cache of dataset `name`, made on a copy of its file, in tmp_path/pre/<name>."""
    root = tmp_path / "made-on"
    corpus = root / name
    corpus.mkdir(parents=True)
    (corpus / "a.jsonl").write_bytes(b'{"n": 1}\n')
    ws = make_workspace(root, corpus, root)
    demo.export(ws, corpus, tmp_path / "pre" / name, name=name, home=root, user="", scan=no_scan)
    return tmp_path / "pre"


def terminal(monkeypatch, answers: list[str]) -> list[str]:
    """A terminal on both ends that answers each question with the next of `answers`; the questions asked."""
    asked: list[str] = []
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    it = iter(answers)
    monkeypatch.setattr("builtins.input", lambda q: asked.append(q) or next(it))
    return asked


def test_demo_downloads_installs_opens_and_says_how_to_attach(tmp_path, fake_world):
    w = fake_world
    pre = precache_for(tmp_path, "one")
    assert run(w, args(names=["one", "two"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert (w["root"] / "one" / "a.jsonl").read_bytes() == b'{"n": 1}\n'
    assert w["got"] == ["https://example.org/one", "https://example.org/two"]
    installed = Path(w["env"]["workspaces_dir"]) / "one"
    assert json.loads((installed / "orient" / "run.json").read_text())["precached"]["dataset"] == "one"
    assert json.loads((installed / demo.MARKER).read_text())["folder"] == str(w["root"] / "one")
    assert str(w["root"] / "one") in (installed / "notebooks" / "g1.json").read_text()
    assert json.loads((tmp_path / "data" / "one.corpus.json").read_text())["path"] == str(w["root"] / "one")
    # two has no pre-cache: registered, nothing installed
    assert json.loads((tmp_path / "data" / "two.corpus.json").read_text())["path"] == str(w["root"] / "two")
    assert not (Path(w["env"]["workspaces_dir"]) / "two").exists()
    text = said(w)
    assert "installed as workspace one: 3 cards, 1 label, 1 view, 1 document" in text
    assert "redistributes none of them" in text and "Published by one's authors" in text
    assert "two opens without a pre-cached orientation; Start in the page runs one" in text
    assert f"cd {w['root'] / 'one'} && thimble # one" in text and f"cd {w['root'] / 'two'} && thimble # two" in text
    assert "No Claude Code session is attached" in text and "`thimble -c` in that folder continues" in text
    assert "starts fresh, with the orientation's cards and report as its context" in text
    assert w["started"] == []  # no terminal here, so nothing is asked and no session starts
    sources = (w["root"] / "SOURCES.md").read_text()
    assert "## one: one" in sources and "redistributes none of these datasets" in sources
    assert "Published by one's authors" in sources and "Downloaded from: https://example.org/one" in sources
    # a second run downloads nothing and leaves the analysis in place
    w["got"].clear()
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert w["got"] == [] and "holds an analysis already; it stays" in said(w)
    assert "## two: two" in (w["root"] / "SOURCES.md").read_text()  # an earlier run's dataset stays listed
    # --replace archives it and installs the pre-cache again
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre), replace=True)) == 0
    assert list((Path(w["env"]["workspaces_dir"]) / ".archive").glob("one-*"))
    assert (installed / "orient" / "run.json").is_file()


def test_demo_with_no_precache_opens_each_dataset_with_a_note(fake_world):
    w = fake_world  # PRECACHES is an empty folder, as in a release with no demos/<name>/
    assert run(w, args(names=["one", "two"], dir=str(w["root"]))) == 0
    for name in ("one", "two"):
        assert json.loads((Path(w["env"]["data_dir"]) / f"{name}.corpus.json").read_text())["path"] == str(w["root"] / name)
        assert not (Path(w["env"]["workspaces_dir"]) / name).exists()
    assert len([x for x in w["lines"] if "opens without a pre-cached orientation" in x]) == 2
    text = said(w)
    assert "None has a pre-cached orientation here" in text and "No Claude Code session is attached" in text
    assert "ran in advance" not in text


def test_demo_asks_to_attach_on_a_terminal_and_enter_attaches(tmp_path, fake_world, monkeypatch):
    w = fake_world
    pre = precache_for(tmp_path, "one")
    asked = terminal(monkeypatch, [""])
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert asked == [demo.ATTACH_QUESTION] and "(requires claude to be logged in)" in asked[0]
    assert w["started"] == [w["root"] / "one"]
    text = said(w)
    assert f"Attaching a Claude Code session in {w['root'] / 'one'}" in text
    assert f"cd {w['root'] / 'one'} && thimble" in text and "`thimble -c` in that folder continues" in text


def test_demo_attaches_nothing_on_a_no(fake_world, monkeypatch):
    w = fake_world
    terminal(monkeypatch, ["n"])
    assert run(w, args(names=["one"], dir=str(w["root"]))) == 0
    assert w["started"] == [] and "No Claude Code session is attached" in said(w)
    # two datasets: the yes then asks which
    asked = terminal(monkeypatch, ["y", "2"])
    assert run(w, args(names=["one", "two"], dir=str(w["root"]))) == 0
    assert asked[0] == demo.ATTACH_QUESTION and asked[1].startswith("Attach in which?")
    assert w["started"] == [w["root"] / "two"]


def test_demo_says_how_to_log_in_when_claude_is_not_logged_in(fake_world, monkeypatch):
    w = fake_world
    w["auth"] = {"loggedIn": False}
    asked = terminal(monkeypatch, [])
    assert run(w, args(names=["one"], dir=str(w["root"]))) == 0
    assert asked == [] and w["started"] == []
    text = said(w)
    assert "Claude Code is not logged in" in text and "`claude auth login`" in text
    assert f"cd {w['root'] / 'one'} && thimble" in text
    # no claude on PATH at all
    monkeypatch.setattr(config, "CLI_PATH", None)
    w["lines"].clear()
    assert run(w, args(names=["one"], dir=str(w["root"]))) == 0
    assert asked == [] and "is not on PATH" in said(w)


def test_demo_attach_and_no_attach_answer_without_asking(fake_world, monkeypatch):
    w = fake_world
    asked = terminal(monkeypatch, [])
    assert run(w, args(names=["one"], dir=str(w["root"]), no_attach=True)) == 0
    assert asked == [] and w["started"] == [] and "No Claude Code session is attached" in said(w)
    assert run(w, args(names=["one"], dir=str(w["root"]), attach=True)) == 0
    assert asked == [] and w["started"] == [w["root"] / "one"]
    # --attach without a terminal: the workspace opens, with the instructions
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    w["lines"].clear()
    assert run(w, args(names=["one"], dir=str(w["root"]), attach=True)) == 0
    assert w["started"] == [w["root"] / "one"] and "needs a terminal" in said(w)


def test_demo_opens_the_page_with_a_server(tmp_path, fake_world, monkeypatch):
    w = fake_world
    pre = precache_for(tmp_path, "one")
    from app import cli

    monkeypatch.setattr(demo, "register", lambda folder, url: folder.name)
    monkeypatch.setattr(cli, "ui_url", lambda name, key=True: f"http://127.0.0.1:1/?ws={name}")
    w["server"] = lambda say: ("http://127.0.0.1:1", w["env"])
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert w["shown"] == ["http://127.0.0.1:1/?ws=one"] and "Open at http://127.0.0.1:1/?ws=one" in said(w)
    assert w["started"] == []


def test_demo_asks_before_downloading_and_needs_a_terminal_to_ask(fake_world, monkeypatch):
    w = fake_world
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    assert run(w, args(yes=False, dir=str(w["root"]))) == 1
    assert w["got"] == [] and "no terminal to ask on" in said(w)
    terminal(monkeypatch, ["n", "y", "n"])
    assert run(w, args(yes=False, dir=str(w["root"]))) == 0
    assert w["got"] == ["https://example.org/two"] and "  one: skipped" in w["lines"]
    # a dataset already in place needs no yes, even with no terminal
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    w["got"].clear()
    assert run(w, args(names=["two"], yes=False, dir=str(w["root"]))) == 0 and w["got"] == []


def test_demo_list_downloads_nothing_and_shows_credits_and_cautions(fake_world, monkeypatch):
    w = fake_world
    monkeypatch.setitem(demo.DATASETS, "one", fake_dataset("one", caution="safeguards may stop it"))
    assert run(w, args(list=True, dir=str(w["root"]))) == 0
    assert w["got"] == [] and not w["root"].exists()
    text = said(w)
    assert "no pre-cached orientation yet" in text and "Published by one's authors" in text
    assert "Note: safeguards may stop it" in text


def test_a_folder_with_other_files_is_left_alone(fake_world):
    w = fake_world
    (w["root"] / "one").mkdir(parents=True)
    (w["root"] / "one" / "mine.txt").write_text("keep")
    assert run(w, args(names=["one"], dir=str(w["root"]))) == 1
    assert "holds other files (mine.txt)" in said(w)
    assert (w["root"] / "one" / "mine.txt").read_text() == "keep" and w["got"] == []


def test_export_command_waits_for_a_finished_orientation(tmp_path, monkeypatch):
    monkeypatch.setattr(demo, "gitleaks_scan", no_scan)
    monkeypatch.setattr(demo.getpass, "getuser", lambda: "")
    monkeypatch.setenv("HOME", str(tmp_path))
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path, corpus, tmp_path)
    run_path = ws / "orient" / "run.json"
    run_rec = json.loads(run_path.read_text())
    run_path.write_text(json.dumps({**run_rec, "status": "running"}))
    lines: list[str] = []
    a = args(export=[str(ws), str(tmp_path / "out")], corpus=str(corpus))
    assert demo.run(a, say=lines.append) == 1 and "is running; export it once it is done" in " ".join(lines)
    run_path.write_text(json.dumps(run_rec))
    assert demo.run(a, say=lines.append) == 0
    assert (tmp_path / "out" / "toy" / demo.MANIFEST).is_file()
    assert "2 cited calls" in " ".join(lines) and "refused from 400" in " ".join(lines)
    # OUT naming the pre-cache folder itself writes it again in place
    assert demo.run(args(export=[str(ws), str(tmp_path / "out" / "toy")], corpus=str(corpus)), say=lines.append) == 0
    assert not (tmp_path / "out" / "toy" / "toy").exists()


def test_the_analyst_picks_the_folder_a_session_attaches_in(tmp_path, monkeypatch):
    folders = [tmp_path / "a", tmp_path / "b"]
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    for typed, want in (("", folders[0]), ("2", folders[1]), ("n", None), ("9", None)):
        monkeypatch.setattr("builtins.input", lambda q, typed=typed: typed)
        assert demo.pick_folder(folders) == want
    assert demo.pick_folder(folders[:1]) == folders[0]
