"""The session ids in the public tests are patterned fakes: every UUID holds a run of four equal characters, such as
5e55a000-0000-4000-8000-000000000001, so none reads like one copied from a real session."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS = (ROOT / "backend" / "tests_public", ROOT / "frontend" / "tests" / "public")
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
RUN = re.compile(r"([0-9a-f])\1{3}", re.I)


def test_every_uuid_in_the_public_tests_is_a_patterned_fake():
    found = []
    for folder in TESTS:
        for path in sorted(folder.rglob("*")):
            if path.suffix not in (".py", ".ts", ".tsx", ".json", ".jsonl") or "__pycache__" in path.parts:
                continue
            for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                found += [(path.relative_to(ROOT).as_posix(), n, u) for u in UUID.findall(line)
                          if not RUN.search(u.replace("-", ""))]
    assert found == []
