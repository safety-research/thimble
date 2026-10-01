"""app.view_libs: a view's page may load any npm package. thimble asks the analyst before it installs a version it has
not installed for them, remembers the answer per package and version, bundles the package into the view's lib folder
and inlines it into the page, which then loads nothing from the network. A refused package, or installs turned off,
leaves the view a problem to fix.

npm is faked (view_libs._run answers `npm view` and `npm install` from PACKAGES); esbuild is the frontend's own, and
the bundles run in Node with a stand-in window."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app import config, view_libs, views

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


@pytest.fixture()
def npm(tmp_path, monkeypatch):
    """The faked npm, and thimble's home in the test's folder. Its `calls` lists each npm command run."""
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    calls: list[list[str]] = []
    real = view_libs._run

    async def run(argv, cwd=None, timeout=view_libs.NPM_TIMEOUT_S):
        if Path(argv[0]).name != "npm":
            return await real(argv, cwd, timeout)
        calls.append(argv)
        if argv[1] == "view":
            name = argv[2].rsplit("@", 1)[0]
            if name not in PACKAGES:
                return 1, "", f"npm error 404 '{name}' is not in this registry."
            version, size, deps, _ = PACKAGES[name]
            return 0, json.dumps({"name": name, "version": version, "dist.unpackedSize": size, "dependencies": deps}), ""
        if argv[1] == "install":
            assert "--ignore-scripts" in argv
            want = argv[-1].rsplit("@", 1)[0]
            todo = [want]
            while todo:
                name = todo.pop()
                for rel, text in PACKAGES[name][3].items():
                    f = Path(cwd) / "node_modules" / name / rel
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_text(text)
                todo += list(PACKAGES[name][2])
            return 0, "", ""
        raise AssertionError(argv)

    monkeypatch.setattr(view_libs, "_run", run)
    monkeypatch.setattr(view_libs, "_npm", lambda: "npm")
    return calls


def _in_node(scripts: list[str], expr: str) -> str:
    """`expr` evaluated in Node after the scripts ran as a page's inline scripts do, with `window` the global object."""
    prog = "globalThis.window = globalThis;\n" + "\n".join(scripts) + f"\nconsole.log(JSON.stringify({expr}))"
    out = subprocess.run(["node", "-e", prog], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


async def test_a_package_is_asked_for_once_per_version_bundled_into_the_view_and_runs_in_the_page(tmp_path, npm):
    asked: list[dict] = []

    async def yes(c, slug, fields):
        asked.append(fields)
        return True

    folder = tmp_path / "graph"
    folder.mkdir()
    libs = ["tiny-graph@2", "tiny-graph@2/extra/edges.js", "tiny-graph@2/theme.css", "default-only"]
    got = await view_libs.ensure("ws", "graph", folder, libs, ask=yes)
    assert got["problems"] == []
    assert len(got["notes"]) == 4 and "`tinyGraph`" in got["notes"][0]
    assert [a["package"] for a in asked] == ["tiny-graph", "default-only"], "one question per package version"
    assert asked[0]["version"] == "2.1.0" and asked[0]["size"] == "6 kB, with 1 package it needs"
    assert asked[0]["needs"] == "tiny-queue 1.4.2"
    assert set(view_libs.approvals()) == {"tiny-graph@2.1.0", "default-only@0.3.0"}

    lock = view_libs.lock(folder)
    assert list(lock) == libs and lock["tiny-graph@2/theme.css"]["kind"] == "css"
    scripts = [view_libs.vendored(folder, e)[1] for e in libs if lock[e]["kind"] == "js"]
    result = _in_node(scripts, "[window.tinyGraph.layout(3), window.__thimbleLibs['tiny-graph/extra/edges.js'].twice(2),"
                               " window.defaultOnly(), window.__thimbleLibs['tiny-graph'] === window.tinyGraph]")
    assert result == [[0, 2, 4], [0, 2], "drawn", True], "a file entry shares its package's instance"

    other = tmp_path / "other"
    other.mkdir()
    again = await view_libs.ensure("ws", "other", other, ["tiny-graph@2.1.0"], ask=yes)
    assert again["problems"] == [] and len(asked) == 2, "an approved version is not asked about again"
    installs = [c for c in npm if c[1] == "install"]
    assert len(installs) == 2, "the npm install of a version is kept and reused"

    before = {p.name for p in (folder / view_libs.LIB_DIR).iterdir()}
    await view_libs.ensure("ws", "graph", folder, ["default-only"], ask=yes)
    after = {p.name for p in (folder / view_libs.LIB_DIR).iterdir()}
    assert after == {view_libs.LOCK_FILE, "default-only@0.3.0.js"} and len(before) == 5, "an entry dropped leaves the folder"


async def test_a_refused_package_or_installs_turned_off_leave_a_problem_and_nothing_installed(tmp_path, npm, monkeypatch):
    async def no(c, slug, fields):
        return False

    folder = tmp_path / "v"
    folder.mkdir()
    got = await view_libs.ensure("ws", "v", folder, ["tiny-queue@1"], ask=no)
    assert got["problems"] == ["the analyst did not allow the package tiny-queue 1.4.2; draw the page without it and "
                               "take it out of libs"]
    assert view_libs.approvals() == {} and not (folder / view_libs.LIB_DIR / "tiny-queue@1.4.2.js").exists()
    assert not [c for c in npm if c[1] == "install"]

    monkeypatch.setattr(view_libs, "_installs", lambda c: "deny")
    got = await view_libs.ensure("ws", "v", folder, ["tiny-queue@1"], ask=no)
    assert "thimble's settings refuse installs" in got["problems"][0]

    got = await view_libs.ensure("ws", "v", folder, ["no-such-package@1"], ask=no)
    assert got["problems"][0].startswith("the package no-such-package@1 could not be found")
    assert view_libs.problems(["vega", "d3-force@3", "not a package!"]) == [
        "`libs` names 'not a package!', which is neither vega, vega-lite, vega-embed nor an npm package as name@version"]


async def test_the_page_inlines_its_packages_and_a_new_package_is_a_new_version(tmp_path, npm, workspaces_tmp, monkeypatch):
    data = tmp_path / "data" / "boards"
    data.mkdir(parents=True)
    (data / "manifest.json").write_text(json.dumps({"name": "boards", "description": "a board"}))
    (data / "board.jsonl").write_text('{"n": 1}\n')
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    reader = "def build_index(paths):\n    return {}\n\ndef records(index, query):\n    return []\n\ndef resolve(index, locator):\n    return None\n"
    html = "<!doctype html><html><body><div id='g'></div></body></html>"
    view = views.write_view("boards", "graph", name="Graph", description="A graph.", claims=["board.jsonl"],
                            libs=["vega-lite", "tiny-graph@2", "tiny-graph@2/theme.css"], reader=reader, html=html)
    assert view["libs"] == ["vega", "vega-lite", "tiny-graph@2", "tiny-graph@2/theme.css"]
    first = view["version"]
    folder = Path(view["dir"])

    async def yes(c, slug, fields):
        return True

    await view_libs.ensure("boards", "graph", folder, view["libs"], ask=yes)
    doc = views.frame_document(views.read_view("boards", "graph"))
    assert "the library tiny-graph@2 is not installed here" not in doc
    assert ".tg{color:red}" in doc and "window.__thimbleLibs" in doc
    assert doc.index("vega-lite") < doc.index("__thimble_lib") < doc.index("<div id='g'>")
    second = views.mark_built("boards", "graph")["version"]
    assert second != first, "the vendored packages are part of the view's version"
    kept = views.read_version("boards", "graph", second)
    assert view_libs.vendored(Path(kept["dir"]), "tiny-graph@2") is not None, "a kept version holds its packages"
