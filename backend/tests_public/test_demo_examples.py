"""`thimble demo --examples` (app/demo_examples.py): each worked example of custom views opens as the workspace
example-<name> on a copy of its sample in THIMBLE_HOME, its view installed built so readers see it at once, its sample
labels defined and applied through the server, and one URL, the start page with the page key, opened; a second run adds
only what is missing, and --refresh copies the views and samples again. The server is stubbed."""
import argparse
import filecmp
import json
import re
import shutil
from pathlib import Path

import pytest

from app import cli, config, demo, demo_examples, views

KEY = "pagekey"


class FakeServer:
    """The routes the command calls, over labels kept in memory, and every call it made."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict | None]] = []
        self.labels: dict[str, dict[str, dict]] = {}

    def __call__(self, method: str, url: str, body: dict | None = None, timeout: float = 5.0):
        self.calls.append((method, url, body))
        ws = url.split("/api/ws/")[1].split("/")[0]
        have = self.labels.setdefault(ws, {})
        if url.endswith("/concepts"):
            if method == "GET":
                return 200, list(have.values())
            k = {"id": f"k{len(have) + 1}", **(body or {})}
            have[k["id"]] = k
            return 200, k
        if url.endswith("/apply"):
            return 200, {"counts": {"yes": 1}}
        kid = url.rsplit("/", 1)[1]
        have[kid].update(body or {})
        return 200, have[kid]

    def writes(self) -> list[tuple[str, str]]:
        return [(m, u.split("/api/ws/")[1]) for m, u, _ in self.calls if m != "GET"]


@pytest.fixture()
def world(tmp_path, monkeypatch):
    """A THIMBLE_HOME, a data folder and the workspaces folder of the test's own, a server that answers, and
    registration as the server does it."""
    env = {"home": str(tmp_path / "home"), "workspaces_dir": str(config.WORKSPACES_DIR), "data_dir": str(tmp_path / "data")}
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(demo, "register", lambda folder, url: str(config.register_corpus(folder, exact=True)["name"]))
    monkeypatch.setattr(cli, "ui_url", lambda name, key=True: f"http://127.0.0.1:1/{f'?ws={name}' if name else ''}"
                                                              + (f"#k={KEY}" if key else ""))
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    return {"env": env, "server": FakeServer(), "lines": [], "shown": []}


def run(w, root: Path | None = None, **kw) -> int:
    a = argparse.Namespace(**{"examples": True, "refresh": False, **kw})
    return demo_examples.run(a, w["lines"].append, lambda say: ("http://127.0.0.1:1", w["env"]), request=w["server"],
                             root=root, show=lambda url: w["shown"].append(url) or True)


def said(w) -> str:
    out = " ".join(w["lines"])
    w["lines"].clear()
    return out


def same_tree(a: Path, b: Path) -> bool:
    files = lambda d: sorted(p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())  # noqa: E731
    return files(a) == files(b) and all(filecmp.cmp(a / f, b / f, shallow=False) for f in files(a))


def installed(name: str, slug: str) -> dict:
    return json.loads((views.views_dir(name) / slug / views.VIEW_JSON).read_text("utf-8"))


def test_every_worked_example_opens_as_a_workspace_with_its_view_built_and_its_labels_on(world):
    """Each example of plugin/viewers: its sample copied into THIMBLE_HOME (not the repository) as the corpus of the
    workspace example-<name>, its view built so read_built serves it, each sample label defined, turned on and applied,
    and one URL printed and opened, the start page with the page key."""
    w = world
    found = demo_examples.examples()
    assert [p.name for p in found] == sorted(p.name for p in views.EXAMPLES_DIR.iterdir() if (p / "view.json").is_file())
    assert run(w) == 0
    out = said(w)
    for src in found:
        name = f"example-{src.name}"
        folder = Path(w["env"]["home"]) / "examples" / name
        assert same_tree(src / "sample", folder), name
        assert config.read_sidecar(name)["path"] == str(folder.resolve())
        v = views.read_built(name, src.name)
        assert v is not None and v["built"] and views.passed_as_is(name, src.name), name
        assert (views.views_dir(name) / src.name / views.VIEW_HTML).read_bytes() == (src / views.VIEW_HTML).read_bytes()
        specs = json.loads((src / "labels.json").read_text("utf-8"))
        made = w["server"].labels[name]
        assert sorted(k["name"] for k in made.values()) == sorted(s["name"] for s in specs)
        assert all(k["shown"] and k["kind"] == "regex" for k in made.values())
        applied = [b for m, u, b in w["server"].calls if u.endswith("/apply") and f"/ws/{name}/" in u]
        assert sorted(json.dumps(b["paths"]) for b in applied) == sorted(json.dumps(s["paths"]) for s in specs)
    assert not (config.REPO_ROOT / "examples").exists()
    # one URL, opened: the start page with the page key, whose rows open each example at its view (start_page.py)
    assert re.findall(r"http://\S+", out) == [f"http://127.0.0.1:1/#k={KEY}"]
    assert w["shown"] == [f"http://127.0.0.1:1/#k={KEY}"]


def test_a_second_run_adds_only_what_is_missing(world):
    w = world
    assert run(w) == 0
    said(w)
    stamps = {p.name: installed(f"example-{p.name}", p.name) for p in demo_examples.examples()}
    w["server"].calls.clear()
    assert run(w) == 0
    assert "sample copied" not in said(w)
    assert w["server"].writes() == [], "no label is defined or applied again"
    assert {p.name: installed(f"example-{p.name}", p.name) for p in demo_examples.examples()} == stamps
    shutil.rmtree(views.views_dir("example-timeline") / "timeline")
    assert run(w) == 0
    assert "view timeline installed" in said(w) and views.read_built("example-timeline", "timeline") is not None


def test_refresh_copies_an_edited_example_again(world, tmp_path):
    """--refresh installs the view as plugin/viewers now holds it, makes the sample's copy match it (a file it no longer
    has is removed) and redefines its labels; without it, edits wait."""
    w = world
    root = tmp_path / "viewers"
    shutil.copytree(views.EXAMPLES_DIR / "timeline", root / "timeline")
    (root / "samples-only" / "sample").mkdir(parents=True)  # no view: not an example
    assert [p.name for p in demo_examples.examples(root)] == ["timeline"]
    assert run(w, root) == 0
    said(w)
    before = installed("example-timeline", "timeline")["version"]
    with (root / "timeline" / "view.html").open("a", encoding="utf-8") as f:
        f.write("<!-- edited -->\n")
    (root / "timeline" / "sample" / "agents.log").unlink()
    (root / "timeline" / "sample" / "extra.log").write_text("2026-05-16T05:00:00Z INFO new line\n", "utf-8")
    assert run(w, root) == 0
    assert installed("example-timeline", "timeline")["version"] == before
    w["server"].calls.clear()
    assert run(w, root, refresh=True) == 0
    out = said(w)
    after = installed("example-timeline", "timeline")["version"]
    assert after != before and "sample copied" in out and f"installed at {after}" in out
    assert (views.views_dir("example-timeline") / "timeline" / "view.html").read_text("utf-8").endswith("<!-- edited -->\n")
    assert views.read_built("example-timeline", "timeline")["version"] == after
    assert same_tree(root / "timeline" / "sample", Path(w["env"]["home"]) / "examples" / "example-timeline")
    writes = w["server"].writes()
    assert ("PUT", "example-timeline/concepts/k1") in writes and not [u for m, u in writes if u.endswith("/concepts")], \
        "the labels are redefined in place, none made again"
    assert not list((views.views_dir("example-timeline")).glob(".timeline.*")), "no folder is left beside the view"


def test_the_command_needs_the_server_and_the_cli_takes_its_flags(world):
    w = world
    a = argparse.Namespace(examples=True, refresh=False)
    assert demo_examples.run(a, w["lines"].append, lambda say: (None, w["env"]), request=w["server"]) == 1
    assert "no server answers" in said(w) and not (Path(w["env"]["home"]) / "examples").exists()
    got = cli.build_parser().parse_args(["demo", "--examples", "--refresh"])
    assert got.examples and got.refresh and got.cmd == "demo"
