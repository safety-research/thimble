"""Add the files the end-to-end test opens to a corpus copy (scripts/e2e_release.sh): chat logs outside any runs/ folder,
in Markdown and in CSV, which the File browser should offer as transcripts, a two-page PDF, which it should show as the
PDF itself, and a JSONL file with a line that is not JSON, which a view reading it should list. Everything is invented
here.

    python3 scripts/e2e/extra_files.py <corpus folder>
"""
import sys
from pathlib import Path

CHAT = [
    ("2026-03-02T09:14:05Z", "user", "The nightly export stopped writing rows after midnight. Can you look?"),
    ("2026-03-02T09:14:41Z", "assistant", "Checking the export job's log first, then the table it writes to."),
    ("2026-03-02T09:16:02Z", "user", "It used to write about 4,000 rows a night."),
    ("2026-03-02T09:17:30Z", "assistant", "The job ran, but its query filtered on yesterday's date in UTC+1, so it found no rows."),
    ("2026-03-02T09:18:12Z", "user", "Makes sense. Please fix the filter and rerun it."),
]


def markdown_log() -> str:
    lines = ["# Support chat, 2 March", ""]
    for ts, role, text in CHAT:
        lines += [f"**{role.title()}** ({ts}): {text}", ""]
    return "\n".join(lines)


def csv_log() -> str:
    rows = ["timestamp,role,content"]
    rows += [f'{ts},{role},"{text.replace(chr(34), chr(34) * 2)}"' for ts, role, text in CHAT]
    return "\n".join(rows) + "\n"


def pdf(pages: list[str]) -> bytes:
    """A minimal PDF, one line of Helvetica text per page."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in pages:
        stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream.decode()}\nendstream")
        content = len(objs)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
                    f"/Contents {content} 0 R >>")
        kids.append(len(objs))
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def main(root: Path) -> None:
    (root / "chatlogs").mkdir(parents=True, exist_ok=True)
    (root / "chatlogs" / "support-chat.md").write_text(markdown_log(), "utf-8")
    (root / "exports").mkdir(exist_ok=True)
    (root / "exports" / "chat-export.csv").write_text(csv_log(), "utf-8")
    (root / "exports" / "broken.jsonl").write_text('{"type": "note", "text": "fine"}\nnot json at all\n', "utf-8")
    (root / "docs").mkdir(exist_ok=True)
    (root / "docs" / "e2e-sample.pdf").write_bytes(pdf(["First page of the sample PDF", "Second page of the sample PDF"]))
    print(f"extra files: chatlogs/support-chat.md, exports/chat-export.csv, exports/broken.jsonl, docs/e2e-sample.pdf in {root}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
