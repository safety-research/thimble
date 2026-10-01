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
import sys
import time
from pathlib import Path

import pytest

from app import agent_session, agents, checks, concepts, config, extensions, harness, kernel_wrap, model, notebook, \
    orientation, tasks, tools, userconf

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = REPO / "docs" / "examples" / "vote-labels"
FAKE = Path(__file__).parent / "fixtures" / "agents" / "fake_sdk_claude.py"
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


@pytest.mark.parametrize("agent,task", [("labels", "labels"), ("cardCheck", "card-check")])
def test_the_config_can_give_a_task_program_the_network_corpus_edits_and_variables(tmp_path, workspaces_tmp, active,
                                                                                   unboxed, monkeypatch, agent, task):
    """labels and cardCheck take `network`, `data` and `env` for a program of their tasks, with the other agents'
    defaults: the network on, and corpus edits off, since a task's program has no thread to ask in. The config can
    turn the network off, allow corpus edits and pass a variable of the server."""
    active.append(_program(tmp_path, "mine", task, "print('unused')\n"))
    [part] = tasks.code_parts(CORPUS, task)
    corpus = str(Path(config.corpus_dir(CORPUS)).resolve())

    def prepared() -> tuple[dict, dict]:
        run, _argv = harness._prepare(harness.task_job(CORPUS, task, {}), part)
        return harness.box_rules(run), harness.program_env(run)

    monkeypatch.setenv("MY_HARNESS_KEY", "k-1")
    box, env = prepared()
    assert "network" not in box and corpus not in box["filesystem"]["allowWrite"]
    assert env["THIMBLE_NETWORK"] == "on" and "MY_HARNESS_KEY" not in env
    _config({"sandbox": {"enforce": False},
             "agents": {agent: {"network": "off", "data": "allow", "env": ["MY_HARNESS_KEY"]}}})
    box, env = prepared()
    assert box["network"] == {"allowedDomains": [], "deniedDomains": []} and corpus in box["filesystem"]["allowWrite"]
    assert env["THIMBLE_NETWORK"] == "off" and env["MY_HARNESS_KEY"] == "k-1"
    _config({"agents": {agent: {"web": "allow"}}})
    assert f"agents.{agent}.web is not a setting" in userconf.problem()


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
    kind = input.get("kind") or ("fail" if "description" in input else "")
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
    active[:] = [_program(tmp_path / "draft", "probe", "label-draft", PROBE)]
    with pytest.raises(concepts.HTTPException) as got:
        await concepts.draft_route(CORPUS, concepts.DraftBody(text="curt messages", paths=["*.jsonl"]))
    assert got.value.detail.startswith("probe's label-draft program gave no label: "), got.value.detail


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
    picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
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


SESSION = '''import thimble
async def run(input):
    await thimble.session("Read the items.")
    return {"labels": []}
thimble.serve(run)
'''


async def test_a_task_program_s_sessions_refuse_what_they_would_ask_since_nobody_can_answer(
        tmp_path, data_tmp, workspaces_tmp, active, unboxed, monkeypatch):
    """A task's program has no thread, so its sessions are refused what they would ask: corpus edits, the web and
    installs, and any other request is denied with a line that says why, not one about an ended session."""
    log_file = tmp_path / "claude.log"
    fake = tmp_path / "claude"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    fake.chmod(0o755)
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(fake))
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log_file))
    active.append(_program(tmp_path, "asker", "labels", SESSION))
    res = await tasks.call(CORPUS, "labels", {"items": []})
    assert res.status == "ok", res.detail
    [start] = [json.loads(line) for line in log_file.read_text().splitlines()]
    argv = start["argv"]
    settings = json.loads(argv[argv.index("--settings") + 1])
    corpus = Path(userconf.session(CORPUS, "labels", sandbox=False).corpus() or config.corpus_dir(CORPUS))
    assert f"Edit(/{corpus}/**)" in settings["permissions"]["deny"]
    asked = settings["permissions"].get("ask") or []
    assert not any(str(corpus) in r or r.startswith("Bash(") or r.startswith("Web") for r in asked), asked
    assert {"WebFetch", "WebSearch"} <= set(argv[argv.index("--disallowedTools") + 1].split(","))
    key = start["session"]
    assert key.startswith("task:labels:")
    agent_session.unanswered(CORPUS, key, True)
    try:
        got = await agent_session.ask(CORPUS, key, "Bash", {"command": "ls"})
    finally:
        agent_session.unanswered(CORPUS, key, False)
    assert got == {"behavior": "deny", "message": agent_session.NO_ONE_LINE}
    assert (await agent_session.ask(CORPUS, key, "Bash", {"command": "ls"}))["message"] == agent_session.GONE_LINE


PEEK = '''import thimble
def run(input):
    out = {}
    for name, inp in (("picture", {"card": {"id": "c1", "question": "Q?"}, "picture": input["secret"]}),
                      ("relative", {"card": {"id": "c1", "question": "Q?"}, "picture": "p.py"})):
        try:
            thimble.default(inp)
            out[name] = "read"
        except thimble.ThimbleError as e:
            out[name] = str(e)
    for name, paths in (("ask-secret", [input["secret"]]), ("ask-png", [input["png"]])):
        try:
            out[name] = thimble.ask("What does the picture show?", images=paths)
        except thimble.ThimbleError as e:
            out[name] = str(e)
    return {"assessment": [{"problem": out["picture"]}, {"problem": out["relative"]}, {"problem": out["ask-secret"]},
                           {"problem": out["ask-png"]}, {"problem": ""}], "question": "Q?", "code": "", "takeaway": ""}
thimble.serve(run)
'''


async def test_thimble_reads_for_a_program_only_pictures_its_box_may_read(tmp_path, data_tmp, workspaces_tmp, active,
                                                                          unboxed, monkeypatch):
    """A picture a program names, in a card check's input for thimble.default or in an ask, is read by the server
    for it: only a PNG, JPEG, GIF or WebP file, never server.json, which its box may not read."""
    secret = userconf.global_file().parent / "server.json"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text('{"token": "not-for-agents"}')
    png = tmp_path / "card.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    seen: list[list[tuple[bytes, str]]] = []

    async def structured(prompt, *, tool, model, images=(), **k):
        seen.append(list(images))
        return model_result({"text": f"{len(images)} pictures"})

    monkeypatch.setattr(model, "structured", structured)
    monkeypatch.setattr(__import__("app.card_check", fromlist=["card_check"]), "fit_image", lambda b: b)
    active.append(_program(tmp_path, "peek", "card-check", PEEK))
    res = await tasks.call(CORPUS, "card-check", {"secret": str(secret), "png": str(png)})
    assert res.status == "ok", res.detail
    problems = [a["problem"] for a in res.output["assessment"]]
    assert "is not a picture" in problems[0] and "not-for-agents" not in json.dumps(res.output)
    assert "is not a PNG, JPEG, GIF or WebP picture" in problems[1]
    assert "is not a picture" in problems[2]
    assert problems[3] == "1 pictures"
    assert seen == [[(png.read_bytes(), "image/png")]], "only the PNG reached a model"


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


async def test_a_checks_program_gets_thimble_s_own_check_as_a_session_of_its_run(tmp_path, data_tmp, workspaces_tmp,
                                                                                active, unboxed, monkeypatch):
    """thimble.default(input) of the checks task runs a session as the check agent on the run's first message, as
    the run's own session, so its add_comment calls belong to the run."""
    from app import agent_session

    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": "# Runs\n\n## Counts\n\nThree runs ended.\n"},
                         actor="analyst")
    assert not r.is_error, r.text
    log_file = tmp_path / "claude.log"
    fake = tmp_path / "claude"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    fake.chmod(0o755)
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(fake))
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log_file))
    monkeypatch.setenv("FAKE_CLAUDE_REPLY", "No sentence needed a comment.")
    active.append(_extension(tmp_path, "own", {"tasks/checks": {"description": "Mine.", "command": ["python", "c.py"]}},
                             {"tasks/checks/c.py": DEFAULT}))
    assert await checks.start_run(CORPUS, "judgment", "report", force=True) is not None
    done = await _until(lambda: (x := ((checks.read(CORPUS, "judgment") or {}).get("runs") or {}).get("report"))
                        and x.get("status") != "running" and x, what="the check's run to end")
    assert done["status"] == "done" and done["summary"].startswith("No sentence needed a comment."), done
    [start] = [json.loads(line) for line in log_file.read_text().splitlines()]
    argv = start["argv"]
    assert start["session"] == checks.session_key("judgment", "report")
    assert "comment" in argv[argv.index("--system-prompt") + 1].lower()
    assert argv[argv.index("--model") + 1] and "--effort" in argv


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
    assert got["status"] == "rerun"
    rec = await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("status") in ("done", "failed")
                       and r["chats"][orientation.ROLE] != chat and r, what="the program to end")
    assert rec["status"] == "done" and rec["program"] == "again", rec
    assert orientation.summary(CORPUS).strip() == "Added to the earlier cards."
    ws = config.workspace_dir(CORPUS)
    titles = [c.get("title") for nb in notebook.list_notebooks(ws)
              for c in (notebook.read_notebook(ws, nb["id"]) or {}).get("cells") or []]
    assert "What does the corpus hold?" in titles and "What did the second look add?" in titles
    assert extensions.offered(CORPUS) == []


async def test_an_orientation_program_s_start_marks_only_its_own_extension_as_oriented(tmp_path, data_tmp,
                                                                                    workspaces_tmp, unboxed):
    """The program does not read the other extensions' orientation instructions, so once it ran they are offered, as a
    follow-up it runs again with, and the program's own extension is not offered again right away."""
    from app import orient_session

    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, announce=False, brief="")["id"]
    orientation.started(CORPUS, chat, passes=["final"])
    orientation.finished(CORPUS, chat, "done", "Three runs.", report=False)
    agents.finish_agent(CORPUS, chat, "done", "Three runs.")
    prog = _extension(tmp_path, "looker", {"agents/orientation": {"description": "Looks.", "command": ["python", "o.py"]}},
                      {"agents/orientation/o.py": "import thimble\nthimble.serve(lambda i: 'Looked.')\n"})
    notes = _extension(tmp_path, "notes", {"agents/orientation": {"description": "Notes.", "prompt": "prompt.md"}},
                       {"agents/orientation/prompt.md": "Read the notes first."})
    for folder in (prog, notes):
        assert extensions.add(str(folder), yes=True, say=lambda _: None) == [folder.name]
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == ["looker"], "thimble's own session that ran is gone, so no follow-up reaches it"
    await orient_session.start(CORPUS, "count the runs", ("final",))
    await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("program") == "looker"
                 and r.get("status") in ("done", "failed"), what="the program to end")
    assert extensions.offered(CORPUS) == ["notes"]


FITS = '''import thimble
def run(input):
    return {"fits": True, "reason": "The program read " + input["view"]["name"] + "."}
thimble.serve(run)
'''


async def test_a_view_s_fit_is_decided_by_the_program_of_an_extension_switched_on_in_the_same_refresh(
        tmp_path, data_tmp, workspaces_tmp, unboxed, monkeypatch):
    """The first refresh after an extension is added both switches it on and checks its views; its view-fit program
    decides that check, rather than thimble's own, which ran before the refresh wrote the extension as active."""
    async def own(*a, **k):
        raise AssertionError("thimble's own view-fit ran")

    monkeypatch.setattr(model, "structured", own)
    folder = _extension(tmp_path, "fitter", {"tasks/view-fit": {"description": "Mine.", "command": ["python", "p.py"]}},
                        {"tasks/view-fit/p.py": FITS,
                         "views/posts/view.json": json.dumps({"name": "Posts", "description": "The board's posts.",
                                                              "claims": ["board.jsonl"]}),
                         "views/posts/view.html": "<main></main>\n",
                         "views/posts/reader.py": "def build_index(paths):\n    return []\n\n\n"
                                                  "def records(index, query):\n    return {'rows': []}\n"})
    assert extensions.add(str(folder), yes=True, say=lambda _: None) == ["fitter"]
    state = await extensions.refresh(CORPUS, wait=30)
    [view] = state["extensions"]["fitter"]["views"]
    assert view["fit"].get("reason") == "The program read Posts.", view["fit"]
