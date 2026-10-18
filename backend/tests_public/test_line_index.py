"""Big files' line indexes (corpus.INDEX_BIG and up): a page is read before the file's index is ready, from its start or
the nearest mark the background build has made, with an estimated line count that turns exact once the index is built;
and an index kept on disk is used only for the file, size and mtime it was built from."""
import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import corpus
from app.main import app

client = TestClient(app)
MINI = "/api/corpora/mini"
N = 20_000


def lines_of(data: bytes) -> list[bytes]:
    """The file's lines as the reader shows them: cut at newlines, a last line without one counted, CRs dropped."""
    out = data.split(b"\n")
    if out and out[-1] == b"":
        out.pop()
    return [ln[:-1] if ln.endswith(b"\r") else ln for ln in out]


def write_big(path: Path, n: int = N) -> bytes:
    """`n` JSON lines of uneven length, every seventh ending in CRLF and the last in no newline."""
    rows = [json.dumps({"i": i, "text": "x" * (i * 37 % 300)}).encode() + (b"\r\n" if i % 7 == 0 else b"\n") for i in range(n)]
    data = b"".join(rows)[:-1]
    path.write_bytes(data)
    return data


@pytest.fixture()
def big(data_tmp, monkeypatch):
    """A file of the mini corpus that counts as big, with small read sizes so that the build reports often and a page
    far past what it has passed waits for it."""
    monkeypatch.setattr(corpus, "INDEX_BIG", 1024)
    monkeypatch.setattr(corpus, "INDEX_BUF", 256 * 1024)
    monkeypatch.setattr(corpus, "FORWARD_BUF", 16 * 1024)
    monkeypatch.setattr(corpus, "FORWARD_SKIP", 64 * 1024)
    path = data_tmp / "mini" / "big.jsonl"
    return path, write_big(path)


@pytest.fixture()
def gate(monkeypatch):
    """Background builds wait until the test calls gate.release()."""
    sem = threading.Semaphore(0)
    monkeypatch.setattr(corpus, "_build_slots", sem)
    yield sem
    sem.release()  # never leave a build waiting


def test_a_big_files_first_page_comes_at_once_with_an_estimate_that_turns_exact(big, gate):
    path, data = big
    want = lines_of(data)
    page = client.get(f"{MINI}/source", params={"path": "big.jsonl", "start": 1, "count": 100}).json()
    assert page["total_estimated"] is True and page["total_lines"] > 100
    assert [r["record"] for r in page["records"]] == [json.loads(x) for x in want[:100]]
    assert path not in corpus._INDEX  # nothing was built: the page came from the file's start
    count = client.get(f"{MINI}/source/lines", params={"path": "big.jsonl"}).json()
    assert count["estimated"] is True and 0.5 * N < count["total_lines"] < 2 * N and count["indexed"] == 0
    gate.release()
    assert len(corpus.line_offsets(path)) == N
    count = client.get(f"{MINI}/source/lines", params={"path": "big.jsonl"}).json()
    assert count == {"path": "big.jsonl", "total_lines": N, "estimated": False, "indexed": 1.0}
    page = client.get(f"{MINI}/source", params={"path": "big.jsonl", "start": N - 1, "count": 100}).json()
    assert "total_estimated" not in page and page["total_lines"] == N and [r["line"] for r in page["records"]] == [N - 1, N]


def test_pages_anywhere_match_the_file_while_the_index_is_built(big, monkeypatch):
    path, data = big
    want = lines_of(data)
    passed, go = threading.Event(), threading.Event()
    progress = corpus._Build.progress

    def paused(self, mark_lines, mark_offsets, lines, at):
        progress(self, mark_lines, mark_offsets, lines, at)
        if lines >= N // 2 and not go.is_set():
            passed.set()
            go.wait(20)

    monkeypatch.setattr(corpus._Build, "progress", paused)
    try:
        got, total, estimated = corpus.page_lines(path, 1, 100)
        assert got == want[:100] and estimated and total > 100
        assert passed.wait(20)
        for a, b in [(1, 1), (7, 7 + 499), (N // 2 - 300, N // 2 - 1), (4001, 4100), (3990, 4010)]:
            got, total, estimated = corpus.page_lines(path, a, b)
            assert got == want[a - 1:b] and estimated and total > b, (a, b)
        far: dict = {}
        t = threading.Thread(target=lambda: far.update(page=corpus.page_lines(path, N - 50, N + 50)))
        t.start()
        t.join(0.5)
        assert t.is_alive()  # past what the build has passed and too far to read on to: it waits for the build
    finally:
        go.set()
    t.join(20)
    assert far["page"] == (want[N - 51:], N, False)
    assert corpus.page_lines(path, N + 1, N + 100) == ([], N, False)
    assert corpus.page_lines(path, 5, 4) == ([], N, False)


def test_an_index_file_that_does_not_match_is_not_used(big):
    path, data = big
    idx = corpus.line_offsets(path)
    f = corpus._index_file(path)
    good = f.read_bytes()
    assert corpus.load_index(path, idx.key) is not None
    assert corpus.load_index(path, (idx.key[0], idx.key[1] + 1)) is None  # another mtime
    other = path.with_name("other.jsonl")
    f.with_name(corpus._index_file(other).name).write_bytes(good)
    assert corpus.load_index(other, idx.key) is None  # another file's index
    for bad in (b"", b"junk", good[:-3], good.replace(b'"marks": ', b'"marks": 1'), good.replace(b'"order": "', b'"order": "x')):
        f.write_bytes(bad)
        assert corpus.load_index(path, idx.key) is None
