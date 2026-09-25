"""The Files view's routes for large corpora: a binary file known from its first bytes whatever its size, the tree's
search by name and inside every file, and the reader's search inside one file. The corpus is invented and written to
the test's own folder."""
import json
import shutil
import time

import pytest
from fastapi.testclient import TestClient

from app import corpus
from app.main import app

client = TestClient(app)
API = "/api/corpora/finds"


@pytest.fixture()
def finds(tmp_path, monkeypatch, mini_dir):
    """A DATA_DIR whose corpus `finds` (a copy of mini) also holds a sparse 3 GB binary, a small binary, a terminal
    log, nested runs with look-alike names, a dot folder and a JSON lines file of invented weather notes."""
    from app import config

    data = tmp_path / "data"
    root = data / "finds"
    shutil.copytree(mini_dir, root)
    big = root / "models" / "weights.bin"
    big.parent.mkdir(parents=True)
    with open(big, "wb") as f:
        f.write(b"\x00\x02\x09\x07" * 64)
        f.truncate(3 * 1024 ** 3)  # sparse: no disk is used for the zeros
    (root / "models" / "tokens.idx").write_bytes(bytes(range(256)) * 8)
    (root / "session.log").write_bytes(b"\x1b[1;32m$ \x1b[0mpytest -q\r\n\x1b]0;tmux\x07ok\n" * 40)
    for run, names in {"sweep-a": ["val_17.jsonl", "train.jsonl"], "sweep-b/deep": ["val_17_sft.jsonl", "notes.md"]}.items():
        (root / run).mkdir(parents=True)
        for n in names:
            (root / run / n).write_text('{"x": 1}\n', encoding="utf-8")
    (root / ".cache").mkdir()
    (root / ".cache" / "val_17.jsonl").write_text("{}\n", encoding="utf-8")
    notes = [{"station": "Ridge", "note": 'wind "gusting" at dusk'}, {"station": "Café Nord", "note": "calm"},
             {"station": "ridge", "note": "WIND again\nand rain"}, {"station": "Bay", "note": "fog"}]
    (root / "weather.jsonl").write_text("".join(json.dumps(n) + "\n" for n in notes), encoding="utf-8")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    return root


# --------------------------------------------------------------------------- binary files


def test_a_binary_file_of_any_size_answers_at_once_without_an_index(finds, monkeypatch):
    """A page of a binary file is known from its first bytes: no records, `binary` and the size, and the line index
    (a pass over every byte) is never built, for the page, the page around a line or the overview ruler."""
    def no_index(*_a, **_k):
        raise AssertionError("a binary file must not be indexed")

    monkeypatch.setattr(corpus, "build_index", no_index)
    monkeypatch.setattr(corpus, "line_count", no_index)
    t0 = time.monotonic()
    page = client.get(f"{API}/source", params={"path": "models/weights.bin"}).json()
    assert time.monotonic() - t0 < 2
    assert page == {"path": "models/weights.bin", "kind": "text", "total_lines": 0, "start": 1, "records": [],
                    "binary": True, "size_bytes": 3 * 1024 ** 3}
    around = client.get(f"{API}/source/around", params={"path": "models/weights.bin", "line": 7}).json()
    assert around["binary"] is True and around["records"] == []
    small = client.get(f"{API}/source", params={"path": "models/tokens.idx"}).json()
    assert small["binary"] is True and small["size_bytes"] == 2048
    ruler = client.get("/api/ws/finds/labels/ruler", params={"path": "models/weights.bin"}).json()
    assert ruler["total"] == 0 and ruler["labels"] == []


def test_text_with_escapes_or_latin1_is_not_binary(finds, tmp_path):
    """A terminal log with its escape sequences reads as text, as do Windows-1252 bytes and an empty file; a head with
    many control bytes and no NUL reads as binary."""
    page = client.get(f"{API}/source", params={"path": "session.log"}).json()
    assert "binary" not in page and page["total_lines"] == 80
    latin = tmp_path / "latin.txt"
    latin.write_bytes(b"caf\xe9 au lait\n" * 10)
    empty = tmp_path / "empty.txt"
    empty.write_bytes(b"")
    controls = tmp_path / "controls.dat"
    controls.write_bytes(bytes([1, 2, 3, 4, 5, 6, 65]) * 100)
    assert (corpus.sniff_binary(latin), corpus.sniff_binary(empty), corpus.sniff_binary(controls)) == (False, False, True)


# --------------------------------------------------------------------------- the tree's search by name


def test_file_search_ranks_names_before_paths_and_leaves_out_dot_entries(finds):
    r = client.get(f"{API}/sources/find", params={"q": "val_17"}).json()
    assert [f["path"] for f in r["files"]] == ["sweep-a/val_17.jsonl", "sweep-b/deep/val_17_sft.jsonl"]
    assert r["total"] == 2 and r["files"][0]["kind"] == "text" and r["files"][0]["size_bytes"] == 9
    # every word must be in the path; a word that names a folder narrows to the files under it
    r = client.get(f"{API}/sources/find", params={"q": "deep VAL"}).json()
    assert [f["path"] for f in r["files"]] == ["sweep-b/deep/val_17_sft.jsonl"]
    # the name equal to the query comes first, then a name starting with it
    r = client.get(f"{API}/sources/find", params={"q": "notes.md"}).json()
    assert r["files"][0]["path"] == "sweep-b/deep/notes.md"


def test_file_search_falls_back_to_letters_in_order_and_caps_the_list(finds):
    r = client.get(f"{API}/sources/find", params={"q": "v17sft"}).json()
    assert [f["path"] for f in r["files"]] == ["sweep-b/deep/val_17_sft.jsonl"]
    r = client.get(f"{API}/sources/find", params={"q": "jsonl", "limit": 2}).json()
    assert len(r["files"]) == 2 and r["total"] > 2
    assert client.get(f"{API}/sources/find", params={"q": "  "}).json() == {"q": "  ", "files": [], "total": 0}
    assert client.get("/api/corpora/nope/sources/find", params={"q": "a"}).status_code == 404


# --------------------------------------------------------------------------- find in a file


def test_find_in_a_file_is_case_insensitive_and_reads_json_escapes(finds):
    r = client.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": "wind"}).json()
    assert (r["lines"], r["counts"], r["total"], r["matches"], r["complete"], r["total_lines"]) == ([1, 3], [1, 1], 2, 2, True, 4)
    # a query with quotes and a line break inside a string, and a non-ASCII letter, as JSON wrote them
    assert client.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": '"gusting"'}).json()["lines"] == [1]
    assert client.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": "café"}).json()["lines"] == [2]
    assert client.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": "again\\nand"}).json()["lines"] == [3]
    # past a line, and nothing past the end
    assert client.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": "ridge", "after": 1}).json()["lines"] == [3]
    assert client.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": "ridge", "after": 9}).json()["lines"] == []


def test_find_in_a_file_refuses_what_it_cannot_search(finds):
    lenient = TestClient(app, raise_server_exceptions=False)
    assert lenient.get(f"{API}/source/find", params={"path": "weather.jsonl", "q": " "}).status_code == 400
    assert lenient.get(f"{API}/source/find", params={"path": "forge.db", "q": "a"}).status_code == 400
    assert lenient.get(f"{API}/source/find", params={"path": "../etc/passwd", "q": "a"}).status_code == 400
    assert lenient.get(f"{API}/source/find", params={"path": "missing.txt", "q": "a"}).status_code == 404
    r = lenient.get(f"{API}/source/find", params={"path": "models/weights.bin", "q": "a"}).json()
    assert r["binary"] is True and r["lines"] == [] and r["total"] == 0


def test_find_lines_counts_past_its_limit_and_stops_on_its_budget(tmp_path, monkeypatch):
    """The listed lines stop at the limit and the count goes on; a line longer than FIND_LONG_LINE is searched in
    pieces and still counts once; a scan past its time budget says it is incomplete and how far it read."""
    p = tmp_path / "log.txt"
    p.write_text("".join(f"step {i} {'MATCH' if i % 3 == 0 else 'quiet'}\n" for i in range(1, 301)), encoding="utf-8")
    got = corpus.find_lines(p, [b"match"], limit=5)
    assert got["lines"] == [3, 6, 9, 12, 15] and got["total"] == 100 and got["complete"] and got["scanned"] == 300
    monkeypatch.setattr(corpus, "FIND_BUF", 64)
    monkeypatch.setattr(corpus, "FIND_LONG_LINE", 256)
    long = tmp_path / "long.txt"
    long.write_bytes(b"head\n" + b"x" * 1000 + b"needle" + b"y" * 1000 + b"needle\nneedle tail")
    assert corpus.find_lines(long, [b"needle"]) == {"lines": [2, 3], "counts": [2, 1], "total": 2, "matches": 3,
                                                    "complete": True, "scanned": 3}
    cut = corpus.find_lines(p, [b"match"], budget_s=0)
    assert cut["complete"] is False and 0 < cut["scanned"] < 300


def test_find_counts_every_match_in_a_line_and_a_match_across_a_piece_cut(tmp_path, monkeypatch):
    """A file of one long line matches as many times as the words appear in it, whichever piece of the line holds them,
    and a match that the cut between two pieces runs through is counted once."""
    one = tmp_path / "one.json"
    one.write_text(json.dumps({"notes": ["the conformance suite passed"] * 40 + ["CONFORMANCE"] * 5}), encoding="utf-8")
    got = corpus.find_lines(one, corpus.find_needles("conformance", False))
    assert (got["lines"], got["counts"], got["total"], got["matches"]) == ([1], [45], 1, 45)
    monkeypatch.setattr(corpus, "FIND_BUF", 64)
    monkeypatch.setattr(corpus, "FIND_LONG_LINE", 256)
    for at in range(240, 330, 7):
        p = tmp_path / f"cut{at}.txt"
        p.write_bytes(b"x" * at + b"needle" + b"z" * 600 + b"\nneedle")
        assert corpus.find_lines(p, [b"needle"])["counts"] == [1, 1], at


# --------------------------------------------------------------------------- the search inside every file


def _grep(q: str) -> list[dict]:
    r = client.get(f"{API}/sources/grep", params={"q": q})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def test_content_search_streams_a_line_per_file_with_snippets_then_a_closing_line(finds):
    """Each file that holds the words comes as a line of its own with its count and its first lines, each a snippet
    with the match's place marked; binary files and dot entries are passed over; a closing line counts what was read."""
    *files, done = _grep("wind")
    assert [f["path"] for f in files] == ["weather.jsonl"]
    w = files[0]
    assert (w["total"], w["complete"], [m["line"] for m in w["matches"]]) == (2, True, [1, 3])
    first = w["matches"][0]
    assert first["text"][first["hit"][0]:first["hit"][1]] == "wind"
    assert first["text"].startswith('{"station": "Ridge", "note": "wind')
    assert done["done"] is True and done["files"] == 1 and done["hits"] == 2 and done["complete"] is True
    assert done["scanned"] == done["of"]


def test_content_search_cuts_a_long_line_around_its_match_and_caps_the_lines_listed(finds):
    (finds / "long.txt").write_text("x" * 500 + " the needle here " + "y" * 500 + "\n" + "needle\n" * 9, encoding="utf-8")
    found = list(corpus.grep_files(finds, corpus.list_sources(finds), "NEEDLE", shown=3))
    [hit] = [f for f in found if f.get("path") == "long.txt"]
    assert hit["total"] == 10 and [m["line"] for m in hit["matches"]] == [1, 2, 3]
    snip = hit["matches"][0]
    assert snip["text"].startswith("…") and snip["text"].endswith("…")
    assert snip["text"][snip["hit"][0]:snip["hit"][1]] == "needle"
    assert len(snip["text"]) < corpus.SNIP_BEFORE + corpus.SNIP_AFTER + 10


def test_content_search_stops_at_its_caps_and_when_a_newer_search_starts(finds):
    for i in range(6):
        (finds / f"note_{i}.txt").write_text("alpha\n", encoding="utf-8")
    src = corpus.list_sources(finds)
    *files, done = list(corpus.grep_files(finds, src, "alpha", files_max=2))
    assert len(files) == 2 and done["complete"] is False
    *files, done = list(corpus.grep_files(finds, src, "alpha", stop=lambda: True))
    assert files == [] and done["complete"] is False
    *files, done = list(corpus.grep_files(finds, src, "alpha", budget_s=0))
    assert done["complete"] is False


def test_content_search_refuses_an_empty_query(finds):
    lenient = TestClient(app, raise_server_exceptions=False)
    assert lenient.get(f"{API}/sources/grep", params={"q": " "}).status_code == 400
    assert lenient.get(f"{API}/sources/grep", params={"q": "a\nb"}).status_code == 400
