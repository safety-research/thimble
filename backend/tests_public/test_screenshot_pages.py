"""The screenshot tool (app/tools.py): an http address is shot only on thimble's own port or its interface's."""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

from app import dev, tools


class FakeShot:
    """Stands in for dev.run_shot: records each call with the page it loads, and writes a one-pixel png."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, dict, str]] = []

    async def __call__(self, url, out, selector=None, **kw):
        self.calls.append((url, selector, kw, Path(url.removeprefix("file://")).read_text("utf-8")
                           if url.startswith("file://") else ""))
        Path(out).write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="))
        return 0


@pytest.fixture()
def shots(monkeypatch):
    fake = FakeShot()
    monkeypatch.setattr(dev, "run_shot", fake)
    return fake


async def test_a_page_screenshot_reaches_only_thimble_s_own_port_or_its_interface_s(shots, monkeypatch):
    monkeypatch.setenv("THIMBLE_PORT", "8721")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    ok = await tools._shot_page("http://127.0.0.1:8721/?ws=mini", None)
    assert not ok.is_error and shots.calls[-1][0] == "http://127.0.0.1:8721/?ws=mini"
    for url in ("http://127.0.0.1:22/", "http://localhost/", "http://127.0.0.1:8722/", "http://evil.example:8721/",
                "http://127.0.0.1:99999/", "http://localhost.evil.example:8721/"):
        r = await tools._shot_page(url, None)
        assert r.is_error and "8721" in r.text, url
    assert len(shots.calls) == 1, "nothing else was loaded"
    monkeypatch.setenv("THIMBLE_DEV", "1")
    monkeypatch.setenv("THIMBLE_FRONTEND_URL", "http://127.0.0.1:5399")
    assert tools.shot_ports() == {8721, 5399}
    assert not (await tools._shot_page("http://localhost:5399/", ".canvas")).is_error
