"""app.extensions: `thimble extension add` lists each contribution of an extension and copies it into thimble's home
once the analyst says yes; from then on it runs in every workspace until it is removed or switched off, and only its
views check whether they fit a corpus. The fixture extension ext-min gives one of each contribution: a view that is
also a card type, a card-only type, an agent, a report type and orientation instructions. Reader calls run in this
process, and the quick model call that checks whether a view fits answers from `fit`."""
from __future__ import annotations

import argparse
import asyncio
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

from app import (card_check, cardtypes, cli, config, extension_manifest, extensions, ledger, model, prompts, report_types, userconf, view_fit, views)
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


def _before_the_rename(base: Path) -> Path:
    """thimble's built-ins as an earlier build shipped them, in `base`: swarm-orient as `swarm`."""
    shutil.copytree(extensions.builtin_dir(), base)
    os.replace(base / "swarm-orient", base / "swarm")
    raw = json.loads((base / "swarm" / "extension.json").read_text())
    (base / "swarm" / "extension.json").write_text(json.dumps({**raw, "name": "swarm"}))
    return base


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
    # the view checks drive a headless browser, which a busy CI runner can keep past half a minute
    for _ in range(2400):
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
    monkeypatch.setattr(cli, "healthy", lambda url: False)  # the default port may be a live server's
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


async def test_an_extension_s_task_prompts_and_report_checks_are_used(corpus, tmp_path):
    """A task's prompt adds to thimble's part of the task's prompt file, or takes its place with `replace` and pulls
    thimble's back in with {{default}}, wherever that part is (a whole file, its head or one section); two replacements
    leave thimble's own. A report check of an extension is offered among the checks, off, after the built-ins."""
    from app import checks, prompts, tasks, view_review

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
    # live check L26 (live-d): an addition to the view review's section that opens with a `## ` heading was cut off
    review = _role_ext(tmp_path, "headed", {}, {
        "tasks/view-review/task.json": json.dumps({"description": "Restore.", "prompt": "r.md"}),
        "tasks/view-review/r.md": "## A test of the restore\n\nBreak the view once.\n\n```\n# a comment in code\n```"})
    _add(review)
    await extensions.refresh(CORPUS)
    with prompts.custom(tasks.files(CORPUS, view_review.PROMPT)):
        reviewer = view_review.reviewer_prompt(CORPUS)
    assert "#### A test of the restore\n\nBreak the view once." in reviewer and "\n# a comment in code\n" in reviewer
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
