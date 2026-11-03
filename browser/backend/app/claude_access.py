"""How thimble reaches Claude: one choice per install, made once and changed in Settings.

    claude-code   the person's Claude Code sign-in (the default, and recommended). thimble runs Claude Code in the
                  background (runtime_cc.py), with the environment as it is, so that Claude Code signs in as it does in
                  the person's terminal; only with the person's consent to CONSENT, which choosing it gives.
    api-key       an Anthropic API key: ANTHROPIC_API_KEY when it is set where the workbench runs, else the key the
                  person pasted in Settings. The server calls the Messages API itself.
    wif           Workload Identity Federation, from the config file the person names (wif.py). The server calls the
                  Messages API itself.

The calls of api-key and wif go to base_url(): ANTHROPIC_BASE_URL only with ANTHROPIC_API_KEY, which come from the
same shell, as Claude Code sends them; a pasted key goes to API_URL, and WIF to the config file's base_url (API_URL by
default), so a key or a token the workbench keeps never goes to an address the shell set. describe() names the host when
it is not API_HOST.

With api-key and wif nothing launches a `claude` process: every agent runs in the server (runtime_api.py). The choice
is kept in <home>/claude-access.json ({how, wif_file, consent}), a pasted key in <home>/anthropic-api-key (0600).
scripts/install.sh sets the choice (`thimble-browser --setup`, with --sign-in, or asked in a terminal); the page's
first-run step and Settings change it (the routes).

problem() says, without a network call, what is missing (no choice, no key, a WIF file that cannot be used, no consent,
no `claude`), in words for the chat's card and the server's start line; check() makes one small call to be sure (with
Claude Code sign-in, a one-turn headless `claude -p`, and the login that `claude auth status` reports for it, which
says whether a key stands in for the sign-in). setup's line says the choice, the login, and what the check found.
Nothing here prints or logs a key, an ID or a token.
"""
from __future__ import annotations

import argparse
import asyncio
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
CHOICES = (CLAUDE_CODE, API_KEY, WIF)  # the order of the install's question and of the page's dialog
ACCESS_FILE = "claude-access.json"
KEY_FILE = "anthropic-api-key"
ENV_KEY = "ANTHROPIC_API_KEY"  # the API key of the environment the workbench runs in, which wins over a pasted one
ENV_BASE_URL = "ANTHROPIC_BASE_URL"  # where the calls with ENV_KEY go, when it is set (base_url)
API_URL = wif.DEFAULT_BASE_URL  # Anthropic's API, where a pasted key's calls go
API_HOST = "api.anthropic.com"
# each way in a few words, as the install's question and the page's dialog give them; the Claude Code sign-in's words
# are what the person consents to when they choose it (CONSENT)
LABELS = {CLAUDE_CODE: "Your Claude Code sign-in", API_KEY: "An Anthropic API key", WIF: "Workload Identity Federation"}
HINTS = {CLAUDE_CODE: "it runs Claude Code in the background, on your Claude plan",
         API_KEY: f"{ENV_KEY} when it is set, or a key you paste in the workbench's Settings",
         WIF: "the path of your WIF config file"}
CONSENT = f"{LABELS[CLAUDE_CODE]}: {HINTS[CLAUDE_CODE]}."
CHECK_MODEL = "claude-haiku-5-5"  # the check's one small call
CC_CHECK_MODEL = "haiku"  # the Claude Code sign-in check's one-turn session
CC_CHECK_TIMEOUT_S = 120.0


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


def env_key() -> str:
    """ANTHROPIC_API_KEY of the environment the workbench runs in ('' when it is not set): the API key it uses."""
    return (os.environ.get(ENV_KEY) or "").strip()


def saved_key() -> str:
    """The key the person pasted in Settings, which the workbench uses when ANTHROPIC_API_KEY is not set."""
    try:
        return key_path().read_text("utf-8").strip()
    except OSError:
        return ""


def api_key() -> str:
    """The API key the workbench uses with api-key: ANTHROPIC_API_KEY when it is set, else the one pasted in
    Settings."""
    return env_key() or saved_key()


def has_key() -> bool:
    return bool(api_key())


def base_url() -> str:
    """Where the Messages API calls of api-key and wif go (module note): ANTHROPIC_BASE_URL when it is set and the key
    is ANTHROPIC_API_KEY, the config file's base_url with wif, else API_URL."""
    h = how()
    if h == WIF:
        try:
            return wif.load(str(read().get("wif_file") or "")).base_url
        except wif.WifError:
            return API_URL
    if h == API_KEY and env_key():
        return (os.environ.get(ENV_BASE_URL) or "").strip() or API_URL
    return API_URL


def _sent_to() -> str:
    """describe()'s words for the host of base_url() when it is not API_HOST, else ''; the host alone, never the rest
    of the address."""
    from urllib.parse import urlparse  # noqa: PLC0415

    try:
        host = urlparse(base_url()).hostname or "an address with no host"
    except ValueError:
        host = "an address with no host"
    if host == API_HOST:
        return ""
    return f", sent to {host}" + (f" ({ENV_BASE_URL})" if how() == API_KEY else "")


class AccessError(ValueError):
    """A choice that cannot be saved, in one sentence for the person."""


def save(choice: str, *, key: str | None = None, wif_file: str | None = None, consent: bool = False) -> dict[str, Any]:
    """Save `choice`. api-key keeps the key given (pasted in Settings) or the one saved before, and needs none: the
    workbench uses ANTHROPIC_API_KEY when it is set, and asks for a key when there is neither; wif needs a file
    wif.load accepts; claude-code needs `consent`, the person's yes to CONSENT. AccessError says why a choice is
    refused."""
    if choice not in CHOICES:
        raise AccessError(f"choose one of {', '.join(CHOICES)}")
    rec: dict[str, Any] = {"how": choice, "at": _now()}
    if choice == API_KEY:
        k = (key or "").strip()
        if k:
            if not k.startswith("sk-") or any(ch.isspace() for ch in k):
                raise AccessError("that does not look like an Anthropic API key (it starts with sk-ant-)")
            _write_private(key_path(), k + "\n")
    elif choice == WIF:
        try:
            conf = wif.load(str(wif_file or ""))
        except wif.WifError as e:
            raise AccessError(str(e)) from None
        rec["wif_file"] = str(conf.path)
    elif choice == CLAUDE_CODE:
        if not consent:
            raise AccessError("Claude Code sign-in needs your confirmation. " + CONSENT)
        rec["consent"] = {"at": _now(), "text": CONSENT}
    _write_private(access_path(), json.dumps(rec, indent=1) + "\n")
    from . import llm  # noqa: PLC0415

    llm.forget()
    return rec


def _tilde(p: str) -> str:
    home = str(Path.home())
    return "~" + p[len(home):] if p.startswith(home + os.sep) else p


def describe() -> str:
    """The way in words, for Settings, the log and setup's line, with the host its calls go to when it is not API_HOST
    (_sent_to); never a key or an ID."""
    rec, h = read(), how()
    if h == API_KEY:
        if env_key():
            return "an API key, from ANTHROPIC_API_KEY" + _sent_to()
        return "an API key, the one saved in Settings" if saved_key() else "an API key (none yet)"
    if h == WIF:
        return f"Workload Identity Federation, with {_tilde(str(rec.get('wif_file') or '(no file)'))}" + _sent_to()
    if h == CLAUDE_CODE:
        return "your Claude Code sign-in"
    return "not chosen yet"


def problem() -> dict[str, str] | None:
    """What keeps Claude from being reached, without a network call: {what, fix}, or None when nothing is missing."""
    rec, h = read(), how()
    fix = "Open Claude access in Settings, or run thimble-browser --setup in a terminal."
    if not h:
        return {"what": "thimble does not know yet how to reach Claude.",
                "fix": "Choose your Claude Code sign-in, an API key or Workload Identity Federation."}
    if h == API_KEY and not has_key():
        return {"what": "No API key: ANTHROPIC_API_KEY is not set, and no key is saved.",
                "fix": "Paste one in Settings, Claude access, or set ANTHROPIC_API_KEY and start thimble-browser "
                       "again."}
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


# Claude Code's words for its login (`claude auth status --json`: authMethod, apiProvider, apiKeySource), as the
# person reads them
LOGINS = {"claude.ai": "a Claude account", "api_key": "an API key",
          "api_key_helper": "an API key from its apiKeyHelper", "oauth_token": "an OAuth token"}
PROVIDERS = {"bedrock": "Amazon Bedrock", "vertex": "Google Vertex AI", "foundry": "Microsoft Foundry",
             "gateway": "a gateway"}
KEY_SOURCES = {"/login managed key": "its /login", "apiKeyHelper": "its apiKeyHelper"}


def _login(status: dict[str, Any] | None) -> str:
    """The login `claude auth status` reports (config.auth_status), in a few words: a Claude account, an API key and
    where it comes from (ANTHROPIC_API_KEY, which a `claude` thimble starts gets from the environment as it is, or
    Claude Code's own settings), an OAuth token (Workload Identity Federation among them), or the cloud provider; ''
    when it says none."""
    if not isinstance(status, dict) or status.get("authMethod") in (None, "", "none"):
        return ""
    method = str(status["authMethod"])
    if method == "third_party":
        return PROVIDERS.get(str(status.get("apiProvider") or ""), "a cloud provider")
    words = LOGINS.get(method, method)
    source = str(status.get("apiKeySource") or "")
    if method == "api_key" and source:
        words += f" from {KEY_SOURCES.get(source, source)}"
    return words


async def check() -> dict[str, Any]:
    """problem(), then one small call over the chosen way: {ok, how, describe, problem?}, and with Claude Code sign-in
    the login its sessions use (login: _login's words, '' when unknown). A problem's fix says what to do; the command
    that checks again is setup's (again)."""
    out: dict[str, Any] = {"how": how(), "describe": describe()}
    p = problem()
    if p:
        return {**out, "ok": False, "problem": p}
    if how() == CLAUDE_CODE:
        from . import config  # noqa: PLC0415

        status = await asyncio.to_thread(config.auth_status)
        if isinstance(status, dict) and status.get("loggedIn") is False:
            return {**out, "ok": False, "problem": {"what": "Claude Code is not signed in.",
                                                     "fix": "Run claude in a terminal and sign in."}}
        out["login"] = login = _login(status)
        failed = await asyncio.to_thread(_claude_code_answers)
        if failed:
            who = f"Claude Code, logged in with {login}," if login else "Claude Code"
            return {**out, "ok": False, "problem": {"what": f"{who} did not answer: {failed.rstrip('.')}.",
                                                     "fix": "Run claude in a terminal and check that it answers."}}
        return {**out, "ok": True}
    from . import llm  # noqa: PLC0415

    try:
        await llm.client().messages.create(model=CHECK_MODEL, max_tokens=1,
                                           messages=[{"role": "user", "content": "ok"}])
    except Exception as e:  # noqa: BLE001 — any failure is the check's answer
        return {**out, "ok": False, "problem": {"what": llm.failure(e), "fix": ""}}
    return {**out, "ok": True}


def _claude_code_answers() -> str:
    """One turn of a headless `claude -p` on the person's sign-in, with no tools, plugins or hooks (--safe-mode), in
    the environment every `claude` thimble starts gets (config.launch_environ): '' when Claude answers, else what went
    wrong in a short line. Skipped under THIMBLE_SKIP_KEY (the tests)."""
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    from . import config  # noqa: PLC0415

    if config._skip() or not config.CLI_PATH:
        return ""
    argv = [config.CLI_PATH, "-p", "Reply with the word ok.", "--model", CC_CHECK_MODEL, "--max-turns", "1",
            "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--safe-mode", "--output-format", "json"]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, env=config.launch_environ(),
                           cwd=tempfile.gettempdir(), stdin=subprocess.DEVNULL, timeout=CC_CHECK_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return f"no answer in {int(CC_CHECK_TIMEOUT_S)} seconds."
    except OSError as e:
        return f"`claude` could not start ({e.strerror or type(e).__name__})."
    try:
        got = json.loads(r.stdout)
    except ValueError:
        got = None
    if isinstance(got, dict) and not got.get("is_error") and r.returncode == 0:
        return ""
    said = str(got.get("result") or "") if isinstance(got, dict) else (r.stderr or r.stdout or "")
    said = " ".join(said.split())[:200]
    return said or f"`claude -p` ended with exit code {r.returncode}."


def status() -> dict[str, Any]:
    """What GET /api/claude-access shows: the choice, its words, what is missing, whether ANTHROPIC_API_KEY is set where
    the workbench runs (env_key, never the key) and whether a key is saved, and each way's words. No secret."""
    rec = read()
    return {"how": how(), "describe": describe(), "problem": problem(), "key_saved": bool(saved_key()),
            "env_key": bool(env_key()), "wif_file": rec.get("wif_file") or "", "consent_text": CONSENT,
            "choices": list(CHOICES), "labels": LABELS, "hints": HINTS}


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


# --------------------------------------------------------------------------- thimble-browser --setup


def _ask(prompt: str) -> str:
    """One answer typed in the terminal; the question goes to stderr, so that the install shows it as it comes while
    it indents setup's lines (stdout)."""
    sys.stderr.write(prompt)
    sys.stderr.flush()
    return (sys.stdin.readline() or "").strip()


def _menu() -> str:
    """The question how the workbench reaches Claude, in a terminal: the way chosen, '' for Enter (choose later)."""
    out = sys.stderr
    out.write("How should the workbench reach Claude?\n")
    for n, h in enumerate(CHOICES, 1):
        mark = " (recommended)" if h == CLAUDE_CODE else ""
        out.write(f"  {n}  {LABELS[h]}{mark}: {HINTS[h]}\n")
    out.write("  Enter: choose later; the workbench asks when it starts.\n")
    while True:
        got = _ask("Choose 1, 2 or 3: ")
        if not got:
            return ""
        if got in ("1", "2", "3"):
            return CHOICES[int(got) - 1]
        out.write("Type 1, 2 or 3, or press Enter to choose later.\n")


def again(h: str, wif_file: str = "") -> str:
    """The command that sets the way `h` and checks it again, with ~ for the home when the path needs no quotes."""
    import re  # noqa: PLC0415
    import shlex  # noqa: PLC0415

    if h != WIF or not wif_file:
        return f"thimble-browser --setup --how {h}"
    t = _tilde(wif_file)
    shown = t if re.fullmatch(r"~/[\w./+-]*", t) else shlex.quote(wif_file)
    return f"thimble-browser --setup --how wif --wif-file {shown}"


def line(no_check: bool = False) -> tuple[int, list[str]]:
    """setup's lines for the way chosen, checked unless `no_check`: Sign-in: the way (with Claude Code sign-in, the
    login it uses), then what the check found; when it failed, the command to run after the fix. Exit 0, or 2 when the
    check failed."""
    h = how()
    if not h:
        return 0, ["Sign-in: not chosen yet. The workbench asks when it starts."]
    if h == API_KEY and not has_key():
        return 0, ["Sign-in: an API key. ANTHROPIC_API_KEY is not set here, so the workbench asks for a key in its "
                   "Settings when it starts."]
    if no_check:
        return 0, [f"Sign-in: {describe()}."]
    got = asyncio.run(check())
    way = describe() + (f" (logged in with {got['login']})" if got.get("login") else "")
    if got.get("ok"):
        return 0, [f"Sign-in: {way}. Checked: Claude answers."]
    p = got.get("problem") or {}
    why = " ".join(x for x in (str(p.get("what") or "").strip(), str(p.get("fix") or "").strip()) if x)
    return 2, [f"Sign-in: {way}. The check failed: {why.rstrip('.')}.",
               f"  After you fix that: {again(h, str(read().get('wif_file') or ''))}"]


def setup(argv: list[str] | None = None) -> int:
    """`thimble-browser --setup [--how H] [--wif-file F] [--keep] [--no-check]`: how the workbench reaches Claude.

    --how chooses the way (claude-code, api-key or wif; --wif-file alone is wif). Choosing the Claude Code sign-in is
    the consent to what it does (CONSENT). The API key needs nothing here: the workbench uses ANTHROPIC_API_KEY when it
    is set, and else asks for a key in its Settings. Without --how, a terminal gets the question (Enter chooses later),
    and with --keep a way chosen before stays (the install's run); with no terminal, the way chosen stays as it is. Then
    the line that says the way and what the check found (line). The question goes to stderr and the lines to stdout.
    Exit 0, 1 when nothing was saved, 2 when the check failed."""
    ap = argparse.ArgumentParser(prog="thimble-browser --setup")
    ap.add_argument("--how", choices=CHOICES)
    ap.add_argument("--wif-file", help="the WIF config file (implies --how wif)")
    ap.add_argument("--keep", action="store_true", help="keep a way chosen before; ask only when there is none")
    ap.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)  # an earlier release's consent: --how is it
    ap.add_argument("--no-check", action="store_true")
    args = ap.parse_args(argv)
    choice = args.how or (WIF if args.wif_file else "")
    if not choice and sys.stdin.isatty() and not (args.keep and how()):
        choice = _menu()
        if not choice:
            print("Sign-in: not chosen yet. The workbench asks when it starts.")
            return 0
    if choice:
        path = args.wif_file or ""
        if choice == WIF and not path and sys.stdin.isatty():
            path = _ask("The path of your WIF config file: ")
        try:
            save(choice, wif_file=path, consent=True)
        except AccessError as e:
            way = describe_of(choice, path)
            print(f"Sign-in: {way}. It was not saved: {str(e).rstrip('.')}.")
            print(f"  After you fix that: {again(choice, path)}")
            return 1
    rc, lines = line(args.no_check)
    for x in lines:
        print(x)
    return rc


def describe_of(choice: str, wif_file: str = "") -> str:
    """describe()'s words for a way that is not saved."""
    if choice == WIF:
        return f"Workload Identity Federation, with {_tilde(wif_file) if wif_file else '(no file)'}"
    return {API_KEY: "an API key", CLAUDE_CODE: "your Claude Code sign-in"}.get(choice, choice)


def main(argv: list[str] | None = None) -> int:
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
