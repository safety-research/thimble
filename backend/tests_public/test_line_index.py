"""Big files' line indexes (corpus.INDEX_BIG and up): a page is read before the file's index is ready, from its start or
the nearest mark the background build has made, with an estimated line count that turns exact once the index is built;
the ruler's count shares that build; and the index is kept on disk, keyed by path, size and mtime, for the next
server."""
import json
import threading
from pathlib import Path

import pytest

from app import corpus

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
