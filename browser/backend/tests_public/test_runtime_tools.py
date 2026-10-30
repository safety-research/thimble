"""The built-in tools of an agent the server runs on the Messages API (runtime_tools.py): Read and Grep number a file's
lines as the citation check does (the terminal's validator, plugin/engine/kernel/evidence.py read_lines), so a line
either names is the line a citation of it names."""
from __future__ import annotations

import json

from app import marks, runtime_tools


async def test_read_and_grep_count_lines_at_newlines_alone_as_the_citation_check_does(tmp_path):
    """A JSON string may hold U+2028, U+2029 or U+0085 as they are (json.dumps with ensure_ascii=False writes them so),
    and str.splitlines() breaks a line at each; the check, wc -l, sed -n and grep -n count "\\n" alone, and a "\\r"
    before it is the line's end. Every line after such a character keeps its own number in Read and Grep."""
    corpus, ws = tmp_path / "corpus", tmp_path / "ws"
    corpus.mkdir()
    ws.mkdir()
    breaks = ["\u2028", "\u0085", "\u2029"]
    rows = [json.dumps({"id": i, "text": f"message {i}" + (f"{breaks[i % 3]}more" if i % 4 == 0 else "")},
                       ensure_ascii=False) for i in range(1, 41)]
    rows[29] = json.dumps({"id": 30, "text": "the total was 136.48"})
    f = corpus / "chat_messages.jsonl"
    f.write_bytes("\r\n".join(rows[:20]).encode() + b"\r\n" + "\n".join(rows[20:]).encode() + b"\n")
    box = runtime_tools.Box(cwd=corpus, workspace=ws, read_roots=[corpus], write_roots=[ws])

    found = await runtime_tools.call(box, "Grep", {"pattern": r"136\.48", "path": str(f)})
    assert found.text == f"{f}:30: {rows[29]}"
    read = await runtime_tools.call(box, "Read", {"file_path": str(f), "offset": 30, "limit": 1})
    assert read.text == f"{30:>6}\t{rows[29]}\n[10 more lines: read on with offset 31]"
    assert marks.evidence().read_lines(str(f), 30, 30) == (30, [rows[29]])
    # the lines with those characters read whole, and a CRLF line without its "\r"
    whole = await runtime_tools.call(box, "Read", {"file_path": str(f), "offset": 1, "limit": 40})
    assert whole.text.split("\n") == [f"{n:>6}\t{row}" for n, row in enumerate(rows, 1)]
