"""The texts both modes read: a text of plugin/prompts whose entry in plugin/prompts/registry.mjs names a reader in the
terminal and one in the workbench. Each mode reads such a text the same, but for its own words in the slots of
plugin/prompts/slots.json; no other text a model reads holds a copy of one; each slot gives each mode a name or a
clause, and is used; and each mode's reader still loads the text. A failure names the file, quotes the words and says
how to fix it."""
from __future__ import annotations

import ast
import json
import re
import subprocess
from pathlib import Path

import pytest

from app import prompts

REPO = Path(__file__).resolve().parents[3]
PLUGIN = REPO / "plugin"
SLOTS = PLUGIN / "prompts" / "slots.json"
MODES = ("terminal", "browser")
# Words in a row that make a copy: about a sentence, so one principle said to two agents in a few words is no copy.
RUN = 20
# Where a copy of a shared text may not stand: the workbench's prompts, the plugin's other texts and its command and
# skill texts, and the string literals of the code of both products, tests left out.
TEXT_GLOBS = ("browser/prompts/**/*.md", "plugin/prompts/*.md", "plugin/commands/*.md", "plugin/skills/**/*.md")
CODE_ROOTS = ("browser/backend/app", "plugin")
NOT_CODE = {"node_modules", ".venv", "__pycache__", "test", "tests", "tests_public"}
# The copies of today, (file, text): the workbench's Heads up and Explainers checks over a document say what the lenses
# say, word for word (test_prompts.py holds them equal), until they are made from the lenses, and the terminal's
# heads-up on picked words (heads-expand.md) names the details to look for in the Heads-ups lens's words. A pair whose
# copy is gone fails too, so the list only shrinks.
KNOWN_COPIES = {("browser/prompts/checks/explainers.md", "lens-explain"),
                ("browser/prompts/checks/heads-up.md", "lens-heads"),
                ("plugin/prompts/heads-expand.md", "lens-heads")}
WORD = re.compile(r"[A-Za-z0-9']+")
SLOT = re.compile(r"\{\{([A-Z_]+)\}\}")

NODE = """
import { readFileSync } from 'node:fs'
import { LENSES } from %(lenses)s
import { textOf } from %(node)s
import { TEXTS } from %(registry)s
const slots = Object.keys(JSON.parse(readFileSync(%(slots)s, 'utf8')))
const marked = Object.fromEntries(slots.map(k => [k, { terminal: `\\u27e6${k}\\u27e7`, browser: `\\u27e6${k}\\u27e7` }]))
const renders = {}
for (const [name, t] of Object.entries(TEXTS)) {
  if (!t.terminal || !t.browser) continue
  try { renders[name] = await textOf(name, 'terminal', marked) } catch (e) { renders[name] = { error: e.message } }
}
process.stdout.write(JSON.stringify({ texts: TEXTS, lenses: LENSES.map(l => l.feature), renders }))
"""


@pytest.fixture(scope="module")
def registry() -> dict:
    """The registry's texts, the texts the look's lenses read, and each shared text as the terminal reads it with a
    marker, `\u27e6NAME\u27e7`, in each slot of slots.json (plugin/prompts/node.mjs), or the error of reading it."""
    urls = {k: json.dumps(str((PLUGIN / p).as_uri())) for k, p in (
        ("lenses", "observer/lenses.mjs"), ("node", "prompts/node.mjs"), ("registry", "prompts/registry.mjs"))}
    done = subprocess.run(["node", "--input-type=module", "-e", NODE % {**urls, "slots": json.dumps(str(SLOTS))}],
                          capture_output=True, text=True)
    assert done.returncode == 0, ("plugin/prompts/registry.mjs or plugin/prompts/slots.json does not read in Node: "
                                  f"{done.stderr.strip()[-600:]}")
    got = json.loads(done.stdout)
    got["shared"] = sorted(got["renders"])
    return got


def _words(text: str) -> list[tuple[str, int, int]]:
    """The words of a text, each as (its form to compare, where it starts, where it ends)."""
    return [(m.group(0).lower(), m.start(), m.end()) for m in WORD.finditer(text.replace("\u2019", "'"))]


def _quote(text: str, start: int = 0, end: int | None = None) -> str:
    """Words of a text on one line, at most about 200 characters of them."""
    words = " ".join(text[start:end].split())
    return words if len(words) <= 200 else words[:words.rfind(" ", 0, 200)] + " …"


def _regex_at(src: str, i: int) -> bool:
    """Whether the `/` at `i` of JavaScript source opens a regular expression rather than a division: it follows an
    operator, a bracket or a keyword, or nothing."""
    before = src[max(0, i - 12):i].rstrip()
    return not before or before[-1] in "(,=:[!&|?{};+-*%<>~^" or bool(re.search(
        r"\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$", before))


def _js_strings(src: str) -> list[str]:
    """The string literals of JavaScript or TypeScript source, comments and regular expressions left out: each quoted
    string, and a template's text outside its ${...} parts."""
    out, i, n = [], 0, len(src)
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif src[i] == "/" and _regex_at(src, i):
            j, chars = i + 1, False  # in a [...] class, a / ends nothing
            while j < n and src[j] != "\n" and (chars or src[j] != "/"):
                chars = (chars or src[j] == "[") and src[j] != "]"
                j += 2 if src[j] == "\\" else 1
            i = j + 1
        elif (q := src[i]) in "'\"`":
            j, buf = i + 1, []
            while j < n and src[j] != q:
                if src[j] == "\\":
                    buf.append({"n": "\n", "t": "\t"}.get(src[j + 1 : j + 2], src[j + 1 : j + 2]))
                    j += 2
                elif q == "`" and src.startswith("${", j):
                    depth, j = 1, j + 2
                    while j < n and depth:
                        depth += {"{": 1, "}": -1}.get(src[j], 0)
                        j += 1
                    buf.append(" ")
                elif q != "`" and src[j] == "\n":
                    break
                else:
                    buf.append(src[j])
                    j += 1
            out.append("".join(buf))
            i = j + 1
        else:
            i += 1
    return out


def _py_strings(src: str) -> list[str]:
    """The string literals of Python source, its docstrings left out (ast.walk meets a docstring after its holder)."""
    docs, out = set(), []
    for x in ast.walk(ast.parse(src)):
        if (isinstance(x, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and x.body
                and isinstance(x.body[0], ast.Expr) and isinstance(x.body[0].value, ast.Constant)):
            docs.add(id(x.body[0].value))
        elif isinstance(x, ast.Constant) and isinstance(x.value, str) and id(x) not in docs:
            out.append(x.value)
    return out


def _model_texts() -> list[tuple[str, str]]:
    """(path from the repository's root, what a model reads of it) of each text where a copy may not stand."""
    out = [(p, (REPO / p).read_text("utf-8")) for g in TEXT_GLOBS for p in sorted(
        str(f.relative_to(REPO)) for f in REPO.glob(g))]
    for root in CODE_ROOTS:
        for f in sorted((REPO / root).rglob("*")):
            rel = f.relative_to(REPO)
            if NOT_CODE & set(rel.parts) or not f.is_file():
                continue
            if f.suffix in (".ts", ".tsx", ".mjs", ".js"):
                out.append((str(rel), "\n".join(_js_strings(f.read_text("utf-8")))))
            elif f.suffix == ".py":
                out.append((str(rel), "\n".join(_py_strings(f.read_text("utf-8")))))
    return out


def _first_difference(a: str, b: str) -> str:
    """The words where two texts start to differ, in each."""
    i = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    start = a.rfind(" ", 0, max(0, i - 60)) + 1
    return f'the terminal reads "{_quote(a, start, i + 80)}", the workbench "{_quote(b, start, i + 80)}"'


def test_both_modes_read_a_shared_text_the_same(registry, tmp_path, monkeypatch):
    """With a marker in each slot of slots.json, the terminal's reading of each shared text (registry.mjs compose, which
    the hooks module and Node run) and the workbench's (prompts.py) are the same words: what differs between the modes
    stands in a slot, where both are seen, not in an edit one mode makes after it read the text."""
    marked = tmp_path / "slots.json"
    marked.write_text(json.dumps({k: {m: f"\u27e6{k}\u27e7" for m in MODES} for k in json.loads(SLOTS.read_text())}))
    monkeypatch.setattr(prompts, "PLUGIN_SLOTS", marked)
    bad = []
    for name in registry["shared"]:
        terminal = registry["renders"][name]
        if isinstance(terminal, dict):
            bad.append(f"plugin/prompts/{name}.md does not read in the terminal: {terminal['error']}")
        elif terminal != (browser := prompts.load(f"plugin:{name}")):
            bad.append(f"plugin/prompts/{name}.md reads differently in the two modes: "
                       f"{_first_difference(terminal, browser)}")
    assert not bad, "\n".join([*bad, "Both modes read a shared text by the same rules (plugin/prompts/registry.mjs): "
                                      "say what differs between them with a slot of plugin/prompts/slots.json."])


def test_no_other_text_a_model_reads_holds_a_copy_of_a_shared_text(registry):
    """No RUN words in a row of a shared text stand in another text a model reads, so no copy drifts from the text both
    modes read. The copies of today (KNOWN_COPIES) stay until the steps that take them out."""
    runs = {}  # each run of RUN words of a shared text, by its words, with the text's name
    for name in registry["shared"]:
        for part in re.split(r"\{\{[^{}]*\}\}", (PLUGIN / "prompts" / f"{name}.md").read_text("utf-8")):
            words = [w for w, _, _ in _words(part)]
            runs.update({tuple(words[i:i + RUN]): name for i in range(len(words) - RUN + 1)})
    found: dict[tuple[str, str], tuple[int, str]] = {}  # (file, text) -> (words copied, the first run, quoted)
    for path, text in _model_texts():
        words = _words(text)
        hits: dict[str, list[int]] = {}
        for i in range(len(words) - RUN + 1):
            name = runs.get(tuple(w for w, _, _ in words[i:i + RUN]))
            if name and path != f"plugin/prompts/{name}.md":
                hits.setdefault(name, []).append(i)
        for name, starts in hits.items():
            last = next((s for s, t in zip(starts, starts[1:]) if t > s + 1), starts[-1]) + RUN - 1
            copied = len({i for s in starts for i in range(s, s + RUN)})
            found[(path, name)] = (copied, _quote(text, words[starts[0]][1], words[last][2]))
    bad = [f'{path} holds {copied} words of plugin/prompts/{name}.md in runs of {RUN} or more, such as "{first}". '
           f"Include the text ({{{{include:plugin:{name}}}}} in a workbench prompt, {{{{include:{name}}}}} in a plugin "
           "text), have the code read it by its name, or say it in other words."
           for (path, name), (copied, first) in sorted(found.items()) if (path, name) not in KNOWN_COPIES]
    bad += [f"{path} no longer holds a copy of plugin/prompts/{name}.md: take ({path!r}, {name!r}) out of KNOWN_COPIES."
            for path, name in sorted(KNOWN_COPIES - found.keys())]
    assert not bad, "\n".join(bad)


def test_each_slot_gives_each_mode_a_name_or_a_clause_and_is_used(registry):
    """Each slot of slots.json gives each mode its words, a name or a clause on one line and no more than one sentence,
    so what differs between the modes stays a few words in sight; it stands in a shared text; and it is no slot that a
    reader fills. Each slot of a shared text is its readers' (the registry's `fills`) or a slot of slots.json."""
    slots = json.loads(SLOTS.read_text("utf-8"))
    used = {k for name in registry["shared"] for k in SLOT.findall((PLUGIN / "prompts" / f"{name}.md").read_text())}
    fills = {k: name for name, t in registry["texts"].items() for k in t.get("fills", [])}
    bad = []
    for k, said in slots.items():
        said = said if isinstance(said, dict) else {}
        bad += [f"slots.json: {k} has no {m} words: give it a value for each of {', '.join(MODES)}."
                for m in MODES if not isinstance(said.get(m), str)]
        bad += [f"slots.json: {k} has words for {m}, which is no mode ({', '.join(MODES)})."
                for m in said if m not in MODES]
        bad += [f"slots.json: {k}'s {m} words are more than one sentence: {v!r}. A slot holds a name or a clause; say "
                "a longer difference in each mode's own text." for m, v in said.items()
                if isinstance(v, str) and ("\n" in v or re.search(r"[.!?]['\")\]]*\s+\S", v.strip()))]
        if k not in used:
            bad.append(f"slots.json: {k} stands in no shared text: use it there as {{{{{k}}}}}, or take it out.")
        if k in fills:
            bad.append(f"slots.json: {k} is also a slot that the readers of plugin/prompts/{fills[k]}.md fill: "
                       "rename one.")
    for name in registry["shared"]:
        own = set(registry["texts"][name].get("fills", []))
        bad += [f"plugin/prompts/{name}.md: the slot {{{{{k}}}}} is neither its readers' (its `fills` in "
                "plugin/prompts/registry.mjs) nor in slots.json: give it each mode's words in slots.json, or have its "
                "readers fill it." for k in sorted(set(SLOT.findall((PLUGIN / "prompts" / f"{name}.md").read_text()))
                                                   - own - set(slots))]
    assert not bad, "\n".join(bad)


# How a reader loads a text by its name, by the reader's kind of file: the hooks module with promptText, Node with
# textOf and the workbench's Python with prompts' `plugin:<name>`; and how it loads a lens's text, by the lens's
# `feature`.
LOADS = {".ts": ("promptText($, '{name}')", "promptText($, lens.feature)"),
         ".mjs": ("textOf('{name}'", "textOf(lens.feature"),
         ".py": ('"plugin:{name}"', None)}


def test_each_mode_s_reader_still_loads_its_shared_texts(registry):
    """Each reader the registry names for a shared text loads it by its name with its mode's loader, or, for a lens's
    text, by the lens's `feature`, as both modes read the look's lenses (plugin/observer/lenses.mjs)."""
    bad = []
    for name in registry["shared"]:
        for mode in MODES:
            reader = registry["texts"][name][mode]
            path = PLUGIN / reader if mode == "terminal" else REPO / reader
            src = path.read_text("utf-8") if path.is_file() else ""
            by_name, by_lens = LOADS.get(path.suffix, ("{name}", None))
            if by_name.format(name=name) not in src and not (by_lens and name in registry["lenses"] and by_lens in src):
                bad.append(f"{path.relative_to(REPO)} holds no {by_name.format(name=name)}, so it does not load "
                           f"plugin/prompts/{name}.md, which the registry names it the {mode}'s reader of: load the "
                           "text by its name with its mode's loader, or name the module that reads it in "
                           "plugin/prompts/registry.mjs.")
    assert not bad, "\n".join(bad)
