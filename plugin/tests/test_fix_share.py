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
    assert r["body"].rstrip().endswith("thimble 0.10.2 · terminal · fixed by `thimble fix`")
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
    assert "### What it needs\n\nIt needs the person's words." in body and "asked through `thimble fix`" in body
    # a fix that left the list has nothing to share
    FX.remove(q["id"])
    with pytest.raises(FX.FixError, match=f"fix {q['id']} is removed: there is nothing to share yet"):
        SH.share(q["id"])


def test_a_running_fixs_issue_says_that_claude_is_still_working_on_it(world, monkeypatch, opened, tmp_path):
    """R1: a fix that Claude still works on goes as an issue too: the person's words, that Claude is still working on
    it, and what it does so far once its fixer ended, never that Claude could not do it in code. Once it is done, its
    issue says how it was fixed, as any finished fix's does."""
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    w = FX.new("make the minimap smaller")
    r = SH.share(w["id"])
    assert r["text"] == "record" and r["title"] == "make the minimap smaller"
    assert r["body"] == ("### What was wrong\n\nmake the minimap smaller\n\n### What it does so far\n\n"
                         "Claude is still working on this fix.\n\n"
                         "thimble 0.10.2 · terminal · asked through `thimble fix`\n")
    assert query(r["url"]) == {"title": "make the minimap smaller", "body": r["body"]}
    # its fixer ended and its tests run (until the gate is there, at most 20 s): it is still working
    gate = tmp_path / "tests-may-end"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"for i in $(seq 400); do [ -e '{gate}' ] && break; sleep 0.05; done")
    p = Path(w["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("coverage", "read"))
    assert FX.done(w["id"], "Bar says read", "The bar's coverage item says read.", within=0)["testing"]
    r = SH.share(w["id"])
    assert r["title"] == "make the minimap smaller" and query(r["url"])["body"] == r["body"]
    assert r["body"].startswith("### What was wrong\n\nmake the minimap smaller\n\n### What it does so far\n\n"
                                "Claude is still working on this fix.\n\nThe bar's coverage item says read.\n\n")
    assert "How it was fixed" not in r["body"] and r["body"].rstrip().endswith("· asked through `thimble fix`")
    gate.touch()
    assert FX.done(w["id"], within=30)["state"] == "ready"
    r = SH.share(w["id"])
    assert r["title"] == "Bar says read" and "still working" not in r["body"]
    assert r["body"] == ("### What was wrong\n\nmake the minimap smaller\n\n### How it was fixed\n\n"
                         "The bar's coverage item says read.\n\nthimble 0.10.2 · terminal · fixed by `thimble fix`\n")


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


def test_a_folder_named_like_thimbles_words_leaves_thimbles_own_text_as_it_is(world, monkeypatch, opened, tmp_path):
    """B16: the scan reads the person's words and Claude's alone. A folder of theirs named like a word of thimble's issue
    text (fix, terminal) takes nothing out of thimble's headings, sentences or last line; in their words, a data file's
    name and such a folder's name still go."""
    data = tmp_path / "made-up-study"
    for f in ("fix/notes.md", "terminal/session-3.log", "runs/board-7.jsonl"):
        (data / f).parent.mkdir(parents=True, exist_ok=True)
        (data / f).write_text("made-up\n")
    monkeypatch.setenv("THIMBLE_ROOT", str(data))
    w = FX.new("the minimap covers the cards of board-7.jsonl")
    r = SH.share(w["id"])
    assert r["body"] == ("### What was wrong\n\nthe minimap covers the cards of ‹data file›\n\n### What it does so far\n\n"
                         "Claude is still working on this fix.\n\nthimble 0.10.2 · terminal · asked through `thimble fix`\n")
    assert r["took"] == "took 1 file name out of the text"
    p = Path(w["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("coverage", "read"))
    assert FX.done(w["id"], "Minimap folds away", "The minimap folds into a button.")["state"] == "ready"
    r = SH.share(w["id"], {"title": "Minimap folds away", "wrong": "The minimap hid the cards.",
                           "fixed": "The minimap folds into a button, as in the terminal."})
    assert r["body"] == ("### What was wrong\n\nThe minimap hid the cards.\n\n### How it was fixed\n\n"
                         "The minimap folds into a button, as in the ‹folder›.\n\n"
                         "thimble 0.10.2 · terminal · fixed by `thimble fix`\n")
    assert r["took"] == "took 1 folder name out of the text" and query(r["url"])["body"] == r["body"]


def test_a_fix_asked_in_the_home_folder_lists_none_of_its_files(world, monkeypatch, opened, capsys, tmp_path):
    from kernel import sources  # noqa: PLC0415

    # a session started in the home folder (a made-up one): the fix's folder is the home folder
    home = tmp_path / "made-up-home"
    (home / "notes").mkdir(parents=True)
    (home / "notes" / "board-7.jsonl").write_text('{"x": 1}\n')
    for k, v in {"HOME": str(home), "LOGNAME": "dana-made-up", "USER": "dana-made-up", "THIMBLE_ROOT": str(home),
                 "THIMBLE_CONVERSATION": "conv-made-up"}.items():
        monkeypatch.setenv(k, v)
    r = FX.new("after Claude read board-7.jsonl the bar still said coverage")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("coverage", "read"))
    FX.done(r["id"], "Bar says read", "The bar says read.")
    assert FX.get(r["id"])["root"] == str(home) and FX.get(r["id"])["conversation"] == "conv-made-up"
    # what the conversation read, as the hooks keep it (hooks/watch.ts)
    seen = FX.thimble_home() / "seen" / "conv-made-up.jsonl"
    seen.parent.mkdir(parents=True, exist_ok=True)
    seen.write_text(json.dumps({"tool": "Read", "file": str(home / "notes" / "board-7.jsonl"), "from": 1, "to": 1,
                                "cwd": str(home)}) + "\n")
    # the person's shell, somewhere else: a walk of every file of the home folder would take minutes, so none runs
    for k in ("THIMBLE_ROOT", "THIMBLE_CONVERSATION"):
        monkeypatch.delenv(k)
    monkeypatch.chdir(tmp_path)
    real = sources.list_files

    def listed(root):
        assert Path(root).resolve() != home.resolve(), "the scan listed the home folder"
        return real(root)

    monkeypatch.setattr(sources, "list_files", listed)
    FX.write_json(SH.share_dir(r["id"]) / "given.json",
                  {**DRAFT, "wrong": "dana-made-up saw the bar say coverage after Claude read board-7.jsonl."})
    assert CLI.main(["file", "issue", str(r["id"])]) == 0
    cap = capsys.readouterr()
    # the link: the user's name and the file the conversation read are out
    took = next(x for x in cap.out.splitlines() if "privacy check" in x)
    assert "1 file name" in took and " 1 name" in took
    assert "board-7.jsonl" not in cap.out and "dana-made-up" not in cap.out


def test_a_failed_fixs_issue_says_why_it_could_not_be_done_and_what_claude_tried(world, monkeypatch, opened):
    # a fix whose fixer could not do without the privacy scan, which no fix may change: its line sends it here
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    r = FX.new("let the scan skip my notes")
    (Path(r["work"]) / "plugin" / "engine" / "kernel").mkdir(parents=True)
    (Path(r["work"]) / "plugin" / "engine" / "kernel" / "privacy.py").write_text("def scan(*a): return [], []\n")
    FX.done(r["id"], "Scan skips notes", "The scan skips the notes you name.")
    FX.again(r["id"])
    r = FX.done(r["id"], cannot="The scan keeps your data private, and a fix may not change it.")
    assert r["state"] == "failed" and r["blocked"] and r["commit"]
    body = SH.share(r["id"])["body"]
    assert body.startswith("### What was wrong\n\nlet the scan skip my notes\n\n### Why it could not be done here\n\n"
                           "The scan keeps your data private, and a fix may not change it.\n\n### What Claude tried\n\n"
                           "The scan skips the notes you name.\n\n")
    assert "How it was fixed" not in body and body.rstrip().endswith("· asked through `thimble fix`")


def test_the_scan_of_a_large_folders_names_finds_the_same_details_in_a_moment():
    from kernel import privacy as P  # noqa: PLC0415

    # a folder of 100,000 files: a name and a stem each, which the scan looked for with a regular expression each (40 s)
    names = [f"run-{i:06d}.jsonl" for i in range(100000)]
    text = "After Claude read run-000042.jsonl, dana-made-up saw the bar say coverage.\n" * 20
    t = time.monotonic()
    many, _ = P.scan({"issue": text}, {"file": names + [n[:-6] for n in names], "name": ["dana-made-up"]}, None,
                     use_gitleaks=False)
    took = time.monotonic() - t
    few, _ = P.scan({"issue": text}, {"file": ["run-000042.jsonl"], "name": ["dana-made-up"]}, None, use_gitleaks=False)
    assert many == few and {h["found"] for h in many} == {"run-000042.jsonl", "dana-made-up"}
    assert took < 15, took


def test_in_wsl_links_open_with_wslview_unless_thimble_open_names_another(monkeypatch, tmp_path):
    """In WSL (WSL_DISTRO_NAME), wslview opens a link in Windows' browser, ahead of xdg-open, which would look for a Linux
    one; THIMBLE_OPEN still comes first. Without wslview, or outside WSL, it is as on any Linux."""
    for name in ("wslview", "xdg-open"):
        (tmp_path / name).write_text("#!/bin/sh\n")
        (tmp_path / name).chmod(0o755)
    monkeypatch.setattr(SH.sys, "platform", "linux")
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.delenv("THIMBLE_OPEN", raising=False)
    monkeypatch.setenv("WSL_DISTRO_NAME", "Made-Up")
    assert SH.opener() == ["wslview"]
    monkeypatch.setenv("THIMBLE_OPEN", "none")
    assert SH.opener() is None
    monkeypatch.delenv("THIMBLE_OPEN")
    (tmp_path / "wslview").unlink()
    assert SH.opener() == ["xdg-open"]
    (tmp_path / "wslview").write_text("#!/bin/sh\n")
    (tmp_path / "wslview").chmod(0o755)
    monkeypatch.delenv("WSL_DISTRO_NAME")
    assert SH.opener() == ["xdg-open"]
