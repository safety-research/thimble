"""thimble file pr (engine/kernel/share.py): y forks thimble's repository, pushes the fix and opens the pull request,
whose link goes on the fix's record; a detail of the person's in the code refuses before anything is sent. gh is a
fake that logs its arguments, and the remotes are local bare repositories: nothing reaches GitHub. The world is
test_fixes.py's made-up thimble 0.10.2. All data here is made up."""
from __future__ import annotations

import json
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


def test_a_pr_from_an_install_made_from_a_release_file_goes_onto_main_and_names_the_release(world, gh, monkeypatch,
                                                                                              tmp_path):
    """An install from a release's file has a live with none of GitHub's history: its release commit has no parent,
    and its id is the person's own. A pull request fetches main into live, goes onto main's tip, and its text names
    the release by its tag, as GitHub knows it."""
    remote = gh["remotes"] / "safety-research.git"
    work = tmp_path / "release-work"
    sh("git", "clone", "-q", "-b", "main", str(remote), str(work))
    # a release's manifest names no version: the release is its tag
    (work / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "thimble"}, indent=2) + "\n")
    sh("git", "commit", "-q", "-am", "thimble 0.10.2", cwd=work)
    sh("git", "tag", "v0.10.2", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", "v0.10.2", cwd=work)
    tip = sh("git", "rev-parse", "HEAD", cwd=work)
    dist = tmp_path / "dist"
    sh("bash", str(Path(__file__).resolve().parents[2] / "scripts" / "release-file.sh"), "v0.10.2", str(dist), cwd=remote)
    rel = FX.ensure_live({"kind": "release", "file": str(dist / "thimble-0.10.2.tar.gz"), "tag": "v0.10.2", "ref": "",
                          "source": "https://github.com/safety-research/thimble/releases/download/v0.10.2/"
                                    "thimble-0.10.2.tar.gz"})
    made = rel["base"]
    assert sh("git", "rev-list", "--count", "--all", cwd=FX.live_dir()) == "1" and rel["commit"] == tip
    rec = fix_on(world)
    assert CLI.main(["file", "pr", str(rec["id"]), "--yes"]) == 0
    (ref,) = branches(gh, "made-up")
    fork = gh["remotes"] / "made-up.git"
    assert sh("git", "rev-parse", f"{ref}^", cwd=fork) == tip
    assert "+const words = `read ${n}`" in sh("git", "show", ref, cwd=fork)
    body = FX.read_json(SH.share_dir(rec["id"]) / "pr.json")["body"]
    assert "thimble 0.10.2 · terminal · fixed by `thimble fix`" in body, body
    assert f"on thimble 0.10.2 (`{tip[:7]}`)" in body and made[:7] not in body
    issue = SH.share(rec["id"])["body"]
    assert issue.rstrip().endswith("thimble 0.10.2 · terminal · fixed by `thimble fix`") and made[:7] not in issue
