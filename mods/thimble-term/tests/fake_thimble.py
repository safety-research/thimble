#!/usr/bin/env python3
"""A stand-in for `thimble state` and `thimble act`, for thimble-term's live check until the backend lane's commands
merge (THIMBLE_TERM_CLI names it). It reads a workspace folder (THIMBLE_WS) and a corpus folder (--cwd) with the
standard library alone and prints the shapes thimble-term reads (README.md, "What it reads and changes"). It writes
only into the workspace: a thread it starts, a thread's seen count, and every act in fake-acts.jsonl.

    fake_thimble.py state <surface> --cwd <dir> [args]
    fake_thimble.py act <kind> --cwd <dir> <json>
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import time
from pathlib import Path

WS = Path(os.environ.get("THIMBLE_WS", "."))


def out(v: object, code: int = 0) -> None:
    print(json.dumps(v))
    sys.exit(code)


def read_json(p: Path, default: object = None) -> object:
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def jsonl(p: Path) -> list[dict]:
    rows: list[dict] = []
    try:
        for line in p.read_text("utf-8").splitlines():
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if isinstance(v, dict):
                rows.append(v)
    except OSError:
        pass
    return rows


def notebooks() -> list[dict]:
    d = WS / "notebooks"
    return [nb for p in sorted(d.glob("*.json")) if isinstance(nb := read_json(p), dict)] if d.is_dir() else []


def cells() -> list[dict]:
    return [{**c, "notebook": nb.get("id") or c.get("notebook")} for nb in notebooks() for c in nb.get("cells") or [] if isinstance(c, dict)]


def find_cell(cid: str) -> dict | None:
    return next((c for c in cells() if c.get("id") == cid), None)


def concepts() -> list[dict]:
    d = WS / "concepts"
    return [c for p in sorted(d.glob("*.json")) if isinstance(c := read_json(p), dict)] if d.is_dir() else []


def corpus_line(cwd: Path, path: str, n: int) -> str | None:
    try:
        with open(cwd / path, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh, 1):
                if i == n:
                    return line.rstrip("\n")
    except OSError:
        return None
    return None


def record_text(line: str) -> str:
    try:
        v = json.loads(line)
    except ValueError:
        return line
    if isinstance(v, dict):
        for k in ("text", "body", "content", "message", "title"):
            if isinstance(v.get(k), str):
                return v[k]
    return line


def label_rows(concept: dict, cwd: Path) -> list[dict]:
    rows = []
    for r in jsonl(WS / "labels" / f"{concept['id']}.jsonl")[:2000]:
        ref = str(r.get("ref") or "")
        m = re.match(r"^(.+)#L(\d+)$", ref)
        text = record_text(corpus_line(cwd, m[1], int(m[2])) or "") if m else ""
        rows.append({"ref": ref, "label": r.get("label"), "rationale": r.get("rationale") or "", "analyst": r.get("analyst"), "confidence": r.get("confidence"), "text": text[:400]})
    picked: list[dict] = []
    for value in concept.get("labels") or []:
        picked.extend([r for r in rows if r["label"] == value][:3])
    return picked


def table_cell(c: dict, col: str, row: str) -> str | None:
    for b in c.get("outputs") or []:
        f = b.get("application/vnd.thimble.frame+json") if isinstance(b, dict) else None
        if isinstance(f, dict) and col in (f.get("columns") or []):
            cols = f["columns"]
            lab = f.get("label") if f.get("label") in cols else cols[0]
            for r in f.get("rows") or []:
                if str(r[cols.index(lab)]) == row:
                    return str(r[cols.index(col)])
        h = b.get("text/html") if isinstance(b, dict) else None
        if isinstance(h, str):
            trs = [[html.unescape(re.sub(r"<[^>]+>", "", x)).strip() for _, x in re.findall(r"<(t[dh])[^>]*>(.*?)</\1>", tr, re.S)] for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S)]
            if len(trs) > 1 and trs[0] and trs[0][0] == "" and all(x == "" for x in trs[1][1:]):
                trs = [[trs[1][0], *trs[0][1:]], *trs[2:]]
            if trs and col in trs[0]:
                j = trs[0].index(col)
                for r in trs[1:]:
                    if r and r[0] == row and j < len(r):
                        return r[j]
    return None


def resolve(ref: str, cwd: Path) -> dict:
    m = re.match(r"^(?:card|cell):([A-Za-z0-9_-]+)(?:#([^/]+)/(.+))?$", ref)
    if m:
        c = find_cell(m[1])
        if c is None:
            return {"error": f"no card {m[1]!r}", "status": 404}
        meta: dict = {"title": c.get("title") or ""}
        excerpt = c.get("title") or ""
        if m[2]:
            v = table_cell(c, m[2].replace("%5F", "_"), m[3].replace("%5F", "_"))
            if v is None:
                meta["span_missing"] = True
            else:
                meta["span"] = {"col": m[2], "row": m[3], "value": v}
                excerpt = f"{m[2]} × {m[3]} = {v}"
        return {"ref": ref, "kind": "cell", "cell_id": m[1], "excerpt": excerpt, "meta": meta}
    m = re.match(r"^(.+?)#L(\d+)(?:-L(\d+))?$", ref)
    if m:
        path, a, b = m[1], int(m[2]), int(m[3] or m[2])
        first = corpus_line(cwd, path, a)
        if first is None:
            return {"error": f"line {a} out of range or no such file: {path}", "status": 404}
        recs = [{"line": n, "blocks": [{"text": record_text(corpus_line(cwd, path, n) or "")}]} for n in range(a, b + 1)]
        ctx = {"before": [{"line": n, "blocks": [{"text": record_text(t)}]} for n in range(max(1, a - 2), a) if (t := corpus_line(cwd, path, n)) is not None],
               "after": [{"line": n, "blocks": [{"text": record_text(t)}]} for n in range(b + 1, b + 3) if (t := corpus_line(cwd, path, n)) is not None]}
        res = {"ref": ref, "kind": "record" if a == b else "range", "path": path, "line": a, "blocks": recs[0]["blocks"], "excerpt": "\n".join(r["blocks"][0]["text"] for r in recs), "context": ctx}
        if a != b:
            res["records"] = recs
        return res
    p = cwd / ref.split("#", 1)[0]
    if p.is_file():
        return {"ref": ref, "kind": "path", "path": ref, "excerpt": p.read_text("utf-8", errors="replace")[:2000]}
    return {"error": f"no such place: {ref}", "status": 404}


def chat_meta(p: Path) -> dict | None:
    m = read_json(p)
    if not isinstance(m, dict):
        return None
    events = jsonl(p.with_name(p.name.replace(".meta.json", ".jsonl")))
    m["n_messages"] = len(events)
    m["answers"] = sum(1 for e in events if e.get("type") == "done")
    m.setdefault("seen", 0)
    m.setdefault("running", m.get("status") == "running")
    return m


def investigation() -> Path | None:
    d = WS / "investigations"
    dirs = sorted(x for x in d.iterdir() if x.is_dir()) if d.is_dir() else []
    return dirs[0] if dirs else None


def state(surface: str, cwd: Path, args: list[str]) -> None:
    if surface == "home":
        inv = investigation()
        docs = sum(1 for p in inv.glob("*.json") if isinstance(d := read_json(p), dict) and "sections" in d) if inv else 0
        threads = [m for p in (WS / "chats").glob("*.meta.json") if (m := chat_meta(p)) and m.get("kind") == "thread"]
        out({"cards": len(cells()), "labels": len(concepts()), "docs": docs, "threads": len(threads), "views": 0, "files": len([p for p in cwd.rglob("*") if p.is_file()])})
    if surface == "cards":
        since = args[args.index("--since") + 1] if "--since" in args else ""
        groups = [{k: nb.get(k) for k in ("id", "title", "role", "ts", "parent", "anchor", "chat")} for nb in notebooks()]
        out({"groups": groups, "cells": [c for c in cells() if str(c.get("ts") or "") >= since]})
    if surface == "card":
        c = find_cell(args[0]) if args else None
        out(c if c else {"error": f"no card {args[:1]}"}, 0 if c else 1)
    if surface == "labels":
        out(concepts())
    if surface == "label":
        c = next((k for k in concepts() if k.get("id") == (args[0] if args else "")), None)
        out({**c, "rows": label_rows(c, cwd)} if c else {"error": "no such label"}, 0 if c else 1)
    if surface == "docs":
        inv = investigation()
        docs = {}
        for p in sorted(inv.glob("*.json")) if inv else []:
            d = read_json(p)
            if isinstance(d, dict) and "sections" in d:
                docs[p.stem] = {"exists": True, "title": d.get("title"), "renderer": d.get("renderer") or "document", "name": p.stem}
        out(docs)
    if surface == "doc":
        inv = investigation()
        d = read_json(inv / f"{args[0]}.json") if inv and args else None
        out(d if isinstance(d, dict) else {"error": "no such document"}, 0 if isinstance(d, dict) else 1)
    if surface == "threads":
        out(sorted([m for p in (WS / "chats").glob("*.meta.json") if (m := chat_meta(p))], key=lambda m: str(m.get("created_at") or "")))
    if surface == "thread":
        cid = args[0] if args else ""
        after = int(args[args.index("--after") + 1]) if "--after" in args else 0
        meta = chat_meta(WS / "chats" / f"{cid}.meta.json")
        if meta is None:
            out({"error": f"no chat {cid}"}, 1)
        events = jsonl(WS / "chats" / f"{cid}.jsonl")
        out({"meta": meta, "events": events[after:], "after": after, "total": len(events)})
    if surface == "agents":
        out(read_json(WS / "fake-agents.json", {"rows": []}))
    if surface == "files":
        rest = [a for a in args if not a.startswith("--")]
        if not rest:
            files = sorted(p for p in cwd.rglob("*") if p.is_file() and not any(x.startswith(".") for x in p.relative_to(cwd).parts))
            out([{"path": str(p.relative_to(cwd)), "kind": "records" if p.suffix == ".jsonl" else p.suffix.lstrip(".") or "text", "size_bytes": p.stat().st_size} for p in files])
        path = rest[0]
        start = int(args[args.index("--start") + 1]) if "--start" in args else 1
        try:
            lines = (cwd / path).read_text("utf-8", errors="replace").splitlines()
        except OSError:
            out({"error": f"no such file: {path}"}, 1)
        out({"path": path, "kind": "markdown" if path.endswith(".md") else "records", "total_lines": len(lines), "start": start,
             "records": [{"line": i, "blocks": [{"text": lines[i - 1]}]} for i in range(start, min(len(lines), start + 199) + 1)]})
    if surface == "resolve":
        refs = json.loads(args[0]) if args else []
        out({r: resolve(r, cwd) for r in refs})
    if surface == "ui":
        after = int(args[args.index("--after") + 1]) if "--after" in args else 0
        out([r for r in jsonl(WS / "ui.jsonl") if int(r.get("n") or 0) > after])
    out({"error": f"no surface {surface}"}, 1)


def act(kind: str, cwd: Path, payload: dict) -> None:
    with open(WS / "fake-acts.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"kind": kind, "payload": payload, "at": time.time()}) + "\n")
    chats = WS / "chats"
    if kind == "thread":
        tid = f"t{int(time.time() * 1000) % 10**8:08d}"
        chats.mkdir(exist_ok=True)
        (chats / f"{tid}.meta.json").write_text(json.dumps({"id": tid, "kind": "thread", "role": "thread", "title": payload.get("message", "")[:60], "anchor": payload.get("anchor"), "anchor_text": payload.get("anchor_text"), "parent": "main", "created_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()), "status": "running"}))
        (chats / f"{tid}.jsonl").write_text(json.dumps({"type": "user", "text": payload.get("message", "")}) + "\n")
        out({"ok": True, "thread": tid})
    if kind == "thread-message":
        with open(chats / f"{payload['thread']}.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "user", "text": payload.get("message", "")}) + "\n")
        out({"ok": True})
    if kind == "seen":
        p = chats / f"{payload['thread']}.meta.json"
        m = chat_meta(p)
        if m:
            raw = read_json(p, {})
            raw["seen"] = m["answers"]
            p.write_text(json.dumps(raw))
        out({"ok": True})
    out({"ok": True})


def main(argv: list[str]) -> None:
    if len(argv) < 4 or argv[2] != "--cwd":
        out({"error": "usage: fake_thimble.py state|act <what> --cwd <dir> [args]"}, 2)
    verb, what, cwd, rest = argv[0], argv[1], Path(argv[3]), argv[4:]
    if verb == "state":
        state(what, cwd, rest)
    if verb == "act":
        act(what, cwd, json.loads(rest[0]) if rest else {})
    out({"error": f"no verb {verb}"}, 2)


if __name__ == "__main__":
    main(sys.argv[1:])
