"""The fixes an update set aside go back on where they still fit (fixes.py carry): their change applies to the new
release, and the release passes a fix's checks with them (the quick tests, in a copy, as done runs them). thimble 0.10.5
and before ran their own kernel for thimble update, which set every fix aside and stopped there: this kernel puts back
what still fits at a step that may take the minutes the checks need (thimble fixes, thimble reapply or thimble update in
a shell, thimble-browser's start, a Claude Code session's start), says what does not fit, and keeps the fixes off that
the person had turned off. A list for the plugin or the workbench never carries. The world is test_fixes.py's made-up
thimble 0.10.2, a GitHub install (a clone install where a test says so); `claude` is a fake, and the quick tests are a
shell command (THIMBLE_FIX_TESTS). All data here is made up."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, calls, commit_in_checkout, fake, live_file, made, on_fix, press, release_with, sh, three_fixes, upstream, world  # noqa: E402, F401

LAUNCHER = Path(__file__).resolve().parents[2] / "browser" / "scripts" / "thimble-browser"


def update_as_before() -> list[int]:
    """thimble update as thimble 0.10.5 and before ran it, with their own kernel: every fix in mine (and any still set
    aside) set aside with its old change, mine and live the plain release, the fixes said to be on (state.json), the
    release checkout moved, and the record of what was set aside (pending/current.json) with no word of the fixes being
    off. Then Claude Code copies live. The fixes set aside."""
    latest = FX.latest_release()
    with FX.Lock():
        FX.ensure_live()
        live, rel = FX.live_dir(), FX.release()
        old, now = str(rel["base"]), FX.release_name(rel)
        ref = f"refs/thimble/releases/{latest['tag']}"
        sh("git", "fetch", "-q", "--no-tags", latest["url"], f"+refs/tags/{latest['tag']}:{ref}", cwd=live)
        new = sh("git", "rev-parse", f"{ref}^{{commit}}", cwd=live)
        recs = FX.records()
        aside = list(dict.fromkeys([*FX._replay_order(recs), *[i for i, r in sorted(recs.items()) if r.get("state") == "pending"]]))
        FX._set_aside(aside, recs, latest["version"], latest["version"], now)
        FX._unstamp()
        sh("git", "checkout", "-q", "-B", "mine", new, cwd=live)
        FX.write_json(FX.home() / "state.json", {"on": True})
        rel.update(base=new, version=FX._version_at(live, new), tag=latest["tag"], updated=time.time())
        FX.write_json(FX.home() / "release.json", rel)
        FX.place_release(new)
        FX.write_json(FX.home() / "pending" / "current.json", {
            "version": latest["version"], "from": now, "from_commit": old, "to_commit": new, "ids": aside,
            "tip": FX.head(), "made": time.time()})
        FX._repoint()
        FX._sync()
    return aside


def fix_of(words: str, path: str, text: str, title: str) -> int:
    """A fix that is on: `text` written to `path` in its copy."""
    r = FX.new(words)
    p = Path(r["work"]) / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    FX.done(r["id"], title, "")
    FX.apply(r["id"], press(r["id"]))
    return r["id"]


def checks_that_fail_on(monkeypatch, tmp_path: Path, test: str) -> Path:
    """The quick tests from now on: a shell command that fails when `test` (a shell test, in the copy) holds, and logs
    each run. The log."""
    log = tmp_path / "runs.log"
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo run >> '{log}'; ! {{ {test}; }}")
    return log


def runs(log: Path) -> int:
    return len(log.read_text().splitlines()) if log.exists() else 0


def test_the_first_list_after_an_older_update_puts_back_what_fits_and_says_what_does_not(world, upstream, monkeypatch, capsys):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    # 0.10.3 has the note as fix b made it, and its own legend on the line fix c changed; 0.10.2's own update ran
    new = upstream({"plugin/notes.md": "made-up note\n", "plugin/legend.ts": "const legend = `quiet ${n} files`\n"},
                   "v0.10.3")
    assert update_as_before() == [a, b, c]
    assert {FX.get(i)["state"] for i in (a, b, c)} == {"pending"}
    live = FX.live_dir()
    before = len(calls(world))
    capsys.readouterr()
    # thimble fixes, the person's next look: the bar's word fits 0.10.3 and is on again, the note is 0.10.3's own, and
    # the legend does not fit it: the line under the table says so, once, for thimble reapply
    rows = FX.list_lines(120)
    assert capsys.readouterr().err.splitlines() == ["Checking your fix on thimble 0.10.3 (a minute or two)..."]
    assert rows[:5] == [
        f"Fix {a} fits thimble 0.10.3 and is on again.",
        "Already in thimble 0.10.3, so it leaves thimble fixes: A note.",
        "In Claude Code, type /reload-plugins to load them.", "",
        "Your thimble fixes · thimble 0.10.3 with 1 on, 1 off"]
    assert [x for x in rows if "does not fit" in x] == [f"  fix {c} is off: it does not fit thimble 0.10.3"]
    assert calls(world)[before:] == ["plugin update thimble@thimble"]
    assert sh("git", "rev-parse", "mine^", cwd=live) == new and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=live) == "mine" and FX.is_on()
    r = FX.get(a)
    assert (r["state"], r["commit"], r["error"], r["pending"]) == ("on", sh("git", "rev-parse", "mine", cwd=live), None, None)
    assert r["files"] == [{"path": "plugin/bar/bar.tsx", "add": 1, "del": 1}]
    assert (FX.get(b)["state"], FX.get(b)["released_in"]) == ("released", "0.10.3")
    assert (FX.get(c)["state"], FX.get(c)["error"]) == ("pending", "it does not fit thimble 0.10.3")
    cur = json.loads((FX.home() / "pending" / "current.json").read_text())
    assert (cur["ids"], cur["tip"], cur["carried"]) == ([c], sh("git", "rev-parse", "mine", cwd=live), True)
    # the copy the check ran in is gone
    assert not (FX.home() / "work" / "carry").exists() and "carry" not in sh("git", "worktree", "list", cwd=live)
    # once: the next look says nothing of it and changes nothing, and neither does thimble update
    head = sh("git", "rev-parse", "mine", cwd=live)
    assert FX.carry() is None
    assert FX.list_lines(120)[0] == "Your thimble fixes · thimble 0.10.3 with 1 on, 1 off"
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    assert sh("git", "rev-parse", "mine", cwd=live) == head and calls(world)[before:] == ["plugin update thimble@thimble"]
    # thimble fix show and a y on it say the same of the legend: it does not fit 0.10.3, and thimble reapply fits it
    assert "  Set aside     it does not fit thimble 0.10.3" in FX.show_lines(c, 120)
    with pytest.raises(FX.FixError, match=f"^fix {c} is off: it does not fit thimble 0.10.3; thimble reapply, in a shell, "
                                          "has Claude fit it$"):
        FX.apply(c, press(c))
    # thimble reapply has Claude fit the legend alone
    text = FX.reapply_argv()["argv"][1]
    assert "thimble set aside 1 fix of theirs" in text and "Legend counts untouched" in text and "Bar says read" not in text


def test_a_fix_whose_change_applies_but_fails_the_checks_on_the_release_stays_off_and_the_others_go_back_on(world, upstream, monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = made(world)["id"]
    FX.done(a, "Bar says read", "")
    FX.apply(a, press(a))
    # fix b calls what 0.10.3 takes away (made-up-old-api), and its change applies all the same
    b = fix_of("say who asked", "plugin/hints.ts", "import { askerOf } from 'made-up-old-api'\n", "Hints say who asked")
    c = fix_of("count the untouched files", "plugin/legend.ts", "const legend = `untouched ${n}`\n", "Legend counts untouched")
    new = upstream({"plugin/api.ts": "export const gone = 'made-up-old-api'\n"}, "v0.10.3")
    update_as_before()
    # 0.10.3's checks fail with fix b, and pass with the others
    log = checks_that_fail_on(monkeypatch, tmp_path, "test -f plugin/api.ts && grep -qs made-up-old-api plugin/hints.ts")
    live = FX.live_dir()
    capsys.readouterr()
    rows = FX.list_lines(120)
    assert capsys.readouterr().err.splitlines() == ["Checking your 3 fixes on thimble 0.10.3 (a minute or two)...",
                                                    "They do not pass together: checking them one at a time..."]
    assert rows[:4] == [f"Fixes {a} and {c} fit thimble 0.10.3 and are on again.",
                        "In Claude Code, type /reload-plugins to load them.", "",
                        "Your thimble fixes · thimble 0.10.3 with 2 on, 1 off"]
    assert [x for x in rows if "does not fit" in x] == [f"  fix {b} is off: it does not fit thimble 0.10.3"]
    # the three together failed, and again (each run that fails runs once more); the release alone passed; then a alone
    # passed, a and b failed twice, and a and c passed
    assert runs(log) == 7
    assert sh("git", "log", "--format=%s", f"{new}..mine", cwd=live).splitlines() == ["Legend counts untouched", "Bar says read"]
    assert not (live / "plugin" / "hints.ts").exists() and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on", "pending", "on"]
    assert FX.get(b)["error"] == "it does not fit thimble 0.10.3"
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{c}", cwd=live) == sh("git", "rev-parse", "mine", cwd=live)
    assert "plugin update thimble@thimble" in calls(world)
    # once: nothing runs the checks again, and thimble reapply has Claude fit fix b alone
    assert FX.carry() is None and runs(log) == 7
    text = FX.reapply_argv()["argv"][1]
    assert "Hints say who asked" in text and "Bar says read" not in text and "Legend counts untouched" not in text


def test_a_fix_that_fails_the_checks_at_thimble_update_stays_off_and_the_release_runs(world, upstream, monkeypatch, tmp_path):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    # 0.10.3's own rule, which the bar's new word breaks
    new = upstream({"plugin/rule.md": "the bar says coverage\n"}, "v0.10.3")
    log = checks_that_fail_on(monkeypatch, tmp_path, "test -f plugin/rule.md && grep -qs 'read ' plugin/bar/bar.tsx")
    out = FX.update()
    assert (out["back"], out["had"], out["aside"]) == ([], [], [a]) and runs(log) == 3
    assert out["lines"][2:4] == ["1 local fix does not fit 0.10.3, so it is off: Bar says read.", ""]
    assert out["lines"][4] == "Bring it back:  thimble reapply"
    live = FX.live_dir()
    assert sh("git", "rev-parse", "mine", cwd=live) == new and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert (FX.get(a)["state"], FX.get(a)["error"]) == ("pending", "it does not fit thimble 0.10.3")
    assert "plugin update thimble@thimble" in calls(world) and out["reload"] is True


def test_0_10_6s_own_update_keeps_every_fix_off_when_the_person_had_turned_them_off(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    FX.all_off()
    new = upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    out = FX.update()
    assert " ".join(out["lines"][2:4]) == ("Your 3 fixes are replayed onto 0.10.3 and stay off, as you had them: Bar says "
                                          "read; A note; Legend counts untouched.")
    live = FX.live_dir()
    # off, as the person had them: live shows the release, and mine holds the three on it
    assert not FX.is_on() and json.loads((FX.home() / "state.json").read_text()) == {"on": False}
    assert sh("git", "rev-parse", "HEAD", cwd=live) == new and "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "rev-parse", "mine~3", cwd=live) == new
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on", "on", "on"]
    assert not (FX.home() / "pending" / "current.json").exists()
    FX.all_on()
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and FX.is_on()


def test_when_the_checks_cannot_run_nothing_moves_and_the_next_carry_checks_again(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    live = FX.live_dir()
    tip = sh("git", "rev-parse", "mine", cwd=live)
    before = len(calls(world))
    why = "the sandbox runtime that fixes run in is not installed"

    def no_sandbox(fid, paths, base):
        raise FX.FixError(why)

    with monkeypatch.context() as m:
        m.setattr(FX, "_checks_argv", no_sandbox)
        rows = FX.list_lines(120)
        assert " ".join(rows[:rows.index("")]) == f"Your 3 fixes stay off: thimble could not check them on thimble 0.10.3 ({why})."
        assert [FX.get(i)["state"] for i in (a, b, c)] == ["pending"] * 3
        assert sh("git", "rev-parse", "mine", cwd=live) == tip and calls(world)[before:] == []
        assert not json.loads((FX.home() / "pending" / "current.json").read_text()).get("carried")
        assert FX.listing()["due"] == {"to": "0.10.3", "n": 3}
    # the sandbox is there now: the next carry puts them back
    assert FX.carry()["back"] == [a, b, c] and [FX.get(i)["state"] for i in (a, b, c)] == ["on"] * 3


def test_when_the_release_alone_fails_the_checks_too_no_fix_is_called_a_misfit_and_nothing_moves(world, upstream, monkeypatch, tmp_path):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    live = FX.live_dir()
    tip = sh("git", "rev-parse", "mine", cwd=live)
    # the tests fail whatever the fixes (a machine too busy for their time limits, say)
    log = checks_that_fail_on(monkeypatch, tmp_path, "true")
    rows = FX.list_lines(120)
    assert " ".join(rows[:rows.index("")]) == ("Your 3 fixes stay off: thimble could not check them on thimble 0.10.3 (the "
                                              "checks fail without them too).")
    # the three together, then the release alone, each twice: then nothing moves, and no fix is called a misfit
    assert runs(log) == 4
    assert [(FX.get(i)["state"], FX.get(i)["error"]) for i in (a, b, c)] == [("pending", None)] * 3
    assert sh("git", "rev-parse", "mine", cwd=live) == tip and FX.listing()["due"] == {"to": "0.10.3", "n": 3}
    # the tests pass again: the next carry puts the fixes back
    monkeypatch.setenv("THIMBLE_FIX_TESTS", "true")
    assert FX.carry()["back"] == [a, b, c]


def test_a_list_for_the_plugin_or_the_workbench_never_carries_and_says_what_waits(world, upstream, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    live = FX.live_dir()
    tip = sh("git", "rev-parse", "mine", cwd=live)
    before = len(calls(world))
    # the plugin's list at a session's start, and the workbench's: nothing moves, and the list says what waits
    assert cli.main(["fix", "list", "--json"]) == 0
    d = json.loads(capsys.readouterr().out)
    assert d["due"] == {"to": "0.10.3", "n": 3} and d["carried"] is None
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["pending"] * 3 and sh("git", "rev-parse", "mine", cwd=live) == tip
    assert calls(world)[before:] == []
    # thimble fixes inside Claude Code (Claude's Bash tool): no carry either, and a line says how
    monkeypatch.setenv("CLAUDECODE", "1")
    assert FX.list_lines(120)[0] == ("Your 3 fixes wait for a check on thimble 0.10.3: thimble fixes, in a shell, puts "
                                     "back those that fit.")
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["pending"] * 3
    # the plugin's session start runs the carry itself, a step on its bar
    assert cli.main(["fix", "carry", "--json"]) == 0
    got = json.loads(capsys.readouterr().out)
    assert (got["to"], got["back"], got["aside"], got["reload"]) == ("0.10.3", [a, b, c], [], True)
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on"] * 3 and FX.listing()["due"] is None
    assert cli.main(["fix", "carry", "--json"]) == 0 and capsys.readouterr().out.strip() == "null"


def test_a_copy_that_claude_code_did_not_make_is_owed_and_the_next_carry_makes_it(world, upstream, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    # Claude Code's copy fails (thimble-browser's start ran the carry, from a shell whose PATH has another claude, say)
    fake(world["bin"] / "claude", world["log"], '[ "$1 $2" = "plugin update" ] && { echo made-up refusal >&2; exit 1; }')
    assert cli.main(["fix", "carry"]) == 0
    said = capsys.readouterr().out.splitlines()
    assert said[0] == "Your fix fits thimble 0.10.3 and is on again: Bar says read."
    assert " ".join(said[1:]).startswith("Claude Code did not copy them yet (")
    assert " ".join(said[1:]).endswith("plugin update failed: made-up refusal); your next Claude Code session does.")
    assert FX.get(a)["state"] == "on" and (FX.home() / "pending" / "sync-owed").exists()
    assert FX.listing()["due"] == {"to": "0.10.3", "n": 0}
    # the next session's start: its list says a copy is owed, and its carry has Claude Code copy live
    fake(world["bin"] / "claude", world["log"])
    out = FX.carry()
    assert (out["back"], out["reload"]) == ([], True) and calls(world)[-1] == "plugin update thimble@thimble"
    assert not (FX.home() / "pending" / "sync-owed").exists() and FX.listing()["due"] is None and FX.carry() is None


def test_thimble_update_after_an_older_update_puts_back_what_fits(world, upstream, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    # the person runs thimble update again, with this kernel: the release is the newest, and the fix goes back on
    assert cli.main(["update"]) == 0
    got = capsys.readouterr()
    assert got.out.splitlines() == [
        "thimble 0.10.3 is the newest release.", "Your fix fits thimble 0.10.3 and is on again: Bar says read.",
        "In Claude Code, type /reload-plugins to load them."]
    assert got.err.splitlines() == ["Checking your fix on thimble 0.10.3 (a minute or two)..."]
    assert FX.get(a)["state"] == "on" and not (FX.home() / "pending" / "current.json").exists()
    assert cli.main(["update"]) == 0 and capsys.readouterr().out.splitlines() == ["thimble 0.10.3 is the newest release."]


def test_reapply_after_an_older_update_opens_no_claude_when_every_fix_fits(world, upstream, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    before = len(calls(world))
    # the line 0.10.2's update printed: Bring them back: thimble reapply
    assert cli.main(["reapply"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "Your 3 fixes fit thimble 0.10.3 and are on again: Bar says read; A note; Legend counts",
        "untouched.", "In Claude Code, type /reload-plugins to load them."]
    # no Claude Code opened: the fake's log has Claude Code's copy alone
    assert calls(world)[before:] == ["plugin update thimble@thimble"]
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on", "on", "on"]
    assert sh("git", "log", "--format=%s", "-3", "mine", cwd=FX.live_dir()).splitlines() == [
        "Legend counts untouched", "A note", "Bar says read"]
    assert cli.main(["reapply"]) == 1 and "no fixes are set aside" in capsys.readouterr().err


def test_reapply_after_an_older_update_puts_back_what_fits_and_opens_claude_for_the_rest(world, upstream, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    upstream({"plugin/legend.ts": "const legend = `quiet ${n} files`\n"}, "v0.10.3")
    update_as_before()
    assert cli.main(["reapply", "--print"]) == 0
    got = capsys.readouterr()
    # what carry did goes to stderr, and says nothing of thimble reapply, which runs now; the prompt alone to stdout
    assert got.err.splitlines() == [
        "Checking your 2 fixes on thimble 0.10.3 (a minute or two)...",
        "Your 2 fixes fit thimble 0.10.3 and are on again: Bar says read; A note.",
        "Off, as it does not fit thimble 0.10.3: Legend counts untouched.",
        "In Claude Code, type /reload-plugins to load them."]
    assert got.out.startswith("You are in this person's own copy") and "Legend counts untouched" in got.out
    assert "Bar says read" not in got.out


def test_fixes_turned_off_before_an_older_update_stay_off(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    FX.all_off()
    new = upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    # the older update said the fixes are on; live's HEAD log says where it came from: the plain release
    assert FX.is_on()
    rows = FX.list_lines(120)
    assert rows[0] == f"Fixes {a}, {b}, and {c} fit thimble 0.10.3 and stay off, as you had them."
    assert rows[2] == "Your thimble fixes · thimble 0.10.3 with 3 off"
    live = FX.live_dir()
    assert not FX.is_on() and sh("git", "rev-parse", "HEAD", cwd=live) == new
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on", "on", "on"]
    # thimble fix on brings them back, on 0.10.3
    FX.all_on()
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and sh("git", "rev-parse", "mine~3", cwd=live) == new


def test_thimble_fix_on_after_an_older_update_checks_the_fixes_first(world, upstream, monkeypatch, capsys):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    FX.all_off()
    new = upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    # thimble fix on, with no list before it: the fixes go back on 0.10.3 first, then on
    out = FX.all_on()
    assert out["said"] == "Your fixes are on again: 3 fixes."
    assert "Checking your 3 fixes on thimble 0.10.3" in capsys.readouterr().err
    assert FX.is_on() and "read ${n}" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "rev-parse", "mine~3", cwd=FX.live_dir()) == new


def test_thimble_fix_on_n_after_an_older_update_puts_that_fix_back_when_it_fits(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    out = FX.one_on(a)
    assert out == {"said": f"Fix {a} is on: Bar says read.", "reload": True}
    assert FX.get(a)["state"] == "on" and "read ${n}" in live_file("plugin/bar/bar.tsx")


def test_nothing_is_put_back_while_a_reapply_session_works_in_live(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    live = FX.live_dir()
    # Claude, in the session thimble reapply opened, changes the bar and has not committed yet
    (live / "plugin" / "bar" / "bar.tsx").write_text("const words = `read ${n} files`\n")
    assert FX.carry() is None and FX.get(a)["state"] == "pending" and FX.listing()["due"] is None
    # it committed: mine moved on from where the update left it, and the commit is for thimble update --continue
    sh("git", "commit", "-q", "-am", "Bar says read", cwd=live)
    assert FX.carry() is None and FX.get(a)["state"] == "pending"
    assert FX.continue_()["recorded"] == [a] and FX.get(a)["state"] == "on"


def test_a_sent_fix_goes_back_on_as_sent(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)
    # thimble file pr sent it: it stays in mine, with its pull request
    FX.put({**a, "state": "sent", "pr": "https://github.com/made-up/thimble/pull/7"})
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    assert FX.carry()["back"] == [a["id"]]
    r = FX.get(a["id"])
    assert (r["state"], r["pr"]) == ("sent", "https://github.com/made-up/thimble/pull/7")
    assert r["commit"] == sh("git", "rev-parse", "mine", cwd=FX.live_dir())


def test_a_fix_changed_in_place_goes_back_as_it_was_with_its_new_version_waiting(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    # a round of the fix: its new version waits for the person's y while the version they have stays on
    r = FX.round_(a, "it breaks when I click")
    p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("${n}", "${n ?? 0}"))
    r = FX.done(a, None, "The read item works when clicked.")
    assert (r["state"], r["prev"]["state"]) == ("ready", "on")
    upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    assert FX.carry()["back"] == [a]
    live = FX.live_dir()
    r = FX.get(a)
    mine = sh("git", "rev-parse", "mine", cwd=live)
    # the version the person had is on, on 0.10.3; the new one still waits for their y
    assert (r["state"], r["prev"]["state"], r["prev"]["commit"]) == ("ready", "on", mine)
    assert sh("git", "rev-parse", f"refs/thimble/fixes/{a}", cwd=live) == mine
    assert "read ${n}`" in live_file("plugin/bar/bar.tsx")
    assert sh("git", "rev-parse", "-q", "--verify", f"refs/thimble/next/{a}", cwd=live)


def test_the_way_back_runs_from_the_release_once_an_update_from_before_it_is_carried(world, upstream, monkeypatch, tmp_path):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n", "plugin/bin/thimble": "#!/bin/sh\necho made-up\n"}, "v0.10.3")
    update_as_before()
    # as 0.10.4's update leaves it: no release checkout, and the shell's link on live's command
    shutil.rmtree(FX.release_dir())
    link = tmp_path / "home" / ".local" / "bin" / "thimble"
    link.parent.mkdir(parents=True)
    link.symlink_to(FX.live_dir() / "plugin" / "bin" / "thimble")
    (FX.thimble_home() / "cli-link").write_text(f"{link}\n")
    assert FX.carry()["back"] == [a]
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == FX.release()["base"]
    assert Path(link.readlink()) == FX.release_dir() / "plugin" / "bin" / "thimble"


def test_a_list_that_cannot_put_fixes_back_still_lists_them_and_says_why(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()

    def broken(sync: bool = True, say=None):
        raise FX.FixError("git checkout failed: made-up")

    monkeypatch.setattr(FX, "_carry", broken)
    d = FX.listing(carry_now=True)
    assert d["carried"] is None and d["carry_error"] == "git checkout failed: made-up"
    assert [r["id"] for r in d["fixes"]] == [a] and FX.get(a)["state"] == "pending"
    assert FX.list_lines(120)[:2] == ["thimble could not put back the fixes the update set aside: git checkout failed: "
                                      "made-up", ""]
    with pytest.raises(FX.FixError, match="made-up"):
        FX.carry()


def made_up_venv(root: Path) -> Path:
    """A made-up Python environment for the browser workbench's server in `root` (its bin/python runs this Python)."""
    py = root / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    py.chmod(0o755)
    return root


def test_the_checks_follow_the_parts_a_change_touches_and_borrow_the_workbenchs_packages(world, monkeypatch, tmp_path):
    monkeypatch.delenv("THIMBLE_FIX_TESTS")
    monkeypatch.setattr(FX, "_has_pytest", lambda py: False)
    seen: list = []
    monkeypatch.setattr(FX, "sandbox_argv", lambda fid, **kw: seen.append((fid, kw)) or ["box"])
    quick = f"{FX.LAUNCHER_SMOKE} && {FX.QUICK_TESTS}"
    page = FX.PAGE_CHECKS.format(base="v0.10.3")
    FX.ensure_live()
    copy = tmp_path / "copy"
    (copy / "browser" / "frontend").mkdir(parents=True)
    (copy / "browser" / "backend").mkdir()
    # without the workbench's packages, the terminal plugin's checks alone, and nothing for the page or the server
    assert FX._checks(copy, ["plugin/bar/bar.tsx", "browser/frontend/src/App.tsx"], "v0.10.3") == (quick, [])
    assert FX._checks(copy, ["browser/backend/app/errors.py", "browser/scripts/thimble-browser"], "v0.10.3") == ("true", [])
    # the workbench on live: its page packages and its server's Python environment, which the copy borrows, the page's
    # as a folder of links that leaves out its tools' temp files
    b = FX.live_dir() / "browser"
    for name in ("react", ".vite", ".bin"):
        (b / "frontend" / "node_modules" / name).mkdir(parents=True)
    venv = made_up_venv(b / "backend" / ".venv")
    cmd, reads = FX._checks(copy, ["browser/frontend/src/App.tsx", "browser/prompts/main.md", "plugin/x.ts"], "v0.10.3")
    assert cmd == f"{quick} && {page} && {FX.SERVER_CHECKS}"
    lent = copy / "browser" / "frontend" / "node_modules"
    assert sorted(x.name for x in lent.iterdir()) == [".bin", "react"] and (lent / "react").is_symlink()
    assert (lent / "react").resolve() == (b / "frontend" / "node_modules" / "react").resolve()
    assert (copy / "browser" / "backend" / ".venv").resolve() == venv.resolve()
    assert {str((b / "frontend" / "node_modules").resolve()), str(venv.resolve()),
            *FX._py_dirs(str(venv / "bin" / "python"))} <= set(reads)
    # the command done and carry run in a copy: the checks, in the sandbox that reads the packages
    (FX.home() / "work" / "carry" / "browser" / "backend").mkdir(parents=True)
    assert FX._checks_argv("carry", ["browser/backend/app/errors.py"], "v0.10.3") == ["box", FX.SERVER_CHECKS]
    assert seen[-1][0] == "carry" and str(venv.resolve()) in seen[-1][1]["reads"]
    # before the workbench runs from live, the copy borrows the packages of the checkout it was installed in
    seed = tmp_path / "checkout" / "browser"
    (seed / "frontend" / "node_modules" / "vite").mkdir(parents=True)
    made_up_venv(seed / "backend" / ".venv")
    (tmp_path / "browser-home").mkdir()
    (tmp_path / "browser-home" / "checkout").write_text(f"{seed}\n")
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(tmp_path / "browser-home"))
    shutil.rmtree(b / "frontend" / "node_modules")
    shutil.rmtree(b / "backend" / ".venv")
    other = tmp_path / "other"
    (other / "browser" / "frontend").mkdir(parents=True)
    (other / "browser" / "backend").mkdir()
    assert FX._checks(other, ["browser/frontend/src/App.tsx"], "v0.10.3")[0] == page
    assert [x.name for x in (other / "browser" / "frontend" / "node_modules").iterdir()] == ["vite"]
    assert (other / "browser" / "backend" / ".venv").resolve() == (seed / "backend" / ".venv").resolve()


def test_the_python_the_sandbox_reads_includes_each_link_on_the_way_to_it(tmp_path):
    """A uv environment's python names uv's folder of its minor version, itself a link to the folder of the patch: the
    sandbox reads the link's folder by its own name, or the program is not there."""
    real = tmp_path / "uv" / "cpython-3.14.6-made-up"
    (real / "bin").mkdir(parents=True)
    os.symlink(sys.executable, real / "bin" / "python3.14")
    (tmp_path / "uv" / "cpython-3.14-made-up").symlink_to(real, target_is_directory=True)
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").symlink_to(tmp_path / "uv" / "cpython-3.14-made-up" / "bin" / "python3.14")
    assert str(tmp_path / "uv" / "cpython-3.14-made-up") in FX._py_dirs(str(venv / "bin" / "python"))


# a made-up server of the browser workbench: its start (app.main) loads the error log, and its checks' tests pass
SERVER = {
    "browser/backend/app/__init__.py": "",
    "browser/backend/app/notebook.py": "def active_notebook_id() -> str:\n    return 'made-up'\n",
    "browser/backend/app/errors.py": "def error_line(text: str) -> str:\n    return text\n",
    "browser/backend/app/main.py": "from . import errors, notebook  # noqa: F401\n",
    "browser/backend/tests_public/test_prompts.py": "def test_made_up_prompts():\n    assert True\n",
    "browser/backend/tests_public/test_american_names.py": "def test_made_up_names():\n    assert True\n",
}
NAMES_THE_NOTEBOOK = ("from .notebook import active_notebook_id\n\n\ndef error_line(text: str) -> str:\n"
                      "    return f'{active_notebook_id()}: {text}'\n")


def test_a_fix_to_the_server_that_breaks_it_on_the_new_release_stays_off_and_done_checks_it_alike(world, monkeypatch):
    """A fix made in the workbench changes the server's error log to name the notebook; the next commit renames what it
    calls, in another file, so its change still applies, and the server no longer starts with it. carry checks it as
    done checks a fix to the server: it stays off, and the release runs."""
    monkeypatch.delenv("CLAUDECODE", raising=False)
    monkeypatch.setattr(FX, "sandbox_argv", lambda fid, **kw: ["/bin/bash", "-c"])
    release_with(world, SERVER)
    r = FX.new("say which notebook an error came from", made_in="browser")
    made_up_venv(FX.live_dir() / "browser" / "backend" / ".venv")
    (Path(r["work"]) / "browser" / "backend" / "app" / "errors.py").write_text(NAMES_THE_NOTEBOOK)
    assert FX.done(r["id"], "Error log names the notebook", "")["state"] == "ready"
    FX.apply(r["id"], press(r["id"]))
    # from now on the checks are thimble's own
    monkeypatch.delenv("THIMBLE_FIX_TESTS")
    # the person pulls a commit that renames the notebook's id: the fix's change applies, and app.main no longer loads
    new = commit_in_checkout(world, {"browser/backend/app/notebook.py": "def notebook_id() -> str:\n    return 'made-up'\n"},
                             "made-up work")
    out = FX.update()
    assert (out["back"], out["aside"]) == ([], [r["id"]])
    assert (FX.get(r["id"])["state"], FX.get(r["id"])["error"]) == ("pending", f"it does not fit thimble main at {new[:7]}")
    assert "active_notebook_id" not in live_file("browser/backend/app/errors.py")
    # the same change made as a fix on the new release fails done's checks, with the server's own words
    s = FX.new("say which notebook an error came from, again")
    (Path(s["work"]) / "browser" / "backend" / "app" / "errors.py").write_text(NAMES_THE_NOTEBOOK)
    s = FX.done(s["id"], "Error log names the notebook", "")
    assert s["state"] == "failed" and "cannot import name 'active_notebook_id'" in s["tests_tail"]


def test_thimble_browser_puts_back_the_fixes_an_update_set_aside_before_it_builds_the_page(tmp_path):
    """The launcher, run from live (as the hand-off runs it), with a stand-in for the plugin's launcher, npm and the
    server's Python, each of which logs what it is asked, in order."""
    th, home = tmp_path / "th", tmp_path / "home"
    live = th / "fixes" / "live"
    log = tmp_path / "steps.log"
    b = live / "browser"
    (b / "scripts").mkdir(parents=True)
    shutil.copy(LAUNCHER, b / "scripts" / "thimble-browser")
    for p, word in ((live / "plugin" / "bin" / "thimble", "kernel"), (b / "backend" / ".venv" / "bin" / "python", "server"),
                    (tmp_path / "bin" / "npm", "npm")):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f'#!/bin/sh\necho "{word} $* THIMBLE_HOME=$THIMBLE_HOME" >> "{log}"\n')
        p.chmod(0o755)
    (b / "frontend" / "src").mkdir(parents=True)
    (b / "frontend" / "src" / "App.tsx").write_text("made-up\n")
    (b / "frontend" / "index.html").write_text("made-up\n")
    (b / "frontend" / "dist").mkdir()
    (b / "frontend" / "dist" / "index.html").write_text("made-up\n")
    old = time.time() - 100
    for p in ((b / "frontend" / "src" / "App.tsx"), (b / "frontend" / "index.html")):
        os.utime(p, (old, old))
    cur = th / "fixes" / "pending" / "current.json"
    cur.parent.mkdir(parents=True)
    cur.write_text(json.dumps({"version": "0.10.3", "ids": [1], "tip": "made-up"}, indent=1) + "\n")
    data = tmp_path / "data"
    data.mkdir()
    env = {"HOME": str(home), "THIMBLE_HOME": str(th), "THIMBLE_BROWSER_HOME": str(tmp_path / "bh"),
           "PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin", "THIMBLE_BROWSER_LIVE": "1"}
    p = subprocess.run(["bash", str(b / "scripts" / "thimble-browser"), str(data)], capture_output=True, text=True, env=env,
                       cwd=data)
    assert p.returncode == 0, p.stderr
    steps = log.read_text().splitlines()
    assert steps == [f"kernel fix carry THIMBLE_HOME={th}",
                     f"server -m app.cli browser --cwd {data.resolve()} --session new THIMBLE_HOME={tmp_path / 'bh'}"]
    # carried: the next start runs no carry
    cur.write_text(json.dumps({"version": "0.10.3", "ids": [1], "tip": "made-up", "carried": True}, indent=1) + "\n")
    log.write_text("")
    subprocess.run(["bash", str(b / "scripts" / "thimble-browser"), str(data)], capture_output=True, text=True, env=env, cwd=data)
    assert [x.split()[0] for x in log.read_text().splitlines()] == ["server"]


def browser_fix(world, publish, monkeypatch, tmp_path) -> tuple[int, Path]:
    """The browser workbench installed (its home, and fakes for uv and npm that log what they are asked), and a fix on
    that changes its page; then 0.10.3, and an update by 0.10.2. The fix, and the log."""
    monkeypatch.delenv("CLAUDECODE", raising=False)
    (tmp_path / "browser-home").mkdir()
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(tmp_path / "browser-home"))
    log = tmp_path / "pkg.log"
    for name in ("uv", "npm"):
        fake(world["bin"] / name, log)
    monkeypatch.setenv("PATH", f"{world['bin']}:{os.environ['PATH']}")
    r = FX.new("the tab names the folder")
    page = Path(r["work"]) / "browser" / "frontend" / "src" / "App.tsx"
    page.parent.mkdir(parents=True)
    page.write_text("document.title = 'made-up'\n")
    FX.done(r["id"], "The tab names the folder", "")
    FX.apply(r["id"], press(r["id"]))
    publish({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    return r["id"], log


def test_a_fix_of_the_page_that_a_list_puts_back_waits_for_thimble_browser_to_build_it(world, upstream, monkeypatch, tmp_path):
    a, log = browser_fix(world, upstream, monkeypatch, tmp_path)
    # a list builds nothing: thimble-browser builds the page at its next start
    assert FX.list_lines(120)[:2] == [
        f"Fix {a} fits thimble 0.10.3 and is on again.",
        "In Claude Code, type /reload-plugins to load them; restart thimble-browser for the browser."]
    assert not log.exists() and FX.get(a)["state"] == "on"
    assert live_file("browser/frontend/src/App.tsx") == "document.title = 'made-up'\n"


def test_a_fix_of_the_page_that_thimble_update_puts_back_builds_it(world, upstream, monkeypatch, tmp_path):
    a, log = browser_fix(world, upstream, monkeypatch, tmp_path)
    out = FX.update()
    b = FX.live_dir() / "browser"
    assert out["lines"] == ["thimble 0.10.3 is the newest release.",
                            "Your fix fits thimble 0.10.3 and is on again: The tab names the folder.",
                            "In Claude Code, type /reload-plugins to load them; restart thimble-browser for the browser."]
    assert log.read_text().splitlines()[-1] == f"--prefix {b / 'frontend'} run build"
    assert (FX.home() / "browser-ready").read_text().strip() == str(b)


def test_reapply_while_every_fix_is_off_brings_the_fix_back_and_keeps_it_off(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    FX.all_off()
    # 0.10.3 has its own legend on the line fix c changed
    new = upstream({"plugin/legend.ts": "const legend = `quiet ${n} files`\n"}, "v0.10.3")
    update_as_before()
    rows = FX.list_lines(120)
    assert rows[0] == f"Fixes {a} and {b} fit thimble 0.10.3 and stay off, as you had them."
    assert f"  fix {c} is off: it does not fit thimble 0.10.3" in rows
    live = FX.live_dir()
    assert sh("git", "rev-parse", "HEAD", cwd=live) == new and not FX.is_on()
    # thimble reapply: Claude works on mine, as when the fixes are on
    FX.reapply_argv()
    assert sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=live) == "mine"
    (live / "plugin" / "legend.ts").write_text("const legend = `quiet ${n} files · untouched ${m}`\n")
    sh("git", "commit", "-q", "-am", "Legend counts untouched", cwd=live)
    done = FX.continue_()
    assert done["recorded"] == [c] and done["reload"] is False and len(done["lines"]) == 1
    assert done["lines"][0].startswith("Recorded 1 fix on thimble 0.10.3, kept off, as you had your fixes; thimble fix on "
                                       "turns them on: Legend counts untouched (")
    # still off, as the person had them: live shows the release; thimble fix on brings all three back
    assert not FX.is_on() and sh("git", "rev-parse", "HEAD", cwd=live) == new
    FX.all_on()
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and "untouched ${m}" in live_file("plugin/legend.ts")
    assert sh("git", "rev-parse", "mine~3", cwd=live) == new


def test_after_a_dev_update_to_a_release_tag_every_line_names_the_release(world, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    # the person pulls 0.10.3 into their clone (scripts/install.sh --local): it changed the bar's line
    new = commit_in_checkout(world, {"plugin/bar/bar.tsx": "const words = `seen ${n}`\n"}, "thimble 0.10.3")
    sh("git", "tag", "v0.10.3", new, cwd=world["rel"])
    # the update of thimble 0.10.5's kernel: it set the fix aside, and said nothing of why
    with monkeypatch.context() as m:
        m.setattr(FX, "_carry", lambda sync=True, say=None: None)
        assert FX.update()["aside"] == [a]
    assert FX.get(a)["error"] is None
    # the list names the release the checkout is at, as the fix's line does
    rows = FX.list_lines(120)
    assert rows[0].startswith("Your thimble fixes · thimble 0.10.3 with 1 off")
    assert f"  fix {a} is off: it does not fit thimble 0.10.3" in rows


def test_a_dev_update_checks_the_fixes_on_the_checkouts_commit(world, monkeypatch, tmp_path):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    b = fix_of("a note", "plugin/notes.md", "made-up note\n", "A note")
    # the person pulls a commit whose new rule the bar's word breaks, though the fix's change applies
    new = commit_in_checkout(world, {"plugin/rule.md": "the bar says coverage\n"}, "made-up work")
    log = checks_that_fail_on(monkeypatch, tmp_path, "test -f plugin/rule.md && grep -qs 'read ' plugin/bar/bar.tsx")
    out = FX.update()
    to = f"main at {new[:7]}"
    assert (out["back"], out["had"], out["aside"]) == ([b], [], [a]) and runs(log) == 6
    assert (FX.get(a)["state"], FX.get(a)["error"]) == ("pending", f"it does not fit thimble {to}")
    assert FX.get(b)["state"] == "on" and sh("git", "rev-parse", "mine^", cwd=FX.live_dir()) == new
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert f"1 local fix does not fit {to}, so it is off: Bar says read." in out["lines"]


def test_thimble_update_installs_the_workbench_of_the_new_release_before_it_checks_a_fix_to_the_page(world, upstream, monkeypatch, tmp_path):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    (tmp_path / "browser-home").mkdir()
    monkeypatch.setenv("THIMBLE_BROWSER_HOME", str(tmp_path / "browser-home"))
    log = tmp_path / "steps.log"
    # npm and uv log what they are asked, and install a folder of packages as they would
    fake(world["bin"] / "npm", log, '[ "$3" = ci ] && mkdir -p "$2/node_modules"')
    fake(world["bin"] / "uv", log, '[ "$1" = sync ] && mkdir -p "$3/.venv"')
    monkeypatch.setenv("PATH", f"{world['bin']}:{os.environ['PATH']}")
    a = fix_of("the tab names the folder", "browser/frontend/src/App.tsx", "document.title = 'made-up'\n",
               "The tab names the folder")
    # 0.10.3 has the workbench, with page packages of its own
    upstream({"browser/frontend/package-lock.json": "made-up lock\n", "browser/backend/uv.lock": "made-up lock\n"}, "v0.10.3")
    monkeypatch.setenv("THIMBLE_FIX_TESTS", f"echo check >> '{log}'")
    out = FX.update()
    fe = FX.live_dir() / "browser" / "frontend"
    steps = [x for x in log.read_text().splitlines() if not x.startswith("sync ")]
    # the page's packages and its build for 0.10.3 come first, then the fix's check, then the build with the fix
    assert steps == [f"--prefix {fe} ci --no-audit --no-fund", f"--prefix {fe} run build", "check", f"--prefix {fe} run build"]
    assert out["back"] == [a] and out["browser"] == "ready" and FX.get(a)["state"] == "on"
