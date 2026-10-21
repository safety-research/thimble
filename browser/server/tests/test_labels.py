"""Labels (thimble_browser/labels/): the store and what the page reads from it, the units of a scope, regex and code runs,
a prompt run's batches and how many of its calls run at once, the routes, and thimble.labels() in card code."""
import importlib.util

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, prompts
from thimble_browser.app import build
from thimble_browser.cards import sandbox
from thimble_browser.labels import classify, define, run, store


@pytest.fixture
def runs(tmp_path):
    """A made-up folder: two runs' events, a CSV of their outcomes and a text file."""
    d = tmp_path / "files"
    (d / "runs").mkdir(parents=True)
    (d / "runs" / "r1.jsonl").write_text(
        '{"kind": "task", "text": "Fix the parser."}\n{"kind": "message", "text": "The tests are flaky."}\n'
        '{"kind": "end", "outcome": "failed"}\n')
    (d / "runs" / "r2.jsonl").write_text(
        '{"kind": "task", "text": "Add an export."}\n\n{"kind": "message", "text": "My edit broke it."}\n'
        '{"kind": "end", "outcome": "merged"}\n')
    (d / "results.csv").write_text("run,outcome\nr1,failed\nr2,merged\n")
    (d / "notes.md").write_text("# Notes\n\nOne line.\n")
    return d


async def _define(ws, name, kind, text, values, glob=("runs/*.jsonl",), unit="record", **kw):
    k, _ = await define.define(ws, name, kind=kind, text=text, unit=unit, values=values, by="chat:main",
                               glob=list(glob), trial=False, comment=kw.get("comment", False),
                               within=kw.get("within"))
    return k


# ---- the store

# ---- units

# ---- runs

async def test_a_regex_label_marks_what_it_matches(runs):
    ws = home.open_folder(runs)
    # a JSON lines record is read as its values (regextext.py), so the pattern is over "failed", not its key and quotes
    k = await _define(ws, "failed", "regex", r"(?m)^failed$", ["failed", "other"])
    await run.start(ws, runs, k, paths=["runs/*.jsonl"])
    rec = await run.wait(ws, k["id"], 30)
    assert rec["status"] == "done" and rec["total"] == 6 and rec["matches"] == 1
    hit = store.merged(ws, k["id"])["runs/r1.jsonl#L3"]
    assert hit["label"] == "failed" and hit["spans"] == ["failed"]
    assert store.read(ws, k["id"])["applications"][-1]["matches"] == 1


def test_the_kernel_reads_the_store_as_written(runs):
    """kernel_thimble.labels over the labels folder, read in this process."""
    ws = home.open_folder(runs)
    k = store.new_concept("blame", labels=["tests", "itself"])
    store.write(ws, store.colored(ws, k))
    store.append_rows(ws, k["id"], [{"ref": "runs/r1.jsonl#L2", "label": "tests", "confidence": 0.9, "source": "prompt"},
                                    {"ref": "results.csv#row=2", "label": "tests", "confidence": 0.5, "source": "prompt",
                                     "line": 3}])
    store.record_verdict(ws, store.read(ws, k["id"]), "results.csv#row=2", "itself")
    spec = importlib.util.spec_from_file_location("kt", sandbox.RUNNER.with_name("kernel_thimble.py"))
    kt = importlib.util.module_from_spec(spec)
    kt.WS = str(store.root(ws))
    spec.loader.exec_module(kt)
    kt.WS = str(store.root(ws))
    df = kt.labels("blame", negatives=True)
    assert sorted(zip(df["ref"], df["effective"], df["line"])) == [("results.csv#row=2", "itself", 3),
                                                                  ("runs/r1.jsonl#L2", "tests", 2)]


async def test_code_finds_thimble_with_no_import(runs):
    """The prompts say thimble.labels(...) is there in run_python and a card's code, so it needs no import."""
    r = await sandbox.run_code("thimble.labels", runs, timeout=60, unsandboxed=True)
    assert r["status"] == "ok", r["outputs"]
    assert "NameError" not in str(r["outputs"])


# ---- a prompt run: batches, calls at once, one system prompt

# ---- the classifier prompt is the terminal's

def test_the_classifier_prompt_is_the_terminals_with_the_listed_change():
    term = prompts.plugin_read(prompts.prompt_file("labels"))
    concept = {"name": "blame", "description": "Who the agent blames.", "labels": ["tests", "itself"], "comment": True}
    want = term.split("{{RECORDS}}", 1)[0]
    for k, v in {"{{NAME}}": "blame", "{{DEFINITION}}": "Who the agent blames.", "{{VALUES}}": "tests, itself",
                 "{{REASON_FIELD}}": classify.REASON}.items():
        want = want.replace(k, v)
    (old, new), = prompts.manifest()["parts"]["labels"]["replace"]
    want = " ".join(want.split()).replace(" ".join(old.split()), new)
    assert " ".join(classify.system_prompt(concept).split()) == want
    # the records as the terminal's requestFor writes them (plugin/shell/labelreads.mjs)
    assert classify.records_text([" a ", "b"]) == "### record 1\na\n\n### record 2\nb"
    assert "{{" not in classify.system_prompt({**concept, "comment": False})


# ---- the chat's tools and the page's routes

def _signed_in():
    port = 21098
    app, auth, _ = build(port)
    c = TestClient(app, base_url=f"http://127.0.0.1:{port}")
    r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": f"http://127.0.0.1:{port}"})
    key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]
    c.headers.update({"cookie": cookie, "origin": f"http://127.0.0.1:{port}"})
    return c, f"/b/{key}/api"


def test_the_routes_the_page_reads(runs):
    c, api_base = _signed_in()
    ws = home.open_folder(runs)
    r = c.post(f"{api_base}/ws/{ws}/concepts", json={"name": "flaky", "kind": "regex", "spec": "flaky",
                                                     "labels": ["flaky", "not flaky"], "marks": "span",
                                                     "glob": "runs/*.jsonl", "shown": True})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    assert c.post(f"{api_base}/ws/{ws}/concepts", json={"name": "flaky"}).status_code == 409
    r = c.post(f"{api_base}/ws/{ws}/concepts/{cid}/apply", json={"wait": True})
    assert r.status_code == 200 and r.json()["matches"] == 1
    listed = c.get(f"{api_base}/ws/{ws}/concepts").json()
    assert listed[0]["counts"] == {"flaky": 1, "not flaky": 5} and listed[0]["last_run"]["matches"] == 1
    on_file = c.get(f"{api_base}/ws/{ws}/labels", params={"path": "runs/r1.jsonl", "lines": "1-2"}).json()
    assert [row["ref"] for row in on_file[0]["rows"]] == ["runs/r1.jsonl#L1", "runs/r1.jsonl#L2"]
    assert c.post(f"{api_base}/ws/{ws}/labels/refs", json={"refs": ["runs/r2.jsonl#L3"]}).json()[0]["rows"][0]["label"] == "not flaky"
    assert c.get(f"{api_base}/ws/{ws}/labels/presence").json()[0]["paths"]["runs/r1.jsonl"] == {"flaky": 1, "not flaky": 2}
    ruler = c.get(f"{api_base}/ws/{ws}/labels/ruler", params={"path": "runs/r1.jsonl", "bins": 3}).json()
    assert ruler["total"] == 3 and ruler["labels"][0]["bins"]["flaky"] == [1]
    rows = c.get(f"{api_base}/ws/{ws}/concepts/{cid}/rows", params={"value": "flaky", "text": 1}).json()
    assert rows["total"] == 1 and "flaky" in rows["rows"][0]["text"] and rows["rows"][0]["match"] == "flaky"
    v = c.post(f"{api_base}/ws/{ws}/concepts/{cid}/labels", json={"ref": "runs/r2.jsonl#L3", "label": "flaky"}).json()
    assert v["row"]["analyst"] == "flaky"
    cov = c.get(f"{api_base}/ws/{ws}/concepts/{cid}/coverage").json()
    assert cov["n_covered"] == 2 and cov["n_files"] == 4
    assert c.get(f"{api_base}/ws/{ws}/labels/glob", params={"pattern": "runs/*"}).json()["total"] == 2
    put = c.put(f"{api_base}/ws/{ws}/concepts/{cid}", json={"spec": "edit"}).json()
    assert put["version"] == 2
    assert c.put(f"{api_base}/ws/{ws}/filters", json={"scope": "files", "concept": cid, "value": "flaky"}).json()["files"]["value"] == "flaky"
    assert c.delete(f"{api_base}/ws/{ws}/filters/files").json() == {}
    ref = c.get(f"{api_base}/corpora/{ws}/ref", params={"ref": f"concept:{cid}/flaky"}).json()
    assert ref["kind"] == "concept" and ref["meta"]["count"] == 2
    assert c.delete(f"{api_base}/ws/{ws}/concepts/{cid}").json() == {"ok": True}
    assert c.get(f"{api_base}/ws/{ws}/concepts").json() == []
