"""The route plugin/bin/thimble-mcp takes to hear the browser, and the tools it lists. Without the channel, or on a
login Claude Code refuses channels to, it subscribes for the hook route and relays no permission prompt; with the
channel flag on its parent's command line naming this plugin copy it takes the channel without the launcher's
signal. A session thimble starts itself never subscribes. No shim lists a permission tool, and only the orientation's
lists critique. The server is test_shim_channel's stand-in."""
from __future__ import annotations

import json
import os
import subprocess
import time

from test_shim_channel import NOTE, SHIM, _run, _Server, server  # noqa: F401 — the fixture, used by name


def _settled(srv: _Server, after_s: float = 1.5):
    """For _run's `until`: true `after_s` after the shim subscribed, so whatever it would write from the stand-in's
    stream is written by then."""
    seen: list[float] = []

    def done() -> bool:
        if srv.queries and not seen:
            seen.append(time.monotonic())
        return bool(seen) and time.monotonic() - seen[0] > after_s

    return done


def _capabilities(out: list[dict]) -> dict:
    return next(m for m in out if m.get("id") == 0)["result"]["capabilities"]["experimental"]


def test_a_session_without_the_channel_subscribes_for_the_hook_route_and_relays_no_prompt(tmp_path, server):
    """The subscription attaches the session and keeps it alive, so the shim subscribes without the channel too, for
    the hook route (`delivery=hook`), where the server queues its events for the watcher; it relays no permission
    prompt (the PermissionRequest hook does) and writes no channel notification. A session thimble starts itself
    (THIMBLE_SESSION) never subscribes."""
    out = _run(tmp_path, server.port, channel=False, wait_s=30, until=_settled(server))
    assert _capabilities(out) == {"claude/channel": {}}
    assert server.queries and server.queries[0]["delivery"] == "hook" and server.queries[0]["session"] == "s-123"
    assert not any(m.get("method") == "notifications/claude/channel" for m in out)
    server.queries.clear()
    _run(tmp_path, server.port, channel=True, wait_s=4, until="never", extra={"THIMBLE_SESSION": "orient"})
    assert server.queries == [], "the orientation's session hears no browser events"


def test_a_session_on_an_api_key_subscribes_for_the_hook_route_even_with_the_flag(tmp_path, server):
    """Claude Code refuses channels to a login that is not a claude.ai one, so a launcher's session on an apiKeyHelper
    gets the hook route: the shim declares no permission relay and subscribes with `delivery=hook`."""
    (tmp_path / "cc").mkdir(parents=True, exist_ok=True)
    (tmp_path / "cc" / "settings.json").write_text(json.dumps({"apiKeyHelper": "print-api-key"}))
    out = _run(tmp_path, server.port, channel=True, wait_s=30, until=_settled(server))
    assert _capabilities(out) == {"claude/channel": {}}
    assert server.queries and server.queries[0]["delivery"] == "hook"
    assert not any(m.get("method") == "notifications/claude/channel" for m in out)


def test_a_session_started_with_the_channel_flag_subscribes_without_the_launcher(tmp_path, server):
    """The analyst starts `claude` with the flag themselves, so there is no THIMBLE_CHANNEL: the flag on the parent's
    command line naming this copy's channel (`plugin:thimble@inline` for plugin/ of this tree) is enough, and an entry
    for another marketplace, which Claude Code skips, is not."""
    flag = "--dangerously-load-development-channels"
    out = _run(tmp_path, server.port, channel=False, wait_s=30, parent=["--plugin-dir", str(SHIM.parents[1]), flag,
                                                                        "plugin:thimble@inline", "--effort", "high"])
    assert _capabilities(out) == {"claude/channel": {}, "claude/channel/permission": {}}
    assert [m["params"] for m in out if m.get("method") == "notifications/claude/channel"] == [NOTE]
    assert server.queries and server.queries[0]["session"] == "s-123" and server.queries[0]["delivery"] == "channel"
    server.queries.clear()
    out = _run(tmp_path, server.port, channel=False, wait_s=30, parent=[flag, "plugin:thimble@thimble-local"],
               until=_settled(server))
    assert _capabilities(out) == {"claude/channel": {}}
    assert [q["delivery"] for q in server.queries][:1] == ["hook"], "Claude Code skips that entry: the hook route"
    assert not any(m.get("method") == "notifications/claude/channel" for m in out)


def test_no_session_lists_a_permission_tool_and_only_the_orientation_s_lists_critique(tmp_path):
    """The sessions thimble starts ask through their permission hook, so no shim lists a permission-prompt tool; a view
    ticket's session checks its draft through the check route, and the critique is the orientation's alone."""
    env = {**os.environ, "THIMBLE_HOME": str(tmp_path)}
    env.pop("THIMBLE_SESSION", None)

    def names(e: dict) -> list[str]:
        out = subprocess.run([str(SHIM), "--list"], env=e, capture_output=True, text=True, check=True).stdout
        return [t["name"] for t in json.loads(out)]

    main = names(env)
    assert "ask_permission" not in main and "start_orientation" in main
    assert "save_view" not in main and "critique" not in main
    orient = names({**env, "THIMBLE_SESSION": "orient"})
    assert "ask_permission" not in orient and "critique" in orient and "save_view" not in orient
    critic = names({**env, "THIMBLE_SESSION": "critique:orient"})
    assert "ask_permission" not in critic and "critique" not in critic, "a critique's session starts no critique"
