"""scripts/check_content.py, the content and commits steps of scripts/check.sh: a listed word is found in any spelling,
the maintainer's name only outside the files that carry it on purpose, files of kinds that never belong in the tree are
refused, and so are names a case-insensitive disk cannot tell apart and commit messages that link a Claude Code session.
The real list is digests, so these tests list words of their own."""
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_content.py"


@pytest.fixture()
def cc(monkeypatch):
    spec = importlib.util.spec_from_file_location("check_content", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "TERMS", {mod.digest("red-kite"): "private", mod.digest("Alice"): "maintainer"})
    return mod


def write(root: Path, files: dict[str, str | bytes]) -> Path:
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(text if isinstance(text, bytes) else text.encode())
    return root


def hits(cc, root: Path) -> list[tuple[str, int, str, str]]:
    return cc.scan(root, cc.files_of(root))


def test_a_listed_word_pair_is_found_in_any_spelling(cc, tmp_path):
    write(tmp_path, {"a.py": "x = 'red_kite'\n# Red Kite\n# red-kites, redkite\n"})
    assert [(h[1], h[2]) for h in hits(cc, tmp_path)] == [(1, "private"), (2, "private")]


def test_the_maintainer_is_named_only_in_the_files_that_carry_the_name(cc, tmp_path):
    write(tmp_path, {".claude-plugin/marketplace.json": '{"owner": "Alice"}\n', "README.md": "Contact: Alice\n",
                     "backend/app/x.py": "# Alice\n", "docs/y.md": "alice\n"})  # the listed spelling is "Alice"
    assert hits(cc, tmp_path) == [("backend/app/x.py", 1, "maintainer", "Alice")]


def test_files_of_kinds_that_never_belong_are_refused(cc, tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "MAX_BYTES", 100)
    write(tmp_path, {"data/c/x.txt": "", "a/b.db": b"\0", "run.jsonl": "{}\n", "big.txt": "x" * 101, "ok.txt": "ok\n",
                     "plugin/viewers/repository/sample/repo.jsonl": "{}\n", "plugin/viewers/repository/sample/x/run.jsonl": "{}\n"})
    assert sorted(h[0] for h in hits(cc, tmp_path)) == ["a/b.db", "big.txt", "data/c/x.txt", "run.jsonl"], \
        "a worked example's sample files, in its folders too, are data on purpose"


def test_a_checkout_is_checked_by_its_tracked_and_unignored_files(cc, tmp_path):
    write(tmp_path, {".gitignore": "ignored/\n", "tracked.py": "red kite\n", "new.py": "red kite\n",
                     "ignored/x.py": "red kite\n"})
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "add", ".gitignore", "tracked.py"], check=True)
    assert sorted(h[0] for h in hits(cc, tmp_path)) == ["new.py", "tracked.py"]


def test_the_command_fails_on_a_hit_and_passes_a_clean_tree(tmp_path):
    clean = write(tmp_path / "clean", {"a.py": "print('ok')\n"})
    dirty = write(tmp_path / "dirty", {"a.db": b"\0"})
    run = [sys.executable, str(SCRIPT), "--no-gitleaks"]
    assert subprocess.run([*run, str(clean)], capture_output=True).returncode == 0
    r = subprocess.run([*run, str(dirty)], capture_output=True, text=True)
    assert r.returncode == 1 and "a.db:0: [path]" in r.stdout


def test_names_that_differ_only_by_case_are_refused(cc, tmp_path):
    write(tmp_path, {"src/Checks.tsx": "", "src/checks.ts": "", "src/Page.tsx": "", "src/page.ts": "",
                     "src/types.d.ts": "", "src/Types.ts": "", "Lib/a.py": "", "lib/b.py": "",
                     "src/card.ts": "", "src/Card.test.ts": "", "src/cards.ts": "", "README.md": "",
                     "README.md.orig": "", ".gitignore": "", "docs/DESIGN.md": "", "docs/design/SYSTEM.md": ""})
    found = sorted(h[0] for h in cc.case_clashes(cc.files_of(tmp_path)))
    assert found == ["Lib/", "lib/", "src/Checks.tsx", "src/Page.tsx", "src/Types.ts", "src/checks.ts", "src/page.ts",
                     "src/types.d.ts"]


def test_the_command_fails_on_names_that_differ_only_by_case(tmp_path):
    write(tmp_path, {"report/Page.tsx": "", "report/page.ts": ""})
    r = subprocess.run([sys.executable, str(SCRIPT), "--no-gitleaks", str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 1 and "report/page.ts:0: [case]" in r.stdout


def test_no_two_names_in_this_tree_differ_only_by_case(cc):
    root = SCRIPT.parents[1]
    rels = [rel for rel in cc.files_of(root) if not cc.NEVER.search(rel)]
    assert cc.case_clashes(rels) == []


def test_this_tree_names_private_material_and_the_maintainer_only_where_it_may():
    root = SCRIPT.parents[1]
    if not (root / ".git").exists():
        pytest.skip("not a git checkout")
    spec = importlib.util.spec_from_file_location("check_content_tree", SCRIPT)
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    tracked = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True).stdout
    rels = sorted(p for p in tracked.decode().split("\0") if p and (root / p).is_file())
    assert [h for h in real.scan(root, rels) if h[2] in ("private", "maintainer")] == []


GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.org",
       "-c", "commit.gpgsign=false"]


def commit(root: Path, message: str) -> str:
    subprocess.run([*GIT, "-C", str(root), "commit", "-q", "--allow-empty", "-m", message], check=True)
    return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                          check=True).stdout.strip()


def test_commit_messages_with_a_session_line_or_link_are_refused(cc, tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    first = commit(tmp_path, "First\n\nClaude-Session: https://claude.ai/code/session_0000")
    old = commit(tmp_path, "Before the rule\n\nclaude-session: https://claude.ai/code/session_0001")
    commit(tmp_path, "Clean\n\nCo-Authored-By: Someone <someone@example.org>")
    linked = commit(tmp_path, "Linked\n\nSee https://claude.ai/code/session_0002 for the run.")
    trailer = commit(tmp_path, "Trailer\n\nBody.\nClaude-Session: https://claude.ai/code/session_0003")
    found = cc.commit_hits(tmp_path, f"{first}..HEAD", until=old)
    assert [(h[0], h[1], h[2]) for h in found] == [(trailer[:12], 4, "session"), (linked[:12], 3, "session")]
    assert len(cc.commit_hits(tmp_path, f"{first}..HEAD", until=None)) == 3
    assert cc.commit_hits(tmp_path, f"{first}..HEAD", until="0" * 40) == cc.commit_hits(tmp_path, f"{first}..HEAD", None)
    assert cc.commit_hits(tmp_path, f"{first}..HEAD", until=("0" * 40, old)) == found
    assert cc.commit_hits(tmp_path, f"{first}..HEAD", until=(old, linked)) == found[:1]
    run = [sys.executable, str(SCRIPT), "--commits"]
    r = subprocess.run([*run, f"{first}..HEAD", str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 1 and f"{trailer[:12]}:4: [session] Claude-Session:" in r.stdout
    assert subprocess.run([*run, f"{first}..{first}", str(tmp_path)], capture_output=True).returncode == 0
    assert subprocess.run([*run, "nope..HEAD", str(tmp_path)], capture_output=True).returncode == 2


def test_the_real_list_is_digests_of_known_kinds():
    spec = importlib.util.spec_from_file_location("check_content_real", SCRIPT)
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    assert real.TERMS and all(re.fullmatch(r"[0-9a-f]{64}", d) for d in real.TERMS)
    assert set(real.TERMS.values()) <= {"private", "maintainer"}


def test_a_release_s_built_ui_and_notices_are_checked_for_file_kinds_but_not_words(cc, tmp_path):
    """A release's staged tree carries frontend/dist, whose minified names can spell a listed word, and the npm
    packages' notices, which are other people's texts."""
    write(tmp_path, {"frontend/dist/assets/a.js": "var Alice=1;// red kite\n", "THIRD_PARTY_NOTICES": "Alice\n",
                     "frontend/dist/x.db": b"\0", "frontend/src/a.ts": "// red kite\n"})
    assert sorted((h[0], h[2]) for h in hits(cc, tmp_path)) == [("frontend/dist/x.db", "path"),
                                                                 ("frontend/src/a.ts", "private")]
