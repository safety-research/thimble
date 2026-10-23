"""Main and its thread forks write the corpus folder, as Claude Code does in its own folder, unless the analyst turns
Settings' "Claude can edit files in this folder" off for the workspace (ledger.corpus_edits, runtime.spec_of).
thimble's other agents never write it, and no agent writes thimble's private files or the workspace's protected files.
Both engines honor the switch: the Messages API's tools (runtime_tools.Box, its srt rules) and Claude Code's settings
(runtime_cc.settings). The prompt and the tools' descriptions say what holds, and name the switch when it is off."""
from __future__ import annotations

import json

import pytest

from app import config, ledger, runtime, runtime_api, runtime_cc, runtime_tools

CORPUS = "mini"
SWITCH = "Claude can edit files in this folder"


@pytest.fixture()
def space(monkeypatch, workspaces_tmp, data_tmp):
    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    config.workspace_dir(CORPUS)
    runtime._spaces.clear()
    yield runtime.ensure(CORPUS)
    runtime._spaces.clear()


def specs(sp: runtime.Space) -> dict[str, runtime.Spec]:
    return {"main": sp.spec_of(sp.main), "fork": sp.spec_of(runtime.Conv(sp, "f1", "fork", agent_id="f1")),
            "writer": sp.spec_of(runtime.Conv(sp, "a1", "agent", agent_id="a1", role="writer"))}


def box(spec: runtime.Spec) -> runtime_tools.Box:
    return runtime_tools.Box(cwd=spec.cwd, workspace=spec.workspace, read_roots=spec.read_roots,
                             write_roots=spec.write_roots, private=spec.private, home=spec.home,
                             no_write=spec.no_write, corpus_edits=spec.corpus_edits)


def descriptions(spec: runtime.Spec) -> str:
    return json.dumps(runtime_tools.definitions(["Bash", "Write", "Edit"], spec.corpus_edits))


async def test_main_and_its_forks_write_the_corpus_by_default_and_the_switch_turns_it_off(space, analyst):
    corpus = space.corpus
    assert ledger.get_settings(CORPUS)["corpus_edits"] is True
    on = specs(space)
    for who in ("main", "fork"):
        assert corpus in on[who].write_roots and on[who].corpus_edits is True, who
    assert corpus not in on["writer"].write_roots and on["writer"].corpus_edits is None
    assert "reads and writes the corpus folder" in on["main"].system and f'"{SWITCH}"' in on["main"].system
    assert "which it reads and writes" in descriptions(on["main"])
    assert "cannot write" in descriptions(on["writer"]) and SWITCH not in descriptions(on["writer"])

    # a derived file goes into the corpus; thimble's private files and the workspace's protected files never do
    got = await runtime_tools.call(box(on["main"]), "Write", {"file_path": "spans.jsonl", "content": "{}\n"})
    assert not got.is_error and (corpus / "spans.jsonl").read_text() == "{}\n"
    for p in [*on["main"].private[:1], space.ws / "settings.json"]:
        got = await runtime_tools.call(box(on["main"]), "Write", {"file_path": str(p), "content": "x"})
        assert got.is_error and "thimble" in got.text, p
    got = await runtime_tools.call(box(on["writer"]), "Write", {"file_path": "w.txt", "content": "x"})
    assert got.is_error and not (corpus / "w.txt").exists() and SWITCH not in got.text

    # the analyst turns it off: the next turn's main and forks keep the corpus read-only and name the switch
    ledger.put_settings_route(CORPUS, analyst, {"corpus_edits": False})
    assert ledger.stored_settings(CORPUS)["corpus_edits"] is False and not ledger.corpus_edits(CORPUS)
    off = specs(space)
    for who in ("main", "fork"):
        assert corpus not in off[who].write_roots and off[who].corpus_edits is False, who
    assert "cannot write it" in off["main"].system and f'"{SWITCH}" back on in Settings' in off["main"].system
    assert SWITCH in descriptions(off["main"]) and "read-only" in descriptions(off["main"])
    got = await runtime_tools.call(box(off["main"]), "Write", {"file_path": "spans2.jsonl", "content": "{}\n"})
    assert got.is_error and SWITCH in got.text and not (corpus / "spans2.jsonl").exists()

    # null puts the default back, and only the analyst's browser changes it
    ledger.put_settings_route(CORPUS, analyst, {"corpus_edits": None})
    assert "corpus_edits" not in ledger.stored_settings(CORPUS) and ledger.corpus_edits(CORPUS)
    from starlette.requests import Request  # noqa: PLC0415

    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, Request({"type": "http", "headers": []}), {"corpus_edits": False})
    assert getattr(e.value, "status_code", None) == 403 and ledger.corpus_edits(CORPUS)
    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, analyst, {"corpus_edits": "no"})
    assert getattr(e.value, "status_code", None) == 400


def test_claude_code_s_settings_follow_the_switch(space, analyst, tmp_path):
    def allowed(spec: runtime.Spec) -> tuple[bool, bool, list[str]]:
        got = runtime_cc.settings(spec, True, tmp_path)
        edit = f"Edit(/{spec.cwd}/**)"
        fs = got["sandbox"]["filesystem"]
        return (edit in got["permissions"]["allow"] and edit not in got["permissions"]["deny"]
                and str(spec.cwd) in fs["allowWrite"], edit in got["permissions"]["deny"], fs["denyWrite"])

    on = specs(space)
    ok, denied, deny = allowed(on["main"])
    assert ok and not denied and str(on["main"].private[0]) in deny and str(space.ws / "settings.json") in deny
    assert allowed(on["writer"])[:2] == (False, True)
    ledger.put_settings_route(CORPUS, analyst, {"corpus_edits": False})
    assert allowed(specs(space)["main"])[:2] == (False, True)


async def test_the_api_engine_s_bash_writes_the_corpus_only_while_the_switch_is_on(space, analyst):
    if why := runtime_tools.sandbox_reason():
        pytest.skip(why)
    corpus = space.corpus
    cmd = {"command": "(echo x > made.txt) 2>/dev/null && echo written || echo refused"}
    private = space.spec_of(space.main).private[0]
    private.parent.mkdir(parents=True, exist_ok=True)
    private.write_text("secret")
    out = await runtime_tools.call(box(space.spec_of(space.main)), "Bash", cmd)
    assert out.text.strip() == "written" and (corpus / "made.txt").is_file(), out.text
    out = await runtime_tools.call(box(space.spec_of(space.main)), "Bash", {
        "command": f"(echo x > {private}) 2>/dev/null && echo written || echo refused"})
    assert out.text.strip() == "refused" and private.read_text() == "secret", out.text
    (corpus / "made.txt").unlink()
    ledger.put_settings_route(CORPUS, analyst, {"corpus_edits": False})
    out = await runtime_tools.call(box(space.spec_of(space.main)), "Bash", cmd)
    assert out.text.strip() == "refused" and not (corpus / "made.txt").exists(), out.text


def test_the_checker_s_fork_never_writes_the_corpus(space, monkeypatch):
    """runtime_api.fork_stream sends main's tools as they are, for the cache, but its box leaves the corpus out."""
    seen = {}

    class Stop(Exception):
        pass

    def grab(**kw):
        seen.update(kw)
        raise Stop

    monkeypatch.setattr(runtime_tools, "Box", grab)
    import asyncio  # noqa: PLC0415

    with pytest.raises(Stop):
        asyncio.run(runtime_api.fork_stream(CORPUS, "check", model="claude-opus-5-5", effort=None))
    assert space.corpus not in seen["write_roots"] and seen["write_roots"]
