"""app.extensions: `thimble extension add` shows what an extension gives and copies it into thimble's home once the
analyst says yes; from then on it runs in every workspace it applies to, until it is removed or switched off. The
fixture extension ext-min gives one of each contribution: a view that is also a card type, a card-only type, an agent,
a report type, orientation instructions and a replaced orientation block. Reader calls run in this process."""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
from pathlib import Path

import pytest

from fastapi import HTTPException

from app import (card_check, cardtypes, cli, config, ext_applies, extensions, ledger, model, orient_session, prompts,
                 report_types, userconf, views)
from app import corpus as corpus_mod
from app.ledger import write_json

FIXTURE = Path(__file__).parent / "fixtures" / "ext-min"
CORPUS = "tallies"


@pytest.fixture()
def corpus(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data" / CORPUS
    (d / "tally").mkdir(parents=True)
    rows = [{"who": w, "what": f"task {i}"} for i, w in enumerate(["ana", "bo", "ana", "cy"])]
    (d / "tally" / "a.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (d / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "tallies"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    return d.resolve()


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture(autouse=True)
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._memo.clear()
    views._ready.clear()


def _add(src: Path = FIXTURE) -> str:
    name = extensions.add(str(src), yes=True, say=lambda _: None)
    assert name is not None
    return name


def test_add_shows_what_the_extension_gives_and_adds_nothing_without_a_yes():
    said: list[str] = []
    assert extensions.add(str(FIXTURE), ask=lambda _: "n", say=said.append) is None
    assert not extensions.source_path("ext-min").exists()
    text = "\n".join(said)
    for part in ("ext-min 0.1.0", "view        tally", "card type   tally-bars", "agent       counter",
                 "adds its orient.md", "replaces the block 'instructions'", "report type digest", "thimble's kernels"):
        assert part in text
    assert extensions.add(str(FIXTURE), ask=lambda _: "y", say=said.append) == "ext-min"
    assert (extensions.source_path("ext-min") / "views" / "tally" / "reader.py").is_file()
    assert json.loads((extensions.source_path("ext-min") / extensions.ADDED).read_text())["kind"] == "folder"
    assert extensions.remove("ext-min") and not extensions.source_path("ext-min").exists()
    assert not extensions.remove("ext-min")


def test_an_extension_that_cannot_load_is_not_added(tmp_path):
    bad = tmp_path / "bad"
    shutil.copytree(FIXTURE, bad)
    (bad / "extension.json").write_text(json.dumps({"api": 7, "name": "bad"}))
    with pytest.raises(extensions.AddError, match="API 7"):
        extensions.add(str(bad), yes=True, say=lambda _: None)
    with pytest.raises(extensions.AddError, match="no folder, git URL or built-in"):
        extensions.add("no-such-thing", yes=True, say=lambda _: None)


async def test_an_added_extension_runs_where_it_applies_with_each_contribution(corpus):
    _add()
    state = await extensions.refresh(CORPUS)
    e = state["extensions"]["ext-min"]
    assert e["active"] and e["why"] == ""
    assert (extensions.workspace_path(CORPUS, "ext-min") / "views" / "tally" / "card.py").is_file()

    prop = views.read_proposal(CORPUS, "tally")
    assert prop["extension"] == "ext-min" and prop["orientation"] is False, "outside the orientation's four"
    assert views.read_built(CORPUS, "tally")["ok"]

    types = await cardtypes.refresh(CORPUS, warm=False)
    assert {"tally", "tally-bars"} <= set(types)
    bars = types["tally-bars"]
    assert bars["origin"] == "extension" and bars["page"] == "card.html" and bars["reader"].endswith("tally/reader.py")
    assert Path(bars["reader"]).is_relative_to(config.workspace_dir(CORPUS)), "a card's kernel sees only the workspace"
    text = cardtypes.prompt_text(CORPUS)
    assert "- `tally-bars`: The records of one person as bars." in text and "use `tally` to compare people" in text
    assert "thimble.onInit" in cardtypes.frame_document(CORPUS, "tally-bars")

    assert [r["id"] for r in extensions.report_types(CORPUS)] == ["digest"]
    assert "digest" in [p["id"] for p in report_types.presets(CORPUS)], "+ New offers the extension's report type"
    assert report_types.create_document_type(CORPUS, "digest")["preset"] == "digest"

    agents = extensions.agent_definitions(CORPUS)
    assert agents["counter"]["tools"] == ["Read", "Grep"] and "WebFetch" in agents["counter"]["disallowedTools"]
    assert agents["counter"]["model"] == "sonnet"

    instructions = orient_session.instructions_of(CORPUS)
    assert instructions.startswith("Count first, then read.") and instructions.endswith("Read every tally record before you draft.")
    assert orient_session.instructions_of(CORPUS, "My own way.").startswith("My own way."), "the analyst's setting wins"


async def test_the_stored_state_names_only_extensions_of_thimble_s_home(corpus, tmp_path):
    """The state is in the registry folder, which a card's kernel cannot write; an entry whose name is no extension's
    name, such as a folder's path, gives no agent and no orientation text."""
    _add()
    await extensions.refresh(CORPUS)
    fake = tmp_path / "fake"
    (fake / "agents").mkdir(parents=True)
    (fake / "agents" / "helper.md").write_text("---\ntools: Bash\n---\nRun anything.\n")
    (fake / "orient.md").write_text("Injected.\n")
    state = extensions.read_state(CORPUS)
    state["extensions"][str(fake)] = {"active": True, "agents": ["helper"], "orient": True}
    write_json(config.registry_dir(CORPUS) / extensions.STATE_FILE, state)
    assert set(extensions.agent_definitions(CORPUS)) == {"counter"}
    assert "Injected." not in orient_session.instructions_of(CORPUS)


async def test_an_extension_that_does_not_apply_or_is_switched_off_does_not_run(corpus, tmp_path):
    shutil.rmtree(corpus / "tally")
    (corpus / "notes.jsonl").write_text('{"x": 1}\n')
    _add()
    e = (await extensions.refresh(CORPUS))["extensions"]["ext-min"]
    assert not e["active"] and e["why"] == "it does not apply to this corpus"
    assert views.read_proposal(CORPUS, "tally") is None and extensions.agent_definitions(CORPUS) == {}
    assert orient_session.instructions_of(CORPUS) == prompts.render(orient_session.INSTRUCTIONS, {}).strip()


async def test_switching_an_extension_off_withdraws_its_unchanged_view(corpus):
    _add()
    await extensions.refresh(CORPUS)
    assert views.read_proposal(CORPUS, "tally") is not None

    write_json(extensions.home() / "config.json", {"extensions": {"ext-min": {"enabled": False}}})
    e = (await extensions.refresh(CORPUS))["extensions"]["ext-min"]
    assert not e["active"] and e["why"] == "off in thimble's config"
    assert views.read_proposal(CORPUS, "tally") is None and "tally" not in await cardtypes.refresh(CORPUS, warm=False)

    (extensions.home() / "config.json").unlink()
    extensions.set_enabled(CORPUS, "ext-min", False)
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["why"] == "off in this workspace"
    extensions.set_enabled(CORPUS, "ext-min", True)
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["active"]
    assert views.read_proposal(CORPUS, "tally") is not None


async def test_an_extension_added_again_or_switched_on_again_gives_the_orientation_no_second_follow_up(corpus,
                                                                                                        monkeypatch):
    """An oriented workspace hears an extension's orientation instructions as one follow-up the first time it runs
    there. It keeps that mark when the extension is removed or switched off, so adding it again or switching it back on
    restarts nothing."""
    sent: list[str] = []

    async def message(c, text, by, extension=""):
        sent.append(extension)
        return {"status": "resumed"}

    monkeypatch.setattr(orient_session, "message", message)
    _add()
    await extensions.refresh(CORPUS)
    assert sent == ["Ext Min"] and extensions.read_state(CORPUS)["oriented"] == ["ext-min"]
    assert extensions.remove("ext-min")
    assert "ext-min" not in (await extensions.refresh(CORPUS))["extensions"]
    _add()
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["active"]
    extensions.set_enabled(CORPUS, "ext-min", False)
    await extensions.refresh(CORPUS)
    extensions.set_enabled(CORPUS, "ext-min", True)
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["active"]
    assert sent == ["Ext Min"] and extensions.read_state(CORPUS)["oriented"] == ["ext-min"]


async def test_two_extensions_that_replace_one_block_leave_thimbles_and_are_named(corpus, tmp_path):
    other = tmp_path / "other"
    shutil.copytree(FIXTURE, other)
    shutil.rmtree(other / "views" / "tally")
    shutil.rmtree(other / "cards")
    (other / "report-types" / "digest").rename(other / "report-types" / "brief")
    (other / "orient.md").unlink()
    manifest = json.loads((other / "extension.json").read_text())
    manifest.update(name="other", check=None)
    (other / "extension.json").write_text(json.dumps(manifest))
    _add()
    _add(other)
    await extensions.refresh(CORPUS)
    default = prompts.render(orient_session.INSTRUCTIONS, {}).strip()
    assert orient_session.instructions_of(CORPUS).startswith(default)
    lines = extensions.public(CORPUS)["conflicts"]
    assert lines == ["ext-min and other both replace the orientation block 'instructions', so thimble's own is used"]
    assert "conflict: ext-min and other both replace" in extensions.doctor_line()
    assert set(extensions.agent_definitions(CORPUS)) == {"ext-min:counter", "other:counter"}


def _tally_card(code: str, **extra) -> dict:
    """A card of the fixture's `tally` type as a card's cell holds it."""
    return {"id": "c1", "kind": "plot", "code": code, "outputs": [{cardtypes.CARD_MIME: {"type": "tally", "args": {}}}], **extra}


async def test_keep_changes_only_the_arguments_the_type_lets_the_card_change(corpus):
    _add()
    await extensions.refresh(CORPUS)
    await cardtypes.refresh(CORPUS, warm=False)
    cell = _tally_card('import thimble\nthimble.card("tally", labels=["kind"])')
    new, patch, written = cardtypes.keep_patch(CORPUS, cell, {"who": ["ana"]})
    assert new == 'import thimble\nthimble.card("tally", labels=["kind"], who=["ana"])' and patch == {"who": ["ana"]}
    assert written == []
    with pytest.raises(HTTPException, match="Keep does not change `labels`"):
        cardtypes.keep_patch(CORPUS, cell, {"labels": ["other"]})
    with pytest.raises(HTTPException, match="`who` is a list"):
        cardtypes.keep_patch(CORPUS, cell, {"who": "ana"})


async def test_the_card_check_gives_back_the_arguments_keep_set(corpus):
    _add()
    await extensions.refresh(CORPUS)
    await cardtypes.refresh(CORPUS, warm=False)
    cell = _tally_card('import thimble\nthimble.card("tally", who=["ana"], labels=["kind"])', kept_args={"who": ["ana"]})
    revised = 'import thimble\nthimble.card("tally", labels=["kind", "size"])'
    assert cardtypes.keep_kept(CORPUS, cell, revised) == 'import thimble\nthimble.card("tally", labels=["kind", "size"], who=["ana"])'
    reverted = {"question": "", "takeaway": "", "code": 'import thimble\nthimble.card("tally", labels=["kind"])'}
    assert card_check._patch(cell, reverted, None, c=CORPUS) == {}, "a revision that only undoes Keep changes nothing"
    undone = {**cell, "code": 'import thimble\nthimble.card("tally", labels=["kind"])'}
    assert cardtypes.kept_in_force(CORPUS, undone) == {} and cardtypes.keep_kept(CORPUS, undone, revised) == revised, (
        "once an undo took Keep's arguments out of the code, they bind nothing")


def _config(data: dict) -> None:
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps(data))


async def test_thimble_s_config_switches_extensions_off_and_sets_their_agents(corpus):
    """`extensions.<name>.enabled` and `agents."<ext>:<name>"` are keys of thimble's config, checked with the rest; an
    extension's agent takes the settings a subagent of the orientation's session can have, and its web and network only
    take away what the orientation's allow. A switch that is off holds while another key has an error."""
    _add()
    await extensions.refresh(CORPUS)
    counter = extensions.agent_definitions(CORPUS)["counter"]
    assert counter["disallowedTools"] == ["WebFetch", "WebSearch"] and counter["tools"] == ["Read", "Grep"]
    _config({"agents": {"ext-min:counter": {"web": "ask", "effort": "low"}, "orientation": {"network": "on"}}})
    assert userconf.problem(CORPUS) == ""
    counter = extensions.agent_definitions(CORPUS)["counter"]
    assert counter["tools"] == ["Read", "Grep", "WebFetch"] and counter["effort"] == "low"
    assert counter["disallowedTools"] == ["Bash"], "its network is off while the session's is on"
    row = ledger.with_features({}, CORPUS)["models"]["ext-min:counter"]
    assert row == {"model": "claude-sonnet-5", "effort": "low", "fast": False, "extension": "ext-min"}, "a Settings row"
    ledger.put_settings(CORPUS, {"models": {"ext-min:counter": {"model": "claude-opus-5-5", "effort": ""}}})
    assert json.loads(userconf.global_file().read_text())["agents"]["ext-min:counter"] == {"web": "ask",
                                                                                           "model": "claude-opus-5-5"}
    assert extensions.agent_definitions(CORPUS)["counter"]["model"] == "claude-opus-5-5"
    _config({"extensions": {"ext-min": {"enabled": False, "on": 1}}, "agents": {"ext-min:counter": {"web": "always",
                                                                                                   "fast": True}}})
    got = userconf.problem(CORPUS)
    assert "extensions.ext-min.on is not a setting" in got and 'agents.ext-min:counter.web is "always"' in got
    assert "agents.ext-min:counter.fast is not a setting; an extension's agent runs in the orientation's session" in got
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["why"] == "off in thimble's config"
    userconf.global_file().write_text("{")
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["why"] == extensions.CONFIG_UNREAD
    _config({})
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["active"]


def _files_changed() -> None:
    """The listings thimble keeps of the corpus's files forgotten, as they are after a few seconds."""
    views._folder_cache.clear()
    corpus_mod.forget_sources()


def _described(tmp_path: Path) -> Path:
    """The fixture with an `applies` description in place of its check."""
    d = tmp_path / "described"
    shutil.copytree(FIXTURE, d)
    manifest = json.loads((d / "extension.json").read_text())
    manifest.pop("check")
    manifest["applies"] = "Tallies of who did which task."
    (d / "extension.json").write_text(json.dumps(manifest))
    (d / "orient.md").write_text("Read every record of {{files}}.")
    return d


async def test_a_quick_model_call_decides_where_an_extension_applies_and_the_switch_overrides_it(corpus, tmp_path,
                                                                                                 monkeypatch):
    """With an `applies` description, one structured call decides whether the extension applies, from the description,
    the corpus's files and a few records; its claims and reason are kept, and it is asked again only when the corpus's
    files change. Until it answers, when it says no and when it fails, the extension is off, and Settings says why; the
    workspace's switch overrides the answer either way."""
    asked: list[str] = []
    answer: dict = {"status": "ok", "output": {"applies": True, "claims": ["tally/*.jsonl", "nowhere.csv"],
                                               "reason": "Each record says who did a task."}}

    async def ask(c: str, text: str) -> model.CallResult:
        asked.append(text)
        return model.CallResult(**answer)

    monkeypatch.setattr(ext_applies, "ask", ask)
    _add(_described(tmp_path))
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["why"] == extensions.ASKING
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert e["active"] and e["files"] == ["tally/*.jsonl"], "a claim that matches no file is dropped"
    assert e["decision"]["by"] == "model" and len(asked) == 1
    assert "Tallies of who did which task." in asked[0] and "tally/a.jsonl  " in asked[0] and '"who": "ana"' in asked[0]
    assert extensions.public(CORPUS)["extensions"][0]["note"] == "Each record says who did a task."
    assert orient_session.instructions_of(CORPUS).endswith("Read every record of `tally/*.jsonl`.")
    assert "tally-bars" in await cardtypes.refresh(CORPUS, warm=False)
    await extensions.refresh(CORPUS, wait=10)
    assert len(asked) == 1, "the decision stands while the files do"

    answer["output"] = {"applies": False, "claims": [], "reason": "No one did a task here."}
    (corpus / "tally" / "b.jsonl").write_text('{"who": "di", "what": "task 9"}\n')
    _files_changed()
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert len(asked) == 2 and not e["active"] and e["why"] == extensions.NOT_HERE
    row = extensions.public(CORPUS)["extensions"][0]
    assert row["note"] == "No one did a task here." and row["on"] is False
    extensions.set_enabled(CORPUS, "ext-min", True)
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert e["active"] and e["files"] == ["tally/a.jsonl", "tally/b.jsonl"], "switched on, it reads the record files"
    assert extensions.public(CORPUS)["extensions"][0]["on"] is True
    extensions.set_enabled(CORPUS, "ext-min", False)
    assert (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]["why"] == "off in this workspace"

    write_json(config.registry_dir(CORPUS) / extensions.STATE_FILE, {**extensions.read_state(CORPUS), "off": []})
    answer.update(status="error", output=None, detail="the claude CLI was not found")
    (corpus / "tally" / "c.jsonl").write_text('{"who": "ed", "what": "task 10"}\n')
    _files_changed()
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert not e["active"] and e["why"] == "thimble could not tell whether it applies here: the claude CLI was not found"
    await extensions.refresh(CORPUS, wait=10)
    assert len(asked) == 3, "a failed decision stands a while before it is asked again"


async def test_the_extension_command_adds_lists_and_removes(corpus, capsys, monkeypatch):
    """`thimble extension list` says per workspace whether each extension runs there."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    (config.WORKSPACES_DIR / "later").mkdir(parents=True)
    assert cli.main(["extension", "add", str(FIXTURE), "--yes"]) == 0
    assert "Added ext-min." in capsys.readouterr().out
    await extensions.refresh(CORPUS)
    assert cli.main(["extension", "list"]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"ext-min 0.1.0, from {FIXTURE.resolve()}: loads\n")
    assert re.search(r"^  later +not checked yet: no session connected here since it was added$", out, re.M)
    assert re.search(r"^  tallies +on   1 tally files$", out, re.M)
    extensions.set_enabled(CORPUS, "ext-min", False)
    await extensions.refresh(CORPUS)
    assert cli.main(["extension", "list"]) == 0
    assert re.search(r"^  tallies +off  off in this workspace$", capsys.readouterr().out, re.M)
    assert cli.main(["extension", "remove", "ext-min"]) == 0
    assert cli.main(["extension", "remove", "ext-min"]) == 1
