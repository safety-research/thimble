"""thimble-cc-mod's report check, which the writer runs before it ends:

    python3 report.py check <report.md> --contract <document|slides|story>

The contract is the renderer of the report's type (hooks/report.ts TYPES), so a new type drawn by one of the three
needs nothing here; `--form <type>` is read as the contract of the types this file knows. Prints one problem per line:
a citation whose place does not resolve or does not show its value, a card the report embeds that no script wrote, and
what the contract needs (a title; a deck's slides, each figure of at most 8 rows so the slide fits a narrow panel; a
story's beats, each with one figure). Ends with one line
"ok: ..." when there is none, and exits 1 when there are problems. Citations are read from the folder that holds the
report's .thimble-cc-mod, as the mod reads them.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refs import HOME, resolve  # noqa: E402

CITE = re.compile(r"\[\[([^\[\]]+?)\]\]")
FIGURE = re.compile(r"^\s*!\[[^\]\n]*\]\(\s*card:([A-Za-z0-9_-]+)(?:\s+\"[^\"\n]*\")?\s*\)\s*$")
EMBED = re.compile(r"^\s*\[\[card:([A-Za-z0-9_-]+)\]\]\s*$")
CODE = re.compile(r"```[\s\S]*?```|`[^`\n]*`")
CONTRACTS = ("document", "slides", "story")
# the types drawn as a document, for --form
DOCUMENT_TYPES = ("casefile", "comparison", "timeline", "custom")
# a slide's figure in a panel 50 columns by 44 rows: at most this many rows, bars, events or examples
SLIDE_ROWS = 8
FIGURE_UNITS = {"table": ("rows", "rows"), "bar": ("rows", "bars"), "label": ("rows", "bars"), "timeline": ("events", "events"), "example": ("examples", "examples")}


def figure_size(cwd: str, cid: str) -> tuple[int, str]:
    """How many rows (bars, events, examples) a card shows, and what they are called; 0 for a card of another kind."""
    try:
        with open(os.path.join(cwd, HOME, "cards", f"{cid}.json"), encoding="utf-8") as f:
            card = json.load(f)
    except (OSError, ValueError):
        return 0, ""
    field, unit = FIGURE_UNITS.get(card.get("kind", ""), ("", ""))
    items = card.get(field) if field else None
    return (len(items), unit) if isinstance(items, list) else (0, "")


def root_of(path: str) -> str:
    parts = os.path.abspath(path).split(os.sep)
    if HOME in parts:
        return os.sep.join(parts[: len(parts) - 1 - parts[::-1].index(HOME)]) or os.sep
    return os.environ.get("THIMBLE_CC_MOD_ROOT") or os.getcwd()


def sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """The text before the first `## ` and each `## ` heading with its text."""
    lead: list[str] = []
    secs: list[tuple[str, list[str]]] = []
    fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"^##\s+(.*)$", line)
        if m:
            secs.append((m.group(1).strip(), []))
        else:
            (secs[-1][1] if secs else lead).append(line)
    return "\n".join(lead), [(h, "\n".join(b)) for h, b in secs]


def paragraphs(text: str) -> list[str]:
    out, cur, fence = [], [], False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence or FIGURE.match(line) or EMBED.match(line):
            continue
        if not line.strip() or re.match(r"^\s*([-*+]|\d+[.)])\s", line):
            if cur:
                out.append(" ".join(cur).strip())
            cur = [re.sub(r"^\s*([-*+]|\d+[.)])\s+", "", line)] if line.strip() else []
            continue
        cur.append(line.strip().lstrip("> "))
    if cur:
        out.append(" ".join(cur).strip())
    return [p for p in out if p]


def figures(text: str) -> list[str]:
    return [m.group(1) for line in text.split("\n") for m in [FIGURE.match(line) or EMBED.match(line)] if m]


def words(text: str) -> int:
    return len(CITE.sub(lambda m: m.group(1).split("|")[0], text).split())


def check(path: str, form: str) -> tuple[list[str], str]:
    form = "document" if form in DOCUMENT_TYPES else form
    text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    cwd = root_of(path)
    problems: list[str] = []
    lines = text.split("\n")
    first = next((ln for ln in lines if ln.strip()), "")
    if not first.startswith("# "):
        problems.append('the report does not open with a "# " title')
    body = "\n".join(lines[lines.index(first) + 1:]) if first.startswith("# ") else text
    # citations, each once, by where it first stands
    seen: set[str] = set()
    clean = CODE.sub(lambda m: " " * len(m.group(0)), text)
    n_cites = 0
    for m in CITE.finditer(clean):
        raw = m.group(0)
        if raw in seen:
            continue
        seen.add(raw)
        inner = m.group(1).strip()
        display, ref = (inner.split("|", 1) + [""])[:2] if "|" in inner else (None, inner)
        ref = ref.strip()
        if display is not None:
            display = display.strip()
        n_cites += 1
        r = resolve(cwd, ref, display, 0)
        line = clean[: m.start()].count("\n") + 1
        if r.get("status") == "missing":
            problems.append(f"line {line}: {raw} does not resolve: {r.get('why', '')}")
        elif r.get("status") == "differs":
            problems.append(f"line {line}: {raw}: {r.get('why', '')}")
    cards = []
    for cid in figures(text):
        if cid not in cards:
            cards.append(cid)
    for cid in cards:
        if not os.path.isfile(os.path.join(cwd, HOME, "cards", f"{cid}.json")):
            problems.append(f"card:{cid} is embedded but {HOME}/cards/{cid}.json does not exist: make it with the card helper")
    lead, secs = sections(body)
    summary = f"{n_cites} citations resolve, {len(cards)} cards"
    if form == "slides":
        if not secs:
            problems.append('the deck has no "## " slide')
        for i, (h, b) in enumerate(secs, 1):
            for cid in dict.fromkeys(figures(b)):
                n, unit = figure_size(cwd, cid)
                if n > SLIDE_ROWS:
                    problems.append(f'slide {i} ("{h}"): card:{cid} shows {n} {unit}, more than fit a narrow panel; show at most {SLIDE_ROWS} on a slide: split them over two slides, or make a card of the top {SLIDE_ROWS}')
        summary += f", {len(secs)} slides"
    elif form == "story":
        for i, (h, b) in enumerate(secs, 1):
            if not figures(b) and h.lower() != "limitations" and not re.search(r"^\s*Card\s*:\s*none", b, re.M | re.I):
                problems.append(f'beat {i} ("{h}") has no figure: a beat shows one card, or says "Card: none"')
        if not secs:
            problems.append('the story has no "## " beat')
        summary += f", {len(secs)} beats"
    else:
        if not secs and words(body) > 200:
            problems.append('the document has no "## " section: open each with a heading that states what it concludes')
        summary += f", {len(secs)} sections"
    return problems, summary


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2 or args[0] != "check":
        print(__doc__, file=sys.stderr)
        return 2
    path = args[1]
    form = "document"
    for flag in ("--form", "--contract"):
        if flag in args and args.index(flag) + 1 < len(args):
            form = args[args.index(flag) + 1]
    form = "document" if form in DOCUMENT_TYPES else form
    if form not in CONTRACTS:
        print(f"report.py: --contract is one of {', '.join(CONTRACTS)}", file=sys.stderr)
        return 2
    if not os.path.isfile(path):
        print(f"{path} does not exist", file=sys.stderr)
        return 1
    problems, summary = check(path, form)
    for p in problems:
        print(p)
    if not problems:
        print(f"ok: {summary}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
