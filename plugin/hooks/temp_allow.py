"""temp_allow.py: Read, Grep, Glob and a fork's Write in thimble's temp folder need no dialog.

thimble asks Claude to write a card's rows in the session's temp folder (core/home.ts tempDir: `thimble/` in the
person's TMPDIR, else $THIMBLE_HOME/tmp; a folder only this user can open), which is outside the working folder, so
Claude Code would ask the person before Claude reads them back. v's fork works in the background, where a dialog would
stop it until the person answers, and it writes its rows with the Write tool. This is a standard PreToolUse command hook
(hooks.json), not a hook of the plugin's module: where an organization manages Claude Code, its security default asks
each tool check again without the plugins a person installs, and a module's allow there would be skipped with a notice.

The hook only says "allow"; a deny or ask rule of the person's still decides. A Glob's absolute pattern names its own
folder, so only a relative one is let through. With the Cards switch off (the plugin option `cards`), it says nothing.
Any failure: it says nothing, and Claude Code decides as it would.
"""
import json
import os
import stat
import sys

TOOLS = {"Read", "Grep", "Glob", "Write"}


def own_folder(path):
    """The real path of `path` when it is a folder this user owns, mode 700 and no link, else None."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        return None
    return os.path.realpath(path)


def temp_folders(env):
    """The folders core/home.ts tempDir may have picked. The session's commands get thimble's folder as their TMPDIR
    (hooks/path.ts), and a hook may get it too, so TMPDIR itself counts when it is a folder named thimble."""
    out = []
    tmp = (env.get("TMPDIR") or "").rstrip("/")
    home = (env.get("THIMBLE_HOME") or os.path.join(env.get("HOME") or ".", ".thimble")).rstrip("/")
    cands = [os.path.join(tmp, "thimble")] if tmp else []
    if tmp and os.path.basename(os.path.realpath(tmp)) == "thimble":
        cands.append(tmp)
    cands.append(os.path.join(home, "tmp"))
    for c in cands:
        real = own_folder(c)
        if real and real not in out:
            out.append(real)
    return out


def real_of(path):
    """The real path of a file, or of a file to be made in a folder that exists."""
    if os.path.lexists(path):
        return os.path.realpath(path)
    folder, name = os.path.split(path)
    if not name or name in (".", "..") or not os.path.isdir(folder or "/"):
        return None
    return os.path.join(os.path.realpath(folder or "/"), name)


def verdict(e, env):
    """'allow', or None for no answer."""
    tool = e.get("tool_name")
    if tool not in TOOLS:
        return None
    opt = env.get("CLAUDE_PLUGIN_OPTION_CARDS", env.get("CLAUDE_PLUGIN_OPTION_cards", "true"))
    if str(opt).strip().lower() == "false":
        return None
    # main writes its rows with its own code; only an agent's Write (v's fork) is let through
    if tool == "Write" and not e.get("agent_id"):
        return None
    inp = e.get("tool_input") or {}
    if tool == "Glob":
        pat = inp.get("pattern")
        if not isinstance(pat, str) or pat.startswith("/") or ".." in pat.split("/"):
            return None
    p = inp.get("file_path") if tool in ("Read", "Write") else inp.get("path")
    if not isinstance(p, str) or not p.startswith("/"):
        return None
    real = real_of(p)
    if real is None:
        return None
    for t in temp_folders(env):
        if real == t or real.startswith(t + "/"):
            return "allow"
    return None


def main():
    try:
        e = json.load(sys.stdin)
        v = verdict(e, os.environ) if isinstance(e, dict) else None
    except Exception:
        return 0
    if v:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": v,
                                                 "permissionDecisionReason": "a file in thimble's temp folder"}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
