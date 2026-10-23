"""thimble09.py: finds a thimble 0.9 install, for scripts/install.sh, which stops while one is here. While 0.9's plugin
is installed, Claude Code loads it and skips 0.10's (both are named thimble), with no error; and a 0.9 clone's
marketplace, named thimble like 0.10's, makes `claude plugin marketplace add` fail.

  thimble09.py report       what it found, and how to remove 0.9 (nothing when there is no 0.9)
  thimble09.py commands     the removal commands, one per line: as shown, a tab, then as run
  thimble09.py workspaces   the 0.9 release install's workspaces folder, when it has one

What 0.9 left: ~/.local/bin/thimble, a link to <tree>/plugin/bin/thimble (0.10 writes no such command); a release
install, the plugin thimble@thimble-local from the marketplace thimble-local, which is ~/.thimble/app, with its
workspaces in ~/.thimble/app/workspaces; a clone install, the plugin thimble@thimble from the marketplace thimble, which
is the clone (0.9's tree: backend/ beside plugin/, or plugin.json's version 0.9), with its workspaces in the clone; and,
for both, its state in ~/.thimble (OLD below). It reads Claude Code's files and runs nothing.
"""
import json
import os
import re
import shlex
import sys

HOME = os.path.expanduser("~")
CONFIG = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
THIMBLE = os.path.join(HOME, ".thimble")
APP = os.path.join(THIMBLE, "app")
LAUNCHER = os.path.join(HOME, ".local", "bin", "thimble")
# what 0.9 kept in ~/.thimble; 0.10 keeps other names there (conversations/, events/, srt/ ...)
OLD = ["app", "app-dir", "data", "extensions", "mirrors", "active", "up", "watch", "install.log", "terminal-tools.json"]


def load(*parts):
    try:
        with open(os.path.join(*parts)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read(200_000)
    except OSError:
        return ""


def shown(path):
    """A path as a person types it: ~/... under the home, quoted when it needs quotes."""
    if path == HOME or path.startswith(HOME + "/"):
        rest = path[len(HOME) + 1:]
        if re.fullmatch(r"[A-Za-z0-9._/-]*", rest):
            return "~/" + rest if rest else "~"
    return shlex.quote(path)


def is_09_tree(d):
    """Whether the folder d holds thimble 0.9: its backend/ beside plugin/, or plugin.json's version 0.9 or before."""
    if not d or not os.path.isdir(os.path.join(d, "plugin")):
        return False
    if os.path.isdir(os.path.join(d, "backend")):
        return True
    m = re.match(r"0\.(\d+)\b", str(load(d, "plugin", ".claude-plugin", "plugin.json").get("version") or ""))
    return bool(m) and int(m.group(1)) < 10


def find():
    settings = load(CONFIG, "settings.json")
    installed = load(CONFIG, "plugins", "installed_plugins.json").get("plugins") or {}
    plugins = set(installed) | set(settings.get("enabledPlugins") or {})
    markets = {}  # name -> the folder it comes from ("" when not a folder)
    for name, m in list((settings.get("extraKnownMarketplaces") or {}).items()) + \
            list(load(CONFIG, "plugins", "known_marketplaces.json").items()):
        src = (m or {}).get("source") or {} if isinstance(m, dict) else {}
        path = src.get("path") if isinstance(src, dict) and src.get("source") == "directory" else ""
        markets[name] = path or markets.get(name, "")

    f = {"release": [], "clone": None, "launcher": None, "runs": False}
    if "thimble@thimble-local" in plugins:
        f["release"].append("plugin")
    if "thimble-local" in markets:
        f["release"].append("market")
    if os.path.isdir(APP):
        f["release"].append("app")
    if is_09_tree(markets.get("thimble")):
        f["clone"] = os.path.normpath(markets["thimble"])
    if os.path.islink(LAUNCHER) or os.path.isfile(LAUNCHER):
        target = os.readlink(LAUNCHER) if os.path.islink(LAUNCHER) else ""
        target = os.path.normpath(os.path.join(os.path.dirname(LAUNCHER), target)) if target else ""
        text = read(target or LAUNCHER)
        if target.endswith("/plugin/bin/thimble") or "thimble uninstall" in text:
            f["launcher"] = target or LAUNCHER
            # 0.9's own command; a 0.9 clone pulled to 0.10 leaves the link on 0.10's plugin/bin/thimble, which fails
            f["runs"] = bool(text) and "engine/thimble.py" not in text
            tree = target[: -len("/plugin/bin/thimble")] if target.endswith("/plugin/bin/thimble") else ""
            if tree and os.path.normpath(tree) != APP and os.path.isdir(tree) and not f["clone"]:
                f["clone"] = os.path.normpath(tree)
    f["plugins"], f["markets"] = plugins, markets
    f["new_state"] = os.path.isdir(THIMBLE) and any(n not in OLD for n in os.listdir(THIMBLE))
    return f if (f["release"] or f["clone"] or f["launcher"]) else None


def commands(f):
    """The removal commands, as [(shown, run)]."""
    out = []
    if "thimble@thimble-local" in f["plugins"]:
        out.append("claude plugin uninstall thimble@thimble-local")
    if "thimble-local" in f["markets"]:
        out.append("claude plugin marketplace remove thimble-local")
    if f["clone"] and f["markets"].get("thimble") and os.path.normpath(f["markets"]["thimble"]) == f["clone"]:
        if "thimble@thimble" in f["plugins"]:
            out.append("claude plugin uninstall thimble@thimble")
        out.append("claude plugin marketplace remove thimble")
    out = [(c, c) for c in out]
    if f["launcher"]:
        out.append(("rm -f " + shown(LAUNCHER), "rm -f " + shlex.quote(LAUNCHER)))
    if os.path.isdir(THIMBLE):
        if f["new_state"]:  # keep what 0.10 already keeps there
            old = [os.path.join(THIMBLE, n) for n in OLD if os.path.lexists(os.path.join(THIMBLE, n))]
            if old:
                out.append(("rm -rf " + " ".join(shown(p) for p in old), "rm -rf " + " ".join(shlex.quote(p) for p in old)))
        else:
            out.append(("rm -rf " + shown(THIMBLE), "rm -rf " + shlex.quote(THIMBLE)))
    return out


def report(f):
    plugin = "thimble@thimble-local" in f["plugins"] or (f["clone"] and "thimble@thimble" in f["plugins"] and
                                                         f["markets"].get("thimble"))
    if plugin:
        lines = ["thimble 0.9 is installed here. Remove it before you install 0.10: while 0.9's plugin is installed,",
                 "Claude Code loads it and skips 0.10's, with no error. Nothing was installed."]
    elif f["clone"] and f["markets"].get("thimble"):
        lines = ["thimble 0.9's marketplace is still here. Remove it before you install 0.10: it has the name of",
                 "0.10's marketplace, thimble, so adding 0.10's fails. Nothing was installed."]
    else:
        lines = ["thimble 0.9 left files here, which 0.10 does not use. Remove them before you install 0.10.",
                 "Nothing was installed."]
    lines += ["", "Found:"]
    if "plugin" in f["release"]:
        lines.append("  - the plugin thimble@thimble-local (thimble 0.9 from a release)")
    if "market" in f["release"]:
        where = f["markets"].get("thimble-local")
        lines.append("  - the marketplace thimble-local" + (f" ({shown(where)})" if where else ""))
    if f["clone"]:
        has = "thimble@thimble" in f["plugins"] and f["markets"].get("thimble")
        lines.append(f"  - a thimble 0.9 clone, {shown(f['clone'])}" +
                     (", which the marketplace thimble and the plugin thimble@thimble come from" if has else
                      ", which the marketplace thimble comes from" if f["markets"].get("thimble") else ""))
    if f["launcher"]:
        how = "" if f["launcher"] == LAUNCHER else f", a link to {shown(f['launcher'])}"
        lines.append(f"  - {shown(LAUNCHER)}, 0.9's thimble command{how}")
    if "app" in f["release"]:
        lines.append(f"  - {shown(APP)}, thimble 0.9 itself")

    keep = os.path.join(APP, "workspaces")
    clone_ws = os.path.join(f["clone"], "workspaces") if f["clone"] else ""
    if os.path.isdir(keep) or (clone_ws and os.path.isdir(clone_ws)):
        lines += ["", "0.10 cannot open 0.9's workspaces (its cards, notebooks, labels and reports)."]
        if os.path.isdir(keep):
            lines += ["Removing 0.9 deletes them. To keep them as an archive, move them first:",
                      f"  mv {shown(keep)} ~/thimble-0.9-workspaces"]
        if clone_ws and os.path.isdir(clone_ws):
            lines.append(f"The clone's workspaces, in {shown(clone_ws)}, stay: removing 0.9 leaves the clone alone.")

    cmds = [c for c, _ in commands(f)]
    lines.append("")
    if f["launcher"] and f["runs"] and not f["new_state"]:
        lines += ["To remove 0.9, run this, and answer y:", "  thimble uninstall",
                  "It removes 0.9's plugin, its marketplace, ~/.local/bin/thimble and all of ~/.thimble, workspaces",
                  "included. If it fails, run these instead:"]
    elif f["launcher"] and f["runs"]:
        lines.append("To remove 0.9, run these (thimble uninstall would also delete what 0.10 keeps in ~/.thimble):")
    else:
        lines.append("To remove 0.9, run these:")
    lines += ["  " + c for c in cmds]
    lines += ["Then run scripts/install.sh again, and restart the claude sessions that are open (or run /reload-plugins",
              "in them)."]
    return "\n".join(lines)


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "report"
    f = find()
    if not f:
        return 0
    if what == "report":
        print(report(f))
    elif what == "commands":
        for c, run in commands(f):
            print(c + "\t" + run)
    elif what == "workspaces":
        if os.path.isdir(os.path.join(APP, "workspaces")):
            print(os.path.join(APP, "workspaces"))
    else:
        print(f"thimble09.py: no {what} (report, commands or workspaces)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
