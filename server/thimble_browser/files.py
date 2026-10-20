"""The File browser's readers as routes (feature module): a file read as a transcript, its keys and its timeline, a
database's tables and rows, a PDF as itself, and the stamps the Files tree compares to see that a folder changed.

Every path comes from the page relative to the folder and is checked to stay inside it (readers/base.py file_in). Nothing
here writes into the folder. A database is opened read-only (SQLite's mode=ro), and the page's own SQL runs under an
authorizer that allows reading only: one SELECT, no ATTACH, no PRAGMA, no change, within QUERY_SECONDS.
"""
from __future__ import annotations

import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse

from . import corpus, views
from .readers import base, pdfs, records, source_events, source_keys, transcripts

ROWS_MAX = 500  # rows one page of a table holds at most
QUERY_LIMIT = 1000  # rows a query answers at most
QUERY_SECONDS = 20.0  # a query or a page of rows stops after this long
STAMPS_MAX = 200  # folders one stamps request asks about
_READ_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION,
                 getattr(sqlite3, "SQLITE_RECURSIVE", 33)}


# ---- databases

def _database(folder: Path, rel: str) -> sqlite3.Connection:
    """A read-only connection to the database `rel`: 400 for a path outside the folder, a file not named as a database
    or one SQLite cannot read; 404 for none."""
    if base.source_kind(rel) != "forge":
        raise HTTPException(400, f"not a database file (*.db, *.sqlite, *.sqlite3): {rel!r}")
    db = base.file_in(folder, rel)
    try:
        return base.open_database(db)
    except sqlite3.Error as e:
        raise HTTPException(400, f"{rel!r} is not a readable SQLite database: {e}") from None


def _reading_only(con: sqlite3.Connection) -> None:
    """From now on `con` runs only statements that read, and each for at most QUERY_SECONDS."""
    def authorize(action: int, *_: Any) -> int:
        return sqlite3.SQLITE_OK if action in _READ_ACTIONS else sqlite3.SQLITE_DENY

    deadline = time.monotonic() + QUERY_SECONDS
    con.set_authorizer(authorize)
    con.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10_000)


def database_tables(folder: Path, rel: str) -> list[dict[str, Any]]:
    with closing(_database(folder, rel)) as con:
        return [{"name": t, "row_count": con.execute(f"SELECT COUNT(*) FROM {records.quote_id(t)}").fetchone()[0]}
                for t in base.table_names(con)]


def database_rows(folder: Path, rel: str, table: str, offset: int = 0, limit: int = 100, order: str | None = None,
                  where: str | None = None) -> dict[str, Any]:
    """{table, columns, rows, pk, total}: `limit` rows from `offset`, sorted by `order` (a column, then asc or desc),
    kept by `where` (an SQL condition)."""
    with closing(_database(folder, rel)) as con:
        if table not in base.table_names(con):
            raise HTTPException(404, f"no such table: {table!r}")
        columns, pk = base.table_info(con, table)
        if pk is None:
            pk, select, columns = "rowid", "rowid, *", ["rowid", *columns]
        else:
            select = "*"
        t = records.quote_id(table)
        sql, count_sql = f"SELECT {select} FROM {t}", f"SELECT COUNT(*) FROM {t}"
        if where and where.strip():
            if ";" in where:
                raise HTTPException(400, "where must not contain ';'")
            sql += f" WHERE ({where}\n)"
            count_sql += f" WHERE ({where}\n)"
        if order and order.strip():
            m = re.fullmatch(r'\s*"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(asc|desc))?\s*', order, re.I)
            if not m or m[1] not in columns:
                raise HTTPException(400, "order must be a column name, then asc or desc if you like")
            sql += f' ORDER BY "{m[1]}" {(m[2] or "").upper()}'
        sql += f" LIMIT {max(1, min(limit, ROWS_MAX))} OFFSET {max(0, offset)}"
        _reading_only(con)
        try:
            total = con.execute(count_sql).fetchone()[0]
            rows = [[base.jsonable(v) for v in r] for r in con.execute(sql)]
        except sqlite3.Error as e:
            raise HTTPException(400, f"sqlite: {e}") from None
    return {"table": table, "columns": columns, "rows": rows, "pk": pk, "total": total}


def database_query(folder: Path, rel: str, sql: str) -> dict[str, Any]:
    """{columns, rows, truncated}: one SELECT of the page's, its first QUERY_LIMIT rows."""
    sql = sql.strip().rstrip(";").strip()
    if not sql:
        raise HTTPException(400, "empty sql")
    if ";" in sql:
        raise HTTPException(400, "one statement only: sql must not contain ';'")
    if re.match(r"(pragma|attach|detach)\b", sql, re.I):
        raise HTTPException(400, "PRAGMA and ATTACH are not allowed")
    with closing(_database(folder, rel)) as con:
        _reading_only(con)
        try:
            # a newline before the paren, so a trailing -- comment cannot swallow it
            cur = con.execute(f"SELECT * FROM ({sql}\n) LIMIT {QUERY_LIMIT + 1}")
            rows = cur.fetchall()
            columns = [d[0] for d in cur.description or []]
        except sqlite3.Error as e:
            raise HTTPException(400, f"sqlite: {e}") from None
    return {"columns": columns, "rows": [[base.jsonable(v) for v in r] for r in rows[:QUERY_LIMIT]],
            "truncated": len(rows) > QUERY_LIMIT}


# ---- routes

def register(ctx: Any) -> None:
    app, folder_of = ctx.app, ctx.folder_of

    @app.get("/api/corpora/{c}/source/turns")
    def source_turns(c: str, path: str, start: int = 0, count: int = 100, line: int | None = None,
                     block: int | None = None, char_start: int | None = None, char_end: int | None = None) -> dict:
        return transcripts.get_turns(folder_of(c), path, start, count, line, block, char_start, char_end)

    @app.get("/api/corpora/{c}/source/speakers")
    def source_speakers(c: str, path: str, key: str, ids: str = "") -> dict[str, Any]:
        return transcripts.get_speaker_names(folder_of(c), path, key, ids)

    @app.get("/api/corpora/{c}/source/keys")
    def source_keys_route(c: str, path: str, bins: int = source_keys.BINS_DEFAULT) -> dict[str, Any]:
        return source_keys.get_source_keys(folder_of(c), path, bins)

    @app.get("/api/corpora/{c}/source/events")
    def source_events_route(c: str, path: str) -> dict[str, Any]:
        return source_events.get_source_events(folder_of(c), path)

    @app.get("/api/corpora/{c}/source/timeline")
    def timeline_page(c: str) -> HTMLResponse:
        """The Timeline mode's page as its frame loads it: the view kit over files_timeline.html, which loads no URL;
        its records come from the reader (source/events)."""
        folder_of(c)
        html = source_events.PAGE_HTML.read_text(encoding="utf-8")
        return HTMLResponse(views.frame_document(html, "", "Timeline"), headers={"cache-control": "no-cache"})

    @app.get("/api/corpora/{c}/forge/tables")
    def forge_tables(c: str, path: str = "forge.db") -> list[dict[str, Any]]:
        return database_tables(folder_of(c), path)

    @app.get("/api/corpora/{c}/forge/rows")
    def forge_rows(c: str, table: str, offset: int = 0, limit: int = 100, order: str | None = None,
                   where: str | None = None, path: str = "forge.db") -> dict[str, Any]:
        return database_rows(folder_of(c), path, table, offset, limit, order, where)

    @app.post("/api/corpora/{c}/forge/query")
    def forge_query(c: str, body: dict = Body(...), path: str = "forge.db") -> dict[str, Any]:
        return database_query(folder_of(c), path, str(body.get("sql") or ""))

    @app.get("/api/corpora/{c}/pdf/{path:path}")
    def pdf(c: str, path: str) -> FileResponse:
        """The PDF itself, for the browser's own viewer, at a URL that ends in its name; ranges answered. 415 for a file
        not named .pdf."""
        if not pdfs.is_pdf(path):
            raise HTTPException(415, f"{path} is not a PDF")
        return FileResponse(base.file_in(folder_of(c), path), media_type="application/pdf", headers=pdfs.PDF_HEADERS)

    @app.get("/api/corpora/{c}/sources/stamps")
    def stamps(c: str, path: list[str] = Query(default=[])) -> dict[str, Any]:
        """Each folder's stamp now (corpus.stamp), null for one that is gone, so the tree lists again only the folders
        that changed."""
        f = folder_of(c)
        if len(path) > STAMPS_MAX:
            raise HTTPException(400, f"at most {STAMPS_MAX} folders at a time")
        return {"stamps": {p: corpus.stamp(f, "" if p.strip().strip("/") in ("", ".") else p) for p in path}}
