"""scripts/check_content.py, the content step of scripts/check.sh: a listed word is found in any spelling, the
maintainer's name only outside the files that carry it on purpose, files of kinds that never belong in the tree are
refused, and so are names a case-insensitive disk cannot tell apart. The real list is digests, so these tests list words
of their own."""
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
    assert sorted(h[0] for h in hits(cc, tmp_path)) == ["a/b.db", "big.txt", "data/c/x.txt",
                                                        "plugin/viewers/repository/sample/x/run.jsonl", "run.jsonl"], \
        "a worked example's sample file is data on purpose"


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


def test_the_real_list_is_digests_of_known_kinds():
    spec = importlib.util.spec_from_file_location("check_content_real", SCRIPT)
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    assert real.TERMS and all(re.fullmatch(r"[0-9a-f]{64}", d) for d in real.TERMS)
    assert set(real.TERMS.values()) <= {"private", "maintainer"}
