"""Check a demo pre-cache's card citations again with this tree's citation check, and write back only what the check
keeps: each card's `verification`. A pre-cache stores the verdicts of the check that ran with its orientation, and a
later fix to the check (such as a citation in words, which names a place and shows no value, never marked red) leaves
them stale (bug hunt F6).

    <tree>/backend/.venv/bin/python scripts/dev/recheck_precache_citations.py demos/<dataset> <dataset folder> [--dry-run]

The dataset folder is the download `thimble demo` makes (~/.thimble/demo/<dataset>), whose files must be those the
manifest lists. In a scratch home of its own, with the server's own code and no server, it installs the pre-cache on a
copy of that folder (demo.install), runs the links check on every card that has a takeaway (verify._links_job), and
writes each card's new `verification` into the pre-cache's notebook, with the placeholders in place of the scratch
paths, and the manifest's size and SHA-256 of each file it changed. It changes no takeaway and no other field: a card
whose takeaway the check would rewrite is named, and left as it is. It prints each card whose verdicts changed
(VERDICTS; the check's timing and version alone change nothing). `thimble demo` then says an install of the old
pre-cache is outdated, with the command that installs this one (`thimble demo --refresh <dataset>`).
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

TREE = Path(__file__).resolve().parents[2]


def options(argv: "list[str] | None" = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("precache", type=Path, help="the pre-cache folder, demos/<dataset>")
    ap.add_argument("dataset", type=Path, help="the dataset's folder, as `thimble demo` downloads it")
    ap.add_argument("--dry-run", action="store_true", help="print what changes, and write nothing")
    return ap.parse_args(argv)


def dumps(nb: dict, raw: str) -> str:
    """The notebook as the pre-cache's file writes it: indent 1, with \\u escapes only when the file has them."""
    ascii_ = json.dumps(json.loads(raw), indent=1, ensure_ascii=True) == raw
    return json.dumps(nb, indent=1, ensure_ascii=ascii_)


VERDICTS = ("status", "resolved", "unresolved", "broken", "quiet", "typed")  # what a card's marks are drawn from


def verdicts(v: object) -> dict:
    """A verification's verdicts on the takeaway's citations, without the check's timing and version; a list the
    check of the time did not write yet counts as empty."""
    links = (v.get("links") if isinstance(v, dict) else None) or {}
    return {k: links.get(k) if k == "status" else links.get(k) or [] for k in VERDICTS}


def main(argv: "list[str] | None" = None) -> int:
    args = options(argv)
    src, data = args.precache.resolve(), args.dataset.resolve()
    scratch = Path(tempfile.mkdtemp(prefix="thimble-recheck-"))
    try:
        os.environ.update(THIMBLE_HOME=str(scratch / "home"), THIMBLE_WORKSPACES_DIR=str(scratch / "workspaces"),
                          THIMBLE_DATA_DIR=str(scratch / "data"), THIMBLE_RENDER="off", THIMBLE_CARD_CHECK="off",
                          THIMBLE_SKIP_KEY="1")
        sys.path.insert(0, str(TREE / "backend"))
        from app import config, demo, verify  # noqa: PLC0415 — after the scratch home is set

        manifest = demo.read_manifest(src)
        corpus = scratch / "corpus" / data.name
        shutil.copytree(data, corpus)
        bad = demo.corpus_mismatches(manifest, corpus)
        if bad:
            print(f"{data} is not the dataset the pre-cache was made on: {'; '.join(bad[:3])}", file=sys.stderr)
            return 1
        name = str(config.register_corpus(corpus, exact=True)["name"])
        ws = config.WORKSPACES_DIR / name
        demo.install(src, ws, corpus, home=scratch / "user")
        paths = {str(ws): "@@THIMBLE_WORKSPACE@@", str(corpus): "@@THIMBLE_CORPUS@@",
                 str(scratch / "home"): "@@THIMBLE_HOME@@", str(scratch / "user"): "@@THIMBLE_USER_HOME@@"}

        async def check() -> None:
            for p in sorted((ws / "notebooks").glob("*.json")):
                for cell in json.loads(p.read_text("utf-8")).get("cells") or []:
                    if str(cell.get("takeaway") or "").strip() and isinstance(cell.get("verification"), dict):
                        await verify._links_job(name, str(cell["id"]), verify._links_version(cell))

        asyncio.run(check())
        files = {f["path"]: f for f in manifest.get("files") or [] if isinstance(f, dict)}
        changed: list[str] = []
        for p in sorted((src / demo.WORKSPACE / "notebooks").glob("*.json")):
            raw = p.read_text("utf-8")
            nb = json.loads(raw)
            now = {c["id"]: c for c in json.loads((ws / "notebooks" / p.name).read_text("utf-8")).get("cells") or []}
            for cell in nb.get("cells") or []:
                new = now.get(cell.get("id"))
                if not new or verdicts(new.get("verification")) == verdicts(cell.get("verification")):
                    continue
                if new.get("takeaway") != cell.get("takeaway"):
                    print(f"card:{cell['id']}: the check would rewrite its takeaway; left as it is\n"
                          f"  was: {cell.get('takeaway')}\n  now: {new.get('takeaway')}")
                    continue
                text = json.dumps(new["verification"], ensure_ascii=False)
                for path, mark in sorted(paths.items(), key=lambda kv: -len(kv[0])):
                    text = text.replace(path, mark)
                if str(scratch) in text:
                    print(f"card:{cell['id']}: its verdicts name a scratch path; left as it is", file=sys.stderr)
                    continue
                old = verdicts(cell.get("verification"))
                cell["verification"] = json.loads(text)
                links = verdicts(cell["verification"])
                print(f"card:{cell['id']} ({p.relative_to(src)}): broken {len(old['broken'])} -> "
                      f"{len(links['broken'])}, linked {len(old['resolved'])} -> {len(links['resolved'])}")
                for k in VERDICTS:
                    if old[k] != links[k]:
                        print(f"  {k}: {json.dumps(old[k], ensure_ascii=False)}\n"
                              f"  {' ' * len(k)}  {json.dumps(links[k], ensure_ascii=False)}")
                changed.append(p.name)
            if p.name in changed and not args.dry_run:
                body = dumps(nb, raw)
                p.write_text(body, "utf-8")
                entry = files.get(f"notebooks/{p.name}")
                if entry is not None:
                    data_ = body.encode("utf-8")
                    entry.update(bytes=len(data_), sha256=hashlib.sha256(data_).hexdigest())
        if changed and not args.dry_run:
            mpath = src / demo.MANIFEST
            mraw = mpath.read_text("utf-8")
            mpath.write_text(dumps(manifest, mraw) + ("\n" if mraw.endswith("\n") else ""), "utf-8")
        print(f"{src.name}: {len(set(changed))} notebook(s) {'would change' if args.dry_run else 'changed'}")
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
