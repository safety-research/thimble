"""Every package thimble's runtime code imports is a runtime dependency of the backend, not a dev extra. A release
installs the tree's venv from uv.lock's runtime packages (scripts/install.sh), while this suite runs in a venv with the
dev extras, so a module only they provide passes every test here and fails in a release (the plugin's MCP shim, for
one, would die at start and no thimble tool would work). Likewise a release installs only some of the frontend's
packages beside its built UI (release.sh's runtime_npm), which must hold every one the runtime code loads.

The runtime code is the backend's app/ and the plugin's Python scripts, which run on the tree's venv through
plugin/bin/thimble-python. Each one's imports are read from its source, stdlib and the tree's own modules left out, and
each package that provides one must be in the closure of the backend's runtime dependencies in uv.lock, the extras a
dependency names included (uvicorn[standard] brings PyYAML)."""
from __future__ import annotations

import ast
import importlib.metadata
import re
import sys
import tomllib
from pathlib import Path

from app import config

BIN = config.REPO_ROOT / "plugin" / "bin"
PYTHON_SCRIPTS = ("thimble-mcp", ".thimble-watch")  # the ones bin/thimble-python runs; the rest are shell
PROJECT = "thimble-backend"


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def imported(path: Path) -> set[str]:
    """The top-level names of the modules `path` imports anywhere in its source, relative imports left out."""
    out: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text("utf-8"))):
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.add(node.module.split(".")[0])
    return out


def runtime_closure(lock: dict) -> set[str]:
    """The packages a `--no-dev` sync of uv.lock installs: the project's dependencies and theirs, with the extras each
    dependency names."""
    pkgs = {p["name"]: p for p in lock["package"]}
    seen: set[str] = set()
    todo = list(pkgs[PROJECT]["dependencies"])
    while todo:
        dep = todo.pop()
        name = _norm(dep["name"])
        pkg = pkgs.get(name, {})
        todo += [x for extra in dep.get("extra", []) for x in pkg.get("optional-dependencies", {}).get(extra, [])]
        if name not in seen:
            seen.add(name)
            todo += pkg.get("dependencies", [])
    return seen


def test_every_package_the_runtime_code_imports_is_a_runtime_dependency():
    lock = tomllib.loads((config.REPO_ROOT / "backend" / "uv.lock").read_text("utf-8"))
    runtime = runtime_closure(lock)
    providers = importlib.metadata.packages_distributions()
    files = [*(BIN / n for n in PYTHON_SCRIPTS), *sorted((config.REPO_ROOT / "backend" / "app").glob("*.py"))]
    own = {"app", "__future__"}
    missing = []
    for path in files:
        for mod in sorted(imported(path) - set(sys.stdlib_module_names) - own):
            dists = providers.get(mod)
            assert dists, f"{path.name} imports {mod}, which no installed package provides"
            if not any(_norm(d) in runtime for d in dists):
                missing.append(f"{path.name}: {mod} ({', '.join(dists)})")
    assert missing == [], "imported at run time but a dev extra or absent from the runtime dependencies"
    assert "httpx" in runtime, "the shim's channel stream and permission relay"


def test_every_frontend_package_the_runtime_code_loads_is_one_a_release_installs():
    from app import srt, tools, view_libs, views

    release = (config.REPO_ROOT / "scripts" / "release.sh").read_text("utf-8")
    shipped = set(re.search(r"^runtime_npm=\(([^)]*)\)", release, re.M).group(1).split())
    modules = config.REPO_ROOT / "frontend" / "node_modules"
    loaded = {p.relative_to(modules).parts[0] for p in (*views.LIBS.values(), *tools.VEGA_BUILDS, view_libs.ESBUILD)}
    shots = "".join((config.REPO_ROOT / "scripts" / n).read_text("utf-8") for n in ("view_shot.mjs", "ui_shot.mjs"))
    loaded |= set(re.findall(r"require\('([^']+)'\)", shots))
    loaded |= {f"@fontsource/{face}" for face in re.findall(r"\['[^']+', '([^']+)', \[", shots)}
    loaded.add("/".join(srt.PACKAGE[2:]))  # the sandbox runtime of the notebook kernel and of code tickets
    assert {"vega", "playwright", "@fontsource/geist-mono"} <= loaded
    assert loaded - shipped == set(), "loaded at run time but not in release.sh's runtime_npm"
