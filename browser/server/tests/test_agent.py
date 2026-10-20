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

    given = {name for f in features.all_features() for name in f.tools}
    assert set(agent.AGENTS) == {"main", "dev"}
    for name, a in agent.AGENTS.items():
        for t in a.tool_names():
            assert hasattr(tools.Tools, f"t_{t}") or t in given, (name, t)
            tools.schema_of(t)
        assert not {"Bash", "Write", "Edit", "WebFetch"} & set(a.tool_names())


def test_the_chat_agent_has_the_tools_and_prompt_of_the_features_that_are_on(tmp_path):
    main = agent.AGENTS["main"]
    assert {"add_card", "read_ref", "write_document", "propose_view", "apply_label"} <= set(main.tool_names())
    assert "## Cards" in main.prompt(tmp_path) and "## Report" in main.prompt(tmp_path)
    settings.write({"features": {"cards": False, "report": False}})
    assert not {"add_card", "write_document"} & set(main.tool_names())
    assert {"read_ref", "propose_view"} <= set(main.tool_names())
    assert "## Cards" not in main.prompt(tmp_path) and "## Report" not in main.prompt(tmp_path)
    assert "## Citing" in main.prompt(tmp_path)


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


def test_settings_refuse_what_they_do_not_know():
    for bad in ({"credentials": {"source": "wif", "file": "/made/up/wif.toml"}}, {"effort": "huge"}, {"model": "gpt"}):
        with pytest.raises(ValueError):
            settings.write(bad)


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
