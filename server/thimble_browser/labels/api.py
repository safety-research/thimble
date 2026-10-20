"""The routes the page's label components call (thimble 0.8's, frontend lib/api.ts labelApi, scaleApi and the filters):
the labels and their runs, their rows on a file or on records, where they fall on a file, the analyst's values, the
label editor's draft, and the filters of Files, the canvas and the report."""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from fastapi import Body, HTTPException
from fastapi.responses import JSONResponse

from .. import canvas, corpus, llm, prompts
from . import chat, run, store, units as units_mod

ROWS_LIMIT = 200
ROWS_MAX = 2_000
RULER_BINS = 400
GLOB_LISTED = 200
COVERAGE_PAGE = 200
LINE_SPANS_MAX = 200
REFS_MAX = 2_000
TEXT_CHARS = 600


def summary(ws: str, k: dict[str, Any]) -> dict[str, Any]:
    """A label as the page lists it: its definition, counts and run."""
    out = detail(ws, k)
    out.pop("applications", None)
    out["last_run"] = k["applications"][-1] if k["applications"] else None
    return out


def detail(ws: str, k: dict[str, Any]) -> dict[str, Any]:
    cal = k.get("calibration") or {}
    return {**{x: v for x, v in k.items() if x != "label_stats"}, **store.stats(ws, k["id"]),
            "est_precision": cal["agreed"] / cal["n"] if cal.get("n") else None,
            "last_run": k["applications"][-1] if k["applications"] else None,
            "run": {x: v for x, v in (run.record(ws, k["id"]) or {}).items() if x != "usage"} or None}


def parse_spans(lines: str | None) -> list[tuple[int, int]] | None:
    if lines is None or not lines.strip():
        return None
    out = []
    parts = lines.split(",")
    if len(parts) > LINE_SPANS_MAX:
        raise HTTPException(400, f"lines names {len(parts)} ranges; at most {LINE_SPANS_MAX} fit in one request")
    for part in parts:
        m = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", part)
        if not m or int(m[1]) < 1 or int(m[2]) < int(m[1]):
            raise HTTPException(400, "lines are ranges a-b of line numbers from 1, comma-separated, such as 1-500")
        out.append((int(m[1]), int(m[2])))
    return out


def unit_text(ws: str, folder: Any, ref: str) -> str:
    """A unit's words, for the rows the label card's drawer lists."""
    try:
        if ref.startswith(("card:", "cell:")):
            return units_mod.cell_text(canvas.find(ws, ref)[1])[:TEXT_CHARS]
        if ref.startswith("report:"):
            sid = ref.split("#", 1)[-1]
            return next((u.text for u in units_mod.span_units(ws) if u.ref.endswith(f"#{sid}")), "")[:TEXT_CHARS]
        got = corpus.resolve(folder, ref)
        text = str(got.get("excerpt") or "")
        return text[:TEXT_CHARS] + ("…" if len(text) > TEXT_CHARS else "")
    except Exception:  # noqa: BLE001 — a unit that no longer resolves shows no words
        return ""


def register_routes(ctx: Any) -> None:
    app, ws_of, folder_of = ctx.app, ctx.ws_of, ctx.folder_of

    def concept_of(c: str, cid: str) -> dict[str, Any]:
        k = store.read(ws_of(c), cid)
        if k is None:
            raise HTTPException(404, f"no label {cid!r}")
        return k

    def bad(e: Exception) -> HTTPException:
        if isinstance(e, store.LabelError):
            return HTTPException(400, str(e))
        return ctx.bad(e)

    # ---- the labels

    @app.get("/api/ws/{c}/concepts")
    def concepts_list(c: str) -> list[dict[str, Any]]:
        ws = ws_of(c)
        return [summary(ws, k) for k in store.listing(ws)]

    @app.post("/api/ws/{c}/concepts")
    def concept_create(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ws_of(c)
        try:
            k = store.new_concept(str(body.get("name") or ""), description=str(body.get("description") or ""),
                                  kind=str(body.get("kind") or "prompt"), spec=str(body.get("spec") or ""),
                                  unit=str(body.get("unit") or "record"), labels=body.get("labels"),
                                  created_by=str(body.get("created_by") or "user"), marks=body.get("marks"),
                                  glob=body.get("glob") or "", model=str(body.get("model") or ""),
                                  classes=body.get("classes"), shown=bool(body.get("shown")))
        except store.LabelError as e:
            raise HTTPException(400, str(e)) from None
        if store.find(ws, k["name"]) is not None:
            raise HTTPException(409, f"a label named {k['name']} exists already")
        store.write(ws, store.colored(ws, k))
        store.notify(ws, k["id"], "defined")
        return detail(ws, k)

    @app.post("/api/ws/{c}/concepts/draft")
    async def concept_draft(c: str, body: dict = Body(...)) -> dict[str, Any]:
        text = " ".join(str(body.get("text") or "").split())
        if not text:
            raise HTTPException(400, "describe the label")
        paths = [str(p) for p in body.get("paths") or [] if str(p).strip()]
        return await draft(ws_of(c), folder_of(c), text, paths)

    @app.get("/api/ws/{c}/concepts/{cid}")
    def concept_get(c: str, cid: str) -> dict[str, Any]:
        ws = ws_of(c)
        return detail(ws, store.colored(ws, concept_of(c, cid)))

    @app.put("/api/ws/{c}/concepts/{cid}")
    def concept_put(c: str, cid: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ws_of(c)
        k = concept_of(c, cid)
        before = {x: k[x] for x in store.DEFINITION}
        name_before = k["name"]
        try:
            if str(body.get("name") or "").strip():
                name = " ".join(str(body["name"]).split())
                other = store.find(ws, name)
                if other is not None and other["id"] != cid:
                    raise store.LabelError(f"a label named {name} exists already")
                k["name"] = name
            if body.get("description") is not None:
                k["description"] = str(body["description"])
            if body.get("kind") is not None:
                if body["kind"] not in store.KINDS:
                    raise store.LabelError(f"kind is one of {', '.join(store.KINDS)}")
                k["kind"] = body["kind"]
            if body.get("unit") is not None:
                if body["unit"] not in store.UNITS:
                    raise store.LabelError(f"unit is one of {', '.join(store.UNITS)}")
                k["unit"] = body["unit"]
            if body.get("marks") is not None:
                if body["marks"] not in store.MARKS:
                    raise store.LabelError(f"marks is one of {', '.join(store.MARKS)}")
                if k["unit"] not in store.FILE_UNITS:
                    raise store.LabelError("marks is for labels over files")
                if body["marks"] != "file" or k["unit"] == "record":
                    k["unit"] = store.MARKS_UNIT[body["marks"]]
            k["marks"] = store.marks_of(k["unit"], body.get("marks") if body.get("marks") is not None else k["marks"])
            if body.get("spec") is not None:
                k["spec"] = str(body["spec"])
            if body.get("labels") is not None:
                k["labels"] = store.values_list(body["labels"])
            classes = [c for c in body.get("classes") or [] if isinstance(c, dict) and str(c.get("name") or "").strip()]
            if classes:
                k["labels"] = store.values_list([c["name"] for c in classes])
                k["classes"] = store.classes_of(k["labels"], classes)
            else:
                k["classes"] = store.classes_of(k["labels"], k["classes"])
            if body.get("glob") is not None:
                k["glob"] = ", ".join(store.globs(body["glob"])) if k["unit"] in store.FILE_UNITS else ""
            if body.get("model") is not None:
                k["model"] = str(body["model"]).strip()
            if body.get("shown") is not None:
                k["shown"] = bool(body["shown"])
        except store.LabelError as e:
            raise HTTPException(400, str(e)) from None
        changed = {x: k[x] for x in store.DEFINITION} != before
        if changed:
            k["version"] += 1
            store.note_change(k, "redefined", "redefined")
        store.write(ws, store.colored(ws, k))
        if body.get("shown") is False:
            f = store.read_filters(ws).get("files")
            if f and f.get("concept") == cid:
                store.clear_filter(ws, "files")
        store.notify(ws, cid, "changed", rows=changed or k["name"] != name_before)
        return detail(ws, k)

    @app.delete("/api/ws/{c}/concepts/{cid}")
    async def concept_delete(c: str, cid: str) -> dict[str, Any]:
        concept_of(c, cid)
        await chat.delete(ws_of(c), cid)
        return {"ok": True}

    # ---- runs

    @app.post("/api/ws/{c}/concepts/{cid}/apply", status_code=202)
    async def concept_apply(c: str, cid: str, body: dict = Body(default={})) -> Any:
        ws = ws_of(c)
        k = concept_of(c, cid)
        paths = store.globs(body.get("paths")) or (store.globs(k["glob"]) if k["unit"] in store.FILE_UNITS else [])
        if k["unit"] in store.FILE_UNITS and not paths:
            raise HTTPException(400, "the label applies to no files: give it a glob, such as runs/*.jsonl or * for every file")
        try:
            rec = await run.start(ws, folder_of(c), k, paths=paths, limit=body.get("limit") or None,
                                  created_by=str(body.get("created_by") or "user"))
        except store.LabelError as e:
            raise HTTPException(409 if "running" in str(e) else 400, str(e)) from None
        if not store.label_cards(ws, cid):
            await asyncio.to_thread(store.label_card, ws, k, group=None, by="analyst")
        if body.get("wait"):
            rec = await run.wait(ws, cid, chat.APPLY_WAIT_S) or rec
            return JSONResponse(rec, status_code=202 if rec.get("status") == "running" else 200)
        return rec

    @app.get("/api/ws/{c}/concepts/{cid}/apply/runs")
    def concept_runs(c: str, cid: str) -> list[dict[str, Any]]:
        concept_of(c, cid)
        r = run.record(ws_of(c), cid)
        return [r] if r else []

    @app.post("/api/ws/{c}/concepts/{cid}/apply/cancel")
    async def concept_cancel(c: str, cid: str) -> dict[str, Any]:
        concept_of(c, cid)
        stopped = await run.cancel(ws_of(c), cid)
        return {"ok": True, "cancelling": stopped}

    # ---- rows

    @app.post("/api/ws/{c}/concepts/{cid}/labels")
    def concept_verdict(c: str, cid: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ws_of(c)
        k = concept_of(c, cid)
        ref = str(body.get("ref") or "").strip()
        if not ref:
            raise HTTPException(400, "a value needs the unit's ref")
        try:
            row = store.record_verdict(ws, k, ref, str(body.get("label") or ""), body.get("note"))
        except store.LabelError as e:
            raise HTTPException(400, str(e)) from None
        store.notify(ws, cid, "changed")
        return {"row": row, "calibration": (store.read(ws, cid) or k)["calibration"]}

    @app.get("/api/ws/{c}/concepts/{cid}/labels")
    def concept_labels(c: str, cid: str, path: str | None = None, lines: str | None = None) -> dict[str, Any]:
        ws = ws_of(c)
        k = concept_of(c, cid)
        spans = parse_spans(lines)
        rows = list(store.merged(ws, cid).values()) if path is None else store.rows_on(ws, cid, path, spans)
        return {"concept": {"id": k["id"], "name": k["name"], "labels": k["labels"], "unit": k["unit"]}, "rows": rows}

    @app.get("/api/ws/{c}/concepts/{cid}/rows")
    def concept_rows(c: str, cid: str, value: str | None = None, limit: int = ROWS_LIMIT, offset: int = 0,
                     text: bool = False, after: int | None = None) -> dict[str, Any]:
        ws = ws_of(c)
        concept_of(c, cid)
        rows = list(store.merged(ws, cid).values())
        if value is not None and value.strip():
            rows = [r for r in rows if store.effective(r) == value.strip()]
        start = max(0, int(after if after is not None else offset))
        n = max(1, min(int(limit), ROWS_MAX))
        page = [{x: r.get(x) for x in ("ref", "label", "confidence", "rationale", "analyst", "source", "line",
                                       *(("spans",) if r.get("spans") else ()))} for r in rows[start:start + n]]
        if text:
            folder = folder_of(c)
            for r in page:
                r["text"] = unit_text(ws, folder, r["ref"])
                if r.get("spans") and r["spans"][0] in r["text"]:
                    r["match"] = r["spans"][0]
        nxt = start + n if start + n < len(rows) else None
        return {"rows": page, "total": len(rows), "next": nxt}

    @app.get("/api/ws/{c}/concepts/{cid}/coverage")
    def concept_coverage(c: str, cid: str, limit: int = COVERAGE_PAGE, offset: int = 0) -> dict[str, Any]:
        ws = ws_of(c)
        k = concept_of(c, cid)
        out: dict[str, Any] = {"unit": k["unit"], "n_files": 0, "n_covered": 0, "rows": 0, "files": [],
                               "not_covered": [], "n_not_covered": 0, "offset": offset}
        if k["unit"] not in store.FILE_UNITS:
            return out
        per: dict[str, int] = {}
        for ref, r in store.merged(ws, cid).items():
            p, _ = store.ref_place(ref, r)
            if p is not None:
                per[p] = per.get(p, 0) + 1
        paths = [f["path"] for f in corpus.walk(folder_of(c))]
        n_not = 0
        for p in paths:
            if per.get(p):
                out["n_covered"] += 1
                out["rows"] += per[p]
                if len(out["files"]) < limit:
                    out["files"].append({"path": p, "covered": True, "rows": per[p]})
            else:
                if offset <= n_not < offset + limit:
                    out["not_covered"].append(p)
                n_not += 1
        out.update(n_files=len(paths), n_not_covered=n_not)
        return out

    @app.get("/api/ws/{c}/labels")
    def labels_on_file(c: str, path: str, lines: str | None = None) -> list[dict[str, Any]]:
        ws = ws_of(c)
        spans = parse_spans(lines)
        out = []
        for k in store.listing(ws):
            if k["unit"] not in store.FILE_UNITS:
                continue
            rows = store.rows_on(ws, k["id"], path, spans)
            if rows:
                out.append({"concept_id": k["id"], "name": k["name"], "labels": k["labels"], "unit": k["unit"],
                            "created_by": k["created_by"], "rows": rows})
        return out

    @app.post("/api/ws/{c}/labels/refs")
    def labels_on_refs(c: str, body: dict = Body(...)) -> list[dict[str, Any]]:
        ws = ws_of(c)
        wanted = list(dict.fromkeys(str(r) for r in (body.get("refs") or [])[:REFS_MAX] if str(r).strip()))
        out = []
        for k in store.listing(ws):
            if k["unit"] not in store.FILE_UNITS or not wanted:
                continue
            rows = store.rows_for_refs(ws, k["id"], wanted)
            if rows:
                out.append({"concept_id": k["id"], "name": k["name"], "labels": k["labels"], "unit": k["unit"],
                            "created_by": k["created_by"], "rows": rows})
        return out

    @app.get("/api/ws/{c}/labels/presence")
    def labels_presence(c: str) -> list[dict[str, Any]]:
        ws = ws_of(c)
        return [{"concept_id": k["id"], "paths": store.presence(ws, k["id"])} for k in store.listing(ws)
                if k["unit"] in store.FILE_UNITS]

    @app.get("/api/ws/{c}/labels/ruler")
    def labels_ruler(c: str, path: str, bins: int = RULER_BINS, turns: bool = False) -> dict[str, Any]:
        ws = ws_of(c)
        bins = max(1, min(int(bins), 2_000))
        try:
            p = corpus.inside(folder_of(c), path)
            total = 0 if not p.is_file() or corpus.is_binary(p) else corpus.line_count(p)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None
        out = []
        for k in store.listing(ws):
            if k["unit"] != "record":
                continue
            got = store.ruler(ws, k["id"], path, total, bins)
            if got:
                at = {v: sorted(per) for v, per in got.items()}
                out.append({"concept_id": k["id"], "bins": at, "counts": {v: [got[v][b] for b in bs] for v, bs in at.items()}})
        return {"path": path, "total": total, "bins": bins, "labels": out}

    @app.get("/api/ws/{c}/labels/glob")
    def labels_glob(c: str, pattern: str = "") -> dict[str, Any]:
        found = units_mod.match_paths(folder_of(c), store.globs(pattern))
        return {"files": found[:GLOB_LISTED], "total": len(found)}

    # ---- filters

    @app.get("/api/ws/{c}/filters")
    def filters_get(c: str) -> dict[str, Any]:
        return store.read_filters(ws_of(c))

    @app.put("/api/ws/{c}/filters")
    def filters_put(c: str, body: dict = Body(...)) -> dict[str, Any]:
        try:
            return store.set_filter(ws_of(c), str(body.get("scope") or ""), str(body.get("concept") or ""),
                                    str(body.get("value") or ""))
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None

    @app.put("/api/ws/{c}/filters/canvas/cards")
    def filters_cards(c: str, body: dict = Body(...)) -> dict[str, Any]:
        return store.set_card_filter(ws_of(c), body)

    @app.delete("/api/ws/{c}/filters/{scope}")
    def filters_delete(c: str, scope: str, whole: bool = False) -> dict[str, Any]:
        try:
            return store.clear_filter(ws_of(c), scope, whole=whole)
        except Exception as e:  # noqa: BLE001
            raise bad(e) from None


# ---- a label from the analyst's words (the label editor's Label from prompt)

SAMPLE_RECORDS = 6
SAMPLE_CUT = 700
DRAFT_OVER = {"files": "files", "canvas": "cards", "report": "sentences"}
DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "scope": {"type": "string", "enum": list(store.SCOPES)},
        "kind": {"type": "string", "enum": ["regex", "code", "prompt"]},
        "text": {"type": "string"},
        "values": {"type": "array", "items": {"type": "string"}},
        "marks": {"type": "string", "enum": list(store.MARKS)},
    },
    "required": ["name", "scope", "kind", "text", "values", "marks"],
    "additionalProperties": False,
}


async def draft(ws: str, folder: Any, text: str, paths: list[str]) -> dict[str, Any]:
    """The label the labels model defines from the analyst's description, reading the first records of the files it
    would apply to; nothing is stored."""
    found = units_mod.match_paths(folder, store.globs(paths)) if paths else []
    if found:
        first = found[0]
        lines = []
        for u in units_mod.record_units(folder, first):
            t = " ".join(u.text.split())
            if t:
                lines.append(t[:SAMPLE_CUT])
            if len(lines) >= SAMPLE_RECORDS:
                break
        names = ", ".join(found[:5]) + (f" and {len(found) - 5} more files" if len(found) > 5 else "")
        records = prompts.render("browser/labels-draft-records.md", {"paths": names, "path": first,
                                                                     "cut": str(SAMPLE_CUT), "lines": "\n".join(lines)})
    else:
        records = ""
    prompt = prompts.render("browser/labels-draft.md", {"description": text, "records": records})
    try:
        reply = await llm.complete(prompt, "Define the label.", schema=DRAFT_SCHEMA, effort="low")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, llm.failure(e)) from None
    try:
        out = json.loads(reply)
    except ValueError:
        raise HTTPException(502, "the labels model gave no label") from None
    scope = out.get("scope") if out.get("scope") in store.SCOPES else "files"
    kind = out.get("kind") if out.get("kind") in store.KINDS else "prompt"
    values = [" ".join(str(v).split()) for v in out.get("values") or [] if str(v).strip()] or list(store.DEFAULT_VALUES)
    if len(values) < 2:
        values.append("no match" if values[0] != "no match" else "match")
    body = str(out.get("text") or "").strip()
    if not body:
        raise HTTPException(422, "the labels model gave the label no pattern, function or definition")
    if kind == "regex":
        try:
            re.compile(body)
        except re.error as e:
            raise HTTPException(422, f"the labels model gave a pattern that does not compile ({e}): {body}") from None
    marks = out.get("marks") if out.get("marks") in store.MARKS else "span"
    return {"name": " ".join(str(out.get("name") or "").split())[:80] or "new label", "over": DRAFT_OVER[scope],
            "marks": marks if scope == "files" else None, "glob": ", ".join(paths) if scope == "files" else "",
            "kind": kind, "text": body, "values": values[:8]}
