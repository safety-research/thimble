"""The Messages API client for the API-key and Workload Identity Federation ways to reach Claude (claude_access.py).

The client is built from what the person chose, passed to the SDK by name, so that no other credential of the
environment stands in for it: the API key (ANTHROPIC_API_KEY when it is set where the workbench runs, else the key
pasted in Settings), or the WIF config file they named (wif.py), passed to `WorkloadIdentityCredentials`. The rest of
the environment is used as it is (ANTHROPIC_BASE_URL, a proxy), as the SDK uses it in the person's terminal. failure()
says a failed call in one plain sentence, never a raw exception name such as NoCredentials.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("thimble.llm")

FALLBACK_BETA = "server-side-fallback-2026-07-01"
FAST_BETA = "fast-mode-2026-02-01"
MAX_RETRIES = 6  # the SDK retries 408, 409, 429 and 5xx with backoff
_lock = threading.Lock()
_cache: dict[str, Any] = {}


class NoCredentials(Exception):
    """Claude cannot be reached the way chosen; the message is claude_access.problem()'s words."""


def forget() -> None:
    """Drop the cached client, after the choice changed."""
    with _lock:
        _cache.clear()


def warm() -> None:
    """Import the SDK and build the client for the way chosen, in a worker thread at the server's start, so the first
    message does not wait for them. Never raises: a choice that cannot be used says so at its first turn."""
    try:
        import anthropic  # noqa: F401, PLC0415

        client()
    except Exception:  # noqa: BLE001
        log.debug("the client was not built ahead", exc_info=True)


def client() -> Any:
    """The AsyncAnthropic client for the way chosen (api-key or wif); NoCredentials when it cannot be built."""
    from anthropic import AsyncAnthropic  # noqa: PLC0415

    from . import claude_access, wif  # noqa: PLC0415

    rec, how = claude_access.read(), claude_access.how()
    p = claude_access.problem()
    if p:
        raise NoCredentials(f"{p['what']} {p['fix']}")
    if how not in (claude_access.API_KEY, claude_access.WIF):
        raise NoCredentials("this way of reaching Claude runs Claude Code sessions, not the Messages API")
    sig = json.dumps(rec, sort_keys=True)
    if how == claude_access.API_KEY:
        # the key it uses, by its hash: ANTHROPIC_API_KEY, or the one pasted, which Settings may change
        sig += hashlib.sha256(claude_access.api_key().encode()).hexdigest()
    else:
        sig += wif.stamp(str(rec.get("wif_file") or ""))
    with _lock:
        if sig in _cache:
            return _cache[sig]
        if how == claude_access.WIF:
            from anthropic import WorkloadIdentityCredentials  # noqa: PLC0415

            try:
                conf = wif.load(str(rec.get("wif_file") or ""))
            except wif.WifError as e:
                raise NoCredentials(f"The Workload Identity Federation config cannot be used: {e}.") from None
            made = AsyncAnthropic(credentials=WorkloadIdentityCredentials(
                identity_token_provider=conf.token_provider(),
                federation_rule_id=conf.ids["federation_rule_id"],
                organization_id=conf.ids["organization_id"],
                service_account_id=conf.ids.get("service_account_id"),
                workspace_id=conf.ids.get("workspace_id"),
            ), max_retries=MAX_RETRIES)
        else:
            made = AsyncAnthropic(api_key=claude_access.api_key(), max_retries=MAX_RETRIES)
        _cache.clear()
        _cache[sig] = made
        return made


def credentials_failure(e: BaseException) -> bool:
    """Whether `e` says the credentials are missing or refused (the chat's Claude-access card), not a passing error."""
    import anthropic  # noqa: PLC0415
    from anthropic.lib.credentials import WorkloadIdentityError  # noqa: PLC0415

    from . import wif  # noqa: PLC0415

    return isinstance(e, (NoCredentials, wif.WifError, WorkloadIdentityError, anthropic.AuthenticationError))


def api_refusal(status: int, body: Any, raw: str) -> str:
    """An error answer of Claude's API in one plain sentence: its status, the kind of error in words and the API's own
    message, from the answer's body ({"error": {"type", "message"}}); the raw text when the body holds none."""
    err = body.get("error") if isinstance(body, dict) else None
    said = err.get("message") if isinstance(err, dict) else None
    if not isinstance(said, str) or not said.strip():
        flat = re.sub(r"\s+", " ", raw)[:300]
        return f"Claude's API answered {status}: {flat}"
    kind = str(err.get("type") or "").removesuffix("_error").replace("_", " ")
    said = re.sub(r"\s+", " ", said).strip()[:300]
    return f"Claude's API answered {status}{f' ({kind})' if kind else ''}: {said}{'' if said.endswith('.') else '.'}"


def failure(e: BaseException) -> str:
    """A failed call in one plain sentence; a 401 names the time and the way, which whoever manages the credentials
    needs to find the reason."""
    import anthropic  # noqa: PLC0415
    from anthropic.lib.credentials import WorkloadIdentityError  # noqa: PLC0415

    from . import claude_access, wif  # noqa: PLC0415

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    if isinstance(e, NoCredentials):
        return str(e)
    if isinstance(e, wif.WifError):
        return f"No identity token at {now} for {claude_access.describe()}: {e}."
    if isinstance(e, WorkloadIdentityError):
        code = f" ({e.status_code})" if getattr(e, "status_code", None) else ""
        return (f"The identity token was not exchanged{code} at {now}, for {claude_access.describe()}. Check the "
                "IDs and the token source in the config file; whoever manages the federation rule can see the reason.")
    if isinstance(e, anthropic.AuthenticationError):
        where = ("ANTHROPIC_API_KEY where the workbench runs" if claude_access.how() == claude_access.API_KEY
                 and claude_access.env_key() else "them in Settings, Claude access")
        return f"Claude refused the credentials (401) at {now}, for {claude_access.describe()}. Check {where}."
    if isinstance(e, anthropic.PermissionDeniedError):
        return f"These credentials may not use this model or feature (403) at {now}, for {claude_access.describe()}."
    if isinstance(e, anthropic.RateLimitError):
        return "Claude's rate limit was reached and the retries ran out. Send the message again in a minute."
    if isinstance(e, anthropic.APIStatusError):
        return api_refusal(e.status_code, getattr(e, "body", None), str(getattr(e, "message", e)))
    if isinstance(e, anthropic.APIConnectionError):
        return "Claude's API could not be reached. Check the network and send the message again."
    return f"Claude stopped with an error: {str(e)[:300] or type(e).__name__}"


def has_fast_mode(model: str) -> bool:
    m = model.lower()
    return "opus-5" in m or "opus-4-8" in m


def request_args(*, model: str, effort: str | None, fast: bool = False) -> dict[str, Any]:
    """What every request carries: the model (without Claude Code's `[1m]` tag), its effort, and the server-side
    fallback on a refusal; fast mode where asked and the model has it."""
    from . import config  # noqa: PLC0415

    m = config.base_model(model)
    args: dict[str, Any] = {"model": m}
    if effort and config.has_effort(m):
        args["output_config"] = {"effort": "xhigh" if effort == "ultracode" else effort}
    betas: list[str] = []
    if not m.startswith("claude-haiku"):
        betas.append(FALLBACK_BETA)
        args["fallbacks"] = "default"
    if fast and has_fast_mode(m):
        betas.append(FAST_BETA)
        args["speed"] = "fast"
    if betas:
        args["betas"] = betas
    return args
