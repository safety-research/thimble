"""notices.py: a failure of one of thimble's agents told in the foreground with its fix. An open notice is one per key,
kept in the workspace's notices file (GET /notices) and written as a row in its agent's chat; clear (a later success)
and dismiss (the analyst's x) take it away, each with its `notice` event."""
from __future__ import annotations


import pytest

from app import notices

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


async def test_h4_the_page_stopped_notice_goes_once_the_server_follows_main_again(sent, tmp_path, monkeypatch):
    """Bug hunt H4: the MCP shim posts `page:stopped` ("thimble's page stopped. thimble's tools wait for it.") when the
    server answers neither of its looks. It stayed in the terminal's band and above the browser's composer after
    /thimble browser brought the page back. It goes once the server follows main again (session.attach, which the
    press and the shim's subscription run), and the stream tells the browser."""
    from app import config, session

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    session._live.clear()
    stopped = notices.post(CORPUS, kind="server", text="thimble's page stopped. thimble's tools wait for it.",
                           key=notices.PAGE_STOPPED_KEY)
    other = notices.post(CORPUS, kind="proposals", text="Another failure.", key="k")
    try:
        session.attach(CORPUS, "5e55a000-0000-4000-8000-0000000000a4", str(config.corpus_dir(CORPUS)))
    finally:
        session._live.clear()
    assert [n["id"] for n in notices.open_notices(CORPUS)] == [other["id"]]
    assert {"type": "notice", "id": stopped["id"], "key": notices.PAGE_STOPPED_KEY, "cleared": True} in sent


async def test_h16_the_shim_tells_of_a_server_gone_within_seconds_with_its_fix_as_an_act(sent, monkeypatch):
    """Bug hunt H16: a killed server was told in the terminal only at main's next call of a thimble tool, and its notice
    ("thimble's page stopped. thimble's tools wait for it.") had no fix but dismiss. The shim's subscription posts it
    once the subscription it held dropped and no server has answered for a while, with /thimble browser as its act in
    the terminal, and once only; while a server answers, nothing."""
    import importlib.machinery
    import importlib.util
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import anyio

    from app import config, local

    loader = importlib.machinery.SourceFileLoader("shim_h16", str(config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"))
    shim = importlib.util.module_from_spec(importlib.util.spec_from_loader("shim_h16", loader))
    loader.exec_module(shim)

    class Server(BaseHTTPRequestHandler):
        def do_GET(self):  # the subscription's keep-alive, then the connection ends (HTTP/1.0); health answers too
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b": keep-alive\n\n")

        def log_message(self, *args):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Server)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setattr(shim, "server", lambda: (base, "a-token"))
    monkeypatch.setattr(shim, "signed", lambda token, at: ({}, "proof"))
    monkeypatch.setattr(shim, "proven", lambda resp, proof: True)
    monkeypatch.setattr(shim, "main_transport", lambda: shim.activate.SERVER)
    monkeypatch.setattr(shim, "transport_now", lambda: shim.activate.SERVER)
    monkeypatch.setattr(shim, "continued", lambda: False)
    monkeypatch.setattr(shim, "workspace", lambda: CORPUS)
    monkeypatch.setattr(shim, "session_id", lambda: "5e55a000-0000-4000-8000-0000000000b6")
    monkeypatch.setattr(shim, "RETRY_S", 0.05)
    monkeypatch.setenv("THIMBLE_MCP_STOPPED_S", "0.3")
    posts: list[str] = []
    post = notices.post
    monkeypatch.setattr(notices, "post", lambda c, **kw: posts.append(kw.get("key") or "") or post(c, **kw))
    stopped = lambda: [n for n in notices.open_notices(CORPUS) if n["key"] == notices.PAGE_STOPPED_KEY]  # noqa: E731
    async with anyio.create_task_group() as tg:
        tg.start_soon(shim.subscription, "hook")
        await anyio.sleep(0.6)
        assert stopped() == [], "a server that answers is no stopped page"
        srv.shutdown()
        srv.server_close()
        with anyio.fail_after(10):
            while not stopped():
                await anyio.sleep(0.05)
        await anyio.sleep(0.5)
        tg.cancel_scope.cancel()
    [n] = stopped()
    assert n["action"] == {"label": "start it again", "do": "page-start"}
    assert "/thimble browser" in n["text"]
    assert posts == [notices.PAGE_STOPPED_KEY], "posted once, not at each look"
    assert local._notice_acts(n["action"]) == [{"label": "start it again", "act": "page-start"}], "the terminal's act"


@pytest.mark.parametrize("line,words,fix", [
    ("API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).",
     "Claude's safeguards stopped its request; rephrase or narrow the request and try again", None),
    ("API Error: 404 model: claude-x not found", "its model isn't available to your account; pick another model in "
     "Settings", notices.SETTINGS),
])
def test_a_failure_s_words_name_the_fix(line, words, fix):
    assert notices.reason(line) == (words, fix)
