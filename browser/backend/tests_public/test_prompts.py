"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left;
every hint the code names is a section of prompts/tools.md with the placeholders the code fills; and the browser's
Heads up and Explainers checks say what the terminal plugin's lenses say."""

import ast
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
