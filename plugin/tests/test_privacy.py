"""The privacy scan of a fix's draft (engine/kernel/privacy.py): each generic kind, the session's terms, the source
tree's words passing, and the module standing alone (the browser keeps a copy). All data here is made up."""
from __future__ import annotations

import re
import sys

HOME = "/ho" + "me/"  # written apart, so that the repository's own scan of commits does not stop at these made-up paths
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import privacy as P  # noqa: E402


def scan(text, session=None, known=None, **kw):
    hits, _ = P.scan({"issue": text}, session, known, use_gitleaks=False, **kw)
    return hits, P.apply({"issue": text}, hits)["issue"]


def test_each_generic_kind():
    cases = {
        "path": [HOME + "dana/data/tickets.csv", "/Us" + "ers/ravi/Desktop/x", "/m" + "nt/disk7/exports", r"C:\Users\mei\notes.txt"],
        "email": ["dana.ruiz@northwind.test", "ops@example.co"],
        "key": ["-----BEGIN OPENSSH " + "PRIVATE KEY-----"],
        "token": ["sk-" + "a1B2" * 6, "ghp_" + "Zx9" * 12, "AKIA" + "ABCD1234EFGH5678", "eyJhbGciOiJIUzI1." + "eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw",
                  "0123456789abcdef" * 3],
        "host": ["10.20.30.40"],
    }
    for kind, examples in cases.items():
        for ex in examples:
            hits, out = scan(f"It failed at {ex} today.")
            assert [h["kind"] for h in hits] == [kind], (ex, hits)
            assert ex not in out and P.PLACEHOLDER[kind] in out, (ex, out)


def test_allowed_and_plain_text_pass():
    hits, out = scan(f"The tests use {HOME}t/data and a server on 127.0.0.1. Rows opens a card; version 0.10.0.")
    assert hits == [] and HOME + "t/data" in out
    # a reproduction on made-up data uses the domains reserved for examples
    made_up = "Mail support@example.com, a@sub.example.org, b@Example.NET or ops@tickets.example."
    assert scan(made_up)[0] == []


def test_session_terms_whole_words_and_placeholders():
    session = {"name": ["dana"], "file": ["tickets.csv", "tickets"], "field": ["queue_owner"], "value": ["Northwind Ltd"],
               "path": ["/srv/exports/support"], "host": ["blue-lab-07"], "folder": ["support"]}
    text = ("dana saw Rows fail on tickets.csv in /srv/exports/support on blue-lab-07: the queue_owner was Northwind Ltd. "
            "A ticketsystem word stays.")
    hits, out = scan(text, session)
    assert {h["kind"] for h in hits} == {"name", "file", "field", "value", "path", "host"}
    for found in ("dana", "tickets.csv", "queue_owner", "Northwind Ltd", "/srv/exports/support", "blue-lab-07"):
        assert found not in out
    assert "‹data file›" in out and "‹field›" in out and "‹value›" in out and "‹name›" in out and "‹host›" in out
    assert "ticketsystem" in out  # a term counts only as a whole word
    assert "‹folder›" not in out  # the folder's name went with its whole path


def test_words_of_thimble_source_pass_but_whole_file_names_never_do():
    # "label" is a field of the person's data and a word of thimble's source, and so is the folder name "support";
    # board.jsonl is the person's data file and also a name in thimble's source (its samples): the field and the
    # folder's bare name pass, the whole file name is a hit wherever it stands
    session = {"field": ["label", "queue_owner"], "value": ["open"], "file": ["board.jsonl"], "folder": ["support"]}
    known = lambda terms: {"label", "open", "board.jsonl", "support"} & set(terms)  # noqa: E731
    seen: list[list[str]] = []
    hits, _ = P.scan({"issue": "The label of board.jsonl in support is open; queue_owner.", "branch": "fix/board.jsonl",
                      "commit": "Read board.jsonl"}, session, lambda t: (seen.append(t), known(t))[1], use_gitleaks=False)
    assert sorted((h["where"], h["found"]) for h in hits) == [
        ("branch", "board.jsonl"), ("commit", "board.jsonl"), ("issue", "board.jsonl"), ("issue", "queue_owner")]
    assert all(set(t) <= {"label", "queue_owner", "open", "support"} for t in seen)  # never the whole file name
    out = P.apply({"issue": "The label of board.jsonl is open."}, [h for h in hits if h["where"] == "issue"])["issue"]
    assert out == "The label of ‹data file› is open."


def test_repo_path_and_keep():
    root = HOME + "dana/.claude/plugins/cache/thimble/thimble/0.10.0/"
    hits, out = scan(f"at {root}engine/kernel/cli.py:52", repo_paths=[(root, "plugin/")])
    assert out == "at plugin/engine/kernel/cli.py:52"
    hits, _ = scan("the field queue_owner", {"field": ["queue_owner"]})
    hits[0]["kept"] = True
    assert P.apply({"issue": "the field queue_owner"}, hits)["issue"] == "the field queue_owner"


def test_parts_are_scanned_apart():
    parts = {"issue": "see tickets.csv", "diff": "+open('tickets.csv')\n", "branch": "fix/tickets-csv"}
    hits, _ = P.scan(parts, {"file": ["tickets.csv", "tickets"]}, use_gitleaks=False)
    assert {(h["where"], h["found"]) for h in hits} == {("issue", "tickets.csv"), ("diff", "tickets.csv"), ("branch", "tickets")}
    assert [h["id"] for h in hits] == [f"h{i}" for i in range(1, len(hits) + 1)]


def test_plain_module():
    """No plugin imports, so the browser can keep a byte-identical copy."""
    src = (ENGINE / "kernel" / "privacy.py").read_text()
    imports = re.findall(r"^(?:from|import) (\S+)", src, re.M)
    assert all(not m.startswith(".") and m.split(".")[0] in sys.stdlib_module_names | {"__future__"} for m in imports), imports


def test_a_decorator_in_a_diff_is_no_email():
    hits, out = scan("+@pytest.fixture\n+def rows(): pass\nmail ada@example.invalid")
    assert [h["found"] for h in hits] == ["ada@example.invalid"] and out.startswith("+@pytest.fixture")
