"""An extension can run one of thimble's roles its own way (roles.py, harness.py): by a prompt that adds to thimble's
or replaces it, or by any command; an Agent SDK program does not start, since thimble starts no Claude Code session of its
own. The guardrails are thimble's for every agent, its own included: no agent can read server.json, and an edit of the
corpus goes to the analyst first unless the config says otherwise. A program's token works only for its role's tools and
only while it runs."""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import pytest

from app import agent_session, config, extensions, harness, hook_auth, kernel_wrap, notebook, orientation, roles, \
    tools, userconf

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
    assert conf.ask_cause("Edit", target) == "data", "the card says the config asks, not the permission mode"
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


def test_an_edit_of_thimble_s_config_asks_in_every_session_somebody_answers_and_is_refused_in_one_nobody_does(
        workspaces_tmp, monkeypatch):
    """An edit of the config in thimble's home or of the workspace's goes to the analyst whatever `data` says, through a
    link to the file too, with `config` as the card's reason; a session nobody answers (a dev run with no host) is
    refused it, its --settings denying both files. main's kept mode stays denied, and other files are left to the rest
    of the config."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    home_file, ws_file = userconf.global_file(), userconf.workspace_file(CORPUS)
    _config({"agents": {"orientation": {"data": "allow"}}})
    conf = userconf.session(CORPUS, "orientation")
    link = workspaces_tmp / "link.json"
    link.symlink_to(home_file)
    for tool, inp in (("Edit", {"file_path": str(home_file)}), ("Write", {"file_path": str(ws_file)}),
                      ("MultiEdit", {"file_path": str(link)}), ("NotebookEdit", {"notebook_path": str(ws_file)})):
        assert conf.verdict(tool, inp) == "ask" and conf.ask_cause(tool, inp) == "config", (tool, inp)
    assert conf.verdict("Edit", {"file_path": str(userconf.main_modes_file())}) == ""
    assert f"Edit(/{userconf.main_modes_file()})" in conf.settings()["permissions"]["deny"]
    assert conf.verdict("Read", {"file_path": str(home_file)}) == "" and conf.may_ask()
    unhosted = userconf.session(CORPUS, "dev")
    unhosted.hosted = False
    assert unhosted.verdict("Write", {"file_path": str(home_file), "content": "{}"}) == "deny"
    perms = unhosted.settings()["permissions"]
    assert {f"Edit(/{home_file})", f"Edit(/{ws_file})"} <= set(perms["deny"]) and not perms.get("ask")


def test_a_program_s_token_works_for_its_role_s_own_tools_only_and_only_while_it_runs(data_tmp, workspaces_tmp):
    from fastapi.testclient import TestClient

    from app.main import app

    job = harness.Job(CORPUS, "orientation", "orient", "Orientation", {}, ("list_cards",), workspaces_tmp / "w")
    part = roles.Part("x", "orientation", workspaces_tmp, workspaces_tmp, {"command": ["true"]})
    run = harness.Run(job, part, None, "abc123", "abc123.s3cret")  # type: ignore[arg-type]
    harness._runs[run.token_id] = run
    hook_auth.grant(run.token_id, run.token, run.allows)

    def headers() -> dict[str, str]:
        nonce = os.urandom(8).hex()  # as docs/agents.md says: a fresh random string, bound to no port or time
        return {hook_auth.NONCE_HEADER: nonce, hook_auth.AUTH_HEADER: hook_auth.sign(run.token, "hook", nonce),
                hook_auth.AGENT_HEADER: run.token_id}

    body = {"args": {"group": "all"}, "cwd": "/nowhere", "session": "main-would-be-refused"}
    with TestClient(app) as client:
        ok = client.post("/api/tools/list_cards", json=body, headers=headers())
        assert ok.status_code == 200 and not ok.json()["is_error"]
        assert client.post("/api/tools/add_card", json=body, headers=headers()).status_code == 401
        assert client.post("/api/events/permission", json={}, headers=headers()).status_code == 401
        hook_auth.revoke(run.token_id)
        harness._runs.pop(run.token_id, None)
        assert client.post("/api/tools/list_cards", json=body, headers=headers()).status_code == 401


# --------------------------------------------------------------------------- programs


HARNESS = '''import thimble

async def run(input):
    thimble.log("reading " + input["corpus"])
    thimble.log("tools: " + " ".join(input["tools"]))
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
    res = await tools.call(CORPUS, "start_orientation", {"brief": "count the runs"})
    assert not res.is_error, res.text
    rec = await _until(lambda: (r := orientation.read_run(CORPUS)) and r.get("status") in ("done", "failed") and r,
                       what="the orientation to end")
    assert rec["status"] == "done", rec
    assert orientation.summary(CORPUS).strip() == "The harness found three runs."
    assert any(c.get("title") == "What did the harness see?" for c in _cards(CORPUS))
    chat = rec["chats"][orientation.ROLE]
    log_text = (config.workspace_dir(CORPUS) / "chats" / f"{chat}.jsonl").read_text()
    assert "reading " in log_text and "refused: propose_view is not one of" in log_text
    assert "tools: read_ref list_cards add_card" in log_text and "critique" not in log_text.split("tools: ")[1][:200]
    assert "a stray print" not in log_text
    meta = json.loads((config.workspace_dir(CORPUS) / "chats" / f"{chat}.meta.json").read_text())
    assert meta["status"] == "done" and meta["way"] == "command" and meta["extension"] == "harn"
    # the program ran without a sandbox: its thread says so, and one notice per extension, with Settings to turn it off
    from app import notices

    told = [n for n in notices.open_notices(CORPUS) if n.get("key") == "no-box:harn"]
    assert len(told) == 1 and told[0]["kind"] == "sandbox" and told[0]["agent"] == "Extension: harn"
    assert told[0]["action"] == notices.SETTINGS
    assert told[0]["text"] == harness.NO_BOX_NOTICE.format(name="harn") and "`thimble doctor --verbose`" in told[0]["text"]


@pytest.mark.skipif(not kernel_wrap.srt_works(*(lambda s: (s.node(), s.package(config.REPO_ROOT)))(
    __import__("app.srt", fromlist=["srt"]))), reason="Anthropic's sandbox runtime can't run here")
async def test_a_program_s_box_hides_server_json_and_keeps_the_corpus_read_only(tmp_path, data_tmp, workspaces_tmp,
                                                                                 active, monkeypatch):
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    _config({"sandbox": {"enforce": False}})
    secret = userconf.global_file().parent / "server.json"
    secret.write_text('{"token": "not-for-agents"}')
    # the path reaches the program through the orientation's `env`, which an extension's program keeps (userconf
    # PROGRAM_KEYS), although thimble's own orientation does not read it
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
    from app import notices

    assert not [n for n in notices.open_notices(CORPUS) if str(n.get("key")).startswith("no-box:")], "boxed: no notice"


async def test_an_agent_sdk_program_does_not_start_and_says_how_to_go_on(tmp_path, data_tmp, workspaces_tmp, active,
                                                                         unboxed):
    """An Agent SDK program's work is Claude Code sessions of its own, which thimble no longer starts (NOCLAUDE.md): the
    role does not start, and the refusal names the extension, Settings and the `command` way."""
    active.append(_extension(tmp_path, "sdkorient", {"orientation": {"description": "An SDK orientation.",
                                                                     "sdk": "orient.py"}},
                             {"agents/orientation/orient.py": "async def run(input):\n    return 'x'\n"}))
    part = roles.Part("sdkorient", "orientation", tmp_path, tmp_path, {"sdk": "orient.py"})
    job = harness.Job(CORPUS, "orientation", "orient", "Orientation", {}, ("list_cards",), tmp_path / "work")
    with pytest.raises(RuntimeError) as got:
        harness.start(job, part)
    assert str(got.value) == harness.NO_SDK.format(name="sdkorient", who="orientation")
    assert "Settings" in str(got.value) and "`command`" in str(got.value) and not harness.running(CORPUS, "orient")
    with pytest.raises(harness.HarnessError, match="no Claude Code session"):
        await harness.session_call(harness.Run(job, part, None, "t", "t.s"), {"prompt": "Survey."})  # type: ignore[arg-type]
