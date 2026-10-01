"""The browser's uncaught errors in server.log (telemetry.log_browser_error): an error gets an ERROR line, and the
ResizeObserver loop notice, which is no error, gets none."""
from __future__ import annotations

import logging

from app import telemetry


def _row(text: str) -> dict:
    return {"kind": "error", "session": "s1", "target": None, "detail": {"text": text}}


def test_an_uncaught_error_is_logged_and_the_resize_observer_notice_is_not(caplog, monkeypatch):
    monkeypatch.setattr(telemetry, "_browser_errors", {})
    with caplog.at_level(logging.DEBUG, logger="thimble.browser"):
        assert telemetry.log_browser_error("w", _row("ResizeObserver loop completed with undelivered notifications.")) is False
        assert telemetry.log_browser_error("w", _row("ResizeObserver loop limit exceeded")) is False
        assert telemetry.log_browser_error("w", _row("TypeError: x is undefined | at f (app.js:1:2)")) is True
    lines = [(r.levelno, r.getMessage()) for r in caplog.records if r.name == "thimble.browser"]
    assert len(lines) == 1
    assert lines[0][0] == logging.ERROR
    assert "TypeError: x is undefined" in lines[0][1]
    assert telemetry._browser_errors["w"] and len(telemetry._browser_errors["w"]) == 1
