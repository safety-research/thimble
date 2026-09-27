"""The dev agent's permission requests and the web tools of every session (agent_session, hosted sessions and the web;
dev.py, permissions). A dev session's hook names its key (`view:<slug>`, `ticket:<id>`) and this server; its run hosts
that key on its chat, so its requests show on the card and are answered by the workspace's mode, or denied after
dev.PERMISSION_WAIT_S unanswered. WebFetch and WebSearch ask in manual mode whatever else allows them, collapse into one
card per site or for search, and a "don't ask again" keeps the site, or web search, for the workspace."""
from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path

import pytest

from app import agent_session, agents, config, dev, ledger, orientation, permission_hook, views

CORPUS = "mini"
KEY = "view:posts"
PAGE = {"url": "https://vega.github.io/vega-lite/docs/bar.html", "prompt": "What does a bar mark take?"}
OTHER_PAGE = {"url": "https://vega.github.io/vega-lite/docs/line.html", "prompt": "And a line mark?"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agent_session._runs.clear()
    agent_session._hosted.clear()
    yield
    agent_session._runs.clear()
    agent_session._hosted.clear()


def _chat(title: str = "view: Posts") -> str:
    return str(agents.new_agent(CORPUS, "dev", title, view="posts")["id"])


def _card(chat: str) -> list[dict]:
    return agents.read_meta(CORPUS, chat).get("permissions") or []


async def _waiting(chat: str, n: int = 1) -> list[dict]:
    for _ in range(200):
        live = [p for p in _card(chat) if not p.get("expired")]
        if len(live) >= n:
            return live
        await asyncio.sleep(0.01)
    raise AssertionError(f"no {n} request(s) on the card: {_card(chat)}")


def _request(tool: str, inp: dict, key: str = KEY, **extra) -> "asyncio.Future":
    body = agent_session.PermissionRequestBody(session=key, tool_name=tool, tool_input=inp, **extra)
    return asyncio.ensure_future(agent_session.permission_request_route(CORPUS, body))


def _allowed(inp: dict) -> dict:
    return {"behavior": "allow", "updatedInput": inp}


async def test_a_dev_session_s_fetch_waits_on_its_chat_s_card_and_don_t_ask_again_keeps_the_site_for_the_workspace():
    """The hook's request for a hosted key lands on that chat's card with the exact URL, the mode, the wait and the
    site's "don't ask again"; Allow lets the fetch run. Chosen, "don't ask again" keeps the site for the workspace, so a
    later fetch from it, by this build or any other session of the workspace, runs without a card, while another site
    asks."""
    chat = _chat()
    agent_session.host(CORPUS, KEY, chat, mode="manual", wait_s=600)
    call = _request("WebFetch", PAGE)
    [p] = await _waiting(chat)
    assert (p["tool"], p["what"], p["mode"], p["wait_s"]) == ("WebFetch", PAGE["url"], "manual", 600)
    assert p["keep"] == "vega.github.io" and "always" not in p
    assert agent_session.answer(CORPUS, chat, p["id"], True)
    assert await call == _allowed(PAGE)
    call = _request("WebFetch", OTHER_PAGE)
    [p] = await _waiting(chat)
    assert (await agent_session.permission_route(CORPUS, chat, agent_session.PermissionAnswer(id=p["id"], allow=True, always=True)))["allow"]
    assert await call == _allowed(OTHER_PAGE), "the rule is the workspace's, so Claude Code is told of none"
    assert agent_session.web_rules(CORPUS) == ["WebFetch(domain:vega.github.io)"]
    assert _card(chat) == []
    assert await _request("WebFetch", {**PAGE, "url": "https://vega.github.io/vega/docs/"}) == \
        _allowed({**PAGE, "url": "https://vega.github.io/vega/docs/"})
    other = _chat("ticket #3: fix the header")
    agent_session.host(CORPUS, "ticket:abc", other, mode="manual", wait_s=600)
    assert await _request("WebFetch", PAGE, key="ticket:abc") == _allowed(PAGE), "kept for every session of the workspace"
    elsewhere = _request("WebFetch", {"url": "https://example.org/x", "prompt": "?"}, key="ticket:abc")
    [p] = await _waiting(other)
    assert p["keep"] == "example.org"
    agent_session.answer(CORPUS, other, p["id"], False)
    assert await elsewhere == {"behavior": "deny", "message": agent_session.DENIED_LINE}
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert "allow, don't ask again: vega.github.io in this workspace" in [r.get("answer") for r in log]
    assert "allow: kept for the workspace" in [r.get("answer") for r in log]


async def test_repeated_requests_for_a_site_or_for_search_collapse_into_one_card_and_share_its_answer():
    """While a fetch from a site waits, the session's later fetches from it, a subagent's too, wait on the same card,
    which lists them; its answer is theirs. Web searches collapse the same way, with web search's "don't ask again"."""
    chat = _chat()
    agent_session.host(CORPUS, KEY, chat, mode="manual", wait_s=600)
    one = _request("WebFetch", PAGE)
    [p] = await _waiting(chat)
    two = _request("WebFetch", OTHER_PAGE, agent_id="a1")
    for _ in range(100):
        if _card(chat)[0].get("also"):
            break
        await asyncio.sleep(0.01)
    [p] = _card(chat)
    assert p["what"] == PAGE["url"] and p["also"] == [OTHER_PAGE["url"]]
    agent_session.answer(CORPUS, chat, p["id"], True)
    assert await one == _allowed(PAGE) and await two == _allowed(OTHER_PAGE)
    s1 = _request("WebSearch", {"query": "vega-lite bar"})
    s2 = _request("WebSearch", {"query": "vega-lite line"})
    [p] = await _waiting(chat)
    await asyncio.sleep(0.05)
    [p] = _card(chat)
    assert p["keep"] == "web search" and p["also"] == ["vega-lite line"]
    agent_session.answer(CORPUS, chat, p["id"], True, always=True)
    assert await s1 == _allowed({"query": "vega-lite bar"}) and await s2 == _allowed({"query": "vega-lite line"})
    assert agent_session.web_rules(CORPUS) == ["WebSearch"]
    assert await _request("WebSearch", {"query": "anything"}) == _allowed({"query": "anything"})


async def test_an_unanswered_request_is_denied_after_the_wait_and_its_card_says_so_until_dismissed():
    """A hosted session's request nobody answers is denied after its wait, so the build goes on; the model is told to
    carry on without it, the thread hears of it, and the card keeps it marked denied unanswered until Dismiss or the
    run's end. Requests that joined it are denied with it."""
    chat = _chat()
    heard: list[dict] = []
    agent_session.host(CORPUS, KEY, chat, mode="manual", wait_s=0.1, on_expired=lambda run, entry: heard.append(entry))
    one = _request("WebFetch", PAGE)
    await _waiting(chat)
    two = _request("WebFetch", OTHER_PAGE)
    denied = {"behavior": "deny", "message": agent_session.timed_out_line(0.1)}
    assert await one == denied and await two == denied
    assert "Carry on without it" in denied["message"]
    [p] = _card(chat)
    assert p["expired"] and p["what"] == PAGE["url"] and [e["what"] for e in heard] == [PAGE["url"]]
    assert not agent_session.asking(CORPUS, KEY)
    assert agent_session.answer(CORPUS, chat, p["id"], False) and _card(chat) == []
    assert not agent_session.answer(CORPUS, chat, p["id"], False)
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert log[-1]["answer"] == "deny: nobody answered in time"
    waiting = _request("Bash", {"command": "curl example.org"})
    await _waiting(chat)
    assert agent_session.asking(CORPUS, KEY)
    agent_session.unhost(CORPUS, KEY)
    assert await waiting == {"behavior": "deny", "message": agent_session.GONE_LINE}
    assert _card(chat) == [] and await _request("Bash", {"command": "ls"}) == {"behavior": "deny", "message": agent_session.GONE_LINE}


async def test_a_hosted_session_follows_bypass_and_the_orientation_s_mode_while_it_runs(monkeypatch):
    """Bypass allows at once. While the orientation runs, a dev session follows its mode, so a switch of the
    orientation to Bypass allows what waits."""
    chat = _chat()
    agent_session.host(CORPUS, KEY, chat, mode="bypass", wait_s=600)
    assert await _request("WebFetch", PAGE) == _allowed(PAGE) and _card(chat) == []
    agent_session.unhost(CORPUS, KEY)
    orient = agent_session.Run(CORPUS, "orient", _chat("Orientation"), "sid", Path("."), "orient", mode="manual")
    agent_session._runs[(CORPUS, "orient")] = orient
    agent_session.host(CORPUS, KEY, chat, mode="bypass", wait_s=600)
    call = _request("WebSearch", {"query": "x"})
    [p] = await _waiting(chat)
    assert p["mode"] == "manual", "the orientation's mode, not the one it was hosted with"
    agent_session.set_mode(CORPUS, orient.chat, "bypass")
    assert await call == _allowed({"query": "x"})


async def test_a_view_build_s_bash_in_the_sandbox_runs_unasked_while_an_excluded_command_asks():
    chat = _chat()
    agent_session.host(CORPUS, KEY, chat, mode="manual", wait_s=600, sandbox=(["docker"], []))
    inp = {"command": "python3 -c 'import json; print([1, 2])'"}
    assert await _request("Bash", inp) == _allowed(inp)
    call = _request("Bash", {"command": "docker ps"})
    [p] = await _waiting(chat)
    agent_session.answer(CORPUS, chat, p["id"], False)
    assert (await call)["behavior"] == "deny"


async def test_auto_mode_s_refusal_of_a_dev_call_waits_on_the_card_and_the_call_made_again_runs():
    chat = _chat()
    agent_session.host(CORPUS, KEY, chat, mode="auto", wait_s=600)
    inp = {"command": "python3 read.py"}
    call = _request("Bash", inp, event="PermissionDenied", reason="Classifier unavailable", tool_use_id="t1")
    [p] = await _waiting(chat)
    assert p["refused"] == "Classifier unavailable" and p["command"] == "python3 read.py"
    agent_session.answer(CORPUS, chat, p["id"], True)
    assert (await call)["behavior"] == "allow"
    again = agent_session.PermissionRequestBody(session=KEY, event="PreToolUse", tool_name="Bash", tool_input=inp)
    assert (await agent_session.permission_request_route(CORPUS, again))["behavior"] == "allow"


def test_web_tools_ask_in_manual_mode_and_follow_auto_mode_s_classifier():
    """The web's ask rules go into a session's settings in manual mode (and with all edits allowed), never in auto
    mode, whose classifier judges the web, nor in bypassPermissions; a switch of the process's mode moves them."""
    assert agent_session.web_asks("default") == agent_session.web_asks("acceptEdits") == ["WebFetch", "WebSearch"]
    assert agent_session.web_asks("auto") == agent_session.web_asks("bypassPermissions") == []
    given = {"permissions": {"ask": ["Bash(rm *)"], "deny": ["Edit(//c/**)"]}}
    assert agent_session.with_web_asks(given, "default")["permissions"]["ask"] == ["Bash(rm *)", "WebFetch", "WebSearch"]
    assert agent_session.with_web_asks(agent_session.with_web_asks(given, "default"), "auto")["permissions"] == given["permissions"]
    assert agent_session.with_web_asks({}, "auto") == {}
    run = agent_session.Run(CORPUS, "orient", "c1", "sid", Path("."), "orient", mode="manual")
    run.argv = ["claude", "--settings", json.dumps(agent_session.with_web_asks({}, "default")), "--permission-mode", "default"]
    agent_session._set_flag(run, "auto")
    settings = json.loads(run.argv[2])
    assert "ask" not in settings.get("permissions", {}) and "PreToolUse" in settings["hooks"]
    agent_session._set_flag(run, "default")
    assert json.loads(run.argv[2])["permissions"]["ask"] == ["WebFetch", "WebSearch"]
    assert agent_session.web_rule("WebFetch", {"url": "not a url"}) is None
    assert agent_session.web_rule("WebFetch", {"url": "https://Docs.Python.org:443/3/"}) == "WebFetch(domain:docs.python.org)"
    assert "WebSearch" not in agent_session.own_rules()


# ----------------------------------------------------------------------------- the dev agent's flags


def _settings(flags: list[str]) -> dict:
    return json.loads(flags[flags.index("--settings") + 1])


def test_a_view_build_asks_through_the_hook_and_is_allowed_only_its_own_work(monkeypatch):
    """A hosted view build gets no --allowedTools: its settings allow edits in the view's folder, reads of the worked
    examples and its check command, sandboxed Bash runs unasked, the web asks, and the permission hook names its key and
    this server. In Auto the process runs in auto mode with the hook before each call and no web ask rules; in Bypass it
    runs in manual mode, where the hook allows each request. A session with no workspace keeps its unasked tools and
    has no web tools. MCP servers stay off."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    monkeypatch.setenv("THIMBLE_PORT", "8671")
    monkeypatch.setattr(config, "models_for", lambda c=None, settings=None: {"dev": {"model": "claude-opus-4-8", "fast": False}})
    monkeypatch.setattr(dev, "permission_mode", lambda c: "manual")
    corpus = config.corpus_dir(CORPUS)
    folder = views.views_dir(CORPUS) / "posts"
    asking = dev.view_asking(CORPUS, "posts", folder)
    flags = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder), asking)
    assert "--allowedTools" not in flags and "--strict-mcp-config" in flags
    assert flags[flags.index("--permission-mode") + 1] == "default"
    settings = _settings(flags)
    check = dev.view_check_command(CORPUS, "posts")
    assert settings["permissions"]["allow"] == [f"Edit(/{folder}/**)", f"Read(/{views.EXAMPLES_DIR}/**)", f"Bash({check})",
                                                f"Bash({check} *)"]
    assert settings["permissions"]["deny"] == [f"Edit(/{corpus}/**)", f"Edit(/{views.EXAMPLES_DIR}/**)"]
    assert settings["permissions"]["ask"] == ["WebFetch", "WebSearch"]
    assert settings["sandbox"]["autoAllowBashIfSandboxed"] is True and settings["sandbox"]["network"] == {"deniedDomains": ["*"]}
    assert set(settings["hooks"]) == {"PermissionRequest", "PermissionDenied", "PreToolUse"}
    [pre] = settings["hooks"]["PreToolUse"]
    assert pre["matcher"] == "Bash" and "sandbox_allow.py" in pre["hooks"][0]["command"], "sandboxed Bash runs unasked"
    command = settings["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
    assert command.endswith(f"--ws {CORPUS} --session view:posts --url http://127.0.0.1:8671")
    assert "WebFetch" not in flags[flags.index("--disallowedTools") + 1]
    monkeypatch.setattr(dev, "permission_mode", lambda c: "auto")
    auto = dev.Sessions()._flags(CORPUS, "thimble view: Posts", (folder,), dev.view_fence(CORPUS, "posts", corpus, folder), asking)
    assert auto[auto.index("--permission-mode") + 1] == "auto"
    assert "ask" not in _settings(auto)["permissions"]
    assert ["sandbox_allow.py" in e["hooks"][0]["command"] for e in _settings(auto)["hooks"]["PreToolUse"]] == [True, False]
    monkeypatch.setattr(dev, "permission_mode", lambda c: "bypass")
    bypass = dev.Sessions()._flags(CORPUS, "thimble ticket 1: x", (), None, {"key": "ticket:t1", "allow": dev.own_work(Path("/wt"))})
    assert bypass[bypass.index("--permission-mode") + 1] == "default" and "--allowedTools" not in bypass
    assert _settings(bypass)["permissions"] == {"allow": ["Edit(//wt/**)"], "ask": ["WebFetch", "WebSearch"]}
    offline = dev.Sessions()._flags(None, "thimble ticket: fix")
    assert offline[offline.index("--allowedTools") + 1].split(",") == dev.UNHOSTED_TOOLS
    assert offline[offline.index("--disallowedTools") + 1].split(",") == [*agent_session.LATER_TOOLS, "WebFetch", "WebSearch"]
    assert "--settings" not in offline and offline[offline.index("--permission-mode") + 1] == "default"


def test_a_dev_session_asks_in_the_orientation_s_mode_else_the_one_start_opens_on(monkeypatch):
    from app import cc_settings

    monkeypatch.setattr(cc_settings, "permission_mode", lambda cwd: "default")
    assert dev.permission_mode(CORPUS) == "manual", "the analyst's own default mode"
    ledger.put_settings(CORPUS, {"orient_permissions": "bypass"})
    assert dev.permission_mode(CORPUS) == "bypass"
    monkeypatch.setattr(orientation, "read_run", lambda c: {"permissions": "auto"})
    assert dev.permission_mode(CORPUS) == "auto", "the mode the orientation last ran in"
    agent_session._runs[(CORPUS, "orient")] = agent_session.Run(CORPUS, "orient", "c1", "sid", Path("."), "orient", mode="manual")
    assert dev.permission_mode(CORPUS) == "manual", "the running orientation's"


async def test_a_turn_waiting_on_the_card_is_not_a_question_and_a_denial_is_noted_in_the_thread(monkeypatch, tmp_path):
    """Claude Code lists a session whose hook waits as blocked; while its request is on the card the turn waits
    without counting it as a question, and it ends when the session does."""
    chat = _chat()
    lines: list[str] = []
    log = dev.Log(None)
    monkeypatch.setattr(log, "stage", lines.append)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "ASK_TIMEOUT_S", 0.05)
    monkeypatch.setattr(dev, "PERMISSION_WAIT_S", 0.3)
    dev._host(CORPUS, {"key": KEY, "allow": []}, chat, log)
    call = _request("WebFetch", PAGE)
    await _waiting(chat)

    class Fake:
        async def start(self, cwd, prompt, **kw):
            assert kw["asking"] == {"key": KEY, "allow": []}
            return {"id": "abcd1234", "session_id": "abcd1234-0000"}

        async def state(self, cwd, short):
            return "blocked" if not call.done() else "done"

        def stop(self, short):
            pass

        def transcript(self, sid):
            return None

    monkeypatch.setattr(dev, "SESSIONS", Fake())
    run = dev.Run(ticket_id="view:posts", title="Posts", ts_start=dev._now())
    await dev._worker_turn(run, log, tmp_path, "build it", None, name="thimble view: Posts", workspace=CORPUS,
                           on_session=lambda *a: None, answered=False, asking={"key": KEY, "allow": []})
    assert (await call)["behavior"] == "deny"
    assert not any("waiting for an answer" in ln for ln in lines)
    assert any(ln.startswith("nobody answered the request to use WebFetch (https://vega.github.io/") for ln in lines)
    dev._unhost(CORPUS, KEY)
    assert KEY not in {k for _, k in agent_session._hosted}


def test_the_hook_names_the_session_and_the_server_it_was_given(monkeypatch, capsys):
    """A dev session's hook takes its session key and this server from its command line, over THIMBLE_SESSION and the
    thimble home's server file, which a background session does not share."""
    sent: list[tuple[str, dict]] = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(req, timeout=None):
        sent.append((req.full_url, json.loads(req.data)))
        return Resp(json.dumps({"behavior": "allow"}).encode())

    monkeypatch.setattr(permission_hook.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(permission_hook, "server_url", lambda: "http://127.0.0.1:8300")
    monkeypatch.setenv("THIMBLE_SESSION", "orient")
    hook = {"hook_event_name": "PermissionRequest", "tool_name": "WebFetch", "tool_input": PAGE}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    permission_hook.main(["--ws", CORPUS, "--session", KEY, "--url", "http://127.0.0.1:8671"])
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow"}
    [(url, body)] = sent
    assert url == f"http://127.0.0.1:8671/api/ws/{CORPUS}/sessions/permission" and body["session"] == KEY
