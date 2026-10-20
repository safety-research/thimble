"""The File browser's readers and media as routes (files.py, media.py, readers/): transcripts, keys, timelines,
databases read-only, PDFs, media, refs and the tree's stamps, all inside the folder."""
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from thimble_browser import home, views
from thimble_browser.app import build

PORT = 21098
OWN = f"http://127.0.0.1:{PORT}"


def pdf_bytes(pages: list[str]) -> bytes:
    """A small PDF with one line of text in Helvetica on each page."""
    objs: list[str] = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    contents = []
    for text in pages:
        stream = f"BT /F1 14 Tf 72 720 Td ({text}) Tj ET"
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        contents.append(len(objs))
    pages_id = len(objs) + len(pages) + 1
    kids = []
    for c in contents:
        objs.append(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 612 792] /Contents {c} 0 R "
                    "/Resources << /Font << /F1 1 0 R >> >> >>")
        kids.append(len(objs))
    objs.append(f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>")
    objs.append(f"<< /Type /Catalog /Pages {pages_id} 0 R >>")
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root {len(objs)} 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    return bytes(out)


STREAM = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00Z", "message": {"role": "user", "content": "Why did the build fail?"}},
    {"type": "assistant", "timestamp": "2026-09-01T10:00:20Z", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "Read the build log."},
        {"type": "text", "text": "I will read the log."},
        {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "build.log"}}]}},
    {"type": "user", "timestamp": "2026-09-01T10:00:30Z", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "error: missing semicolon on line 12"}]}},
    {"type": "assistant", "timestamp": "2026-09-01T10:00:50Z", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "A missing semicolon on line 12 broke the build."}]}},
]


@pytest.fixture
def files(folder):
    """The test folder with a transcript in each of three formats, timed records, a database, a PDF and an image."""
    (folder / "sessions").mkdir()
    (folder / "sessions" / "build.jsonl").write_text("".join(json.dumps(r) + "\n" for r in STREAM))
    convs = {"conversations": [{"title": "Order 12 is late", "messages": [
        {"role": "user", "content": "Where is order 12?", "created_at": "2026-09-02T09:00:00Z"},
        {"role": "assistant", "content": "It ships today.", "created_at": "2026-09-02T09:00:30Z"}]}]}
    (folder / "export.json").write_text(json.dumps(convs, indent=2))
    (folder / "standup.txt").write_text("[09:00] maya: hello all\n[09:01] ravi: I fixed the uploader\n"
                                        "[09:02] maya: thanks\n[09:03] lin: I start on alerts\n"
                                        "[09:04] ravi: I need access to billing\n[09:05] lin: I can grant it\n"
                                        "[09:06] maya: see you at three\n")
    (folder / "chat.jsonl").write_text("".join(json.dumps({"agent_id": f"ag-{w}x7k2m9q1x4p", "text": t,
                                                            "sent_at": f"2026-09-05T14:0{n}:00Z"}) + "\n"
                                               for n, (w, t) in enumerate([("a", "Plan it."), ("b", "Done."),
                                                                           ("a", "Good."), ("b", "Next.")])))
    (folder / "agents.jsonl").write_text(json.dumps({"id": "ag-ax7k2m9q1x4p", "name": "Planner"}) + "\n")
    (folder / "events.log.jsonl").write_text("".join(
        json.dumps({"timestamp": f"2026-09-01T0{n % 9}:00:00Z", "service": ["api", "web"][n % 2],
                    "kind": ["deploy", "alert", "deploy"][n % 3], "message": f"event {n}"}) + "\n" for n in range(30)))
    con = sqlite3.connect(folder / "shop.db")
    con.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, status TEXT)")
    con.execute("CREATE TABLE notes (body TEXT)")
    con.executemany("INSERT INTO orders VALUES (?,?,?)", [(i, f"item {i}", ["open", "shipped"][i % 2]) for i in range(1, 51)])
    con.execute("INSERT INTO notes VALUES ('no key here')")
    con.commit()
    con.close()
    (folder / "guide.pdf").write_bytes(pdf_bytes(["Page one text", "The second page says hello"]))
    (folder / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 64)
    (folder / "drawing.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    return folder


@pytest.fixture
def api(files):
    """A signed-in client, the workspace's name and the auth."""
    ws = home.open_folder(files)
    app, auth, _ = build(PORT)
    c = TestClient(app, base_url=OWN)
    r = c.post("/api/ui/key", json={"code": auth.mint()}, headers={"origin": OWN})
    key, cookie = r.json()["key"], r.headers["set-cookie"].split(";")[0]

    class Api:
        name = ws

        def get(self, path, **kw):
            return c.get(f"/b/{key}/api{path}", headers={"cookie": cookie, **kw.pop("headers", {})}, **kw)

        def post(self, path, **kw):
            return c.post(f"/b/{key}/api{path}", headers={"cookie": cookie, "origin": OWN}, **kw)

        def bare(self, path, **kw):
            return c.get(path, **kw)

        def sign_out(self):
            c.post(f"/b/{key}/api/ui/signout", headers={"cookie": cookie, "origin": OWN})

    return Api()


def test_a_page_of_a_file_says_it_reads_as_a_transcript_and_has_a_time(api):
    page = api.get(f"/corpora/{api.name}/source", params={"path": "sessions/build.jsonl", "count": 4}).json()
    assert page["transcript"]["format"] == "stream" and page["time"] == {"key": "timestamp"}
    # a Claude Code transcript's records are its message's blocks, not raw JSON
    assert [b["kind"] for b in page["records"][1]["blocks"]] == ["thinking", "text", "tool_use"]
    assert page["records"][2]["blocks"] == [{"kind": "tool_result", "text": "error: missing semicolon on line 12"}]
    chat = api.get(f"/corpora/{api.name}/source", params={"path": "standup.txt"}).json()
    assert chat["transcript"]["format"] == "text" and chat["records"][1]["meta"]["turn"]["speaker"] == "ravi"
    plain = api.get(f"/corpora/{api.name}/source", params={"path": "notes.md"}).json()
    assert "transcript" not in plain and "time" not in plain


def test_the_turns_of_a_whole_json_transcript_and_the_names_of_its_speakers(api):
    got = api.get(f"/corpora/{api.name}/source/turns", params={"path": "export.json"}).json()
    assert got["total"] == 2 and got["n_groups"] == 1 and got["groups"]["0"]["title"] == "Order 12 is late"
    assert [t["role"] for t in got["turns"]] == ["user", "assistant"] and got["turns"][1]["text"] == "It ships today."
    assert api.get(f"/corpora/{api.name}/source/turns", params={"path": "notes.md"}).status_code == 415
    names = api.get(f"/corpora/{api.name}/source/speakers",
                    params={"path": "chat.jsonl", "key": "agent_id", "ids": "ag-ax7k2m9q1x4p,ag-bx7k2m9q1x4p"}).json()
    assert names == {"names": {"ag-ax7k2m9q1x4p": "Planner"}}


def test_keys_and_the_timeline_of_timed_records(api):
    keys = api.get(f"/corpora/{api.name}/source/keys", params={"path": "events.log.jsonl", "bins": 10}).json()
    by = {k["key"]: k for k in keys["keys"]}
    assert keys["total"] == 30 and {v["value"] for v in by["service"]["values"]} == {"api", "web"}
    assert len(by["kind"]["at"]) == 10
    ev = api.get(f"/corpora/{api.name}/source/events", params={"path": "events.log.jsonl"}).json()
    assert ev["time"] == "timestamp" and ev["total"] == 30 and ev["events"][0]["ref"].startswith("events.log.jsonl#L")
    assert [e["t"] for e in ev["events"]] == sorted(e["t"] for e in ev["events"])
    assert api.get(f"/corpora/{api.name}/source/events", params={"path": "shop.db"}).status_code == 415
    page = api.get(f"/corpora/{api.name}/source/timeline")
    assert page.status_code == 200 and "connect-src 'none'" in page.text and 'id="view"' in page.text


def test_a_database_is_read_only(api, files):
    base = f"/corpora/{api.name}/forge"
    assert api.get(f"{base}/tables", params={"path": "shop.db"}).json() == [
        {"name": "notes", "row_count": 1}, {"name": "orders", "row_count": 50}]
    rows = api.get(f"{base}/rows", params={"path": "shop.db", "table": "orders", "where": "status = 'open'",
                                          "order": "id desc", "limit": 3}).json()
    assert rows["total"] == 25 and [r[0] for r in rows["rows"]] == [50, 48, 46] and rows["pk"] == "id"
    assert api.get(f"{base}/rows", params={"path": "shop.db", "table": "notes"}).json()["columns"] == ["rowid", "body"]
    q = api.post(f"{base}/query", params={"path": "shop.db"}, json={"sql": "select status, count(*) n from orders group by 1"})
    assert q.status_code == 200 and q.json()["rows"] == [["open", 25], ["shipped", 25]]
    for sql in ("attach database 'other.db' as o", "pragma table_info(orders)", "delete from orders",
                "select 1; delete from orders", "with x as (select 1) delete from orders", "detach o"):
        assert api.post(f"{base}/query", params={"path": "shop.db"}, json={"sql": sql}).status_code == 400, sql
    # a condition cannot carry a second statement, and the connection would refuse a write anyway
    assert api.get(f"{base}/rows", params={"path": "shop.db", "table": "orders",
                                          "where": "1); delete from orders; --"}).status_code == 400
    assert api.get(f"{base}/tables", params={"path": "../outside.db"}).status_code == 400
    assert api.get(f"{base}/tables", params={"path": "notes.md"}).status_code == 400
    assert sqlite3.connect(files / "shop.db").execute("select count(*) from orders").fetchone()[0] == 50


def test_a_pdf_opens_as_itself_and_a_page_ref_reads_its_text(api):
    r = api.get(f"/corpora/{api.name}/pdf/guide.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.headers["x-content-type-options"] == "nosniff" and r.content.startswith(b"%PDF")
    assert api.get(f"/corpora/{api.name}/pdf/notes.md").status_code == 415
    assert api.get(f"/corpora/{api.name}/pdf/../x.pdf").status_code in (400, 404)
    page = api.get(f"/corpora/{api.name}/ref", params={"ref": "guide.pdf#p2"}).json()
    assert page["kind"] == "page" and "second page" in page["excerpt"] and page["meta"]["pages"] == 2
    assert api.get(f"/corpora/{api.name}/ref", params={"ref": "guide.pdf#p9"}).status_code == 404


def test_refs_to_a_span_a_block_and_a_database_row(api):
    ref = lambda r: api.get(f"/corpora/{api.name}/ref", params={"ref": r})  # noqa: E731
    assert ref("sessions/build.jsonl#L4.b0:c2-21").json()["excerpt"] == "missing semicolon o"
    assert ref("sessions/build.jsonl#L2.b2").json()["excerpt"].startswith("Read\n")
    row = ref("shop.db#orders/7").json()
    assert row["kind"] == "row" and row["record"] == {"id": 7, "item": "item 7", "status": "shipped"}
    assert ref("shop.db#orders/999").status_code == 404 and ref("shop.db#nope").status_code == 404
    assert ref("export.json#/conversations/0").json()["kind"] == "pointer"


def test_media_files_and_nothing_else(api):
    r = api.get(f"/ws/{api.name}/media", params={"path": "chart.png"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert "sandbox" in r.headers["content-security-policy"]
    part = api.get(f"/ws/{api.name}/media", params={"path": "chart.png"}, headers={"range": "bytes=0-7"})
    assert part.status_code == 206 and part.content == b"\x89PNG\r\n\x1a\n"
    for path, status in (("drawing.svg", 415), ("notes.md", 415), ("../chart.png", 400), (".hidden.png", 400),
                         ("gone.png", 404)):
        assert api.get(f"/ws/{api.name}/media", params={"path": path}).status_code == status, path


def test_a_views_frame_loads_the_media_it_claims_with_its_own_key(api, files):
    views.write_file(api.name, "pics", "view.json", json.dumps({"name": "Pictures", "scope": ["*.png"]}))
    views.write_file(api.name, "pics", "reader.py", "def build_index(p):\n    return p\ndef records(i, q):\n    return i\n"
                     "def resolve(i, l):\n    return None\n")
    views.write_file(api.name, "pics", "view.html", "<img id=i>")
    views.mark_built(api.name, "pics")
    doc = api.get(f"/ws/{api.name}/views/pics/frame").text
    media = json.loads(doc.split("window.__thimbleView = ", 1)[1].split("; window.", 1)[0])["media"]
    assert media.startswith(f"{OWN}/api/ws/{api.name}/views/pics/media/") and f"img-src data: blob: {media}" in doc
    path = media[len(OWN):]
    got = api.bare(path, params={"path": "chart.png"})  # no cookie: the frame sends none
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert api.bare(path, params={"path": "guide.pdf"}).status_code == 415
    (files / "photo.jpg").write_bytes(b"\xff\xd8\xff")
    assert api.bare(path, params={"path": "photo.jpg"}).status_code == 403  # not claimed
    assert api.bare(path[:-4] + "abcd", params={"path": "chart.png"}).status_code in (401, 404)
    assert api.bare(f"/api/ws/{api.name}/media", params={"path": "chart.png"}).status_code == 401
    api.sign_out()
    assert api.bare(path, params={"path": "chart.png"}).status_code == 404


def test_card_libraries_and_the_trees_stamps(api, files):
    got = api.get(f"/ws/{api.name}/card-libs", params={"libs": "vega-embed,d3"}).json()
    assert got["problems"][0].startswith("thimble browser has only vega")
    listing = api.get(f"/corpora/{api.name}/sources", params={"path": ".", "depth": 1}).json()
    stamps = api.get(f"/corpora/{api.name}/sources/stamps?path=.&path=sessions&path=gone").json()["stamps"]
    assert stamps["."] == listing["stamp"] and stamps["sessions"] and stamps["gone"] is None
    (files / "new.txt").write_text("x")
    assert api.get(f"/corpora/{api.name}/sources/stamps?path=.").json()["stamps"]["."] != listing["stamp"]
