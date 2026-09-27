"""The screenshot tool's own pages (app/tools.py): an http address is shot only on thimble's own port, and a card's
figure (an SVG, a Vega chart) is drawn from a page of its own where it is data in a frame sandboxed to scripts alone,
under a policy that loads nothing, shot with every request refused. The last test draws both in the headless Chromium
of frontend/node_modules and skips where there is none."""
from __future__ import annotations

import base64
import html
import io
import re
import shutil
from pathlib import Path

import pytest

from app import config, dev, tools


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


def _frame(page: str) -> str:
    """The document a figure page's frame holds."""
    m = re.search(r"<iframe id='fig' sandbox='allow-scripts' [^>]*srcdoc=\"([^\"]*)\"", page)
    assert m, page[:300]
    return html.unescape(m.group(1))


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


async def test_a_figure_is_data_in_a_sandboxed_frame_that_loads_nothing(shots):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>parent.x = 1</script><rect width="40" height="20"/></svg>'
    await tools._shot_svg("abcd1234", svg)
    url, selector, kw, page = shots.calls[-1]
    assert selector == "#fig" and kw["offline"] is True
    assert f'content="{tools.SHOT_PAGE_CSP}"' in page and "connect-src data:" in tools.SHOT_PAGE_CSP
    assert "<svg" not in page and "parent.x" not in page, "the figure is an image's data, never markup"
    inner = _frame(page)
    src = re.search(r"<img id='vis' src='data:image/svg\+xml;base64,([^']+)'", inner)
    assert src and base64.b64decode(src.group(1)).decode() == svg

    spec = {"mark": "bar", "title": "</script><script>parent.y = 1</script>",
            "data": {"values": [{"a": 1}]}, "usermeta": {"embedOptions": {"loader": {"baseURL": "https://evil.example/"}}, "k": 1}}
    page = tools.chart_page(spec)
    inner = _frame(page)
    assert "</script><script>parent.y" not in inner and "\\u003c/script>\\u003cscript>parent.y = 1\\u003c/script>" in inner
    assert "evil.example" not in inner and '"usermeta": {"k": 1}' in inner
    assert spec["usermeta"]["embedOptions"], "the card's own spec is untouched"


def _playwright_missing() -> str | None:
    if shutil.which("node") is None or not (config.REPO_ROOT / "frontend" / "node_modules" / "playwright").is_dir():
        return "no node or frontend/node_modules/playwright"
    if any(not p.is_file() for p in tools.VEGA_BUILDS):
        return "no vega builds in frontend/node_modules"
    return None


async def test_the_figure_page_draws_the_figure_alone():
    missing = _playwright_missing()
    if missing:
        pytest.skip(missing)
    from PIL import Image

    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c33"/></svg>'
    r = await tools._shot_svg("abcd1234", svg)
    assert not r.is_error, r.text
    img = Image.open(io.BytesIO(base64.b64decode(r.content[1]["data"])))
    assert img.size == (120 + 24, 60 + 24), "the figure's frame at the figure's size, padded where the page allows"
    assert img.convert("RGB").getpixel((img.size[0] // 2, img.size[1] // 2)) == (204, 51, 51)

    spec = {"$schema": "https://vega.github.io/schema/vega-lite/v5.json", "width": 200, "height": 100, "mark": "bar",
            "data": {"values": [{"a": "x", "b": 3}, {"a": "y", "b": 5}]},
            "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}}}
    r = await tools._shot_page_file("abcd1234", tools.chart_page(spec))
    assert not r.is_error, r.text
    img = Image.open(io.BytesIO(base64.b64decode(r.content[1]["data"])))
    assert 200 < img.size[0] < 400 and 100 < img.size[1] < 250, img.size
    lo, hi = img.convert("L").getextrema()
    assert hi - lo > 100, "the chart was drawn"
