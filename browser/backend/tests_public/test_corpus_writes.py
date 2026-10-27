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


# --------------------------------------------------------------------------- a view's own folders (runtime.agent_writes)


def agent(sp: runtime.Space, role: str, key: str = "") -> runtime.Spec:
    return sp.spec_of(runtime.Conv(sp, "a2", "agent", agent_id="a2", role=role, key=key))


async def write(spec: runtime.Spec, path) -> runtime_tools.Out:
    return await runtime_tools.call(box(spec), "Write", {"file_path": str(path), "content": "x"})


async def test_a_view_s_builder_and_reviewer_write_its_folder_and_their_own_alone(space, tmp_path):
    from app import dev, views  # noqa: PLC0415

    folder, other = views.views_dir(CORPUS) / "posts", views.views_dir(CORPUS) / "other"
    work = dev.view_work_dir(CORPUS, "posts")
    other.mkdir(parents=True)
    for role, key in (("view-builder", "view:posts"), ("view-reviewer", "review:posts")):
        spec = agent(space, role, key)
        assert spec.write_roots[:2] == [folder, work] and len(spec.write_roots) == 3, role
        for p in (folder / "view.json", work / "draft.py"):
            got = await write(spec, p)
            assert not got.is_error and p.read_text() == "x", (role, got.text)
        # another view, the extension's own files, the views' state, a way out by .. or by a link: refused
        (folder / "out").symlink_to(other)
        for p in (other / "view.json", views.local_dir(CORPUS) / "extension.json", space.ws / "views" / "x.json",
                  space.ws / "registry" / "x", folder / ".." / "other" / "view.json", folder / "out" / "view.json",
                  space.ws / "writers" / "x.md", space.corpus / "x.txt"):
            got = await write(spec, p)
            assert got.is_error and not p.exists(), (role, p)
        (folder / "out").unlink()
        # Claude Code's settings: Edit and the sandbox's writes allowed in the two folders, extension/ no longer denied
        # (a deny would win over the allow), the other protected folders still denied
        cc = runtime_cc.settings(spec, True, tmp_path)
        assert f"Edit(/{folder}/**)" in cc["permissions"]["allow"] and f"Edit(/{work}/**)" in cc["permissions"]["allow"]
        assert not any("/extension" in r for r in cc["permissions"]["deny"])
        assert f"Edit(/{space.ws / 'registry'}/**)" in cc["permissions"]["deny"]
        fs = cc["sandbox"]["filesystem"]
        assert str(folder) in fs["allowWrite"] and str(views.views_dir(CORPUS)) not in fs["allowWrite"]
        assert str(views.local_dir(CORPUS)) not in fs["denyWrite"] and str(space.ws / "trusted") in fs["denyWrite"]


async def test_no_other_agent_writes_a_view_s_folder(space, tmp_path):
    from app import views  # noqa: PLC0415

    folder = views.views_dir(CORPUS) / "posts"
    folder.mkdir(parents=True)
    others = {"writer": agent(space, "writer", "writer:report"), "main": space.spec_of(space.main),
              # a view's role whose start names no view, another view's kind or a slug that is no slug
              "builder without a key": agent(space, "view-builder"),
              "builder with a review's key": agent(space, "view-builder", "review:posts"),
              "reviewer with a build's key": agent(space, "view-reviewer", "view:posts"),
              "builder with a path for a slug": agent(space, "view-builder", "view:../../trusted")}
    for who, spec in others.items():
        assert views.local_dir(CORPUS) in spec.no_write, who
        assert not any(w == folder or folder in w.parents or w in folder.parents for w in spec.write_roots), who
        got = await write(spec, folder / "view.json")
        assert got.is_error and not (folder / "view.json").exists(), who
        deny = runtime_cc.settings(spec, True, tmp_path)["permissions"]["deny"]
        assert f"Edit(/{views.local_dir(CORPUS)}/**)" in deny, who
    for who in ("builder without a key", "builder with a review's key", "reviewer with a build's key",
                "builder with a path for a slug"):
        assert len(others[who].write_roots) == 1, who  # its temp folder alone


async def test_an_agent_takes_the_key_of_the_start_the_server_recorded(space, monkeypatch):
    from app import subagents  # noqa: PLC0415

    monkeypatch.setattr(runtime, "_spawn_task", lambda coro, name: coro.close())
    rid = subagents.new_request(CORPUS, "start", "view:posts", {"prompt": "p"}, {}, subagents.CLICK, role="view-builder")
    got = runtime._spawn_agent(space, {"role": "view-builder", "request": rid})
    assert space.convs[got["agentId"]].key == "view:posts"
    # another role's request, or none: no key
    got = runtime._spawn_agent(space, {"role": "view-reviewer", "request": rid})
    assert space.convs[got["agentId"]].key == ""
    got = runtime._spawn_agent(space, {"role": "view-builder"})
    assert space.convs[got["agentId"]].key == ""
