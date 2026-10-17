"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left,
with every set of flags (the feature flags and the view build targets); every hint the code names is a section of
prompts/tools.md with the placeholders the code fills; no prompt still describes what went when thimble's agents became
subagents of main (tray entries, sessions of their own, the start and write events); no prompt keeps one of 0.8.0's
mode blocks; and a prompt that names the browser, the canvas or the dashboard names it as the browser workbench."""

import ast
import re
import string
from pathlib import Path


from app import prompts

# the flag sets every prompt renders with: every feature on (the default), every feature off, and each build target
FLAG_SETS = (prompts.DEFAULT_FLAGS, frozenset(), prompts.DEFAULT_FLAGS | {prompts.TERM_PAGE},
             prompts.DEFAULT_FLAGS | {prompts.HTML_PAGE})


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives, with each set of flags — nothing half-filled can
    reach a model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for flags in FLAG_SETS:
        for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
            values = {s: f"<{s}>" for s in prompts.slots(name, flags)}
            out = prompts.render(name, values, flags)
            assert "{{" not in out and "}}" not in out, (sorted(flags), name)


REPO = Path(__file__).resolve().parent.parent.parent
APP = REPO / "backend" / "app"
PLUGIN = REPO / "plugin"

# The hint sections lanes B, M and E name for thimble's subagents, with exactly the placeholders each takes.
# What no prompt says any more, each with what it stood for. The code ticket's prompts keep a session of their own,
# since code tickets stay `claude -p` jobs of the server.
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


def test_agent_definitions_name_a_fixed_description_and_render_clean(monkeypatch):
    """Each agent file a registered role comes from, and the helper's, names the agent and carries the fixed
    description main's agent list shows, and renders with its own slots and no {{...}} left."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for flags in FLAG_SETS:
        for name in (*prompts.AGENT_FILES, "orient-helper"):
            front, _ = prompts.frontmatter(name, flags)
            assert str(front.get("name") or "").strip() and str(front.get("description") or "").strip(), name
            out = prompts.render(name, {s: f"<{s}>" for s in prompts.slots(name, flags)}, flags)
            assert "{{" not in out and "}}" not in out, (sorted(flags), name)


# Words that name what only the browser workbench has. A prompt main or an agent gets uses them only in a sentence that
# names the browser workbench, in a code span (a token or a command, such as the end token `(shown in the dashboard)`,
# the rewake line `thimble browser event:` or `canvas`, a scope's name), or in an html-page block.
# Prompts that keep these words outside such sentences, each with why: the view's builder and reviewer, whose page
# passages are html-page blocks and whose shared ones name the File browser and Color by's chips, which the terminal
# kit has too; video is the browser's only, and its `canvas` is the HTML element.
# Texts that still name 0.8.0's browser mode, each with the lane that removes them (SPEC-v2 3.17, 5.2): left out of
# the scan until then.


def _skill(name: str) -> "tuple[dict, str]":
    import yaml

    head, _, body = (PLUGIN / "skills" / name / "SKILL.md").read_text("utf-8").removeprefix("---\n").partition("\n---\n")
    return yaml.safe_load(head), body


def test_the_skills_usage_has_no_angle_brackets():
    """Claude Code escapes `<` and `>` in a skill's description in the `/thimble` typeahead, which then read
    `/thimble:ask &lt;thread&gt;` (bug hunt F10): each skill's description and argument hint name a placeholder in
    capitals (`THREAD`, `NAME`) instead, as `[limit=N]` does."""
    for d in sorted((PLUGIN / "skills").iterdir()):
        if not (d / "SKILL.md").is_file():
            continue
        front, _ = _skill(d.name)
        for key in ("description", "argument-hint"):
            text = str(front.get(key) or "")
            assert not re.search(r"[<>&]", text), (d.name, key, text)


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
    assert all(re.search(rf"\[--{f} [A-Z]+\]", hint) for f in set(flags) - booleans), hint
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
