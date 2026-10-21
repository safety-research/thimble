"""Fix thimble from the browser (fixcopy.py): the agent's fix tools reach the fix's copy and nothing else, and the
draft of a change carries its files into the preview. gh and the push run through stubs (THIMBLE_GH, THIMBLE_GIT)
that only record their arguments: nothing is filed or pushed. All names and data are made up."""
import asyncio
import json
import os
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from thimble_browser import agent, fixcopy, issues
from thimble_browser.fixcopy import OutsideCopy, inside
from thimble_browser.kernel_fix import fix


# ---- the confinement, alone

@pytest.fixture
def copy(tmp_path):
    root = tmp_path / "copy"
    (root / "plugin" / "claims").mkdir(parents=True)
    (root / "plugin" / "claims" / "list.js").write_text("export const order = 'oldest'\n")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.txt").write_text("made-up secret\n")
    return root, outside


def test_a_path_inside_the_copy_resolves(copy):
    root, _ = copy
    assert inside(root, "plugin/claims/list.js") == (root / "plugin/claims/list.js").resolve()
    assert inside(root, str(root / "plugin")) == (root / "plugin").resolve()
    assert inside(root, "plugin/claims/../claims/list.js") == (root / "plugin/claims/list.js").resolve()
    # a new file, which does not exist yet
    assert inside(root, "plugin/claims/new_test.py") == (root / "plugin/claims/new_test.py").resolve()


@pytest.mark.parametrize("path", ["..", "../elsewhere/secret.txt", "plugin/../../elsewhere/secret.txt",
                                  "plugin/not-yet/../../../elsewhere", "/etc/passwd", "/"])
def test_dot_dot_and_absolute_paths_out_of_the_copy_are_refused(copy, path):
    root, _ = copy
    with pytest.raises(OutsideCopy):
        inside(root, path)


def test_an_absolute_path_to_a_sibling_with_the_same_prefix_is_refused(copy, tmp_path):
    root, _ = copy
    (tmp_path / "copy-other").mkdir()
    with pytest.raises(OutsideCopy):
        inside(root, str(tmp_path / "copy-other"))


def test_symlinks_that_lead_out_are_refused(copy):
    root, outside = copy
    (root / "plugin" / "file-link").symlink_to(outside / "secret.txt")
    (root / "plugin" / "dir-link").symlink_to(outside)
    (root / "plugin" / "dangling").symlink_to(outside / "not-there.txt")
    for p in ("plugin/file-link", "plugin/dir-link", "plugin/dir-link/secret.txt", "plugin/dir-link/new.txt",
              "plugin/dangling"):
        with pytest.raises(OutsideCopy):
            inside(root, p)
    # a link that stays inside the copy is fine
    (root / "plugin" / "inner").symlink_to(root / "plugin" / "claims")
    assert inside(root, "plugin/inner/list.js") == (root / "plugin/claims/list.js").resolve()


def test_a_copy_reached_through_a_symlink_still_confines(copy, tmp_path):
    root, outside = copy
    (tmp_path / "via").symlink_to(root)
    assert inside(tmp_path / "via", "plugin/claims/list.js") == (root / "plugin/claims/list.js").resolve()
    with pytest.raises(OutsideCopy):
        inside(tmp_path / "via", "../elsewhere/secret.txt")


def test_the_copys_git_folder_and_nul_are_refused(copy):
    root, _ = copy
    for p in (".git", ".git/config", "plugin/../.git/hooks/pre-commit", "plugin\x00x"):
        with pytest.raises(OutsideCopy):
            inside(root, p)


# ---- the tools, on a kernel fix made from a made-up thimble checkout

GH_STUB = """#!/bin/sh
echo "$*" >> "{log}"
case "$*" in
  "api user") echo '{{"login": "made-up-tester", "id": 4242}}' ;;
  "pr create"*) echo "https://example.invalid/made-up-tester/pull/1" ;;
  "issue create"*) echo "https://example.invalid/made-up-tester/issues/2" ;;
esac
"""


def sh(*args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def kfix(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "thome"))
    for name, stub in (("gh", GH_STUB), ("git", '#!/bin/sh\necho "$*" >> "{log}"\n')):
        p = tmp_path / f"{name}-stub"
        p.write_text(stub.format(log=tmp_path / f"{name}.log"))
        p.chmod(p.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv(f"THIMBLE_{name.upper()}", str(p))
    src = tmp_path / "src"
    (src / "plugin" / "claims").mkdir(parents=True)
    (src / "plugin" / "claims" / "order.py").write_text("ORDER = 'oldest'\n")
    for args in (("init", "-q", "-b", "main"), ("add", "plugin"),
                 ("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "release")):
        sh("git", *args, cwd=src)
    monkeypatch.setattr(fix, "find_source", lambda: (src, sh("git", "rev-parse", "HEAD", cwd=src), False))
    (tmp_path / "secret.txt").write_text("made-up secret\n")
    t = SimpleNamespace(ws="ws-made-up", unsandboxed=True)
    return t, tmp_path


def run(coro):
    return asyncio.run(coro)


def test_the_chat_agent_gets_the_fix_tools_and_no_shell():
    names = agent.AGENTS["main"].tool_names()
    assert set(fixcopy.TOOLS) <= set(names)
    assert not any(n in names for n in ("Bash", "Write", "Edit", "shell"))


def test_the_fix_tools_work_in_the_copy_and_refuse_everything_else(kfix):
    t, tmp = kfix
    r = run(fixcopy.fix_start(t, {"title": "Sort claims newest first"}))
    slug = t.fix_slug
    assert not r.is_error and slug in r.text
    assert "plugin/claims/order.py" in run(fixcopy.fix_files(t, {"slug": slug})).text
    assert "ORDER = 'oldest'" in run(fixcopy.fix_read(t, {"slug": slug, "path": "plugin/claims/order.py"})).text
    wt = Path(fix.load(slug)["worktree"])
    (wt / "plugin" / "leak").symlink_to(tmp / "secret.txt")
    for call, args in ((fixcopy.fix_read, {"path": "../../../secret.txt"}), (fixcopy.fix_read, {"path": str(tmp / "secret.txt")}),
                       (fixcopy.fix_read, {"path": "plugin/leak"}), (fixcopy.fix_edit, {"path": "plugin/leak", "new": "x"}),
                       (fixcopy.fix_edit, {"path": "../outside.py", "new": "x"}), (fixcopy.fix_files, {"dir": ".."}),
                       (fixcopy.fix_test, {"path": "../.."})):
        with pytest.raises(OutsideCopy):
            run(call(t, {"slug": slug, **args}))
    assert not (tmp / "thome" / "fixes" / "outside.py").exists() and (tmp / "secret.txt").read_text() == "made-up secret\n"
    assert "plugin/leak" not in run(fixcopy.fix_files(t, {"slug": slug})).text
    with pytest.raises(OutsideCopy):
        run(fixcopy.fix_read(t, {"slug": "../../x", "path": "a"}))
    assert not run(fixcopy.fix_edit(t, {"slug": slug, "path": "plugin/claims/order.py", "old": "'oldest'", "new": "'newest'"})).is_error
    assert not run(fixcopy.fix_edit(t, {"slug": slug, "path": "plugin/claims/test_order.py",
                                        "new": "from order import ORDER\n\ndef test_newest():\n    assert ORDER == 'newest'\n"})).is_error
    res = run(fixcopy.fix_test(t, {"slug": slug, "path": "plugin/claims"}))
    assert not res.is_error and "1 passed" in res.text


def test_a_draft_with_a_change_shows_its_files_and_sends_a_draft_pr_through_the_stubs(kfix, folder):
    t, tmp = kfix
    from thimble_browser import home

    t.ws = home.open_folder(folder)
    run(fixcopy.fix_start(t, {"title": "Sort claims newest first"}))
    slug = t.fix_slug
    run(fixcopy.fix_edit(t, {"slug": slug, "path": "plugin/claims/order.py", "old": "'oldest'", "new": "'newest'"}))
    r = run(issues.draft_report(t, {"slug": slug, "title": "Sort claims newest first",
                                    "body": "## What happened\nClaims list oldest first.\n\n## Expected\nNewest first.\n\n"
                                            "## Change\nORDER is newest; a test on made-up claims checks it."}))
    assert not r.is_error
    got = issues.current(t.ws)
    assert got["slug"] == slug and got["kind"] == "change"
    assert got["files"] == [{"path": "plugin/claims/order.py", "added": 1, "removed": 1}]
    assert "+ORDER = 'newest'" in got["diff"] and "## Change" in got["pr"]
    out = issues._send_fix(issues._dir(slug), slug, "send", got["ask"])
    assert out["pr_url"].endswith("/pull/1") and out["url"].endswith("/issues/2")
    gh = (tmp / "gh.log").read_text()
    assert "pr create" in gh and "--draft" in gh and "issue create" in gh
    assert "push" in (tmp / "git.log").read_text()


def test_slash_fix_is_expanded_for_claude_and_other_text_is_not():
    assert fixcopy.expand("what is in runs/?") is None
    assert fixcopy.expand("/fixture") is None
    said = fixcopy.expand("/fix sort claims newest first")
    assert '"sort claims newest first"' in said and "fix_start" in said and "fix_use" in said
    assert "draft_report" in fixcopy.expand("/fix submit")
    assert "Ask them" in fixcopy.expand("/fix")
