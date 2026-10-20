"""The Messages API client, built only from explicit credentials (settings.py):

- Workload Identity Federation: the org's IDs are read from `~/.thimble/orgs/org-<org>.env` and passed to
  `WorkloadIdentityCredentials`, with a Google identity token from this machine's metadata server as the identity
  token. Nothing goes through the environment.
- An API key the analyst pasted in Settings, passed as `api_key=`.

The server clears every ANTHROPIC_* name from its own environment when it starts (scrub_env), without reading the
values, so a variable in the analyst's shell can never stand in for, or override, the credentials they chose.

The client is used for the Messages API alone: the agent loops (agent.py) and one-shot calls (complete()).
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from . import settings

log = logging.getLogger("thimble_browser.llm")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RETRIES = 6  # the SDK retries 408, 409, 429 and 5xx (529 among them) with backoff
_lock = threading.Lock()
_cache: dict[str, AsyncAnthropic] = {}


class NoCredentials(Exception):
    pass


def scrub_env() -> list[str]:
    """Remove ANTHROPIC_* names from this process's environment, values unread; the names removed."""
    names = [k for k in list(os.environ) if k.startswith("ANTHROPIC_")]
    for k in names:
        os.environ.pop(k, None)
    return names


def _wif_ids(org: str) -> dict[str, str]:
    ids: dict[str, str] = {}
    with open(Path(f"~/.thimble/orgs/org-{org}.env").expanduser()) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                ids[k] = v
    return ids


def _google_token() -> str:
    import google.auth.transport.requests  # noqa: PLC0415
    import google.oauth2.id_token  # noqa: PLC0415

    return google.oauth2.id_token.fetch_id_token(google.auth.transport.requests.Request(), "https://api.anthropic.com")


def describe() -> str:
    """The credentials in words, for the page and the log; never an id or a key."""
    c = settings.read()["credentials"]
    if c.get("source") == "wif":
        return f"Workload Identity Federation ({c.get('org')})"
    if c.get("source") == "key":
        return "an API key" if settings.has_api_key() else "an API key (none saved yet)"
    return "none"


def client() -> AsyncAnthropic:
    """The client for the credentials Settings names; NoCredentials when there are none."""
    c = settings.read()["credentials"]
    sig = json.dumps(c, sort_keys=True) + (str(settings._key_path().stat().st_mtime) if c.get("source") == "key"
                                           and settings.has_api_key() else "")
    with _lock:
        if sig in _cache:
            return _cache[sig]
        if c.get("source") == "wif":
            from anthropic import WorkloadIdentityCredentials  # noqa: PLC0415

            try:
                ids = _wif_ids(str(c.get("org")))
            except OSError:
                raise NoCredentials(f"no Workload Identity Federation file for the org {c.get('org')!r} on this "
                                    "machine") from None
            made = AsyncAnthropic(credentials=WorkloadIdentityCredentials(
                identity_token_provider=_google_token,
                federation_rule_id=ids["ANTHROPIC_FEDERATION_RULE_ID"],
                organization_id=ids["ANTHROPIC_ORGANIZATION_ID"],
                service_account_id=ids["ANTHROPIC_SERVICE_ACCOUNT_ID"],
                workspace_id=ids["ANTHROPIC_WORKSPACE_ID"],
            ), max_retries=MAX_RETRIES)
        elif c.get("source") == "key":
            key = settings.api_key()
            if not key:
                raise NoCredentials("no API key saved: paste one in Settings")
            made = AsyncAnthropic(api_key=key, max_retries=MAX_RETRIES)
        else:
            raise NoCredentials("no credentials yet: choose them in Settings")
        _cache.clear()
        _cache[sig] = made
        return made


def failure(e: BaseException) -> str:
    """A failed call in one plain line for the chat; a 401 names the time and the credentials, as the person who can
    see the reason on the admin side needs them."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    if isinstance(e, NoCredentials):
        return f"Claude is not signed in: {e}."
    if isinstance(e, anthropic.AuthenticationError):
        return (f"Sign-in failed (401) at {now} with {describe()}. Check the credentials in Settings; the reason is "
                "visible to whoever manages them.")
    if isinstance(e, anthropic.PermissionDeniedError):
        return f"These credentials may not use this model or feature (403) at {now}, with {describe()}."
    if isinstance(e, anthropic.RateLimitError):
        return "Claude's rate limit was reached and the retries ran out. Send the message again in a minute."
    if isinstance(e, anthropic.APIStatusError):
        msg = re.sub(r"\s+", " ", str(getattr(e, "message", e)))[:300]
        return f"Claude's API answered {e.status_code}: {msg}"
    if isinstance(e, anthropic.APIConnectionError):
        return "Claude's API could not be reached. Check the network and send the message again."
    return f"Claude stopped with an error: {type(e).__name__}: {str(e)[:300]}"


def request_args(*, effort: str | None = None, model: str | None = None) -> dict[str, Any]:
    """What every request carries: the model, the effort, and the server-side fallback on a refusal."""
    s = settings.read()
    m = model or s["model"]
    args: dict[str, Any] = {"model": m, "output_config": {"effort": effort or s["effort"]}}
    if not m.startswith("claude-haiku"):
        args.update(betas=[FALLBACK_BETA], fallbacks="default")
    return args


async def complete(system: str, user: str, *, max_tokens: int = 8000, effort: str = "low",
                   schema: dict[str, Any] | None = None) -> str:
    """One model call with no tools: the reply's text (JSON when `schema` is given)."""
    args = request_args(effort=effort)
    if schema is not None:
        args["output_config"] = {**args["output_config"], "format": {"type": "json_schema", "schema": schema}}
    msg = await client().beta.messages.create(max_tokens=max_tokens, system=system,
                                              messages=[{"role": "user", "content": user}], **args)
    if msg.stop_reason == "refusal":
        return ""
    return "".join(b.text for b in msg.content if b.type == "text")

