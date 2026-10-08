"""The permission hook of the `claude -p` sessions of an extension's program that thimble starts itself
(agent_session.py). Claude Code runs it on three events of the session, its subagents and its workflow agents, and it
hands each to the server:

- PermissionRequest: answered by the session's mode (agent_session.ask), at once in Bypass, else when the analyst
  answers on the session's card, with Claude Code's "don't ask again" suggestions offered beside Allow.
- PermissionDenied: auto mode refused a call. The server shows it like a request; if the analyst allows it the hook
  answers `retry`, so the model may make the call again.
- PreToolUse, in auto mode: the hook answers `allow` for a call the analyst allowed after auto mode refused it, so the
  retry skips the classifier, or `deny` for one the analyst denied. With `--wait`, a call thimble's config sends to the
  analyst waits here for their answer (agent_session, the config).

A hook is used rather than --permission-prompt-tool because requests from background subagents and workflow agents reach
only the hook; using both would ask twice for foreground requests. Claude Code waits for the hook's decision (its
timeout in the session's settings is a day). In auto mode a refused call never reaches PermissionRequest, hence
PermissionDenied with `retry` plus a PreToolUse `allow`.

It posts the event to POST {server}/api/ws/{ws}/sessions/permission with post, which signs it with the token in
server.json and believes only an answer that carries the server's proof (app/hook_auth.py), waits for the answer and
prints Claude Code's hook output. The session is `--session` when given, else THIMBLE_SESSION, and thimble's home
`--home` when given, else THIMBLE_HOME, else ~/.thimble. Standard library only, run with `python -S`. Anything
unexpected prints nothing: a request is then denied, a refusal stays refused, and before a call auto mode decides.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REQUEST, DENIED, PRE = "PermissionRequest", "PermissionDenied", "PreToolUse"
EVENTS = (REQUEST, DENIED, PRE)
TIMEOUT = 86_400  # the hook's own timeout in the session's settings for a request or a refusal, in seconds
PRE_TIMEOUT = 10  # its timeout before each call, which the server answers at once (agent_session.permission_hooks)


def sign(token: str, role: str, nonce: str) -> str:
    """app/hook_auth.py's sign: the proof `role` gives for `nonce`."""
    return hmac.new(token.encode("utf-8"), f"{role}:{nonce}".encode("utf-8"), hashlib.sha256).hexdigest()


def server(home: str = "") -> tuple[str, str] | None:
    """(the server's address, its token) from server.json in `home`, else THIMBLE_HOME, else ~/.thimble; None without
    the file, an address or a token."""
    folder = Path(home or os.environ.get("THIMBLE_HOME") or Path.home() / ".thimble").expanduser()
    try:
        data = json.loads((folder / "server.json").read_text("utf-8"))
        url = str(data["api"]).rstrip("/") if data.get("api") else f"http://127.0.0.1:{int(data['port'])}"
        token = data.get("token")
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None
    return (url, token) if isinstance(token, str) and token else None


def post(path: str, body: dict, timeout: float, home: str = "") -> object:
    """The server's JSON answer to `body` posted to `path`; OSError when there is no server to ask or the answer does not
    carry the server's proof."""
    found = server(home)
    if found is None:
        raise OSError("no server.json with an address and a token")
    url, token = found
    nonce = secrets.token_hex(16)
    headers = {"Content-Type": "application/json", "X-Thimble-Nonce": nonce, "X-Thimble-Auth": sign(token, "hook", nonce)}
    req = urllib.request.Request(url + path, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — loopback, thimble's own server
        raw, proof = resp.read(), resp.headers.get("X-Thimble-Proof") or ""
    if not hmac.compare_digest(proof, sign(token, "server", nonce)):
        raise OSError("the answer does not carry thimble's proof")
    return json.loads(raw.decode("utf-8") or "{}")


def decision(answer: object, event: str = REQUEST) -> dict | None:
    """Claude Code's hook output for the server's answer ({behavior, message?}) to `event`, or None for no decision."""
    if not isinstance(answer, dict) or answer.get("behavior") not in ("allow", "deny"):
        return None
    allow = answer["behavior"] == "allow"
    message = answer.get("message") if isinstance(answer.get("message"), str) else None
    updates = answer.get("updatedPermissions") if allow and isinstance(answer.get("updatedPermissions"), list) else None
    if event == DENIED:
        return {"hookSpecificOutput": {"hookEventName": DENIED, "retry": True}} if allow else None
    if event == PRE:
        out = {"hookEventName": PRE, "permissionDecision": answer["behavior"]}
        return {"hookSpecificOutput": {**out, **({"permissionDecisionReason": message} if message else {})}}
    out: dict = {"behavior": answer["behavior"]}
    if not allow and message:
        out["message"] = message
    if updates:
        out["updatedPermissions"] = updates
    return {"hookSpecificOutput": {"hookEventName": REQUEST, "decision": out}}


def arg(argv: list[str], flag: str) -> str:
    """The value after `flag` in `argv`, '' when it is missing."""
    return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else ""


def main(argv: list[str]) -> int:
    ws = arg(argv, "--ws")
    session = (arg(argv, "--session") or os.environ.get("THIMBLE_SESSION", "")).strip()
    try:
        hook = json.load(sys.stdin)
    except (OSError, ValueError):
        return 0
    event = hook.get("hook_event_name") if isinstance(hook, dict) else None
    if not ws or not session or event not in EVENTS:
        return 0
    fields = {"session": session, "event": event, "tool_name": str(hook.get("tool_name") or ""),
              "tool_input": hook.get("tool_input"), "agent_id": hook.get("agent_id") or None,
              "agent_type": hook.get("agent_type") or None}
    if event != REQUEST:
        fields["tool_use_id"] = hook.get("tool_use_id") or None
    if event == DENIED:
        fields["reason"] = str(hook.get("reason") or "")
    if event == REQUEST and isinstance(hook.get("permission_suggestions"), list):
        fields["suggestions"] = hook["permission_suggestions"]
    try:
        out = decision(post(f"/api/ws/{urllib.parse.quote(ws, safe='')}/sessions/permission", fields,
                            PRE_TIMEOUT - 2 if event == PRE and "--wait" not in argv else TIMEOUT, arg(argv, "--home")),
                       event)
    except (OSError, ValueError):
        return 0
    if out is not None:
        print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
