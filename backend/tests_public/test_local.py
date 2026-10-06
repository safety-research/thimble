"""thimble's backend without its server (app/local.py): in a terminal-mode workspace every tool runs in the calling
process and opens no socket; a folder of no workspace and a browser-mode workspace are refused; `thimble state` gives
the JSON the server's GET routes give and `thimble act` makes the changes its POST routes make; a process that lost its
environment does nothing; and the MCP shim in terminal mode keeps fd 1 for its stream and subscribes to nothing."""
from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from app import cardrun, config, local, notebook, tools

CORPUS = "mini"
BACKEND = Path(__file__).resolve().parents[1]


def _mode(mode: str, c: str = CORPUS) -> Path:
    ws = config.workspace_dir(c)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": mode}))
    return ws


@pytest.fixture()
def term(workspaces_tmp, mini_dir, monkeypatch) -> Path:
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    _mode("terminal")
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    yield mini_dir
    cardrun.CardWatch.stop_all()
    local._started.clear()


async def call(corpus: Path, tool: str, **args: Any) -> dict:
    return await local.call(tool, args, cwd=str(corpus))


def text(res: dict) -> str:
    return "\n".join(b.get("text", "") for b in res["content"] if b.get("type") == "text")


@pytest.fixture()
def no_sockets(monkeypatch):
    """A socket that connects, binds or listens fails the test: an in-process call reaches no server and starts no
    kernel. The event loop's own socket pair is made before this, with no connect."""
    opened: list[str] = []

    def refuse(name):
        def fn(self, *a, **k):
            opened.append(f"{name} {a!r}")
            raise AssertionError(f"socket.{name} {a!r}")
        return fn

    for name in ("connect", "connect_ex", "bind", "listen"):
        monkeypatch.setattr(socket.socket, name, refuse(name))
    return opened


def _args(c: str, corpus: Path) -> dict[str, dict]:
    """A call of every tool of prompts/tools.md, each with the arguments it takes."""
    return {
        "read_ref": {"ref": "board.jsonl#L1"},
        "list_cards": {"group": "all"},
        "add_card": {"question": "What is this corpus?", "kind": "note", "text": "A small synthetic corpus."},
        "edit_card": {"card": "card:nope", "question": "?"},
        "delete_card": {"card": "card:nope"},
        "apply_label": {"scope": "files", "name": "bash", "predicate": {"kind": "regex", "text": "Bash"},
                        "paths": ["agents/*.jsonl"]},
        "show_label": {"name": "bash", "on": True},
        "set_filter": {"scope": "files", "label": "bash"},
        "clear_filter": {"scope": "files"},
        "set_layout": {"layout": "one", "surfaces": ["files"]},
        "open_view": {"view": "nope"},
        "propose_view": {"name": "Board", "why": "w", "claims": ["board.jsonl"], "unit": "a post", "overview": "o",
                         "zoom": "z", "filter": "f", "details": "d"},
        "write_document": {"doc": "report", "text": "# Report\n\n## What this data is and what we analyzed\n\nPosts."},
        "edit_document": {"span": "report:report#nope", "text": "x"},
        "add_comment": {"ref": "report:report#nope", "text": "a note"},
        "resolve_comment": {"comment": "nope"},
        "reply_in_thread": {"thread": "thread:nope", "text": "x"},
        "message_thread": {"thread": "nope", "message": "x"},
        "list_agents": {},
        "rename_thread": {"thread": "nope", "name": "x"},
        "delete_thread": {"thread": "nope"},
        "screenshot": {"ref": "card:nope"},
        "start_orientation": {"brief": ""},
        "start_writing": {"doc": "report"},
        "critique": {},
        "message_orientation": {"message": "x"},
        "run_check": {"name": "Unverified", "instructions": "Comment on numbers without a source."},
        "stop_check": {"name": "Unverified"},
        "file_dev_ticket": {"title": "t", "body": "b"},
        "view_check": {},
        "finish_view": {},
        "view_pictures": {},
        "finish_review": {},
        "ticket_checks": {},
        "finish_ticket": {},
    }


async def test_every_tool_runs_in_process_and_opens_no_socket(term, no_sockets, monkeypatch):
    assert not (Path(os.environ["THIMBLE_HOME"]) / "server.json").exists()
    args = _args(CORPUS, term)
    assert sorted(args) == sorted(tools.REGISTRY), "every tool of the registry is called"
    for name, given in args.items():
        res = await call(term, name, **given)
        assert isinstance(res.get("content"), list) and res["content"], name
        assert text(res).startswith(f"$ {name}") or res["is_error"], (name, text(res))
        assert "server" not in text(res).lower() or name in ("file_dev_ticket",), (name, text(res))
    assert no_sockets == []
    # what the calls made is in the workspace's files, as a server would have written it
    ws = config.workspace_dir(CORPUS)
    notes = [c for p in (ws / "notebooks").glob("*.json") for c in json.loads(p.read_text())["cells"] if c["kind"] == "note"]
    assert [c["title"] for c in notes] == ["What is this corpus?"]
    assert local.ui_records(CORPUS)[0]["kind"] in ("label", "filter", "layout")


async def test_the_tools_refuse_a_folder_of_no_workspace_and_a_browser_mode_workspace(term, tmp_path):
    res = await local.call("list_cards", {"group": "all"}, cwd=str(tmp_path))
    assert res["is_error"] and "not inside a corpus thimble knows" in text(res)
    assert not (config.WORKSPACES_DIR / tmp_path.name).exists(), "no tool call registers a folder"
    _mode("browser")
    res = await call(term, "list_cards", group="all")
    assert res["is_error"] and "browser mode" in text(res)


async def test_a_code_ticket_is_refused_and_a_card_screenshot_needs_the_harness(term):
    res = await call(term, "file_dev_ticket", title="t", body="b")
    assert res["is_error"] and (tools.hint("ticket-terminal") or "browser mode") in text(res)
    cid = re.search(r"card:([A-Za-z0-9_-]+)", text(await call(term, "add_card", question="q", kind="note", text="x"))
                    .split("\n", 1)[1]).group(1)
    res = await call(term, "screenshot", ref=f"card:{cid}")
    assert res["is_error"], "THIMBLE_RENDER is off in the suite: the harness cannot draw"


async def test_the_ui_tools_leave_records_for_the_renderer(term):
    assert not (await call(term, "set_layout", layout="columns", surfaces=["files", "report"]))["is_error"]
    assert not (await call(term, "clear_filter", scope="canvas"))["is_error"]
    recs = local.ui_records(CORPUS)
    assert [(r["n"], r["kind"]) for r in recs] == [(1, "layout"), (2, "filter")]
    assert recs[0]["args"] == {"layout": "columns", "surfaces": ["files", "report"]}
    assert [r["n"] for r in local.ui_records(CORPUS, after=1)] == [2]
    _mode("browser")
    local.ui_note(CORPUS, "layout", {"layout": "one"})
    assert len(local.ui_records(CORPUS)) == 2, "browser mode's page hears the stream instead"


async def test_state_gives_what_the_routes_give(term):
    from app import agents, concepts

    await call(term, "add_card", question="Posts?", kind="note", text="Eight.", group="G")
    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    home = await local.state(CORPUS, "home")
    assert home["cards"] == 2 and home["labels"] == 1 and home["mode"] == "terminal" and home["unread"] == []
    cards = await local.state(CORPUS, "cards", ["--since", "2000-01-01"])
    assert {c["title"] for c in cards["cells"]} >= {"Posts?"} and cards["groups"]
    assert (await local.state(CORPUS, "cards", ["--since", "2999-01-01"]))["cells"] == []
    cid = next(c["id"] for c in cards["cells"] if c["title"] == "Posts?")
    assert (await local.state(CORPUS, "card", [f"card:{cid}"]))["text"] == "Eight."
    labels = await local.state(CORPUS, "labels")
    assert [k["name"] for k in labels] == ["bash"]
    label = await local.state(CORPUS, "label", ["bash"])
    assert label["examples"]["yes"] and label["examples"]["yes"][0]["ref"].startswith("agents/")
    assert set(await local.state(CORPUS, "docs")) >= {"report"}
    meta = agents.new_thread(CORPUS, f"card:{cid}", "Eight.")
    threads = await local.state(CORPUS, "threads")
    assert any(t["id"] == meta["id"] and t["unread"] is False and t["answers"] == 0 for t in threads)
    thread = await local.state(CORPUS, "thread", [meta["id"], "--after", "0"])
    assert thread["meta"]["id"] == meta["id"] and thread["events"] == [] and thread["meta"]["answers"] == 0
    # each run that ends with an answer counts, which the renderer's row under main's latest reply follows
    _, log_path = agents.paths(CORPUS, meta["id"])
    for _ in range(2):
        agents.append(log_path, {"type": "user", "text": "Why?"})
        agents.append(log_path, {"type": "text", "delta": "Because.", "reply": True})
        agents.append(log_path, {"type": "done", "result": None})
    [row] = [t for t in await local.state(CORPUS, "threads") if t["id"] == meta["id"]]
    assert row["answers"] == 2 and row["unread"] is True
    assert (await local.state(CORPUS, "files"))[0]["path"]
    assert [f["path"] for f in (await local.state(CORPUS, "files", ["agents"]))["files"]][0] == "agents/agent-01.jsonl"
    got = await local.state(CORPUS, "resolve", [json.dumps(["board.jsonl#L1", {"ref": "board.jsonl#L1", "value": "REVIEW WANTED"},
                                                           {"ref": "board.jsonl#L1", "value": "nope 4242"}, "gone.jsonl#L1"])])
    assert [g["state"] for g in got] == ["ok", "ok", "differs", "missing"]
    # each is the ref route's answer for its ref (refs.resolve), `error` where it does not resolve
    from app import refs

    assert {k: v for k, v in got[0].items() if k != "state"} == refs.resolve(config.corpus_dir(CORPUS), "board.jsonl#L1")
    assert got[3]["error"] and got[3]["ref"] == "gone.jsonl#L1"
    agents_ = await local.state(CORPUS, "agents", ["--tail", "1"])
    assert [a["role"] for a in agents_["agents"]] == ["labels"] and len(agents_["agents"][0]["tail"]) <= 1
    with pytest.raises(local.StateError, match="no surface"):
        await local.state(CORPUS, "nope")
    with pytest.raises(local.StateError, match="no such card"):
        await local.state(CORPUS, "card", ["nope"])
    assert concepts.find_concept(config.workspace_dir(CORPUS), "bash")


async def test_act_makes_what_the_browser_makes(term, monkeypatch):
    from app import agents, concepts, events, subagents, threads

    await call(term, "apply_label", scope="files", name="bash", predicate={"kind": "regex", "text": "Bash"},
               paths=["agents/*.jsonl"])
    got = await local.act(CORPUS, "verdict", {"label": "bash", "ref": "agents/agent-01.jsonl#L1", "value": "yes"})
    assert got["ok"] and got["row"]["source"] == "analyst" and got["row"]["label"] == "yes"
    ws = config.workspace_dir(CORPUS)
    rows = [json.loads(x) for x in (ws / "labels" / f"{got['label']}.jsonl").read_text().splitlines()]
    assert rows[-1]["ref"] == "agents/agent-01.jsonl#L1" and rows[-1]["source"] == "analyst"
    # a thread: the browser's ⌘-click, its first question posted as the thread's event
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(events, "reachable", lambda c: True)

    def post(c, kind, payload, **kw):
        posted.append((kind, dict(payload)))
        return {"id": "e1", "kind": kind}

    monkeypatch.setattr(events, "post", post)
    made = await local.act(CORPUS, "thread", {"anchor": "board.jsonl#L1", "message": "Who wrote this?"})
    assert made["ok"] and posted == [("thread", {"thread": made["thread"], "text": "Who wrote this?"})]
    meta = agents.read_meta(CORPUS, made["thread"])
    assert meta["anchor"] == "board.jsonl#L1" and meta["anchor_surface"] == "terminal"
    # a sentence or a selection has no ref: the renderer sends its words as anchor_text, with a null anchor
    said = await local.act(CORPUS, "thread", {"anchor": None, "anchor_text": "Posts are short.", "message": "Why?"})
    meta2 = agents.read_meta(CORPUS, said["thread"])
    assert said["ok"] and meta2["anchor"] is None and meta2["anchor_text"] == "Posts are short."
    more = await local.act(CORPUS, "thread-message", {"thread": f"thread:{made['thread']}", "message": "And when?"})
    assert more["thread"] == made["thread"] and posted[-1] == ("thread", {"thread": made["thread"], "text": "And when?"})
    # an answer is unread until the thread is opened
    threads.reply(CORPUS, made["thread"], "agent-01 wrote it.", by="fork")
    assert threads.unread(CORPUS, agents.read_meta(CORPUS, made["thread"]))
    seen = await local.act(CORPUS, "seen", {"thread": made["thread"]})
    assert seen["seen"] >= 1 and not threads.unread(CORPUS, agents.read_meta(CORPUS, made["thread"]))
    # a stop goes through the module, as the browser's Stop does
    asked: list[str] = []

    async def stop(c, agent_id):
        asked.append(agent_id)
        return subagents.Answer({"done": True})

    monkeypatch.setattr(subagents, "stop", stop)
    assert (await local.act(CORPUS, "stop", {"agent": "a1234"}))["stopped"] is True and asked == ["a1234"]
    with pytest.raises(local.StateError, match="no act"):
        await local.act(CORPUS, "nope", {})
    with pytest.raises(local.StateError, match="empty"):
        await local.act(CORPUS, "thread", {"anchor": "x"})
    with pytest.raises(local.StateError, match="both empty"):
        await local.act(CORPUS, "thread", {"anchor": None, "message": "Why?"})
    assert concepts.find_concept(ws, "bash")


def _cli(*argv: str, env: dict | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "app.local", *argv], cwd=cwd or BACKEND, env=env or dict(os.environ),
                          capture_output=True, text=True, timeout=120)


def test_the_command_line_prints_json_and_an_error(term):
    out = _cli("state", "home", "--cwd", str(term))
    assert out.returncode == 0 and json.loads(out.stdout)["workspace"] == CORPUS
    out = _cli("state", "card", "nope", "--cwd", str(term))
    assert out.returncode == 1 and json.loads(out.stdout) == {"error": "no such card: nope"}
    out = _cli("act", "seen", "{not json", "--cwd", str(term))
    assert out.returncode == 1 and "not JSON" in json.loads(out.stdout)["error"]
    _mode("browser")
    out = _cli("act", "seen", '{"thread": "x"}', "--cwd", str(term))
    assert out.returncode == 1 and "browser mode" in json.loads(out.stdout)["error"]


def test_a_process_that_lost_its_environment_does_nothing(term, tmp_path):
    """Every THIMBLE_* gone and another home: the folder is a corpus of the test's home only, so `thimble state`,
    `thimble-run` and the shim find no workspace, refuse, and make no ~/.thimble."""
    fake = tmp_path / "fakehome"
    fake.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("THIMBLE_")}
    env["HOME"] = str(fake)
    out = _cli("state", "home", "--cwd", str(term), env=env)
    assert out.returncode == 1 and "not inside a corpus" in json.loads(out.stdout)["error"]
    run = subprocess.run([str(cardrun.bin_path()), "card", "abc"], cwd=term, env=env, capture_output=True, text=True,
                         timeout=60)
    assert run.returncode == 1 and "not inside a corpus" in run.stdout
    shim = subprocess.run([str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), "--list"], cwd=term, env=env,
                          capture_output=True, text=True, timeout=60)
    assert shim.returncode == 0
    assert not (fake / ".thimble").exists()


async def test_the_shim_in_terminal_mode_runs_calls_itself_keeps_fd_1_and_subscribes_to_nothing(term, tmp_path):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    from conftest import PLUGIN_TOKEN, _record

    # a server that records every request it gets: a browser-mode shim would subscribe and post its calls there
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    heard: list[str] = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            heard.append(f"GET {self.path}")
            self.send_response(503)
            self.end_headers()

        do_POST = do_GET  # noqa: N815

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    _record(token=PLUGIN_TOKEN, port=httpd.server_address[1])
    env = {**os.environ, "THIMBLE_CARD_CHECK": "off", "THIMBLE_CWD": str(term),
           "THIMBLE_WORKSPACES_DIR": str(config.WORKSPACES_DIR)}
    params = StdioServerParameters(command=str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"), args=[], env=env,
                                   cwd=str(term))
    fds: dict[str, str] = {}

    async def run() -> str:
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                res = await s.call_tool("add_card", {"kind": "code", "question": "How many posts?",
                                                     "code": "print(sum(1 for _ in open('board.jsonl')))"})
                assert not res.is_error, res
                pid = next(p for p in _children() if "thimble-mcp" in _cmdline(p))
                fds["1"], fds["2"] = os.readlink(f"/proc/{pid}/fd/1"), os.readlink(f"/proc/{pid}/fd/2")
                return "\n".join(getattr(b, "text", "") for b in res.content)

    try:
        out = await asyncio.wait_for(run(), 60)
    finally:
        httpd.shutdown()
    assert heard == [], "the shim reached for a server"
    cid = re.search(r"^card:([A-Za-z0-9_-]+)\s*$", out, re.M).group(1)
    assert cardrun.command("card", cid) in out, "the card waits for thimble-run: the shim ran no code"
    assert notebook.get_cell(CORPUS, cid)["run"]["state"] == "waiting"
    assert fds["1"] == fds["2"], "fd 1 points at stderr, the stream kept a copy of its own"


def _children() -> list[int]:
    me = os.getpid()
    out = []
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                stat = (p / "stat").read_text().rsplit(")", 1)[1].split()
            except OSError:
                continue
            if int(stat[1]) == me or _descends(int(p.name), me):
                out.append(int(p.name))
    return out


def _descends(pid: int, root: int) -> bool:
    seen = 0
    while pid > 1 and seen < 20:
        try:
            pid = int((Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError):
            return False
        if pid == root:
            return True
        seen += 1
    return False


def _cmdline(pid: int) -> str:
    try:
        return (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode()
    except OSError:
        return ""
