"""thimble.timeline with clock times and no date (bug hunt B22): the card keeps each time as the code gave it, so no
surface draws a date thimble made up (the terminal drew `Jan 1 22:14` from a stored `2000-01-01T22:14:07`). The
kernel's display is caught; no kernel, no browser."""
import datetime as dt

from app import kernel_thimble as kt


def drawn(events) -> dict:
    """The bundle thimble.timeline shows."""
    shown: list[dict] = []
    real = kt._show
    kt._show = shown.append
    try:
        assert kt.timeline(events) is None
    finally:
        kt._show = real
    assert len(shown) == 1
    return shown[0]


def test_clock_times_stay_times_without_a_date():
    b = drawn([("22:14:07", "4 clicks in 18s"), ("22:15:30", "a new thread"), ("00:02:00", "past midnight"),
               {"time": dt.time(0, 5, 9), "label": "a time object", "end": "00:06"}])
    events = b[kt.TIMELINE_MIME]["events"]
    assert [e["time"] for e in events] == ["22:14:07", "22:15:30", "00:02:00", "00:05:09"]
    assert events[3]["end"] == "00:06"
    assert "2000" not in str(b), "no date of thimble's making"
    assert b["text/plain"].splitlines()[1] == "22:14:07  4 clicks in 18s"
