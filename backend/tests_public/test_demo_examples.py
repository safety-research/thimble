"""`thimble demo --examples` (app/demo_examples.py): each worked example of custom views opens as the workspace
example-<name> on a copy of its sample in THIMBLE_HOME, its view installed built so readers see it at once, its sample
labels defined and applied through the server, and one URL, the start page with a sign-in code, opened; a second run
adds only what is missing, and --refresh copies the views and samples again. The server is stubbed."""
import argparse
import filecmp
import hashlib
import json
import re
from pathlib import Path

import pytest

from app import cli, config, demo, demo_examples, views

CODE = "c0de"


# the sign-in the command makes for its writes (cli.browser_cookie): the cookie and the browser path it is scoped to
COOKIE = "thimble-ui-1=c00kie-of-the-run; Path=/b/the-key-of-the-run-s-browser/api/"


class FakeServer:
    """The routes the command calls, over labels kept in memory, and every call it made. A write without the browser's
    cookie is refused, as hook_auth.LocalWriteGuard refuses it."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict | None]] = []
        self.labels: dict[str, dict[str, dict]] = {}
        self.signed_out: list[str] = []

    def __call__(self, method: str, url: str, body: dict | None = None, timeout: float = 5.0, cookie: str | None = None):
        if method != "GET" and cookie != COOKIE:
            return 403, {"detail": "open thimble from the link shown under /thimble's reply"}
        if url.endswith("/api/ui/signout"):
            self.signed_out.append((body or {}).get("id"))
            return 200, {"signed_out": True}
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
    monkeypatch.setattr(cli, "ui_url", lambda name, pair=False: f"http://127.0.0.1:1/{f'?ws={name}' if name else ''}"
                                                                + (f"#p={CODE}" if pair else ""))
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    return {"env": env, "server": FakeServer(), "lines": [], "shown": [], "signins": []}


def run(w, root: Path | None = None, **kw) -> int:
    a = argparse.Namespace(**{"examples": True, "refresh": False, **kw})
    return demo_examples.run(a, w["lines"].append, lambda say: ("http://127.0.0.1:1", w["env"]), request=w["server"],
                             root=root, show=lambda url: w["shown"].append(url) or True,
                             signin=lambda url: w["signins"].append(url) or COOKIE)


def said(w) -> str:
    out = " ".join(w["lines"])
    w["lines"].clear()
    return out


def same_tree(a: Path, b: Path) -> bool:
    files = lambda d: sorted(p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())  # noqa: E731
    return files(a) == files(b) and all(filecmp.cmp(a / f, b / f, shallow=False) for f in files(a))


def installed(name: str, slug: str) -> dict:
    return json.loads((views.views_dir(name) / slug / views.VIEW_JSON).read_text("utf-8"))


def test_every_worked_example_opens_as_a_workspace_with_its_view_built_and_its_labels_on(world, monkeypatch):
    """Each example of plugin/viewers: its sample copied into THIMBLE_HOME (not the repository) as the corpus of the
    workspace example-<name>, its view built so read_built serves it, each sample label defined, turned on and applied,
    and one URL printed and opened, the start page with a sign-in code on a terminal."""
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
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
    # the labels are the analyst's writes: one sign-in for the run, signed out at its end (its id, hook_auth.browser_id)
    assert w["signins"] == ["http://127.0.0.1:1"]
    value = COOKIE.split(";", 1)[0].split("=", 1)[1]
    assert w["server"].signed_out == [hashlib.sha256(value.encode()).hexdigest()[:12]]
    # one URL, opened with a one-time sign-in code: the start page, whose rows open each example at its view
    # (start_page.py); the browser spent the code, so the printed line names the page without it
    assert re.findall(r"http://\S+", out) == ["http://127.0.0.1:1/"]
    assert w["shown"] == [f"http://127.0.0.1:1/#p={CODE}"]


def test_without_a_terminal_the_start_page_s_link_carries_no_sign_in_code(world, monkeypatch):
    """Output that a program reads, such as an agent's Bash, can reach a model's context, so without a terminal the
    printed link carries no sign-in code (cli.ui_url, as `thimble demo` and /thimble print it)."""
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    w = world
    a = argparse.Namespace(examples=True, refresh=False)
    assert demo_examples.run(a, w["lines"].append, lambda say: ("http://127.0.0.1:1", w["env"]), request=w["server"],
                             show=lambda url: w["shown"].append(url) and False, signin=lambda url: COOKIE) == 0
    out = said(w)
    assert re.findall(r"http://\S+", out) == ["http://127.0.0.1:1/"] and "#p=" not in out
    assert w["shown"] == ["http://127.0.0.1:1/"]
