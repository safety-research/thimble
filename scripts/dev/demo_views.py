"""Put reviewed views in a demo pre-cache (demos/<dataset>/) in place of its orientation's own views.

    backend/.venv/bin/python scripts/dev/demo_views.py <pre-cache folder> --from <workspace folder>
        --view <slug>[=<new slug>] [--view …] [--corpus <dataset folder>] [--suffix " (v2)"] [--dry-run]

scripts/sync_demo_views.sh runs it for each dataset. The pre-cache's views (workspace/extension/views/) are all taken
out, and each named view of the workspace folder `--from` is written in their place:

- Under its plain slug there once the review home has renamed it (`relay-board`), else under the slug named
  (`relay-board-v2`); while both are there, the one built last (source_slug).
- As thimble serves it there (views.read_built): its live folder when its files still hash to the `version` stamp of
  its last gate and the server kept that version, else the copy the server kept at that version, so a view that is
  being changed gives the files that last passed, never a half-made change. A view whose stamp names no kept version
  is refused.
- Under its new slug, with the suffix taken off its name (`Relay Board (v2)` becomes `Relay Board`). In the text of
  every file written, each old slug and old name of the views named becomes the new one, so a link from one view to
  another (`const HISTORY = 'wiki-page-history-v2'`) still finds it.
- Stamped again: `version` is the digest of the files as written (views.view_digest), so `thimble demo`'s install
  keeps that version (views.keep_installed) and the view shows at once, as it passed.

Each file is checked as the export checks the files it writes (backend/app/demo.py): of a kind a pre-cache holds
(demo_scrub.workspace_kind), with no absolute path of the workspace or the machine and not the user name
(demo_scrub.findings), with no placeholder to fill in on install (which would change its bytes after the stamp), and,
with `--corpus`, sharing no stretch of demo_verbatim.LONG characters or more with the dataset. It refuses, writing
nothing, when one fails. views/proposals.json keeps the proposals of the slugs still there, without the record of the
review home's reviewer (REVIEW_KEY), whose notes name pictures the analyst never saw and whose mark the view's head would
show as a flag. The manifest's `files`,
`counts`, `verbatim` and `views` (where each view came from) and README.md follow.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND))

from app import config, demo, demo_verbatim  # noqa: E402
from app.demo_scrub import VIEW_CODE_SUFFIXES, findings, shape_findings, workspace_kind  # noqa: E402
from app.view_libs import LIB_DIR  # noqa: E402
from app.views import VERSION_RE, VIEW_JSON, view_digest  # noqa: E402

VIEWS = "extension/views"  # in the pre-cache's workspace/
PROPOSALS = "views/proposals.json"
VERSIONS = Path("views") / ".versions"  # in the source workspace: the copies the server kept (views.VERSIONS_SUBDIR)
SKIPPED = {"cache", "__pycache__"}  # a view's check pictures and Python's bytecode, which view_digest leaves out
# the gate's record beside a view's code in a review home: not the view's, and a copy of it would change the digest
NOT_COPIED = {"gate.json"}
REVIEW_KEY = "review"  # a proposal's record of the view's reviewer (view_review), left out of a pre-cache's proposals


class Refused(Exception):
    pass


def as_built(ws: Path, slug: str) -> tuple[Path, str]:
    """The folder of view `slug` of workspace folder `ws` as thimble serves it (views.read_built): its live folder when
    its files hash to its `version` stamp and the server kept that version, else the copy kept at the stamp; and how it
    was picked. Refused when the server kept no copy at the stamp (thimble's own fallbacks, the copy set aside or the
    newest kept, are not taken: under a slug that another view had before, they can be that view)."""
    live = ws / VIEWS / slug
    if not (live / VIEW_JSON).is_file():
        raise Refused(f"{slug}: no such view in {ws}")
    stamp = str(json.loads((live / VIEW_JSON).read_text("utf-8")).get("version") or "")
    kept = ws / VERSIONS / slug / stamp
    if not VERSION_RE.match(stamp) or not (kept / VIEW_JSON).is_file():
        raise Refused(f"{slug}: its stamp ({stamp or 'none'}) names no version the server kept in {ws}; run again once "
                      "its gate has passed")
    if view_digest(live)[:12] == stamp:
        return live, f"live at {stamp}"
    return kept, f"kept at {stamp} (its live folder changed after that gate)"


def source_slug(ws: Path, src: str, dst: str) -> str:
    """The slug the reviewed view has in workspace folder `ws`: its plain slug `dst` once the review home has renamed it,
    else `src` (`…-v2`). While both are there, the one its gate passed last (`built`), the plain one on a tie: before the
    rename the plain slug is still the orientation's own view, built hours before the reviewed one."""
    def built(slug: str) -> str | None:
        p = ws / VIEWS / slug / VIEW_JSON
        return str(json.loads(p.read_text("utf-8")).get("built") or "") if p.is_file() else None

    have = {slug: b for slug in dict.fromkeys((dst, src)) if (b := built(slug)) is not None}
    return max(have, key=lambda slug: (have[slug], slug == dst)) if have else src


def view_files(folder: Path, slug: str) -> dict[str, bytes]:
    """The files of a view folder a pre-cache holds, by their path in it: view.json and the code beside it, and its
    vendored packages (LIB_DIR); the cache and bytecode are left out, as view_digest leaves them, and so is the gate's
    record (NOT_COPIED). Refused when any other file is there, since the view's digest would then differ once
    installed."""
    out: dict[str, bytes] = {}
    for p in sorted(folder.rglob("*")):
        rel = p.relative_to(folder)
        if p.is_dir() or rel.parts[0] in SKIPPED or rel.as_posix() in NOT_COPIED:
            continue
        name = rel.as_posix()
        if len(rel.parts) > 1 and rel.parts[0] != LIB_DIR:
            raise Refused(f"{slug}: {name} is in a folder a view's digest does not cover")
        if not workspace_kind(f"{VIEWS}/{slug}/{name}") or p.is_symlink():
            raise Refused(f"{slug}: {name} is not a file a pre-cache holds (view.json, {', '.join(VIEW_CODE_SUFFIXES)})")
        out[name] = p.read_bytes()
    if VIEW_JSON not in out:
        raise Refused(f"{slug}: no {VIEW_JSON}")
    return out


def renamed(text: str, slugs: dict[str, str], names: dict[str, str]) -> str:
    """`text` with each old name and old slug of the views written as the new one."""
    for old, new in sorted(names.items(), key=lambda kv: -len(kv[0])):
        if old != new:
            text = text.replace(old, new)
    for old, new in sorted(slugs.items(), key=lambda kv: -len(kv[0])):
        if old != new:
            text = re.sub(rf"(?<![\w-]){re.escape(old)}(?![\w-])", new, text)
    return text


def digest(files: dict[str, bytes]) -> str:
    with tempfile.TemporaryDirectory(prefix="thimble-demo-view-") as tmp:
        d = Path(tmp)
        for name, data in files.items():
            (d / name).parent.mkdir(parents=True, exist_ok=True)
            (d / name).write_bytes(data)
        return view_digest(d)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sync(pc: Path, src_ws: Path, pairs: list[tuple[str, str]], corpus: Path | None, suffix: str,
         dry_run: bool = False, say=print) -> dict[str, Any]:
    """Put the views `pairs` ((slug in `src_ws`, slug in the pre-cache)) in the pre-cache folder `pc` (module note);
    the manifest as written."""
    manifest = demo.read_manifest(pc)
    if manifest.get("version") != demo.VERSION:
        raise Refused(f"{pc} is a pre-cache of version {manifest.get('version')}, not {demo.VERSION} (outputs alone)")
    src_ws = src_ws.resolve()
    renames = dict(pairs)  # an old slug's text is renamed even when the source has its plain slug already
    pairs = [(source_slug(src_ws, src, dst), dst) for src, dst in pairs]
    picked = {src: as_built(src_ws, src) for src, _ in pairs}
    raw = {src: view_files(folder, src) for src, (folder, _) in picked.items()}
    old_names = {src: str(json.loads(files[VIEW_JSON]).get("name") or src) for src, files in raw.items()}
    new_names = {src: n[: -len(suffix)] if suffix and n.endswith(suffix) else n for src, n in old_names.items()}
    slugs = {**renames, **dict(pairs)}
    names = {old_names[s]: new_names[s] for s in old_names}
    if len({dst for _, dst in pairs}) != len(pairs):
        raise Refused("two views would take the same slug")
    # the paths that would be the source's, written as placeholders by the export: none may be in a view's file
    home = Path.home()
    corpus_dir = corpus or src_ws
    places = demo.placeholder_pairs(src_ws, corpus_dir, home, config.REPO_ROOT, own=src_ws.parent.parent)
    user = getpass.getuser()
    index = demo_verbatim.Corpus(corpus) if corpus else None
    written: dict[str, bytes] = {}  # path in the pre-cache's workspace -> bytes
    views_meta: list[dict[str, Any]] = []
    longest: list[dict[str, Any]] = []
    problems: list[str] = []
    for src, dst in pairs:
        files = {n: renamed(d.decode("utf-8"), slugs, names).encode("utf-8") for n, d in raw[src].items()}
        meta = json.loads(files[VIEW_JSON])
        if not meta.get("built"):
            problems.append(f"{src}: its view.json says it was never built")
        version = digest(files)[:12]
        meta["version"] = version
        files[VIEW_JSON] = (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        assert digest(files)[:12] == version  # the stamps are left out of the digest
        for name, data in files.items():
            rel = f"{VIEWS}/{dst}/{name}"
            text = data.decode("utf-8")
            if demo.with_placeholders(text, places) != text or any(ph in text for ph in demo.PLACEHOLDERS.values()):
                problems.append(f"{rel}: holds a path that install would rewrite, which would change the view's digest")
            problems += [f"{rel}: {f}" for f in findings(text, user)]
            problems += [f"{rel}: {f}" for f in shape_findings(rel, text, manifest)]
            if index is not None:
                found = demo_verbatim.scan(index, rel, text, demo_verbatim.LONG)
                if found.longest:
                    longest.append({"path": rel, "chars": found.longest, "shared": found.shared})
                if found.long_runs:
                    problems.append(f"{rel}: {found.long_runs} stretch(es) of {demo_verbatim.LONG}+ characters copied "
                                    f"from the dataset (it starts {found.sample[:60]!r})")
            written[rel] = data
        how = picked[src][1]
        views_meta.append({"slug": dst, "name": meta.get("name"), "version": version, "from": src,
                           "from_version": str(json.loads(raw[src][VIEW_JSON]).get("version") or ""),
                           "picked": how.split(" (")[0]})
        say(f"  {dst}: {meta.get('name')!r} from {src} ({how}), stamped {version}, {len(files)} files")
    ws = pc / demo.WORKSPACE
    prop_path = ws / PROPOSALS
    if prop_path.is_file():
        props = json.loads(prop_path.read_text("utf-8"))
        keep = [{k: v for k, v in p.items() if k != REVIEW_KEY} for p in props
                if isinstance(p, dict) and p.get("slug") in {dst for _, dst in pairs}]
        dropped = sorted({str(p.get("slug")) for p in props if isinstance(p, dict)} - {str(p.get("slug")) for p in keep})
        if dropped:
            say(f"  views/proposals.json: dropped the proposals of {', '.join(dropped)}")
        written[PROPOSALS] = (json.dumps(keep, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        problems += [f"{PROPOSALS}: {f}" for f in findings(written[PROPOSALS].decode("utf-8"), user)]
    if problems:
        raise Refused("nothing was written:\n  " + "\n  ".join(problems))
    gone = sorted(f["path"] for f in manifest.get("files") or []
                  if f["path"].startswith(VIEWS + "/") and f["path"] not in written)
    files = [f for f in manifest.get("files") or [] if not f["path"].startswith(VIEWS + "/") and f["path"] not in written]
    files += [{"path": p, "bytes": len(d), "sha256": sha(d)} for p, d in written.items()]
    manifest["files"] = sorted(files, key=lambda f: f["path"])
    manifest.setdefault("counts", {})["views"] = len(pairs)
    if index is not None:
        v = manifest.setdefault("verbatim", {})
        keepv = [x for x in v.get("longest") or [] if x["path"] not in written and not x["path"].startswith(VIEWS + "/")]
        v["longest"] = sorted(keepv + longest, key=lambda x: -x["chars"])[:20]
    manifest["views"] = views_meta
    text = json.dumps(manifest, ensure_ascii=False, indent=1) + "\n"
    if findings(json.dumps({k: x for k, x in manifest.items() if k != "flagged"}, ensure_ascii=False), user):
        raise Refused("nothing was written: the manifest would hold a path or the user name")
    if dry_run:
        say(f"  (dry run) would take out {len(gone)} files of the views and write {len(written)}")
        return manifest
    shutil.rmtree(ws / VIEWS, ignore_errors=True)  # every view the pre-cache held; the new ones are written next
    for p, data in written.items():
        (ws / p).parent.mkdir(parents=True, exist_ok=True)
        (ws / p).write_bytes(data)
    (pc / demo.MANIFEST).write_text(text, "utf-8")
    (pc / demo.README).write_text(demo.readme(manifest), "utf-8")
    listed = {f["path"] for f in manifest["files"]}
    stray = [p.relative_to(ws).as_posix() for p in ws.rglob("*") if p.is_file() and p.relative_to(ws).as_posix() not in listed]
    if stray:
        raise Refused(f"files the manifest does not list are left in {ws}: {stray[:5]}")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("precache", type=Path)
    ap.add_argument("--from", dest="src", type=Path, required=True, help="the workspace folder that holds the views")
    ap.add_argument("--view", action="append", required=True, metavar="SLUG[=NEW]")
    ap.add_argument("--corpus", type=Path, help="the dataset's folder, for the check against long copied stretches")
    ap.add_argument("--suffix", default=" (v2)", help="taken off the end of each view's name (default ' (v2)')")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    pairs = [(v.split("=", 1)[0], v.split("=", 1)[-1]) for v in a.view]
    try:
        sync(a.precache, a.src, pairs, a.corpus, a.suffix, a.dry_run)
    except (Refused, demo.DemoError) as e:
        print(f"demo_views: {a.precache.name}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
