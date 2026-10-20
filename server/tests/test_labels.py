"""Labels (thimble_browser/labels/): the store and what the page reads from it, the units of a scope, regex and code runs,
a prompt run's batches and how many of its calls run at once, the routes, and thimble.labels() in card code."""
import asyncio
import importlib.util
import json

import pytest
from fastapi.testclient import TestClient

from thimble_browser import canvas, home, prompts, tools
from thimble_browser.app import build
from thimble_browser.cards import sandbox
from thimble_browser.labels import api, chat, classify, define, run, store, units


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


@pytest.fixture(autouse=True)
def code_runs_somewhere():
    run.SETTINGS["unsandboxed"] = sandbox.available() is None
    yield
    run.SETTINGS["unsandboxed"] = False


async def _define(ws, name, kind, text, values, glob=("runs/*.jsonl",), unit="record", **kw):
    k, _ = await define.define(ws, name, kind=kind, text=text, unit=unit, values=values, by="chat:main",
                               glob=list(glob), trial=False, comment=kw.get("comment", False),
                               within=kw.get("within"))
    return k


# ---- the store

def test_values_get_colors_and_a_negative_value_the_gray(runs):
    ws = home.open_folder(runs)
    a = store.new_concept("first", labels=["yes", "no"])
    store.write(ws, store.colored(ws, a))
    b = store.new_concept("second", labels=["tests", "itself", "neither"])
    store.write(ws, store.colored(ws, b))
    got = {k["name"]: [(c["name"], c["color"]) for c in k["classes"]] for k in store.listing(ws)}
    assert got["first"] == [("yes", 1), ("no", 0)]
    assert got["second"][0][1] not in (0, 1) and got["second"][2] == ("neither", 0)
    assert store.find(ws, "FIRST ")["id"] == a["id"] and store.find(ws, f"concept:{b['id']}")["name"] == "second"


def test_the_last_row_counts_and_the_analysts_value_overrides(runs):
    ws = home.open_folder(runs)
    k = store.new_concept("blame", labels=["tests", "itself"])
    store.write(ws, k)
    store.append_rows(ws, k["id"], [
        {"ref": "runs/r1.jsonl#L2", "label": "itself", "confidence": 0.4, "source": "prompt"},
        {"ref": "runs/r1.jsonl#L2", "label": "tests", "confidence": 0.9, "source": "prompt"},
        {"ref": "runs/r2.jsonl#L3", "label": "tests", "confidence": 0.7, "source": "prompt"},
        {"ref": "results.csv#row=2", "label": "itself", "confidence": 0.7, "source": "prompt", "line": 3}])
    store.record_verdict(ws, k, "runs/r2.jsonl#L3", "itself")
    assert store.stats(ws, k["id"]) == {"n_labeled": 3, "n_reviewed": 1, "n_marked": 1,
                                        "counts": {"tests": 2, "itself": 1}}
    assert store.effective_counts(ws, k["id"]) == ({"tests": 1, "itself": 2}, 1)
    assert [r["ref"] for r in store.rows_on(ws, k["id"], "runs/r1.jsonl", [(1, 5)])] == ["runs/r1.jsonl#L2"]
    assert store.rows_on(ws, k["id"], "runs/r1.jsonl", [(3, 9)]) == []
    assert store.rows_on(ws, k["id"], "results.csv", [(3, 3)])[0]["line"] == 3
    assert store.presence(ws, k["id"]) == {"runs/r1.jsonl": {"tests": 1}, "runs/r2.jsonl": {"itself": 1},
                                           "results.csv": {"itself": 1}}
    assert store.ruler(ws, k["id"], "runs/r1.jsonl", 4, 2) == {"tests": {0: 1}}
    with pytest.raises(store.LabelError):
        store.record_verdict(ws, store.read(ws, k["id"]), "runs/r1.jsonl#L2", "maybe")


def test_a_files_filter_turns_its_label_on_with_its_value_alone_highlighted(runs):
    ws = home.open_folder(runs)
    k = store.new_concept("blame", labels=["tests", "itself", "neither"])
    store.write(ws, store.colored(ws, k))
    store.set_filter(ws, "files", k["id"], "itself")
    on = store.read(ws, k["id"])
    assert on["shown"] and [c["highlight"] for c in on["classes"]] == [False, True, False]
    assert store.read_filters(ws) == {"files": {"concept": k["id"], "value": "itself"}}
    store.set_card_filter(ws, {"kinds": ["table"], "starred": True})
    store.clear_filter(ws, "files")
    assert not store.read(ws, k["id"])["shown"]
    assert store.read_filters(ws) == {"canvas": {"kinds": ["table"], "starred": True}}


# ---- units

def test_the_units_of_files(runs):
    got = units.units_of("x", runs, "record", ["runs/*.jsonl", "results.csv"])
    refs = [u.ref for u in got]
    assert refs[:3] == ["runs/r1.jsonl#L1", "runs/r1.jsonl#L2", "runs/r1.jsonl#L3"]
    assert "runs/r2.jsonl#L2" not in refs  # a blank line is no record
    row = next(u for u in got if u.ref == "results.csv#row=2")
    assert row.line == 3 and row.value == {"run": "r2", "outcome": "merged"} and row.text == "run: r2\noutcome: merged"
    assert got[1].value == {"kind": "message", "text": "The tests are flaky."}
    files = units.units_of("x", runs, "agent", ["runs"])
    assert [u.ref for u in files] == ["runs/r1.jsonl", "runs/r2.jsonl"] and len(files[0].value["records"]) == 3
    assert units.match_paths(runs, ["*"]) == units.match_paths(runs, ["**/*"])
    assert [u.ref for u in units.sample(got, 3)] == ["runs/r1.jsonl#L1", "runs/r2.jsonl#L1", "results.csv#row=1"]


# ---- runs

async def test_a_regex_label_marks_what_it_matches(runs):
    ws = home.open_folder(runs)
    k = await _define(ws, "failed", "regex", r'"outcome": "failed"', ["failed", "other"])
    await run.start(ws, runs, k, paths=["runs/*.jsonl"])
    rec = await run.wait(ws, k["id"], 30)
    assert rec["status"] == "done" and rec["total"] == 6 and rec["matches"] == 1
    hit = store.merged(ws, k["id"])["runs/r1.jsonl#L3"]
    assert hit["label"] == "failed" and hit["spans"] == ['"outcome": "failed"']
    assert store.read(ws, k["id"])["applications"][-1]["matches"] == 1


async def test_a_code_label_runs_in_the_sandbox_and_says_what_failed(runs):
    ws = home.open_folder(runs)
    code = "def label(unit):\n    if unit['kind'] == 'task':\n        raise ValueError('no')\n    return unit['kind'] == 'end', 0.9\n"
    k = await _define(ws, "end", "code", code, ["end", "other"])
    await run.start(ws, runs, k, paths=["runs/*.jsonl"])
    rec = await run.wait(ws, k["id"], 60)
    assert rec["status"] == "done", rec
    assert rec["labeled"] == 4 and rec["failed"] == 2 and rec["matches"] == 2
    assert "ValueError: no (line 3)" in rec["message"]
    assert store.merged(ws, k["id"])["runs/r2.jsonl#L4"]["label"] == "end"
    broken = await _define(ws, "broken", "code", "def label(unit):\n    return (\n", ["a", "b"])
    await run.start(ws, runs, broken, paths=["runs/*.jsonl"])
    rec = await run.wait(ws, broken["id"], 60)
    assert rec["status"] == "error" and "SyntaxError" in rec["message"]


async def test_card_code_reads_a_labels_rows(runs):
    ws = home.open_folder(runs)
    k = await _define(ws, "flaky", "regex", "flaky", ["flaky", "not flaky"])
    await run.start(ws, runs, k, paths=["runs/*.jsonl"])
    await run.wait(ws, k["id"], 30)
    code = ('import thimble\ndf = thimble.labels("flaky")\nprint(list(df["ref"]), list(df["effective"]))\n'
            'print(len(thimble.labels("flaky", negatives=True)))')
    res = await canvas.run_code(ws, code, runs, timeout=60, unsandboxed=run.SETTINGS["unsandboxed"])
    out = "".join(o.get("text/plain", "") for o in res["outputs"])
    assert res["status"] == "ok", res
    assert "['runs/r1.jsonl#L2'] ['flaky']" in out and "\n6" in out


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


# ---- a prompt run: batches, calls at once, one system prompt

async def test_a_prompt_label_reads_in_batches_many_at_once(runs, monkeypatch):
    ws = home.open_folder(runs)
    many = runs / "many.jsonl"
    many.write_text("".join(json.dumps({"n": i, "text": "tests" if i % 3 else "mine"}) + "\n" for i in range(1, 501)))
    k = await _define(ws, "blame", "prompt", "Who the agent blames.", ["tests", "itself"], glob=["many.jsonl"])
    systems, sizes = set(), []
    live = peak = 0

    async def fake_call(concept, system, user, rec):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        systems.add(system)
        n = user.count("### record ")
        sizes.append(n)
        first = len(sizes) == 1
        await asyncio.sleep(0.05)
        live -= 1
        entries = [{"i": i, "value": "tests" if i % 2 else "itself", "confidence": 0.8} for i in range(1, n + 1)]
        if first:
            entries = entries[:-1]  # one record left without a value
        return json.dumps({"records": entries})

    monkeypatch.setattr(run, "_call", fake_call)
    await run.start(ws, runs, k, paths=["many.jsonl"])
    rec = await run.wait(ws, k["id"], 30)
    assert rec["status"] == "done" and rec["total"] == 500
    assert sizes == [classify.BATCH_ITEMS] * 10
    assert 1 < peak <= run.CONCURRENCY
    assert len(systems) == 1
    assert rec["labeled"] == 499 and rec["failed"] == 1 and "no value" in rec["message"]


async def test_stopping_a_run_keeps_what_it_labeled(runs, monkeypatch):
    ws = home.open_folder(runs)
    many = runs / "many.jsonl"
    many.write_text("".join(json.dumps({"n": i}) + "\n" for i in range(1, 1001)))
    k = await _define(ws, "slow", "prompt", "Anything.", ["yes", "no"], glob=["many.jsonl"])
    calls = 0

    async def slow_call(concept, system, user, rec):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.02 if calls <= run.CONCURRENCY else 30)
        n = user.count("### record ")
        return json.dumps({"records": [{"i": i, "value": "yes", "confidence": 1} for i in range(1, n + 1)]})

    monkeypatch.setattr(run, "_call", slow_call)
    await run.start(ws, runs, k, paths=["many.jsonl"])
    await asyncio.sleep(0.5)
    assert await run.cancel(ws, k["id"])
    rec = run.record(ws, k["id"])
    assert rec["stopped"] and rec["status"] == "done" and "stopped after" in rec["message"]
    assert store.stats(ws, k["id"])["n_labeled"] == rec["labeled"] == run.CONCURRENCY * classify.BATCH_ITEMS


def test_answers_take_near_misses_and_say_what_is_missing():
    got, failed = classify.answers('{"records": [{"i": 1, "value": "Tests", "confidence": 2}, {"i": 3, "value": "x", '
                                   '"confidence": 0.5}]}', 3, ["tests", "itself"])
    assert got == {0: {"value": "tests", "confidence": 1.0}}
    assert failed[1] == "the reply gave this record no value" and "not one of" in failed[2]
    assert classify.answers("no json here", 2, ["a", "b"])[1] == {0: "the reply held no JSON of values",
                                                                 1: "the reply held no JSON of values"}


# ---- the classifier prompt is the terminal's

def test_the_classifier_prompt_is_the_terminals_with_the_listed_change():
    term = prompts.read("terminal/labels/v2.md")
    concept = {"name": "blame", "description": "Who the agent blames.", "labels": ["tests", "itself"], "comment": True}
    want = term.split("{{RECORDS}}", 1)[0]
    for k, v in {"{{NAME}}": "blame", "{{DEFINITION}}": "Who the agent blames.", "{{VALUES}}": "tests, itself",
                 "{{REASON_FIELD}}": classify.REASON}.items():
        want = want.replace(k, v)
    (old, new), = prompts.manifest()["parts"]["labels"]["replace"]
    want = " ".join(want.split()).replace(" ".join(old.split()), new)
    assert " ".join(classify.system_prompt(concept).split()) == want
    # the records as the terminal's requestFor writes them (lean/verbs/label/calls.mjs)
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


async def test_apply_label_makes_the_card_and_answers_the_counts(runs, monkeypatch):
    monkeypatch.setitem(tools.REF_RESOLVERS, "concept:", define.resolve_ref)  # as the feature's register() does
    ws = home.open_folder(runs)
    t = tools.Tools(ws, "main", runs)
    seen = []
    t.on_card = seen.append
    got = await chat.apply_label(t, {"scope": "files", "name": "failed end", "question": "Which runs failed?",
                                     "predicate": {"kind": "regex", "text": "failed"}, "values": ["failed", "other"],
                                     "paths": ["runs/*.jsonl"], "filter": True})
    assert not got.is_error, got.text
    k = store.find(ws, "failed end")
    assert f"failed [1](concept:{k['id']}/failed), other [5](concept:{k['id']}/other)" in got.text
    (_, card), = store.label_cards(ws, k["id"])
    assert card["title"] == "Which runs failed?" and got.extra == {"label_card": card["id"]} and seen == [card["id"]]
    assert store.read_filters(ws)["files"] == {"concept": k["id"], "value": "failed"}
    again = await chat.apply_label(t, {"scope": "files", "name": "failed end", "predicate": {"kind": "regex", "text": "failed"},
                                       "values": ["failed", "other"], "paths": ["runs/*.jsonl"]})
    assert "nothing ran again" in again.text
    other = await chat.apply_label(t, {"scope": "canvas", "name": "failed end", "predicate": {"kind": "regex", "text": "x"}})
    assert other.is_error
    assert define.resolve_ref(ws, f"concept:{k['id']}/failed")["meta"]["count"] == 1
    assert (await t.call("read_ref", {"ref": f"concept:{k['id']}"})).text.startswith(f"concept:{k['id']} (concept)")
    assert (await chat.delete_label(t, {"name": "failed end"})).text.startswith("The label failed end is deleted")
    assert store.label_cards(ws, k["id"]) == [] and store.read_filters(ws) == {}


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


async def test_the_chats_stop_stops_the_label_it_waits_on(runs, monkeypatch):
    ws = home.open_folder(runs)
    (runs / "many.jsonl").write_text("".join(json.dumps({"n": i}) + "\n" for i in range(1, 301)))

    async def slow_call(concept, system, user, rec):
        await asyncio.sleep(30)

    monkeypatch.setattr(run, "_call", slow_call)
    t = tools.Tools(ws, "main", runs)
    call = asyncio.create_task(chat.apply_label(t, {"scope": "files", "name": "slow", "paths": ["many.jsonl"],
                                                    "predicate": {"kind": "prompt", "text": "Anything."}}))
    await asyncio.sleep(0.5)
    k = store.find(ws, "slow")
    assert run.running(ws, k["id"])
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert not run.running(ws, k["id"]) and run.record(ws, k["id"])["stopped"]


async def test_a_run_over_other_files_keeps_the_rows_it_does_not_cover(runs):
    ws = home.open_folder(runs)
    k = await _define(ws, "task", "regex", '"kind": "task"', ["task", "other"], glob=["runs/r1.jsonl"])
    await run.start(ws, runs, k, paths=["runs/r1.jsonl"])
    await run.wait(ws, k["id"], 30)
    k = await _define(ws, "task", "regex", '"kind": "task"', ["task", "other"], glob=["runs/r2.jsonl"])
    assert k["glob"] == "runs/r1.jsonl, runs/r2.jsonl"
    await run.start(ws, runs, k, paths=["runs/r2.jsonl"])
    await run.wait(ws, k["id"], 30)
    assert store.stats(ws, k["id"])["counts"] == {"task": 2, "other": 4}
    k = await _define(ws, "task", "regex", '"kind": "end"', ["task", "other"], glob=["runs/r2.jsonl"])
    await run.start(ws, runs, k, paths=["runs/r2.jsonl"])
    await run.wait(ws, k["id"], 30)
    assert store.stats(ws, k["id"])["n_labeled"] == 3  # a new definition starts its rows anew
