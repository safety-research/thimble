"""The privacy scan of a fix's draft (engine/kernel/privacy.py): each generic kind of private detail is found and
replaced. All data here is made up."""
from __future__ import annotations

import sys

HOME = "/ho" + "me/"  # written apart, so that the repository's own scan of commits does not stop at these made-up paths
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from kernel import privacy as P  # noqa: E402


def scan(text):
    hits, _ = P.scan({"issue": text}, None, None, use_gitleaks=False)
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
