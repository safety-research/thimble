"""Mechanisms that read main's text, which a rewrite of its words can break without another test failing.

- The server takes an event only of a kind that main.md's `## Events from the browser` names: events.kinds() reads the
  kinds from the backticked word that opens each bullet there. A bullet whose opening is reworded drops its kind, and
  the server then refuses those events.
- With Labels off, both modes leave out of main's text what it says of labels: the workbench by the exact words of
  labels_off.py (CUTS, SECTIONS), which must each stand once in the text, and the terminal by the `## Labels` section
  of its guidance (plugin/guidance/guidance.ts, guidanceFor). A reworded part makes the workbench's main fail to render.
"""
import re

import test_renders
from app import events, labels_off, prompts

# the event kinds of main.md's `## Events from the browser`, one bullet each
EVENT_KINDS = ("main", "thread", "card", "written", "labeled", "label_ask", "checked", "view", "label_done", "rerun",
               "citations")
# words of the label feature that main's text must not hold while Labels is off
LABEL_WORDS = ("## Labels", "thimble label", "{{LABEL", "label card", *labels_off.TOOLS,
               *(f"`{kind}`" for kind in labels_off.EVENTS))


def test_events_kinds_lists_every_event_kind_that_main_names(monkeypatch):
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    kinds = events.kinds()
    assert len(kinds) == len(set(kinds)), kinds
    assert set(kinds) == set(EVENT_KINDS), (
        f"main.md's '## {events.EVENTS_SECTION}' must open one bullet with each event kind, as `kind`; the server reads "
        f"{kinds}")
    section = prompts.section(events.PROMPT, events.EVENTS_SECTION)
    quiet = re.search(r"^((?:`[a-z_]+`(?:, | and ))+`[a-z_]+`) do not start a turn", section, re.M)
    assert quiet and set(re.findall(r"`([a-z_]+)`", quiet.group(1))) == set(events.QUIET_KINDS)
    assert set(events.QUIET_KINDS) <= set(kinds) and set(labels_off.EVENTS) <= set(kinds)


def test_main_renders_in_both_modes_with_labels_off(monkeypatch):
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    values = {"workdir": "/made-up/corpus", "forms": "", "corpus_writes": events.CORPUS_WRITES[None], "network": ""}
    on = prompts.render(events.PROMPT, values)
    off = labels_off.prompt(events.PROMPT, on)  # raises PromptError when a part of CUTS or SECTIONS is not there once
    assert len(off) < len(on)
    terminal = test_renders._terminal()["guidance"]
    parts = re.split(r"(?m)^(?=## )", terminal)  # guidance.ts's guidanceFor: each `## ` section, the Labels one left out
    assert sum(re.match(r"## Labels[ \t]*\n", p) is not None for p in parts) == 1
    terminal_off = "".join(p for p in parts if not re.match(r"## Labels[ \t]*\n", p))
    for mode, text in (("browser", off), ("terminal", terminal_off)):
        named = [w for w in LABEL_WORDS if w in text]
        assert not named, f"with Labels off, main's text in the {mode} still names {named}"
