"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left;
every hint the code names is a section of prompts/tools.md with the placeholders the code fills; and the browser's
Heads up and Explainers checks say what the terminal plugin's lenses say."""

import ast
import itertools
import re
import string
from pathlib import Path

import pytest

from app import prompts


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives — nothing half-filled can reach a model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
        values = {s: f"<{s}>" for s in prompts.slots(name)}
        out = prompts.render(name, values)
        assert "{{" not in out and "}}" not in out, name


def test_main_renders_with_either_ending(tmp_path, monkeypatch):
    """Main's prompt renders with the ending of each Claude Code (terminal_tools.ENDINGS), each found on exactly one
    line."""
    from app import events, terminal_tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for terminal in (True, False):
        out = events.render_prompts(["main"], str(tmp_path), terminal=terminal)
        assert terminal_tools.ENDINGS[terminal] in out and terminal_tools.ENDINGS[not terminal] not in out


REPO = Path(__file__).resolve().parent.parent.parent
APP = REPO / "backend" / "app"
PLUGIN = REPO / "plugin"

# The hint sections lanes B, M and E name for thimble's subagents, with exactly the placeholders each takes.
SUBAGENT_HINTS = {
    "start_writing-subagent": {"input"},
    "start_job-subagent": {"input"},
    "subagent-request": {"request_id"},
    "agent-check-exact": set(),
    "agent-check-message": set(),
    "start-plan-mode": set(),
    "writer-context-file": {"path"},
    "writer-context-files": {"paths", "n"},
    "check-task-file": {"path"},
    "check-task-files": {"paths", "n"},
    "start-refused-no-module": {"reason"},
    "start-refused-connecting": set(),
    "module-deny-private": set(),
    "module-deny-records": set(),
    "module-deny-data": set(),
    "module-deny-web": set(),
    "module-started-note": {"role", "agent", "what", "how"},
    "follow-up-ran-on": {"model", "effort"},
    "finish-view-pass": set(),
    "finish-view-fail": {"report", "n", "of"},
    "finish-view-stop": set(),
    "finish-review-again": set(),
    "finish-review-done": set(),
    "finish-review-restored": set(),
    "view-pictures": {"paths", "records"},
}
HINT_FUNCS = ("hint", "_hint")  # tools.hint and the modules' wrappers of it


def _fields(body: str) -> set[str]:
    """The {placeholders} a hint's body takes, as str.format reads them."""
    return {f.split(".")[0].split("[")[0] for _, f, _, _ in string.Formatter().parse(body) if f}


def _constants(tree: ast.Module) -> dict[str, ast.expr]:
    """A module's top-level names, each with the expression bound to it."""
    out: dict[str, ast.expr] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            out.update({t.id: node.value for t in node.targets if isinstance(t, ast.Name)})
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            out[node.target.id] = node.value
    return out


class _Code:
    """The hint calls of the Python thimble runs, backend/app and the plugin's watcher: each call's first argument
    resolved to the hint names it can take where the code alone says (a literal, a module's constant, a function's
    default or local, a dict of them), with the keywords the call fills."""

    def __init__(self) -> None:
        files = {p.stem: p for p in APP.glob("*.py")}
        files[".thimble-watch"] = PLUGIN / "bin" / ".thimble-watch"
        self.trees = {name: ast.parse(path.read_text("utf-8"), str(path)) for name, path in files.items()}
        self.consts = {name: _constants(tree) for name, tree in self.trees.items()}

    def names(self, node: ast.expr, mod: str, scope: "ast.AST | None", depth: int = 0) -> "list[str] | None":
        """The strings `node` can be, or None where the code alone does not say."""
        if depth > 6:
            return None

        def every(nodes: "list[ast.expr]", m: str = mod, s: "ast.AST | None" = scope) -> "list[str] | None":
            got = [self.names(n, m, s, depth + 1) for n in nodes]
            return None if not got or any(g is None for g in got) else [x for g in got for x in g]

        if isinstance(node, ast.Constant):
            return [node.value] if isinstance(node.value, str) else None
        if isinstance(node, ast.IfExp):
            return every([node.body, node.orelse])
        if isinstance(node, ast.Dict):
            return every([v for v in node.values if v is not None])
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
            return every([node.func.value, *node.args[1:2]])
        if isinstance(node, ast.Subscript):
            return every([node.value])
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in self.consts:
            bound = self.consts[node.value.id].get(node.attr)
            return None if bound is None else every([bound], node.value.id, None)
        if isinstance(node, ast.Name):
            if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
                local = [n.value for n in ast.walk(scope) if isinstance(n, ast.Assign)
                         and any(isinstance(t, ast.Name) and t.id == node.id for t in n.targets)]
                a = scope.args
                params = [x.arg for x in (*a.posonlyargs, *a.args)]
                defaults = dict(zip(params[len(params) - len(a.defaults):], a.defaults))
                defaults.update({x.arg: d for x, d in zip(a.kwonlyargs, a.kw_defaults) if d is not None})
                local += [defaults[node.id]] if node.id in defaults else []
                if local:
                    return every(local)
            bound = self.consts[mod].get(node.id)
            return None if bound is None else every([bound], mod, None)
        return None

    def calls(self):
        """(where, hint names, keywords or None when the call spreads **values) of each hint call it resolves."""
        for mod, tree in self.trees.items():
            scopes = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and node.args):
                    continue
                f = node.func
                if (f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else "") not in HINT_FUNCS:
                    continue
                inside = [s for s in scopes if s.lineno <= node.lineno <= (s.end_lineno or s.lineno)]
                scope = min(inside, key=lambda s: (s.end_lineno or s.lineno) - s.lineno, default=None)
                found = self.names(node.args[0], mod, scope)
                if found is not None:
                    kws = None if any(k.arg is None for k in node.keywords) else {k.arg for k in node.keywords}
                    yield f"{mod}:{node.lineno}", found, kws


def _module_hints() -> "list[tuple[str, str]]":
    """(where, hint name) of each `hint("…")` the plugin's hooks module (plugin/hooks/*.ts) names."""
    out = []
    for path in sorted((PLUGIN / "hooks").glob("*.ts")):
        for i, line in enumerate(path.read_text("utf-8").splitlines(), 1):
            out += [(f"{path.name}:{i}", m.group(1)) for m in re.finditer(r"\bhint\(\s*['\"]([\w-]+)['\"]", line)]
    return out


def test_every_hint_the_code_names_exists_with_its_placeholders(monkeypatch):
    """Each hint a hint call of the code can name is a section of prompts/tools.md, and a call that names its keywords
    fills every placeholder of it: tools.hint gives '' for a missing section and the raw text, braces and all, for a
    placeholder left unfilled, so either would reach a model or the analyst without an error."""
    from app import tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    hints = tools.descriptions()
    calls = list(_Code().calls())
    assert len(calls) > 100, "the scan found too few hint calls to be reading the code"
    missing, unfilled = [], []
    for where, names, kws in calls:
        for name in names:
            if name not in hints:
                missing.append(f"{where} {name}")
            elif kws is not None and not _fields(hints[name]) <= kws:
                unfilled.append(f"{where} {name} lacks {sorted(_fields(hints[name]) - kws)}")
    missing += [f"{where} {name}" for where, name in _module_hints() if name not in hints]
    assert not missing, f"hints the code names that prompts/tools.md lacks: {missing}"
    assert not unfilled, f"hint calls that leave placeholders unfilled: {unfilled}"


def test_the_subagent_hints_have_their_placeholders(monkeypatch):
    """The hint sections the subagent paths name exist with exactly their placeholders."""
    from app import tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    hints = tools.descriptions()
    wrong = {name: sorted(_fields(hints[name])) if name in hints else "missing"
             for name, want in SUBAGENT_HINTS.items() if name not in hints or _fields(hints[name]) != want}
    assert not wrong, wrong


# The browser's Heads up and Explainers checks and the terminal's lenses they share their text with.
LENS_TEXTS = {"heads-up": "lens-heads", "explainers": "lens-explain"}
OUTPUT_FORM = ('"heads"', '"glosses"', "add_comment")  # what only the paragraphs on a mode's output form name


def _shared(text: str) -> list[str]:
    """The paragraphs a check's text shares with its lens, each with its whitespace collapsed: the text without its front
    matter, heading, digest and the paragraphs on its output form, and of the example only what it checks, the lines
    before Good."""
    if text.startswith("---\n"):
        text = text.split("\n---\n", 1)[1]
    out = []
    for para in text.split("<!-- digest -->")[0].split("\n\n"):
        lines = [ln for ln in para.strip("\n").split("\n") if ln.strip() and not ln.startswith(("## ", "```"))]
        if not lines:
            continue
        if para.lstrip("\n").startswith(("```", "    ")):  # the example
            lines = [ln.strip() for ln in lines]
            lines = lines[:next((i for i, ln in enumerate(lines) if ln.startswith("Good")), len(lines))]
        elif any(w in para for w in OUTPUT_FORM):
            continue
        out.append(" ".join(" ".join(lines).split()))
    return out


@pytest.mark.parametrize("check", sorted(LENS_TEXTS))
def test_the_lens_checks_say_what_the_terminal_lenses_say(check):
    """Heads up and Explainers say what the terminal's heads-up and explainer lenses say, word for word: the definition,
    what to look for, the limit, the example's answer and why the good example is good. Only the output form differs,
    the lens's JSON and the check's add_comment, each in its own example and paragraph."""
    browser = _shared((REPO / "prompts" / "checks" / f"{check}.md").read_text("utf-8"))
    terminal = _shared((REPO.parent / "plugin" / "prompts" / f"{LENS_TEXTS[check]}.md").read_text("utf-8"))
    assert browser and browser == terminal


def _examples(text: str) -> list[list[str]]:
    """The example blocks of a prompt's text: each run of lines indented by four spaces, its lines stripped."""
    blocks: list[list[str]] = []
    run: list[str] = []
    for line in text.splitlines() + [""]:
        if line.startswith("    ") and line.strip():
            run.append(line.strip())
        elif run:
            blocks.append(run)
            run = []
    return blocks


def _what_to_make(mode: str) -> tuple[str, list[list[str]]]:
    """The guidance's What to make (shared.md), as main's prompt includes it: its paragraph, and its example's turns,
    each an `Analyst` line with the lines under it."""
    section = prompts.section("main", "What to make", mode)
    para = next(p for p in section.split("\n\n") if p.strip() and not p.startswith("    "))
    turns: list[list[str]] = []
    for line in (ln for block in _examples(section) for ln in block):
        if line.startswith("Analyst"):
            turns.append([line])
        elif turns:
            turns[-1].append(line)
    return para, turns


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_takes_a_request_for_a_dashboard_as_a_view(mode, monkeypatch):
    """The guidance says a page the analyst comes back to, such as a dashboard, is a view whatever they call it, and its
    example answers a request for a dashboard with propose_view and a question about the records with a card;
    propose_view's description says what a view is in the same words, so main does not answer it with cards."""
    from app import tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    para, turns = _what_to_make(mode)
    assert "dashboard" in para and "is a view, whatever they call it" in para
    dashboard = next(t for t in turns if "dashboard" in t[0])
    assert any("propose_view" in line for line in dashboard[1:])
    assert any(line.startswith("card") for t in turns for line in t[1:])
    assert "dashboard" in tools.descriptions()["propose_view"]


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_fits_the_reply_to_the_question(mode, monkeypatch):
    """The guidance's example sizes each answer to its question: a casual question answered in a few sentences in the
    chat with no card, and a question about how something works answered with its steps in order and a diagram card,
    with no table."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    _, turns = _what_to_make(mode)
    casual = next(t for t in turns if "folder" in t[0])
    chat = next(line for line in casual if line.startswith("chat"))
    assert "card:" not in chat and chat.count(". ") <= 2
    assert not any(line.startswith(("card", "group", "view")) for line in casual)
    how = next(t for t in turns if "how does" in t[0].lower())
    assert any(line.startswith("chat") for line in how) and any("diagram" in line for line in how)
    assert not any("table" in line for line in how)


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_says_why_a_finding_nobody_asked_for_gets_one_sentence(mode, monkeypatch):
    """The guidance says why a reply stays short: the analyst asks in the middle of other work and reads the answer once,
    so a reply shaped like a report makes them read past what they did not ask for; and a finding they did not ask about
    gets one sentence at most, since they ask when they want more. Without these reasons, replies grew longer and added
    paragraphs that nobody asked for."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    para, _ = _what_to_make(mode)
    assert "in the middle of other work" in para and "shaped like a report" in para
    assert "read past what they did not ask for" in para
    unasked = next(s for s in para.split(". ") if "did not ask about" in s)
    assert "one sentence at most" in unasked and "they ask when they want more" in unasked


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_draws_a_diagram_for_steps_that_branch(mode, monkeypatch):
    """The guidance answers a question about how something works with its steps in order, one sentence each, and a
    diagram card when they branch, as the card kinds say a diagram is for how things branch and connect; its example of
    such a question draws one for steps that branch, not for a straight line of steps."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    kinds = prompts.section("main", "Cards", mode)
    assert "`diagram` for how things branch" in kinds and "Steps in a straight line read better as a timeline" in kinds
    para, turns = _what_to_make(mode)
    how_works = next(s for s in para.split(". ") if "how something works" in s)
    assert "order of its steps" in how_works and "in order in the chat, one sentence each" in how_works
    assert "a diagram card when they branch" in how_works
    how = next(t for t in turns if "how does" in t[0].lower())
    diagram = next(line for line in how if "diagram" in line)
    assert "branch" in diagram or "join" in diagram


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_keeps_the_short_reply_for_a_casual_question(mode, monkeypatch):
    """The guidance says why a casual question, such as what a folder holds, gets two to four sentences in the chat:
    it comes before any analysis, so that the analyst can choose what to ask next. Not a broad question: a broad
    question about the data, such as the main ways the runs fail, asks for analysis, whose work goes in cards."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    para, _ = _what_to_make(mode)
    sentences = para.split(". ")
    i = next(i for i, s in enumerate(sentences) if "casual question" in s)
    assert "folder" in sentences[i] and "before any analysis" in sentences[i] and "what to ask next" in sentences[i]
    short = sentences[i + 1]
    assert "two to four plain sentences in the chat" in short and "without a list or a card" in short
    assert "one thing that stands out" in short
    assert "broad" not in para


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_takes_how_a_project_works_from_its_code(mode, monkeypatch):
    """Main's prompt says where a fact comes from: what a project does from its code, which shows it now, in main's own
    words, since the checker finds words copied from a README in the README; and a README or a design note only for
    what its authors wrote, since it can be out of date."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    section = prompts.section("main", "Citing claims in the chat", mode)
    para = next(p for p in section.split("\n\n") if "README" in p)
    assert "out of date" in para and "read its code" in para and "words copied from a README" in para


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_keeps_the_runs_that_lead_to_an_answer_in_the_shell(mode, monkeypatch):
    """The guidance keeps the runs that lead to an answer, such as a first look at the files, in the shell, which shows
    them folded, and puts only what answers on the canvas; main's prompt no longer puts all of its analysis work in
    cards, which made a first look at the data a card on the canvas."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    main = prompts.load("main", mode)
    assert "analysis work in cards" not in main and "never sees your shell output" not in main
    para, turns = _what_to_make(mode)
    runs = next(s for s in para.split(". ") if "in the shell" in s)
    assert "first look at the files" in runs and "folded" in runs and "Only what answers goes on the canvas" in para
    assert any(line.startswith("shell") for line in turns[0])


def _grouped(blocks: list[list[str]]) -> list[int]:
    """How many cards each group of an example holds: the numbered lines under each `group` line."""
    counts: list[int] = []
    for block in blocks:
        for i, line in enumerate(block):
            if re.match(r"^(Good|Bad)?\s*group\b", line):
                counts.append(len(list(itertools.takewhile(lambda ln: re.match(r"^\d+\s", ln), block[i + 1:]))))
    return counts


@pytest.mark.parametrize("mode", prompts.MODES)
def test_main_names_a_group_only_for_a_sequence_of_cards(mode, monkeypatch):
    """The canvas has no group by default, and a card added without one stands loose on it. add_card's `group` says what
    a group is for, a sequence of cards that answer one question together, and that a single card leaves it out; main's
    examples agree: a single card with no group, and each group a sequence of cards. Before, the description said only
    how to name a group, and two examples put one card in a group."""
    from app import tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    group = tools.tool_sections(["add_card"])["add_card"][1]["properties"]["group"]["description"]
    assert "sequence of cards" in group and "single card" in group
    blocks = [*_examples(prompts.section("main", "What to make", mode)),
              *_examples(prompts.section("main", "Cards", mode)), *_examples(prompts.load("card-types", mode))]
    counts = _grouped(blocks)
    assert counts and min(counts) >= 2, counts
    own = [ln for b in _examples(prompts.section("main", "What to make", mode)) for ln in b if ln.startswith("group")]
    assert own and all(re.search(r'"[^"]+\?"', ln) for ln in own), "the guidance's group is named by its question"
    single = [b for b in blocks if any(line.startswith("question") for line in b)]
    assert single and not _grouped(single), "a card that answers a question alone has no group"
