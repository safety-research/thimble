"""app.extensions: `thimble extension add` lists each contribution of an extension and copies it into thimble's home
once the analyst says yes; from then on it runs in every workspace until it is removed or switched off, and only its
views check whether they fit a corpus. The fixture extension ext-min gives one of each contribution: a view that is
also a card type, a card-only type, an agent, a report type and orientation instructions. Reader calls run in this
process, and the quick model call that checks whether a view fits answers from `fit`."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import shutil
import tracemalloc
from pathlib import Path

import pytest

from fastapi import HTTPException

from app import (card_check, cardtypes, cli, config, extension_manifest, extensions, ledger, model, orient_session,
                 prompts, report_types, userconf, view_fit, views)
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


@pytest.fixture(autouse=True)
def fit(monkeypatch) -> dict:
    """The check on whether a view fits, in place: it answers `answer`, and keeps the prompts it got in `asked`."""
    got: dict = {"asked": [], "answer": {"status": "ok", "output": {"fits": True, "reason": "Each record says who did a task."}}}

    async def ask(c: str, text: str) -> model.CallResult:
        got["asked"].append(text)
        return model.CallResult(**got["answer"])

    monkeypatch.setattr(view_fit, "ask", ask)
    return got


def _add(src: Path = FIXTURE) -> str:
    names = extensions.add(str(src), yes=True, say=lambda _: None)
    assert names is not None
    return names[0]


def _copy(tmp_path: Path, name: str, **manifest) -> Path:
    d = tmp_path / name
    shutil.copytree(FIXTURE, d)
    raw = json.loads((d / "extension.json").read_text())
    raw.update(name=name, **manifest)
    (d / "extension.json").write_text(json.dumps(raw))
    return d


def _files_changed() -> None:
    """The listings thimble keeps of the corpus's files forgotten, as they are after a few seconds."""
    views._folder_cache.clear()
    corpus_mod.forget_sources()


def test_a_thimble_range_reads_as_package_json_s_engines():
    cases = {">=0.4": True, ">=0.5": False, "^0.4": True, "^0.3": False, "~0.4.0": True, "0.4.x": True, "0.4": True,
             ">0.4": False, "<=0.4": True, ">=0.3 <0.4": False, "<0.4 || >=0.4.0": True, "0.3 - 0.4": True, "*": True}
    assert {r: extensions.in_range("0.4.0", r) for r in cases} == cases
    assert extensions.in_range("0.4.0", "newest") is None


def test_add_lists_each_contribution_with_its_own_description_and_adds_nothing_without_a_yes():
    said: list[str] = []
    assert extensions.add(str(FIXTURE), ask=lambda _: "n", say=said.append) is None
    assert not extensions.source_path("ext-min").exists()
    text = "\n".join(said)
    for part in ("ext-min 0.1.0", "view        tally: Each record of the tally files, counted by who made it. Also a card type.",
                 "card type   tally-bars: The records of one person as bars.",
                 "agent       counter: Counts the tally records of the places it is given.",
                 "orientation Tally-aware orientation. It adds to the orientation's instructions.",
                 "report type digest: A one-page digest of the tally.", "It works with thimble >=0.4.",
                 "thimble's kernels"):
        assert part in text
    assert f"ext-min 0.1.0, used in place from {FIXTURE.resolve()}" in said
    assert extensions.add(str(FIXTURE), ask=lambda _: "y", say=said.append) == ["ext-min"]
    assert extensions.linked("ext-min"), "a local folder is used in place"
    assert (extensions.source_path("ext-min") / "views" / "tally" / "reader.py").is_file()
    assert json.loads(extensions._record_file("ext-min").read_text())["kind"] == "folder"
    assert not (FIXTURE / extensions.ADDED).exists(), "thimble writes nothing into a folder used in place"
    assert extensions.remove("ext-min") and not extensions.source_path("ext-min").exists()
    assert (FIXTURE / "extension.json").is_file(), "removing it leaves the folder"
    assert not extensions.remove("ext-min")


async def test_what_an_extension_needs_is_checked_and_what_it_waits_for_leaves_it_unloaded_and_named(corpus, tmp_path):
    """An npm package its views do not hold stops the add, as does a library that is no package; a thimble outside its
    range, a Python package that is not installed and an extension that is not added leave it added but unloaded, and
    Settings, the list and doctor say why. An extension it needs that thimble ships is listed and added on the same yes,
    and it runs only where that one runs."""
    with pytest.raises(extensions.AddError, match="loads d3, which its lib folder does not hold"):
        _add(_copy(tmp_path, "d3ish", dependencies={"js": ["d3"]}))
    with pytest.raises(extensions.AddError, match="neither one of vega, vega-lite, vega-embed nor an npm package"):
        _add(_copy(tmp_path, "badlib", dependencies={"js": ["not a package!"]}))
    half = _copy(tmp_path, "d3half", dependencies={"js": ["d3@7"]})
    (half / "views" / "tally" / "lib").mkdir()
    (half / "views" / "tally" / "lib" / "libs.json").write_text(json.dumps({"d3@7": {"file": "d3@7.0.0.js", "kind": "js"}}))
    (half / "views" / "tally" / "lib" / "d3@7.0.0.js").write_text("window.d3 = {}")
    with pytest.raises(extensions.AddError, match="its card type 'tally-bars' loads d3@7, which its lib folder"):
        _add(half)
    with pytest.raises(extensions.AddError, match="no folder, git URL or built-in"):
        extensions.add("no-such-thing", yes=True, say=lambda _: None)

    said: list[str] = []
    extensions.add(str(_copy(tmp_path, "later", thimble=">=9")), yes=True, say=said.append)
    assert "  It stays unloaded until then: it works with thimble >=9, and this is thimble 0.4.0." in said
    assert all(extensions._importable(x) for x in ("pyyaml", "PyYAML", "yaml", "pandas>=1", "python-dateutil"))
    assert not extensions._importable("pandas>=999")
    _add(_copy(tmp_path, "heavy", dependencies={"python": ["no_such_package_xyz"]}))
    e = (await extensions.refresh(CORPUS))["extensions"]
    assert not e["later"]["active"] and e["later"]["why"] == "it works with thimble >=9, and this is thimble 0.4.0"
    assert e["heavy"]["why"] == "it needs the Python package no_such_package_xyz, which thimble does not install"
    assert "heavy 0.1.0 (not loaded: it needs the Python package no_such_package_xyz" in extensions.doctor_line()
    row = next(x for x in extensions.public(CORPUS)["extensions"] if x["name"] == "later")
    assert row["locked"] and row["why"].startswith("it works with thimble >=9")
    for n in ("later", "heavy"):
        extensions.remove(n)

    said = []
    extensions.add(str(_copy(tmp_path, "needy", dependencies={"extensions": ["swarm-orient", "nope"]})), yes=True,
                   say=said.append)
    assert "It needs swarm-orient, which is added with it:" in said and extensions.source_path("swarm-orient").is_dir()
    assert "  It stays unloaded until then: it needs the extension nope, which is not added." in said
    e = (await extensions.refresh(CORPUS))["extensions"]
    assert e["swarm-orient"]["active"] and e["needy"]["why"] == "it needs the extension nope, which is not added"
    assert e["multiagent-swimlane"]["active"] and e["swarm-orient"]["files"] == ["*.jsonl", "*.csv"]
    extensions.set_enabled(CORPUS, "multiagent-swimlane", False)
    e = (await extensions.refresh(CORPUS))["extensions"]
    assert e["swarm-orient"]["why"] == "it needs the extension multiagent-swimlane, which does not run here"


async def test_thimble_adds_the_extensions_it_ships_on_once_and_names_the_others_not_added(corpus, tmp_path, monkeypatch):
    """video ships added: thimble's first run adds it, it runs and switches off as any other, and once removed it stays
    removed. swarm-orient and multiagent-swimlane ship off: Settings and the list name them as not added. A built-in
    whose copy nobody changed follows the version thimble ships; one that now needs a built-in the analyst removed stays
    unloaded rather than adding it back."""
    assert extensions.ship() == ["video"] and extensions.ship() == []
    assert (await extensions.refresh(CORPUS))["extensions"]["video"]["active"]
    assert [t["id"] for t in extensions.report_types(CORPUS)] == ["video"]
    rows = {r["name"]: r for r in extensions.public(CORPUS)["extensions"]}
    assert rows["video"]["on"] and not rows["video"]["locked"] and rows["video"]["builtin"]
    for n in ("swarm-orient", "multiagent-swimlane"):
        assert (rows[n]["on"], rows[n]["locked"], rows[n]["addable"], rows[n]["builtin"]) == (False, False, True, True)
        assert rows[n]["note"] == "", "off reads as off: its switch adds it"
    assert rows["swarm-orient"]["needs"] == ["multiagent-swimlane"] and rows["multiagent-swimlane"]["needs"] == []
    assert "swarm-reader:" in rows["swarm-orient"]["consent"], "what its switch would run, before it adds it"
    assert rows["multiagent-swimlane"]["sandboxed"] is not None and rows["swarm-orient"]["sandboxed"] is None
    assert ("swarm-orient 0.4.0, built in, not added. `thimble extension add swarm-orient` adds it."
            in extensions.list_lines(config.WORKSPACES_DIR))
    extensions.set_enabled(CORPUS, "video", False)
    assert (await extensions.refresh(CORPUS))["extensions"]["video"]["why"] == "off in this workspace"
    assert extensions.remove("video") and extensions.ship() == [] and "video" not in extensions.added()

    ships = tmp_path / "ships"
    shutil.copytree(extensions.builtin_dir(), ships)
    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    assert extensions.add("swarm-orient", yes=True, say=lambda _: None) == ["swarm-orient", "multiagent-swimlane"]
    prompt = Path("agents") / "orientation" / "prompt.md"
    (ships / "swarm-orient" / prompt).write_text("Read every record.\n")
    assert extensions.ship() == ["swarm-orient"]
    assert (extensions.source_path("swarm-orient") / prompt).read_text() == "Read every record.\n"
    (extensions.source_path("swarm-orient") / prompt).write_text("Mine.\n")
    (ships / "swarm-orient" / prompt).write_text("Read each record.\n")
    assert extensions.ship() == [] and (extensions.source_path("swarm-orient") / prompt).read_text() == "Mine.\n"
    assert extensions.remove("multiagent-swimlane")
    extensions.remove("swarm-orient")
    old = tmp_path / "old-ships"
    shutil.copytree(ships / "swarm-orient", old / "swarm-orient")
    (old / "swarm-orient" / "extension.json").write_text('{"name": "swarm-orient", "version": "0.3.0"}')
    monkeypatch.setattr(extensions, "builtin_dir", lambda: old)
    assert extensions.add("swarm-orient", yes=True, say=lambda _: None) == ["swarm-orient"]
    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    assert extensions.ship() == ["swarm-orient"] and "multiagent-swimlane" not in extensions.added()
    assert (await extensions.refresh(CORPUS))["extensions"]["swarm-orient"]["why"] == (
        "it needs the extension multiagent-swimlane, which is not added")


def _before_the_rename(base: Path) -> Path:
    """thimble's built-ins as an earlier build shipped them, in `base`: swarm-orient as `swarm`."""
    shutil.copytree(extensions.builtin_dir(), base)
    os.replace(base / "swarm-orient", base / "swarm")
    raw = json.loads((base / "swarm" / "extension.json").read_text())
    (base / "swarm" / "extension.json").write_text(json.dumps({**raw, "name": "swarm"}))
    return base


async def test_an_install_that_added_swarm_has_it_as_swarm_orient_without_the_analyst_doing_anything(
        corpus, tmp_path, monkeypatch, capsys):
    """An earlier build added swarm, set its swarm-reader's model in thimble's config and its effort in the workspace's,
    and its orientation instructions ran. Once this build runs, all of it is swarm-orient's: the copy, unchanged, is the
    version thimble ships, the settings are under the new name in both files, the workspace's copy is replaced, and
    Settings does not offer to run the instructions again. The old name still works in the commands, which say the new
    one."""
    ships = extensions.builtin_dir()
    old = _before_the_rename(tmp_path / "old-ships")
    monkeypatch.setattr(extensions, "builtin_dir", lambda: old)
    assert extensions.add("swarm", yes=True, say=lambda _: None) == ["swarm", "multiagent-swimlane"]
    await extensions.refresh(CORPUS)
    await extensions.mark_oriented(CORPUS, ["swarm"])
    write_json(userconf.global_file(), {"agents": {"swarm:swarm-reader": {"model": "claude-opus-4-8"}}})
    write_json(userconf.workspace_file(CORPUS), {"agents": {"swarm:swarm-reader": {"effort": "low"}}})
    assert extensions.workspace_path(CORPUS, "swarm").is_dir()

    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    assert extensions.ship() == ["swarm-orient", "video"] and extensions.ship() == []
    assert sorted(extensions.added()) == ["multiagent-swimlane", "swarm-orient", "video"]
    new = extensions.source_path("swarm-orient")
    assert extensions.digest(new)[0] == extensions.digest(ships / "swarm-orient")[0]
    rec = json.loads((new / extensions.ADDED).read_text())
    assert (rec["kind"], rec["source"], rec["digest"]) == ("built-in", "swarm-orient", extensions.digest(new)[0])
    assert json.loads(userconf.global_file().read_text()) == {
        "agents": {"swarm-orient:swarm-reader": {"model": "claude-opus-4-8"}}}
    conf = userconf.load(CORPUS)
    assert json.loads(userconf.workspace_file(CORPUS).read_text()) == {
        "agents": {"swarm-orient:swarm-reader": {"effort": "low"}}}
    assert {k: v for k, v in userconf.extension_agent(conf, "swarm-orient:swarm-reader").items() if v} == {
        "model": "claude-opus-4-8", "effort": "low", "web": "off", "network": "on"}

    state = await extensions.refresh(CORPUS)
    assert "swarm" not in state["extensions"] and state["extensions"]["swarm-orient"]["active"]
    assert state["oriented"] == ["swarm-orient"], "its instructions ran, so Settings does not offer them again"
    assert not extensions.workspace_path(CORPUS, "swarm").exists()
    assert extensions.workspace_path(CORPUS, "swarm-orient").is_dir()
    reader = extensions.agent_definitions(CORPUS)["swarm-reader"]
    assert (reader["model"], reader["effort"]) == ("claude-opus-4-8", "low")

    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    assert cli.cmd_extension(argparse.Namespace(ext_cmd="off", name="swarm")) == 0
    out = capsys.readouterr().out
    assert "swarm is now called swarm-orient." in out and "swarm-orient is off in every workspace." in out
    assert userconf.extensions_off() == {"swarm-orient"}
    assert cli.cmd_extension(argparse.Namespace(ext_cmd="remove", name="swarm")) == 0
    assert "Removed swarm-orient." in capsys.readouterr().out and "swarm-orient" not in extensions.added()
    assert cli.cmd_extension(argparse.Namespace(ext_cmd="add", source="swarm", yes=True)) == 0
    out = capsys.readouterr().out
    assert "swarm is now called swarm-orient." in out and "swarm-orient is on." in out
    assert "swarm-orient" in extensions.added() and userconf.extensions_off() == set()


async def test_a_changed_copy_of_swarm_keeps_its_changes_and_an_extension_of_the_analyst_s_own_keeps_its_name(
        corpus, tmp_path, tmp_path_factory, monkeypatch):
    """A copy of swarm the analyst changed is swarm-orient with their changes, which thimble's versions then leave alone.
    A workspace's switches of swarm are swarm-orient's. An unchanged copy of swarm beside an added swarm-orient goes. A
    link to the folder thimble shipped swarm in links to swarm-orient's. An extension of the analyst's own called swarm
    keeps its name and its settings."""
    ships = extensions.builtin_dir()
    old = _before_the_rename(tmp_path / "old-ships")
    monkeypatch.setattr(extensions, "builtin_dir", lambda: old)
    extensions.add("swarm", yes=True, say=lambda _: None)
    prompt = Path("agents") / "orientation" / "prompt.md"
    (extensions.source_path("swarm") / prompt).write_text("Mine.\n")
    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    assert extensions.ship() == ["swarm-orient", "video"] and not extensions.source_path("swarm").exists()
    new = extensions.source_path("swarm-orient")
    assert (new / prompt).read_text() == "Mine.\n"
    assert extensions.read_extension(new, "swarm-orient")["problems"] == []
    assert extensions.ship() == [] and (new / prompt).read_text() == "Mine.\n"

    write_json(config.registry_dir(CORPUS) / extensions.STATE_FILE, {
        "off": ["swarm"], "oriented": [], "declined": ["swarm"], "shown": {"swarm/lanes": True},
        "extensions": {"swarm": {"active": False, "why": "off in this workspace"}}})
    state = extensions.read_state(CORPUS)
    assert (state["off"], state["declined"], state["shown"]) == (["swarm-orient"], ["swarm-orient"],
                                                                 {"swarm-orient/lanes": True})
    assert list(state["extensions"]) == ["swarm-orient"]
    assert extensions.off_in("swarm-orient") == [CORPUS]
    assert (await extensions.refresh(CORPUS))["extensions"]["swarm-orient"]["why"] == "off in this workspace"

    extensions.remove("swarm-orient")
    monkeypatch.setattr(extensions, "builtin_dir", lambda: old)
    extensions.add("swarm", yes=True, say=lambda _: None)
    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    extensions.add("swarm-orient", yes=True, say=lambda _: None)
    assert extensions.ship() == [] and "swarm" not in extensions.added(), "an unchanged copy beside the new name goes"

    extensions.remove("swarm-orient")
    dev =_before_the_rename(tmp_path_factory.mktemp("checkout") / "extensions")
    monkeypatch.setattr(extensions, "builtin_dir", lambda: dev)
    assert extensions.add(str(dev / "swarm"), yes=True, say=lambda _: None) == ["swarm"]
    shutil.rmtree(dev)
    shutil.copytree(ships, dev)
    assert extensions.ship() == ["swarm-orient"] and not extensions.source_path("swarm").is_symlink()
    assert os.path.realpath(extensions.source_path("swarm-orient")) == os.path.realpath(dev / "swarm-orient")
    assert extensions.read_extension(extensions.source_path("swarm-orient"), "swarm-orient")["problems"] == []

    extensions.remove("swarm-orient")
    _add(_copy(tmp_path, "swarm"))
    write_json(userconf.global_file(), {"extensions": {"swarm": {"enabled": False}},
                                        "agents": {"swarm:counter": {"model": "claude-opus-4-8"}}})
    assert extensions.foreign("swarm") and extensions.renamed("swarm") == "swarm"
    assert extensions.ship() == [] and extensions.linked("swarm") and "swarm-orient" not in extensions.added()
    assert userconf.extensions_off() == {"swarm"} and "swarm:counter" in userconf.load()["agents"]
    assert "swarm:counter" in json.loads(userconf.global_file().read_text())["agents"]


async def test_settings_adds_an_extension_thimble_ships_when_its_switch_is_turned_on(corpus, analyst, tmp_path,
                                                                                    monkeypatch):
    """Turning on the switch of an extension thimble ships that is not added adds it, with those it needs, for the
    analyst's browser only; nothing else can be added that way."""
    from starlette.requests import Request

    ships = tmp_path / "ships"
    shutil.copytree(extensions.builtin_dir(), ships)
    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    with pytest.raises(HTTPException) as refused:
        await extensions.add_route(CORPUS, "swarm-orient", Request({"type": "http", "headers": []}))
    assert refused.value.status_code == 403 and "swarm-orient" not in extensions.added()
    with pytest.raises(HTTPException) as unknown:
        await extensions.add_route(CORPUS, "no-such", analyst)
    assert unknown.value.status_code == 404
    got = await extensions.add_route(CORPUS, "swarm-orient", analyst)
    assert {"swarm-orient", "multiagent-swimlane"} <= set(extensions.added())
    rows = {r["name"]: r for r in got["extensions"]}
    assert rows["swarm-orient"]["active"] and rows["swarm-orient"]["on"] and not rows["swarm-orient"].get("addable")


async def test_an_added_extension_runs_in_every_workspace_and_its_view_where_it_fits(corpus, fit):
    _add()
    state = await extensions.refresh(CORPUS, wait=10)
    e = state["extensions"]["ext-min"]
    assert e["active"] and e["why"] == ""
    assert (extensions.workspace_path(CORPUS, "ext-min") / "views" / "tally" / "card.py").is_file()
    assert len(fit["asked"]) == 1 and "Each record of the tally files, counted by who made it." in fit["asked"][0]
    assert "tally/a.jsonl  " in fit["asked"][0] and '"who": "ana"' in fit["asked"][0]

    prop = views.read_proposal(CORPUS, "tally")
    assert prop["extension"] == "ext-min" and prop["orientation"] is False, "outside the orientation's four"
    assert views.read_built(CORPUS, "tally")["ok"]
    row = extensions.public(CORPUS)["extensions"][0]
    assert row["views"] == [{"slug": "tally", "name": "Tally", "shown": True, "note": "Each record says who did a task.",
                             "on": True, "locked": False}]

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
    assert set(agents) == {"counter"}, "agents/orient.md is no agent"
    assert agents["counter"]["tools"] == ["Read", "Grep"] and "WebFetch" in agents["counter"]["disallowedTools"]
    assert agents["counter"]["model"] == "sonnet"

    default = prompts.render(orient_session.INSTRUCTIONS, {}).strip()
    instructions = orient_session.instructions_of(CORPUS)
    assert instructions == f"{default}\n\n#### ext-min\n\nRead every tally record in `tally/*.jsonl` before you draft."
    assert orient_session.instructions_of(CORPUS, "My own way.").startswith("My own way."), "the analyst's setting wins"


async def test_a_view_json_in_the_schema_s_form_keeps_its_scope_and_derived_fields_when_installed(corpus, tmp_path):
    """A view.json written the way extension.schema.json documents it, with `scope` and the derived fields in
    `records`, is installed with its records kept, and the view header's derived fields are those it declares."""
    d = _copy(tmp_path, "schema-form")
    vj = d / "views" / "tally" / "view.json"
    raw = json.loads(vj.read_text())
    del raw["claims"]
    raw.update(scope=["tally/*.jsonl"], compare=True, records=[{"name": "row", "fields": [
        {"name": "who", "type": "category"},
        {"name": "person", "type": "text", "derived": "cleaned", "from": "who", "how": "title-cased"},
        {"name": "busy", "type": "category", "derived": "computed", "from": "each person's rows", "how": "more than one"}]}])
    vj.write_text(json.dumps(raw))
    _add(d)
    await extensions.refresh(CORPUS, wait=10)
    v = views.read_built(CORPUS, "tally")
    assert v["ok"] and v["claims"] == ["tally/*.jsonl"] and v["compare"] is True
    assert [(x["field"], x["kind"]) for x in v["derived"]] == [("busy", "inferred"), ("person", "")]
    assert json.loads((Path(v["dir"]) / "view.json").read_text())["records"] == raw["records"]
    assert [x["field"] for x in await views.derived_fields(CORPUS, "tally", v)] == ["busy", "person"]


async def test_an_extension_view_that_fails_the_view_checks_is_hidden_and_settings_says_why(corpus, tmp_path, monkeypatch):
    """Once an extension's view is installed in a workspace it runs the checks a built view passes; a page that
    anchors no record, so no label could mark it, fails them and is hidden there with the first failure in Settings,
    and the view's switch still shows it."""
    if why := views.build_problem():
        if os.environ.get("CI") == "true":
            pytest.fail(why)
        pytest.skip(why)
    import asyncio

    monkeypatch.setenv("THIMBLE_EXTENSION_VIEW_CHECKS", "on")
    views._bind_loop()
    _add()
    await extensions.refresh(CORPUS, wait=10)
    assert views.read_built(CORPUS, "tally")["ok"], "installed while its checks run"
    for _ in range(600):
        if "ext-min/tally" in extensions.read_gates(CORPUS) and not any(not t.done() for t in extensions._gating.values()):
            break
        await asyncio.sleep(0.05)
    gate = extensions.read_gates(CORPUS)["ext-min/tally"]
    assert gate["ok"] is False and "data-anchor" in gate["why"], gate
    await extensions.refresh(CORPUS)
    row = extensions.public(CORPUS)["extensions"][0]
    (v,) = row["views"]
    assert not v["shown"] and v["note"].startswith("its checks failed here: "), v
    assert views.read_built(CORPUS, "tally") is None, "the failed view is taken out"
    extensions.set_view(CORPUS, "ext-min", "tally", True)
    await extensions.refresh(CORPUS)
    assert extensions.public(CORPUS)["extensions"][0]["views"][0]["shown"], "the switch overrides the checks"


async def test_a_view_shows_where_its_check_finds_it_fits_and_its_switch_overrides_the_check(corpus, fit):
    """The check is asked once per view and workspace and again only when the files it claims change, the last answer
    standing meanwhile. Until it first answers, when it says no and when it fails, the view is hidden and Settings says
    why, while the extension's other contributions run; the view's switch overrides the check either way."""
    _add()
    first = (await extensions.refresh(CORPUS))["extensions"]["ext-min"]
    assert first["active"] and first["views"][0]["note"] == extensions.CHECKING and not first["views"][0]["shown"]
    assert views.read_proposal(CORPUS, "tally") is None and "counter" in extensions.agent_definitions(CORPUS)
    await extensions.refresh(CORPUS, wait=10)
    await extensions.refresh(CORPUS, wait=10)
    assert len(fit["asked"]) == 1 and views.read_proposal(CORPUS, "tally") is not None, "the answer stands while the files do"

    fit["answer"]["output"] = {"fits": False, "reason": "No one did a task here."}
    (corpus / "tally" / "b.jsonl").write_text('{"who": "di", "what": "task 9"}\n')
    _files_changed()
    e = (await extensions.refresh(CORPUS))["extensions"]["ext-min"]
    assert e["views"][0]["shown"] and e["views"][0]["note"] == extensions.CHECKING, "the last answer stands meanwhile"
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert len(fit["asked"]) == 2 and e["active"] and not e["views"][0]["shown"]
    assert views.read_proposal(CORPUS, "tally") is None, "its unchanged view is withdrawn"
    assert "tally-bars" in await cardtypes.refresh(CORPUS, warm=False), "a card type joins where its claims match files"
    view = extensions.public(CORPUS)["extensions"][0]["views"][0]
    assert view["note"] == "No one did a task here." and view["on"] is False
    extensions.set_view(CORPUS, "ext-min", "tally", True)
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert e["views"][0]["shown"] and views.read_proposal(CORPUS, "tally") is not None
    assert extensions.public(CORPUS)["extensions"][0]["views"][0]["on"] is True

    write_json(config.registry_dir(CORPUS) / extensions.STATE_FILE, {**extensions.read_state(CORPUS), "shown": {}})
    fit["answer"] = {"status": "error", "output": None, "detail": "the claude CLI was not found"}
    (corpus / "tally" / "c.jsonl").write_text('{"who": "ed", "what": "task 10"}\n')
    _files_changed()
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert not e["views"][0]["shown"]
    assert e["views"][0]["note"] == "thimble could not tell whether it fits here: the claude CLI was not found"
    await extensions.refresh(CORPUS, wait=10)
    assert len(fit["asked"]) == 3, "a failed check stands a while before it is asked again"

    fit["answer"] = {"status": "ok", "output": {"fits": True, "reason": "Each record says who did a task."}}
    state = extensions.read_state(CORPUS)
    state["extensions"]["ext-min"]["views"][0]["fit"]["ts"] = "2000-01-01T00:00:00+00:00"
    write_json(config.registry_dir(CORPUS) / extensions.STATE_FILE, state)
    assert (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]["views"][0]["shown"]
    extensions.set_enabled(CORPUS, "ext-min", False)
    await extensions.refresh(CORPUS)
    extensions.set_enabled(CORPUS, "ext-min", True)
    e = (await extensions.refresh(CORPUS))["extensions"]["ext-min"]
    assert e["views"][0]["shown"] and len(fit["asked"]) == 4, "switching it off and on keeps the answer"

    shutil.rmtree(corpus / "tally")
    (corpus / "notes.jsonl").write_text('{"x": 1}\n')
    _files_changed()
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert e["active"] and e["views"][0]["note"] == extensions.NO_FILES and len(fit["asked"]) == 4
    assert extensions.public(CORPUS)["extensions"][0]["views"][0]["locked"]


async def test_a_view_s_check_lands_while_its_files_keep_changing(corpus, monkeypatch):
    """An answer to files that changed while it was asked still stands, and the next check waits a while, so a corpus
    that is still being written shows the view and asks the model once."""
    asked: list[int] = []

    async def ask(c: str, text: str) -> model.CallResult:
        asked.append(1)
        (corpus / "tally" / "a.jsonl").open("a").write('{"who": "ana", "what": "live"}\n')
        _files_changed()
        return model.CallResult(status="ok", output={"fits": True, "reason": "Each record says who did a task."})

    monkeypatch.setattr(view_fit, "ask", ask)
    _add()
    for _ in range(3):
        e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]
    assert e["views"][0]["shown"] and e["views"][0]["fit"]["stale"] and len(asked) == 1


async def test_a_big_csv_is_checked_with_a_few_of_its_records(corpus, fit, tmp_path):
    """The check sends a few records of each likely file, so a big CSV costs little memory."""
    d = _copy(tmp_path, "metrics")
    raw = json.loads((d / "views" / "tally" / "view.json").read_text())
    (d / "views" / "tally" / "view.json").write_text(json.dumps({**raw, "claims": ["metrics.csv"]}))
    with open(corpus / "metrics.csv", "w") as f:
        f.write("ts,host,metric,value,status\n" + "2026-05-16T08:00:00Z,web-1,cpu,0.93,ok\n" * 1_000_000)
    _add(d)
    tracemalloc.start()
    try:
        await extensions.refresh(CORPUS, wait=10)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < (corpus / "metrics.csv").stat().st_size / 20, peak
    assert "metrics.csv  " in fit["asked"][-1] and fit["asked"][-1].count("web-1,cpu") == 5, (
        "its first record and four through it")


async def test_the_stored_state_names_only_extensions_of_thimble_s_home(corpus, tmp_path):
    """The state is in the registry folder, which a card's kernel cannot write; an entry whose name is no extension's
    name, such as a folder's path, gives no agent and no orientation text."""
    _add()
    await extensions.refresh(CORPUS, wait=10)
    fake = tmp_path / "fake"
    (fake / "agents").mkdir(parents=True)
    (fake / "agents" / "helper.md").write_text("---\ntools: Bash\n---\nRun anything.\n")
    (fake / "orient.md").write_text("Injected.\n")
    state = extensions.read_state(CORPUS)
    state["extensions"][str(fake)] = {"active": True, "agents": ["helper"], "orient": "orient.md"}
    write_json(config.registry_dir(CORPUS) / extensions.STATE_FILE, state)
    assert set(extensions.agent_definitions(CORPUS)) == {"counter"}
    assert "Injected." not in orient_session.instructions_of(CORPUS)


async def test_an_extension_switched_off_does_not_run_and_its_unchanged_view_goes(corpus):
    _add()
    await extensions.refresh(CORPUS, wait=10)
    assert views.read_proposal(CORPUS, "tally") is not None

    write_json(extensions.home() / "config.json", {"extensions": {"ext-min": {"enabled": False}}})
    e = (await extensions.refresh(CORPUS))["extensions"]["ext-min"]
    assert not e["active"] and e["why"] == "off in thimble's config"
    assert views.read_proposal(CORPUS, "tally") is None and "tally" not in await cardtypes.refresh(CORPUS, warm=False)
    assert extensions.agent_definitions(CORPUS) == {} and extensions.report_types(CORPUS) == []
    assert orient_session.instructions_of(CORPUS) == prompts.render(orient_session.INSTRUCTIONS, {}).strip()

    (extensions.home() / "config.json").unlink()
    extensions.set_enabled(CORPUS, "ext-min", False)
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["why"] == "off in this workspace"
    extensions.set_enabled(CORPUS, "ext-min", True)
    assert (await extensions.refresh(CORPUS, wait=10))["extensions"]["ext-min"]["active"]
    assert views.read_proposal(CORPUS, "tally") is not None


async def test_switching_on_an_extension_offers_to_run_its_orientation_instructions(corpus, monkeypatch, analyst):
    """Where an orientation ran, an extension with orientation instructions that comes on is offered, never sent on its
    own: Run now sends its instructions once as a follow-up, Not now stops the offer, and switching it off and on again
    offers it again. An orientation that starts reads them in its prompt, so nothing is offered after it."""
    sent: list[tuple[str, str]] = []

    async def message(c, text, by, extension=""):
        sent.append((extension, text))
        return {"status": "resumed"}

    monkeypatch.setattr(orient_session, "message", message)
    ran = {"yes": False}
    monkeypatch.setattr(extensions, "orientation_ran", lambda c: ran["yes"])
    _add()
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == [] and sent == [], "no orientation ran here: it reads them when it starts"
    await extensions.mark_oriented(CORPUS)
    ran["yes"] = True
    assert extensions.offered(CORPUS) == []

    extensions.set_enabled(CORPUS, "ext-min", False)
    await extensions.refresh(CORPUS)
    extensions.set_enabled(CORPUS, "ext-min", True)
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == ["ext-min"] and sent == []
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "ext-min")
    assert row["offer"] and row["orients"]
    from starlette.requests import Request

    with pytest.raises(HTTPException) as refused:
        await extensions.orientation_route(CORPUS, "ext-min", extensions.OrientBody(run=True),
                                           Request({"type": "http", "headers": []}))
    assert refused.value.status_code == 403 and sent == [], "only the analyst's browser answers"
    got = await extensions.orientation_route(CORPUS, "ext-min", extensions.OrientBody(run=True), analyst)
    assert got["status"] == "resumed" and not next(r for r in got["extensions"] if r["name"] == "ext-min")["offer"]
    assert sent == [("ext-min", "Read every tally record in `tally/*.jsonl` before you draft.")]
    assert extensions.offered(CORPUS) == []
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == [] and len(sent) == 1

    broken = {"yes": True}
    check = extension_manifest.check
    monkeypatch.setattr(extension_manifest, "check", lambda root, expect=None: [
        extension_manifest.Problem("extension.json", 1, "is not JSON")] if broken["yes"] else check(root, expect))
    assert not (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["active"]
    broken["yes"] = False
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == [] and len(sent) == 1, "a problem fixed is not a switch turned on"

    assert extensions.remove("ext-min")
    await extensions.refresh(CORPUS)
    _add()
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == ["ext-min"], "added again, it is offered again"
    await extensions.decline(CORPUS, "ext-min")
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == [] and len(sent) == 1


async def test_an_orient_md_that_replaces_takes_the_place_of_thimble_s_instructions(corpus, tmp_path, monkeypatch):
    """With `replace: true` the body stands in for thimble's instructions and its tools, model and effort are
    ignored; the analyst's own instructions win; two extensions that replace them leave thimble's, and are named. Run
    now sends a replacement only where it would stand in the prompt."""
    sent: list[str] = []

    async def message(c, text, by, extension=""):
        sent.append(extension)
        return {"status": "resumed"}

    monkeypatch.setattr(orient_session, "message", message)
    monkeypatch.setattr(extensions, "orientation_ran", lambda c: True)
    write_json(config.workspace_dir(CORPUS) / "settings.json", {orient_session.SETTING: "My own way."})
    solo = _copy(tmp_path, "solo")
    shutil.rmtree(solo / "views")
    shutil.rmtree(solo / "cards")
    (solo / "agents" / "orient.md").write_text("---\nreplace: true\n---\nLabel everything.\n")
    _add(solo)
    await extensions.refresh(CORPUS)
    assert await extensions.run_orientation(CORPUS, "solo") == {"status": "nothing"}
    assert sent == [] and orient_session.instructions_of(CORPUS) == "My own way."
    extensions.remove("solo")
    write_json(config.workspace_dir(CORPUS) / "settings.json", {})

    d = _copy(tmp_path, "mine")
    shutil.rmtree(d / "views")
    shutil.rmtree(d / "cards")
    (d / "agents" / "orient.md").write_text("---\nreplace: true\ntools: Bash\nmodel: haiku\n---\nCount first, then read.\n")
    _add(d)
    await extensions.refresh(CORPUS)
    assert sent == [] and extensions.offered(CORPUS) == ["mine"]
    await extensions.run_orientation(CORPUS, "mine")
    assert sent == ["mine"] and orient_session.instructions_of(CORPUS) == "Count first, then read."
    assert orient_session.instructions_of(CORPUS, "My own way.") == "My own way."
    assert set(extensions.agent_definitions(CORPUS)) == {"counter"}

    other = _copy(tmp_path, "other")
    shutil.rmtree(other / "views")
    shutil.rmtree(other / "cards")
    (other / "agents" / "orient.md").write_text("---\nreplace: true\n---\nRead first.\n")
    _add(other)
    await extensions.refresh(CORPUS)
    assert await extensions.run_orientation(CORPUS, "other") == {"status": "nothing"}
    assert sent == ["mine"], "a replacement two extensions give is sent by neither"
    assert orient_session.instructions_of(CORPUS) == prompts.render(orient_session.INSTRUCTIONS, {}).strip()
    lines = extensions.public(CORPUS)["conflicts"]
    assert lines == ["mine and other both replace the orientation's instructions, so thimble's own are used"]
    assert "conflict: mine and other both replace" in extensions.doctor_line()
    assert set(extensions.agent_definitions(CORPUS)) == {"mine:counter", "other:counter"}


async def test_an_extension_written_before_the_spec_settled_still_loads(corpus, tmp_path, fit):
    """The old keys are read: `requires` as dependencies.python, `replaces` as orientation instructions in place of
    thimble's, orient.md beside extension.json, report-types/ with `default`, and a view.json with `why`, `declares`,
    `applies`, `show` and `reports`. `api`, `title`, `description`, `applies` and `check` are left alone. A card type
    with a reader of its own and no claims reads the JSON Lines and CSV files."""
    d = tmp_path / "old"
    shutil.copytree(FIXTURE, d)
    (d / "extension.json").write_text(json.dumps({
        "api": 0, "name": "old", "version": "0.0.9", "title": "Old", "description": "An old one.", "applies": "Tallies.",
        "check": "tally", "requires": ["json"], "replaces": {"instructions": "instructions.md"}}))
    (d / "instructions.md").write_text("Count first, then read.")
    (d / "agents" / "orient.md").rename(d / "orient.md")
    (d / "reports").rename(d / "report-types")
    (d / "report-types" / "digest" / "type.md").write_text("---\nname: Digest\ndefault: false\n---\nWrite a digest.\n")
    raw = json.loads((d / "views" / "tally" / "view.json").read_text())
    raw["why"] = raw.pop("description")
    raw.update(applies=True, show="proposed", reports=["digest"], declares=[{"form": "<who>", "means": "one person"}])
    (d / "views" / "tally" / "view.json").write_text(json.dumps(raw))
    own = d / "cards" / "tally-own"
    shutil.copytree(d / "cards" / "tally-bars", own)
    shutil.copy(d / "views" / "tally" / "reader.py", own / "reader.py")
    card = json.loads((own / "card.json").read_text())
    card.pop("reader")
    (own / "card.json").write_text(json.dumps(card))
    _add(d)
    e = (await extensions.refresh(CORPUS, wait=10))["extensions"]["old"]
    assert e["active"] and e["python"] == ["json"] and e["views"][0]["shown"]
    assert "Each record of the tally files" in fit["asked"][0], "the view's `why` is its description"
    assert orient_session.instructions_of(CORPUS) == ("Count first, then read.\n\n#### old\n\n"
                                                      "Read every tally record in `tally/*.jsonl`, `*.jsonl`, `*.csv` "
                                                      "before you draft.")
    assert [r["id"] for r in extensions.report_types(CORPUS)] == ["digest"]
    types = await cardtypes.refresh(CORPUS, warm=False)
    assert types["tally-own"]["claims"] == ["*.jsonl", "*.csv"] and types["tally-own"]["view"] is None
    assert views.read_built(CORPUS, "tally")["ok"]


async def test_a_card_type_with_a_reader_of_its_own_reads_the_files_its_card_json_claims(corpus, tmp_path):
    d = _copy(tmp_path, "own")
    shutil.rmtree(d / "views")
    bars = d / "cards" / "tally-bars"
    shutil.copy(FIXTURE / "views" / "tally" / "reader.py", bars / "reader.py")
    card = json.loads((bars / "card.json").read_text())
    card.pop("reader")
    (bars / "card.json").write_text(json.dumps({**card, "claims": ["tally/*.jsonl"]}))
    _add(d)
    e = (await extensions.refresh(CORPUS))["extensions"]["own"]
    assert e["files"] == ["tally/*.jsonl"]
    types = await cardtypes.refresh(CORPUS, warm=False)
    assert types["tally-bars"]["claims"] == ["tally/*.jsonl"] and types["tally-bars"]["paths"] == ["tally/a.jsonl"]
    (bars / "card.json").write_text(json.dumps({**card, "claims": ["nowhere/*.csv"]}))
    _add(d)
    await extensions.refresh(CORPUS)
    assert "tally-bars" not in await cardtypes.refresh(CORPUS, warm=False), "no file here matches its claims"


def _tally_card(code: str, **extra) -> dict:
    """A card of the fixture's `tally` type as a card's cell holds it."""
    return {"id": "c1", "kind": "plot", "code": code, "outputs": [{cardtypes.CARD_MIME: {"type": "tally", "args": {}}}], **extra}


async def test_the_server_neither_writes_nor_serves_through_a_symlink_a_kernel_leaves(corpus, tmp_path):
    """A kernel writes the workspace, so a symlink it leaves where the server copies a file is replaced rather than
    written through, and a card type's page is read from the extension's folder in thimble's home."""
    secret = tmp_path / "outside" / "secret.txt"
    secret.parent.mkdir()
    secret.write_text("KEEP")
    _add()
    await extensions.refresh(CORPUS, wait=10)
    await cardtypes.refresh(CORPUS, warm=False)
    host = cardtypes.types_dir(CORPUS) / cardtypes.HOST_FILE
    host.unlink()
    host.symlink_to(secret)
    t = (await cardtypes.refresh(CORPUS, warm=False))["tally-bars"]
    assert secret.read_text() == "KEEP" and not host.is_symlink()
    page = Path(t["dir"]) / "card.html"
    page.unlink()
    page.symlink_to(secret)
    assert "KEEP" not in cardtypes.frame_document(CORPUS, "tally-bars")

    inv = config.workspace_dir(CORPUS) / "investigations" / "main"
    inv.mkdir(parents=True, exist_ok=True)
    (inv / "video.json").write_text("{}")
    d = report_types.types_dir(CORPUS) / "video"
    d.mkdir(parents=True)
    (d / "prompt.md").symlink_to(secret)
    report_types.list_types(CORPUS)
    assert secret.read_text() == "KEEP" and not (d / "prompt.md").is_symlink()


async def test_keep_changes_only_the_arguments_the_type_lets_the_card_change(corpus):
    _add()
    await extensions.refresh(CORPUS, wait=10)
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
    await extensions.refresh(CORPUS, wait=10)
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
    _config({"agents": {"ext-min:counter": {"web": "ask", "effort": "low", "network": "off"},
                        "orientation": {"network": "on"}}})
    assert userconf.problem(CORPUS) == ""
    counter = extensions.agent_definitions(CORPUS)["counter"]
    assert counter["tools"] == ["Read", "Grep", "WebFetch"] and counter["effort"] == "low"
    assert counter["disallowedTools"] == ["Bash"], "its network is off while the session's is on"
    row = ledger.with_features({}, CORPUS)["models"]["ext-min:counter"]
    assert row == {"model": "claude-sonnet-5", "effort": "low", "fast": False, "extension": "ext-min"}, "a Settings row"
    ledger.put_settings(CORPUS, {"models": {"ext-min:counter": {"model": "claude-opus-5-5", "effort": ""}}})
    assert json.loads(userconf.global_file().read_text())["agents"]["ext-min:counter"] == {
        "web": "ask", "network": "off", "model": "claude-opus-5-5"}
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


async def test_the_extension_command_adds_lists_and_removes(corpus, capsys, monkeypatch, tmp_path):
    """`thimble extension list` says per workspace whether each extension runs there, and whether each view shows."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    (config.WORKSPACES_DIR / "later").mkdir(parents=True)
    assert cli.main(["extension", "add", str(FIXTURE), "--yes"]) == 0
    out = capsys.readouterr().out
    assert "ext-min is on." in out and "ext-min adds to the orientation." in out
    await extensions.refresh(CORPUS, wait=10)
    assert cli.main(["extension", "list"]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"ext-min 0.1.0, used in place from {FIXTURE.resolve()}: on\n")
    assert re.search(r"^  later +not checked yet: no session connected here since it was added$", out, re.M)
    assert re.search(r"^  tallies +on\n +view tally shown: Each record says who did a task\.$", out, re.M)
    extensions.set_enabled(CORPUS, "ext-min", False)
    await extensions.refresh(CORPUS)
    assert cli.main(["extension", "list"]) == 0
    assert re.search(r"^  tallies +off  off in this workspace$", capsys.readouterr().out, re.M)

    assert cli.main(["extension", "off", "ext-min"]) == 0
    assert capsys.readouterr().out == "ext-min is off in every workspace.\n"
    assert json.loads(userconf.global_file().read_text()) == {"extensions": {"ext-min": {"enabled": False}}}
    assert (await extensions.refresh(CORPUS))["extensions"]["ext-min"]["why"] == "off in thimble's config"
    assert cli.main(["extension", "on", "ext-min"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("ext-min is on, except where its switch in Settings keeps it off: tallies.\n")
    assert "ext-min adds to the orientation." in out
    assert json.loads(userconf.global_file().read_text()) == {}
    assert cli.main(["extension", "off", "no-such"]) == 1
    assert "no extension 'no-such' is added" in capsys.readouterr().err
    assert cli.main(["extension", "off", "ext-min"]) == 0
    capsys.readouterr()
    assert cli.main(["extension", "add", str(FIXTURE), "--yes"]) == 0
    assert json.loads(userconf.global_file().read_text()) == {}, "adding it again switches it on"
    assert "ext-min stays off where its switch in Settings keeps it off: tallies." in capsys.readouterr().out

    broken = tmp_path / "ext-min"
    shutil.copytree(FIXTURE, broken)
    assert cli.main(["extension", "add", str(broken), "--yes"]) == 0
    capsys.readouterr()
    (broken / "extension.json").write_text("{")
    assert cli.main(["extension", "on", "ext-min"]) == 0
    out = capsys.readouterr().out
    assert "It does not run until this is fixed: extension.json:1  is not JSON" in out
    assert "adds to the orientation" not in out

    assert cli.main(["extension", "remove", "ext-min"]) == 0
    assert cli.main(["extension", "remove", "ext-min"]) == 1


async def test_a_folder_used_in_place_is_read_again_on_each_refresh_and_stays_when_removed(corpus, tmp_path):
    """An edit to a folder added in place reaches the workspace on the next refresh, a file that breaks unloads it
    with its file and line in Settings, and removing it takes out only thimble's link."""
    d = _copy(tmp_path, "live")
    _add(d)
    assert (await extensions.refresh(CORPUS))["extensions"]["live"]["active"]
    view = d / "views" / "tally" / "view.json"
    raw = json.loads(view.read_text())
    view.write_text(json.dumps({**raw, "description": "Counts per person."}))
    e = (await extensions.refresh(CORPUS))["extensions"]["live"]
    assert e["views"][0]["description"] == "Counts per person."
    assert json.loads((extensions.workspace_path(CORPUS, "live") / "views" / "tally" / "view.json").read_text())[
        "description"] == "Counts per person."
    view.write_text(json.dumps({**raw, "scopes": ["x"]}, indent=2))
    e = (await extensions.refresh(CORPUS))["extensions"]["live"]
    assert not e["active"] and e["why"].startswith('views/tally/view.json:') and 'unknown key "scopes"' in e["why"]
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "live")
    assert row["locked"] and 'unknown key "scopes"' in row["note"]
    assert extensions.remove("live") and (d / "extension.json").is_file()
    assert "live" not in (await extensions.refresh(CORPUS))["extensions"]


async def test_a_folder_used_in_place_cannot_link_to_files_outside_it(corpus, tmp_path, monkeypatch):
    """thimble reads a folder used in place where it is, so a link in it that leads outside it (here to the file that
    holds thimble's local API token) is a problem: add refuses the folder, and a link made after the add unloads it,
    so the file never reaches the orientation's prompt."""
    monkeypatch.setattr(orient_session, "message", lambda *a, **k: pytest.fail("nothing is sent"))
    secret = extensions.home() / "server.json"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text('{"token": "not-for-agents"}')
    d = _copy(tmp_path, "linky")
    (d / "agents" / "orient.md").unlink()
    (d / "agents" / "orient.md").symlink_to(secret)
    with pytest.raises(extensions.AddError) as got:
        extensions.add(str(d), yes=True, say=lambda _: None)
    assert "agents/orient.md  is a link to a file outside the extension's folder" in str(got.value)
    assert "linky" not in extensions.added()

    (d / "agents" / "orient.md").unlink()
    (d / "agents" / "orient.md").write_text("Read every tally record.\n")
    (d / "views" / "tally" / "notes.md").symlink_to(d / "agents" / "orient.md")
    _add(d)
    assert (await extensions.refresh(CORPUS))["extensions"]["linky"]["active"], "a link inside the folder is fine"
    (d / "agents" / "orient.md").unlink()
    (d / "agents" / "orient.md").symlink_to(secret)
    e = (await extensions.refresh(CORPUS))["extensions"]["linky"]
    assert not e["active"] and "is a link to a file outside" in e["why"]
    assert "not-for-agents" not in json.dumps(extensions.orient_blocks(CORPUS))
    assert not extensions._own_file(d, "agents/orient.md")


def test_add_refuses_a_folder_in_thimble_s_own_folders(corpus, tmp_path):
    """Adding a folder uses it in place and first takes out what thimble held under that name, so one of thimble's own
    copies (in its extensions folder, or a workspace's) is refused and left as it was. So is any other folder of a
    workspace, which thimble's agents and kernels write, such as the workspace's own extension."""
    _add(_copy(tmp_path, "kept"))
    extensions.remove("kept")
    copy = extensions.extensions_dir() / "kept"
    shutil.copytree(tmp_path / "kept", copy)
    with pytest.raises(extensions.AddError, match="is in thimble's own folders"):
        extensions.add(str(copy), yes=True, say=lambda _: None)
    assert (copy / "extension.json").is_file() and not copy.is_symlink()
    for rel in (f"{extensions.WS_DIR}/kept", "extension"):
        inside = config.workspace_dir(CORPUS) / rel
        shutil.copytree(tmp_path / "kept", inside)
        with pytest.raises(extensions.AddError, match="is in thimble's own folders"):
            extensions.add(str(inside), yes=True, say=lambda _: None)
        assert (inside / "extension.json").is_file()
    assert not extensions.linked("kept")


async def test_the_add_question_and_settings_name_what_runs_outside_the_sandbox(corpus, tmp_path, monkeypatch):
    """An agent's MCP servers start outside the sandbox, so the add question lists each with its command, and Settings
    says so beside the agent. Whether the extension's code runs in a sandbox is the kernels' wrapper's to say."""
    d = _copy(tmp_path, "servers")
    body = (d / "agents" / "counter.md").read_text()
    (d / "agents" / "counter.md").write_text(body.replace("---\n", "---\nmcpServers:\n  db:\n    command: node\n"
                                                                  "    args: [db.js]\n", 1))
    said: list[str] = []
    extensions.add(str(d), yes=True, say=said.append)
    assert "It starts MCP servers outside the sandbox: db (node db.js)." in "\n".join(said)
    await extensions.refresh(CORPUS)
    assert extensions.agent_definitions(CORPUS)["counter"]["mcpServers"] == {"db": {"command": "node", "args": ["db.js"]}}
    monkeypatch.setattr(extensions, "kernels_wrapped", lambda c: False)
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "servers")
    assert "counter: network, no web, MCP servers outside the sandbox." in row["consent"]
    assert row["sandboxed"] is False
    monkeypatch.setattr(extensions, "kernels_wrapped", lambda c: True)
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "servers")
    assert row["sandboxed"] is True


async def test_run_now_is_not_offered_where_a_replacement_would_not_be_sent(corpus, tmp_path, monkeypatch):
    """A replacement of thimble's orientation instructions stands aside for the analyst's own, so Settings neither
    offers to run it nor asks when it is switched on, where Run now would send nothing."""
    monkeypatch.setattr(extensions, "orientation_ran", lambda c: True)
    write_json(config.workspace_dir(CORPUS) / "settings.json", {orient_session.SETTING: "My own way."})
    d = _copy(tmp_path, "solo")
    (d / "agents" / "orient.md").write_text("---\nreplace: true\n---\nLabel everything.\n")
    _add(d)
    await extensions.refresh(CORPUS)
    assert extensions.offered(CORPUS) == []
    row = next(r for r in extensions.public(CORPUS)["extensions"] if r["name"] == "solo")
    assert not row["offer"] and not row["orients"]
    write_json(config.workspace_dir(CORPUS) / "settings.json", {})
    assert extensions.offered(CORPUS) == ["solo"]


def test_shipping_leaves_a_folder_used_in_place_alone(corpus, tmp_path, monkeypatch):
    """A built-in's name linked to the analyst's own folder is theirs: ship() neither copies over it nor writes in it."""
    ships = tmp_path / "ships"
    shutil.copytree(extensions.builtin_dir(), ships)
    monkeypatch.setattr(extensions, "builtin_dir", lambda: ships)
    mine = tmp_path / "video"
    shutil.copytree(ships / "video", mine)
    write_json(mine / extensions.ADDED, {"kind": "built-in", "digest": extensions.digest(mine)[0]})
    _add(mine)
    (ships / "video" / "reports" / "video" / "report.md").write_text("A newer form.\n")
    assert extensions.ship() == []
    assert extensions.linked("video") and (mine / "reports" / "video" / "report.md").read_text() != "A newer form.\n"


def test_an_orientation_counts_as_run_only_with_the_thread_a_follow_up_resumes(corpus, monkeypatch):
    """Settings offers Run now only where a follow-up can reach the orientation: its record names a session and a
    thread, the thread is there (orient_session._chat_of), and Claude Code still keeps the session's transcript."""
    from app import agents, session

    kept = {"s-1": "/transcripts/s-1.jsonl"}
    monkeypatch.setattr(session, "find_transcript", lambda sid, config_dir=None: kept.get(sid))
    run = config.workspace_dir(CORPUS) / "orient" / "run.json"
    run.parent.mkdir(parents=True, exist_ok=True)
    write_json(run, {"session": "s-1", "chats": {"orient": "orient-1"}})
    assert not extensions.orientation_ran(CORPUS)
    agents.write_meta(CORPUS, {"id": "orient-1", "kind": "agent", "role": "orient"})
    assert extensions.orientation_ran(CORPUS)
    kept.clear()
    assert not extensions.orientation_ran(CORPUS), "a follow-up could not resume it"


def _role_ext(root: Path, name: str, agents: dict[str, dict], files: dict[str, str] | None = None, **manifest) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "extension.json").write_text(json.dumps({"name": name, "version": "0.1.0", **manifest}))
    for role, spec in agents.items():
        (folder / "agents" / role).mkdir(parents=True)
        (folder / "agents" / role / "agent.json").write_text(json.dumps(spec))
    for rel, text in (files or {}).items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text)
    return folder


async def test_settings_add_and_doctor_name_what_another_extension_keeps_from_running(corpus, tmp_path, capsys,
                                                                                     monkeypatch):
    """Two extensions that replace one role both leave it to thimble, and add, doctor and Settings say so; another's
    program running the orientation leaves an extension's addition to it unused, and Settings says that too. Removing
    an extension another needs names the one that stops running."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    program = {"description": "Its own critic.", "command": ["python3", "c.py"]}
    _add(_role_ext(tmp_path, "roleswap", {"critic": program}, {"agents/critic/c.py": "print('{}')\n"}))
    said: list[str] = []

    def ask(question: str) -> str:
        said.append(question)
        return "n"

    second = _role_ext(tmp_path, "roleswap2", {"critic": program}, {"agents/critic/c.py": "print('{}')\n"})
    assert extensions.add(str(second), ask=ask, say=said.append) is None
    conflict = "Conflict: roleswap and roleswap2 both replace the critic, so thimble's own runs."
    assert conflict in said and said.index(conflict) < said.index("Add it? [y/N] "), "named before the question"
    _add(second)
    assert "conflict: roleswap and roleswap2 both replace the critic, so thimble's own runs" in extensions.doctor_line()
    assert cli.main(["extension", "add", str(tmp_path / "roleswap2"), "--yes"]) == 0
    assert "Conflict: roleswap and roleswap2 both replace the critic, so thimble's own runs." in capsys.readouterr().out
    await extensions.refresh(CORPUS)
    got = extensions.public(CORPUS)
    assert "roleswap and roleswap2 both replace the critic, so thimble's own runs" in got["conflicts"]
    rows = {r["name"]: r for r in got["extensions"]}
    assert rows["roleswap"]["parts"] == ["its own critic, a program, not used, since roleswap2 replaces it too"]

    _add(_role_ext(tmp_path, "orientswap", {"orientation": {"description": "Its own.", "command": ["python3", "o.py"]}},
                   {"agents/orientation/o.py": "print('{}')\n"}))
    _add()
    await extensions.refresh(CORPUS, wait=10)
    rows = {r["name"]: r for r in extensions.public(CORPUS)["extensions"]}
    assert "adds to the orientation, not used, since orientswap's program runs the orientation" in rows["ext-min"]["parts"]
    assert "counter agent, not used, since orientswap's program runs the orientation" in rows["ext-min"]["parts"]

    _add(_role_ext(tmp_path, "needy", {}, needs=["ext-min"]))
    capsys.readouterr()
    assert cli.main(["extension", "remove", "ext-min"]) == 0
    out = capsys.readouterr().out
    assert "Removed ext-min.\nneedy needs it, so it does not run until ext-min is added again" in out


async def test_an_extension_s_task_prompts_and_report_checks_are_used(corpus, tmp_path):
    """A task's prompt adds to thimble's part of the task's prompt file, or takes its place with `replace` and pulls
    thimble's back in with {{default}}, wherever that part is (a whole file, its head or one section); two replacements
    leave thimble's own. A report check of an extension is offered among the checks, off, after the built-ins."""
    from app import checks, prompts, tasks

    ext = _role_ext(tmp_path, "tuned", {}, {
        "tasks/view-fit/task.json": json.dumps({"description": "Stricter.", "prompt": "fit.md"}),
        "tasks/view-fit/fit.md": "Say no for a view of logs.",
        "tasks/card-check/task.json": json.dumps({"description": "Axes.", "prompt": "check.md", "replace": True}),
        "tasks/card-check/check.md": "{{default}}\n\nAlso read every axis title of {{files}}.",
        "tasks/labels/task.json": json.dumps({"description": "Careful.", "prompt": "labels.md"}),
        "tasks/labels/labels.md": "Read the whole record twice.",
        "tasks/label-draft/task.json": json.dumps({"description": "Short.", "prompt": "draft.md"}),
        "tasks/label-draft/draft.md": "Keep the definition to two sentences.",
        "checks/tone/check.json": json.dumps({"name": "Tone", "colour": "3"}),
        "checks/tone/check.md": "Comment on each sentence whose tone is stronger than its evidence."})
    _add(ext)
    await extensions.refresh(CORPUS)
    assert [p.extension for p in tasks.parts(CORPUS, "view-fit")] == ["tuned"]

    fit = view_fit.prompt(CORPUS, "Tally", "Counts records.", [("tally/a.jsonl", 10, 0)])
    assert fit.rstrip().endswith("#### From the tuned extension\n\nSay no for a view of logs."), fit[-300:]
    with prompts.custom(tasks.files(CORPUS, "card-check")):
        secs = card_check._sections()
    default = prompts.section("card-check", "check").strip()
    assert secs["check"].startswith(default[:200]) and "Also read every axis title of (none)." in secs["check"]
    assert "card" in secs and "## " not in secs["check"], "the other sections stay apart"
    with prompts.custom(userconf.prompt_files(CORPUS, "labels")):
        head = prompts.render_head("labels", {"name": "x", "unit": "record", "definition": "d", "labels": "a, b",
                                              "comment": "", "examples": ""})
        draft = prompts.section("labels", "draft")
    assert "Read the whole record twice." in head and "Keep the definition to two sentences." not in head
    assert "Keep the definition to two sentences." in draft and "Read the whole record twice." not in draft

    other = _role_ext(tmp_path, "tuned2", {}, {
        "tasks/card-check/task.json": json.dumps({"description": "Mine.", "prompt": "c.md", "replace": True}),
        "tasks/card-check/c.md": "Only my own words."})
    _add(other)
    await extensions.refresh(CORPUS)
    with prompts.custom(tasks.files(CORPUS, "card-check")):
        assert card_check._sections()["check"] == default, "two replacements leave thimble's own"

    listed = {x["id"]: x for x in checks.list_checks(CORPUS)}
    tone = listed["tuned-tone"]
    assert (tone["name"], tone["colour"], tone["shown"], tone["builtin"], tone["created_by"]) == ("Tone", 3, False, True, "tuned")
    assert list(listed).index("tuned-tone") == len(checks.BUILTINS), "after the built-ins"
    assert checks.read(CORPUS, "tuned-tone")["prompt"].startswith("Comment on each sentence whose tone")
