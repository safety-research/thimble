"""The hooks tests cannot see the kernel's Python files, which lets the checks of a fix to those files alone leave them
out (kernel/fixes.py KERNEL_ONLY). Their runner takes a test file anywhere in the plugin, but no Python file. A hooks
test reads no file and starts no process: its `$` is the kit's, and the test answers each effect itself (tests/kit.ts).
So it sees the plugin's files only through what it imports. This walks the imports from each hooks test and from the
hooks module (hooks/hooks.json): each one is the kit's (`claude-code`, `claude-code/testing`) or a file of the plugin
that is none of those Python files, none is made at run time, and no file uses a name that the runtime gives every
module to read files or start processes with."""
from __future__ import annotations

import fnmatch
import json
import re
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN / "engine"))

from kernel import fixes as FX  # noqa: E402

KIT = ("claude-code", "claude-code/testing")
CODE = (".ts", ".tsx", ".js", ".mjs")
# the module an import or an export names, in a statement that starts its line
NAMED = re.compile(r"""^[ \t]*(?:import\s*|(?:import|export)\b[^'"`;]*?\bfrom\s*)(['"])([^'"\n]+)\1""", re.M)
# an import made at run time, and the names the runtime gives every module
RUN_TIME = re.compile(r"""\b(import|require)\s*\(|(?<![.$\w'"])(process|Bun|Deno)\.\w|\b(globalThis)\b""")
FIX = ("thimble leaves the hooks tests out of the checks of a fix to the kernel's Python files alone (kernel/fixes.py "
       "KERNEL_ONLY): keep the hooks tests and the hooks module off those files and off the runtime's own modules, or "
       "take that skip away")


def problems(plugin: Path) -> list[str]:
    """What the hooks tests of `plugin` and its hooks module reach that the checks of a fix count on them not to."""
    plugin = plugin.resolve()
    # a hooks test is a *.test.ts or *.test.tsx file, wherever it is in the plugin
    todo = [*sorted(plugin.rglob("*.test.ts")), *sorted(plugin.rglob("*.test.tsx")),
            *((plugin / "hooks" / m).resolve() for m in json.loads((plugin / "hooks" / "hooks.json").read_text())["modules"])]
    seen: set[Path] = set()
    out: list[str] = []
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        rel = f.relative_to(plugin).as_posix()
        # a line that is a comment says nothing of what the file does
        code = "\n".join(line for line in f.read_text().splitlines() if not line.lstrip().startswith(("//", "/*", "*")))
        used = RUN_TIME.search(code)
        if used:
            out.append(f"{rel} uses {used.group(1) + '()' if used.group(1) else used.group(2) or used.group(3)}")
        for _, name in NAMED.findall(code):
            if not name.startswith("."):
                if name not in KIT:
                    out.append(f"{rel} imports {name}")
                continue
            at = f.parent / name
            to = next((p.resolve() for p in (at, at.with_name(at.name + ".ts"), at.with_name(at.name + ".tsx"),
                                             at / "index.ts") if p.is_file()), None)
            path = f"plugin/{to.relative_to(plugin).as_posix()}" if to and plugin in to.parents else None
            if path is None or any(fnmatch.fnmatch(path, pat) for pat in FX.KERNEL_ONLY):
                out.append(f"{rel} imports {name}")
            elif to.suffix in CODE:
                todo.append(to)
    return sorted(out)


def test_no_hooks_test_can_see_the_kernels_code_or_its_tests():
    assert problems(PLUGIN) == [], FIX


def test_the_walk_names_what_reaches_the_kernel_or_the_runtime(tmp_path):
    files = {
        "hooks/hooks.json": '{"modules": ["./register.ts"]}',
        "hooks/register.ts": "import { bar } from '../bar/bar'\nexport { run } from '../core/run.mjs'\n",
        "bar/bar.tsx": "import type { Engine } from 'claude-code'\n// import fs from 'node:fs' was here once\n"
                       "import rows from '../engine/kernel/rows.py'\nexport const bar = ($: Engine) => $.process.run(['ls'])\n",
        "core/run.mjs": "export const run = async () => (await import('node:child_process')).execSync('ls')\n",
        "engine/kernel/rows.py": "",
        "tests/bar.test.ts": "import { expect } from 'claude-code/testing'\nimport {\n  readFileSync,\n} from 'node:fs'\n"
                             "import '../conftest.py'\nconst home = process.env.HOME\n",
        "conftest.py": "",
        # a hooks test outside tests/, which the runner takes too
        "engine/kernel/rows.test.ts": "import '../../tests/test_rows.py'\n",
        "tests/test_rows.py": "",
    }
    for name, text in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text)
    assert problems(tmp_path) == ["bar/bar.tsx imports ../engine/kernel/rows.py", "core/run.mjs uses import()",
                                  "engine/kernel/rows.test.ts imports ../../tests/test_rows.py",
                                  "tests/bar.test.ts imports ../conftest.py", "tests/bar.test.ts imports node:fs",
                                  "tests/bar.test.ts uses process"]
