"""app.view_libs: a view's page may load any npm package. The view's builder installs it in its own folder with its own
Bash call (`npm install --ignore-scripts`), which Claude Code decides by main's permission mode, and thimble asks
nothing and installs nothing itself: when the view is checked, it bundles each package from that folder into the view's
lib folder and inlines it into the page, which then loads nothing from the network. A package the folder does not hold,
or holds at a version the entry does not allow, leaves the view a problem to fix.

The builder's install is faked (`install` writes the packages of PACKAGES into a builder's folder as npm would); esbuild
is the frontend's own, and the bundles run in Node with a stand-in window."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app import view_libs

PACKAGES = {  # name -> (version, unpacked bytes, dependencies, files)
    "tiny-graph": ("2.1.0", 5000, {"tiny-queue": "^1"}, {
        "package.json": json.dumps({"name": "tiny-graph", "version": "2.1.0", "main": "index.js"}),
        "index.js": "const q = require('tiny-queue'); exports.layout = (n) => q.make(n).map((x) => x * 2);",
        "extra/edges.js": "const g = require('tiny-graph'); module.exports = { twice: (n) => g.layout(n) };",
        "theme.css": ".tg{color:red}"}),
    "tiny-queue": ("1.4.2", 1200, {}, {
        "package.json": json.dumps({"name": "tiny-queue", "version": "1.4.2", "main": "q.mjs", "type": "module"}),
        "q.mjs": "export function make(n) { return Array.from({ length: n }, (_, i) => i) }"}),
    "default-only": ("0.3.0", 900, {}, {
        "package.json": json.dumps({"name": "default-only", "version": "0.3.0", "main": "d.mjs"}),
        "d.mjs": "export default function draw() { return 'drawn' }"}),
}

pytestmark = pytest.mark.skipif(view_libs.ESBUILD.is_file() is False or shutil.which("node") is None,
                                reason="needs the frontend's esbuild and Node")


def install(stage: Path, *names: str) -> None:
    """The builder's `npm install --ignore-scripts <name>` in its own folder `stage`, with what each package needs."""
    todo = list(names)
    while todo:
        name = todo.pop()
        for rel, text in PACKAGES[name][3].items():
            f = stage / "node_modules" / name / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(text)
        todo += list(PACKAGES[name][2])


@pytest.fixture()
def no_npm(monkeypatch):
    """thimble runs no npm itself: each command it runs is kept, and an npm one fails the test."""
    calls: list[list[str]] = []
    real = view_libs._run

    async def run(argv, cwd=None, timeout=view_libs.NPM_TIMEOUT_S):
        calls.append(argv)
        assert Path(argv[0]).name != "npm", argv
        return await real(argv, cwd, timeout)

    monkeypatch.setattr(view_libs, "_run", run)
    return calls


def _in_node(scripts: list[str], expr: str) -> str:
    """`expr` evaluated in Node after the scripts ran as a page's inline scripts do, with `window` the global object."""
    prog = "globalThis.window = globalThis;\n" + "\n".join(scripts) + f"\nconsole.log(JSON.stringify({expr}))"
    out = subprocess.run(["node", "-e", prog], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


async def test_a_package_the_builder_installed_is_bundled_into_the_view_and_runs_in_the_page(tmp_path, no_npm):
    stage = tmp_path / "work"
    install(stage, "tiny-graph", "default-only")
    folder = tmp_path / "graph"
    folder.mkdir()
    libs = ["tiny-graph@2", "tiny-graph@2/extra/edges.js", "tiny-graph@2/theme.css", "default-only"]
    got = await view_libs.ensure("ws", "graph", folder, libs, source=stage)
    assert got["problems"] == []
    assert len(got["notes"]) == 4 and got["notes"][0].startswith("bundled tiny-graph 2.1.0") and "`tinyGraph`" in got["notes"][0]
    assert not [c for c in no_npm if Path(c[0]).name == "npm"], "thimble installs nothing itself"

    lock = view_libs.lock(folder)
    assert list(lock) == libs and lock["tiny-graph@2/theme.css"]["kind"] == "css"
    assert lock["tiny-graph@2"]["version"] == "2.1.0"
    scripts = [view_libs.vendored(folder, e)[1] for e in libs if lock[e]["kind"] == "js"]
    result = _in_node(scripts, "[window.tinyGraph.layout(3), window.__thimbleLibs['tiny-graph/extra/edges.js'].twice(2),"
                               " window.defaultOnly(), window.__thimbleLibs['tiny-graph'] === window.tinyGraph]")
    assert result == [[0, 2, 4], [0, 2], "drawn", True], "a file entry shares its package's instance"

    bundles = len(no_npm)
    again = await view_libs.ensure("ws", "graph", folder, libs, source=stage)
    assert again == {"problems": [], "notes": []} and len(no_npm) == bundles, "a bundle kept is not made again"
    before = {p.name for p in (folder / view_libs.LIB_DIR).iterdir()}
    await view_libs.ensure("ws", "graph", folder, ["default-only"], source=stage)
    after = {p.name for p in (folder / view_libs.LIB_DIR).iterdir()}
    assert after == {view_libs.LOCK_FILE, "default-only@0.3.0.js"} and len(before) == 5, "an entry dropped leaves the folder"


async def test_a_bundle_holds_only_files_from_the_builder_s_node_modules(tmp_path, no_npm):
    """esbuild runs as thimble's server, outside the sandbox, on files the builder wrote: a package that requires a file
    outside its folder's node_modules (a token file the sandbox hides), or links out of it, is not bundled, so the file
    never reaches the view's lib, which the builder can read."""
    secret = tmp_path / "home" / "server.json"
    secret.parent.mkdir()
    secret.write_text(json.dumps({"token": "SECRET-TOKEN"}))
    folder = tmp_path / "v"
    folder.mkdir()

    def package(stage: Path, name: str, index: str) -> None:
        d = stage / "node_modules" / name
        d.mkdir(parents=True)
        (d / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0", "main": "index.js"}))
        (d / "index.js").write_text(index)

    stage = tmp_path / "work"
    package(stage, "reads-out", f"module.exports = require({json.dumps(str(secret))});")
    got = await view_libs.ensure("ws", "v", folder, ["reads-out@1"], source=stage)
    assert len(got["problems"]) == 1 and "outside" in got["problems"][0] and str(secret) in got["problems"][0]
    stage2 = tmp_path / "work2"
    package(stage2, "plain", "module.exports = require('linked/server.json');")
    (stage2 / "node_modules" / "linked").symlink_to(secret.parent)
    got = await view_libs.ensure("ws", "v", folder, ["plain@1"], source=stage2)
    assert len(got["problems"]) == 1 and "outside" in got["problems"][0]
    package(secret.parent, "evil", "module.exports = require('../../server.json');")  # beside the token file
    stage3 = tmp_path / "work3"
    stage3.mkdir()
    (stage3 / "node_modules").symlink_to(secret.parent / "node_modules")
    got = await view_libs.ensure("ws", "v", folder, ["evil@1"], source=stage3)
    assert len(got["problems"]) == 1 and "not a folder of its own" in got["problems"][0]
    lib = folder / view_libs.LIB_DIR
    assert not any("SECRET-TOKEN" in p.read_text() for p in lib.iterdir() if p.is_file())
    assert all(view_libs.vendored(folder, x) is None for x in ("reads-out@1", "plain@1", "evil@1"))
