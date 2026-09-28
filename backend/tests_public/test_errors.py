"""A request no route handled (errors.ErrorLog): a JSON answer naming the failure and an id, a log record with the
method, the path, the workspace and the traceback under that id; a full disk and an unreadable file named as such. Also
the plain sentence for a link out of the corpus (config.safe_corpus_path), the stamps on uvicorn's own log lines, and
the build of the UI that /api/health names."""
from __future__ import annotations

import errno
import logging
import os

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import config, errors, main


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(errors.ErrorLog)

    @app.get("/api/ws/{c}/boom")
    def boom(c: str):
        raise RuntimeError("the store was half written")

    @app.get("/api/corpora/{c}/source")
    def unreadable(c: str, path: str):
        raise PermissionError(errno.EACCES, "Permission denied", f"/corpus/{path}")

    @app.post("/api/ws/{c}/save")
    def full(c: str):
        raise OSError(errno.ENOSPC, "No space left on device", "/ws/cards.json")

    @app.get("/api/stream")
    def stream():
        def gen():
            yield b"first"
            raise RuntimeError("mid-stream")

        return StreamingResponse(gen())

    return app


def test_a_link_out_of_the_corpus_is_named_as_one(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("x")
    os.symlink(outside, corpus / "link.txt")
    (corpus / "own.txt").write_text("y")
    os.symlink("own.txt", corpus / "inner.txt")
    assert config.safe_corpus_path(corpus, "inner.txt") == corpus / "own.txt"
    with pytest.raises(ValueError) as e:
        config.safe_corpus_path(corpus, "link.txt")
    assert str(e.value).startswith(f"path escapes corpus: 'link.txt' is a link to {outside}, outside the corpus folder")
    with pytest.raises(ValueError, match=r"^path escapes corpus: '../outside.txt'$"):
        config.safe_corpus_path(corpus, "../outside.txt")
