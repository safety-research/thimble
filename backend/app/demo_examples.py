"""`thimble demo --examples`: the worked examples of custom views (plugin/viewers) as workspaces on the server the demo
datasets open on, so a reviewer sees both on one port.

    thimble demo --examples [--refresh]

An example is a folder of plugin/viewers with a view (view.json, reader.py, view.html) and a sample/; a folder with no
view is left out. For each, the command copies the sample to $THIMBLE_HOME/examples/example-<name> (never into the
repository), registers that folder as the workspace example-<name>, installs the example's view in it as a built view
(views.install_view, as a pre-cache's views are installed), so it shows at once without its checks running, and
defines the sample labels its labels.json lists, turned on in Files and applied (regex labels: no model is called).
It ends with one URL per workspace, opened at the view, with the page key.

A second run adds only what is missing: a sample already copied, a view already installed and a label already defined
stay as they are. --refresh copies each example's sample and view again and redefines its labels, so edits in
plugin/viewers show once the page is reloaded. It works in a release install too, which ships plugin/viewers; the
examples stay examples for the dev agent, which no other command installs (views.EXAMPLES_DIR).
"""
from __future__ import annotations

import argparse
import filecmp
import json
import shutil
import urllib.parse
from pathlib import Path
from typing import Any, Callable

from . import config

FOLDER = "examples"  # under THIMBLE_HOME: the samples' copies, each the corpus folder of its workspace
PREFIX = "example-"  # of each copy's folder name, so of its workspace's name
LABELS_JSON = "labels.json"
APPLY_TIMEOUT_S = 180.0  # one sample label's apply, which the server answers once it ends
Request = Callable[..., "tuple[int, Any]"]


def examples(root: Path | None = None) -> list[Path]:
    """The example folders of `root` (plugin/viewers by default): those with a view and a sample, by name."""
    from . import views  # noqa: PLC0415 — the server's module, loaded only for this command

    root = root or views.EXAMPLES_DIR
    need = (views.VIEW_JSON, views.READER_PY, views.VIEW_HTML)
    return sorted(p for p in root.iterdir()
                  if p.is_dir() and (p / "sample").is_dir() and all((p / f).is_file() for f in need))


def sync(src: Path, dst: Path) -> bool:
    """`dst` made a copy of the folder `src`: files that differ or are missing copied, files `src` lacks removed.
    Whether anything changed."""
    changed = False
    if dst.is_dir():
        for p in sorted(dst.rglob("*"), reverse=True):  # a folder's files before the folder
            rel = p.relative_to(dst)
            if p.is_symlink() or (p.is_file() and not (src / rel).is_file()):
                p.unlink()
                changed = True
            elif p.is_dir() and not (src / rel).is_dir():
                shutil.rmtree(p)
                changed = True
    for p in sorted(src.rglob("*")):
        q = dst / p.relative_to(src)
        if p.is_dir():
            q.mkdir(parents=True, exist_ok=True)
        elif p.is_file() and not (q.is_file() and filecmp.cmp(p, q, shallow=False)):
            q.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, q)
            changed = True
    return changed


def ensure_workspace(ws: Path) -> None:
    """The workspace folder `ws` made as config.workspace_dir makes one, in the workspaces folder the server uses."""
    from . import subagent_files  # noqa: PLC0415 — standard library only

    if not ws.is_dir():
        config.private_dir(ws.parent)
        ws.mkdir(mode=0o700)
    subagent_files.ensure(ws)


def page(name: str, slug: str) -> str:
    """The workspace's page opened at its view, with the page key (cli.ui_url)."""
    from . import cli  # noqa: PLC0415

    base, sep, key = cli.ui_url(name, key=True).partition("#")
    return f"{base}&ref={urllib.parse.quote('view:' + slug, safe=':')}{sep}{key}"


def label_specs(src: Path) -> list[dict[str, Any]]:
    """The sample labels the example's labels.json lists, [] when it has none."""
    p = src / LABELS_JSON
    if not p.is_file():
        return []
    specs = json.loads(p.read_text("utf-8"))
    return [s for s in specs if isinstance(s, dict) and s.get("name")] if isinstance(specs, list) else []


def define_labels(url: str, name: str, src: Path, refresh: bool, request: Request) -> list[str]:
    """The example's sample labels defined in the workspace through the server (as the analyst defines one in Files),
    turned on and applied; one defined already is left as it is unless `refresh`, which redefines and applies it again.
    A line for each label defined, or why it was not."""
    base = f"{url}/api/ws/{urllib.parse.quote(name)}/concepts"
    status, have = request("GET", base)
    if status != 200 or not isinstance(have, list):
        return [f"the labels could not be listed: {status} {str(have)[:200]}"]
    by_name = {str(k.get("name")): k for k in have if isinstance(k, dict)}
    out = []
    for spec in label_specs(src):
        fields = {"kind": spec.get("kind") or "regex", "spec": spec.get("spec"), "labels": spec.get("labels"),
                  "shown": True}
        k = by_name.get(str(spec["name"]))
        if k is not None and not refresh:
            continue
        if k is None:
            status, k = request("POST", base, {"name": spec["name"], **fields})
        else:
            status, k = request("PUT", f"{base}/{urllib.parse.quote(str(k['id']))}", fields)
        if status not in (200, 201) or not isinstance(k, dict) or not k.get("id"):
            out.append(f"label {spec['name']!r} not defined: {status} {str(k)[:200]}")
            continue
        status, done = request("POST", f"{base}/{urllib.parse.quote(str(k['id']))}/apply",
                               {"paths": list(spec.get("paths") or ["*"]), "wait": True}, timeout=APPLY_TIMEOUT_S)
        counts = (done.get("counts") or (done.get("label_stats") or {}).get("counts")) if isinstance(done, dict) else None
        out.append(f"label {spec['name']!r} " + (f"applied: {counts}" if status in (200, 202) and counts is not None
                                                  else f"defined, not applied: {status} {str(done)[:200]}"))
    return out


def open_example(src: Path, url: str, env: dict[str, Any], refresh: bool, say: Callable[[str], None],
                 request: Request) -> tuple[str, str]:
    """The example in the folder `src` opened as a workspace (module note): (the workspace's name, its view's slug)."""
    from . import demo, views  # noqa: PLC0415

    folder = Path(env["home"]) / FOLDER / f"{PREFIX}{src.name}"
    copied = not folder.is_dir()
    if copied:
        config.private_dir(folder.parent)
        shutil.copytree(src / "sample", folder, symlinks=False)
    elif refresh:
        copied = sync(src / "sample", folder)
    name = demo.register(folder, url)
    ws = Path(env["workspaces_dir"]) / name
    ensure_workspace(ws)
    slug = src.name
    installed = demo._read_json(ws / views.LOCAL_SUBDIR / views.VIEWS_SUBDIR / slug / views.VIEW_JSON)
    installed = installed if isinstance(installed, dict) else {}
    if refresh or not installed.get("built"):
        version = views.install_view(ws, src, slug)
        what = f"view {slug} installed at {version}"
    else:
        what = f"view {slug} kept at {installed.get('version')}"
    say(f"  {name}: " + ("sample copied, " if copied else "") + what
        + (f" (the folder {folder.name} was registered as {name}, a name already taken)" if name != folder.name else ""))
    for line in define_labels(url, name, src, refresh, request):
        say(f"    {line}")
    return name, slug


def run(args: argparse.Namespace, say: Callable[[str], None],
        server: Callable[[Callable[[str], None]], tuple[str | None, dict[str, Any]]],
        request: Request | None = None, root: Path | None = None) -> int:
    from . import cli, demo  # noqa: PLC0415

    request = request or cli._request
    found = examples(root)
    if not found:
        say("thimble demo --examples: no worked examples found")
        return 1
    say(f"thimble demo --examples: {len(found)} worked examples of custom views, each opened as a workspace on its "
        f"sample" + (" (--refresh: copied again)" if args.refresh else ""))
    url, env = server(say)
    if not url:
        say("thimble demo --examples: the server is not running, so nothing was opened")
        return 1
    opened: list[tuple[str, str]] = []
    failed = 0
    for src in found:
        try:
            opened.append(open_example(src, url, env, args.refresh, say, request))
        except (demo.DemoError, OSError, ValueError) as e:
            say(f"  {PREFIX}{src.name}: not opened: {e}")
            failed += 1
    say("")
    for name, slug in opened:
        say(f"  {name} is open at {page(name, slug)}")
    if opened:
        say("Reload a page after `thimble demo --examples --refresh` to see edits to plugin/viewers.")
    return 1 if failed else 0
