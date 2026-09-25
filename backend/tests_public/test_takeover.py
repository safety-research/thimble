"""A second `thimble` in the same folder while the first runs on. Its /thimble makes it main, and the server tells it
which session it took over from, which `server up` prints as one line in the second terminal. When the second session
exits, main goes back to the first, whose shim is still subscribed, so the browser's next message reaches a session
instead of none. Main's meta carries what the browser says about it: the session a new main took over from in another
terminal (`attached.after`), and, with no session attached, the one that ended and its folder (`ended`)."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from test_delivery import CORPUS, Req, _cwd, _fresh, _subscribe  # noqa: F401 — the fixture, used by name

from app import cc_channel, channel, cli, session

FIRST = "11111111-aaaa-4aaa-8aaa-000000000001"
SECOND = "22222222-bbbb-4bbb-8bbb-000000000002"
OTHER = "33333333-cccc-4ccc-8ccc-000000000003"  # a `claude` in the folder that never ran /thimble


def test_main_goes_back_to_the_first_session_when_the_second_exits():
    first = _subscribe(FIRST, cc_channel.HOOK)
    session.attach(CORPUS, FIRST, _cwd(), None)
    second = _subscribe(SECOND, cc_channel.HOOK)
    session.attach(CORPUS, SECOND, _cwd(), None)
    assert session.current(CORPUS).sid == SECOND and session.sessions(CORPUS)[FIRST]["reason"] == "replaced"
    channel._subs[CORPUS].discard(second)  # the second terminal's /exit: its shim's subscription ends
    channel._routes.pop(second, None)
    session.disconnected(CORPUS, SECOND)  # no event loop here, so the grace ends at once
    assert session.current(CORPUS).sid == FIRST
    assert session.sessions(CORPUS)[SECOND]["reason"] == "ended" and not session.sessions(CORPUS)[FIRST].get("ended")
    out = channel.post(CORPUS, "main", {"text": "are you there?"})
    assert out["delivered"] == 1 and list(channel._pending[(CORPUS, FIRST)])[0]["content"] == "are you there?"
    assert first.empty(), "the hook route's event waits for the first session's watcher"


def test_the_first_session_s_watcher_waits_while_the_second_is_main_and_takes_the_next_message_after_it_exits(monkeypatch):
    """On the hook route the first session's watcher polls while the second session is main. It is not told to stop
    (410), since nothing would arm another while the first session is idle, and it takes nothing meant for the second;
    once the second exits it takes the browser's next message. A session that was never main is still told to stop."""
    monkeypatch.setattr(session, "GRACE_S", 0.0)
    _subscribe(FIRST, cc_channel.HOOK)
    session.attach(CORPUS, FIRST, _cwd(), None)
    second = _subscribe(SECOND, cc_channel.HOOK)

    async def go():
        waiting = asyncio.create_task(channel.pull_route(Req(), cwd=_cwd(), session=FIRST, wait=3))
        await asyncio.sleep(0.1)
        session.attach(CORPUS, SECOND, _cwd(), None)  # the second terminal's /thimble
        channel.post(CORPUS, "main", {"text": "for the second"})
        mine = await channel.pull_route(Req(), cwd=_cwd(), session=SECOND, wait=1)
        idle = await asyncio.wait_for(waiting, 5)
        with pytest.raises(HTTPException) as e:
            await channel.pull_route(Req(), cwd=_cwd(), session=OTHER, wait=1)
        waiting = asyncio.create_task(channel.pull_route(Req(), cwd=_cwd(), session=FIRST, wait=10))
        await asyncio.sleep(0.1)
        channel._subs[CORPUS].discard(second)  # the second terminal's /exit
        channel._routes.pop(second, None)
        session.disconnected(CORPUS, SECOND)
        await asyncio.sleep(0.1)
        channel.post(CORPUS, "main", {"text": "are you there?"})
        return mine, idle, e.value.status_code, await asyncio.wait_for(waiting, 5)

    mine, idle, never_main, got = asyncio.run(go())
    assert "\nfor the second\n" in mine["text"]
    assert idle.status_code == 204, "the replaced session's pull waits out its time and takes nothing"
    assert never_main == 410
    assert session.current(CORPUS).sid == FIRST and "\nare you there?\n" in got["text"]


def test_a_session_whose_shim_is_gone_is_not_made_main_again():
    session.attach(CORPUS, FIRST, _cwd(), None)  # the first terminal has exited: no subscription of its own
    second = _subscribe(SECOND, cc_channel.HOOK)
    session.attach(CORPUS, SECOND, _cwd(), None)
    channel._subs[CORPUS].discard(second)
    channel._routes.pop(second, None)
    session.disconnected(CORPUS, SECOND)
    assert session.current(CORPUS) is None


def test_the_second_terminal_s_slash_thimble_names_the_session_it_took_over_from(monkeypatch):
    _subscribe(FIRST, cc_channel.HOOK)
    session.attach(CORPUS, FIRST, _cwd(), None)

    async def name_twice() -> tuple[dict, dict]:
        body = channel.SessionBody(session=SECOND, cwd=_cwd())
        try:
            return await channel.session_route(CORPUS, body), await channel.session_route(CORPUS, body)
        finally:
            session.detach(CORPUS, SECOND)  # its tail task ends with this loop

    first, again = asyncio.run(name_twice())
    assert first["replaced"] == FIRST and again["replaced"] is None, "naming itself again takes nothing"
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (200, {"attached": True, "replaced": FIRST}))
    assert cli.name_session("http://127.0.0.1:1", CORPUS, SECOND, cli.Path(_cwd())) == FIRST
    line = cli.TAKEOVER_LINE.format(other=FIRST[:8])
    assert line.startswith("thimble: this session is main now.") and FIRST[:8] in line


def _main() -> dict:
    return session.agents.ensure_main(CORPUS)


def test_a_session_that_ends_leaves_its_folder_on_main_until_one_attaches_again():
    """The browser's overlay names the folder `thimble --continue` resumes in, from main's `ended`; any attach clears
    it."""
    sub = _subscribe(FIRST, cc_channel.CHANNEL)
    session.attach(CORPUS, FIRST, _cwd(), None)
    assert _main()["attached"]["session"] == FIRST and not _main().get("ended")
    channel._subs[CORPUS].discard(sub)  # the terminal's Claude Code quit
    channel._routes.pop(sub, None)
    session.disconnected(CORPUS, FIRST)
    meta = _main()
    assert meta["attached"] is None
    assert meta["ended"]["session"] == FIRST and meta["ended"]["cwd"] == _cwd() and meta["ended"]["at"]
    session.attach(CORPUS, FIRST, _cwd(), None)  # `thimble --continue` resumes it under the same id
    assert _main()["attached"]["session"] == FIRST and _main()["ended"] is None
    assert "after" not in _main()["attached"]


def test_a_second_terminal_s_session_names_the_one_it_took_main_from():
    _subscribe(FIRST, cc_channel.CHANNEL)
    session.connected(CORPUS, FIRST, _cwd(), 4242)
    _subscribe(SECOND, cc_channel.CHANNEL)
    session.connected(CORPUS, SECOND, _cwd(), 5151)
    meta = _main()
    assert meta["attached"]["session"] == SECOND and meta["attached"]["after"] == FIRST
    assert meta["ended"] is None, "main never had no session, so the browser shows no overlay"


def test_clear_in_the_same_process_and_a_terminal_that_quit_name_no_session_taken_over():
    _subscribe(FIRST, cc_channel.CHANNEL)
    session.connected(CORPUS, FIRST, _cwd(), 4242)
    _subscribe(SECOND, cc_channel.CHANNEL)
    session.connected(CORPUS, SECOND, _cwd(), 4242)  # /clear: a new id in main's own `claude` process
    assert session.current(CORPUS).sid == SECOND and "after" not in _main()["attached"]
    channel._subs.clear()
    channel._routes.clear()
    third = "33333333-cccc-4ccc-8ccc-000000000003"
    session.attach(CORPUS, third, _cwd(), None)  # a new `thimble` after the last one's shim went away
    assert _main()["attached"]["session"] == third and "after" not in _main()["attached"]


def test_main_handed_back_to_the_first_terminal_names_the_session_that_ended():
    _subscribe(FIRST, cc_channel.HOOK)
    session.attach(CORPUS, FIRST, _cwd(), None)
    second = _subscribe(SECOND, cc_channel.HOOK)
    session.attach(CORPUS, SECOND, _cwd(), None)
    channel._subs[CORPUS].discard(second)
    channel._routes.pop(second, None)
    session.disconnected(CORPUS, SECOND)
    meta = _main()
    assert meta["attached"]["session"] == FIRST and meta["attached"]["after"] == SECOND and meta["ended"] is None
