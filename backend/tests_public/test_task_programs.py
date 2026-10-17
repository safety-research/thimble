"""An extension can run any of thimble's seven tasks with its own program (tasks.py, harness.py), as it can a role: an
Agent SDK program or any command gets the task's input and returns the object thimble's own implementation returns,
which it can call as thimble.default(input). One extension that replaces a task runs it; two leave it thimble's. A
program's output is checked before thimble uses it, and a program runs in its task's box, which never reads
server.json. The example in docs/examples/vote-labels runs end to end with the model calls faked. An extension whose
program runs the orientation is offered Run now where an orientation ran, which runs it again with the cards as they
stand."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app import agent_session, concepts, config, extensions, harness, kernel_wrap, model, tasks, userconf

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

    async def structured(c, prompt, *, tool, model, images=(), **k):
        seen.append(list(images))
        return model_result({"text": f"{len(images)} pictures"})

    monkeypatch.setattr(__import__("app.agent_call", fromlist=["agent_call"]), "structured", structured)
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
