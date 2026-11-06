"""The screenshot tool (app/tools.py): an http address is shot only on thimble's own port, so an agent's screenshot
reaches no other service on this machine or elsewhere."""
from __future__ import annotations

import base64
from pathlib import Path

from app import dev, tools


async def test_a_page_screenshot_reaches_only_thimble_s_own_port(monkeypatch):
    shot: list[str] = []

    async def run_shot(url, out, selector=None, **kw):
        shot.append(url)
        Path(out).write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="))
        return 0

    monkeypatch.setattr(dev, "run_shot", run_shot)
    monkeypatch.setenv("THIMBLE_PORT", "8721")
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    ok = await tools._shot_page("http://127.0.0.1:8721/?ws=mini", None)
    assert not ok.is_error and shot == ["http://127.0.0.1:8721/?ws=mini"]
    for url in ("http://127.0.0.1:22/", "http://evil.example:8721/", "http://evil.example\\@127.0.0.1:8721/",
                "http://x@127.0.0.1:8721/"):
        r = await tools._shot_page(url, None)
        assert r.is_error and "8721" in r.text, url
    assert len(shot) == 1, "nothing else was loaded"
