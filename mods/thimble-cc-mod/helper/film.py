"""thimble-cc-mod's film renderer: a video report's frames, ANSI text drawn by hooks/film.ts, as an MP4.

    python film.py <film.json> <out.mp4>          (a Python with Playwright and its Chromium)
    python film.py --voice                        (prints the offline voice this machine has, or nothing)

film.json is {cols, rows, frames: [{ansi, ms, caption}], lines: [{start, end, text}]}. Each frame is drawn as terminal
cells (the cell renderer of the lab's ansi2png: DejaVu Sans Mono, half and eighth blocks as gradients) in one headless
Chromium page, with its caption in a band under the drawing, shot once as PNG; ffmpeg's concat demuxer holds each shot
for its ms and encodes H.264 (yuv420p, faststart). When the machine has an offline voice (espeak-ng, espeak,
pico2wave, piper with THIMBLE_PIPER_MODEL naming its model, or say), each line is spoken from its start and mixed in;
otherwise the captions carry the narration. Prints one JSON line: {file, seconds, frames, voice}.
"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

W, H = 1280, 720
CELL_W, CELL_H = 11, 22  # px per cell at 18px DejaVu Sans Mono
FONT_PX = 18
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT_SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BG, FG = "#0d1117", "#c9d1d9"
FPS = 25
VOICES = ("espeak-ng", "espeak", "pico2wave", "piper", "say")

# ---------------------------------------------------------------------------------------------- cells (from ansi2png)

BASE16 = ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
          "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"]
SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER = re.compile(r"\x1b(?:\[[0-9;?]*[A-La-ln-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Z0-9])")
EIGHTHS = {"▁": 1, "▂": 2, "▃": 3, "▄": 4, "▅": 5, "▆": 6, "▇": 7, "█": 8}


class Style:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.fg = self.bg = None
        self.bold = self.dim = self.italic = self.underline = self.inverse = False

    def apply(self, params: str) -> None:
        ps = re.split(r"[;:]", params) if params else ["0"]
        i = 0
        while i < len(ps):
            p = int(ps[i] or 0)
            if p == 0:
                self.reset()
            elif p in (1, 2, 3, 4, 7):
                setattr(self, {1: "bold", 2: "dim", 3: "italic", 4: "underline", 7: "inverse"}[p], True)
            elif p == 22:
                self.bold = self.dim = False
            elif 30 <= p <= 37:
                self.fg = BASE16[p - 30]
            elif 90 <= p <= 97:
                self.fg = BASE16[p - 82]
            elif p in (38, 48) and i + 4 < len(ps) and ps[i + 1] == "2":
                col = "#%02x%02x%02x" % tuple(int(x or 0) for x in ps[i + 2:i + 5])
                i += 4
                if p == 38:
                    self.fg = col
                else:
                    self.bg = col
            elif p == 39:
                self.fg = None
            elif p == 49:
                self.bg = None
            i += 1

    def colors(self) -> tuple[str, str]:
        fg, bg = self.fg or FG, self.bg or BG
        return (bg, fg) if self.inverse else (fg, bg)


def cell_html(ch: str, st: Style) -> str:
    fg, bg = st.colors()
    css = [f"background:{bg}"]
    if ch == "▀":
        css, ch = [f"background:linear-gradient(to bottom,{fg} 50%,{bg} 50%)"], " "
    elif ch in EIGHTHS:
        pct = EIGHTHS[ch] * 12.5
        css, ch = [f"background:linear-gradient(to top,{fg} {pct}%,{bg} {pct}%)"], " "
    else:
        css.append(f"color:{fg}")
    if st.bold:
        css.append("font-weight:bold")
    if st.dim:
        css.append("opacity:.62")
    if st.italic:
        css.append("font-style:italic")
    if st.underline:
        css.append("text-decoration:underline")
    cls = "c w" if unicodedata.east_asian_width(ch) in ("W", "F") else "c"
    return f'<span class="{cls}" style="{";".join(css)}">{html.escape(ch)}</span>'


def rows_html(text: str, rows: int) -> str:
    out = []
    st = Style()
    lines = (text.split("\n") + [""] * rows)[:rows]
    for raw in lines:
        line = OTHER.sub("", raw)
        parts = []
        pos = 0
        for m in SGR.finditer(line):
            parts.extend(cell_html(ch, st) for ch in line[pos:m.start()])
            st.apply(m.group(1))
            pos = m.end()
        parts.extend(cell_html(ch, st) for ch in line[pos:])
        out.append(f'<div class="l">{"".join(parts) or "&nbsp;"}</div>')
    return "".join(out)


def shell(cols: int, rows: int) -> str:
    left = max(0, (W - cols * CELL_W) // 2)
    band_top = 22 + rows * CELL_H + 14
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: Term; src: url(file://{FONT}); }}
@font-face {{ font-family: Term; font-weight: bold; src: url(file://{FONT_BOLD}); }}
@font-face {{ font-family: Sans; src: url(file://{FONT_SANS}); }}
html, body {{ margin: 0; width: {W}px; height: {H}px; overflow: hidden; background: {BG}; }}
#term {{ position: absolute; left: {left}px; top: 22px; font-family: Term, monospace; font-size: {FONT_PX}px; color: {FG};
         width: {cols * CELL_W}px; height: {rows * CELL_H}px; }}
.l {{ height: {CELL_H}px; white-space: pre; display: flex; }}
.c {{ display: inline-block; width: {CELL_W}px; height: {CELL_H}px; line-height: {CELL_H}px; text-align: center; overflow: visible; }}
.w {{ width: {2 * CELL_W}px; }}
#cap {{ position: absolute; left: 80px; right: 80px; top: {band_top}px; bottom: 10px; display: flex; align-items: center;
        justify-content: center; text-align: center; font: 23px/1.35 Sans, sans-serif; color: #f0f3f6; overflow: hidden; }}
</style></head><body><div id="term"></div><div id="cap"></div></body></html>"""


# ---------------------------------------------------------------------------------------------- voice


def voice() -> str | None:
    """The first offline voice on this machine, or None."""
    for name in VOICES:
        if name == "piper" and not os.environ.get("THIMBLE_PIPER_MODEL"):
            continue
        if shutil.which(name):
            return name
    return None


def speak(tool: str, text: str, out: Path) -> bool:
    """`text` spoken by `tool` into the WAV file `out`; False when it fails."""
    if tool in ("espeak-ng", "espeak"):
        argv, stdin = [tool, "-s", "165", "-w", str(out), text], None
    elif tool == "pico2wave":
        argv, stdin = [tool, "-l", "en-US", "-w", str(out), text], None
    elif tool == "piper":
        argv, stdin = [tool, "--model", os.environ["THIMBLE_PIPER_MODEL"], "--output_file", str(out)], text
    else:  # say writes AIFF; ffmpeg reads it by its content whatever the name
        argv, stdin = [tool, "-o", str(out.with_suffix(".aiff")), text], None
    try:
        subprocess.run(argv, input=stdin, text=True, capture_output=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError):
        return False
    if tool == "say":
        out.with_suffix(".aiff").rename(out)
    return out.exists() and out.stat().st_size > 0


def narration(lines: list[dict], tool: str, tmp: Path) -> tuple[list[str], str] | None:
    """ffmpeg inputs and a filter that mixes each spoken line in at its start, or None when no line could be spoken."""
    inputs: list[str] = []
    parts: list[str] = []
    for i, ln in enumerate(lines):
        text = str(ln.get("text") or "").strip()
        wav = tmp / f"line{i:03d}.wav"
        if not text or not speak(tool, text, wav):
            continue
        k = len(inputs) // 2 + 1
        inputs += ["-i", str(wav)]
        ms = int(float(ln.get("start") or 0) * 1000)
        parts.append(f"[{k}:a]adelay={ms}|{ms},aformat=channel_layouts=mono[a{k}]")
    if not parts:
        return None
    n = len(parts)
    mix = "".join(f"[a{k}]" for k in range(1, n + 1))
    return inputs, ";".join(parts) + f";{mix}amix=inputs={n}:normalize=0:dropout_transition=0[aout]"


# ---------------------------------------------------------------------------------------------- the film


def concat_list(shots: list[tuple[str, int]]) -> str:
    """ffmpeg's concat demuxer list: each shot held for its ms, the last named again so its duration counts."""
    out = ["ffconcat version 1.0"]
    for path, ms in shots:
        out += [f"file '{path}'", f"duration {max(ms, 1) / 1000:.3f}"]
    if shots:
        out.append(f"file '{shots[-1][0]}'")
    return "\n".join(out) + "\n"


def render(film: dict, out: Path) -> dict:
    cols, rows = int(film.get("cols") or 112), int(film.get("rows") or 26)
    frames = [f for f in film.get("frames") or [] if isinstance(f, dict)]
    if not frames:
        raise SystemExit("film.py: the film has no frames")
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="thimble-film-") as d:
        tmp = Path(d)
        page_path = tmp / "shell.html"
        page_path.write_text(shell(cols, rows), "utf-8")
        shots: list[tuple[str, int]] = []
        with sync_playwright() as p:
            b = p.chromium.launch()
            try:
                pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
                pg.goto(f"file://{page_path}")
                pg.evaluate(f"Promise.all([document.fonts.load('{FONT_PX}px Term'), document.fonts.load('bold {FONT_PX}px Term'), document.fonts.load('23px Sans')])")
                for i, f in enumerate(frames):
                    pg.evaluate("([rows, cap]) => { document.getElementById('term').innerHTML = rows; document.getElementById('cap').textContent = cap }",
                                [rows_html(str(f.get("ansi") or ""), rows), str(f.get("caption") or "")])
                    shot = tmp / f"f{i:05d}.png"
                    pg.screenshot(path=str(shot), clip={"x": 0, "y": 0, "width": W, "height": H})
                    shots.append((shot.name, int(f.get("ms") or 0)))
            finally:
                b.close()
        (tmp / "list.txt").write_text(concat_list(shots), "utf-8")
        seconds = sum(ms for _, ms in shots) / 1000
        tool = voice()
        mix = narration(list(film.get("lines") or []), tool, tmp) if tool else None
        argv = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt")]
        if mix:
            argv += mix[0] + ["-filter_complex", mix[1], "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]
        argv += ["-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                 "-movflags", "+faststart", "-t", f"{seconds:.2f}", str(out)]
        r = subprocess.run(argv, cwd=tmp, capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"film.py: ffmpeg failed: {r.stderr.strip()[-400:]}")
    return {"file": str(out), "seconds": round(seconds, 1), "frames": len(shots), "voice": tool if mix else None}


def main() -> int:
    if sys.argv[1:] == ["--voice"]:
        print(voice() or "")
        return 0
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    film = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    out = Path(sys.argv[2]).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps(render(film, out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
