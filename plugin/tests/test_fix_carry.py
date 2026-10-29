"""The fixes an update set aside go back on where they still apply (fixes.py carry). thimble 0.10.5 and before ran their
own kernel for thimble update, which set every fix aside and stopped there: this kernel puts back what still applies
at the first command that reads or changes the fixes, says what does not fit and why, and keeps the fixes off that the
person had turned off. The world is test_fixes.py's made-up thimble 0.10.2, a GitHub install; `claude` is a fake. All data
here is made up."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, calls, fake, live_file, made, on_fix, press, sh, three_fixes, upstream, world  # noqa: E402, F401


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


def test_the_first_list_after_an_older_update_puts_back_what_fits_and_says_what_does_not(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    # 0.10.3 has the note as fix b made it, and its own legend on the line fix c changed; 0.10.2's own update ran
    new = upstream({"plugin/notes.md": "made-up note\n", "plugin/legend.ts": "const legend = `quiet ${n} files`\n"},
                   "v0.10.3")
    assert update_as_before() == [a, b, c]
    assert {FX.get(i)["state"] for i in (a, b, c)} == {"pending"}
    live = FX.live_dir()
    before = len(calls(world))
    # thimble fixes, the person's next look: the bar's word fits 0.10.3 and is on again, the note is 0.10.3's own, and
    # the legend does not fit it, with why, for thimble reapply
    rows = FX.list_lines(120)
    assert rows[:6] == [
        "Your fix fits thimble 0.10.3 and is on again: Bar says read.",
        "Already in thimble 0.10.3, so it leaves thimble fixes: A note.",
        "Off, as it does not fit thimble 0.10.3: Legend counts untouched. thimble reapply has Claude fit it.",
        "In Claude Code, type /reload-plugins to load them.", "",
        "Your thimble fixes · thimble 0.10.3 with 1 on, 1 off"]
    assert f"  fix {c} is off: it does not fit thimble 0.10.3" in rows
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
    # once: the next look says nothing of it and changes nothing, and neither does thimble update
    head = sh("git", "rev-parse", "mine", cwd=live)
    assert FX.list_lines(120)[0] == "Your thimble fixes · thimble 0.10.3 with 1 on, 1 off"
    assert FX.listing()["carried"] is None
    assert FX.update()["lines"] == ["thimble 0.10.3 is the newest release."]
    assert sh("git", "rev-parse", "mine", cwd=live) == head and calls(world)[before:] == ["plugin update thimble@thimble"]
    # thimble reapply has Claude fit the legend alone
    text = FX.reapply_argv()["argv"][1]
    assert "thimble set aside 1 fix of theirs" in text and "Legend counts untouched" in text and "Bar says read" not in text


def test_thimble_update_after_an_older_update_puts_back_what_fits(world, upstream, monkeypatch, capsys):
    from kernel import cli  # noqa: PLC0415

    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    # the person runs thimble update again, with this kernel: the release is the newest, and the fix goes back on
    assert cli.main(["update"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "thimble 0.10.3 is the newest release.", "Your fix fits thimble 0.10.3 and is on again: Bar says read.",
        "In Claude Code, type /reload-plugins to load them."]
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
        "Your 3 fixes fit thimble 0.10.3 and are on again: Bar says read; A note; Legend counts untouched.",
        "In Claude Code, type /reload-plugins to load them."]
    # no Claude Code opened: the fake's log has Claude Code's copy alone
    assert calls(world)[before:] == ["plugin update thimble@thimble"]
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on", "on", "on"]
    assert sh("git", "log", "--format=%s", "-3", "mine", cwd=FX.live_dir()).splitlines() == [
        "Legend counts untouched", "A note", "Bar says read"]
    assert cli.main(["reapply"]) == 1 and "no fixes are set aside" in capsys.readouterr().err


def test_fixes_turned_off_before_an_older_update_stay_off(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a, b, c = three_fixes(world)
    FX.all_off()
    new = upstream({"plugin/other.md": "made-up\n"}, "v0.10.3")
    update_as_before()
    # the older update said the fixes are on; live's HEAD log says where it came from: the plain release
    assert FX.is_on()
    rows = FX.list_lines(120)
    assert rows[0] == "Your 3 fixes fit thimble 0.10.3 and stay off, as you had them: Bar says read; A note; Legend counts untouched."
    assert rows[2] == "Your thimble fixes · thimble 0.10.3 with 3 off"
    live = FX.live_dir()
    assert not FX.is_on() and sh("git", "rev-parse", "HEAD", cwd=live) == new
    assert "coverage ${n}" in live_file("plugin/bar/bar.tsx")
    assert [FX.get(i)["state"] for i in (a, b, c)] == ["on", "on", "on"]
    # thimble fix on brings them back, on 0.10.3
    FX.all_on()
    assert "read ${n}" in live_file("plugin/bar/bar.tsx") and sh("git", "rev-parse", "mine~3", cwd=live) == new


def test_nothing_is_put_back_while_a_reapply_session_works_in_live(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    live = FX.live_dir()
    # Claude, in the session thimble reapply opened, changes the bar and has not committed yet
    (live / "plugin" / "bar" / "bar.tsx").write_text("const words = `read ${n} files`\n")
    assert FX.listing()["carried"] is None and FX.get(a)["state"] == "pending"
    # it committed: mine moved on from where the update left it, and the commit is for thimble update --continue
    sh("git", "commit", "-q", "-am", "Bar says read", cwd=live)
    assert FX.listing()["carried"] is None and FX.get(a)["state"] == "pending"
    assert FX.continue_()["recorded"] == [a] and FX.get(a)["state"] == "on"


def test_a_sent_fix_goes_back_on_as_sent(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)
    # thimble file pr sent it: it stays in mine, with its pull request
    FX.put({**a, "state": "sent", "pr": "https://github.com/made-up/thimble/pull/7"})
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()
    assert FX.listing()["carried"]["back"] == [a["id"]]
    r = FX.get(a["id"])
    assert (r["state"], r["pr"]) == ("sent", "https://github.com/made-up/thimble/pull/7")
    assert r["commit"] == sh("git", "rev-parse", "mine", cwd=FX.live_dir())


def test_the_way_back_runs_from_the_release_once_an_update_from_before_it_is_carried(world, upstream, monkeypatch, tmp_path):
    import shutil  # noqa: PLC0415

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
    assert FX.listing()["carried"]["back"] == [a]
    assert sh("git", "rev-parse", "HEAD", cwd=FX.release_dir()) == FX.release()["base"]
    assert Path(link.readlink()) == FX.release_dir() / "plugin" / "bin" / "thimble"


def test_a_list_that_cannot_put_fixes_back_still_lists_them(world, upstream, monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    a = on_fix(world)["id"]
    upstream({"plugin/notes.md": "made-up note\n"}, "v0.10.3")
    update_as_before()

    def broken(sync: bool = True):
        raise FX.FixError("git checkout failed: made-up")

    monkeypatch.setattr(FX, "_carry", broken)
    d = FX.listing()
    assert d["carried"] is None and [r["id"] for r in d["fixes"]] == [a] and FX.get(a)["state"] == "pending"
    with pytest.raises(FX.FixError, match="made-up"):
        FX.carry()


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
    # a list (the plugin's at session start has 30 s) builds nothing: thimble-browser builds the page at its next start
    assert FX.list_lines(120)[:2] == [
        "Your fix fits thimble 0.10.3 and is on again: The tab names the folder.",
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
    assert rows[:2] == ["Your 2 fixes fit thimble 0.10.3 and stay off, as you had them: Bar says read; A note.",
                        "Off, as it does not fit thimble 0.10.3: Legend counts untouched. thimble reapply has Claude fit it."]
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
