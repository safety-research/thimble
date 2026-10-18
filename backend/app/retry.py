"""Which model failures are transient: an HTTP status in TRANSIENT_HTTP, or a text that names such a status, an
overload or a connection failure (transient_class). The card check and the notices read a failed call's detail with
it."""
from __future__ import annotations

import re

# The transient failures by status, each with its short class. The text patterns cover failures reported without a
# status or under HTTP 200 (a streamed error event such as `{'type': 'overloaded_error', …}`).
TRANSIENT_HTTP: dict[int, str] = {429: "rate_limited", 500: "server_error", 502: "server_error", 503: "server_error",
                                  504: "server_error", 529: "overloaded"}
_OVERLOADED_TEXT = re.compile(r"overloaded", re.I)
_CONNECTION_TEXT = re.compile(r"connection error|connection reset|connection refused|econnreset|econnrefused|etimedout|"
                              r"socket hang up|fetch failed|network error", re.I)
_STATUS_TEXT = re.compile(r"\b(?:HTTP|API Error:?|Error code:?|status(?: code)?:?)\s*(429|500|502|503|504|529)\b", re.I)
# the API's error types (an error event inside a 200 body names one)
_BODY_TEXT = re.compile(r"\b(overloaded_error|api_error|server_error|rate_limit_error)\b", re.I)
# Claude Code's wording for a 5xx that arrived mid-stream carries no status and no error type
_SERVER_ERROR_TEXT = re.compile(r"server error( mid-response)?|internal server error", re.I)
_BODY_CLASS = {"overloaded_error": "overloaded", "api_error": "server_error", "server_error": "server_error",
               "rate_limit_error": "rate_limited"}


def transient_class(status: int | None, text: str | None) -> str | None:
    """The short class of a failure worth retrying (overloaded, rate_limited, server_error, connection) from the
    reported HTTP status and the error text, or None when it is not transient."""
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
