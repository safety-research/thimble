"""calls.py: an orientation call's output that Claude Code saved to a file is read only from the session's own
tool-results folder, and read_ref reads a call in pages that stay under Claude Code's caps on a tool result."""
from __future__ import annotations

import re
from typing import Any

import pytest

from app import calls, read_parts, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    calls.forget()
    yield
    calls.forget()


def test_only_a_file_in_the_session_s_own_tool_results_folder_is_read(tmp_path):
    """A result's text can say anything (a tool printed a file that starts with <persisted-output>), and a record's path
    is read only inside the tool-results folder of that record's session."""
    sid, other = "5e55a000-0000-4000-8000-000000000001", "5e55a000-0000-4000-8000-000000000002"
    slug = tmp_path / "projects" / "-corpus"
    for s in (sid, other):
        (slug / s / "tool-results").mkdir(parents=True)
        (slug / f"{s}.jsonl").write_text("")
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET")
    (slug / other / "tool-results" / "o.txt").write_text("SECRET")
    (slug / sid / "tool-results" / "link.txt").symlink_to(secret)
    (tmp_path / "loose" / sid / "tool-results").mkdir(parents=True)
    (tmp_path / "loose" / sid / "tool-results" / "x.txt").write_text("SECRET")
    preview = f"<persisted-output>\nOutput too large (1.9MB). Full output saved to: {secret}\n\nPreview (first 2KB):\n1"
    assert calls.result_text({"type": "tool_result", "content": preview}, {"sessionId": sid}) == preview
    for path in (secret, slug / other / "tool-results" / "o.txt", slug / sid / "tool-results" / "link.txt",
                 slug / sid / "tool-results" / ".." / ".." / other / "tool-results" / "o.txt",
                 tmp_path / "loose" / sid / "tool-results" / "x.txt", "tool-results/o.txt"):
        rec = {"sessionId": sid, "toolUseResult": {"persistedOutputPath": str(path)}}
        assert calls.result_text({"type": "tool_result", "content": "preview"}, rec) == "preview", path
    rec = {"sessionId": "../x", "toolUseResult": {"persistedOutputPath": str(secret)}}
    assert calls.result_text({"type": "tool_result", "content": "preview"}, rec) == "preview"


# --------------------------------------------------------------------------- read_ref of a call

PAGE_RE = re.compile(r"\[stopped at (?:line \d+|character [\d,]+ of [\d,]+ in line \d+); "
                     r"read_ref (call:\S+) reads on\]")


def _store(command: Any, output: str) -> str:
    calls.number(CORPUS, "o1", "toolu_1", "Bash", {"command": command})
    calls.result(CORPUS, "o1", "toolu_1", output)
    return "call:o1/1"


async def _read(ref: str) -> str:
    """read_ref's result for `ref` as the session reads it, its call line first, which stays within what Claude Code
    returns to the model whole."""
    r = await tools.call(CORPUS, "read_ref", {"ref": ref})
    assert not r.is_error and r.text.startswith('$ read_ref ref="'), r.text[:200]
    assert read_parts.units(r.text) <= read_parts.READ_UNITS, f"{ref}: {read_parts.units(r.text):,} code units"
    return r.text


def _page(text: str) -> tuple[int | None, int, list[tuple[int, str]], str | None]:
    """(the line a page starts inside of or None, the code unit it starts at, its (number, text) lines, the ref that
    reads on or None) of a read_ref result for a call."""
    _, _, body = text.partition("\noutput, ")
    lead, _, rest = body.partition("\n")
    inside = re.search(r", line (\d+) from character ([\d,]+):$", lead)
    rows, on = [], None
    for ln in rest.split("\n") if rest else []:
        if m := PAGE_RE.fullmatch(ln):
            on = m.group(1)
            continue
        num, tab, line = ln.partition("\t")
        assert tab and num.isdigit(), ln[:80]
        rows.append((int(num), line))
    return (int(inside.group(1)) if inside else None, int(inside.group(2).replace(",", "")) if inside else 0, rows, on)


async def test_read_ref_reads_a_line_longer_than_a_page_in_pieces_and_every_page_reads_on():
    """A line of a call's output longer than a page gave an empty page whose ref read on at that same line, so an agent
    read it again and again. read_ref now gives as much of the line as fits and names the code unit of the line where
    the next page starts, so paging from the call's ref reads its whole output, every line once and in order, each
    page within READ_UNITS code units wherever it starts (characters past U+FFFF count 2), with the pages of short
    lines as before."""
    long = "".join(f"{i:06d} 数字😀," for i in range(12_000))  # 132,000 characters, 144,000 code units
    lines = [f"row {i:04d} " + "." * 30 for i in range(2_000)] + [long, "after the long line", long[:30_000], "end"]
    ref = _store("python3 report.py", "\n".join(lines) + "\n")
    seen: dict[int, str] = {}
    refs = [ref]
    while ref:
        assert len(refs) < 60, refs[-3:]
        inside, at, rows, on = _page(await _read(ref))
        assert rows, f"{ref}: a page with no line"
        for num, line in rows:
            if num == inside and num == rows[0][0]:
                assert read_parts.units(seen.get(num, "")) == at, "the piece starts where the last one stopped"
                seen[num] = seen.get(num, "") + line
            else:
                assert num not in seen, f"line {num} twice"
                seen[num] = line
        assert on != ref, f"{ref} reads on at itself"
        ref = on
        if ref:
            refs.append(ref)
    assert [seen[i] for i in range(1, len(lines) + 1)] == lines and len(seen) == len(lines)
    assert any(":c" in r for r in refs) and any(re.search(r"#L\d+-L\d+$", r) for r in refs), "pieces and line pages"
    # a piece's ref with no end reads to the end of its line, and a line past the output's end reads as no lines
    at = read_parts.units(lines[-2][:25_000])
    text = await _read(f"call:o1/1#L{len(lines) - 1}:c{at}")
    assert _page(text) == (len(lines) - 1, at, [(len(lines) - 1, lines[-2][25_000:])], None)
    assert (await _read(f"call:o1/1#L{len(lines) + 5}")).endswith(f"output, {len(lines):,} lines:")
