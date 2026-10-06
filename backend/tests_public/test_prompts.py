"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left, in
browser mode and in terminal mode; every hint the code names is a section of prompts/tools.md with the placeholders the
code fills; no prompt still describes what went when thimble's agents became subagents of main (tray entries, sessions
of their own, the start and write events); and no prompt that main or an agent gets in terminal mode names the browser,
the canvas or the dashboard."""

import ast
import re
import string
from pathlib import Path

from app import prompts


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives, in each mode — nothing half-filled can reach a
    model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for mode in prompts.MODES:
        for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
            values = {s: f"<{s}>" for s in prompts.slots(name, mode)}
            out = prompts.render(name, values, mode)
            assert "{{" not in out and "}}" not in out, (mode, name)


def test_main_renders_with_either_ending(tmp_path, monkeypatch):
    """Main's prompt renders with the ending of each Claude Code (terminal_tools.ENDINGS), each found on exactly one
    line, in browser mode and in terminal mode."""
    from app import events, terminal_tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for mode in prompts.MODES:
        with prompts.rendering(mode):
            for terminal in (True, False):
                out = events.render_prompts(["main"], str(tmp_path), terminal=terminal)
                assert terminal_tools.ENDINGS[terminal] in out and terminal_tools.ENDINGS[not terminal] not in out


def test_the_terminal_tools_name_the_subagent_calls():
    """The launcher's CLAUDE_CODE_TERMINAL_MCP_TOOLS names Agent, SendMessage and TaskStop, the calls main makes to start,
    continue and stop thimble's subagents, so a turn that ends on one gets no empty-turn nudge (terminal_tools)."""
    from app import terminal_tools

    assert {"Agent", "SendMessage", "TaskStop"} <= set(terminal_tools.BUILTIN)
    names = terminal_tools.names()
    assert names[:len(terminal_tools.BUILTIN)] == list(terminal_tools.BUILTIN)
    assert "TaskStop" in terminal_tools.value({}).split(",")


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
    """main.md tells main to answer a hand-back of one of thimble's agents in one short line, and to write that line
    for a task notification that follows a report it answered too, since a turn without text makes Claude Code ask
    again (a turn more); orient.md tells the orientation to start its own subagents as thimble:orient-helper."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    [line] = [line for line in prompts.load("main").splitlines() if "hands back" in line and "one short line" in line]
    assert "task notification comes after a report" in line and "Always write this line" in line
    assert all(end in line for end in ("finished", "stopped", "failed")), "the line says how the agent ended"
    assert "thimble:orient-helper" in prompts.load("orient")


def test_agent_definitions_name_a_fixed_description_and_render_clean(monkeypatch):
    """Each agent file a registered role comes from, and the helper's, names the agent and carries the fixed
    description main's agent list shows, and renders with its own slots and no {{...}} left."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for mode in prompts.MODES:
        for name in (*prompts.AGENT_FILES, "orient-helper"):
            front, _ = prompts.frontmatter(name, mode)
            assert str(front.get("name") or "").strip() and str(front.get("description") or "").strip(), name
            out = prompts.render(name, {s: f"<{s}>" for s in prompts.slots(name, mode)}, mode)
            assert "{{" not in out and "}}" not in out, (mode, name)


# --------------------------------------------------------------------------- modes: browser and terminal

import sys  # noqa: E402
import types  # noqa: E402

import pytest  # noqa: E402


def _fixture(tmp_path, monkeypatch, files: dict[str, str]) -> None:
    for name, text in files.items():
        (tmp_path / name).write_text(text, "utf-8")
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(tmp_path))


def test_a_mode_block_keeps_its_text_only_in_its_mode(tmp_path, monkeypatch):
    """`{{if:<mode>}}…{{end}}` keeps its text in its mode and drops it in the other; a marker alone on its line takes
    the line with it; an include or a slot inside a block left out is never read or asked for."""
    _fixture(tmp_path, monkeypatch, {
        "a.md": "Top {{if:browser}}B{{end}}{{if:terminal}}T {{who}}{{end}} end.\n\n{{if:terminal}}\n{{include:t}}\n"
                "{{end}}\nlast\n",
        "t.md": "terminal line\n",
    })
    assert prompts.load("a", "browser") == "Top B end.\n\nlast\n"
    assert prompts.load("a", "terminal") == "Top T {{who}} end.\n\nterminal line\nlast\n"
    assert prompts.files("a", "browser") == ["a.md"] and prompts.files("a", "terminal") == ["a.md", "t.md"]
    assert prompts.render("a", {}, "browser") == "Top B end.\n\nlast\n"
    assert prompts.slots("a", "terminal") == {"who"}
    (tmp_path / "t.md").unlink()
    assert prompts.load("a", "browser")  # the include is in a block browser mode leaves out
    with pytest.raises(prompts.PromptError, match="t.md"):
        prompts.load("a", "terminal")


@pytest.mark.parametrize(("text", "says"), [
    ("{{if:web}}x{{end}}", "unknown mode 'web'"),
    ("{{if:browser}}x{{if:terminal}}y{{end}}", "inside the"),
    ("x{{end}}", "no {{if:<mode>}} block open"),
    ("{{if:terminal}}x", "not closed"),
])
def test_a_broken_mode_block_names_its_file(tmp_path, monkeypatch, text, says):
    """An unknown mode, a block inside a block, an `{{end}}` with no block open and a block left open each raise
    PromptError naming the file, in either mode, as an unknown directive does."""
    _fixture(tmp_path, monkeypatch, {"bad.md": text})
    for mode in prompts.MODES:
        with pytest.raises(prompts.PromptError, match="bad.md") as e:
            prompts.load("bad", mode)
        assert says in str(e.value)


def test_a_mode_section_replaces_its_section_in_its_mode(tmp_path, monkeypatch):
    """`## <name>@terminal` gives `## <name>` its body in terminal mode, in place, and is left out in browser mode; one
    with no `## <name>` is that section in its own mode only; two of one name and mode raise PromptError."""
    _fixture(tmp_path, monkeypatch, {"h.md": "Head.\n\n## x\n\nbrowser {a}\n\n## x@terminal\n\nterminal {a}\n\n"
                                             "## y@terminal\n\nonly here\n\n## z\n\nz body\n"})
    assert prompts.load("h", "browser") == "Head.\n\n## x\n\nbrowser {a}\n\n## z\n\nz body\n"
    assert prompts.load("h", "terminal") == "Head.\n\n## x\n\nterminal {a}\n\n## y\n\nonly here\n\n## z\n\nz body\n"
    assert prompts.section("h", "x", "terminal") == "terminal {a}\n"
    assert prompts.render_section("h", "y", {}, "terminal") == "only here\n"
    with pytest.raises(prompts.PromptError, match="no section"):
        prompts.section("h", "y", "browser")
    _fixture(tmp_path, monkeypatch, {"last.md": "## x\n\nb\n\n## z\n\nz\n\n## x@terminal\n\nt\n"})
    assert prompts.load("last", "terminal") == "## x\n\nt\n\n## z\n\nz\n\n"
    _fixture(tmp_path, monkeypatch, {"two.md": "## x@terminal\n\none\n\n## x@terminal\n\ntwo\n"})
    assert prompts.load("two", "browser") == ""
    with pytest.raises(prompts.PromptError, match="two sections"):
        prompts.load("two", "terminal")


def test_a_heading_with_a_mode_block_is_found_by_its_browser_text(tmp_path, monkeypatch):
    """Code names a section by its heading as browser mode writes it (events.EVENTS_SECTION), so a heading whose words
    differ by mode is found by those words in terminal mode too."""
    _fixture(tmp_path, monkeypatch, {"m.md": "## Events from {{if:browser}}the browser{{end}}{{if:terminal}}thimble"
                                             "{{end}}\n\n- `a` one{{if:terminal}} here{{end}}\n\n## Other\n\nx\n"})
    assert prompts.load("m", "terminal").startswith("## Events from thimble\n")
    assert prompts.section("m", "Events from the browser", "terminal") == "- `a` one here\n"
    assert prompts.section("m", "Events from thimble", "terminal") == "- `a` one here\n"
    assert prompts.section("m", "Events from the browser", "browser") == "- `a` one\n"


class _FakeLaunchMode(types.ModuleType):
    """app.launch_mode as the mode lane builds it, reduced to current(): the session's mode, counted."""

    def __init__(self, mode: str) -> None:
        super().__init__("app.launch_mode")
        self.mode, self.asked = mode, 0

    def current(self, cwd=None) -> str:  # noqa: ARG002 — the real one reads the session's launch record
        self.asked += 1
        return self.mode


def _session_mode(monkeypatch, fake: "types.ModuleType | None") -> None:
    import app

    monkeypatch.setitem(sys.modules, "app.launch_mode", fake)
    if fake is None:
        monkeypatch.delattr(app, "launch_mode", raising=False)
    else:
        monkeypatch.setattr(app, "launch_mode", fake, raising=False)


def test_the_mode_comes_from_the_call_the_block_or_the_session(tmp_path, monkeypatch):
    """A prompt renders in the call's mode, else the `rendering` block's, else the session's (launch_mode.current()),
    else browser; a file with no mode block or mode section never asks the session."""
    _fixture(tmp_path, monkeypatch, {"a.md": "{{if:browser}}B{{end}}{{if:terminal}}T{{end}}", "plain.md": "P"})
    fake = _FakeLaunchMode("terminal")
    _session_mode(monkeypatch, fake)
    assert prompts.load("plain") == "P" and fake.asked == 0
    assert prompts.load("a") == "T" and fake.asked == 1
    with prompts.rendering("browser"):
        assert prompts.load("a") == "B" and prompts.load("a", "terminal") == "T"
    assert prompts.current_mode() == "terminal"
    fake.mode = "neither"
    assert prompts.load("a") == "B"  # a session mode thimble does not know renders browser mode
    _session_mode(monkeypatch, None)  # a tree without app.launch_mode has browser mode only
    assert prompts.load("a") == "B"
    with pytest.raises(prompts.PromptError, match="unknown mode"):
        prompts.load("a", "web")
    with pytest.raises(prompts.PromptError, match="unknown mode"):
        with prompts.rendering("web"):
            pass


def test_tools_md_reads_in_the_session_mode(tmp_path, monkeypatch):
    """tools.hint and the tool listing read prompts/tools.md in the session's mode: a hint's `@terminal` section and a
    description's terminal block in terminal mode, the browser text otherwise."""
    from app import tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    _session_mode(monkeypatch, _FakeLaunchMode("terminal"))
    terminal = tools.tool_sections(["add_card"])["add_card"][0]
    with prompts.rendering("browser"):
        browser = tools.tool_sections(["add_card"])["add_card"][0]
        assert tools.hint("start-refused-fork") != ""
        refused_browser = tools.hint("start-refused-fork")
    assert "Bash" in terminal and "Bash" not in browser
    assert "/thimble:orient" in tools.hint("start-refused-fork") and "/thimble:orient" not in refused_browser


def test_the_event_kinds_are_the_same_in_both_modes(monkeypatch):
    """events.kinds() reads main.md's events section, whose heading differs by mode, and finds the same kinds in
    each, so events.post refuses or takes a kind the same way in both modes."""
    from app import events

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    found = {}
    for mode in prompts.MODES:
        with prompts.rendering(mode):
            found[mode] = events.kinds()
    assert found["browser"] == found["terminal"] and "thread" in found["terminal"]


def test_the_orientation_parts_leave_out_cleanly_in_both_modes(monkeypatch):
    """orient_session leaves out parts of orient.md by heading and by line, strictly; each of those headings and
    lines is still there in terminal mode."""
    from app import orient_session

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for mode in prompts.MODES:
        text = prompts.agent_prompt("orient", {s: "<x>" for s in prompts.slots("orient", mode)}, mode)
        lines = [*orient_session.LINES.values(), *orient_session.OUTPUT_LINES, *orient_session.VIEWS_LINES]
        out = prompts.without(text, orient_session.PARTS.values(), lines)
        assert all(line not in out for line in lines), mode


# The hint sections the terminal-mode lanes name (modes PLAN.md, Prompt modes), with exactly their placeholders.
TERMINAL_HINTS = {
    "card-run": {"command"},
    "label-run": {"command"},
    "cards-stale": {"cards", "command"},
    "screenshot-terminal": set(),
    "thimble-terminal-home": set(),
    "ticket-terminal": set(),
}


def test_the_terminal_hints_have_their_placeholders(monkeypatch):
    """Each hint the backend, mode and agents lanes give in terminal mode is a section of prompts/tools.md there, with
    exactly its placeholders; the line /thimble prints in terminal mode is a `thimble:` line, which the skill's reply
    repeats."""
    from app import tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    with prompts.rendering("terminal"):
        hints = tools.descriptions()
    wrong = {name: sorted(_fields(hints[name])) if name in hints else "missing"
             for name, want in TERMINAL_HINTS.items() if name not in hints or _fields(hints[name]) != want}
    assert not wrong, wrong
    assert hints["thimble-terminal-home"].startswith("thimble: ") and "\n" not in hints["thimble-terminal-home"]


def test_the_hints_the_hooks_read_raw_have_no_mode_block(monkeypatch):
    """subagent_files.hint, which the hooks run without the backend, reads a section of prompts/tools.md as written,
    so a hint it names says one thing in both modes, never through a mode block."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    raw = (REPO / "prompts" / "tools.md").read_text("utf-8")
    named = {n for where, names, _ in _Code().calls() if where.split(":")[0] in ("subagent_files", ".thimble-watch")
             for n in names}
    assert {"agent-check-exact", "start_orientation-running"} <= named, "the scan found the raw reader's hints"
    blocked = [n for n in sorted(named)
               if (m := re.search(rf"^## {re.escape(n)}[ \t]*\n(.*?)(?=^## \S|\Z)", raw, re.M | re.S))
               and re.search(r"\{\{(if:|end\}\}|include:)", m.group(1))]
    assert not blocked, blocked


# Words that name what only browser mode has. A prompt main or an agent gets in terminal mode uses none of them outside
# a `{{if:browser}}` block, a code span (a token or a command, such as the end token `(shown in the dashboard)`, the
# rewake line `thimble browser event:` or `canvas`, a scope's name) or the name of the other mode, "browser mode".
BROWSER_WORDS = re.compile(r"\bbrowser|\bcanvas|\bdashboard|⌘|\bchips?\b", re.I)
# Prompts that keep these words in terminal mode, each with why: the view page stays a browser page, video is browser
# mode's only, and its `canvas` is the HTML element.
BROWSER_ONLY_PROMPTS = {"dev-view.md": "the view page", "report-video.md": "video"}
BROWSER_ONLY_HINTS = {"view-media-unplayable": "the view page", "view-marks-missing": "the view page"}


def _browser_words(text: str) -> list[str]:
    prose = re.sub(r"`[^`\n]*`", "", text).replace("browser mode", "")
    return [prose[max(0, m.start() - 40):m.end() + 20].replace("\n", " ") for m in BROWSER_WORDS.finditer(prose)]


def _descriptions(schema: object) -> "list[str]":
    """Every `description` string of a JSON schema, at any depth."""
    if isinstance(schema, dict):
        own = [schema["description"]] if isinstance(schema.get("description"), str) else []
        return own + [d for v in schema.values() for d in _descriptions(v)]
    if isinstance(schema, list):
        return [d for v in schema for d in _descriptions(v)]
    return []


def test_no_terminal_mode_prompt_names_the_browser(tmp_path, monkeypatch):
    """Rendered in terminal mode, main's prompt, every prompt file, every tool's description and schema, every hint and
    every skill name the browser, the canvas, the dashboard, ⌘ or a chip only inside a `{{if:browser}}` block."""
    from app import events, tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    found: list[str] = []
    with prompts.rendering("terminal"):
        for terminal in (True, False):
            found += [f"main: {w}" for w in _browser_words(events.render_prompts(["main"], str(tmp_path), terminal))]
        for path in sorted((REPO / "prompts").rglob("*.md")):
            rel = str(path.relative_to(REPO / "prompts"))
            if rel in BROWSER_ONLY_PROMPTS or rel == "tools.md":
                continue
            name = rel.removesuffix(".md")
            text = prompts.render(name, {s: "X" for s in prompts.slots(name)})
            found += [f"{rel}: {w}" for w in _browser_words(text)]
        for name, (desc, schema) in tools.tool_sections().items():
            found += [f"tools.md ## {name}: {w}" for d in (desc, *_descriptions(schema)) for w in _browser_words(d)]
        found += [f"tools.md ## instructions: {w}" for w in _browser_words(tools.instructions())]
        for name, body in tools.descriptions().items():
            if name not in tools.REGISTRY and name not in BROWSER_ONLY_HINTS:
                found += [f"tools.md ## {name}: {w}" for w in _browser_words(body)]
    for path in sorted((PLUGIN / "skills").glob("*/SKILL.md")):
        found += [f"{path.relative_to(REPO)}: {w}" for w in _browser_words(path.read_text("utf-8"))]
    assert not found, found
    with prompts.rendering("browser"):
        assert _browser_words(events.render_prompts(["main"], str(tmp_path), True)), "the scan finds browser mode's words"


def _skill(name: str) -> "tuple[dict, str]":
    import yaml

    head, _, body = (PLUGIN / "skills" / name / "SKILL.md").read_text("utf-8").removeprefix("---\n").partition("\n---\n")
    return yaml.safe_load(head), body


def test_the_skills_flags_match_their_tools_arguments():
    """/thimble:orient's flags are one set, each naming one argument of start_orientation, with every argument but the
    brief set by one; /thimble:label's keys are apply_label's arguments, its kinds the predicate's; /thimble:write
    names only start_writing's arguments. Each skill's description shows the syntax of its argument hint."""
    from app import tools

    front, body = _skill("orient")
    schema = tools.schema_of("start_orientation")["properties"]
    flags = dict(re.findall(r"`--([a-z]+)` sets `([a-z_]+)`", body))
    assert set(flags.values()) == set(schema) - {"brief"}, flags
    booleans = {f for f, arg in flags.items() if schema[arg].get("type") == "boolean"}
    hint = front["argument-hint"]
    assert all(f"[--[no-]{f}]" in hint for f in booleans), hint
    assert all(f"[--{f} <" in hint for f in set(flags) - booleans), hint
    assert hint.removeprefix("[focus] ") in front["description"]

    front, body = _skill("label")
    schema = tools.schema_of("apply_label")["properties"]
    hint = front["argument-hint"]
    keys = dict(re.findall(r"\[([a-z]+)=([^\]]+)\]", hint))
    assert set(keys) == {"kind", "paths", "values", "limit"}, keys
    assert set(keys["kind"].split("|")) == set(schema["predicate"]["properties"]["kind"]["enum"])
    assert {"paths", "values", "limit"} <= set(schema) and "scope" in body and "`files`" in body
    assert hint in front["description"] and front.get("disable-model-invocation") is True

    front, body = _skill("write")
    schema = tools.schema_of("start_writing")["properties"]
    named = set(re.findall(r"as `([a-z_]+)`|`([a-z_]+)` is|are `([a-z_]+)`", body))
    args = {a for group in named for a in group if a}
    assert args and args <= set(schema), args
    assert front["argument-hint"] in front["description"] and front.get("disable-model-invocation") is True
