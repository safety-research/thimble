"""The drawings a card's code hands the canvas (app/kernel_thimble.py): thimble.timeline's `spacing`, which the card
check's replacements pass for events whose long waits leave rows far apart, reaches the data the canvas draws, and a
value it does not take is refused with the values it does. No kernel: the bundle `_show` would display is captured."""
import pytest

from app import kernel_thimble

EVENTS = [("09:00", "run starts"), ("09:02", "first save"), ("14:30", "last save")]


@pytest.fixture()
def shown(monkeypatch):
    got: list[dict] = []
    monkeypatch.setattr(kernel_thimble, "_show", got.append)
    return got


def test_a_timeline_spaced_evenly_says_so_in_its_data_and_listing(shown):
    kernel_thimble.timeline(EVENTS, spacing="even")
    data = shown[-1][kernel_thimble.TIMELINE_MIME]
    assert data["spacing"] == "even" and len(data["events"]) == 3
    assert shown[-1]["text/plain"].splitlines()[0] == "timeline: 3 events, evenly spaced"
    kernel_thimble.timeline(EVENTS)
    assert "spacing" not in shown[-1][kernel_thimble.TIMELINE_MIME], "by time, the default, adds nothing"
    with pytest.raises(ValueError, match="'time', 'even'"):
        kernel_thimble.timeline(EVENTS, spacing="log")
