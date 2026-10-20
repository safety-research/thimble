"""The Messages API client, built only from explicit credentials (settings.py):

- Workload Identity Federation: a config file the analyst names (wif.py) gives the IDs and where the identity token
  comes from, and both go to `WorkloadIdentityCredentials`. Nothing goes through the environment.
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
from typing import Any

import anthropic
from anthropic import AsyncAnthropic
from anthropic.lib.credentials import WorkloadIdentityError

from . import settings, wif

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


def describe() -> str:
    """The credentials in words, for the page and the log; never an id or a key."""
    c = settings.read()["credentials"]
    if c.get("source") == "wif":
        if not c.get("file"):
            return "Workload Identity Federation (no config file named yet)"
        try:
            how = f" ({wif.load(str(c.get('file'))).describe()})"
        except wif.WifError:
            how = " (which cannot be used now)"
        return f"Workload Identity Federation from {c.get('file')}{how}"
    if c.get("source") == "key":
        return "an API key" if settings.has_api_key() else "an API key (none saved yet)"
    return "none"


def client() -> AsyncAnthropic:
    """The client for the credentials Settings names; NoCredentials when there are none."""
    c = settings.read()["credentials"]
    sig = json.dumps(c, sort_keys=True)
    if c.get("source") == "key" and settings.has_api_key():
        sig += str(settings._key_path().stat().st_mtime_ns)
    elif c.get("source") == "wif":
        sig += wif.stamp(str(c.get("file") or ""))
    with _lock:
        if sig in _cache:
            return _cache[sig]
        if c.get("source") == "wif":
            from anthropic import WorkloadIdentityCredentials  # noqa: PLC0415

            try:
                conf = wif.load(str(c.get("file") or ""))
            except wif.WifError as e:
                raise NoCredentials(f"the Workload Identity Federation config cannot be used: {e}") from None
            made = AsyncAnthropic(credentials=WorkloadIdentityCredentials(
                identity_token_provider=conf.token_provider(),
                federation_rule_id=conf.ids["federation_rule_id"],
                organization_id=conf.ids["organization_id"],
                service_account_id=conf.ids.get("service_account_id"),
                workspace_id=conf.ids.get("workspace_id"),
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
    if isinstance(e, wif.WifError):
        return f"No identity token at {now} for {describe()}: {e}."
    if isinstance(e, WorkloadIdentityError):
        code = f" ({e.status_code})" if e.status_code else ""
        return (f"The identity token was not exchanged{code} at {now} with {describe()}. Check the IDs and the token "
                "source in the config file; the reason is visible to whoever manages the federation rule.")
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

