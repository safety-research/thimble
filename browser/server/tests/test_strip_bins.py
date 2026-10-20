"""Where records fall on the strip beside a reader's scrollbar (readers/base.share_bins, readers/source_keys,
labels/store.ruler): a record fills its whole share of the strip's bins, so consecutive records of one value form one
band, a few records tall bands and many records thin ones, with no gap between them."""
import json

from thimble_browser.readers import source_keys
from thimble_browser.readers.base import share_bins


def test_a_record_covers_every_bin_of_its_share():
    # four records on forty bins: ten bins each, end to end
    assert [list(share_bins(i, i, 4, 40)) for i in range(4)] == [list(range(10 * i, 10 * i + 10)) for i in range(4)]
    # three records on ten bins: every bin is covered, a bin on a border by both records
    covered = sorted({b for i in range(3) for b in share_bins(i, i, 3, 10)})
    assert covered == list(range(10))
    # many records on few bins: a record is in the one or two bins its line overlaps
    assert list(share_bins(0, 0, 1000, 10)) == [0] and list(share_bins(150, 150, 1000, 10)) == [1]
    assert list(share_bins(999, 999, 1000, 10)) == [9]
    # a record over many lines (a whole-file transcript's turn) covers all of them
    assert list(share_bins(0, 1, 4, 8)) == [0, 1, 2, 3]


def test_a_short_file_colored_by_a_key_draws_bands_with_no_gap(tmp_path):
    p = tmp_path / "steps.jsonl"
    kinds = ["plan", "plan", "act", "act", "act", "check"]
    p.write_text("".join(json.dumps({"kind": k, "n": i}) + "\n" for i, k in enumerate(kinds)))
    got = source_keys.scan(p, 60, "steps.jsonl")
    at = next(k for k in got["keys"] if k["key"] == "kind")["at"]
    assert len(at) == 60 and -1 not in at
    ranks = {v["value"]: r for r, v in enumerate(next(k for k in got["keys"] if k["key"] == "kind")["values"])}
    # each record's ten bins in its value's rank: plan, then act, then check
    assert at[:20] == [ranks["plan"]] * 20 and at[20:50] == [ranks["act"]] * 30 and at[50:] == [ranks["check"]] * 10
