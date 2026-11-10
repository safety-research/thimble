"""Pictures in tool results. A tool that names a picture file gives the agent the picture itself: Read on the Messages
API runtime returns a PNG, JPEG, GIF or WebP file as a picture (runtime_tools.py), and the picture of a view's check
and the pictures of its review come with those tools' answers on both runtimes (view_tools.py, view_review.py). The
pictures here are made up; no model is called and no page is loaded.

The view's agents start through the fake bridge (subagent_fakes), which makes no conversation, so a test makes the
agent's as the runtime does and calls the tool the way each runtime runs a call."""
from __future__ import annotations

import base64
import io
import random
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

from app import (config, headless, runtime, runtime_api, runtime_cc, runtime_tools, subagents, view_review, view_tools,
                 views)
from subagent_fakes import bridge  # noqa: F401 — a fixture
from test_runtime import CORPUS, api_key, call, fake_sdk, main_records, main_turn, on, text  # noqa: F401 — `on` is a fixture
from test_view_subagents import CORPUS as BOARDS, _call, _draft, _propose, _started, board, gates  # noqa: F401 — `board`, `gates` are fixtures


def drawn(fmt: str = "PNG", size: tuple[int, int] = (40, 30)) -> bytes:
    """A made-up picture of `size` px in one color, as a file of the format `fmt`."""
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, format=fmt)
    return out.getvalue()


def as_sent(raw: bytes, mime: str = "image/png") -> dict:
    """The picture `raw` as a tool result of the Messages API carries it."""
    return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(raw).decode()}}


def as_handed(raw: bytes, mime: str = "image/png") -> dict:
    """The picture `raw` as a thimble tool's result carries it, which the session of Claude Code gets as it is."""
    return {"type": "image", "data": base64.b64encode(raw).decode(), "mimeType": mime}


def box() -> runtime_tools.Box:
    """The built-in tools of an agent that reads the corpus and the workspace."""
    ws, corpus = config.workspace_dir(CORPUS), config.corpus_dir(CORPUS)
    ws.mkdir(parents=True, exist_ok=True)
    return runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus, ws], write_roots=[])


def conv_of(agent: str, role: str, key: str) -> runtime.Conv:
    """The conversation of the agent `agent` of `role`, whose start has the key `key`, as the runtime makes one
    (runtime._spawn_agent)."""
    return runtime.Conv(runtime.Space(BOARDS), agent, "agent", agent_id=agent, agent_type=subagents.type_name(role),
                        role=role, key=key)


async def on_the_api(conv: runtime.Conv, tool: str, args: dict[str, Any]) -> list[dict]:
    """What the Messages API runtime sends the model as the result of the agent's call of `tool`."""
    block = {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:20]}", "name": tool, "input": args}
    _, sent = await runtime_api._call(conv, None, block)
    assert not sent.get("is_error"), sent
    return sent["content"]


async def on_claude_code(monkeypatch, conv: runtime.Conv, tool: str, args: dict[str, Any]) -> list[dict]:
    """What the session of Claude Code gets as the result of the agent's call of `tool`: the answer of the tool's
    handler in the session's own MCP server (runtime_cc.options), whose text and pictures the Agent SDK passes on."""
    seen: dict[str, Any] = {}
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    fake_sdk(monkeypatch, [], seen)
    runtime_cc.options(conv, conv.spec(), {})
    got = await next(t.handler for t in seen["server"][1] if t.name == tool)(args)
    assert not got["is_error"], got
    return got["content"]


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


async def test_a_view_check_with_a_picture_answers_with_the_picture_on_both_runtimes(board, bridge, monkeypatch):
    """view_check with `picture` named the picture's file and said Read opens it, which Read on the Messages API
    runtime did not. Now the picture comes with the answer after its text, which still names the file, on the Messages
    API and in a session of Claude Code. A picture over the API's limits is scaled down and the text says so; a file
    that does not load is named as such, with no picture."""
    slug = _propose(asked=True)
    conv = conv_of(await _started(slug), view_tools.BUILDER, view_tools.build_key(slug))
    _draft(slug)
    shot = views.views_dir(BOARDS) / slug / "cache" / "shots" / "check-1-overview.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(drawn())
    taken = {"png": shot}

    async def check_answer(c: str, slug: str, locators: list[str], picture: bool) -> dict[str, Any]:
        return {"ok": True, "lines": ["the checks passed"], "png": str(taken["png"]) if picture else None}

    monkeypatch.setattr(views, "check_answer", check_answer)
    said = f"The picture of the page as it opens comes with this answer. Its file: {shot}"
    words, pic = await on_the_api(conv, "view_check", {"picture": True})
    assert "The checks pass." in words["text"] and said in words["text"]
    assert pic == as_sent(shot.read_bytes())
    words, pic = await on_claude_code(monkeypatch, conv, "view_check", {"picture": True})
    assert "The checks pass." in words["text"] and said in words["text"]
    assert pic == as_handed(shot.read_bytes())
    [words] = await on_the_api(conv, "view_check", {})  # no picture asked for: the text alone, as before
    assert "The checks pass." in words["text"] and "picture" not in words["text"].split("\n", 1)[1]

    monkeypatch.setattr(runtime_tools, "PICTURE_EDGE", 20)
    words, pic = await on_the_api(conv, "view_check", {"picture": True})
    assert ("The picture of the page as it opens comes with this answer, scaled down to 20 x 15 px. "
            f"Its file: {shot}") in words["text"]
    assert Image.open(io.BytesIO(base64.b64decode(pic["source"]["data"]))).size == (20, 15)

    taken["png"] = shot.with_name("check-2-overview.png")
    [words] = await on_the_api(conv, "view_check", {"picture": True})
    assert f"The picture of the page as it opens did not load. Its file: {taken['png']}" in words["text"]


async def test_a_review_s_pictures_come_with_the_answer_in_the_order_its_text_lists_them(board, bridge, gates,
                                                                                         monkeypatch):
    """view_pictures listed the files of a review's pictures and said Read opens them. Now the pictures come with the
    answer after its text, in the order the text numbers their files, on the Messages API and in a session of Claude
    Code: a reviewer looks at the view in the answer itself."""
    slug = _propose(asked=True)
    builder = await _started(slug)
    _draft(slug)
    assert not (await _call("finish_view", {}, builder, view_tools.build_key(slug))).is_error
    started = await view_review.begin(BOARDS, slug, route=subagents.CLICK)
    assert started.started, dict(started)
    conv = conv_of(str(started.agent_id), view_tools.REVIEWER, view_tools.review_key(slug))

    async def shoot_states(c: str, slug: str, states: list[dict[str, Any]], **_kw: Any) -> list[dict[str, Any]]:
        for st in states:  # a page's picture at its pane's size, so each state's file differs
            Path(st["out"]).write_bytes(drawn(size=st["size"]))
        return [{"ok": True, "fonts": True, "errors": [], "fetches": 0, "png": str(st["out"])} for st in states]

    monkeypatch.setattr(views, "shoot_states", shoot_states)
    monkeypatch.setattr(headless, "missing", lambda kind: "")
    folder = view_review.work_dir(BOARDS, slug) / "review" / "1"

    def files() -> list[Path]:
        return sorted(folder.glob("picture-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))

    words, *pics = await on_the_api(conv, "view_pictures", {"states": [{"state": "narrow", "why": "the rows"}]})
    overview, narrow = files()
    assert [Image.open(p).size for p in (overview, narrow)] == [views.PANE_SIZE, views.PANE_NARROW]
    assert pics == [as_sent(overview.read_bytes()), as_sent(narrow.read_bytes())]
    lines = words["text"].splitlines()
    assert "The pictures come with this answer, in this order:" in lines
    assert [x.split(" (")[0] for x in lines if x[:1].isdigit()] == [f"1: {overview}", f"2: {narrow}"]

    words, *pics = await on_claude_code(monkeypatch, conv, "view_pictures", {"states": [{"state": "wide"}]})
    wide = files()[2]
    assert Image.open(wide).size == views.PANE_WIDE and pics == [as_handed(wide.read_bytes())]
    assert [x.split(" (")[0] for x in words["text"].splitlines() if x[:1].isdigit()] == [f"3: {wide}"]
