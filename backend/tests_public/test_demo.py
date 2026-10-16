"""`thimble demo` (app/demo.py, app/demo_data.py, app/demo_verbatim.py, app/precached.py): the dataset builders on
stubbed sources, the pre-cache's export (its outputs alone, refused when it copies the corpus) and install, the
command's flow with downloads, the server, Claude Code's login and the session start stubbed, and the context a fresh
session on a pre-cached workspace starts from. No network."""
import argparse
import hashlib
import json
from pathlib import Path

import pytest

from app import config, demo, demo_data
from app.demo_data import Built, Dataset


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def jsonl(rows, **kw) -> bytes:
    return "".join(json.dumps(r, ensure_ascii=False, **kw) + "\n" for r in rows).encode()


# --------------------------------------------------------------------------- builders


def test_the_registry_pins_every_dataset_and_its_sources():
    assert list(demo_data.DATASETS) == ["collusion-wiki", "mythos-5", "transluce-urlquery"]
    for d in demo_data.DATASETS.values():
        assert d.expected and all(len(h) == 64 for h in d.expected.values())
        assert all(u.startswith("https://") for u in d.sources)
    uq = demo_data.DATASETS["transluce-urlquery"]
    assert len(uq.expected) == 16
    assert uq.sources[0].startswith("https://transluce.org/data/")
    assert "Published by Transluce" in uq.credit and "does not redistribute" in uq.credit
    assert uq.licence.startswith("No license stated")
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
                                         "status": "running", "pid": 7, "server": 8, "session": "s-1", "bg": "b1", "background": True,
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
    m = demo.export_outputs(ws, corpus, out, name=name, home=root, user="", scan=no_scan, **kw)
    return out, corpus, m


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
        demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan, allow_private=True)
    assert "notebooks/g1.json: 1 stretch of 400+ characters copied from the corpus" in str(e.value)
    assert "nothing was written" in str(e.value) and not out.exists()
    assert not [x for x in tmp_path.iterdir() if x.name.startswith(".")]  # not even a folder it staged in
    # an excerpt under the threshold, as a card quotes a record, passes
    cards["cells"][0]["outputs"] = [{"text/plain": "head:\n" + CORPUS_TEXT[:300]}]
    nb.write_text(json.dumps(cards))
    m = demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan)
    assert m["verbatim"]["longest"][0]["path"] == "notebooks/g1.json" and m["verbatim"]["longest"][0]["chars"] < 400
    # rows of a CSV file printed as they stand are one stretch of it
    cards["cells"][0]["outputs"] = [{"text/plain": (corpus / "b.csv").read_text()[:700]}]
    nb.write_text(json.dumps(cards))
    with pytest.raises(demo.DemoError, match="notebooks/g1.json"):
        demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan)


def test_export_refuses_what_may_be_private(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path / "elsewhere", corpus, Path("/home/someone"))
    (ws / "orient" / "summary.md").write_text("by maintainername from /mnt/disk/x")
    out = tmp_path / "p"
    with pytest.raises(demo.DemoError) as e:
        demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path / "nohome", user="maintainername",
                    scan=lambda _: ["workspace/orient/summary.md:1: generic-api-key"])
    assert "maintainername" in str(e.value) and "/mnt/disk" in str(e.value) and "generic-api-key" in str(e.value)
    assert not out.exists()
    m = demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path / "nohome", user="maintainername", allow_private=True,
                    scan=no_scan)
    assert out.is_dir() and "workspace/orient/summary.md: /mnt/disk" in m["flagged"]
    (tmp_path / "mine").mkdir()
    (tmp_path / "mine" / "notes.txt").write_text("keep")
    with pytest.raises(demo.DemoError, match="not a pre-cache"):
        demo.export_outputs(ws, corpus, tmp_path / "mine", name="toy", home=tmp_path, user="", scan=no_scan)
    assert (tmp_path / "mine" / "notes.txt").read_text() == "keep"


def test_export_scrubs_the_user_name_and_paths_a_summary_cut_short(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path, corpus, tmp_path)
    cut = str(ws)[: len(str(ws)) - 4] + "…"
    (ws / "orient" / "summary.md").write_text(f"drwx maintainername maintainername x\n{cut}\n")
    out = tmp_path / "s"
    m = demo.export_outputs(ws, corpus, out, name="toy", home=tmp_path, user="maintainername", scrub_user=True, scan=no_scan)
    summary = (out / "workspace" / "orient" / "summary.md").read_text()
    assert "drwx user user x" in summary and "@@THIMBLE_WORKSPACE@@…" in summary and str(tmp_path) not in summary
    assert m["user_name_scrubbed"] == 2 and m["flagged"] == []


def test_install_refuses_paths_outside_the_workspace_and_files_of_other_kinds(tmp_path):
    out, corpus, _ = made(tmp_path)
    man = json.loads((out / demo.MANIFEST).read_text())
    for bad in ("../../escape.txt", "orient/work/rows.json"):
        changed = {**man, "files": [*man["files"], {"path": bad}]}
        (out / demo.MANIFEST).write_text(json.dumps(changed))
        with pytest.raises(demo.DemoError, match="paths it may not"):
            demo.install(out, tmp_path / "ws", corpus)
        assert not (tmp_path / "ws").exists()
    for version in (1, 5):
        (out / demo.MANIFEST).write_text(json.dumps({**man, "version": version}))
        with pytest.raises(demo.DemoError, match="another format"):
            demo.install(out, tmp_path / "ws", corpus)


# --------------------------------------------------------------------------- the command


def fake_dataset(name: str, caution: str = "") -> Dataset:
    data = b'{"n": 1}\n'
    return Dataset(name=name, title=name, about="about", source="example.org", sources=(f"https://example.org/{name}",),
                   download_bytes=10, expected={"a.jsonl": sha(data)}, transforms="none", licence="test",
                   credit=f"Published by {name}'s authors; downloaded from example.org.", caution=caution,
                   build=lambda fetch: Built({"a.jsonl": fetch(f"https://example.org/{name}") and data}))


def args(**kw) -> argparse.Namespace:
    base = dict(names=[], yes=True, dir=None, list=False, attach=False, no_attach=False, replace=False, precaches=None,
                export=None, outputs_only=False, dataset=None, corpus=None, allow_private=False, scrub_user=False,
                app=None, claude_config=None, view=None, refresh=False)
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
    demo.export_outputs(ws, corpus, tmp_path / "pre" / name, name=name, home=root, user="", scan=no_scan)
    return tmp_path / "pre"


def test_demo_downloads_installs_opens_and_says_how_to_attach(tmp_path, fake_world):
    w = fake_world
    pre = precache_for(tmp_path, "one")
    assert run(w, args(names=["one", "two"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert (w["root"] / "one" / "a.jsonl").read_bytes() == b'{"n": 1}\n'
    assert w["got"] == ["https://example.org/one", "https://example.org/two"]
    installed = Path(w["env"]["workspaces_dir"]) / "demo-one"
    assert json.loads((installed / "orient" / "run.json").read_text())["precached"]["dataset"] == "one"
    assert json.loads((installed / demo.MARKER).read_text())["folder"] == str(w["root"] / "one")
    assert str(w["root"] / "one") in (installed / "notebooks" / "g1.json").read_text()
    assert json.loads((tmp_path / "data" / "demo-one.corpus.json").read_text())["path"] == str(w["root"] / "one")
    # two has no pre-cache: registered, nothing installed
    assert json.loads((tmp_path / "data" / "demo-two.corpus.json").read_text())["path"] == str(w["root"] / "two")
    assert not (Path(w["env"]["workspaces_dir"]) / "demo-two").exists()
    text = said(w)
    assert "installed as workspace demo-one: 3 cards, 1 label, 1 view, 1 document" in text
    assert "downloads these datasets from their sources" in text
    # a static page has no Claude to ask: the line says where a session starts
    assert (f"two opens without a pre-cached orientation; to run one, start a session there (`cd {w['root'] / 'two'} "
            "&& thimble`) and ask Claude for an orientation") in text
    assert "ask Claude in the page" not in text
    assert f"cd {w['root'] / 'one'} && thimble # one" in text and f"cd {w['root'] / 'two'} && thimble # two" in text
    # no session attached: for each dataset one sentence and the command that starts a session there
    assert text.count(f"{demo.FROZEN_LINE} cd ") == 2
    assert "No Claude Code session is attached" not in text and "thimble -c" not in text and "starts fresh" not in text
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
    assert list((Path(w["env"]["workspaces_dir"]) / ".archive").glob("demo-one-*"))
    assert (installed / "orient" / "run.json").is_file()
