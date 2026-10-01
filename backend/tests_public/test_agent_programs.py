"""An extension can run one of thimble's roles its own way (roles.py, harness.py): by a prompt that adds to thimble's
or replaces it, by an Agent SDK program, or by any command. The guardrails are thimble's for every agent, its own
included: no agent can read server.json, an edit of the corpus goes to the analyst first unless the config says
otherwise, and a program's sessions run in the role's permission mode and sandbox. A program's token works only for its
role's tools and only while it runs. The example orientation in docs/examples runs end to end on a copy of a corpus,
with a stand-in `claude` that speaks the Agent SDK's stream-json."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

from app import agent_session, config, extensions, harness, hook_auth, kernel_wrap, notebook, orientation, roles, \
    tools, userconf

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = REPO / "docs" / "examples" / "orient-sdk"
FAKE = Path(__file__).parent / "fixtures" / "agents" / "fake_sdk_claude.py"
CORPUS = "mini"


def _config(data: dict) -> None:
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def _extension(root: Path, name: str, agents: dict[str, dict], files: dict[str, str] | None = None) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "extension.json").write_text(json.dumps({"name": name, "version": "0.1.0"}))
    for role, spec in agents.items():
        (folder / "agents" / role).mkdir(parents=True)
        (folder / "agents" / role / "agent.json").write_text(json.dumps(spec))
    for rel, text in (files or {}).items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text)
    return folder


@pytest.fixture()
def active(monkeypatch):
    """The extensions active in every workspace, set by the test: a list of their folders."""
    folders: list[Path] = []
    monkeypatch.setattr(extensions, "active", lambda c: [
        {"name": f.name, "src": str(f), "dir": str(f), "files": ["runs/r1.jsonl"], "active": True} for f in folders])
    return folders


@pytest.fixture()
def unboxed(monkeypatch):
    """No sandbox for agents or programs, as on a machine without bubblewrap whose config allows that."""
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


def _cards(c: str) -> list[dict]:
    ws = config.workspace_dir(c)
    return [cell for nb in notebook.list_notebooks(ws) for cell in (notebook.read_notebook(ws, nb["id"]) or {}).get("cells") or []]


# --------------------------------------------------------------------------- roles and the prompt way


def test_each_role_is_thimble_s_own_until_an_extension_gives_it_and_two_replacements_leave_it_to_thimble(
        tmp_path, workspaces_tmp, active):
    assert roles.agent_for(CORPUS, "orientation").way == "thimble"
    active.append(_extension(tmp_path, "survey", {"orientation": {"description": "Surveys.", "sdk": "o.py"}},
                             {"agents/orientation/o.py": "async def run(input):\n    return 'ok'\n"}))
    active.append(_extension(tmp_path, "notes", {"critic": {"description": "Adds.", "prompt": "p.md"},
                                                 "main": {"description": "Adds.", "prompt": "p.md"}},
                             {"agents/critic/p.md": "Check the dates.", "agents/main/p.md": "Say hello."}))
    got = roles.agent_for(CORPUS, "orientation")
    assert got.way == "sdk" and got.extension == "survey" and got.code
    critic = roles.agent_for(CORPUS, "critic")
    assert critic.way == "thimble" and [p.extension for p in critic.additions] == ["notes"]
    assert "Say hello." in roles.main_additions(CORPUS)
    active.append(_extension(tmp_path, "other", {"orientation": {"description": "Also.", "command": ["true"]}}))
    clash = roles.agent_for(CORPUS, "orientation")
    assert clash.way == "thimble" and clash.conflict == ["survey", "other"]
    rows = {r["role"]: r for r in roles.public(CORPUS)}
    assert rows["orientation"]["conflict"] == ["survey", "other"] and rows["critic"]["additions"] == ["notes"]


def test_agent_json_problems_name_the_field_and_main_takes_additions_only(tmp_path):
    folder = tmp_path / "x" / "agents" / "main"
    folder.mkdir(parents=True)
    assert any("main takes prompt additions only" in p
               for p in roles.problems({"command": ["true"]}, "main", folder, tmp_path / "x"))
    got = roles.problems({"promt": "p.md"}, "critic", folder, tmp_path / "x")
    assert any("'promt'" in p and "'prompt'" in p for p in got)
    assert any("exactly one" in p for p in roles.problems({"prompt": "a.md", "sdk": "b.py"}, "critic", folder,
                                                          tmp_path / "x"))
    assert any("not a file" in p for p in roles.problems({"sdk": "../../../etc/passwd"}, "critic", folder,
                                                         tmp_path / "x"))


def test_a_prompt_addition_or_replacement_reaches_the_role_s_prompt_and_the_config_s_prompt_wins(
        tmp_path, workspaces_tmp, active):
    from app import prompts

    active.append(_extension(tmp_path, "dates", {"critic": {"description": "Dates.", "prompt": "p.md"}},
                             {"agents/critic/p.md": "Check every date against {{files}}. Folder: {{dir}}."}))
    files = userconf.prompt_files(CORPUS, "critic")
    with prompts.custom(files):
        _, body = prompts.agent_file("critic")
    own = prompts.agent_file("critic")[1]
    assert body.startswith(own[:200]) and "## From the dates extension" in body
    assert "`runs/r1.jsonl`" in body and str(active[0]) in body
    active[0] = _extension(tmp_path, "whole", {"critic": {"description": "Whole.", "prompt": "p.md", "replace": True}},
                           {"agents/critic/p.md": "Read the digest.\n\n{{default#What to look for}}"})
    with prompts.custom(userconf.prompt_files(CORPUS, "critic")):
        front, body = prompts.agent_file("critic")
    section = prompts.section("critic", "What to look for").strip()
    assert body.startswith("Read the digest.") and front.get("name") and section[:120] in body
    mine = tmp_path / "mine.md"
    mine.write_text((REPO / "prompts" / "critic.md").read_text())
    _config({"agents": {"critic": {"prompt": str(mine)}}})
    assert userconf.prompt_files(CORPUS, "critic") == {"critic": mine}


def test_a_replacing_orientation_prompt_keeps_thimble_s_slots_and_needs_none_of_its_parts(tmp_path, data_tmp,
                                                                                         workspaces_tmp, active):
    """A replacement may use the slots thimble's own prompt for the role fills ({{request}}); any other double brace
    is literal, and a prompt without the parts Start's switches leave out still renders."""
    from app import orient_session

    active.append(_extension(tmp_path, "lean", {"orientation": {"description": "Lean.", "prompt": "p.md",
                                                                "replace": True}},
                             {"agents/orientation/p.md": "Survey {{files}} for this request: {{request}}. "
                                                         "Keep {{braces}} as they are."}))
    from app import prompts

    with prompts.custom(userconf.prompt_files(CORPUS, "orientation")):
        text = orient_session.system_prompt(CORPUS, "count the runs", ["final"])
    assert text.startswith("Survey `runs/r1.jsonl` for this request: count the runs.")
    assert "{ {braces} }" in text


# --------------------------------------------------------------------------- guardrails for every agent


def test_no_agent_thimble_starts_may_read_server_json(workspaces_tmp, monkeypatch):
    """Every session's settings deny reading and editing server.json, and the sandbox of a fenced session hides it from
    Bash and what it runs."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    conf = userconf.session(CORPUS, "writer")
    secret = str(userconf.global_file().parent / "server.json")
    assert f"Read(/{secret})" in conf.settings()["permissions"]["deny"]
    corpus = config.corpus_dir(CORPUS)
    fenced = agent_session.fence(corpus, workspaces_tmp / "w", sandbox=True, data=conf.data)
    merged = agent_session.with_config(fenced, conf.settings())
    assert secret in merged["sandbox"]["filesystem"]["denyRead"] and merged["sandbox"]["enabled"]
    unfenced = agent_session.with_config({"permissions": {}}, conf.settings())
    assert "sandbox" not in unfenced, "a session without a sandbox gets none from the read deny alone"


def test_an_edit_of_the_corpus_asks_by_default_and_the_config_can_allow_or_refuse_it(workspaces_tmp, monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    corpus = config.corpus_dir(CORPUS)
    target = {"file_path": str(corpus / "runs" / "r1.jsonl"), "old_string": "a", "new_string": "b"}
    conf = userconf.session(CORPUS, "orientation")
    assert conf.data == "ask" and conf.network and conf.verdict("Edit", target) == "ask" and conf.may_ask()
    assert conf.verdict("Write", {"file_path": "/elsewhere/x.txt"}) == ""
    fenced = agent_session.fence(corpus, workspaces_tmp / "w", sandbox=True, data="ask")
    assert fenced["permissions"]["ask"] == [f"Edit(/{corpus}/**)"] and "deny" not in fenced["permissions"]
    assert fenced["sandbox"]["filesystem"]["denyWrite"] == [str(corpus)]
    _config({"agents": {"orientation": {"data": "off"}}})
    assert userconf.session(CORPUS, "orientation").verdict("NotebookEdit", {"notebook_path": target["file_path"]}) == "deny"
    _config({"agents": {"orientation": {"data": "allow"}}})
    assert userconf.session(CORPUS, "orientation").verdict("Edit", target) == ""
    allowed = agent_session.fence(corpus, workspaces_tmp / "w", sandbox=True, data="allow")
    assert allowed["sandbox"]["filesystem"]["allowWrite"] == [str(corpus)] and "ask" not in allowed["permissions"]


def test_an_agent_s_own_sandbox_switch_runs_it_outside_the_sandbox_without_the_enforce_refusal(workspaces_tmp,
                                                                                                monkeypatch):
    monkeypatch.setattr(userconf, "sandbox_runs", lambda refresh=False: False)
    with pytest.raises(userconf.ConfigError):
        userconf.session(CORPUS, "writer")
    _config({"agents": {"writer": {"sandbox": "off"}}})
    assert not userconf.session(CORPUS, "writer").sandboxed
    _config({"agents": {"writer": {"sandbox": "maybe", "env": ["NOT A NAME"]}}})
    problem = userconf.problem(CORPUS)
    assert "agents.writer.sandbox" in problem and "agents.writer.env" in problem


def test_a_program_s_token_works_for_its_role_s_own_tools_only_and_only_while_it_runs(data_tmp, workspaces_tmp):
    from fastapi.testclient import TestClient

    from app.main import app

    job = harness.Job(CORPUS, "orientation", "orient", "Orientation", {}, ("list_cards",), workspaces_tmp / "w")
    part = roles.Part("x", "orientation", workspaces_tmp, workspaces_tmp, {"command": ["true"]})
    run = harness.Run(job, part, None, "abc123", "abc123.s3cret")  # type: ignore[arg-type]
    harness._runs[run.token_id] = run
    hook_auth.grant(run.token_id, run.token, run.allows)

    def headers() -> dict[str, str]:
        nonce = os.urandom(8).hex()
        return {**hook_auth.headers(run.token, nonce), hook_auth.AGENT_HEADER: run.token_id}

    body = {"args": {"group": "all"}, "cwd": "/nowhere", "session": "main-would-be-refused"}
    with TestClient(app) as client:
        ok = client.post("/api/tools/list_cards", json=body, headers=headers())
        assert ok.status_code == 200 and not ok.json()["is_error"]
        assert client.post("/api/tools/add_card", json=body, headers=headers()).status_code == 401
        assert client.post("/api/channel/permission", json={}, headers=headers()).status_code == 401
        hook_auth.revoke(run.token_id)
        harness._runs.pop(run.token_id, None)
        assert client.post("/api/tools/list_cards", json=body, headers=headers()).status_code == 401


def test_settings_name_each_role_s_agent_and_its_consent_settings(tmp_path, workspaces_tmp, active):
    from app import ledger

    active.append(_extension(tmp_path, "survey", {"orientation": {"description": "Surveys.", "sdk": "o.py"},
                                                  "main": {"description": "Adds.", "prompt": "m.md"}},
                             {"agents/orientation/o.py": "async def run(input):\n    return 'ok'\n",
                              "agents/main/m.md": "Say hello."}))
    _config({"agents": {"critic": {"network": "off", "data": "off", "sandbox": "off"}}})
    rows = ledger.with_features({}, CORPUS)["agents"]
    assert rows["main"]["additions"] == ["survey"]
    assert rows["orient"]["way"] == "sdk" and rows["orient"]["extension"] == "survey"
    assert (rows["orient"]["network"], rows["orient"]["data"], rows["orient"]["sandbox"]) == ("on", "ask", "on")
    assert (rows["critic"]["network"], rows["critic"]["data"], rows["critic"]["sandbox"]) == ("off", "off", "off")
    assert rows["critic"]["way"] == "thimble" and rows["critic"]["config"] == "agents.critic"
    assert set(rows) == {"main", *userconf.MODE_ROWS.values()}


# --------------------------------------------------------------------------- programs


HARNESS = '''import thimble

async def run(input):
    thimble.log("reading " + input["corpus"])
    print("a stray print goes to stderr")
    listed = await thimble.tool("list_cards", {"group": "all"})
    try:
        await thimble.tool("propose_view", {"name": "x"})
    except thimble.ThimbleError as e:
        thimble.log("refused: " + str(e)[:40])
    await thimble.tool("add_card", {"question": "What did the harness see?", "kind": "note",
                                    "text": "Three runs.", "takeaway": "Three runs."})
    return "The harness found three runs."

thimble.serve(run)
'''


async def test_a_command_harness_runs_the_orientation_through_thimble_s_tools(tmp_path, data_tmp, workspaces_tmp,
                                                                             active, unboxed):
    active.append(_extension(tmp_path, "harn", {"orientation": {"description": "A harness.",
                                                                "command": ["python", "orient.py"]}},
                             {"agents/orientation/orient.py": HARNESS}))
    res = await tools.call(CORPUS, "start_orientation", {"brief": "count the runs", "propose_views": False})
    assert not res.is_error, res.text
    rec = await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("status") in ("done", "failed") and r,
                       what="the orientation to end")
    assert rec["status"] == "done", rec
    assert orientation.summary(CORPUS).strip() == "The harness found three runs."
    assert any(c.get("title") == "What did the harness see?" for c in _cards(CORPUS))
    chat = rec["chats"][orientation.ROLE]
    log_text = (config.workspace_dir(CORPUS) / "chats" / f"{chat}.jsonl").read_text()
    assert "reading " in log_text and "refused: propose_view is not one of" in log_text
    assert "a stray print" not in log_text
    meta = json.loads((config.workspace_dir(CORPUS) / "chats" / f"{chat}.meta.json").read_text())
    assert meta["status"] == "done" and meta["way"] == "command" and meta["extension"] == "harn"


async def test_a_failing_program_fails_its_run_with_the_end_of_its_stderr(tmp_path, data_tmp, workspaces_tmp, active,
                                                                          unboxed):
    active.append(_extension(tmp_path, "bad", {"orientation": {"description": "Fails.", "command": ["python", "o.py"]}},
                             {"agents/orientation/o.py": "import sys\nprint('no corpus today', file=sys.stderr)\n"
                                                         "sys.exit(3)\n"}))
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert not res.is_error, res.text
    rec = await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("status") in ("done", "failed") and r,
                       what="the orientation to end")
    assert rec["status"] == "failed" and "code 3" in rec["error"] and "no corpus today" in rec["error"]


@pytest.mark.skipif(not kernel_wrap.srt_works(*(lambda s: (s.node(), s.package(config.REPO_ROOT)))(
    __import__("app.srt", fromlist=["srt"]))), reason="Anthropic's sandbox runtime can't run here")
async def test_a_program_s_box_hides_server_json_and_keeps_the_corpus_read_only(tmp_path, data_tmp, workspaces_tmp,
                                                                                 active, monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    _config({"sandbox": {"enforce": False}})
    secret = userconf.global_file().parent / "server.json"
    secret.write_text('{"token": "not-for-agents"}')
    probe = '''import json, os, thimble
def run(input):
    out = {}
    for name, path in (("secret", os.environ["SECRET"]), ("corpus", os.path.join(input["corpus"], "x.txt")),
                       ("work", os.path.join(os.environ["THIMBLE_WORK"], "x.txt"))):
        try:
            if name == "secret":
                open(path).read()
            else:
                open(path, "w").write("x")
            out[name] = "ok"
        except OSError as e:
            out[name] = type(e).__name__
    return json.dumps(out)
thimble.serve(run)
'''
    monkeypatch.setenv("SECRET", str(secret))
    _config({"sandbox": {"enforce": False}, "agents": {"orientation": {"env": ["SECRET"]}}})
    active.append(_extension(tmp_path, "probe", {"orientation": {"description": "Probes.", "command": ["python", "p.py"]}},
                             {"agents/orientation/p.py": probe}))
    res = await tools.call(CORPUS, "start_orientation", {"brief": ""})
    assert not res.is_error, res.text
    rec = await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("status") in ("done", "failed") and r,
                       what="the orientation to end")
    assert rec["status"] == "done", rec
    got = json.loads(orientation.summary(CORPUS))
    assert got["secret"] == "PermissionError" and got["corpus"] != "ok" and got["work"] == "ok", got


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def live_server(monkeypatch, plugin_headers):
    """thimble's app served on a free port in a thread, so a program's shim can reach it; THIMBLE_PORT names it."""
    import uvicorn

    from app.main import app

    port = _free_port()
    monkeypatch.setenv("THIMBLE_PORT", str(port))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    end = time.monotonic() + 15
    while not server.started and time.monotonic() < end:
        time.sleep(0.05)
    assert server.started
    yield f"http://127.0.0.1:{port}", server
    server.should_exit = True
    thread.join(10)


def test_the_example_sdk_orientation_runs_end_to_end_on_a_copy_of_a_corpus(tmp_path, data_tmp, workspaces_tmp,
                                                                           active, unboxed, live_server, plugin_headers,
                                                                           monkeypatch):
    """docs/examples/orient-sdk: the program's query() reaches a stand-in claude that thimble starts with the role's
    flags; the program files the survey as a card through thimble's tool, and its first line is the summary."""
    base, server = live_server
    log_file = tmp_path / "claude.log"
    fake = tmp_path / "claude"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    fake.chmod(0o755)
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(fake))
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log_file))
    monkeypatch.setenv("FAKE_CLAUDE_REPLY", "A corpus of three agent runs.\n- runs: transcripts")
    home = Path(os.environ["THIMBLE_HOME"])
    shutil.copytree(EXAMPLE, home / "extensions" / "orient-sdk")
    active.append(home / "extensions" / "orient-sdk")
    r = httpx.post(f"{base}/api/tools/start_orientation", headers=plugin_headers(), timeout=60,
                   json={"args": {"brief": "", "propose_views": False}, "workspace": CORPUS, "actor": "analyst"})
    assert r.status_code == 200 and not r.json()["is_error"], r.text
    end = time.monotonic() + 90
    rec: dict = {}
    while time.monotonic() < end:
        rec = orientation.read_run(CORPUS) or {}
        if rec.get("status") in ("done", "failed"):
            break
        time.sleep(0.2)
    assert rec.get("status") == "done", rec
    assert orientation.summary(CORPUS).strip() == "A corpus of three agent runs."
    card = next(c for c in _cards(CORPUS) if c.get("title") == "What does the corpus hold?")
    assert "three agent runs" in json.dumps(card)
    [start] = [json.loads(line) for line in log_file.read_text().splitlines()]
    argv = start["argv"]
    assert start["session"] == "orient" and Path(start["cwd"]) == orientation.orient_dir(CORPUS) / "work"
    assert argv[argv.index("--permission-mode") + 1] in ("default", "auto")
    assert str(agent_session.PLUGIN_DIR) in argv and str(config.corpus_dir(CORPUS)) in argv
    settings = json.loads(argv[argv.index("--settings") + 1])
    secret = str(home / "server.json")
    assert f"Read(/{secret})" in settings["permissions"]["deny"]
    assert settings["permissions"]["ask"][0].startswith("Edit(") and "hooks" in settings
    assert "--strict-mcp-config" not in argv and "--setting-sources" not in " ".join(argv)
    assert "survey a corpus of files" in argv[argv.index("--append-system-prompt") + 1]


async def test_a_program_writes_a_document_and_main_hears_what_it_returns(tmp_path, data_tmp, workspaces_tmp, active,
                                                                         unboxed):
    from app import report_types, write_session

    writer = '''import thimble
def run(input):
    thimble.log("writing " + input["doc"])
    return "Wrote the summary of " + input["doc"] + "."
thimble.serve(run)
'''
    active.append(_extension(tmp_path, "pen", {"writer": {"description": "Writes.", "command": ["python", "w.py"]}},
                             {"agents/writer/w.py": writer}))
    made = report_types.create_document_type(CORPUS, "document", name="Summary", brief="A short summary.")
    res = await tools.call(CORPUS, "start_writing", {"doc": made["slug"], "request": "keep it short"})
    assert not res.is_error, res.text
    meta = await _until(lambda: next((m for m in agents_list(CORPUS) if m.get("doc") == made["slug"]
                                      and m.get("status") != "running"), None), what="the writer to end")
    assert meta["status"] == "done" and meta["result"] == f"Wrote the summary of {made['slug']}."
    assert meta["role"] == write_session.ROLE and meta["way"] == "command"
    assert not write_session.running(CORPUS, made["slug"])


async def test_a_program_critiques_the_orientation_and_its_report_is_the_call_s_answer(tmp_path, data_tmp,
                                                                                      workspaces_tmp, active, unboxed,
                                                                                      monkeypatch):
    from app import critique_session

    critic = '''import thimble
def run(input):
    return "Report: " + input["digest"][:21]
thimble.serve(run)
'''
    active.append(_extension(tmp_path, "crit", {"critic": {"description": "Critiques.", "command": ["python", "c.py"]}},
                             {"agents/critic/c.py": critic}))
    caller = agent_session.Run(CORPUS, "orient", "chat-o", "sid", config.corpus_dir(CORPUS), orientation.ROLE)
    monkeypatch.setattr(critique_session, "orientation_run", lambda c, key: caller)
    monkeypatch.setattr(critique_session, "write_digest", lambda c, run: None)
    monkeypatch.setattr(critique_session, "first_message", lambda c, t, ctx, checks=None: "The digest of the run.")

    async def no_checks(c):
        return None

    monkeypatch.setattr(critique_session, "checks_text", no_checks)
    res = await tools.call(CORPUS, "critique", {}, session="orient")
    assert not res.is_error, res.text
    assert res.text.splitlines()[-1] == "Report: The digest of the run"


def agents_list(c: str) -> list[dict]:
    folder = config.workspace_dir(c) / "chats"
    return [json.loads(p.read_text()) for p in folder.glob("*.meta.json")] if folder.is_dir() else []


DEV = '''import json, os, thimble
def run(input):
    folder = input["folder"]
    with open(os.path.join(folder, "view.json"), "w") as f:
        json.dump({"name": input["name"], "scope": ["runs/*.jsonl"]}, f)
    with open(os.path.join(os.environ["THIMBLE_WORK"], "notes.txt"), "w") as f:
        f.write(input["message"])
    thimble.log("wrote the view of " + input["slug"])
    return "Built " + input["slug"] + " from: " + input["message"][:12]
thimble.serve(run)
'''


async def test_a_dev_program_takes_each_turn_of_a_view_build_and_writes_only_the_view_s_folder(
        tmp_path, data_tmp, workspaces_tmp, active, unboxed, monkeypatch):
    """With an extension's program as the dev agent, a view build's turn runs the program in place of thimble's session:
    it gets the message the session would get and the view's folder, writes the view there and keeps its own notes in
    a folder beside it."""
    from app import dev, views

    active.append(_extension(tmp_path, "builder", {"dev": {"description": "Builds views.", "command": ["python", "d.py"]}},
                             {"agents/dev/d.py": DEV}))
    assert dev.view_program(CORPUS) is not None and dev.view_program(CORPUS).extension == "builder"

    def no_session(*a, **k):
        raise AssertionError("thimble's own session started")

    monkeypatch.setattr(dev.SESSIONS, "start", no_session)
    monkeypatch.setattr(dev.SESSIONS, "resume", no_session)
    folder = views.views_dir(CORPUS) / "runs-table"
    folder.mkdir(parents=True)
    run = dev.Run(ticket_id="view:runs-table", title="Runs table", ts_start="")
    said = await dev._worker_turn(run, dev.Log(None), config.corpus_dir(CORPUS), "Build the runs table.", None,
                                  name="thimble:view-runs-table", workspace=CORPUS, on_session=lambda *a: None,
                                  add_dirs=(folder,), answered=False, asking={"key": "view:runs-table"})
    assert said == "Built runs-table from: Build the ru"
    assert json.loads((folder / "view.json").read_text())["name"] == "runs-table"
    assert sorted(p.name for p in folder.iterdir()) == ["view.json"]
    assert (dev.view_program_dir(CORPUS, "runs-table") / "notes.txt").read_text() == "Build the runs table."
    assert not harness.running(CORPUS, "view:runs-table")
