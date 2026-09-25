"""The sandbox hook of a check's run: a Bash call that runs inside Claude Code's Bash sandbox, which already keeps it
from writing the corpus and reaching the network, is allowed without a prompt. One rule, `allows`, answers the
PreToolUse and PermissionRequest hook events and the session's permission requests (agent_session.ask).

PreToolUse is needed because `sandbox.autoAllowBashIfSandboxed` only allows commands Claude Code's parser can vet and
does not decide in auto mode, whose classifier drops a blanket `Bash` allow rule. PermissionRequest is needed because
a PreToolUse `allow` does not settle calls sent to the full permission pipeline, and a subagent has no prompt.

A command naming one of `sandbox.excludedCommands` (`--exclude <name>`) or matching one of the analyst's Bash ask
rules (`--ask <content>`, `*` for a bare `Bash`) gets no answer, so the permission mode decides. Standard library
only, run with `python -S`; anything unexpected prints nothing."""
from __future__ import annotations

import json
import re
import sys

PRE, REQUEST = "PreToolUse", "PermissionRequest"
EVENTS = (PRE, REQUEST)
TOOL = "Bash"
REASON = "Runs in thimble's Bash sandbox."
WORD_RE = re.compile(r"[^\s;&|()<>`'\"$=]+")  # the words of a command line, split at shell operators and quotes


def _values(argv: list[str], flag: str) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == flag and argv[i + 1].strip()]


def excluded(argv: list[str]) -> set[str]:
    """The command names passed as `--exclude <name>`."""
    return set(_values(argv, "--exclude"))


def asked(argv: list[str]) -> list[str]:
    """The contents of the analyst's Bash ask rules, passed as `--ask <content>`."""
    return _values(argv, "--ask")


def names_excluded(command: str, names: "set[str] | list[str]") -> bool:
    """Whether the command line holds a word that is one of `names`, or a path ending in one (`/usr/bin/docker`)."""
    names = set(names)
    return any(w in names or w.rsplit("/", 1)[-1] in names for w in WORD_RE.findall(command))


def matches_ask(command: str, rules: "list[str]") -> bool:
    """Whether the command line matches one of the ask rules' contents (the module note): `git push:*` and `git push *`
    match a command that holds `git push`, `*` any command."""
    for rule in rules:
        body = rule.strip()
        body = body[:-2] if body.endswith(":*") else body
        body = body.rstrip("* ").strip()
        if not body:
            return True
        pattern = ".*".join(re.escape(part.strip()) for part in body.split("*"))
        if re.search(pattern, command):
            return True
    return False


def allows(tool_name: str, tool_input: object, names: "set[str] | list[str]" = (), rules: "list[str]" = ()) -> bool:
    """The one rule (module note): a Bash call with a command that names no excluded command and matches no ask rule."""
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    return (tool_name == TOOL and isinstance(command, str) and bool(command.strip())
            and not names_excluded(command, names) and not matches_ask(command, list(rules)))


def main(argv: list[str]) -> int:
    try:
        hook = json.load(sys.stdin)
    except (OSError, ValueError):
        return 0
    if not isinstance(hook, dict) or hook.get("hook_event_name") not in EVENTS:
        return 0
    if not allows(str(hook.get("tool_name") or ""), hook.get("tool_input"), excluded(argv), asked(argv)):
        return 0
    if hook["hook_event_name"] == PRE:
        out = {"hookEventName": PRE, "permissionDecision": "allow", "permissionDecisionReason": REASON}
    else:
        out = {"hookEventName": REQUEST, "decision": {"behavior": "allow"}}
    print(json.dumps({"hookSpecificOutput": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
