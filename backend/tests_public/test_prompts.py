"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left;
every hint the code names is a section of prompts/tools.md with the placeholders the code fills; and no prompt still
describes what went when thimble's agents became subagents of main (tray entries, sessions of their own, the start and
write events)."""

import ast
import re
import string
from pathlib import Path

from app import prompts


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives — nothing half-filled can reach a model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
        values = {s: f"<{s}>" for s in prompts.slots(name)}
        out = prompts.render(name, values)
        assert "{{" not in out and "}}" not in out, name


def test_main_renders_with_either_ending(tmp_path, monkeypatch):
    """Main's prompt renders with the ending of each mode (terminal_tools.ENDINGS), each found on exactly one line."""
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
    "start_orientation-subagent": {"input"},
    "start_writing-subagent": {"input"},
    "start_job-subagent": {"input"},
    "critique-subagent": {"input"},
    "orient-subagent-prompt": {"request_id", "request", "outputs", "off", "critique"},
    "orient-subagent-message": {"agent", "text"},
    "subagent-request": {"request_id"},
    "agent-check-exact": set(),
    "agent-check-message": set(),
    "start-plan-mode": set(),
    "writer-context-file": {"path"},
    "critic-brief-file": {"path"},
    "critique-work-folder": {"path"},
    "check-task-file": {"path"},
    "start-refused-not-launched": set(),
    "start-refused-no-module": {"reason"},
    "orient-continue-earlier-session": {"resume"},
    "orient-continue-earlier-version": set(),
    "module-started-note": {"role", "agent", "what"},
    "follow-up-ran-on": {"model", "effort"},
    "finish-view-pass": set(),
    "finish-view-fail": {"report", "n", "of"},
    "finish-view-stop": set(),
    "finish-review-again": set(),
    "finish-review-done": set(),
    "finish-review-restored": set(),
    "view-pictures": {"paths", "records"},
}
# What no prompt says any more, each with what it stood for. The code ticket's prompts keep a session of their own,
# since code tickets stay `claude -p` jobs of the server.
GONE = {
    r"\bwait_session\b": "the tray entries' wait_session tool",
    r"\btray entr(y|ies)\b": "a tray entry",
    r"claude attach": "claude attach",
    r"view_check\.py|\{\{check\}\}": "a check command the agent runs itself, outside the sandbox",
    r"allow each package|package approval|thimble approves": "an install that thimble approves",
    r"`(start|write)` (event|asks)|\b(a|the) (start|write) event\b": "a `start` or `write` event",
    r"\bsessions? of (its|your|their) own\b": "a session of its own",
}
CODE_TICKET_PROMPTS = ("dev-ticket.md", "dev-fix.md", "dev-gates.md")
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


def test_no_prompt_describes_what_went_with_the_headless_agents():
    """No prompt or skill names the tray entries, wait_session, claude attach, a check command the agent runs outside
    the sandbox, an install thimble approves, a `start` or `write` event, or a session of its own for one of thimble's
    subagents."""
    found = []
    for path in sorted([*(REPO / "prompts").rglob("*.md"), *(PLUGIN / "skills").glob("*/SKILL.md")]):
        if path.name in CODE_TICKET_PROMPTS:
            continue
        for i, line in enumerate(path.read_text("utf-8").splitlines(), 1):
            found += [f"{path.relative_to(REPO)}:{i} names {what}" for pat, what in GONE.items() if re.search(pat, line)]
    assert not found, found


def test_main_and_the_orientation_say_how_subagents_end_and_start(monkeypatch):
    """main.md tells main to answer a hand-back of one of thimble's agents in one short line, and orient.md tells the
    orientation to start its own subagents as thimble:helper."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    assert any("hands back" in line and "one short line" in line for line in prompts.load("main").splitlines())
    assert "thimble:helper" in prompts.load("orient")


def test_agent_definitions_name_a_fixed_description_and_render_clean(monkeypatch):
    """Each agent file a registered role comes from, and the helper's, names the agent and carries the fixed
    description main's agent list shows, and renders with its own slots and no {{...}} left."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for name in (*prompts.AGENT_FILES, "helper"):
        front, _ = prompts.frontmatter(name)
        assert str(front.get("name") or "").strip() and str(front.get("description") or "").strip(), name
        out = prompts.render(name, {s: f"<{s}>" for s in prompts.slots(name)})
        assert "{{" not in out and "}}" not in out, name
