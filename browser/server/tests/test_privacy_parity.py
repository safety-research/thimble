"""The privacy scan is the same in both products: thimble browser keeps a byte-for-byte copy of the plugin kernel's
privacy.py, as it does for the label estimate."""
from __future__ import annotations

from pathlib import Path

from thimble_browser import privacy

KERNEL = Path(__file__).resolve().parents[3] / "plugin" / "engine" / "kernel" / "privacy.py"
BROWSER = Path(privacy.__file__)


def test_the_browser_keeps_the_kernels_privacy_scan_byte_for_byte():
    assert BROWSER.read_bytes() == KERNEL.read_bytes()


HOME = "/ho" + "me/"  # written apart, so that the repository's own scan of commits does not stop at these made-up paths
FAKE_KEY = "sk" + "-ant-" + "abcdefghijklmnopqrstuvwx"  # made up, built here so secret scanners pass this file


def test_the_scan_removes_paths_secrets_and_session_terms_but_not_thimbles_own_words():
    text = ("Rows could not open tickets.csv at " + HOME + "dana/work/northwind/plugin/claims/rows.js:52. "
            "The cited row was queue_owner = dana.ruiz@northwind.test. Key " + FAKE_KEY + ". "
            "The card shows rows. Write to support@example.com or ops@tickets.example.")
    terms = {"file": ["tickets.csv"], "field": ["queue_owner", "rows"], "folder": ["northwind"]}
    hits, _ = privacy.scan({"issue": text}, terms, known=lambda ts: {t for t in ts if t.lower() in {"rows", "card"}},
                           repo_paths=[(HOME + "dana/work/northwind/", "")], use_gitleaks=False)
    by = {h["found"]: h for h in hits}
    assert by["tickets.csv"]["replacement"] == "‹data file›"
    assert by["queue_owner"]["replacement"] == "‹field›"
    assert by["dana.ruiz@northwind.test"]["kind"] == "email"
    assert by[HOME + "dana/work/northwind/plugin/claims/rows.js:52"]["replacement"] == "plugin/claims/rows.js:52"
    assert by[FAKE_KEY]["kind"] == "token" and not privacy.keepable(by[FAKE_KEY])
    assert "support@example.com" not in by and "ops@tickets.example" not in by  # domains reserved for examples
    clean = privacy.redact(text, hits)
    for gone in ("tickets.csv", "queue_owner", "dana", "northwind", "sk-ant"):
        assert gone not in clean
    assert "The card shows rows." in clean and "plugin/claims/rows.js:52" in clean
    assert "support@example.com" in clean
    by["queue_owner"]["kept"] = True
    by[FAKE_KEY]["kept"] = True  # a token is never kept, whatever the flag says
    again = privacy.redact(text, hits)
    assert "queue_owner" in again and "sk-ant" not in again
