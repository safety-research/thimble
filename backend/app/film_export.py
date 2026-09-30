"""A video document exported: the film as a video file, as a self-contained HTML player, and as a PDF of one frame per
line.

The video file: the film's page is loaded headless at 1280x720, drawn at each frame's time with `window.seek(t)` and
shot, and the frames are encoded by ffmpeg. The system's ffmpeg writes an MP4 (H.264 when it has libx264); without one,
Playwright's own ffmpeg writes a WebM, which cannot carry sound. The narration is spoken by an on-device voice (`say`,
`espeak-ng`, `espeak`, or `piper` with THIMBLE_PIPER_MODEL naming its voice) when there is one and the encoder can carry
sound; otherwise each line is burned in as a caption, in a band under the film, which is drawn smaller above it so the
caption covers none of it (CAPTION_PAGE).
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import html
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import wave
from functools import lru_cache
from pathlib import Path
from typing import Any

log = logging.getLogger("thimble.film_export")

FPS = 15
W, H = 1280, 720
JPEG_QUALITY = 88
READY_WAIT_MS = 8000
FRAMES_MAX = FPS * 60 * 10  # ten minutes
VOICES = ("say", "espeak-ng", "espeak", "piper")

BAND = 112  # px under the film that a burned-in caption takes, three lines of it
_K = (H - BAND) / H
# The frame of a video with burned-in captions: the film at its own 1280x720 in a frame scaled down to fit above the
# band, the caption in the band.
CAPTION_PAGE = f"""<!doctype html><html><head><meta charset="utf-8"><style>\0FACES\0
html,body{{margin:0;width:{W}px;height:{H}px;overflow:hidden;background:#1b1a18}}
#film{{position:absolute;left:{(W - W * _K) / 2:.1f}px;top:0;width:{W}px;height:{H}px;border:0;transform:scale({_K:.5f});
transform-origin:0 0}}
#thimble-cap{{position:absolute;left:0;right:0;bottom:0;height:{BAND}px;box-sizing:border-box;padding:0 64px;display:flex;
align-items:center;justify-content:center;overflow:hidden;color:#fffdf8;font:500 22px/1.3 'Hanken Grotesk',sans-serif;text-align:center}}
</style></head><body><iframe id="film" srcdoc="\0FILM\0"></iframe><div id="thimble-cap"></div><script>window.__capLines = \0LINES\0;
window.__cap = (t) => {{ const L = window.__capLines; const k = L.findIndex((x) => x.start <= t && t < x.end + 0.3);
  document.getElementById('thimble-cap').textContent = k < 0 ? '' : L[k].text }}</script></body></html>"""


# --------------------------------------------------------------------------- tools on this machine


@lru_cache(maxsize=1)
def _system_ffmpeg() -> tuple[str, bool] | None:
    """(path, has libx264) of the system's ffmpeg, or None."""
    path = shutil.which("ffmpeg")
    if not path:
        return None
    try:
        enc = subprocess.run([path, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return path, "libx264" in enc


def _playwright_ffmpeg() -> str | None:
    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / ".cache" / "ms-playwright")
    for p in sorted(root.glob("ffmpeg-*/ffmpeg*"), reverse=True):
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


def encoder() -> tuple[str, str] | None:
    """(the file's extension, the ffmpeg that writes it): mp4 by the system's ffmpeg, else webm by Playwright's."""
    sys_ff = _system_ffmpeg()
    if sys_ff:
        return "mp4", sys_ff[0]
    pw = _playwright_ffmpeg()
    return ("webm", pw) if pw else None


def voice() -> str | None:
    """The on-device speech tool the narration uses, or None."""
    for name in VOICES:
        if name == "piper" and not os.environ.get("THIMBLE_PIPER_MODEL"):
            continue
        if shutil.which(name):
            return name
    return None


def _speak_argv(tool: str, text: str, out: Path) -> tuple[list[str], str | None]:
    """(argv, stdin text) that write `text` spoken to the WAV file `out`."""
    exe = shutil.which(tool) or tool
    if tool == "say":
        return [exe, "--data-format=LEI16@22050", "-o", str(out), text], None
    if tool == "piper":
        return [exe, "--model", os.environ.get("THIMBLE_PIPER_MODEL", ""), "--output_file", str(out)], text
    return [exe, "-w", str(out), text], None


async def narration(lines: list[dict[str, Any]], duration: float, tool: str, folder: Path) -> Path | None:
    """One WAV track of the film's length with each line spoken from its start (after the previous one when that
    overruns); None when the voice fails."""
    clips: list[tuple[float, Path]] = []
    for i, ln in enumerate(lines):
        text = str(ln.get("spoken") or ln.get("text") or "").strip()
        if not text:
            continue
        out = folder / f"line{i}.wav"
        argv, stdin = _speak_argv(tool, text, out)
        proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE if stdin else asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err = await proc.communicate(stdin.encode("utf-8") if stdin else None)
        if proc.returncode != 0 or not out.is_file():
            log.warning("video export: %s failed on line %d: %s", tool, i + 1, err.decode("utf-8", "replace")[:300])
            return None
        clips.append((float(ln.get("start") or 0), out))
    return mix(clips, duration, folder / "narration.wav") if clips else None


def mix(clips: list[tuple[float, Path]], duration: float, out: Path) -> Path:
    """The clips laid on one track at their start times, each after the previous one's end, padded to `duration`."""
    params = None
    track = bytearray()
    for start, path in clips:
        with wave.open(str(path), "rb") as w:
            if params is None:
                params = w.getparams()
            elif (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (params.nchannels, params.sampwidth, params.framerate):
                continue
            frames = w.readframes(w.getnframes())
        frame_bytes = params.nchannels * params.sampwidth
        at = max(int(start * params.framerate) * frame_bytes, len(track))
        track.extend(b"\0" * (at - len(track)))
        track.extend(frames)
    assert params is not None
    frame_bytes = params.nchannels * params.sampwidth
    end = int(duration * params.framerate) * frame_bytes
    track.extend(b"\0" * max(0, end - len(track)))
    with wave.open(str(out), "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(bytes(track))
    return out


def ffmpeg_argv(ext: str, ffmpeg: str, out: Path, audio: Path | None) -> list[str]:
    """The ffmpeg command that reads JPEG frames on stdin and writes the video file."""
    argv = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS),
            "-c:v", "mjpeg", "-i", "pipe:0"]
    if ext == "webm":
        return argv + ["-c:v", "libvpx", "-b:v", "2M", "-crf", "8", "-qmin", "0", "-qmax", "40", "-deadline", "realtime",
                       "-cpu-used", "8", "-pix_fmt", "yuv420p", str(out)]
    if audio is not None:
        argv += ["-i", str(audio)]
    x264 = (_system_ffmpeg() or ("", False))[1]
    argv += (["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"] if x264 else ["-c:v", "mpeg4", "-q:v", "3"])
    argv += ["-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if audio is not None:
        argv += ["-c:a", "aac", "-b:a", "128k", "-shortest"]
    return argv + [str(out)]


# --------------------------------------------------------------------------- the film's page


def with_head(page: str, extra: str) -> str:
    """`extra` put at the start of the page's head."""
    if re.search(r"<head[^>]*>", page, re.I):
        return re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + extra, page, count=1, flags=re.I)
    return "<!doctype html><head>" + extra + "</head>" + page


def film_page(film_html: str, duration: float, lines: list[dict[str, Any]]) -> str:
    """A hook's film as video.film_document makes a video's: the frames' policy, `window.timing` and the bridge."""
    from . import video, views  # noqa: PLC0415

    data = json.dumps({"duration": duration, "lines": [{"start": x["start"], "end": x["end"]} for x in lines]}).replace("<", "\\u003c")
    head = (f'<meta http-equiv="Content-Security-Policy" content="{views.FRAME_CSP.format(media="")}"><meta charset="utf-8">'
            f"<script>window.timing = {data}</script><script>{views._script_text(video.BRIDGE_JS.read_text('utf-8'))}</script>")
    body = re.sub(r"^\s*<!doctype[^>]*>", "", film_html, count=1, flags=re.I)
    return "<!doctype html><head>" + head + "</head>" + body


async def _ready(film: Any) -> str:
    """'' once the film's window.ready settled and its faces loaded, else what is wrong. `film` is the page or frame the
    film runs in."""
    return str(await film.evaluate(
        """async (wait) => { const t0 = Date.now(); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        while (!window.ready && Date.now() - t0 < wait) await sleep(50);
        try { if (window.ready) await Promise.race([Promise.resolve(window.ready), sleep(wait)]) } catch (e) { return 'window.ready failed: ' + e }
        await document.fonts.ready; await document.fonts.load('16px "Hanken Grotesk"').catch(() => []);
        if (typeof window.seek !== 'function') return 'the film sets no window.seek function';
        return document.fonts.check('16px "Hanken Grotesk"') ? '' : 'fonts' }""", READY_WAIT_MS))


async def _open(page: Any, v: dict[str, Any], faces: str, captions: bool) -> Any:
    """The film loaded in `page`, with its captions under it when `captions` (CAPTION_PAGE); the page or frame the film
    runs in."""
    doc = with_head(v["film_page"], f"<style>{faces}</style>")
    if captions:
        cap = json.dumps([{"start": x["start"], "end": x["end"], "text": x["text"]} for x in v["lines"]]).replace("<", "\\u003c")
        parts = {"FACES": faces, "FILM": html.escape(doc, quote=True), "LINES": cap}
        doc = re.sub("\0(FACES|FILM|LINES)\0", lambda m: parts[m.group(1)], CAPTION_PAGE)
    await page.set_content(doc, wait_until="load")
    film = page.frames[1] if captions and len(page.frames) > 1 else page
    why = await _ready(film)
    if why == "fonts":
        log.warning("video export: Hanken Grotesk did not load; the film is drawn in a fallback face")
    elif why:
        raise RuntimeError(why)
    return film


async def _shot(page: Any, film: Any, t: float, *, kind: str = "jpeg") -> bytes:
    await film.evaluate("(t) => window.seek(t)", t)
    await page.evaluate("(t) => { if (window.__cap) window.__cap(t) }", t)
    opts: dict[str, Any] = {"type": kind, "clip": {"x": 0, "y": 0, "width": W, "height": H}, "animations": "disabled"}
    if kind == "jpeg":
        opts["quality"] = JPEG_QUALITY
    return await page.screenshot(**opts)


async def render(v: dict[str, Any], *, faces: str, narrate: bool) -> tuple[bytes, str]:
    """(the video file, its extension) of `v` ({film_page, duration, lines [{start, end, text, spoken}]}).
    RuntimeError with what is missing."""
    from .exports import browser_page  # noqa: PLC0415

    enc = encoder()
    if enc is None:
        raise RuntimeError("no ffmpeg: install ffmpeg to export video")
    ext, ffmpeg = enc
    tool = voice() if narrate and ext == "mp4" else None
    n = min(FRAMES_MAX, max(1, int(round(float(v["duration"]) * FPS))))
    with tempfile.TemporaryDirectory(prefix="thimble-video-") as d:
        folder = Path(d)
        audio = await narration(v["lines"], float(v["duration"]), tool, folder) if tool else None
        out = folder / f"film.{ext}"
        proc = await asyncio.create_subprocess_exec(*ffmpeg_argv(ext, ffmpeg, out, audio), stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        assert proc.stdin is not None
        try:
            async with browser_page(W, H) as page:
                film = await _open(page, v, faces, captions=audio is None)
                for i in range(n):
                    proc.stdin.write(await _shot(page, film, i / FPS))
                    await proc.stdin.drain()
        except (ConnectionError, RuntimeError) as e:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            err = await proc.stderr.read() if proc.stderr else b""
            await proc.wait()
            raise RuntimeError(f"ffmpeg failed: {err.decode('utf-8', 'replace')[-400:]}" if err else str(e)) from e
        except BaseException:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            raise
        proc.stdin.close()
        _, err = await proc.communicate()
        if proc.returncode != 0 or not out.is_file():
            raise RuntimeError(f"ffmpeg failed: {err.decode('utf-8', 'replace')[-400:]}")
        log.info("video export: %d frames, %s, %s", n, ext, f"narrated by {tool}" if audio else "captions")
        return out.read_bytes(), ext


def _video_of(m: dict[str, Any]) -> dict[str, Any]:
    return {"film_page": m["film_page"], "duration": m["duration"], "lines": m["lines"]}


async def render_video(m: dict[str, Any], *, voice: bool = True) -> tuple[bytes, str]:
    from .exports import font_faces  # noqa: PLC0415
    from fastapi import HTTPException  # noqa: PLC0415

    try:
        return await render(_video_of(m), faces=font_faces(), narrate=voice)
    except RuntimeError as e:
        raise HTTPException(409, f"The video could not be made: {e}") from e


async def render_film(film: dict[str, Any], *, faces: str) -> tuple[bytes, str]:
    """A hook's film, {html, duration, lines [{start, end, text}]}, as a video file."""
    from fastapi import HTTPException  # noqa: PLC0415

    lines = [{"start": float(x.get("start") or 0), "end": float(x.get("end") or 0), "text": str(x.get("text") or "")}
             for x in film.get("lines") or [] if isinstance(x, dict)]
    duration = float(film.get("duration") or (max((x["end"] for x in lines), default=0) + 1))
    v = {"film_page": film_page(str(film.get("html") or ""), duration, lines), "duration": duration, "lines": lines}
    try:
        return await render(v, faces=faces, narrate=True)
    except RuntimeError as e:
        raise HTTPException(409, f"The video could not be made: {e}") from e


async def frames_pdf(m: dict[str, Any]) -> bytes:
    """A PDF of one 16:9 page per line: the film's frame at the line's middle, the line and its citations under it."""
    from fastapi import HTTPException  # noqa: PLC0415

    from .exports import BASE_CSS, _cites_html, _document, _esc, _notes_html, font_faces, inline_html, print_pdf, browser_page  # noqa: PLC0415

    faces = font_faces()
    shots: list[str] = []
    try:
        async with browser_page(W, H) as page:
            film = await _open(page, _video_of(m), faces, captions=False)
            for ln in m["lines"]:
                png = await _shot(page, film, (ln["start"] + ln["end"]) / 2, kind="png")
                shots.append(base64.b64encode(png).decode("ascii"))
    except RuntimeError as e:
        raise HTTPException(409, f"PDF needs a browser: {e}") from e
    css = BASE_CSS + """@page{size:13.333in 7.5in;margin:0}main{max-width:none;padding:0}
.frame{height:7.5in;padding:.35in .6in;display:flex;flex-direction:column;gap:.18in;break-after:page}
.frame img{height:5.6in;width:auto;align-self:center;border-radius:8px;box-shadow:0 0 0 1px rgba(var(--ink-rgb),.1)}
.frame p{font-size:17px;margin:0}.frame .t{font-family:var(--font-mono);font-size:12px;color:var(--ink-500)}
.notes{padding:.5in .8in;margin:0;border:0}h1{padding:.5in .6in 0}"""
    pages = [f'<section class="frame"><img alt="" src="data:image/png;base64,{s}"><div class="t">{_clock(ln["start"])}</div>'
             f'<p>{inline_html(ln["text"])}{_cites_html(ln["notes"])}</p></section>' for s, ln in zip(shots, m["lines"])]
    html_text = _document(m["title"], faces, css, f"<main>{''.join(pages)}{_notes_html(m)}</main>")
    try:
        return await print_pdf(html_text, "slides")
    except RuntimeError as e:
        raise HTTPException(409, f"PDF needs a browser: {e}") from e


def _clock(t: float) -> str:
    s = int(max(0.0, float(t or 0)))
    return f"{s // 60}:{s % 60:02d}"


# --------------------------------------------------------------------------- the HTML player


PLAYER_CSS = """
main{max-width:1000px}
.stage{position:relative;width:100%;aspect-ratio:16/9;background:var(--paper-1);border-radius:12px;overflow:hidden}
.stage iframe{position:absolute;left:0;top:0;width:1280px;height:720px;border:0;transform-origin:0 0}
.cap{min-height:3.2em;margin:12px 0 0;font-size:18px;text-align:center}
.bar{display:flex;align-items:center;gap:12px;margin:12px 0 28px;font-size:13px;color:var(--ink-500)}
.bar button{font:inherit;font-weight:500;color:var(--ink-900);background:var(--white);border:0;border-radius:8px;
padding:6px 14px;box-shadow:0 0 0 1px rgba(var(--ink-rgb),.14);cursor:pointer}
.bar input[type=range]{flex:1;accent-color:var(--ink-900)}
.bar label{display:flex;align-items:center;gap:6px}
.script p{display:flex;gap:14px}.script .t{font-family:var(--font-mono);font-size:12px;color:var(--ink-500);min-width:44px;padding-top:3px}
.script p.on{font-weight:500}
"""

PLAYER_JS = """
(() => {
  const L = LINES, D = DURATION
  const frame = document.getElementById('film'), stage = frame.parentElement
  const bar = document.getElementById('seek'), time = document.getElementById('time'), btn = document.getElementById('play')
  const cap = document.getElementById('cap'), voiceBox = document.getElementById('voice')
  const rows = [...document.querySelectorAll('.script p')]
  const fit = () => { frame.style.transform = `scale(${stage.clientWidth / 1280})` }
  addEventListener('resize', fit); fit()
  const synth = window.speechSynthesis
  if (!synth) voiceBox.parentElement.hidden = true
  let t = 0, playing = false, last = null, spoken = -1
  const clock = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`
  const lineAt = (x) => L.findIndex((l) => l.start <= x && x < l.end + 0.3)
  const draw = () => {
    frame.contentWindow.postMessage({ type: 'thimble:seek', t }, '*')
    bar.value = String(t); time.textContent = `${clock(t)} / ${clock(D)}`
    const k = lineAt(t); cap.textContent = k < 0 ? '' : L[k].text
    rows.forEach((r, i) => r.classList.toggle('on', i === k))
    if (playing && synth && voiceBox.checked && k >= 0 && k !== spoken) {
      spoken = k; synth.cancel(); synth.speak(new SpeechSynthesisUtterance(L[k].spoken))
    }
  }
  const tick = (now) => {
    if (!playing) return
    if (last != null) t = Math.min(D, t + (now - last) / 1000)
    last = now; draw()
    if (t >= D) { stop(); return }
    requestAnimationFrame(tick)
  }
  const stop = () => { playing = false; last = null; btn.textContent = 'Play'; if (synth) synth.cancel(); spoken = -1 }
  btn.onclick = () => { if (playing) return stop(); if (t >= D) t = 0; playing = true; btn.textContent = 'Pause'; requestAnimationFrame(tick) }
  bar.oninput = () => { t = Number(bar.value); spoken = -1; if (synth) synth.cancel(); draw() }
  addEventListener('message', (e) => { if (e.source === frame.contentWindow && e.data && e.data.type === 'thimble:ready') draw() })
})()
"""


def player_html(m: dict[str, Any], faces: str) -> str:
    """The video as one HTML file: the film in a sandboxed frame, played with captions and this browser's voice, then
    the script with its citations."""
    from .exports import BASE_CSS, _cites_html, _document, _esc, _notes_html, inline_html  # noqa: PLC0415

    film = with_head(m["film_page"], f"<style>{faces}</style>")
    lines = json.dumps([{"start": x["start"], "end": x["end"], "text": x["text"], "spoken": x["spoken"]} for x in m["lines"]])
    script = "".join(f'<p><span class="t">{_clock(x["start"])}</span><span>{inline_html(x["text"])}{_cites_html(x["notes"])}</span></p>'
                     for x in m["lines"])
    js = PLAYER_JS.replace("LINES", lines.replace("<", "\\u003c")).replace("DURATION", json.dumps(m["duration"]))
    body = (f"<main><h1>{inline_html(m['title'])}</h1>"
            f'<div class="stage"><iframe id="film" title="Film" sandbox="allow-scripts" srcdoc="{_esc(film)}"></iframe></div>'
            f'<p class="cap" id="cap" aria-live="polite"></p>'
            f'<div class="bar"><button id="play" type="button">Play</button><input id="seek" type="range" min="0" '
            f'max="{m["duration"]}" step="0.05" value="0" aria-label="Time"><span id="time"></span>'
            f'<label><input id="voice" type="checkbox" checked> Voice</label></div>'
            f'<section class="script">{script}</section>{_notes_html(m)}</main><script>{js}</script>')
    return _document(m["title"], faces, BASE_CSS + PLAYER_CSS, body)
