"""An extension can run any of thimble's seven tasks with its own program (tasks.py, harness.py), as it can a role: an
Agent SDK program or any command gets the task's input and returns the object thimble's own implementation returns,
which it can call as thimble.default(input). One extension that replaces a task runs it; two leave it thimble's. A
program's output is checked before thimble uses it, and a program runs in its task's box, which never reads
server.json. The example in docs/examples/vote-labels runs end to end with the model calls faked. An extension whose
program runs the orientation is offered Run now where an orientation ran, which runs it again with the cards as they
stand."""
from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path

import pytest

from app import agents, checks, concepts, config, extensions, harness, kernel_wrap, model, notebook, orientation, \
    tasks, tools, userconf

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = REPO / "docs" / "examples" / "vote-labels"
CORPUS = "mini"


def _config(data: dict) -> None:
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def _extension(root: Path, name: str, specs: dict[str, dict], files: dict[str, str] | None = None) -> Path:
    """An extension folder whose `specs` are {"tasks/<task>" or "agents/<role>": its task.json or agent.json}."""
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "extension.json").write_text(json.dumps({"name": name, "version": "0.1.0"}))
    for where, spec in specs.items():
        (folder / where).mkdir(parents=True)
        (folder / where / ("task.json" if where.startswith("tasks/") else "agent.json")).write_text(json.dumps(spec))
    for rel, text in (files or {}).items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text)
    return folder


def _program(root: Path, name: str, task: str, code: str) -> Path:
    return _extension(root, name, {f"tasks/{task}": {"description": "Mine.", "command": ["python", "p.py"]}},
                      {f"tasks/{task}/p.py": code})


@pytest.fixture()
def active(monkeypatch):
    """The extensions active in every workspace, set by the test: a list of their folders."""
    folders: list[Path] = []
    monkeypatch.setattr(extensions, "active", lambda c: [
        {"name": f.name, "src": str(f), "dir": str(f), "files": [], "active": True} for f in folders])
    return folders


@pytest.fixture()
def unboxed(monkeypatch):
    """No sandbox for programs, as on a machine without bubblewrap whose config allows that."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, package: False)
    _config({"sandbox": {"enforce": False}})


async def _until(check, timeout: float = 60.0, what: str = "the condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        got = check()
        if got:
            return got
        await asyncio.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


CONCEPT = {"name": "tone", "unit": "record", "kind": "prompt", "spec": "Is the message friendly?", "description": "",
           "labels": ["friendly", "curt"], "marks": None}
ITEMS = [("runs/r1.jsonl#L1", "Thanks so much!"), ("runs/r1.jsonl#L2", "Do it now."), ("runs/r1.jsonl#L3", "Sure.")]


# --------------------------------------------------------------------------- who runs a task


def test_a_task_is_thimble_s_own_until_one_extension_replaces_it_and_two_leave_it_thimble_s(tmp_path, workspaces_tmp,
                                                                                            active):
    assert tasks.program(CORPUS, "labels") is None
    assert {r["task"]: r["way"] for r in tasks.public(CORPUS)} == dict.fromkeys(tasks.TASKS, "thimble")
    active.append(_program(tmp_path, "vote", "labels", "print('unused')\n"))
    active.append(_extension(tmp_path, "careful", {"tasks/labels": {"description": "Careful.", "prompt": "p.md"}},
                             {"tasks/labels/p.md": "Read each item twice."}))
    got = tasks.program(CORPUS, "labels")
    assert got is not None and got.extension == "vote" and got.way == "command"
    row = next(r for r in tasks.public(CORPUS) if r["task"] == "labels")
    assert (row["way"], row["extension"], row["additions"], row["conflict"]) == ("command", "vote", ["careful"], [])
    assert "Read each item twice." in (tasks.text_of(CORPUS, "labels") or ""), "thimble's own keeps the additions"
    active.append(_extension(tmp_path, "mine", {"tasks/labels": {"description": "Mine.", "prompt": "m.md",
                                                                 "replace": True}},
                             {"tasks/labels/m.md": "Only my words."}))
    assert tasks.program(CORPUS, "labels") is None, "two replacements leave thimble's own"
    row = next(r for r in tasks.public(CORPUS) if r["task"] == "labels")
    assert row["way"] == "thimble" and row["conflict"] == ["vote", "mine"]
    assert "Only my words." not in (tasks.text_of(CORPUS, "labels") or "")


def test_settings_show_the_tasks_rows(tmp_path, workspaces_tmp, active):
    from app import ledger

    active.append(_program(tmp_path, "vote", "view-fit", "print('unused')\n"))
    rows = {r["task"]: r for r in ledger.with_features({}, CORPUS)["tasks"]}
    assert list(rows) == list(tasks.TASKS)
    assert rows["view-fit"]["way"] == "command" and rows["view-fit"]["extension"] == "vote"
    assert rows["labels"]["way"] == "thimble"


# --------------------------------------------------------------------------- the example


def test_the_example_vote_labels_program_runs_the_labels_task_once_per_model(tmp_path, data_tmp, workspaces_tmp,
                                                                            active, unboxed, monkeypatch):
    """docs/examples/vote-labels: thimble's own labels task runs once per model through thimble.default, and each item
    takes the value most models gave it, with the share that gave it as its confidence."""
    assert extensions.read_extension(EXAMPLE)["problems"] == []
    votes = {"opus": ["friendly", "curt", "friendly"], "sonnet": ["friendly", "friendly", "curt"],
             "haiku": ["curt", "curt", "friendly"]}
    asked: list[tuple[str | None, list[str]]] = []

    async def own(c, inp, *, model=None, on_retry=None):
        asked.append((model, [it["text"] for it in inp["items"]]))
        return model_result({"labels": [{"i": it["i"], "label": votes[model][it["i"] - 1], "confidence": 0.9,
                                         "rationale": f"{model} says so"} for it in inp["items"]]})

    monkeypatch.setattr(concepts, "labels_task", own)
    shutil.copytree(EXAMPLE, tmp_path / "vote-labels")
    active.append(tmp_path / "vote-labels")
    res = asyncio.run(concepts.classify_structured(CORPUS, CONCEPT, ITEMS))
    assert res.status == "ok", res.detail
    assert sorted(m for m, _ in asked) == ["haiku", "opus", "sonnet"]
    assert all(texts == [t for _, t in ITEMS] for _, texts in asked)
    got = concepts.parse_labels(res.output, CONCEPT, len(ITEMS))
    assert [got[i]["label"] for i in (1, 2, 3)] == ["friendly", "curt", "friendly"]
    assert [round(got[i]["confidence"], 2) for i in (1, 2, 3)] == [0.67, 0.67, 0.67]
    assert got[1]["rationale"] in ("opus says so", "sonnet says so")


# --------------------------------------------------------------------------- the contract


PROBE = '''import json, os, sys, thimble
def run(input):
    kind = input.get("kind")
    if kind == "env":
        return {"labels": [{"i": 1, "label": os.environ["THIMBLE_TASK"] + "/" + os.environ["THIMBLE_ROLE"],
                            "confidence": 1}]}
    if kind == "bad":
        return {"labels": "every one friendly"}
    if kind == "fail":
        print("the vote could not start", file=sys.stderr)
        sys.exit(2)
    if kind == "tool":
        got = thimble.request("tool", {"name": "add_card", "args": {}})
    return {"labels": []}
thimble.serve(run)
'''


async def test_a_task_program_s_output_is_checked_and_a_failing_one_fails_the_call(tmp_path, data_tmp, workspaces_tmp,
                                                                                  active, unboxed):
    active.append(_program(tmp_path, "probe", "labels", PROBE))
    schema = concepts.labels_tool(concepts.label_input(CONCEPT, ITEMS)["label"]).input_schema
    ok = await tasks.call(CORPUS, "labels", {"kind": "env"}, schema=schema)
    assert ok.status == "ok" and ok.output["labels"][0]["label"] == "labels/", ok.detail
    bad = await tasks.call(CORPUS, "labels", {"kind": "bad"}, schema=schema)
    assert bad.status == "error" and "cannot use" in bad.detail and "labels" in bad.detail
    failed = await tasks.call(CORPUS, "labels", {"kind": "fail"}, schema=schema)
    assert failed.status == "error" and "code 2" in failed.detail and "could not start" in failed.detail
    refused = await tasks.call(CORPUS, "labels", {"kind": "tool"}, schema=schema)
    assert refused.status == "error" and "add_card is not one of" in refused.detail
    work = config.workspace_dir(CORPUS).joinpath(*harness.TASK_WORK)
    assert not work.is_dir() or not any(work.iterdir()), "each run's work folder goes when it ends"


DEFAULT = '''import thimble
def run(input):
    thimble.log("asking thimble's own")
    return thimble.default(input)
thimble.serve(run)
'''

OUTPUTS = {"labels": {"labels": [{"i": 1, "label": "friendly", "confidence": 0.8, "rationale": "warm"}]},
           "label": {"name": "Curt", "scope": "files", "kind": "prompt", "text": "Is it curt?",
                     "values": ["curt", "not curt"], "marks": "span"},
           "critique": {"assessment": [{"problem": ""}] * 5, "question": "Q?", "code": "", "takeaway": "T."},
           "findings": {"problems": ["The legend covers the chart."]},
           "decision": {"fits": True, "reason": "Each record is a post."},
           "proposal": {"help": False, "name": "", "why": "", "arrangement": ""}}


async def test_every_task_s_own_implementation_takes_its_input_from_a_program(tmp_path, data_tmp, workspaces_tmp, active,
                                                                             unboxed, monkeypatch):
    """thimble.default(input) runs thimble's own implementation on the input the program got, so each task's input
    carries all its implementation reads."""
    from app import card_check

    seen: dict[str, str] = {}

    async def structured(prompt, *, tool, model, system_append="", images=(), **k):
        seen[tool.name] = f"{system_append}\n{prompt}\n{len(images)} images"
        return model_result(OUTPUTS[tool.name])

    monkeypatch.setattr(model, "structured", structured)
    monkeypatch.setattr(card_check, "fit_image", lambda b: b)
    picture = tmp_path / "shot.png"
    picture.write_bytes(b"png")
    inputs = {
        "labels": concepts.label_input(CONCEPT, ITEMS[:1]),
        "label-draft": {"description": "messages that sound curt", "paths": ["runs/*.jsonl"],
                        "records": {"paths": "runs/r1.jsonl", "path": "runs/r1.jsonl", "cut": "700",
                                    "lines": "Do it now."}},
        "card-check": {"card": {"id": "c1", "kind": "code", "question": "How many curt replies?", "takeaway": "Two.",
                                "citations": "", "code": "print(2)", "context": "", "typed": "", "kept": ""},
                       "picture": str(picture), "effort": "low"},
        "view-review": {"view": {"slug": "board", "name": "Board", "description": "The posts by thread.",
                                 "claims": ["board.jsonl"], "spec": "Unit: a post", "checks": []},
                        "pictures": [{"path": str(picture), "about": "the view as it opens, 840 px wide"}],
                        "controls": ["Day"], "records": "", "ask": False},
        "view-fit": {"view": {"name": "Board", "description": "The posts by thread."}, "files": "board.jsonl",
                     "samples": "board.jsonl\n  line 1: a post"},
        "file-viewer": {"path": "a.cast", "size": "2.0 KB", "count": "3", "suffix": ".cast",
                        "what": "its first 2 lines", "head": "{\"version\": 2}"},
    }
    marks = {"labels": "Thanks so much!", "label": "messages that sound curt", "critique": "How many curt replies?",
             "findings": "the view as it opens, 840 px wide", "decision": "The posts by thread.", "proposal": "a.cast"}
    names = {"labels": "labels", "label-draft": "label", "card-check": "critique", "view-review": "findings",
             "view-fit": "decision", "file-viewer": "proposal"}
    for task, inp in inputs.items():
        active[:] = [_program(tmp_path / task, "own", task, DEFAULT)]
        res = await tasks.call(CORPUS, task, inp)
        assert res.status == "ok", (task, res.detail)
        tool = names[task]
        assert res.output == OUTPUTS[tool], task
        assert marks[tool] in seen[tool], (task, seen[tool][-400:])
    assert seen["critique"].endswith("1 images") and seen["findings"].endswith("1 images")


def model_result(output: dict) -> model.CallResult:
    return model.CallResult(status="ok", output=output, model_requested="m")


@pytest.mark.skipif(not kernel_wrap.srt_works(*(lambda s: (s.node(), s.package(config.REPO_ROOT)))(
    __import__("app.srt", fromlist=["srt"]))), reason="Anthropic's sandbox runtime can't run here")
async def test_a_task_program_s_box_hides_server_json_and_keeps_the_corpus_read_only(tmp_path, data_tmp,
                                                                                      workspaces_tmp, active,
                                                                                      monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    secret = userconf.global_file().parent / "server.json"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text('{"token": "not-for-agents"}')
    probe = '''import os, thimble
def run(input):
    out = {}
    for name, path in (("secret", input["secret"]), ("corpus", os.path.join(os.environ["THIMBLE_CORPUS"], "x.txt")),
                       ("work", os.path.join(os.environ["THIMBLE_WORK"], "x.txt"))):
        try:
            if name == "secret":
                open(path).read()
            else:
                open(path, "w").write("x")
            out[name] = "ok"
        except OSError as e:
            out[name] = type(e).__name__
    return out
thimble.serve(run)
'''
    _config({"sandbox": {"enforce": False}})
    active.append(_program(tmp_path, "probe", "view-fit", probe))
    res = await tasks.call(CORPUS, "view-fit", {"secret": str(secret)})
    assert res.status == "ok", res.detail
    assert res.output["secret"] == "PermissionError" and res.output["corpus"] != "ok" and res.output["work"] == "ok"
    assert not (config.corpus_dir(CORPUS) / "x.txt").exists()


# --------------------------------------------------------------------------- the checks task


CHECKER = '''import thimble
async def run(input):
    first = input["passages"][0]
    await thimble.tool("add_comment", {"ref": first["ref"], "text": "Which source says so? (" + input["check"]["name"] + ")"})
    return "Left 1 comment on " + input["doc"] + "."
thimble.serve(run)
'''


async def test_a_checks_program_comments_as_its_run_and_what_it_returns_is_the_summary(tmp_path, data_tmp,
                                                                                      workspaces_tmp, active, unboxed):
    from app import investigation, report_types

    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# Runs\n\n## Counts\n\nThree runs ended.\n"},
                         actor="analyst")
    assert not r.is_error, r.text
    active.append(_extension(tmp_path, "checker", {"tasks/checks": {"description": "Mine.", "command": ["python", "c.py"]}},
                             {"tasks/checks/c.py": CHECKER}))
    rec = await checks.start_run(CORPUS, "judgment", "report", force=True)
    assert rec is not None
    done = await _until(lambda: (x := ((checks.read(CORPUS, "judgment") or {}).get("runs") or {}).get("report"))
                        and x.get("status") != "running" and x, what="the check's run to end")
    assert done["status"] == "done" and done["summary"] == "Left 1 comment on report." and done["comments"] == 1, done
    doc = report_types.read_doc(CORPUS, investigation.MAIN, "report")
    [comment] = [cm for cm in doc.get("comments") or [] if cm.get("check") == "judgment"]
    assert comment["text"].startswith("Which source says so?") and comment["run"] == done["run"]
    meta = agents.meta_or_none(CORPUS, done["chat"])
    assert meta is not None and meta["role"] == checks.ROLE and meta["way"] == "command"


# --------------------------------------------------------------------------- Run now for an orientation program


AGAIN = '''import thimble
async def run(input):
    assert input["follow_up"] is True and input["request"] == "count the runs", input
    seen = "What does the corpus hold?" in input["cards"]
    await thimble.tool("add_card", {"question": "What did the second look add?", "kind": "note",
                                    "text": "One more run.", "takeaway": "One more run."})
    return "Added to the earlier cards." if seen else "Saw no earlier cards."
thimble.serve(run)
'''


async def test_run_now_runs_an_orientation_program_again_with_the_cards_as_they_stand(tmp_path, data_tmp, workspaces_tmp,
                                                                                     unboxed, analyst):
    """Switched on where an orientation already ran, an extension whose program runs the orientation is offered Run
    now; Run now runs the program as a follow-up with the earlier request and the cards, so it adds to them, and the
    offer goes."""
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, announce=False, brief="count the runs")["id"]
    orientation.started(CORPUS, chat, passes=["final"])
    made = await tools.call(CORPUS, "add_card", {"question": "What does the corpus hold?", "kind": "note",
                                                  "text": "Three runs.", "takeaway": "Three runs."}, session="orient")
    assert not made.is_error, made.text
    orientation.finished(CORPUS, chat, "done", "Three runs.", report=False)
    agents.finish_agent(CORPUS, chat, "done", "Three runs.")
    folder = _extension(tmp_path, "again", {"agents/orientation": {"description": "Looks again.",
                                                                  "command": ["python", "o.py"]}},
                        {"agents/orientation/o.py": AGAIN})
    assert extensions.add(str(folder), yes=True, say=lambda _: None) == ["again"]
    await extensions.refresh(CORPUS)
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "again")
    assert row["orients"] and row["offer"] and extensions.offered(CORPUS) == ["again"]
    got = await extensions.orientation_route(CORPUS, "again", extensions.OrientBody(run=True), analyst)
    assert got["status"] == "resumed"
    rec = await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("status") in ("done", "failed")
                       and r["chats"][orientation.ROLE] != chat and r, what="the program to end")
    assert rec["status"] == "done" and rec["program"] == "again", rec
    assert orientation.summary(CORPUS).strip() == "Added to the earlier cards."
    ws = config.workspace_dir(CORPUS)
    titles = [c.get("title") for nb in notebook.list_notebooks(ws)
              for c in (notebook.read_notebook(ws, nb["id"]) or {}).get("cells") or []]
    assert "What does the corpus hold?" in titles and "What did the second look add?" in titles
    assert extensions.offered(CORPUS) == []
