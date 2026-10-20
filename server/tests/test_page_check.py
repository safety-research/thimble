"""The view builder's check of a view's page in headless Chromium (views/page_check.py)."""
import builtins
import json
import struct
import zlib

import pytest

from thimble_browser import home, views
from thimble_browser.cards import sandbox
from thimble_browser.views import page_check

READER = '''
def build_index(paths):
    out = []
    for p in paths:
        with open(p, "rb") as f:
            out.append({"path": p, "size": len(f.read())})
    return out

def records(index, query):
    return {"files": [r["path"] for r in index]}

def resolve(index, locator):
    return None
'''


def png() -> bytes:
    """A 2x2 PNG."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\0" + b"\xc9\x3a\x28" * 2 for _ in range(2))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def view(folder, html: str, scope=("runs/*.jsonl", "*.png")) -> str:
    ws = home.open_folder(folder)
    views.write_file(ws, "check", "view.json", json.dumps({"name": "Check", "scope": list(scope)}))
    views.write_file(ws, "check", "reader.py", READER)
    views.write_file(ws, "check", "view.html", html)
    return ws


async def test_without_playwright_the_check_is_skipped_and_does_not_fail(folder, monkeypatch):
    real = builtins.__import__

    def no_playwright(name, *args, **kwargs):
        if name.startswith("playwright"):
            raise ImportError(name)
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_playwright)
    ws = view(folder, "<p>hello</p>")
    got = await page_check.run(ws, "check", folder)
    assert got["shot"] is None and got["lines"][0].startswith("skipped: the page was not drawn")


@pytest.fixture
async def chromium(monkeypatch):
    """Headless Chromium for the tests, or a skip. Where Chromium cannot start its own sandbox on the test machine (a
    Linux that restricts user namespaces), these tests, and only they, draw their own made-up pages without it; the
    check itself never does."""
    pw_api = pytest.importorskip("playwright.async_api")
    async with pw_api.async_playwright() as pw:
        try:
            b = await pw.chromium.launch(headless=True, chromium_sandbox=True)
            await b.close()
        except Exception as e:  # noqa: BLE001
            if "sandbox" not in str(e).lower():
                pytest.skip(f"no Chromium here: {str(e).splitlines()[0]}")

            async def launch(pw, tmp):
                return await pw.chromium.launch(headless=True, chromium_sandbox=False, env={"HOME": tmp})

            monkeypatch.setattr(page_check, "_launch", launch)


async def test_a_page_that_draws_passes_and_leaves_its_picture(folder, chromium):
    (folder / "chart.png").write_bytes(png())
    ws = view(folder, "<h1 data-anchor='runs/a.jsonl#L1'>Runs</h1><img id=i><script>"
                      "document.getElementById('i').src = thimble.mediaUrl('chart.png')</script>")
    got = await page_check.run(ws, "check", folder)
    assert got["lines"][0].startswith("ok: the page drew"), got["lines"]
    assert got["shot"] and open(got["shot"], "rb").read(4) == b"\x89PNG"


async def test_errors_refused_loads_and_an_empty_page_fail(folder, chromium):
    ws = view(folder, "<p>x</p><script>throw new Error('the view broke')</script>")
    assert any("uncaught" in x and "the view broke" in x for x in (await page_check.run(ws, "check", folder))["lines"])
    ws = view(folder, "<p>x</p><img src='https://example.com/a.png'>")
    assert any(x.startswith("the frame's policy refused a load") for x in (await page_check.run(ws, "check", folder))["lines"])
    ws = view(folder, "<p>x</p><script>location.href = 'http://example.com/elsewhere'</script>")
    lines = (await page_check.run(ws, "check", folder))["lines"]
    assert any("asked for http://example.com/elsewhere" in x for x in lines), lines
    ws = view(folder, "<div></div>")
    assert any("shows nothing" in x for x in (await page_check.run(ws, "check", folder))["lines"])
    ws = view(folder, "<p>x</p><img id=i><script>document.getElementById('i').src = thimble.mediaUrl('notes.md')</script>")
    assert any("mediaUrl" in x for x in (await page_check.run(ws, "check", folder))["lines"])


@pytest.mark.skipif(sandbox.available() is None, reason="no sandbox on this machine")
async def test_the_builders_check_draws_the_page_with_the_readers_answers(folder, chromium):
    ws = view(folder, "<ul id=u></ul><script>thimble.fetch({}).then(d => { for (const f of d.files) "
                      "document.getElementById('u').insertAdjacentHTML('beforeend', '<li>' + f + '</li>') })</script>")
    got = await views.check(ws, "check", folder)
    assert got["ok"], got["lines"]
    assert any(x.startswith("ok: the page drew in headless Chromium after 1 fetch") for x in got["lines"])


def test_a_tool_result_with_a_picture_is_text_then_an_image_block(tmp_path):
    from thimble_browser.agent import _result_content
    from thimble_browser.tools import Result

    shot = tmp_path / "check.png"
    shot.write_bytes(png())
    assert _result_content(Result("no picture")) == "no picture"
    text, image = _result_content(Result("the checks pass", images=[shot]))
    assert text == {"type": "text", "text": "the checks pass"}
    assert image["type"] == "image" and image["source"]["media_type"] == "image/png"
