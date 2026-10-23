"""thimble file pr (engine/kernel/share.py): the warning, the preview and the y/N before anything is sent, the privacy
scan of the text and of the code, gh missing or signed out, a fork or a branch on the repository, and the pull request's
link on the fix's record. gh is a fake that logs its arguments, and the remotes are local bare repositories: nothing
reaches GitHub. The world is test_fixes.py's made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fixes import FX, made, press, sh, world  # noqa: E402, F401  (world is the fixture)

from kernel import cli as CLI  # noqa: E402
from kernel import share as SH  # noqa: E402

DRAFT = {"title": "Bar says read for coverage",
         "wrong": "After Claude read board-7.jsonl, the bar's item still said coverage.",
         "fixed": "The bar's coverage item now says read."}
PR_URL = "https://github.com/safety-research/thimble/pull/77"
GH = """#!/bin/sh
echo "$@" >> '{log}'
case "$1 $2" in
  "auth status") [ -f '{signed_out}' ] && {{ echo "You are not logged into any GitHub hosts" >&2; exit 1; }}; exit 0;;
  "api user") echo '{{"login": "made-up", "id": 42}}';;
  "repo view") cat '{perm}' 2>/dev/null || echo READ;;
  "repo fork") echo "made-up/thimble already exists";;
  "pr create") echo "{url}";;
esac
exit 0
"""


@pytest.fixture
def gh(world, monkeypatch, tmp_path):
    """A fake gh, two bare repositories as GitHub (the person's fork and the repository itself), and a shell of the
    person's own: no Claude Code, a folder of its own, no terms of theirs unless a test gives some."""
    d = tmp_path / "gh"
    d.mkdir()
    log, signed_out, perm = d / "gh.log", d / "signed-out", d / "perm"
    exe = d / "gh"
    exe.write_text(GH.format(log=log, signed_out=signed_out, perm=perm, url=PR_URL))
    exe.chmod(0o755)
    remotes = tmp_path / "remotes"
    for owner in ("made-up", "safety-research"):
        sh("git", "init", "-q", "--bare", str(remotes / f"{owner}.git"))
    # the repository's main is the release the world runs, until a test moves the person's checkout on
    sh("git", "push", "-q", str(remotes / "safety-research.git"), "main", cwd=world["rel"])
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(remotes / "safety-research.git"))
    monkeypatch.setenv("THIMBLE_GH", str(exe))
    monkeypatch.setenv("THIMBLE_FIX_PUSH_URL", str(remotes / "{owner}.git"))
    monkeypatch.delenv("CLAUDECODE", raising=False)
    monkeypatch.delenv("THIMBLE_ROOT", raising=False)
    (tmp_path / "shell").mkdir()
    monkeypatch.chdir(tmp_path / "shell")
    monkeypatch.setattr(FX, "session_terms", lambda st: {})
    return {"log": log, "signed_out": signed_out, "perm": perm, "remotes": remotes}


def calls(g) -> list[str]:
    return g["log"].read_text().splitlines() if g["log"].exists() else []


def fix_on(w, extra: str = "") -> dict:
    r = made(w)
    if extra:
        p = Path(r["work"]) / "plugin" / "bar" / "bar.tsx"
        p.write_text(p.read_text() + extra)
    FX.done(r["id"], "Bar says read", "The bar's coverage item says read.")
    FX.apply(r["id"], press(r["id"]))
    FX.write_json(SH.share_dir(r["id"]) / "given.json", DRAFT)
    return FX.get(r["id"])


def answer(monkeypatch, said: str | None) -> list[str]:
    asked: list[str] = []
    monkeypatch.setattr(SH, "pr_ask", lambda q: asked.append(q) or said)
    return asked


def branches(g, owner: str) -> list[str]:
    """The branches a pull request pushed (the repository's own main left out)."""
    refs = sh("git", "for-each-ref", "--format=%(refname)", "refs/heads/", cwd=g["remotes"] / f"{owner}.git").split()
    return [r for r in refs if r != "refs/heads/main"]


def ahead(w, path: str = "plugin/notes.md", text: str = "made-up notes\n" * 400) -> str:
    """The person's checkout moves on past main (a dev install): a commit that is not on the repository's main, which
    the thimble they run is made from. Its commit."""
    f = w["rel"] / path
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
    sh("git", "add", "-A", cwd=w["rel"])
    sh("git", "commit", "-q", "-m", "work not on main", cwd=w["rel"])
    head = sh("git", "rev-parse", "HEAD", cwd=w["rel"])
    p = w["cc"] / "plugins" / "installed_plugins.json"
    p.write_text(p.read_text().replace(w["base"], head))
    return head


def test_it_warns_shows_what_would_go_and_no_sends_nothing(world, gh, monkeypatch, capsys):
    rec = fix_on(world)
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["board-7.jsonl"]})
    asked = answer(monkeypatch, "")
    assert CLI.main(["file", "pr", str(rec["id"])]) == 0
    out = capsys.readouterr().out
    assert "\x1b[" not in out  # plain text off a terminal
    lines = out.splitlines()
    warning = " ".join(lines[:lines.index("")])
    assert warning == ("This posts fix 1's code change publicly: as a pull request on the public repository "
                       "safety-research/thimble, from your GitHub account (made-up). Anyone can read the code and the text.")
    assert "  Title    Bar says read for coverage" in lines
    assert f"  Branch   thimble-fix-1-bar-says-read-for-coverage, on thimble 0.10.2 ({world['base'][:7]})" in lines
    assert "  Files    plugin/bar/bar.tsx  +1 −1" in lines
    # the body: share's text, the person's data file taken out, with the line that says how it was opened
    assert "    ### What was wrong" in lines and "    After Claude read ‹data file›, the bar's item still said coverage." in lines
    assert "    ### How it was fixed" in lines
    assert f"    Opened with `thimble file pr`, on thimble 0.10.2 (`{world['base'][:7]}`)." in lines
    assert "board-7.jsonl" not in out
    assert "  ✓ privacy check: took 1 file name out of the text; nothing of yours in the code" in lines
    assert asked == ["\nOpen this pull request on safety-research/thimble? [y/N] "]
    assert lines[-1] == "Nothing was sent."
    # no: gh only checked the sign-in; nothing forked, pushed or opened, and nothing recorded
    assert calls(gh) == ["auth status", "api user"]
    assert branches(gh, "made-up") == [] and branches(gh, "safety-research") == []
    assert "pr" not in FX.get(rec["id"]) and not (SH.share_dir(rec["id"]) / "pr.json").exists()
    # no terminal to ask in and no --yes: refused, nothing sent
    answer(monkeypatch, None)
    assert CLI.main(["file", "pr", str(rec["id"])]) == 1
    assert "add --yes to open it without the question" in capsys.readouterr().err
    assert branches(gh, "made-up") == []


def test_yes_forks_pushes_and_opens_the_pr_then_records_its_link(world, gh, monkeypatch, capsys):
    rec = fix_on(world)
    asked = answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 0
    assert asked == []
    out = capsys.readouterr().out.splitlines()
    assert out[-1] == f"✓ Opened the pull request: {PR_URL}"
    # no push access: a fork, the branch there, the pull request from it against main
    log = calls(gh)
    assert "repo view safety-research/thimble --json viewerPermission -q .viewerPermission" in log
    assert "repo fork safety-research/thimble --clone=false" in log
    create = next(x for x in log if x.startswith("pr create"))
    assert "--repo safety-research/thimble --base main --head made-up:thimble-fix-1-bar-says-read-for-coverage" in create
    assert branches(gh, "safety-research") == []
    (ref,) = branches(gh, "made-up")
    assert ref == "refs/heads/thimble-fix-1-bar-says-read-for-coverage"
    fork = gh["remotes"] / "made-up.git"
    # one commit on the release commit, by the person's GitHub noreply address, holding the fix's change
    assert sh("git", "rev-parse", f"{ref}^", cwd=fork) == world["base"]
    assert sh("git", "log", "-1", "--format=%an <%ae>|%s", ref, cwd=fork) == \
        "made-up <42+made-up@users.noreply.github.com>|Bar says read for coverage"
    assert "+const words = `read ${n}`" in sh("git", "show", ref, cwd=fork)
    # recorded: on the fix (show and list say so) and in share/<id>/pr.json; the temporary repository is gone
    assert FX.get(rec["id"])["pr"] == PR_URL
    assert FX.read_json(SH.share_dir(rec["id"]) / "pr.json")["url"] == PR_URL
    assert list((FX.home() / "pr").iterdir()) == []
    assert f"  Pull request  {PR_URL}" in FX.show_lines(rec["id"])
    listed = FX.list_lines()
    assert f"  fix 1 has a pull request: {PR_URL}" in listed
    # one fix: nothing to merge, and no second pull request to suggest
    assert not any("fix merge" in x or "file pr" in x for x in listed)
    # the person's own clone has no new remote or branch, and live is where it was
    assert sh("git", "remote", cwd=world["rel"]) == ""
    assert "thimble-fix" not in sh("git", "branch", "-a", cwd=world["rel"])
    # a second pull request for the same fix is refused with the first one's link
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    assert f"fix 1 has a pull request already: {PR_URL}" in capsys.readouterr().err


def test_on_a_checkout_ahead_of_main_the_pr_holds_only_the_fix_on_main_s_tip(world, gh, monkeypatch, capsys):
    head = ahead(world)
    rec = fix_on(world)
    assert sh("git", "rev-parse", "mine^", cwd=FX.live_dir()) == head  # the fix sits on the person's checkout
    answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert f"  Branch   thimble-fix-1-bar-says-read-for-coverage, on thimble 0.10.2 ({world['base'][:7]})" in out
    assert out[-1] == f"✓ Opened the pull request: {PR_URL}"
    (ref,) = branches(gh, "made-up")
    fork = gh["remotes"] / "made-up.git"
    # one commit on main's tip, not on the checkout: the pull request's diff against main is the fix alone
    assert sh("git", "rev-parse", f"{ref}^", cwd=fork) == world["base"]
    assert sh("git", "diff", "--stat", world["base"], ref, cwd=fork).splitlines()[-1].strip() == \
        "1 file changed, 1 insertion(+), 1 deletion(-)"
    assert "plugin/notes.md" not in sh("git", "show", "--stat", ref, cwd=fork)
    # live and the person's clone are as they were
    assert sh("git", "rev-parse", "mine^", cwd=FX.live_dir()) == head
    assert sh("git", "rev-parse", "HEAD", cwd=world["rel"]) == head


def test_a_newer_main_takes_the_fix_named_by_its_version(world, gh, monkeypatch, capsys):
    # main moves on (a release after the one the person runs): the fix goes onto it, named by its version
    up = world["tmp"] / "up"
    sh("git", "clone", "-q", "-b", "main", str(gh["remotes"] / "safety-research.git"), str(up))
    pj = up / "plugin" / ".claude-plugin" / "plugin.json"
    pj.write_text(pj.read_text().replace("0.10.2", "0.10.3"))
    sh("git", "commit", "-q", "-am", "thimble 0.10.3", cwd=up)
    sh("git", "push", "-q", "origin", "main", cwd=up)
    tip = sh("git", "rev-parse", "HEAD", cwd=up)
    rec = fix_on(world)
    answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert f"  Branch   thimble-fix-1-bar-says-read-for-coverage, on thimble 0.10.3 ({tip[:7]})" in out
    (ref,) = branches(gh, "made-up")
    assert sh("git", "rev-parse", f"{ref}^", cwd=gh["remotes"] / "made-up.git") == tip


def test_a_change_that_does_not_apply_on_main_is_refused_before_anything_goes(world, gh, monkeypatch, capsys):
    # the checkout changed the line the fix changes, and main never had that change
    ahead(world, "plugin/bar/bar.tsx", "const words = `coverage ${n} files`\n")
    rec = fix_on(world)
    asked = answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(rec["id"])]) == 1
    cap = capsys.readouterr()
    assert cap.err.strip() == (
        f"thimble file pr: fix 1's change does not apply to the newest thimble (0.10.2, {world['base'][:7]} on main), "
        "which a pull request goes onto: the lines it changes are different there. Ask /thimble-fix to make it work on "
        "the newest thimble (thimble update moves you to it), then try again")
    assert asked == [] and cap.out == "" and calls(gh) == ["auth status", "api user"]
    assert branches(gh, "made-up") == [] and "pr" not in FX.get(rec["id"])


def test_a_fix_that_builds_on_another_fix_says_so(world, gh, monkeypatch, capsys):
    fix_on(world)
    b = FX.new("say files read")
    p = Path(b["work"]) / "plugin" / "bar" / "bar.tsx"
    p.write_text(p.read_text().replace("read ${n}", "read ${n} files"))
    FX.done(b["id"], "Bar says files read", "The bar says files read.")
    FX.apply(b["id"], press(b["id"]))
    FX.write_json(SH.share_dir(b["id"]) / "given.json", DRAFT)
    answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(b["id"]), "--yes"]) == 1
    assert capsys.readouterr().err.strip() == (
        "thimble file pr: fix 2's change does not apply to thimble 0.10.2 alone: it builds on another of your fixes. "
        "Ask /thimble-fix to make it work on the release by itself")
    assert branches(gh, "made-up") == []


def test_main_out_of_reach_refuses_with_the_reason(world, gh, monkeypatch, capsys):
    rec = fix_on(world)
    monkeypatch.setenv("THIMBLE_UPDATE_URL", str(gh["remotes"] / "no-such.git"))
    answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    err = capsys.readouterr().err
    assert "thimble file pr: thimble could not read main from" in err and "check the network, then try again" in err
    assert branches(gh, "made-up") == []


def test_with_push_access_the_branch_goes_on_the_repository_with_no_fork(world, gh, monkeypatch, capsys):
    rec = fix_on(world)
    gh["perm"].write_text("WRITE\n")
    answer(monkeypatch, "yes")
    assert CLI.main(["file", "pr", str(rec["id"])]) == 0
    assert capsys.readouterr().out.splitlines()[-1] == f"✓ Opened the pull request: {PR_URL}"
    log = calls(gh)
    assert not any(x.startswith("repo fork") for x in log)
    assert "--head thimble-fix-1-bar-says-read-for-coverage --title" in next(x for x in log if x.startswith("pr create"))
    assert branches(gh, "safety-research") == ["refs/heads/thimble-fix-1-bar-says-read-for-coverage"]
    assert branches(gh, "made-up") == []


def test_a_detail_of_the_persons_in_the_code_refuses_and_names_each_one(world, gh, monkeypatch, capsys):
    rec = fix_on(world, "// seen in " + "/ho" + "me/dana/data/board-7.jsonl\nconst who = 'dana'\n")
    monkeypatch.setattr(FX, "session_terms", lambda st: {"file": ["board-7.jsonl"], "name": ["dana"]})
    asked = answer(monkeypatch, "y")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    out = capsys.readouterr().out.splitlines()
    i = next(i for i, x in enumerate(out) if x.startswith("  ✗ privacy check:"))
    j = next(j for j in range(i, len(out)) if out[j].startswith("      "))
    assert " ".join(x.strip() for x in out[i:j]) == (
        "✗ privacy check: took 1 file name out of the text, but the code holds 2 details of yours, which thimble cannot "
        "take out of code:")
    i = j - 1
    assert out[i + 1] == "      path '" + "/ho" + "me/dana/data/board-7.jsonl' in plugin/bar/bar.tsx, line 2"
    assert out[i + 2] == "      name 'dana' in plugin/bar/bar.tsx, lines 2 and 3"
    assert out[-2:] == ["Nothing was sent. You can turn fix 1 off (thimble fix off 1),",
                        "or ask /thimble-fix to change it: /thimble-fix 1 take my details out of the code"]
    assert asked == [] and not any(x.startswith(("repo", "pr")) for x in calls(gh))
    assert branches(gh, "made-up") == [] and "pr" not in FX.get(rec["id"])


def test_gh_missing_or_signed_out_says_how_in_one_line(world, gh, monkeypatch, capsys):
    rec = fix_on(world)
    answer(monkeypatch, "y")
    monkeypatch.setenv("THIMBLE_GH", str(gh["log"].parent / "no-such-gh"))
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    err = capsys.readouterr().err.strip().splitlines()
    assert err == ["thimble file pr: this needs gh, GitHub's command line tool: install it (https://cli.github.com), "
                   "then run gh auth login"]
    monkeypatch.setenv("THIMBLE_GH", str(gh["log"].parent / "gh"))
    gh["signed_out"].write_text("")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    cap = capsys.readouterr()
    assert cap.err.strip().splitlines() == ["thimble file pr: gh is not signed in to GitHub: run gh auth login, then try again"]
    assert cap.out == "" and calls(gh) == ["auth status"] and branches(gh, "made-up") == []


def test_a_fix_with_no_change_to_send_and_claude_code_are_refused(world, gh, monkeypatch, capsys):
    answer(monkeypatch, "y")
    # still being made
    w = FX.new("make the minimap smaller")
    assert CLI.main(["file", "pr", str(w["id"]), "--yes"]) == 1
    assert "fix 1 is working: only a fix that is on or ready has a change to open a pull request with" in capsys.readouterr().err
    # a request with no code
    q = FX.done(FX.new("explain the terms of my field")["id"], "Explain terms of my field", "It needs the person's words.",
                request=True)
    assert CLI.main(["file", "pr", str(q["id"]), "--yes"]) == 1
    err = capsys.readouterr().err
    assert f"fix {q['id']} is request" in err or f"fix {q['id']} has no code change" in err
    # off: not on or ready
    rec = fix_on(world)
    FX.one_off(rec["id"])
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    assert f"fix {rec['id']} is off: only a fix that is on or ready" in capsys.readouterr().err
    # Claude Code's Bash tool (and the person's ! in it): refused before gh runs, --yes or not
    monkeypatch.setenv("CLAUDECODE", "1")
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 1
    assert "runs in a shell, not inside Claude Code" in capsys.readouterr().err
    assert calls(gh) == []


def test_help_lists_it(world, capsys, monkeypatch):
    monkeypatch.setattr(FX, "can_share", lambda: True)
    assert CLI.main(["--help"]) == 0
    assert ("\n    thimble file pr N              open a pull request with fix N's code on the public repo (asks first)"
            in capsys.readouterr().out)
    with pytest.raises(SystemExit):
        CLI.main(["fix", "--help"])
    assert "thimble file pr N [--yes]" in capsys.readouterr().out
    monkeypatch.setattr(FX, "can_share", lambda: False)
    assert CLI.main(["--help"]) == 0 and "thimble file pr" not in capsys.readouterr().out
