"""Backoff for transient model failures, used by model.structured.

A failure is transient when its HTTP status is in TRANSIENT_HTTP or its text names such a status, an overload or a
connection failure. `with_retries` reruns a coroutine factory on transient failures, waiting
`retry_schedule(retries, base_s)` between attempts, and re-raises anything else. `model_knobs()` reads
THIMBLE_MODEL_RETRIES / THIMBLE_MODEL_RETRY_BASE_S (default 3 retries from 5 s: 5, 15, 45 s)."""
from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, TypeVar

log = logging.getLogger("thimble.retry")

T = TypeVar("T")

# The transient failures by status, each with its short class. The text patterns cover failures reported without a
# status or under HTTP 200 (a streamed error event such as `{'type': 'overloaded_error', …}`).
TRANSIENT_HTTP: dict[int, str] = {429: "rate_limited", 500: "server_error", 502: "server_error", 503: "server_error",
                                  504: "server_error", 529: "overloaded"}
_OVERLOADED_TEXT = re.compile(r"overloaded", re.I)
_CONNECTION_TEXT = re.compile(r"connection error|connection reset|connection refused|econnreset|econnrefused|etimedout|"
                              r"socket hang up|fetch failed|network error", re.I)
_STATUS_TEXT = re.compile(r"\b(?:HTTP|API Error:?|Error code:?|status(?: code)?:?)\s*(429|500|502|503|504|529)\b", re.I)
# the API's error types (an error event inside a 200 body names one) and the SDK's AssistantMessage error kinds
_BODY_TEXT = re.compile(r"\b(overloaded_error|api_error|server_error|rate_limit_error)\b", re.I)
# Claude Code's wording for a 5xx that arrived mid-stream carries no status and no error type
_SERVER_ERROR_TEXT = re.compile(r"server error( mid-response)?|internal server error", re.I)
_BODY_CLASS = {"overloaded_error": "overloaded", "api_error": "server_error", "server_error": "server_error",
               "rate_limit_error": "rate_limited"}
DEFAULT_RETRIES = 5
DEFAULT_RETRY_BASE_S = 5.0
DEFAULT_MODEL_RETRIES = 3  # model.structured's schedule: 5, 15, 45 s
RETRY_FACTOR = 3
RETRY_MAX_S = 240.0
_sleep = asyncio.sleep  # the retry wait; tests replace it

MODEL_RETRIES_ENV = "THIMBLE_MODEL_RETRIES"
MODEL_RETRY_BASE_ENV = "THIMBLE_MODEL_RETRY_BASE_S"


def retry_schedule(retries: int, base_s: float) -> list[float]:
    """The waits before each retry, in order: base × 3^k capped at RETRY_MAX_S (5, 15, 45, 135, 240 s for the
    defaults); empty for `retries` 0."""
    n = max(0, int(retries))
    base = max(0.0, float(base_s))
    return [min(base * RETRY_FACTOR**k, RETRY_MAX_S) for k in range(n)]


def transient_class(status: int | None, text: str | None) -> str | None:
    """The short class of a failure worth retrying (overloaded, rate_limited, server_error, connection) from the
    reported
    HTTP status and the error text, or None when it is not transient."""
    if isinstance(status, int) and status in TRANSIENT_HTTP:
        return TRANSIENT_HTTP[status]
    t = text or ""
    if _OVERLOADED_TEXT.search(t):
        return "overloaded"
    m = _STATUS_TEXT.search(t)
    if m:
        return TRANSIENT_HTTP[int(m.group(1))]
    m = _BODY_TEXT.search(t)
    if m:
        return _BODY_CLASS[m.group(1).lower()]
    if _SERVER_ERROR_TEXT.search(t):
        return "server_error"
    if _CONNECTION_TEXT.search(t):
        return "connection"
    return None


def exception_class(e: BaseException) -> str | None:
    """transient_class for an exception the SDK raised: a ResultError carries the result's HTTP status and text (read
    by attribute, so a fake works); a ConnectionError is a connection failure; anything else is judged by its text."""
    if isinstance(e, ConnectionError):
        return "connection"
    status = getattr(e, "api_error_status", None)
    text = " ".join(str(p) for p in (getattr(e, "result", None), e) if p)
    return transient_class(status if isinstance(status, int) else None, text)


def knobs(retries_env: str | Sequence[str], base_env: str | Sequence[str], environ: Mapping[str, str] | None = None,
          *, defaults: tuple[int, float] = (DEFAULT_RETRIES, DEFAULT_RETRY_BASE_S)) -> tuple[int, float]:
    """(retries, first wait in seconds) from `environ`: the first set variable of `retries_env` and of `base_env`, else
    `defaults`. An invalid value falls back to the default with a log line."""
    src = os.environ if environ is None else environ
    retries, base = defaults
    for name in ([retries_env] if isinstance(retries_env, str) else retries_env):
        raw = str(src.get(name, "") or "").strip()
        if not raw:
            continue
        try:
            retries = max(0, int(raw))
        except ValueError:
            log.warning("%s=%r is not an integer; using %d", name, raw, retries)
        break
    for name in ([base_env] if isinstance(base_env, str) else base_env):
        raw = str(src.get(name, "") or "").strip()
        if not raw:
            continue
        try:
            base = max(0.0, float(raw))
        except ValueError:
            log.warning("%s=%r is not a number; using %g", name, raw, base)
        break
    return retries, base


def model_knobs(environ: Mapping[str, str] | None = None) -> tuple[int, float]:
    """model.structured's (retries, first wait): THIMBLE_MODEL_RETRIES / THIMBLE_MODEL_RETRY_BASE_S, else 3 retries
    from 5 s."""
    return knobs(MODEL_RETRIES_ENV, MODEL_RETRY_BASE_ENV, environ, defaults=(DEFAULT_MODEL_RETRIES, DEFAULT_RETRY_BASE_S))


async def with_retries(attempt: Callable[[], Awaitable[T]], *, retries: int = DEFAULT_RETRIES,
                       base_s: float = DEFAULT_RETRY_BASE_S, what: str = "model call",
                       classify: Callable[[BaseException], str | None] = exception_class,
                       on_retry: Callable[[int, float, str, BaseException], Any] | None = None) -> T:
    """`await attempt()`, again after each transient failure until it returns or the schedule is spent.

    `classify(e)` gives the transient class or None (default `exception_class`). Each retry logs one line and calls
    `on_retry(n, wait_s, error_class, exc)`. Other exceptions are re-raised; asyncio.CancelledError is never caught."""
    schedule = retry_schedule(retries, base_s)
    n = 0
    while True:
        try:
            return await attempt()
        except Exception as e:  # noqa: BLE001 — re-raised unless transient with a wait left
            cls = classify(e)
            if cls is None or n >= len(schedule):
                raise
            wait = schedule[n]
            n += 1
            detail = str(e)[:300]
            log.info("%s: %s (%s); retry %d/%d in %.0f s", what, cls, detail, n, len(schedule), wait)
            if on_retry is not None:
                try:
                    out = on_retry(n, wait, cls, e)
                    if asyncio.iscoroutine(out):
                        await out
                except Exception:  # noqa: BLE001 — a listener never stops the retry
                    log.debug("%s: on_retry raised", what, exc_info=True)
            await _sleep(wait)
