"""thimble file issue (engine/kernel/share.py): the share draft and its privacy scan, the GitHub link (its encoding and its
length cap), and what `thimble file issue ID` prints. Nothing is sent: the command that would open the link is a fake. The world is test_fixes.py's made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, press, world  # noqa: E402, F401  (world is the fixture)

from kernel import cli as CLI  # noqa: E402
from kernel import share as SH  # noqa: E402

DRAFT = {"title": "Bar says read for coverage",
         "wrong": "After Claude read board-7.jsonl, the bar's item still said coverage.",
         "fixed": "The bar's coverage item now says read, as in r read 14% (3/21 files)."}


def fix_on(w) -> dict:
    r = made(w)
    FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(r["id"], press(r["id"]))
    return FX.get(r["id"])


def query(url: str) -> dict[str, str]:
    q = parse_qs(urlsplit(url).query, keep_blank_values=True)
    return {k: v[0] for k, v in q.items()}


@pytest.fixture
def opened(world, monkeypatch, tmp_path):
    """The command that opens the link: a fake that logs what it was given."""
    log = tmp_path / "opened.log"
    fake = tmp_path / "open-fake"
    fake.write_text(f"#!/bin/sh\necho \"$1\" >> '{log}'\n")
    fake.chmod(0o755)
    monkeypatch.setenv("THIMBLE_OPEN", str(fake))
    return log


def test_the_draft_goes_through_the_scan_and_says_what_it_took_out(world, monkeypatch, opened):
    rec = fix_on(world)
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["board-7.jsonl"], "name": ["dana"]})
    r = SH.share(rec["id"], DRAFT)
    assert r["took"] == "took 1 file name out of the text"
    assert "board-7.jsonl" not in r["title"] + r["body"] + r["url"]
    assert "After Claude read ‹data file›, the bar's item still said coverage." in r["body"]
    # GitHub Markdown: a heading for each part, the version line small at the end
    assert r["body"].startswith("### What was wrong\n\nAfter Claude read")
    assert "\n\n### How it was fixed\n\nThe bar's coverage item now says read" in r["body"]
    assert r["body"].rstrip().endswith("<sub>thimble 0.10.2 · terminal · fixed by <code>thimble fix</code></sub>")
    assert r["marks"] == ["‹data file›"]
    # Claude's draft is kept for the next share of the same fix (the shell has no model call), before the scan
    assert json.loads((SH.share_dir(rec["id"]) / "given.json").read_text())["wrong"] == DRAFT["wrong"]
    again = SH.share(rec["id"])
    assert again["text"] == "earlier" and again["body"] == r["body"]


def test_with_no_draft_the_text_is_the_persons_words_and_what_the_fixer_said(world, monkeypatch, opened):
    rec = fix_on(world)
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    r = SH.share(rec["id"])
    assert r["text"] == "record" and r["title"] == "Bar says read"
    assert r["body"].startswith("### What was wrong\n\nsay read, not coverage\n\n### How it was fixed\n\nThe bar's coverage item says read.")
    assert r["took"] == "found nothing of yours to take out"
    # a request with no code says what it needs, not how it was fixed
    q = FX.done(FX.new("explain the terms of my field")["id"], "Explain terms of my field", "It needs the person's words.")
    body = SH.share(q["id"])["body"]
    assert "### What it needs\n\nIt needs the person's words." in body and "asked through <code>thimble fix</code>" in body
    # a fix that is still being made has nothing to share
    w = FX.new("make the minimap smaller")
    with pytest.raises(FX.FixError, match="nothing to share yet"):
        SH.share(w["id"])


def test_the_link_is_githubs_new_issue_page_with_the_text_encoded(world, monkeypatch, opened):
    rec = fix_on(world)
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    r = SH.share(rec["id"], {**DRAFT, "wrong": "A reply's \"50% & more\" #3 line + emoji ✓ broke? (yes)"})
    assert r["url"].startswith("https://github.com/safety-research/thimble/issues/new?title=")
    got = query(r["url"])
    assert got["title"] == DRAFT["title"] and got["body"] == r["body"]
    assert "50% & more" in got["body"] and "✓" in got["body"]
    # every character outside the unreserved ones is encoded
    assert not re.search(r"[^A-Za-z0-9_.~%&=?/:-]", r["url"].split("?", 1)[1].replace("title=", "").replace("&body=", ""))
    assert "%20" in r["url"] and "+" not in r["url"].split("?", 1)[1]


def test_a_long_text_is_cut_to_fit_the_link_and_the_shell_says_so(world, monkeypatch, opened):
    rec = fix_on(world)
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    long = "The explainer cut its last line. " * 400
    r = SH.share(rec["id"], {**DRAFT, "wrong": long})
    assert r["shortened"] is True and len(r["url"]) <= SH.URL_MAX
    body = query(r["url"])["body"]
    assert body.endswith("…") and r["body"].startswith(body[:-1])
    # the link holds as much of the text as fits
    assert len(r["url"]) > SH.URL_MAX - 20
    assert "  · the text is longer than a GitHub link holds, so the link has the first part of it" in SH.lines(r)
    short = SH.issue_url("A title", "short text", "safety-research/thimble")
    assert short[1] is False and query(short[0])["body"] == "short text"


def test_the_shell_prints_the_link_and_opens_it_only_when_asked(world, monkeypatch, opened, capsys, tmp_path):
    rec = fix_on(world)
    (tmp_path / "shell").mkdir()
    monkeypatch.chdir(tmp_path / "shell")  # the shell stands in a folder of its own
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["board-7.jsonl"]})
    FX.write_json(SH.share_dir(rec["id"]) / "given.json", DRAFT)
    assert CLI.main(["file", "issue", str(rec["id"])]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "Share fix 1: Bar says read for coverage"
    assert out[1] == "  ✓ privacy check: took 1 file name out of the text"
    assert out[2].startswith("Open this link to post it as a GitHub issue.")
    assert out[2].endswith("nothing is sent until you do.")
    assert out[3] == "" and out[4].startswith("https://github.com/safety-research/thimble/issues/new?title=")
    # no local page, and nothing opened
    assert not (SH.share_dir(rec["id"]) / "index.html").exists()
    time.sleep(0.3)
    assert not opened.exists()
    # --open opens GitHub's page itself, once (the opener runs on its own, so its log may come a moment later)
    assert CLI.main(["file", "issue", str(rec["id"]), "--open"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[2] == "  ✓ opened the link in your browser"
    for _ in range(50):
        if opened.exists() and opened.read_text().strip():
            break
        time.sleep(0.1)
    assert opened.read_text().split() == [out[-1]]
    # --json, as the plugin and the browser call it, with Claude's draft on stdin
    p = subprocess.run([sys.executable, str(Path(SH.__file__).resolve().parents[1] / "thimble.py"), "file", "issue", "1",
                        "--json", "--draft", "-"], input=json.dumps(DRAFT), capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    d = json.loads(p.stdout)
    assert d["opened"] is False and d["text"] == "claude" and d["title"] == DRAFT["title"] and "page" not in d
    assert CLI.main(["file", "issue", "9"]) == 1
    assert "there is no fix 9" in capsys.readouterr().err


def test_in_a_shell_the_scan_takes_out_the_names_of_the_folder_the_fix_was_asked_in(world, monkeypatch, opened, tmp_path):
    data = tmp_path / "made-up-study"
    (data / "runs").mkdir(parents=True)
    (data / "runs" / "board-7.jsonl").write_text('{"x": 1}\n')
    monkeypatch.setenv("THIMBLE_ROOT", str(data))
    r = FX.new("after Claude read board-7.jsonl the bar still said coverage")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("coverage", "read"))
    FX.done(r["id"], "Bar says read", "The bar says read.")
    assert FX.get(r["id"])["root"] == str(data)
    # the shell: no THIMBLE_ROOT, and it stands somewhere else
    monkeypatch.delenv("THIMBLE_ROOT")
    monkeypatch.chdir(tmp_path)
    out = SH.share(r["id"])
    assert out["took"] == "took 1 file name out of the text"
    assert "board-7.jsonl" not in out["body"] + out["url"] and "after Claude read ‹data file›" in out["body"]
