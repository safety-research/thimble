"""The agent loop's own rules: what a thread copies, a stopped turn left valid, and credentials only from Settings."""
import os

import pytest

from thimble_browser import agent, features, llm, settings, tools


def test_a_thread_copies_main_up_to_its_last_finished_turn():
    msgs = [{"role": "user", "content": "q1"},
            {"role": "assistant", "content": [{"type": "text", "text": "a1"}]},
            {"role": "user", "content": "q2"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]}]
    assert agent.complete_prefix(msgs) == msgs[:2]
    assert agent.complete_prefix([{"role": "user", "content": "q"}]) == []


def test_every_agent_has_a_fixed_tool_set_and_no_shell():
    from thimble_browser.features import views  # noqa: F401  (adds the view builder)

    from thimble_browser import fixcopy  # noqa: PLC0415  (the fix tools, confined to a fix's copy)

    given = {name for f in features.all_features() for name in f.tools} | set(fixcopy.TOOLS)
    assert set(agent.AGENTS) == {"main", "checker", "designer", "dev"}
    for name, a in agent.AGENTS.items():
        for t in a.tool_names():
            assert hasattr(tools.Tools, f"t_{t}") or t in given, (name, t)
            tools.schema_of(t)
        assert not {"Bash", "Write", "Edit", "WebFetch"} & set(a.tool_names())
        assert a.allowed is None or set(a.allowed) <= set(a.tool_names()), name
    # the copies of a conversation run main's tools, so their requests read main's cache, and may call only a few
    assert agent.AGENTS["checker"].allowed == ("Read", "Grep", "Glob", "run_python")
    assert agent.AGENTS["designer"].allowed == ("Read", "Grep", "Glob", "run_python", "card")


async def test_a_copy_may_call_only_its_allowed_tools(folder):
    t = tools.Tools("ws", "c1", folder, allowed=("Read",), denied="only reads")
    r = await t.call("run_python", {"code": "print(1)"})
    assert r.is_error and r.text == "only reads"
    assert not (await t.call("Read", {"file_path": "runs/a.jsonl"})).is_error


def test_the_environment_gives_no_credentials(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_SOMETHING", "x")
    assert "ANTHROPIC_SOMETHING" in llm.scrub_env()
    assert not any(k.startswith("ANTHROPIC_") for k in os.environ)
    with pytest.raises(llm.NoCredentials):
        llm.client()
    assert llm.describe() == "none"


def test_the_api_key_file_is_the_users_alone():
    settings.write({"credentials": {"source": "key"}})
    settings.set_api_key("sk-test-not-real")
    st = settings._key_path().stat()
    assert oct(st.st_mode & 0o777) == "0o600"
    assert llm.client() is not None
    settings.set_api_key("")
    with pytest.raises(llm.NoCredentials):
        llm.client()


async def test_reading_stays_inside_the_folder(folder, tmp_path):
    (tmp_path / "secret.txt").write_text("no")
    os.symlink(tmp_path / "secret.txt", folder / "link.txt")
    t = tools.Tools("ws", "main", folder)
    assert (await t.call("Read", {"file_path": "runs/a.jsonl"})).text.startswith("1\t")
    for p in ("../secret.txt", str(tmp_path / "secret.txt"), "link.txt"):
        r = await t.call("Read", {"file_path": p})
        assert r.is_error and "outside" in r.text
    r = await t.call("Grep", {"pattern": "merged"})
    assert "runs/a.jsonl:2:" in r.text and not r.is_error
    assert (await t.call("Read", {"offset": 3})).is_error  # the schema needs file_path
