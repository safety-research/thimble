"""Labels off: the workspace's Labels switch in Settings (ledger.labels_on) turned off, as the terminal's Labels setting
does in the plugin. Main's prompt, the shared text thimble's agents read and the texts of the tools say nothing of labels
then, no agent is offered a label tool (TOOLS), and a label tool's call is refused with the line both modes read (LINE,
plugin/prompts/labels-off.md), changing nothing. thimble tells main of no label event either (events.post). The texts of
agents that never make a label (a writer's, a view's builder's and reviewer's) keep their words.

Each text keeps its words while Labels is on. While it is off, the parts of a text that name labels go (CUTS, by the
prompt file that holds them): a `## ` section by its heading, up to the next `## ` heading, and any other part by its
words exactly as the file has them. Each part must stand in the text exactly once, so a part reworded in its file
fails loudly (PromptError names it) rather than reach a model; the parts take out words only, and add none. The card
types' text, a way to answer with labels, is left out whole (events.render_prompts), with the event that brings a new
one and what the card tool says of them."""
from __future__ import annotations

import re

from . import prompts

LINE = "plugin:labels-off"  # what a label tool's call answers while Labels is off
# the tools that make, show or delete a label, none of which an agent is offered while Labels is off
TOOLS = ("apply_label", "show_label", "delete_label")
# the events that tell main of a label, or of card types, which thimble sends no session while Labels is off
EVENTS = ("labeled", "label_ask", "label_done", "rerun", "card_types")

CUTS: dict[str, tuple[str, ...]] = {
    "main.md": (
        "- `labeled` says the analyst defined or changed a label themselves, with its definition as the text. It needs "
        "no words from you until the analyst asks about it.\n",
        "- `label_ask` says what the analyst chose when a label you ran asked them first, because it reads many records "
        "with a model: all of them, a sample, or none, as its text. It needs no words from you until the analyst asks "
        "about it.\n",
        "- `card_types` says which card types this corpus has that the list under Cards above does not, with each one's "
        "use and arguments as the text.\n",
        "- `label_done` says a label you ran finished after your turn moved on, with its counts as the text. thimble then "
        "ran the cards that read it again, and the text ends with each of them whose takeaway the new output left "
        "behind, or that failed, with that output. Write each of those takeaways again with `edit_card` from its "
        "output, fix each card that failed, and write the label card's takeaway again from the final counts, in the "
        "same turn before any other call. Say something in the chat only when the final counts change your answer.\n",
        "- `rerun` says thimble ran cards again because a label they read changed, with each card whose takeaway the new "
        "output left behind, or that failed, and that output as the text. Write each of those takeaways again with "
        "`edit_card` from its output and fix each card that failed, in the same turn before any other call. Say "
        "something in the chat only when a new output changes your answer.\n",
        "`labeled`, `label_ask`, ",
        ", `card_types`",
        " `apply_label` on the report fits only a question each sentence's own words answer, since its model reads each "
        "sentence alone.",
        "    Analyst   Which sentences in my report hedge their claim?                            apply_label, scope "
        "report\n",
    ),
    "shared.md": (
        "## Labels",
        ' I defined the "product named" label [[card:<id>]] to classify which product each request is about.',
        ", says nothing about how the requests were sorted,",
        ', from the model label "outage cause"',
        ', by the model label "outage cause"',
        "    a value's count on a label card             concept:<id>/<value>\n",
    ),
    "tools.md": (
        ", and label=<label> draws a label's values in its colors",
        " In matplotlib, color a label's values with thimble.colors(label, values), a {value: color} dict.",
        " A plot can also be a card type's graphic, thimble.card(type, labels=[...], **args), from the card types under "
        "Cards.",
        ", the records in Files or the report's sentences by a value of a label that exists, and the cards also",
        "no label and ",
        '    "label": {"type": "string", "description": "A label\'s name or id. An empty string drops the label from the '
        'filter."},\n',
        '    "value": {"type": "string", "description": "The label\'s value to keep. Default its first."},\n',
        "the card's labels turn on and ",
        ", which follow the labels live",
    ),
}
TOOLS_FILE = "tools.md"
_HEADING = re.compile(r"^## .*$", re.M)


def _cut(text: str, part: str, file: str) -> str:
    """`text` without `part` of prompts/`file`, which stands in it once: a `## ` heading's section, else these words."""
    if part.startswith("## ") and "\n" not in part:
        at = [m for m in _HEADING.finditer(text) if m.group(0).rstrip() == part]
        if len(at) != 1:
            raise prompts.PromptError(f"prompts/{file}: Labels off leaves out its section {part!r}, which the text has "
                                      f"{len(at)} times, not once")
        nxt = _HEADING.search(text, at[0].end())
        return text[:at[0].start()] + (text[nxt.start():] if nxt else "")
    if (n := text.count(part)) != 1:
        raise prompts.PromptError(f"prompts/{file}: Labels off leaves out these words, which the text has {n} times, "
                                  f"not once: {part[:90]!r}")
    return text.replace(part, "", 1)


def cut(text: str, files: list[str] | tuple[str, ...]) -> str:
    """`text`, which holds the prompt files `files`, without the parts of each that name labels (CUTS)."""
    for file in files:
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
