"""Load on demand (V4): main's guide leaves out the later parts of main.md and shared.md, each reaches main word for word
with its feature's first use (app/disclose.py), and main's shim lists only the everyday tools loaded, every other one
deferred behind ToolSearch, with a line of the guide that says when to use it.

prompts.py renders a later part three ways: kept, its markers gone (every prompt but the guide); left out (the guide);
marked (to read the parts). The parts and the guide together hold main's whole prompt, word for word. A part joins the
result of the first call of its feature in main's conversation once, after a lead line with the session's guide
marker, and the first event of its kind; a failed call, a call of one of thimble's agents, a call without a
tool_use_id and a fork's part that main had give nothing. A guide that goes out again forgets what main had."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import re
from pathlib import Path

import pytest

from app import config, disclose, events, guide, prompts, tools

CORPUS = "mini"
SID = "5e55a000-0000-4000-8000-0000000000d4"
SHIM = config.REPO_ROOT / "plugin" / "bin" / "thimble-mcp"


@pytest.fixture()
def ws(monkeypatch):
    """The `mini` workspace with main's session in launch.json, the server's folders the test's own."""
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    w = config.workspace_dir(CORPUS)
    (w / "trusted").mkdir(exist_ok=True)
    (w / "trusted" / "launch.json").write_text(json.dumps({"session": SID}))
    return w


def _caller(w: Path, tool_use_id: str, agent: str = "", kind: str = "") -> None:
    from app import subagent_files

    subagent_files.add_caller(w, tool_use_id, agent, kind)


def _full() -> str:
    with prompts.rendering(prompts.DEFAULT_FLAGS):
        return events.render_prompts(events.SESSION_PROMPTS, "/corpus", True)


def _core() -> str:
    with prompts.rendering(prompts.DEFAULT_FLAGS), prompts.later_parts(prompts.DROP):
        return events.render_prompts(events.SESSION_PROMPTS, "/corpus", True)


def _parts() -> list[tuple[str, str, str]]:
    with prompts.rendering(prompts.DEFAULT_FLAGS), prompts.later_parts(prompts.MARK):
        return prompts.later_texts(events.render_prompts(events.SESSION_PROMPTS, "/corpus", True))


# --------------------------------------------------------------------------- prompts.py's later parts


def test_a_later_part_is_kept_left_out_or_marked(tmp_path, monkeypatch):
    d = tmp_path / "prompts"
    d.mkdir()
    (d / "p.md").write_text("## A\n\nOne.{{later:x}} Two.{{/later}}\n\n{{later:y}}\n## B\n\nThree.\n{{/later}}\n\n"
                            "{{if:labels}}\n{{later:x}}\n    row\n{{/later}}\n{{end}}\nFour.\n")
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(d))
    assert prompts.load("p") == "## A\n\nOne. Two.\n\n## B\n\nThree.\n\n    row\nFour.\n"
    with prompts.later_parts(prompts.DROP):
        assert prompts.load("p") == "## A\n\nOne.\n\n\nFour.\n"
    with prompts.later_parts(prompts.DROP, keep={"y"}):
        assert "## B\n\nThree." in prompts.load("p") and "Two." not in prompts.load("p")
    with prompts.later_parts(prompts.MARK):
        marked = prompts.load("p")
    assert prompts.without_marks(marked) == prompts.load("p")
    assert prompts.later_texts(marked) == [("x", "## A", "Two."), ("y", "## A", "## B\n\nThree."),
                                           ("x", "## B", "    row")]
    with prompts.later_parts(prompts.MARK, keep=()), prompts.rendering(set()):
        assert [n for n, _, _ in prompts.later_texts(prompts.load("p"))] == ["x", "y"], "a flag block's part goes with it"
    for bad in ("{{later:x}}a{{later:y}}b{{/later}}{{/later}}", "a{{/later}}", "{{later:x}}a"):
        (d / "p.md").write_text(bad)
        with pytest.raises(prompts.PromptError):
            prompts.load("p")


def test_the_guide_and_its_later_parts_hold_main_s_whole_prompt_word_for_word():
    full, core, parts = _full(), _core(), _parts()
    assert len(core) < len(full)
    names = {n for n, _, _ in parts}
    assert names == set(disclose.SECTIONS), "every part has its name in disclose.SECTIONS, and every name a part"
    for name, _, text in parts:
        assert text and text in full, name
        assert text not in core, f"{name} is left out of the guide"
    # the marked prompt is the whole prompt with sentinels around the parts, and the guide is it without them
    with prompts.rendering(prompts.DEFAULT_FLAGS), prompts.later_parts(prompts.MARK):
        marked = events.render_prompts(events.SESSION_PROMPTS, "/corpus", True)
    squeeze = lambda t: re.sub(r"\n{3,}", "\n\n", t)  # noqa: E731 — render_prompts' own blank-line rule
    assert squeeze(prompts.without_marks(marked)) == full
    assert squeeze(prompts.without_parts(marked)) == core
    # the guide keeps what every answer needs, and when to use each feature
    for kept in ("## Communicating", "## Cards", "### Several cards", "## Citations", "never a regex",
                 "You decide when to start an orientation", "call `run_check`", "do not offer a view",
                 "A follow-up for the orientation goes through `message_orientation`"):
        assert kept in core, kept
    for left in ("    Analyst   What do customers complain about?", "## Threads", "## Permission requests",
                 "- `thread` opens or continues", "- `label_done` says"):
        assert left not in core, left


def test_the_guide_says_when_to_use_each_tool_the_shim_defers():
    loader = importlib.machinery.SourceFileLoader("shim_v4", str(SHIM))
    spec = importlib.util.spec_from_loader("shim_v4", loader)
    shim = importlib.util.module_from_spec(spec)
    loader.exec_module(shim)
    listed = [t["name"] for t in tools.list(tools.ANALYST)]
    deferred = [n for n in listed if shim.tool_meta(False, n) == {tools.META_ALWAYS_LOAD: False}]
    loaded = [n for n in listed if shim.tool_meta(False, n) == {tools.META_ALWAYS_LOAD: True}]
    agent_only = {n for n, s in tools.REGISTRY.items() if s.sessions and None not in s.sessions}
    assert set(loaded) == set(tools.ALWAYS_LOADED) | (agent_only & set(listed)), "an agent's own tools stay loaded"
    assert len(loaded) + len(deferred) == len(listed) and not set(deferred) & agent_only
    core = _core()
    named = set(re.findall(r"`([a-z]+(?:_[a-z]+)*)`", core))
    assert not [n for n in deferred if n not in named], "a deferred tool the guide never names"
    assert shim.tool_meta(True) == {tools.META_SEARCH_HINT: tools.SEARCH_HINT}


def test_a_session_thimble_starts_lists_each_tool_loaded(monkeypatch):
    monkeypatch.setenv("THIMBLE_SESSION", "orient")
    monkeypatch.setenv("THIMBLE_SESSION_TOKEN", "a-token")
    loader = importlib.machinery.SourceFileLoader("shim_v4s", str(SHIM))
    spec = importlib.util.spec_from_loader("shim_v4s", loader)
    shim = importlib.util.module_from_spec(spec)
    loader.exec_module(shim)
    assert shim.tool_meta(False, "start_writing") == {tools.META_ALWAYS_LOAD: True}


# --------------------------------------------------------------------------- disclosure


def _res(text: str = "label `talks to another` · yes 3 · no 41", error: bool = False) -> tools.ToolResult:
    return tools.err(text) if error else tools.ok(text)


def test_a_feature_s_later_parts_join_its_first_call_once(ws):
    marker = guide.marker(SID)
    _caller(ws, "toolu_1")
    got = disclose.after_call(CORPUS, "apply_label", {"name": "x"}, _res(), None, "toolu_1")
    assert len(got.content) == 2
    told = got.content[1]["text"]
    assert told.startswith(guide.LATER_LEAD.format(marker=marker))
    assert "\n\n## Labels\n\nThe result is a count per value" in told
    assert "    Analyst   What do customers complain about?" in told and "concept:<id>/<value>" in told
    assert not told.startswith(guide.LEAD_PREFIX.format(marker=marker)), "never taken for the guide itself"
    _caller(ws, "toolu_2")
    assert len(disclose.after_call(CORPUS, "show_label", {"name": "x"}, _res(), None, "toolu_2").content) == 1


def test_a_call_gives_nothing_when_it_failed_or_no_model_reads_it_or_an_agent_of_thimble_s_made_it(ws):
    _caller(ws, "toolu_e")
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(error=True), None, "toolu_e").content) == 1
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(), None, None).content) == 1
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(), None, "toolu_plugin_1").content) == 1
    _caller(ws, "toolu_o", "a-orient", "thimble:orientation")
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(), "orient", "toolu_o").content) == 1
    _caller(ws, "toolu_m")
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(), None, "toolu_m").content) == 2, "main's still"


def test_a_fork_has_what_main_had_and_gets_what_main_did_not(ws):
    _caller(ws, "toolu_m")
    disclose.after_call(CORPUS, "start_orientation", {}, _res("Agent call"), None, "toolu_m")
    _caller(ws, "toolu_f1", "a-fork", "fork")
    assert len(disclose.after_call(CORPUS, "message_orientation", {}, _res(), None, "toolu_f1").content) == 1
    _caller(ws, "toolu_f2", "a-fork", "fork")
    got = disclose.after_call(CORPUS, "rename_thread", {}, _res(), None, "toolu_f2")
    assert "## Threads" in got.content[1]["text"]
    _caller(ws, "toolu_f3", "a-fork", "fork")
    assert len(disclose.after_call(CORPUS, "start_writing", {}, _res(), None, "toolu_f3").content) == 1, \
        "a fork's start: main makes its Agent call"
    _caller(ws, "toolu_m2")
    assert len(disclose.after_call(CORPUS, "rename_thread", {}, _res(), None, "toolu_m2").content) == 2, "main's own"


def test_a_ref_gives_the_parts_of_what_it_names(ws):
    _caller(ws, "toolu_r")
    got = disclose.after_call(CORPUS, "read_ref", {"ref": "report:report"}, _res("# Report"), None, "toolu_r")
    assert "report:<slug>#<id>" in got.content[1]["text"]
    _caller(ws, "toolu_r2")
    assert len(disclose.after_call(CORPUS, "read_ref", {"ref": "board.jsonl#L1"}, _res(), None, "toolu_r2").content) == 1


def test_a_guide_that_goes_out_again_forgets_what_main_had(ws):
    _caller(ws, "toolu_1")
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(), None, "toolu_1").content) == 2
    cwd = str(config.corpus_dir(CORPUS))
    assert guide.render(cwd, SID).startswith(guide.LEAD_PREFIX.format(marker=guide.marker(SID)))
    _caller(ws, "toolu_2")
    assert len(disclose.after_call(CORPUS, "apply_label", {}, _res(), None, "toolu_2").content) == 2


def test_the_guide_keeps_the_orientation_s_part_once_an_orientation_ran(ws):
    cwd = str(config.corpus_dir(CORPUS))
    assert "The orientation analyzes the corpus" not in guide.render(cwd)
    (ws / "orient").mkdir(exist_ok=True)
    (ws / "orient" / "run.json").write_text(json.dumps({"status": "done"}))
    assert "The orientation analyzes the corpus" in guide.render(cwd, SID)
    _caller(ws, "toolu_o")
    got = disclose.after_call(CORPUS, "start_orientation", {}, _res("Agent call"), None, "toolu_o")
    assert "The orientation analyzes" not in got.content[-1]["text"], "inline: marked had"


def test_main_s_first_event_of_a_kind_carries_its_parts(ws):
    note = {"content": "the analyst's question", "meta": {"kind": "thread", "event": "e1"}}
    got = disclose.with_event(CORPUS, "thread", note, quiet=False)
    assert got["content"].startswith("the analyst's question\n\n" + guide.LATER_LEAD.format(marker=guide.marker(SID)))
    assert "- `thread` opens or continues" in got["content"] and "## Threads" in got["content"]
    assert disclose.with_event(CORPUS, "thread", note, quiet=False) == note
    quiet = {"content": "the orientation made 7 cards", "meta": {"kind": "orient", "event": "e2"}}
    held = disclose.with_event(CORPUS, "orient", quiet, quiet=True)
    assert held["content"] == quiet["content"] and "- `orient` says" in held["told"]
    lines = events.meanwhile([held])
    assert lines.startswith("meanwhile:\n[") and lines.split("\n")[1].count("\n") == 0
    assert lines.endswith(held["told"]) and "do not start a turn of their own" in held["told"]
