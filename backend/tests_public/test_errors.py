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


def test_an_unhandled_error_answers_json_with_an_id_and_logs_the_request_and_the_traceback(caplog):
    client = TestClient(_app(), raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="thimble.error"):
        r = client.get("/api/ws/harbor-logs/boom?x=1")
    assert r.status_code == 500 and r.headers["content-type"] == "application/json"
    body = r.json()
    assert body["detail"] == (f"server error (RuntimeError: the store was half written). Logged in server.log as "
                              f"{body['error_id']}.")
    rec = next(r for r in caplog.records if r.name == "thimble.error")
    assert rec.getMessage() == (f"request {body['error_id']} failed: GET /api/ws/harbor-logs/boom?x=1 "
                                "(workspace harbor-logs) -> 500")
    assert rec.exc_info and rec.exc_info[0] is RuntimeError


def test_an_unreadable_file_is_403_and_a_full_disk_507_each_naming_the_path():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/api/corpora/edge/source?path=secret.txt")
    assert r.status_code == 403
    assert r.json()["detail"].startswith("the server may not read or write /corpus/secret.txt (Permission denied)")
    r = client.post("/api/ws/edge/save")
    assert r.status_code == 507
    assert r.json()["detail"].startswith("the disk that holds /ws/cards.json is full; free some space and try again")


def test_an_error_after_the_response_started_is_logged_and_raised(caplog):
    client = TestClient(_app(), raise_server_exceptions=True)
    with caplog.at_level(logging.ERROR, logger="thimble.error"), pytest.raises(RuntimeError, match="mid-stream"):
        client.get("/api/stream")
    assert any(r.name == "thimble.error" and "GET /api/stream (workspace -)" in r.getMessage() for r in caplog.records)


def test_the_server_wraps_every_route_in_it():
    assert any(m.cls is errors.ErrorLog for m in main.app.user_middleware)
    assert errors.workspace_of("/api/ws/a-b/chats") == "a-b" and errors.workspace_of("/api/health") == "-"


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


def test_uvicorn_lines_get_the_wall_clock_stamp():
    logger = logging.getLogger("uvicorn.access")
    handler = logging.StreamHandler()
    from uvicorn.logging import AccessFormatter

    handler.setFormatter(AccessFormatter('%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s'))
    logger.addHandler(handler)
    try:
        main.stamp_uvicorn_logs()
        assert handler.formatter._fmt.startswith("%(asctime)s %(levelprefix)s")
        main.stamp_uvicorn_logs()
        assert handler.formatter._fmt.count("%(asctime)s") == 1
    finally:
        logger.removeHandler(handler)


def test_health_names_the_built_ui_it_serves_so_an_open_tab_can_tell_it_is_older(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>")
    monkeypatch.setattr(config, "FRONTEND_DIST", dist)
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    first = main.ui_build()
    assert first == str((dist / "index.html").stat().st_mtime_ns)
    os.utime(dist / "index.html", ns=(1, int(first) + 5_000_000_000))
    assert main.ui_build() != first, "a rebuild's index.html is another build"
    assert TestClient(main.app).get("/api/health").json()["ui"] == main.ui_build()
    monkeypatch.setenv("THIMBLE_DEV", "1")
    assert main.ui_build() is None, "in dev mode Vite reloads the page itself"
