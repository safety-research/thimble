# The video as a video file: thimble renders the film this returns, each line spoken by an on-device voice or burned in
# as a caption, as an MP4 with ffmpeg, else a silent WebM.
import re

FORMATS = [{"id": "video", "name": "Video", "ext": "mp4"}]

MARKUP = re.compile(r"\[\[([^\[\]|]*)\|[^\[\]]*\]\]|\[\[[^\[\]]*\]\]")
BEFORE_PUNCT = re.compile(r"\s+([,;:!?)]|\.(?!\w))")


def spoken(sentence):
    """A sentence as the voice says it: each citation read as the text it shows, a bare ref left out."""
    text = " ".join(MARKUP.sub(lambda m: m.group(1) or "", str(sentence.get("text") or "")).split())
    return BEFORE_PUNCT.sub(r"\1", text)


def export(doc, fmt, ctx):
    timing = doc.get("timing") or {}
    at = {str(x.get("id")): x for x in timing.get("lines") or []}
    lines = []
    for line in doc.get("lines") or []:
        t = at.get(str(line.get("id")), {})
        text = " ".join(spoken(s) for s in line.get("sentences") or [] if isinstance(s, dict)).strip()
        lines.append({"start": t.get("start", 0), "end": t.get("end", 0), "text": text})
    return {"film": {"html": str(doc.get("film") or ""), "duration": timing.get("duration"), "lines": lines}}
