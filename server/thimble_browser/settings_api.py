"""Settings in the page: the gear's popover reads and changes settings.py.

    GET  /api/ws/{c}/settings           the settings, with the choices the popover offers
    PUT  /api/ws/{c}/settings           change some of them: credentials, model, effort, explain
    PUT  /api/ws/{c}/settings/api-key   keep an API key the analyst pasted (never sent back, never logged)
    DELETE /api/ws/{c}/settings/api-key remove it
    POST /api/ws/{c}/settings/check     one Models API call with the credentials now saved: are they good?

Settings belong to the server's home, not to one workspace; the routes take a workspace only because the page asks
under one. Every agent runs on the one model and effort Settings name, so the 0.8 page's per-role rows (`models`) all
show those, and a change to any role's row changes them. A new choice applies from Claude's next request: llm.client()
builds its client from the settings each time they change.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, Request

from . import home, llm, settings

log = logging.getLogger("thimble_browser.settings_api")

KEY_MAX = 512  # characters of an API key, which is far shorter
ROLES = ("main", "writer", "dev")  # the 0.8 page's roles that thimble browser runs, all on the one model


def view() -> dict[str, Any]:
    """The settings as the page reads them. The API key itself is never in it: only whether one is saved."""
    s = settings.read()
    conf = {"model": s["model"], "effort": s["effort"], "fast": False}
    return {
        "credentials": s["credentials"],
        "signed_in": llm.describe(),
        "has_api_key": settings.has_api_key(),
        "model": s["model"],
        "effort": s["effort"],
        "explain": s["explain"],
        "choices": {"models": list(settings.MODELS), "efforts": list(settings.EFFORTS), "orgs": settings.wif_orgs()},
        "models": {r: dict(conf) for r in ROLES},
    }


def patch_of(body: dict[str, Any]) -> dict[str, Any]:
    """What settings.write takes from the page's body: its own keys, and a 0.8 role row's model or effort as the one
    model and effort."""
    out = {k: body[k] for k in ("credentials", "model", "effort", "explain") if k in body}
    for conf in (body.get("models") or {}).values():
        if isinstance(conf, dict):
            if conf.get("model"):
                out.setdefault("model", conf["model"])
            if conf.get("effort"):
                out.setdefault("effort", conf["effort"])
    return out


async def _json(request: Request) -> dict[str, Any]:
    """The request's JSON object; a 400 that never repeats what was sent (it may hold a key)."""
    try:
        got = await request.json()
    except ValueError:
        raise HTTPException(400, "the body is not JSON") from None
    if not isinstance(got, dict):
        raise HTTPException(400, "the body is not a JSON object")
    return got


def register(ctx: Any) -> None:
    app = ctx.app

    @app.get("/api/ws/{c}/settings")
    def get_settings(c: str) -> dict[str, Any]:
        ctx.ws_of(c)
        return view()

    @app.put("/api/ws/{c}/settings")
    async def put_settings(c: str, request: Request) -> dict[str, Any]:
        ctx.ws_of(c)
        patch = patch_of(await _json(request))
        try:
            settings.write(patch)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        if "effort" in patch:
            # the composer's choice for this workspace gives way to the one just saved, so both show the same
            p = home.workspace_dir(c) / "session.json"
            got = home.read_json(p, {}) or {}
            if got.pop("effort", None) is not None:
                home.write_json(p, got)
        from .hub import hub  # noqa: PLC0415

        hub.publish(c, {"type": "chat", "chat": "main"})  # the composer's line names the model and effort
        log.info("settings changed: %s", ", ".join(sorted(patch)) or "nothing")
        return view()

    @app.put("/api/ws/{c}/settings/api-key")
    async def put_key(c: str, request: Request) -> dict[str, Any]:
        ctx.ws_of(c)
        key = str((await _json(request)).get("key") or "").strip()
        if not key:
            raise HTTPException(400, "paste a key, or remove the saved one")
        if len(key) > KEY_MAX or any(ch.isspace() for ch in key) or not key.isprintable():
            raise HTTPException(400, "that does not look like an API key")
        settings.set_api_key(key)
        log.info("an API key was saved")
        return view()

    @app.delete("/api/ws/{c}/settings/api-key")
    def delete_key(c: str) -> dict[str, Any]:
        ctx.ws_of(c)
        settings.set_api_key("")
        log.info("the API key was removed")
        return view()

    @app.post("/api/ws/{c}/settings/check")
    async def check(c: str) -> dict[str, Any]:
        """One Models API call with the saved credentials: {ok, message}."""
        ctx.ws_of(c)
        try:
            await llm.client().models.list(limit=1)
        except Exception as e:  # noqa: BLE001 — the failure is the answer, in the chat's words
            return {"ok": False, "message": llm.failure(e)}
        return {"ok": True, "message": f"Signed in with {llm.describe()}."}
