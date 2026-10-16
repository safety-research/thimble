"""`thimble open [--session SID] [--cwd DIR] [--ref REF] [--hook] [--link] [--json]`: the press. It opens thimble's page
in the browser on one object (REF, as the page's `?ref=` takes it), signed in, on one Claude Code session, and starts
the server first when none runs.

Callers: the terminal panel's `o` and `↗` (plugin/hooks/term offramp.ts, through `$.process.run` with --json), `/thimble
open` (the mod, or the UserPromptExpansion hook with --hook where there is no mod), the `thimble` command, and a shell.

Which session. When CLAUDE_CODE_SESSION_ID is set (a hook's or a Bash command's environment), --session must equal it
(REFUSED_SESSION): a model's `thimble open --session <other>` takes over nothing. Without either, the target is the
folder's live main (launch.json and its `claude` process); with none, nothing starts (NO_SESSION). The folder is refused
as activation refuses it (REFUSED_HOME). The press activates the folder when it is not on (core's app.activate, when it
is there), starts the server (cli.ensure_running, under its lock), registers the folder (cli.open_workspace), makes this
session main (cli.name_session, cli.made_main: the press takes main explicitly, and the transport moves to the server).

The code. A one-time code (60 s; 300 s for a link a person copies) goes only into the redirect file the opener gets, or
into a remote terminal's link file (app/opener.py), each readable by the analyst's account alone. stdout and stderr
hold status only, never a code, TTY or not: one line on a TTY, else the C12 JSON {ok, port, url, opened, remote,
tunnel, et, link_file, claim_file, proxy}, or {ok: false, error: {code, message, fix}}. Exit 0 always. --link makes a
300 s link (no opener runs), as the panel's `copy link` asks; --hook reads the session and the folder from the hook's
input on stdin and prints nothing.

One tab per press. The mod's press and the UserPromptExpansion hook can both run for one `/thimble browser`: a press of the
same session at the same ref within DEBOUNCE_S answers the first press's status and runs no second opener (a lock
serializes presses; the record is <home>/open/<hash>.last, opener.press_record).
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import io
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from . import opener

DEBOUNCE_S = 5.0  # a second press of one session at one ref within this long answers the first's status
LOCK_NAME = "press.lock"  # under <home>/open: one press at a time
PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
NO_PROXY_VARS = ("NO_PROXY", "no_proxy")
LOOPBACK_NAMES = ("127.0.0.1", "localhost", "*")
CODE_TEXT = re.compile(r"#p=[A-Za-z0-9_%-]+")  # a code in a URL, as an error's text could show one

NO_SESSION_LINE = "No Claude Code session is active in this folder. Start claude (or thimble) here."
ERRORS: dict[str, tuple[str, str]] = {  # code -> (message, fix)
    "REFUSED_HOME": ("thimble does not open this folder (your home folder, /, a folder above them or a mount root).",
                     "cd into the data folder and start claude there."),
    "REFUSED_SESSION": ("This command may open thimble's page only for its own Claude Code session.",
                        "Type /thimble browser in that session's terminal."),
    "REFUSED_REF": ("thimble's page cannot open this ref.", "Open the page with /thimble browser and find it there."),
    "NO_SESSION": (NO_SESSION_LINE, "Start claude (or thimble) in this folder, then type /thimble browser."),
    "PORT": ("Another program uses thimble's port.", "Set THIMBLE_PORT to a free port, or stop that program."),
    "START": ("thimble's page did not start.", "Run `thimble doctor` in a shell."),
    "NO_OPENER": ("No browser opener found.", "Copy the one-time link from thimble's panel."),
    "NOT_BUILT": ("thimble's browser UI is not built.", "Run `thimble doctor --verbose` in a shell for how to build it."),
}

log = logging.getLogger("thimble.open")


def _error(code: str, message: str = "", fix: str = "", **extra: Any) -> dict[str, Any]:
    msg, fx = ERRORS.get(code, ("", ""))
    return {"ok": False, "error": {"code": code, "message": scrub(message or msg), "fix": scrub(fix or fx)}, **extra}


def scrub(text: str) -> str:
    """`text` with any sign-in code in a URL shown as `<code>`."""
    return CODE_TEXT.sub("#p=<code>", str(text))


def proxy_set(env: Mapping[str, str]) -> bool:
    """Whether the caller's environment sets a proxy that a request to 127.0.0.1 could go through: one of PROXY_VARS
    set, and no NO_PROXY naming 127.0.0.1, localhost or *. NO_PROXY as the caller gave it (config adds 127.0.0.1 to
    this process's own as it loads)."""
    if not any(env.get(v, "").strip() for v in PROXY_VARS):
        return False
    try:
        from . import config  # noqa: PLC0415

        given = dict(config.GIVEN_NO_PROXY) if env is os.environ else {v: env.get(v, "") for v in NO_PROXY_VARS}
    except Exception:  # noqa: BLE001
        given = {v: env.get(v, "") for v in NO_PROXY_VARS}
    named = {part.strip().lower() for v in NO_PROXY_VARS for part in str(given.get(v) or "").split(",")}
    return not named & set(LOOPBACK_NAMES)


def hook_input(raw: str) -> dict[str, Any]:
    """The UserPromptExpansion hook's input: {} when it is not a JSON object."""
    try:
        got = json.loads(raw)
    except ValueError:
        return {}
    return got if isinstance(got, dict) else {}


def live_main(cwd: Path) -> str | None:
    """The session of the folder's live main (launch.json names it and its `claude` runs), None when there is none."""
    from . import cli, config  # noqa: PLC0415

    try:
        with cli.server_dirs():
            c = config.workspace_for_cwd(str(cwd))
            rec = cli.read_launch(c) if c else {}
            alive = bool(rec) and cli.live_launch(rec, c)
    except Exception:  # noqa: BLE001 — no main found
        return None
    sid = str(rec.get("session") or "")
    return sid if alive and sid else None


def refused(cwd: Path) -> bool:
    """Whether the press refuses the folder, as activation does (core's activate._refused, else cli.refused: $HOME or
    /)."""
    try:
        from . import activate  # noqa: PLC0415 — core's module, when it is there

        rule = getattr(activate, "_refused", None)
        if rule is not None:
            return bool(rule(cwd))
    except ImportError:
        pass
    from . import cli  # noqa: PLC0415

    return cli.refused(cwd)


def activate_here(cwd: Path, sid: str) -> dict[str, Any] | None:
    """Turn thimble on in the folder for session `sid` with `via: press` (core's activate.activate, contract C2), when
    that module is there; None without it (the server's registration below stands in)."""
    try:
        from . import activate  # noqa: PLC0415
    except ImportError:
        return None
    fn = getattr(activate, "activate", None)
    if fn is None:
        return None
    try:
        got = fn(str(cwd), sid, "press")
    except Exception as e:  # noqa: BLE001 — the registration below still runs
        log.warning("activation for the press failed: %s", type(e).__name__)
        return None
    return got if isinstance(got, dict) else None


def mint(api: str, ws: str, ttl: int, open_id: str) -> str:
    """A one-time code from the server at `api` (POST /api/ui/pair, which needs the token: hook_auth.mint) for
    workspace `ws`, good for `ttl` seconds, made with the open id; '' when the server gives none (logged, without a
    code)."""
    from . import cli  # noqa: PLC0415

    status, body = cli._request("POST", f"{api}/api/ui/pair", {"ws": ws, "ttl": ttl, "open": open_id},
                                timeout=cli.PAIR_TIMEOUT_S)
    code = body.get("code") if status == 200 and isinstance(body, dict) else None
    if isinstance(code, str) and code:
        return code
    cli._log(f"thimble open: no sign-in code from {api}: {status}")
    return ""


def _port(url: str) -> int:
    u = urlsplit(url)
    return int(u.port or (443 if u.scheme == "https" else 80))


def _recent(sid: str, ref: str) -> dict[str, Any] | None:
    """The status of a press of `sid` at `ref` made within DEBOUNCE_S, None when there is none."""
    path = opener.press_record(sid, ref)
    try:
        got = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(got, dict) or not 0 <= time.time() - float(got.get("at") or 0) <= DEBOUNCE_S:
        return None
    status = got.get("status")
    return status if isinstance(status, dict) else None


def _remember(sid: str, ref: str, status: dict[str, Any]) -> None:
    with contextlib.suppress(OSError):
        opener.write_private(opener.press_record(sid, ref), json.dumps({"at": time.time(), "status": status}))


@contextlib.contextmanager
def _press_lock():
    d = opener.private_dir(opener.open_dir())
    fd = os.open(d / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def press(*, session: str | None, cwd: Path, ref: str, link: bool, env: Mapping[str, str]) -> dict[str, Any]:
    """The press (module note): the C12 status."""
    why = opener.check_ref(ref)
    if why:
        return _error("REFUSED_REF", f"thimble's page cannot open this ref: {why}.")
    caller = env.get("CLAUDE_CODE_SESSION_ID", "").strip()
    if session and caller and session != caller:
        return _error("REFUSED_SESSION")
    if refused(cwd):
        return _error("REFUSED_HOME")
    sid = session or caller or live_main(cwd)
    if not sid:
        return _error("NO_SESSION")
    with _press_lock():
        if not link:
            got = _recent(sid, ref)
            if got is not None:
                return got
        status = _press(sid, cwd, ref, link, env)
        if status.get("ok") or status.get("link_file"):
            _remember(sid, ref, status)
        return status


def _press(sid: str, cwd: Path, ref: str, link: bool, env: Mapping[str, str]) -> dict[str, Any]:
    from . import cli, hook_auth  # noqa: PLC0415

    if cli.in_sandbox():
        return _error("START", "thimble's page cannot start inside Claude Code's Bash sandbox.",
                      "Type /thimble browser in the terminal (the press runs outside the sandbox).")
    act = activate_here(cwd, sid)
    if act is not None and not act.get("ok"):
        err = act.get("error") if isinstance(act.get("error"), dict) else {}
        code = str(err.get("code") or "")
        return _error("REFUSED_HOME" if code.startswith("REFUSED") else "START", str(err.get("message") or ""),
                      str(err.get("fix") or ""))
    cli.ensure_home()
    renv = cli.resolve_env()
    data_dir = Path(renv["data_dir"])
    url = cli.api_url()
    if cli.refuse_foreign(url):
        return _error("PORT")
    try:
        up = cli.ensure_running(cli.WAIT_S)
    except TimeoutError as e:
        cli._log(f"thimble open: {e}")
        up = False
    url = cli.api_url()  # the server may have passed over a taken port
    if not up and not cli.serves(url):
        return _error("START", f"thimble's page did not start: {cli.start_failure(url) or 'no answer'}.")
    name, _ = cli.open_workspace(cwd, data_dir, url, here=True)
    if not name:
        return _error("START", f"thimble could not open {cwd} as a workspace.")
    cli.name_session(url, name, sid, cwd, sandbox=cli.own_sandbox_here(cwd), warnings=cli.setup_warnings(cwd))
    cli.made_main(name, sid, cwd)
    if not renv.get("dev") and not cli.has_ui_build():
        return _error("NOT_BUILT")
    st = cli.read_state()
    base = str(st.get("url") or url)
    api = str(st.get("api") or url)
    port = _port(base)
    page = opener.page_url(base, name, ref)
    where = opener.remote(env)
    oid = opener.new_id()
    status: dict[str, Any] = {"ok": True, "port": port, "url": page, "opened": False, "remote": where.remote,
                              "tunnel": None, "et": None, "link_file": None,
                              "claim_file": str(opener.claim_path(oid)), "proxy": proxy_set(env)}
    no_opener = not (link or where.remote) and opener.choose(env) is None
    if link or where.remote or no_opener:
        code = mint(api, name, hook_auth.LINK_TTL_S, oid)
        if not code:
            return _error("START", "thimble's page gave no sign-in code.")
        tunnel, et = opener.tunnels(port, where, env)
        path = opener.write_link(sid, opener.with_code(page, code), tunnel=tunnel, et=et, ttl=hook_auth.LINK_TTL_S,
                                 port=port)
        status.update({"tunnel": tunnel, "et": et, "link_file": str(path) if path else None})
        if no_opener:
            cli._log(f"thimble open: {name}: no browser opener; a one-time link instead")
            return _error("NO_OPENER", **{k: v for k, v in status.items() if k != "ok"})
        cli._log(f"thimble open: {name} at {ref} for session {sid[:8]}: a one-time link ({where.why})")
        return status
    code = mint(api, name, hook_auth.PRESS_TTL_S, oid)
    if not code:
        return _error("START", "thimble's page gave no sign-in code.")
    got = opener.open_url(opener.with_code(page, code), open_id=oid, env=env)
    if not got.opened:
        return _error("NO_OPENER", "The browser opener did not start.", **{k: v for k, v in status.items() if k != "ok"})
    status["opened"] = True
    cli._log(f"thimble open: {name} at {ref} for session {sid[:8]}: opened with {got.how}"
             + (" (its URL in the opener's argv)" if got.direct else ""))
    return status


def status_line(status: dict[str, Any]) -> str:
    """The one line a terminal shows (no code)."""
    if not status.get("ok"):
        err = status.get("error") or {}
        tail = f" The one-time link (5 minutes) is in {status['link_file']}." if status.get("link_file") else ""
        return f"thimble: {err.get('message', '')} {err.get('fix', '')}".rstrip() + tail
    if status.get("remote"):
        parts = [f"thimble's page runs on 127.0.0.1:{status['port']}."]
        if status.get("tunnel"):
            parts.append(f"From your computer: {status['et'] or status['tunnel']}")
        if status.get("link_file"):
            parts.append(f"The one-time link (5 minutes) is in {status['link_file']}.")
        return " ".join(parts)
    if status.get("link_file") and not status.get("opened"):
        return f"thimble: the one-time link (5 minutes) is in {status['link_file']}."
    return f"opened in the browser · 127.0.0.1:{status['port']}"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="thimble open", description="Open thimble's page in the browser, signed in.")
    p.add_argument("--session", help="the Claude Code session to open the page for (default: CLAUDE_CODE_SESSION_ID, "
                                     "else the folder's live main)")
    p.add_argument("--cwd", help="the session's folder (default: the current folder)")
    p.add_argument("--ref", default="home", help="what to open: card:<id>, view:<slug>, files:<folder>, checks, … "
                                                 "(default: home)")
    p.add_argument("--hook", action="store_true", help="read the session and folder from a hook's input; print nothing")
    p.add_argument("--link", action="store_true", help="make a one-time link (5 minutes) instead of opening a browser")
    p.add_argument("--json", action="store_true", help="print JSON (the default when stdout is not a terminal)")
    return p


class ScrubbedFormatter(logging.Formatter):
    """A log line, its traceback included, with any sign-in code in a URL shown as `<code>` (scrub)."""

    def format(self, record: logging.LogRecord) -> str:
        return scrub(super().format(record))


def _log_to_file() -> None:
    """The open's and the opener's log lines go to thimble's server log, scrubbed, never to stdout or stderr."""
    try:
        from . import cli  # noqa: PLC0415

        handler: logging.Handler = logging.FileHandler(cli.ensure_home() / "server.log", encoding="utf-8")
    except Exception:  # noqa: BLE001
        handler = logging.NullHandler()
    handler.setFormatter(ScrubbedFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    for name in ("thimble.open", "thimble.opener"):
        lg = logging.getLogger(name)
        lg.addHandler(handler)
        lg.setLevel(logging.INFO)
        lg.propagate = False


def main(argv: list[str] | None = None, *, stdin: io.TextIOBase | None = None) -> int:
    args = build_parser().parse_args(argv)
    env = os.environ
    session, cwd_text = args.session, args.cwd
    if args.hook:
        hook = hook_input((stdin or sys.stdin).read())
        words = str(hook.get("command_args") or "").split()
        if "command_args" in hook and (not words or words[0] != "open"):
            return 0  # /thimble with another argument: not a press
        session = session or str(hook.get("session_id") or "") or None
        cwd_text = cwd_text or env.get("CLAUDE_PROJECT_DIR") or str(hook.get("cwd") or "") or None
    cwd = Path(cwd_text or env.get("THIMBLE_CALLER_CWD") or os.getcwd())
    _log_to_file()
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = press(session=session, cwd=cwd, ref=(args.ref or "home").strip() or "home", link=args.link, env=env)
    except Exception as e:  # noqa: BLE001 — status only, never a traceback (which could hold a URL)
        log.exception("thimble open failed")
        status = _error("START", f"thimble open failed: {type(e).__name__}.")
    for text in (out.getvalue(), err.getvalue()):
        if text.strip():
            log.info("what the press printed: %s", scrub(text.strip())[:2000])
    if args.hook:
        return 0
    if args.json or not sys.stdout.isatty():
        print(json.dumps(status))
    else:
        print(status_line(status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
