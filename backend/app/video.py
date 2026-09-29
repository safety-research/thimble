"""The video: a narrated film over the workspace's findings.

A video document is {id, type, renderer: video, title, lines, film}: each line {id, sentences, pause_after?} is what
the voice says, one or two cited sentences checked as any document's are, and the film is one HTML page at 1280x720
that draws the frame at t seconds with `window.seek(t)`. When each line starts and ends is estimated from the words it
speaks (timing) and reaches the film as `window.timing` (film_document). The browser plays the film in a sandboxed frame
under the views' policy while its speech synthesis reads the lines (frontend/src/report/Video.tsx); the writer looks at
frames with `screenshot` (tool_screenshot), shot by the views' headless page (views.shoot_page)."""
from __future__ import annotations

import base64
import json
import re
import tempfile
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .report import _collapse, _new_id, plain_text

FILM_W, FILM_H = 1280, 720
LEAD_S = 0.5  # before the first line
TAIL_S = 1.0  # after the last line and its pause
LINE_BASE_S = 1.4
WORDS_PER_S = 2.5
LINE_MIN_S = 4.5
PAUSE_MAX_S = 5.0
FRAMES_MAX = 6  # frames one screenshot call returns
FILM_MAX = 2_000_000
BRIDGE_JS = Path(__file__).with_name("film_bridge.js")
# a line's closing `(pause 0.8)`: the seconds of silence after it
_PAUSE_RE = re.compile(r"\s*\(\s*pause\s+(\d+(?:\.\d+)?)\s*s?\s*\)\s*$", re.I)


def lines_of(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [u for u in doc.get("lines") or [] if isinstance(u, dict)]


def spoken(line: dict[str, Any]) -> str:
    """What the voice says for a line: its sentences with each citation read as the text it shows."""
    return " ".join(plain_text(str(x.get("text") or "")) for x in line.get("sentences") or [] if isinstance(x, dict)).strip()


def seconds(words: int) -> float:
    """A line's estimated length from the words it speaks."""
    return max(LINE_MIN_S, round(LINE_BASE_S + words / WORDS_PER_S, 1))


def _pause(line: dict[str, Any]) -> float:
    try:
        return min(PAUSE_MAX_S, max(0.0, float(line.get("pause_after") or 0)))
    except (TypeError, ValueError):
        return 0.0


def timing(doc: dict[str, Any]) -> dict[str, Any]:
    """{duration, lines: [{id, start, end}]} in seconds, the lines in script order, each after the previous one's end
    and pause."""
    t = LEAD_S
    out = []
    for u in lines_of(doc):
        end = t + seconds(len(spoken(u).split()))
        out.append({"id": str(u.get("id") or ""), "start": round(t, 2), "end": round(end, 2)})
        t = end + _pause(u)
    return {"duration": round(t + TAIL_S, 2), "lines": out}


def parse(title: str, said: list[str], film: str, changed: list[str]) -> dict[str, Any]:
    """{title, lines: [{say, pause_after}], film, what_changed} from the markdown as report_types.parse_markdown reads
    it: each paragraph a line, a closing `(pause 0.8)` taken off as its pause, and a `What changed` section's lines apart."""
    lines = []
    for say in said:
        m = _PAUSE_RE.search(say)
        lines.append({"say": say[: m.start()] if m else say, "pause_after": float(m.group(1)) if m else 0.0})
    return {"title": title or "", "lines": lines, "film": film or "", "what_changed": changed}


def normalize(t: dict[str, Any], raw: dict[str, Any], valid: Any) -> dict[str, Any]:
    """The stored video from parse's shape: each line's text as sentence records. 400 without a film or a line."""
    from . import report_format  # noqa: PLC0415

    film = str(raw.get("film") or "").strip()
    if not film:
        raise HTTPException(400, "the video has no ```html block, the film")
    if len(film) > FILM_MAX:
        raise HTTPException(400, f"the film is longer than {FILM_MAX} characters")
    used: set[str] = set()
    lines = []
    for ln in raw.get("lines") or []:
        sentences = report_format.sentence_units(str(ln.get("say") or ""), valid, used)
        for x in sentences:
            x.pop("bullet", None)
        if not sentences:
            continue
        rec: dict[str, Any] = {"id": _new_id(used), "sentences": sentences}
        pause = min(PAUSE_MAX_S, float(ln.get("pause_after") or 0))
        if pause > 0:
            rec["pause_after"] = pause
        lines.append(rec)
    if not lines:
        raise HTTPException(400, "the video has no line of narration")
    return {"id": t["slug"], "type": t["slug"], "renderer": "video", "title": _collapse(raw.get("title")) or t.get("name") or t["slug"],
            "lines": lines, "film": film}


def document_lines(doc: dict[str, Any], sentence_lines: Any, cut: int) -> list[str]:
    """The lines with their ids and windows, then the film, as read_ref gives a video (report_types.document_lines)."""
    tm = {x["id"]: x for x in timing(doc)["lines"]}
    out: list[str] = []
    for n, u in enumerate(lines_of(doc), 1):
        w = tm.get(str(u.get("id")), {})
        out += ["", f"line {n} · #{u.get('id')} · {w.get('start', 0):g}–{w.get('end', 0):g} s"
                + (f" · pause {_pause(u):g}" if _pause(u) else "")]
        out += sentence_lines(u.get("sentences") or [], "  ")
    film = str(doc.get("film") or "")
    if film:
        out += ["", f"film · {FILM_W}×{FILM_H} · {timing(doc)['duration']:g} s", "```html",
                film[:cut] + ("\n… (cut)" if len(film) > cut else ""), "```"]
    return out


def film_document(doc: dict[str, Any]) -> str:
    """The film's page as its frame loads it: the views' policy, which lets it load nothing, the timing as
    `window.timing` ({duration, lines: [{start, end}]}), the bridge (film_bridge.js), then the film."""
    from . import views  # noqa: PLC0415

    tm = timing(doc)
    data = json.dumps({"duration": tm["duration"], "lines": [{"start": x["start"], "end": x["end"]} for x in tm["lines"]]})
    data = data.replace("<", "\\u003c")
    head = [f'<meta http-equiv="Content-Security-Policy" content="{views.FRAME_CSP.format(media="")}">',
            '<meta charset="utf-8">',
            f"<script>window.timing = {data}</script>",
            f"<script>{views._script_text(BRIDGE_JS.read_text('utf-8'))}</script>"]
    body = re.sub(r"^\s*<!doctype[^>]*>", "", str(doc.get("film") or ""), count=1, flags=re.I)
    return "<!doctype html><head>" + "".join(head) + "</head>" + body


def _times(raw: Any, tm: dict[str, Any]) -> list[float]:
    """The seconds to shoot: those asked for, else the middles of the lines spread over FRAMES_MAX, each within the
    film, at most FRAMES_MAX. ValueError for a value that is no number."""
    if raw is None or raw == []:
        mids = [(x["start"] + x["end"]) / 2 for x in tm["lines"]]
        step = max(1, -(-len(mids) // FRAMES_MAX))
        asked = mids[::step]
    else:
        asked = [float(v) for v in (raw if isinstance(raw, list) else [raw])]
    out: list[float] = []
    for v in asked:
        v = round(min(max(v, 0.0), tm["duration"]), 2)
        if v not in out:
            out.append(v)
    return out[:FRAMES_MAX]


async def _no_records(kind: str, i: int, msg: dict[str, Any]) -> dict[str, Any]:
    """The film's page asks for nothing: a marks request (the headless page's first) has none, anything else fails."""
    return {"marks": {}, "on": [], "filter": None} if kind == "marks" else {"error": "a film loads no records or files"}


async def tool_screenshot(ctx: Any, slug: str, doc: dict[str, Any], args: dict[str, Any]) -> Any:
    """`screenshot` of `report:<slug>` for a video: the film's frames at the seconds `t` names, each a picture, with
    what the film reported (script errors, a missing window.ready or window.seek)."""
    from . import tools, views  # noqa: PLC0415

    tm = timing(doc)
    try:
        times = _times(args.get("t"), tm)
    except (TypeError, ValueError):
        return tools.err("screenshot: `t` must be a list of seconds, such as [2, 12.5]")
    if not doc.get("film") or not times:
        return tools.err(tools.hint("screenshot-none", what=f"report:{slug} has no film yet") or f"screenshot: report:{slug} has no film")
    with tempfile.TemporaryDirectory(prefix="thimble-film-") as d:
        states = [{"out": Path(d) / f"t{i}.png", "open": {"t": t}} for i, t in enumerate(times)]
        shots = await views.shoot_page(film_document(doc), states, _no_records, width=FILM_W, height=FILM_H)
        blocks: list[dict[str, Any]] = []
        for t, r in zip(times, shots):
            k = next((n for n, x in enumerate(tm["lines"], 1) if x["start"] <= t < x["end"]), None)
            blocks.append({"type": "text", "text": f"{t:g} s" + (f", line {k}" if k else "")})
            if r.get("png"):
                blocks.append({"type": "image", "data": base64.b64encode(Path(r["png"]).read_bytes()).decode("ascii"),
                               "mimeType": "image/png"})
    errors = sorted({str(e) for r in shots for e in r.get("errors") or []})
    head = tools.hint("screenshot-frames", ref=f"report:{slug}", duration=f"{tm['duration']:g}",
                      windows=", ".join(f"{x['start']:g}–{x['end']:g}" for x in tm["lines"]))
    if errors:
        head += "\n" + tools.hint("screenshot-frames-errors", errors="; ".join(errors[:8]))
    return tools.ToolResult([{"type": "text", "text": head}, *blocks])
