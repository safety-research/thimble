"""Pictures of a built view, with crude first-load counts, for the views-abstraction runs.

run_views.py runs this in an instance's environment (THIMBLE_HOME and the rest, VABS_TREE), with the server stopped:
the view's reader runs in this process's kernel, as the gate's pictures do. Every picture is 1440x900 in the light theme
unless named otherwise, and is written as a JPEG when its file name ends in .jpg.

    python shoot_view.py <workspace> <slug> <out folder> [--click "<control text>[>>...]" ...] [--no-detail]
    python shoot_view.py <workspace> <slug> <out folder> --capture [--snapshot <folder>=<picture.jpg> ...]

The first form (rounds 1-3), each state written to <out>/<state>.png and described in <out>/shots.json:
  overview       1440x900, no label on, opened as the Views bar opens it (the default state)
  overview-pane  1048x676, the view's pane in a 1440x900 window beside the chat (views.PANE_SIZE)
  interact       1440x900, overview then a click on the first record the page shows (record_click.js)
  click-<i>      1440x900, overview then the controls named, clicked in turn (as views.shoot_states clicks them)
  detail         1440x900, the first place a sampled line opens, as a citation opens it
--capture (round 4), each state a JPEG under <out>, described in <out>/shots.json:
  overview       first-load.jpg: the view as it first loads, no label on
  hook-color     hooks/color-by.jpg: overview, then Color by's menu opened (hook_click.js '@hook:color')
  hook-filter    hooks/filter-by.jpg: overview, then Filter by's menu opened
  hook-rows      hooks/rows.jpg: overview, then Rows' menu opened
  hook-range     hooks/time-range.jpg: overview, then the time range narrowed to its middle
  record         hooks/record.jpg: overview, then a click on the first record the page shows ('@record'), which opens
                 it in the side panel when the view has one (first_load's side_open says)
  A hook the page does not have is not pictured (`found` false). --snapshot pictures another copy of the view's files
  as it first loads: the folder is copied into the workspace's views under a slug of its own (vabs-snap-<i>), shot
  with its live files (views.live_reads, as the gate reads a draft) and removed again.
A click that leaves the page as it first loaded (it can land while the page still settles) is tried once more
(`retried`, `unchanged_after_click`). The shot script is the tree's scripts/view_shot.mjs with first_load.js appended,
record_click.js and hook_click.js pasted into its findControl, and its relative paths made absolute (metrics_script)."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TREE = Path(os.environ.get("VABS_TREE") or HERE.parent).resolve()
sys.path.insert(0, str(TREE / "backend"))

FULL = (1440, 900)
CLEAR_ACT = "for (const el of document.querySelectorAll('[data-thimble-act]')) el.removeAttribute('data-thimble-act')"
RESULT_AT = "label_controls: labelControls,"
CAPTURE = (("overview", "first-load.jpg", None), ("hook-color", "hooks/color-by.jpg", "@hook:color"),
           ("hook-filter", "hooks/filter-by.jpg", "@hook:filter"), ("hook-rows", "hooks/rows.jpg", "@hook:rows"),
           ("hook-range", "hooks/time-range.jpg", "@hook:range"), ("record", "hooks/record.jpg", "@record"))
KEY = ("controls", "text_nodes", "words")
SKIP = shutil.ignore_patterns("__pycache__", "cache", "*.lock")


def metrics_script(tree: Path, out: Path) -> tuple[Path, list[str]]:
    """Write the shot script with the first-load counts and the '@record' and '@hook:' actions to `out`; returns it and
    the notes on what could not be added (the tree's script changed shape)."""
    src = (tree / "scripts" / "view_shot.mjs").read_text("utf-8")
    front = (tree / "frontend").as_uri()
    src = re.sub(r"new URL\((['`])\.\./frontend/", lambda m: f"new URL({m.group(1)}{front}/", src)
    notes = []
    if CLEAR_ACT in src:
        src = src.replace(CLEAR_ACT, CLEAR_ACT + "\n" + (HERE / "record_click.js").read_text("utf-8") + "\n"
                          + (HERE / "hook_click.js").read_text("utf-8"), 1)
    else:
        notes.append("findControl changed: the '@record' and '@hook:' actions are unavailable")
    if RESULT_AT in src:
        src = src.replace(RESULT_AT, RESULT_AT + "\n      first_load: await frame.evaluate(firstLoad, { sel: CONTROLS })"
                          ".catch((e) => ({ error: String(e) })),\n      clicked: await frame.evaluate(() => "
                          "window.__vabsClicked || null).catch(() => null),", 1)
    else:
        notes.append("the state's result changed: no first_load counts")
    src += "\n" + (HERE / "first_load.js").read_text("utf-8")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(src, "utf-8")
    return out, notes


def counts(r: dict) -> list:
    fl = r.get("first_load") or {}
    return [fl.get(k) for k in KEY]


async def shoot_with_retry(views, c: str, slug: str, states: list[dict]) -> list[dict]:
    """views.shoot_states, then once more for each state whose action was found but left the page as it first loaded
    (the first state is the overview the others are compared with)."""
    got = await views.shoot_states(c, slug, states)
    first = counts(got[0])
    again = [i for i, r in enumerate(got) if states[i].get("actions") and r.get("ok") and counts(r) == first
             and any(x.get("found") for x in r.get("actions") or [])]
    if again:
        redo = await views.shoot_states(c, slug, [states[i] for i in again])
        for i, r in zip(again, redo):
            r["retried"] = True
            got[i] = r
    return got


def row(name: str, st: dict, r: dict, first: list) -> dict:
    fl = r.get("first_load") or {}
    acts = r.get("actions") or []
    return {"state": name, "png": str(st["out"]), "size": list(st["size"]), "ok": r.get("ok"),
            "errors": r.get("errors"), "actions": acts, "found": all(a.get("found") for a in acts) if acts else None,
            "clicked": r.get("clicked"), "retried": bool(r.get("retried")),
            "unchanged_after_click": bool(st.get("actions")) and counts(r) == first,
            "open": st["open"], "controls_listed": r.get("controls"), "layout": r.get("layout"),
            "shown": r.get("shown"), "first_load": fl}


def say(n: str, r: dict) -> None:
    fl = r.get("first_load") or {}
    print(f"{n:13} ok={r.get('ok')} controls={fl.get('controls')} text_nodes={fl.get('text_nodes')} "
          f"words={fl.get('words')} prose={fl.get('prose_blocks')} hues={fl.get('hues')} "
          f"svg_marks={fl.get('svg_marks')} anchored={fl.get('anchored_in_view')} menu={fl.get('menu_open')} "
          f"side={fl.get('side_open')} clicked={r.get('clicked')} errors={(r.get('errors') or [])[:2]}", flush=True)


async def legacy(views, a: argparse.Namespace, out: Path, overview: dict, files) -> list[dict]:
    states, names = [], []

    def add(name: str, **kw) -> None:
        names.append(name)
        states.append({"out": out / f"{name}.png", "open": overview, "labels": views.NO_LABELS, "size": FULL, **kw})

    add("overview")
    add("overview-pane", size=views.PANE_SIZE)
    add("interact", actions=["@record"])
    for i, ctl in enumerate(a.click or []):
        add(f"click-{i + 1}", actions=[s.strip() for s in ctl.split(">>")])
    if not a.no_detail:
        locs = views._kept_locators(a.c, a.slug) or ([f"{files[0][0]}#L1"] if files else [])
        place = await views.first_place(a.c, a.slug, [{"ok": True, "locator": x} for x in locs]) if locs else None
        add("detail", open=place or overview)
    got = await shoot_with_retry(views, a.c, a.slug, states)
    first = counts(got[0])
    rows = []
    for n, st, r in zip(names, states, got):
        rows.append(row(n, st, r, first))
        say(n, r)
    return rows


async def capture(views, a: argparse.Namespace, out: Path, overview: dict) -> list[dict]:
    states = [{"out": out / f, "open": overview, "labels": views.NO_LABELS, "size": FULL,
               **({"actions": [act]} if act else {})} for _n, f, act in CAPTURE]
    for st in states:
        Path(st["out"]).parent.mkdir(parents=True, exist_ok=True)
    got = await shoot_with_retry(views, a.c, a.slug, states)
    first = counts(got[0])
    rows = []
    for (n, _f, act), st, r in zip(CAPTURE, states, got):
        x = row(n, st, r, first)
        if act and not x["found"]:
            Path(st["out"]).unlink(missing_ok=True)  # the page has no such hook: the picture would be the overview
            x["png"] = None
        rows.append(x)
        say(n, r)
    return rows


async def snapshots(views, a: argparse.Namespace) -> list[dict]:
    """Each --snapshot folder pictured as it first loads, under a slug of its own, with its live files."""
    from app import config  # noqa: PLC0415

    base = views.views_dir(a.c)
    rows = []
    for i, spec in enumerate(a.snapshot or []):
        src, _, pic = spec.partition("=")
        src_p, pic_p = Path(src), Path(pic)
        slug = f"vabs-snap-{i + 1}"
        d = base / slug
        shutil.rmtree(d, ignore_errors=True)
        rec = {"folder": src, "picture": pic, "slug": slug}
        try:
            if not (src_p / "view.json").is_file():
                rec.update(ok=False, errors=["no view.json in the snapshot"])
                rows.append(rec)
                continue
            shutil.copytree(src_p, d, ignore=SKIP)
            with views.live_reads():
                view = views.read_view(a.c, slug)
                if view is None:
                    rec.update(ok=False, errors=["the snapshot does not read as a view"])
                    rows.append(rec)
                    continue
                files = await asyncio.to_thread(views.claimed_files, a.c, view)
                place = {"ref": None, "path": files[0][0]} if files else {"ref": None}
                pic_p.parent.mkdir(parents=True, exist_ok=True)
                r = (await views.shoot_states(a.c, slug, [{"out": pic_p, "open": place, "labels": views.NO_LABELS,
                                                            "size": FULL}]))[0]
            rec.update(ok=r.get("ok"), errors=r.get("errors"), first_load=r.get("first_load"))
            say(slug, r)
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(config.workspace_dir(a.c) / "view-indexes" / slug, ignore_errors=True)
        rows.append(rec)
    return rows


async def main(a: argparse.Namespace) -> int:
    from app import views  # noqa: PLC0415  (after the environment names the instance)

    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    script, notes = metrics_script(TREE, out / ".view_shot_metrics.mjs")
    views.SHOT_SCRIPT = script
    result: dict = {"notes": notes}
    try:
        view = views.read_view(a.c, a.slug)
        if view is None:
            print(f"no view {a.slug!r} in {a.c}", file=sys.stderr)
            result["error"] = f"no view {a.slug!r}"
        else:
            files = await asyncio.to_thread(views.claimed_files, a.c, view)
            overview = {"ref": None, "path": files[0][0]} if files else {"ref": None}
            result["states"] = await (capture(views, a, out, overview) if a.capture
                                      else legacy(views, a, out, overview, files))
        if a.snapshot:
            result["snapshots"] = await snapshots(views, a)
    finally:
        script.unlink(missing_ok=True)
    (out / "shots.json").write_text(json.dumps(result, indent=1, default=str), "utf-8")
    return 0 if result.get("states") else 1


ap = argparse.ArgumentParser()
ap.add_argument("c")
ap.add_argument("slug")
ap.add_argument("out")
ap.add_argument("--click", action="append", help="control texts to click in turn, separated by >>")
ap.add_argument("--no-detail", action="store_true")
ap.add_argument("--capture", action="store_true", help="round 4: the first load, each top-row hook and a record")
ap.add_argument("--snapshot", action="append", help="<folder>=<picture.jpg>: another copy of the view, as it first loads")
sys.exit(asyncio.run(main(ap.parse_args())))
