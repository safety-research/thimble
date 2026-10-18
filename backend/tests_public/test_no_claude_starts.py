"""thimble starts no Claude Code session of its own (NOCLAUDE.md): every model call runs in the analyst's Claude Code
session, as a completion through its own client (app/model_call.py: the plugin module's $.model.complete and
$.model.fork) or, for long work and the card check, as a subagent of main. A grep over the source, so a new place that
starts `claude` fails here until it is named below.

It reads the backend, the plugin and the scripts, and finds every place that starts a process whose program is
`claude`: a Python call of subprocess, asyncio's subprocess functions or os.exec*/spawn* (read with ast, the program
followed through a local name), a shell line that names `claude` or `$CLAUDE…` with an argument (a message that names a
command counts too, so a shell file is allowed whole), and a JavaScript spawn or exec of it. Each must be in ALLOWED by
file and function (or `<shell>` for a shell file) with the reason it starts no model session, and none may pass a model
session's flags (SESSION_FLAGS) but the release test's stand-in for main and the launcher's exec of the analyst's own
session, which passes the analyst's arguments on. No source imports the Agent SDK, and no dependency list names it.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# (file, function or "<shell>") -> why it starts no model session of thimble's
ALLOWED: dict[tuple[str, str], str] = {
    ("backend/app/config.py", "auth_status"): "`claude auth status --json`: the sign-in, no model",
    ("backend/app/cli.py", "_claude_json"): "`claude plugin list --json`, `claude plugin marketplace list --json`",
    ("backend/app/cli.py", "claude_code_version"): "`claude --version`",
    ("backend/app/feedback.py", "claude_version"): "`claude --version`",
    ("backend/app/harness.py", "session_route"): "`claude -v` for a program that asks the version (the session route "
                                                 "refuses every session)",
    ("backend/app/subagents.py", "_stop_background"): "`claude stop <id>`: stops an agent a 0.5.0 build left running",
    ("plugin/bin/thimble", "<shell>"): "the launcher: execs the analyst's own interactive session, and `claude plugin` "
                                       "and `--version` checks",
    ("scripts/install.sh", "<shell>"): "`claude --version` and `claude plugin …`, and messages that name them",
    ("scripts/plugin.sh", "<shell>"): "`claude plugin …`, and messages that name it",
    ("scripts/update.sh", "<shell>"): "a message that names `claude -c`, the analyst's own session",
    # release and dev tests that play the analyst: their `claude` is the analyst's main, never a session of thimble's
    ("scripts/e2e/contract_print.py", "run"): "the release test's stand-in for main in `claude -p`",
    ("scripts/e2e/contract_print.py", "other_thimbles"): "`claude plugin list --json`",
    ("scripts/e2e/contract_print.py", "main"): "`claude --version` for the summary",
    ("scripts/e2e_release.sh", "<shell>"): "the release test: `claude --version`, `claude plugin` in the plan",
}
# a model session's flags, which no allowed start but the stand-in for main may pass
SESSION_FLAGS = ("--print", "--resume", "--resume-session-at", "--fork-session", "--session-id", "--continue",
                 "--output-format", "--input-format", "--system-prompt", "--append-system-prompt",
                 "--permission-prompt-tool", "--no-session-persistence", "stream-json")
PLAYS_MAIN = {("scripts/e2e/contract_print.py", "run")}
SDK = re.compile(r"claude[_-]agent[_-]sdk|@anthropic-ai/claude-(agent-sdk|code)\b")

PROCESS_CALLS = {"subprocess.run", "subprocess.Popen", "subprocess.call", "subprocess.check_call",
                 "subprocess.check_output", "asyncio.create_subprocess_exec", "asyncio.create_subprocess_shell",
                 "os.execv", "os.execve", "os.execvp", "os.execvpe", "os.execl", "os.execle", "os.execlp", "os.execlpe",
                 "os.spawnv", "os.spawnvp", "os.spawnl", "os.spawnlp", "os.posix_spawn", "os.posix_spawnp", "pty.spawn",
                 "Popen", "create_subprocess_exec", "create_subprocess_shell"}
NAMES_CLAUDE = re.compile(r"claude|CLI_PATH", re.I)
# `claude` or `$CLAUDE…` followed by an argument, not a part of a path or a name (.claude/, claude-plugin, CLAUDE_CONFIG_DIR)
SHELL_RUN = re.compile(r"""(?<![\w./-])(?:\$\{?[A-Z_]*CLAUDE[A-Z_]*\}?|claude)"?\s+(?:-{1,2}[A-Za-z]|[a-z]{2,}\b|"?\$)""")
JS_RUN = re.compile(r"""\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*([^,)]*claude[^,)]*)""", re.I)


def _sources(*globs: str) -> list[Path]:
    out: list[Path] = []
    for g in globs:
        out += [p for p in REPO.glob(g) if p.is_file() and "node_modules" not in p.parts and "__pycache__" not in p.parts]
    return sorted(set(out))


def _python_files() -> list[Path]:
    files = _sources("backend/app/**/*.py", "backend/agent_kit/**/*.py", "scripts/**/*.py")
    files += [p for p in _sources("plugin/bin/*", "plugin/bin/.*") if p.read_text("utf-8", "replace").startswith(
        "#!/bin/sh\n''''")]
    return files


def _shell_files() -> list[Path]:
    out = []
    for p in _sources("plugin/bin/*", "scripts/**/*.sh", "plugin/hooks/**/*.sh"):
        head = p.read_text("utf-8", "replace")[:200]
        if p.suffix == ".sh" or (head.startswith("#!") and "''''" not in head and "sh" in head.splitlines()[0]):
            out.append(p)
    return out


def _dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_dotted(node.value)}.{node.attr}"
    return ""


class _Starts(ast.NodeVisitor):
    """Each process start in a module whose program names `claude`: (function, the call's source)."""

    def __init__(self, text: str) -> None:
        self.text, self.where, self.found = text, ["<module>"], []
        self.assigned: list[dict[str, list[ast.AST]]] = [{}]

    def _func(self, node: ast.AST) -> None:
        self.where.append(node.name)  # type: ignore[attr-defined]
        names: dict[str, list[ast.AST]] = {}
        for sub in ast.walk(node):
            if isinstance(sub, (ast.Assign, ast.AnnAssign)) and sub.value is not None:
                for t in (sub.targets if isinstance(sub, ast.Assign) else [sub.target]):
                    if isinstance(t, ast.Name):
                        names.setdefault(t.id, []).append(sub.value)
        self.assigned.append(names)
        self.generic_visit(node)
        self.assigned.pop()
        self.where.pop()

    visit_FunctionDef = visit_AsyncFunctionDef = _func

    def _program(self, call: ast.Call) -> str:
        """The source of the call's program: the first element of its argv, followed through local names."""
        arg = call.args[0] if call.args else next((k.value for k in call.keywords if k.arg in ("args", "file")), None)
        if arg is None:
            return ""
        if isinstance(arg, (ast.List, ast.Tuple)) and arg.elts:
            arg = arg.elts[0]
        if isinstance(arg, ast.Starred):
            arg = arg.value
        nodes = [arg] + ([v for scope in self.assigned for v in scope.get(arg.id, [])] if isinstance(arg, ast.Name) else [])
        return " ".join(ast.unparse(n) for n in nodes)

    def visit_Call(self, node: ast.Call) -> None:
        if _dotted(node.func) in PROCESS_CALLS and NAMES_CLAUDE.search(self._program(node)):
            self.found.append((self.where[-1], ast.unparse(node)))
        self.generic_visit(node)


def _starts() -> list[tuple[str, str, str]]:
    """(file, function or <shell>, the source) of every place that starts `claude`."""
    out = []
    for p in _python_files():
        text = p.read_text("utf-8")
        v = _Starts(text)
        v.visit(ast.parse(text, str(p)))
        out += [(str(p.relative_to(REPO)), where, src) for where, src in v.found]
    for p in _shell_files():
        for line in p.read_text("utf-8", "replace").splitlines():
            if line.lstrip().startswith("#"):
                continue
            if SHELL_RUN.search(line):
                out.append((str(p.relative_to(REPO)), "<shell>", line.strip()))
    for p in _sources("plugin/**/*.ts", "plugin/**/*.tsx", "plugin/**/*.mjs", "backend/app/**/*.mjs", "scripts/**/*.mjs"):
        if p.name.endswith((".test.ts", ".test.tsx")):
            continue
        for m in JS_RUN.finditer(p.read_text("utf-8", "replace")):
            out.append((str(p.relative_to(REPO)), "<js>", m.group(0)))
    return out


def test_thimble_starts_claude_only_where_it_starts_no_model_session():
    starts = _starts()
    assert any(f == "plugin/bin/thimble" and src.startswith("exec claude") for f, _, src in starts), \
        "the scan must find the launcher's exec of the analyst's own session"
    new = sorted({(f, w) for f, w, _ in starts} - set(ALLOWED))
    assert not new, ("a new place starts `claude`; thimble starts no Claude Code session of its own (NOCLAUDE.md). "
                     "Run the model call through the session's own client (app/model_call.py), or, for a start "
                     f"with no model session, add it to ALLOWED with its reason: {new}")
    flagged = [(f, w, src) for f, w, src in starts if (f, w) not in PLAYS_MAIN
               and re.search(r"(?<![\w-])(-p|" + "|".join(map(re.escape, SESSION_FLAGS)) + r")(?![\w-])", src)
               and not (f == "plugin/bin/thimble" and re.search(r"\bexec\b", src))]
    assert not flagged, f"a start of `claude` passes a model session's flags: {flagged}"


def test_nothing_imports_or_depends_on_the_agent_sdk():
    hits = [str(p.relative_to(REPO)) for p in _sources("backend/app/**/*", "backend/agent_kit/**/*", "plugin/**/*",
                                                       "scripts/**/*", "backend/pyproject.toml", "frontend/package.json")
            if p.suffix in ("", ".py", ".ts", ".tsx", ".mjs", ".js", ".sh", ".toml", ".json")
            and SDK.search("\n".join(line for line in p.read_text("utf-8", "replace").splitlines()
                                     if not line.lstrip().startswith(("#", "//", "*"))))]
    assert not hits, f"the Agent SDK is gone (NOCLAUDE.md): {hits}"
    deps = json.loads((REPO / "frontend" / "package.json").read_text("utf-8"))
    assert not any(SDK.search(k) for k in {**deps.get("dependencies", {}), **deps.get("devDependencies", {})})
