"""Labels off in the workbench: the Labels sidebar's Label tool switch for the workspace (ledger.labels_on), as the
terminal's Labels setting. While it is off, main's prompt, the shared text thimble's agents read and the tools' texts
say nothing of labels (labels_off.py), no agent is offered a label tool, a label tool's call is refused with the line
both modes read (plugin/prompts/labels-off.md) and changes nothing, and main is told of no label event. While it is on,
every text is as before. All data is made up (the `mini` corpus)."""
from __future__ import annotations

import re

import pytest

from app import concepts, config, events, labels_off, ledger, prompts, runtime, tools

CORPUS = "mini"
LINE = "Labels are off in thimble's settings, so thimble made no label."
# what a text may still say with "label" in it while Labels is off: words that mean no label of thimble's, such as the
# text on a diagram's edge or a timeline's event
GENERIC = ("with a bold label on each point", "cuts or overlaps long labels", "has room to label no more",
           "each edge a (source, target, label)", "each event a (time, label)", "an edge label over 36 characters")


@pytest.fixture()
def space(monkeypatch, workspaces_tmp, data_tmp):
    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    config.workspace_dir(CORPUS)
    runtime._spaces.clear()
    yield runtime.ensure(CORPUS)
    runtime._spaces.clear()


def label_words(text: str, folder: str = "") -> list[str]:
    """Each place `text` says "label", with some words around it, but for GENERIC's and in the corpus `folder`'s path."""
    for g in (*GENERIC, *([folder] if folder else [])):
        text = text.replace(g, "")
    return [text[max(0, m.start() - 60):m.end() + 40] for m in re.finditer(r"label", text, re.I)]


def test_each_part_labels_off_leaves_out_stands_once_in_its_text(monkeypatch):
    """A part reworded in its prompt file fails here, with the file and its words, before it reaches a model. In each
    launch mode, since main.md words some of its label parts in each mode's own words."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for mode in prompts.MODES:
        texts = {"main.md": prompts.load("main", mode), "shared.md": prompts.load("shared", mode),
                 "tools.md": prompts.load("tools", mode)}
        for file, parts in labels_off.CUTS.items():
            for part in parts:
                for words in part if isinstance(part, tuple) else (part,):
                    assert words in texts[file], (mode, file, words)
            # each part, in order, stands once in what the parts before it left (labels_off.cut raises else)
            assert len(labels_off.cut(texts[file], [file])) < len(texts[file]), (mode, file)
    with pytest.raises(prompts.PromptError, match="main.md"):
        labels_off.cut("no such words", ["main.md"])


def test_with_labels_off_the_terminal_launch_s_prompt_says_nothing_of_labels_either(space, analyst, monkeypatch):
    """The 0.8 terminal launch (launch_mode.py) renders main's prompt in terminal mode, whose `label_done` and `rerun`
    bullets have words of their own: Labels off leaves them out too, and the launch's prompt renders."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    workdir = str(space.corpus)
    ledger.put_settings_route(CORPUS, analyst, {"labels": False})
    with prompts.rendering("terminal"):
        text = events.session_prompt(workdir, terminal=False)
        tool_texts = tools.tool_sections([n for n in tools.REGISTRY if n not in labels_off.TOOLS], False)
    assert "## Events from thimble" in text and label_words(text, workdir) == [], label_words(text, workdir)
    for name in ("add_card", "set_filter", "open_view"):
        desc, schema = tool_texts[name]
        assert label_words(desc) == [] and label_words(str(schema)) == [], name


def test_with_labels_off_main_s_prompt_and_the_shared_text_say_nothing_of_labels_and_with_labels_on_all_of_it(
        space, analyst, monkeypatch):
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    workdir = str(space.corpus)
    assert ledger.labels_on(CORPUS) and ledger.get_settings(CORPUS)["labels"] is True
    on_main, on_shared = events.session_prompt(workdir, edits=True), events.render_prompts(["shared"], workdir)
    assert "## Labels" in on_main and "apply_label" in on_main and "`label_done`" in on_main
    assert "## Labels" in on_shared and on_shared in on_main
    for part in labels_off.CUTS["main.md"] + labels_off.CUTS["shared.md"]:
        for words in part if isinstance(part, tuple) else (part,):
            assert words.strip() in on_main, words
    # the switch off: the same prompts, less what they say of labels
    ledger.put_settings_route(CORPUS, analyst, {"labels": False})
    assert not ledger.labels_on(CORPUS) and ledger.get_settings(CORPUS)["labels"] is False
    off_main, off_shared = events.session_prompt(workdir, edits=True), events.render_prompts(["shared"], workdir)
    for text in (off_main, off_shared):
        assert label_words(text, workdir) == [], label_words(text, workdir)
        assert "## Citations" in text and "### Several cards" in text
    assert "## Events from the browser" in off_main and "`written`, `view` and `citations` do not start a turn" in off_main
    assert "The second gives a count without its base and quotes" in off_shared
    # the Labels section's last paragraph, on how a card decides an outcome, stays without its words on labels
    assert ("A card that sorts outcomes, such as which attempts worked, decides each one by what the analyst asked about"
            in off_shared and "Once a card defines an outcome" in off_shared and "in a takeaway or a view you propose"
            in off_shared)
    # what stays is as it was: each kept line of main's prompt stands in the prompt with Labels on
    on_lines = set(on_main.splitlines())
    changed = [ln for ln in off_main.splitlines() if ln not in on_lines]
    assert len(changed) == 7, changed  # the lines a part was cut out of, each now without it
    # on again: every word is back, as before
    ledger.put_settings_route(CORPUS, analyst, {"labels": None})
    assert "labels" not in ledger.stored_settings(CORPUS) and events.session_prompt(workdir, edits=True) == on_main


async def test_with_labels_off_no_agent_is_offered_a_label_tool_and_the_tools_texts_say_nothing_of_labels(
        space, analyst):
    def specs() -> dict[str, runtime.Spec]:
        return {"main": space.spec_of(space.main),
                "fork": space.spec_of(runtime.Conv(space, "f1", "fork", agent_id="f1")),
                "writer": space.spec_of(runtime.Conv(space, "a1", "agent", agent_id="a1", role="writer"))}

    on = specs()
    for who in ("main", "fork"):
        assert set(labels_off.TOOLS) <= set(on[who].thimble) and on[who].labels, who
    on_secs = tools.tool_sections(on["main"].thimble, on["main"].labels)
    ledger.put_settings_route(CORPUS, analyst, {"labels": False})
    off = specs()
    for who, spec in off.items():
        assert not set(labels_off.TOOLS) & set(spec.thimble) and spec.labels is False, who
        assert set(spec.thimble) == set(on[who].thimble) - set(labels_off.TOOLS), who
    secs = tools.tool_sections(off["main"].thimble, off["main"].labels)
    for name, (desc, schema) in secs.items():
        assert label_words(desc) == [] and label_words(str(schema)) == [], name
    # a tool that stays keeps what it does: set_filter still filters the cards
    assert secs["set_filter"][1]["properties"].keys() == on_secs["set_filter"][1]["properties"].keys() - {"label", "value"}
    assert secs["set_filter"][0].startswith("Filter the cards by their kind, group, maker, card check, star, lock or words.")
    # main's shim lists them alike
    listed = [t["name"] for t in tools.list("analyst", labels=False)]
    assert listed and not set(labels_off.TOOLS) & set(listed)
    assert [t["name"] for t in tools.list("analyst")] == [s.name for s in tools.REGISTRY.values()
                                                       if "analyst" in s.roles]


async def test_with_labels_off_a_label_tool_s_call_answers_with_the_one_line_and_changes_nothing(space, analyst):
    # a label event held while Labels was on, which would ride along with main's next event
    assert events.post(CORPUS, "labeled", {"text": "made-up", "name": "old one"})["held"] is True
    ledger.put_settings_route(CORPUS, analyst, {"labels": False})
    assert events.pop_held(CORPUS) == []
    assert labels_off.line() == LINE
    calls = [("apply_label", {"scope": "files", "paths": ["agents/*.jsonl"], "name": "bash use",
                              "predicate": {"kind": "regex", "text": "Bash"}}),
             ("show_label", {"name": "bash use"}), ("delete_label", {"label": "bash use"})]
    for name, args in calls:
        r = await tools.call(CORPUS, name, args, actor="analyst")
        assert r.is_error and r.text.splitlines()[-1] == LINE, (name, r.text)
    assert concepts.list_concepts(config.workspace_dir(CORPUS)) == []
    # main hears of no label: the label events go nowhere
    for kind in labels_off.EVENTS:
        got = events.post(CORPUS, kind, {"text": "made-up", "name": "bash use"})
        assert got["delivered"] == 0 and got.get("labels_off") is True, kind
    assert events.held(CORPUS) == []


async def test_with_labels_on_a_label_tool_runs_as_before(space):
    assert ledger.labels_on(CORPUS)
    r = await tools.call(CORPUS, "apply_label", {"scope": "files", "paths": ["agents/*.jsonl"], "name": "bash use",
                                                 "predicate": {"kind": "regex", "text": "Bash"}}, actor="analyst")
    assert not r.is_error and LINE not in r.text, r.text
    assert [k["name"] for k in concepts.list_concepts(config.workspace_dir(CORPUS))] == ["bash use"]


def test_only_the_analyst_s_browser_turns_labels_off(space, analyst):
    from starlette.requests import Request  # noqa: PLC0415

    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, Request({"type": "http", "headers": []}), {"labels": False})
    assert getattr(e.value, "status_code", None) == 403 and ledger.labels_on(CORPUS)
    with pytest.raises(Exception) as e:
        ledger.put_settings_route(CORPUS, analyst, {"labels": "off"})
    assert getattr(e.value, "status_code", None) == 400 and ledger.labels_on(CORPUS)
