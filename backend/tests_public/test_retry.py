"""app.retry: the transient-failure classifier, the backoff schedule, the environment knobs and `with_retries`, shared
by jobs.py and dev.py. No network; the wait is recorded, never slept."""
from __future__ import annotations

import logging

import pytest
from claude_agent_sdk import ResultError

from app import retry

OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
OVERLOADED_3C = ("API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again "
                 "in a moment. If it persists, check https://status.claude.com.")


class Transient(RuntimeError):
    """A job-style exception whose text carries model.py's sentence for a 529."""

    def __init__(self, text: str = "the model call ended error: the API returned HTTP 529: Error code: 529 - overloaded_error"):
        super().__init__(text)


@pytest.fixture()
def waits(monkeypatch) -> list[float]:
    seen: list[float] = []

    async def fake_sleep(s: float) -> None:
        seen.append(s)

    monkeypatch.setattr(retry, "_sleep", fake_sleep)
    return seen


# --------------------------------------------------------------------------- classification


def test_transient_class_reads_the_status_first_then_the_text():
    assert retry.transient_class(529, "") == "overloaded"
    assert retry.transient_class(429, "") == "rate_limited"
    assert all(retry.transient_class(s, "") == "server_error" for s in (500, 502, 503, 504))
    assert retry.transient_class(None, OVERLOADED) == "overloaded"
    assert retry.transient_class(None, OVERLOADED_3C) == "overloaded"
    assert retry.transient_class(None, "API Error: Connection error.") == "connection"
    assert retry.transient_class(None, "fetch failed: ECONNRESET") == "connection"
    # a status quoted in the text (model.py's sentences on the two paths) counts when none was reported
    assert retry.transient_class(None, "the API returned HTTP 503: Error code: 503 - Service Unavailable") == "server_error"
    assert retry.transient_class(None, "the session reported an error (HTTP 529)") == "overloaded"
    assert retry.transient_class(None, "Error code: 502 - Bad Gateway") == "server_error"
    assert retry.transient_class(None, "the API returned HTTP 429: too many requests") == "rate_limited"
    # an error type the body named: the API's streamed error event arrives under HTTP 200 (the key path's sentence
    # quotes the status 200 and the body; the SDK path's quotes the CLI's result text), the SDK's AssistantMessage kind
    assert retry.transient_class(200, "the API returned HTTP 200: {'type': 'error', 'error': {'type': 'overloaded_error'}}") == "overloaded"
    assert retry.transient_class(None, 'the session reported an error: API Error: {"type":"error","error":{"type":"api_error"}}') == "server_error"
    assert retry.transient_class(None, "the model call failed (server_error)") == "server_error"
    assert retry.transient_class(200, "{'type': 'error', 'error': {'type': 'rate_limit_error', 'message': 'x'}}") == "rate_limited"
    assert retry.transient_class(None, "the API returned HTTP 200: {'type': 'invalid_request_error'}") is None
    assert retry.transient_class(None, "api_error_status was None") is None  # the token, not a longer identifier
    # not transient: a 400, a status the map does not name, a number that is not a status, nothing at all
    assert retry.transient_class(400, "invalid_request_error") is None
    assert retry.transient_class(None, "the API returned HTTP 400: bad request") is None
    assert retry.transient_class(None, "the request was invalid (HTTP 404)") is None
    assert retry.transient_class(None, "cell 529 has 503 rows") is None
    assert retry.transient_class(None, "boom") is None and retry.transient_class(None, None) is None


def test_exception_class():
    assert retry.exception_class(ConnectionResetError("peer")) == "connection"
    assert retry.exception_class(ResultError("x", data={"api_error_status": 503, "result": "API Error: 503"})) == "server_error"
    assert retry.exception_class(ResultError("x", data={"result": OVERLOADED})) == "overloaded"
    assert retry.exception_class(Transient()) == "overloaded"
    assert retry.exception_class(RuntimeError("no such session")) is None
    assert retry.exception_class(ValueError("bad")) is None


    assert (retry.DEFAULT_RETRIES, retry.DEFAULT_RETRY_BASE_S) == (5, 5.0)
    assert (retry.RETRY_FACTOR, retry.RETRY_MAX_S) == (3, 240.0)


# --------------------------------------------------------------------------- the schedule


def test_retry_schedule_is_base_times_three_capped_at_240_s():
    assert retry.retry_schedule(5, 5.0) == [5.0, 15.0, 45.0, 135.0, 240.0]
    assert retry.retry_schedule(retry.DEFAULT_RETRIES, retry.DEFAULT_RETRY_BASE_S) == [5.0, 15.0, 45.0, 135.0, 240.0]
    assert retry.retry_schedule(3, 1.0) == [1.0, 3.0, 9.0]
    assert retry.retry_schedule(7, 5.0) == [5.0, 15.0, 45.0, 135.0, 240.0, 240.0, 240.0]  # the cap holds
    assert retry.retry_schedule(0, 5.0) == [] and retry.retry_schedule(-1, 5.0) == []
    assert retry.retry_schedule(2, -3.0) == [0.0, 0.0]  # a negative base is 0: retries at once


# --------------------------------------------------------------------------- the knobs


def test_model_knobs_default_to_three_retries_from_five_seconds_and_do_not_follow_the_orient_knobs():
    assert retry.model_knobs({}) == (3, 5.0) and retry.retry_schedule(*retry.model_knobs({})) == [5.0, 15.0, 45.0]
    assert retry.model_knobs({"THIMBLE_MODEL_RETRIES": "1", "THIMBLE_MODEL_RETRY_BASE_S": "2"}) == (1, 2.0)
    assert retry.model_knobs({"THIMBLE_MODEL_RETRIES": "0"}) == (0, 5.0)
    assert retry.model_knobs({"THIMBLE_ORIENT_RETRIES": "8", "THIMBLE_JOB_RETRIES": "7"}) == (3, 5.0)  # its own line
    assert retry.model_knobs({"THIMBLE_MODEL_RETRIES": "many"}) == (3, 5.0)


# --------------------------------------------------------------------------- with_retries


async def test_with_retries_retries_a_transient_failure_on_the_schedule_then_returns(waits, caplog):
    calls = {"n": 0}
    told: list[tuple[int, float, str, str]] = []

    async def attempt():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise Transient()
        return "ok"

    with caplog.at_level(logging.INFO, logger="thimble.retry"):
        out = await retry.with_retries(attempt, retries=3, base_s=1.0, what="verify clarity",
                                       on_retry=lambda n, w, cls, e: told.append((n, w, cls, type(e).__name__)))
    assert out == "ok" and calls["n"] == 3
    assert waits == [1.0, 3.0]
    assert told == [(1, 1.0, "overloaded", "Transient"), (2, 3.0, "overloaded", "Transient")]
    lines = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert len(lines) == 2 and lines[0].startswith("verify clarity: overloaded (") and "retry 1/3 in 1 s" in lines[0]
    assert "retry 2/3 in 3 s" in lines[1]


async def test_with_retries_gives_up_after_the_schedule_with_the_last_exception(waits):
    calls = {"n": 0}

    async def attempt():
        calls["n"] += 1
        raise ConnectionResetError(f"peer {calls['n']}")

    with pytest.raises(ConnectionResetError, match="peer 3"):
        await retry.with_retries(attempt, retries=2, base_s=5.0)
    assert calls["n"] == 3 and waits == [5.0, 15.0]


async def test_with_retries_raises_a_non_transient_failure_at_once(waits):
    calls = {"n": 0}

    async def attempt():
        calls["n"] += 1
        raise ValueError("a 400, a refusal, a bug: not retried")

    with pytest.raises(ValueError):
        await retry.with_retries(attempt, retries=5, base_s=5.0)
    assert calls["n"] == 1 and waits == []


async def test_with_retries_with_zero_retries_is_one_attempt_and_honours_the_classifier(waits):
    calls = {"n": 0}

    async def attempt():
        calls["n"] += 1
        raise Transient()

    with pytest.raises(Transient):
        await retry.with_retries(attempt, retries=0, base_s=5.0)
    assert calls["n"] == 1 and waits == []
    # a caller's classifier can exempt its own exceptions
    with pytest.raises(Transient):
        await retry.with_retries(attempt, retries=3, base_s=1.0, classify=lambda e: None)
    assert calls["n"] == 2 and waits == []


async def test_with_retries_survives_a_listener_that_raises(waits):
    calls = {"n": 0}

    async def attempt():
        calls["n"] += 1
        if calls["n"] == 1:
            raise Transient()
        return calls["n"]

    def bad(n, w, cls, e):
        raise RuntimeError("listener bug")

    assert await retry.with_retries(attempt, retries=1, base_s=2.0, on_retry=bad) == 2
    assert waits == [2.0]


def test_claude_codes_mid_stream_server_error_is_transient():
    """The CLI's "API Error: Server error mid-response …" has no status and no error type; it is a server error and is
    retried."""
    from app import retry
    assert retry.transient_class(None, "API Error: Server error mid-response. The response above may be incomplete.") == "server_error"
    assert retry.transient_class(None, "Internal server error") == "server_error"
    assert retry.transient_class(None, "invalid_request_error: bad field") is None
