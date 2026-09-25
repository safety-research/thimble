"""A table card's DataFrame kept as data (app/frames.py): the number formats the browser's d3-format writes, the row
names a ref uses and what a run's outputs keep. No kernel: the frames are what kernel_thimble._frame sends."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import frames, kernel_thimble  # noqa: E402

RAW = {"columns": ["line", "late", "trips", "share_late"], "index": ["line"],
       "types": {"line": "nominal", "late": "quantitative", "trips": "quantitative", "share_late": "quantitative"},
       "rows": [["A", 12, 100, 0.12], ["B", 30, 120, 0.25], ["C", 7, 90, 0.0777777778]], "total": 3}


def _reply(frame: dict | None, problem: str | None = None, last: str | None = None) -> dict:
    """The execute reply's user expression, as IPython returns kernel_thimble._frame's value."""
    return {"status": "ok", "data": {"text/plain": json.dumps({"frame": frame, "problem": problem, "last": last})}}


# ----------------------------------------------------------------------------------------------------------
# number formats: what d3-format 3.1 writes, checked against the frontend's own d3-format when written
# ----------------------------------------------------------------------------------------------------------

D3_CASES = [
    (",d", 1234567, "1,234,567"), ("d", 2024, "2024"), (",d", -1234.5, "−1,235"), (",d", 2.5, "3"), (",d", -0.4, "0"),
    (",.3~f", 0.9123, "0.912"), (",.2~f", 1234.5, "1,234.5"), (",.1~f", 12.25, "12.3"), (",.2~f", 2.675, "2.67"),
    (",.3~f", 0.0025, "0.003"), (",.0~f", 12345.6, "12,346"), (",.6~f", 0.00012, "0.00012"), (",.2~f", -0.001, "0"),
]


@pytest.mark.parametrize("fmt,value,want", D3_CASES)
def test_numbers_are_written_as_d3_format_writes_them(fmt, value, want):
    assert frames.show(value, fmt) == want


def test_a_column_gets_three_significant_digits_and_years_no_separator():
    assert frames.default_format([0.912, 0.5]) == ",.3~f"
    assert frames.default_format([12.5, 3.25]) == ",.1~f"
    assert frames.default_format([12345.6]) == ",.0~f"
    assert frames.default_format([0.00012]) == ",.6~f"
    assert frames.default_format([1, 2, 30000]) == ",d" and frames.default_format([3.0, 4.0]) == ",d"
    assert frames.default_format([2019, 2024]) == "d", "a column of years reads 2024, not 2,024"
    assert frames.show(None, ",d") == "" and frames.show(True) == "true" and frames.show([1, 2]) == "[1,2]"
    assert frames.show(3.5, "shiny") == "3.5", "a format this module does not write leaves the number as it is"


# ----------------------------------------------------------------------------------------------------------
# the frame
# ----------------------------------------------------------------------------------------------------------


def test_a_frame_is_normalized_and_times_at_midnight_become_dates():
    f = frames.normalize({"columns": ["day", "at", "n"], "types": {"day": "temporal", "at": "temporal", "n": "quantitative"},
                          "rows": [["2026-01-05T00:00:00", "2026-01-05T12:30:00", 1], ["2026-01-12T00:00:00", None, 2]]})
    assert [r[0] for r in f["rows"]] == ["2026-01-05", "2026-01-12"]
    assert f["rows"][0][1] == "2026-01-05T12:30:00", "a time of day stays"
    g = frames.normalize({"columns": ["a", "b"], "rows": [[1, "x"], [2, "y"]]})
    assert g["types"] == {"a": "quantitative", "b": "nominal"}, "types guessed when the kernel sent none"


def test_rows_are_named_by_the_index_else_the_first_distinct_text_column_else_position():
    assert frames.normalize(RAW)["label"] == "line"
    runs = frames.normalize({"columns": ["score", "run"], "rows": [[3, "r1"], [5, "r2"]]})
    assert runs["label"] == "run" and runs["view"]["columns"] == ["score"]
    steps = frames.normalize({"columns": ["step", "loss"], "rows": [[100, 0.5], [200, 0.4]]})
    assert steps["label"] is None and frames.row_labels(steps) == ["0", "1"]
    years = frames.normalize({"columns": ["year", "n"], "index": ["year"], "rows": [[2024.0, 3], [2025.0, 4]]})
    assert frames.row_labels(years) == ["2024", "2025"], "a whole float names its row without .0"


def test_the_view_shows_every_column_beside_the_row_names_in_its_format_and_the_text_is_what_the_card_shows():
    b = frames.bundle(frames.normalize(RAW))
    f = b[frames.FRAME_MIME]
    assert f["view"] == {"columns": ["late", "trips", "share_late"], "formats": {"late": ",d", "trips": ",d", "share_late": ",.3~f"},
                         "more": 0}
    assert b["text/plain"] == "line  late  trips  share_late\nA     12    100    0.12\nB     30    120    0.25\nC     7     90     0.078"
    assert frames.frame_cells(b)[:3] == [("late", "A", "12"), ("trips", "A", "100"), ("share_late", "A", "0.12")]
    assert frames.locate(b, "share_late", "C") == "0.078" and frames.locate(b, "late", "Z") is None
    assert frames.locate(b, "line", "B") == "B", "the row names are a column a ref may name"


def test_a_capped_frame_says_how_many_rows_it_has_and_the_model_reads_the_first():
    raw = {"columns": ["k", "v"], "rows": [[f"r{i}", i] for i in range(100)], "total": 900}
    f = frames.normalize(raw)
    assert f["view"]["more"] == 800
    text = frames.frame_text(f)
    assert text.splitlines()[-1] == "[900 rows x 2 columns]" and len(text.splitlines()) == 1 + frames.TEXT_ROWS + 1


def test_after_a_run_the_frame_replaces_the_dataframes_own_display():
    stream = {"text/plain": "computed 3\n", "_stream": "stdout"}
    shown = {"text/plain": "   late\nline\nA 12", "text/html": "<table>...</table>"}
    out = frames.apply_run([stream, shown], "ok", _reply(RAW), 1)
    assert out[0] is stream and frames.FRAME_MIME in out[1] and "text/html" not in out[1]
    assert frames.frame_in(out)["label"] == "line"


def test_a_run_that_ends_in_no_dataframe_or_errored_keeps_its_outputs():
    shown = {"text/plain": "3"}
    assert frames.apply_run([shown], "ok", _reply(None, last="int"), 0) == [shown]
    assert frames.apply_run([shown], "ok", _reply(None, problem="the DataFrame could not be read"), 0) == [shown]
    assert frames.apply_run([shown], "error", _reply(RAW), 0) == [shown]
    assert frames.apply_run([], "ok", _reply(RAW), None) == [], "no execute_result to replace (display(df))"
    assert frames.read_reply({"status": "error", "ename": "NameError", "evalue": "x"}) == (None, "NameError: x")
    assert frames.captures("table") and not frames.captures("plot") and not frames.captures("code")


def test_the_kernels_frame_json_names_the_index_and_writes_times_and_timedeltas():
    import pandas as pd

    df = pd.DataFrame({"at": pd.to_datetime(["2026-01-05", "2026-01-06"]), "wait": pd.to_timedelta([60, 90], unit="s"),
                       "n": [1, 2]}, index=pd.Index(["x", "y"], name="run"))
    got = kernel_thimble._frame_json(df)
    assert got["columns"] == ["run", "at", "wait", "n"] and got["index"] == ["run"]
    assert got["types"] == {"run": "nominal", "at": "temporal", "wait": "quantitative", "n": "quantitative"}
    assert got["rows"][0] == ["x", "2026-01-05T00:00:00", 60.0, 1]
    assert list(kernel_thimble._as_frame(pd.Series([3, 4])).columns) == ["value"], "an unnamed Series is a column named value"
    assert kernel_thimble._frame_json(pd.DataFrame({"a": [1]}))["index"] is None, "a plain range index is hidden"
    big = kernel_thimble._frame_json(pd.DataFrame({"a": range(kernel_thimble.FRAME_ROWS + 5)}))
    assert len(big["rows"]) == kernel_thimble.FRAME_ROWS == frames.ROWS_MAX and big["total"] == frames.ROWS_MAX + 5


def test_a_transposed_frame_types_its_numbers_and_an_unnamed_index_has_no_header():
    """After `.T` a DataFrame's columns are of object dtype, so the kernel types numbers as text. A column of numbers is
    quantitative whatever the kernel said, a frame stored before is typed again when read, and pandas' own name for an
    unnamed index heads nothing."""
    import pandas as pd

    df = pd.DataFrame({"r1": ["q7c2", 63, 55.8], "r2": ["b4k9", 60, 47]}, index=["workspace", "interview", "minutes"]).T
    raw = kernel_thimble._frame_json(df)
    assert raw["index"] == ["index"] and raw["types"]["minutes"] == "nominal", "the kernel sees object dtype"
    f = frames.normalize(raw)
    assert f["types"]["minutes"] == "quantitative" and f["types"]["interview"] == "quantitative"
    assert f["types"]["workspace"] == "nominal" and f["view"]["formats"]["minutes"] == ",.1~f"
    assert frames.corner(f) == "" and f["label"] == "index"
    text = frames.bundle(f)["text/plain"]
    assert text.splitlines()[0].split() == ["workspace", "interview", "minutes"], text
    assert frames.frame_html(frames.bundle(f)).startswith("<table><thead><tr><th></th><th>workspace</th>")
    assert frames.locate(frames.bundle(f), "minutes", "r2") == "47", "a cell still reads as the card shows it"
    stored = {**f, "types": {**f["types"], "minutes": "nominal"}}
    assert frames.frame_of({frames.FRAME_MIME: stored})["types"]["minutes"] == "quantitative", "an older frame, typed again"
    named = frames.normalize(RAW)
    assert frames.corner(named) == "line", "a named index keeps its header"
    data = frames.normalize({"columns": ["index", "n"], "rows": [["a", 1], ["b", 2]]})
    assert data["label"] == "index" and frames.corner(data) == "index", "a column the data itself calls index keeps it"
