"""Labels off: the workspace's Label tool switch in the Labels sidebar (ledger.labels_on) turned off, as the terminal's
Labels setting does in the plugin. Main's prompt, the shared text thimble's agents read and the texts of the tools say
nothing of labels then, no agent is offered a label tool (TOOLS), and a label tool's call is refused with the line both
modes read (LINE, plugin/prompts/labels-off.md), changing nothing. thimble tells main of no label event either
(events.post). The texts of agents that never make a label (a writer's, a view's builder's and reviewer's) keep their
words.

Each text keeps its words while Labels is on. While it is off, the parts of a text that name labels go (CUTS, by the
prompt file that holds them, in order): words exactly as the file has them, or a run of the text from its first words
up to the words that follow it, as (from, up to). Each part must stand exactly once in the text the parts before it
left, so a part reworded in its file fails loudly (PromptError names it) rather than reach a model; the parts take out
words only, and add none.
The `## Labels` section of main's text (plugin:main) and of the shared text (shared.md) goes whole (SECTIONS), with the
text on labels that both modes read in it (plugin:guidance-labels), as the terminal's guidance leaves out its Labels
section."""
from __future__ import annotations

import re

from . import prompts

LINE = "plugin:labels-off"  # what a label tool's call answers while Labels is off
# the tools that make, show or delete a label, none of which an agent is offered while Labels is off
TOOLS = ("apply_label", "show_label", "delete_label")
# the events that tell main of a label, which thimble sends no session while Labels is off
EVENTS = ("labeled", "label_ask", "label_done", "rerun")

CUTS: dict[str, tuple[str | tuple[str, str], ...]] = {
    "main.md": (
        "- `labeled` says the analyst defined or changed a label.\n",
        "- `label_ask` says how many records the analyst let a label of yours read with a model.\n",
        "- `label_done` says a label you ran finished. It lists each card whose takeaway the new output left behind, and "
        "each card that failed. In the same turn, before any other call, rewrite those takeaways with `edit_card`, fix "
        "the cards that failed, and rewrite the label card's takeaway from the final counts. Say something in the chat "
        "only if the new counts change your answer.\n",
        "- `rerun` says cards ran again because a label they read changed. It lists the cards as `label_done` does. Fix "
        "them in the same way, in the same turn, before any other call. Say something in the chat only if a new output "
        "changes your answer.\n",
        "`labeled`, `label_ask`, ",
        "- When each sentence's own words answer the question, use `apply_label` on the report instead, because its "
        "model reads each sentence alone.\n",
        "\n    Analyst   Which sentences in my report hedge their claim?                            apply_label, scope "
        "report",
    ),
    "refs.md": (
        "    a value's count on a label card             concept:<id>/<value>\n",
    ),
    "tools.md": (
        ", and label=<label> draws a label's values in its colors",
        " In matplotlib, color a label's values with thimble.colors(label, values), a {value: color} dict.",
        "the records in Files or the report's sentences by a value of a label that exists, and ",
        "no label and ",
        '    "label": {"type": "string", "description": "A label\'s name or id. An empty string drops the label from the '
        'filter."},\n',
        '    "value": {"type": "string", "description": "The label\'s value to keep. Default its first."},\n',
    ),
}
# the `## ` sections that go whole, by the prompt file that holds the heading: from the heading up to the next heading of
# its level or higher, or to the end of the text
SECTIONS: dict[str, tuple[str, ...]] = {"plugin:main.md": ("Labels",), "shared.md": ("Labels",)}
TOOLS_FILE = "tools.md"
_HEADING = re.compile(r"^#{1,2} ", re.M)


def _once(text: str, words: str, file: str, start: int = 0) -> int:
    """Where `words` of prompts/`file` stand in `text` from `start`, which they must do exactly once."""
    if (n := text.count(words, start)) != 1:
        raise prompts.PromptError(f"prompts/{file}: Labels off leaves out words by these, which the text has {n} times, "
                                  f"not once: {words[:90]!r}")
    return text.index(words, start)


def _cut(text: str, part: str | tuple[str, str], file: str) -> str:
    """`text` without `part` of prompts/`file`: these words, or the run from its first words up to the next (CUTS)."""
    if isinstance(part, tuple):
        at = _once(text, part[0], file)
        end = _once(text, part[1], file, at)
        return text[:at] + text[end:]
    at = _once(text, part, file)
    return text[:at] + text[at + len(part):]


def _cut_section(text: str, heading: str, file: str) -> str:
    """`text` without the `## <heading>` section of prompts/`file` (SECTIONS), whose heading it must hold exactly once."""
    found = list(re.finditer(rf"^## {re.escape(heading)}[ \t]*$", text, re.M))
    if len(found) != 1:
        raise prompts.PromptError(f"prompts/{file}: Labels off leaves out its section '## {heading}', which the text has "
                                  f"{len(found)} times, not once")
    at = found[0].start()
    end = _HEADING.search(text, found[0].end())
    return text[:at] + (text[end.start():] if end else "")


def cut(text: str, files: list[str] | tuple[str, ...]) -> str:
    """`text`, which holds the prompt files `files`, without the parts of each that name labels (SECTIONS, CUTS)."""
    for file in files:
        for heading in SECTIONS.get(file, ()):
            text = _cut_section(text, heading, file)
        for part in CUTS.get(file, ()):
            text = _cut(text, part, file)
    return text


def prompt(name: str, text: str) -> str:
    """Prompt `name` as render made it, `text`, without the parts of the files it reads that name labels."""
    return cut(text, prompts.files(name))


def tools_text(text: str) -> str:
    """prompts/tools.md without the parts that name labels: what the tools that stay say of them."""
    return cut(text, (TOOLS_FILE,))


def line() -> str:
    """The answer of a label tool's call while Labels is off."""
    return prompts.load(LINE).strip()
