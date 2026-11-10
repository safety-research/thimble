"""Pictures in tool results. A tool that names a picture file gives the agent the picture itself: Read on the Messages
API runtime returns a PNG, JPEG, GIF or WebP file as a picture (runtime_tools.py). The pictures here are made up; no
model is called."""
from __future__ import annotations

import base64
import io
import random

from PIL import Image

from app import config, runtime_tools
from test_runtime import CORPUS, api_key, call, main_records, main_turn, on, text  # noqa: F401 — `on` is a fixture


def drawn(fmt: str = "PNG", size: tuple[int, int] = (40, 30)) -> bytes:
    """A made-up picture of `size` px in one color, as a file of the format `fmt`."""
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, format=fmt)
    return out.getvalue()


def as_sent(raw: bytes, mime: str = "image/png") -> dict:
    """The picture `raw` as a tool result of the Messages API carries it."""
    return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(raw).decode()}}


def box() -> runtime_tools.Box:
    """The built-in tools of an agent that reads the corpus and the workspace."""
    ws, corpus = config.workspace_dir(CORPUS), config.corpus_dir(CORPUS)
    ws.mkdir(parents=True, exist_ok=True)
    return runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus, ws], write_roots=[])


async def test_read_returns_a_picture_file_as_a_picture_and_answers_as_before_for_another_binary_file(workspaces_tmp):
    """Read answered `<path> is a binary file` for a picture, so an agent that a tool gave a picture's path (a view's
    check, a review's pictures) could not look at it. Now a PNG, JPEG, GIF or WebP file comes back as the picture after
    a line of text. A binary file that is no picture, and one named as a picture that does not decode, answer as
    before."""
    b = box()
    for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("WEBP", "image/webp")):
        path = b.workspace / f"page.{fmt.lower()}"
        path.write_bytes(drawn(fmt))
        out = await runtime_tools.call(b, "Read", {"file_path": str(path)})
        assert not out.is_error, out.text
        assert out.text == [{"type": "text", "text": f"{path} is a picture of 40 x 30 px"},
                            as_sent(path.read_bytes(), mime)], fmt
    rows, cut = b.workspace / "rows.bin", b.workspace / "cut.png"
    rows.write_bytes(b"\0\1\2" * 10)
    whole = drawn(size=(400, 300))
    cut.write_bytes(whole[:len(whole) // 2])
    for path in (rows, cut):
        out = await runtime_tools.call(b, "Read", {"file_path": str(path)})
        assert out.is_error and out.text == f"{path} is a binary file ({path.stat().st_size} bytes)"


async def test_read_scales_a_picture_over_the_limits_down_and_says_so(workspaces_tmp, monkeypatch):
    """The API refuses a picture over its limits of pixels and bytes. Read scales such a picture down until it fits
    rather than refuse it, names the size it sends, and keeps a JPEG a JPEG."""
    b = box()
    monkeypatch.setattr(runtime_tools, "PICTURE_EDGE", 20)
    for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg")):
        path = b.workspace / f"wide.{fmt.lower()}"
        path.write_bytes(drawn(fmt))
        words, pic = (await runtime_tools.call(b, "Read", {"file_path": str(path)})).text
        assert words["text"] == f"{path} is a picture of 40 x 30 px, scaled down to 20 x 15 px"
        sent = Image.open(io.BytesIO(base64.b64decode(pic["source"]["data"])))
        assert (sent.format, sent.size, pic["source"]["media_type"]) == (fmt, (20, 15), mime)
    # a picture within the edge whose file is too large: noise, which no format packs
    monkeypatch.setattr(runtime_tools, "PICTURE_EDGE", 2576)
    noise = b.workspace / "noise.png"
    Image.frombytes("RGB", (300, 200), random.Random(0).randbytes(300 * 200 * 3)).save(noise, format="PNG")
    monkeypatch.setattr(runtime_tools, "PICTURE_BYTES", noise.stat().st_size // 3)
    words, pic = (await runtime_tools.call(b, "Read", {"file_path": str(noise)})).text
    sent = Image.open(io.BytesIO(base64.b64decode(pic["source"]["data"])))
    assert len(base64.b64decode(pic["source"]["data"])) <= runtime_tools.PICTURE_BYTES
    assert words["text"] == f"{noise} is a picture of 300 x 200 px, scaled down to {sent.size[0]} x {sent.size[1]} px"


async def test_a_picture_main_reads_reaches_the_model_as_a_picture(on, monkeypatch):
    """On the Messages API runtime the result of a Read of a picture carries the picture in the next request, where the
    model sees it, and the chat shows the result as a picture's."""
    path = config.workspace_dir(CORPUS) / "page.png"
    path.write_bytes(drawn())
    client = api_key(monkeypatch, [call("Read", {"file_path": str(path)}), text("A red page.")])
    await main_turn("What does the page look like?")
    result = client.bodies[1]["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and not result.get("is_error")
    assert result["content"] == [{"type": "text", "text": f"{path} is a picture of 40 x 30 px"},
                                 as_sent(path.read_bytes())]
    shown = [r for r in main_records() if r["type"] == "tool_result"]
    assert [r.get("summary") for r in shown] == [f"{path} is a picture of 40 x 30 px\n[image]"], shown
