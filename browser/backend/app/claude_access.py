"""How thimble reaches Claude: one choice per install, made once and changed in Settings.

    api-key       an Anthropic API key the person pasted (the default). The server calls the Messages API itself.
    wif           Workload Identity Federation, from a config file the person names (wif.py). The server calls the
                  Messages API itself.
    claude-code   the person's Claude Code sign-in. thimble launches headless Claude Code sessions in the background
                  (runtime_cc.py), and only with the person's consent to CONSENT.

With api-key and wif nothing launches a `claude` process: every agent runs in the server (runtime_api.py). The choice
is kept in <home>/claude-access.json ({how, wif_file, consent}), the key in <home>/anthropic-api-key (0600); neither
holds a value the environment gave, since the server never reads ANTHROPIC_* variables (scrub_env). install.sh asks
for the choice (`python -m app.claude_access setup`), the page's first-run step and Settings change it (the routes).

problem() says, without a network call, what is missing (no choice, no key, a WIF file that cannot be used, no consent,
no `claude`), in words for the chat's card and the server's start line; check() makes one small call to be sure.
Nothing here prints or logs a key, an ID or a token.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import wif

router = APIRouter()

API_KEY, CLAUDE_CODE, WIF = "api-key", "claude-code", "wif"
CHOICES = (API_KEY, CLAUDE_CODE, WIF)
ACCESS_FILE = "claude-access.json"
KEY_FILE = "anthropic-api-key"
CONSENT = ("This uses your Claude subscription through Claude Code and will launch headless Claude Code sessions in "
           "the background.")
LABELS = {API_KEY: "Anthropic API key", CLAUDE_CODE: "Claude Code sign-in", WIF: "Workload Identity Federation"}
CHECK_MODEL = "claude-haiku-4-5-20251001"  # the check's one small call


def _home() -> Path:
    return Path(os.environ.get("THIMBLE_HOME") or "~/.thimble").expanduser()


def access_path() -> Path:
    return _home() / ACCESS_FILE


def key_path() -> Path:
    return _home() / KEY_FILE


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def read() -> dict[str, Any]:
    """The saved choice: {how, wif_file, consent}; {} before one is made."""
    try:
        got = json.loads(access_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def how() -> str:
    """The way chosen, '' before one is made."""
    h = str(read().get("how") or "")
    return h if h in CHOICES else ""


def api_key() -> str:
    try:
        return key_path().read_text("utf-8").strip()
    except OSError:
        return ""


def has_key() -> bool:
    return bool(api_key())


class AccessError(ValueError):
    """A choice that cannot be saved, in one sentence for the person."""


def save(choice: str, *, key: str | None = None, wif_file: str | None = None, consent: bool = False) -> dict[str, Any]:
    """Save `choice`. api-key keeps the key given, or the one saved before; wif needs a file wif.load accepts;
    claude-code needs `consent`, the person's yes to CONSENT. AccessError says why a choice is refused."""
    if choice not in CHOICES:
        raise AccessError(f"choose one of {', '.join(CHOICES)}")
    rec: dict[str, Any] = {"how": choice, "at": _now()}
    if choice == API_KEY:
        k = (key or "").strip()
        if k:
            if not k.startswith("sk-") or any(ch.isspace() for ch in k):
                raise AccessError("that does not look like an Anthropic API key (it starts with sk-ant-)")
            _write_private(key_path(), k + "\n")
        elif not has_key():
            raise AccessError("paste an Anthropic API key")
    elif choice == WIF:
        try:
            conf = wif.load(str(wif_file or ""))
        except wif.WifError as e:
            raise AccessError(str(e)) from None
        rec["wif_file"] = str(conf.path)
    elif choice == CLAUDE_CODE:
        if not consent:
            raise AccessError("Claude Code sign-in needs your confirmation: " + CONSENT)
        rec["consent"] = {"at": _now(), "text": CONSENT}
    _write_private(access_path(), json.dumps(rec, indent=1) + "\n")
    from . import llm  # noqa: PLC0415

    llm.forget()
    return rec


def describe() -> str:
    """The way in words, for Settings and the log; never a key or an ID."""
    rec, h = read(), how()
    if h == API_KEY:
        return "an Anthropic API key" + ("" if has_key() else " (none saved)")
    if h == WIF:
        return f"Workload Identity Federation from {rec.get('wif_file') or '(no file)'}"
    if h == CLAUDE_CODE:
        return "your Claude Code sign-in"
    return "not chosen yet"


def problem() -> dict[str, str] | None:
    """What keeps Claude from being reached, without a network call: {what, fix}, or None when nothing is missing."""
    rec, h = read(), how()
    fix = "Open Claude access in Settings, or run thimble-browser --setup in a terminal."
    if not h:
        return {"what": "thimble does not know yet how to reach Claude.",
                "fix": "Choose an API key, your Claude Code sign-in or Workload Identity Federation."}
    if h == API_KEY and not has_key():
        return {"what": "No Anthropic API key is saved.", "fix": "Paste one. " + fix}
    if h == WIF:
        try:
            wif.load(str(rec.get("wif_file") or ""))
        except wif.WifError as e:
            return {"what": f"The Workload Identity Federation config cannot be used: {e}.", "fix": fix}
    if h == CLAUDE_CODE:
        from . import config  # noqa: PLC0415

        if not (rec.get("consent") or {}).get("at"):
            return {"what": "Claude Code sign-in was chosen without your confirmation.", "fix": "Confirm it. " + fix}
        if not config.CLI_PATH:
            return {"what": "Claude Code sign-in was chosen, but the `claude` command was not found.",
                    "fix": "Install Claude Code, or choose an API key. " + fix}
    return None


def problem_line() -> str:
    """problem() on one line, '' when there is none: for the server's start line."""
    p = problem()
    return f"{p['what']} {p['fix']}" if p else ""


async def check() -> dict[str, Any]:
    """problem(), then one small call over the chosen way: {ok, how, describe, problem?}."""
    out: dict[str, Any] = {"how": how(), "describe": describe()}
    p = problem()
    if p:
        return {**out, "ok": False, "problem": p}
    if how() == CLAUDE_CODE:
        from . import config  # noqa: PLC0415

        status = await asyncio.to_thread(config.auth_status)
        if isinstance(status, dict) and status.get("loggedIn") is False:
            return {**out, "ok": False, "problem": {"what": "Claude Code is not signed in.",
                                                     "fix": "Run `claude` in a terminal and sign in, then check again."}}
        return {**out, "ok": True}
    from . import llm  # noqa: PLC0415

    try:
        await llm.client().messages.create(model=CHECK_MODEL, max_tokens=1,
                                           messages=[{"role": "user", "content": "ok"}])
    except Exception as e:  # noqa: BLE001 — any failure is the check's answer
        return {**out, "ok": False, "problem": {"what": llm.failure(e), "fix": "Check the choice in Settings."}}
    return {**out, "ok": True}


def status() -> dict[str, Any]:
    """What GET /api/claude-access shows: the choice, its words, what is missing, and the consent text. No secret."""
    rec = read()
    return {"how": how(), "describe": describe(), "problem": problem(), "key_saved": has_key(),
            "wif_file": rec.get("wif_file") or "", "consent_text": CONSENT, "choices": list(CHOICES), "labels": LABELS}


# --------------------------------------------------------------------------- routes


class AccessBody(BaseModel):
    how: str
    key: str | None = None
    wif_file: str | None = None
    consent: bool = False


def _analyst(request: Request) -> None:
    from . import hook_auth  # noqa: PLC0415

    if not hook_auth.analyst(request):
        raise HTTPException(403, "only the signed-in browser changes how thimble reaches Claude")


@router.get("/claude-access")
async def get_route() -> dict[str, Any]:
    return status()


@router.put("/claude-access")
async def put_route(body: AccessBody, request: Request) -> dict[str, Any]:
    _analyst(request)
    try:
        await asyncio.to_thread(save, body.how, key=body.key, wif_file=body.wif_file, consent=body.consent)
    except AccessError as e:
        raise HTTPException(400, str(e)) from None
    from . import runtime  # noqa: PLC0415

    runtime.access_changed()
    return {**status(), "check": await check()}


@router.post("/claude-access/check")
async def check_route() -> dict[str, Any]:
    return await check()


# --------------------------------------------------------------------------- the install's question


def _ask(prompt: str, default: str = "") -> str:
    try:
        got = input(prompt).strip()
    except EOFError:
        return default
    return got or default


def setup(argv: list[str] | None = None) -> int:
    """`python -m app.claude_access setup [--how H] [--wif-file F] [--yes]`: ask how to reach Claude (1 API key, the
    default; 2 Claude Code sign-in, after the consent text; 3 WIF, its config file), check it, and save it. The key is
    read without echo, or from stdin when it is not a terminal. Exit 0 when saved and checked, 1 when not saved, 2 when
    saved and the check failed."""
    ap = argparse.ArgumentParser(prog="thimble-browser --setup")
    ap.add_argument("--how", choices=CHOICES)
    ap.add_argument("--wif-file")
    ap.add_argument("--yes", action="store_true", help="confirm Claude Code sign-in's consent text")
    ap.add_argument("--no-check", action="store_true")
    args = ap.parse_args(argv)
    choice = args.how
    if not choice:
        print("How should thimble browser reach Claude?")
        print("  1  an Anthropic API key (default)")
        print("  2  your Claude Code sign-in (launches headless Claude Code sessions)")
        print("  3  Workload Identity Federation (a config file)")
        choice = {"1": API_KEY, "2": CLAUDE_CODE, "3": WIF}.get(_ask("Choose 1, 2 or 3 [1]: ", "1"))
        if not choice:
            print("thimble: no choice saved; run thimble-browser --setup again.")
            return 1
    try:
        if choice == API_KEY:
            key = ""
            if sys.stdin.isatty():
                key = getpass.getpass("Paste your Anthropic API key (it is not shown): ").strip()
            else:
                key = sys.stdin.readline().strip()
            save(API_KEY, key=key)
        elif choice == CLAUDE_CODE:
            print(CONSENT)
            ok = args.yes or _ask("Continue? [y/N]: ").lower() in ("y", "yes")
            if not ok:
                print("thimble: Claude Code sign-in was not chosen.")
                return 1
            save(CLAUDE_CODE, consent=True)
        else:
            path = args.wif_file or _ask("Path of the Workload Identity Federation config file: ")
            save(WIF, wif_file=path)
    except AccessError as e:
        print(f"thimble: not saved: {e}")
        return 1
    print(f"thimble: saved: {describe()}.")
    if args.no_check:
        return 0
    got = asyncio.run(check())
    if got.get("ok"):
        print("thimble: checked: Claude answers.")
        return 0
    p = got.get("problem") or {}
    print(f"thimble: the check failed: {p.get('what', '')} {p.get('fix', '')}".rstrip())
    return 2


def main(argv: list[str] | None = None) -> int:
    from . import llm  # noqa: PLC0415

    llm.scrub_env()
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "status"
    if cmd == "setup":
        return setup(argv[1:])
    if cmd == "status":
        p = problem_line()
        print(f"thimble: Claude access: {describe()}" + (f". {p}" if p else ""))
        return 0 if not p else 1
    if cmd == "check":
        got = asyncio.run(check())
        print(json.dumps({k: v for k, v in got.items()}, indent=1))
        return 0 if got.get("ok") else 1
    print("usage: python -m app.claude_access setup | status | check", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
