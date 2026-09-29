"""app.extensions: `thimble extension add` shows what an extension gives and copies it into thimble's home once the
analyst says yes; from then on it runs in every workspace it applies to, until it is removed or switched off. The
fixture extension ext-min gives one of each contribution: a view that is also a card type, a card-only type, an agent,
a report type, orientation instructions and a replaced orientation block. Reader calls run in this process."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
from pathlib import Path

import pytest

from fastapi import HTTPException

from app import card_check, cardtypes, cli, config, extensions, orient_session, prompts, report_types, views
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


async def test_two_extensions_that_replace_one_block_leave_thimbles_and_are_named(corpus, tmp_path):
    other = tmp_path / "other"
    shutil.copytree(FIXTURE, other)
    shutil.rmtree(other / "views" / "tally")
    shutil.rmtree(other / "cards")
    (other / "report-types" / "digest").rename(other / "report-types" / "brief")
    (other / "orient.md").unlink()
    manifest = json.loads((other / "extension.json").read_text())
    manifest.update(name="other", applies=None)
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


def test_the_config_keys_of_extensions_are_checked():
    assert extensions.config_problems({"extensions": {"a": {"enabled": False}}, "agents": {"a:b": {"web": "off"}}}) == []
    got = extensions.config_problems({"extensions": {"a": {"on": 1}}, "agents": {"a:b": {"web": "always"}}})
    assert got == ["extensions.a.on is not a setting; it takes enabled", "agents.a:b.web is \"always\"; it takes off, ask, allow"]


def test_the_extension_command_adds_lists_and_removes(capsys):
    assert cli.main(["extension", "add", str(FIXTURE), "--yes"]) == 0
    assert "Added ext-min." in capsys.readouterr().out
    assert cli.main(["extension", "list"]) == 0
    assert capsys.readouterr().out.startswith(f"ext-min  0.1.0  {FIXTURE.resolve()}  on")
    assert cli.main(["extension", "remove", "ext-min"]) == 0
    assert cli.main(["extension", "remove", "ext-min"]) == 1
