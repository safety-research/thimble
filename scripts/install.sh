#!/usr/bin/env bash
# install.sh: installs thimble's terminal plugin into Claude Code and its browser workbench from this checkout. Run
# `scripts/install.sh --help` for what it does. It can run again at any time: it installs again what it installed,
# and updates what changed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--no-browser] [--no-plugin] [--local] [--bin-dir DIR] [--no-setup] [--remove-0.9]

Installs thimble's two products. It checks Node, Python and uv first, and says what is missing, one line each. Before
it installs the plugin, it looks for thimble 0.9, and stops while 0.9 is here: it says what it found, how to keep 0.9's
workspaces (0.10 cannot open them), and the commands that remove 0.9.
  The terminal plugin: adds the marketplace safety-research/thimble to Claude Code and installs thimble@thimble, then
    the sandbox its cards run in (Anthropic's sandbox runtime, pinned by the plugin, in ~/.thimble/srt), and draws a
    test card in it on the node a new terminal finds; a sandbox that does not load or start it installs again. On Linux
    it says which system packages the sandbox lacks, with the one command that installs them (it never runs sudo).
    Without the claude command, it prints the two commands to run.
    It also links the thimble command into ~/.local/bin, for a shell: thimble update moves both products to the
    newest release, thimble fixes lists your changes to thimble, and thimble --help lists the rest.
  The browser workbench (thimble 0.8's browser mode), from this checkout: the server (uv sync in browser/backend,
    with its test extras), the page and the sandbox runtime (npm ci in browser/frontend, then a build), and a
    thimble-browser launcher in ~/.local/bin. It says how much disk space this takes, about 1 GB. Then it asks how
    the workbench reaches Claude: 1 an Anthropic API key (the default), 2 your Claude Code sign-in (it launches
    headless Claude Code sessions, so it asks you to confirm), 3 Workload Identity Federation (a config file), checks
    the choice and saves it in ~/.thimble-browser. The page asks the same when this step was skipped.
Running it again is safe, and updates both.

  --no-browser   install the terminal plugin only
  --no-plugin    install the browser workbench only
  --local        use this checkout as the plugin's marketplace, in place of GitHub (to try a branch)
  --bin-dir DIR  put the thimble command and the thimble-browser launcher in DIR
  --no-setup     do not ask how the browser workbench reaches Claude (the page asks at its first start)
  --remove-0.9   when thimble 0.9 is here, remove it, then install: it shows the steps and runs them only after you
                 answer y, in a terminal (without one, it removes nothing)
EOF
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
browser="$root/browser"
plugin=1 web=1 local=0 setup=1 remove09=0
bin_dir="$HOME/.local/bin"
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --no-browser) web=0 ;;
    --no-plugin) plugin=0 ;;
    --local) local=1 ;;
    --no-setup) setup=0 ;;
    --remove-0.9) remove09=1 ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "install.sh: --bin-dir needs a folder" >&2; exit 2; }
      bin_dir="$2"; shift ;;
    *) echo "install.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ "$plugin" = 1 ] || [ "$web" = 1 ] || { echo "install.sh: --no-browser and --no-plugin leave nothing to install" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
# quietly CMD...: runs CMD, and shows what it printed only when it fails
quietly() {
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then rm -f "$log"; else cat "$log" >&2; rm -f "$log"; return 1; fi
}
step() { printf '\n== %s\n' "$*"; }

# ver_ge HAVE WANT: whether the version HAVE is WANT or later, comparing up to three dotted numbers
ver_ge() {
  local IFS=.
  local -a h=($1) w=($2)
  local i a b
  for i in 0 1 2; do
    a="${h[$i]:-0}"; b="${w[$i]:-0}"
    a="${a%%[!0-9]*}"; b="${b%%[!0-9]*}"
    a=$((10#${a:-0})); b=$((10#${b:-0}))
    [ "$a" -gt "$b" ] && return 0
    [ "$a" -lt "$b" ] && return 1
  done
  return 0
}

# claude_update: how to update Claude Code, by where its claude lives. A build that a package manager installed (the
# system's, as an AUR, deb or rpm package; Homebrew; npm) is updated by it: in such a build, `claude update` may only
# say to use the package manager, or that updates are disabled by your administrator.
claude_update() {
  local at
  at="$(command -v claude)"
  at="$(cd / && "$py" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$at" 2>/dev/null)" || at="$(command -v claude)"
  if { pacman -Qo "$at" || dpkg -S "$at" || rpm -qf "$at"; } >/dev/null 2>&1; then
    say "update it with the package manager that installed $at"
    return 0
  fi
  case "$at" in
    */Caskroom/* | */Cellar/*) at="${at#*/Caskroom/}"; at="${at#*/Cellar/}"; say "brew upgrade ${at%%/*}" ;;
    */node_modules/@anthropic-ai/*) say "npm install -g @anthropic-ai/claude-code@latest" ;;
    /nix/*) say "update it with Nix, which installed it" ;;
    *) say "claude update" ;;
  esac
}

# ---- what it needs

macos=0
[ "$(uname -s)" = Darwin ] && macos=1
missing=()
notes=()
if [ "$macos" = 1 ]; then node_fix="brew install node"; uv_fix="brew install uv"
else node_fix="from your system's packages or https://nodejs.org"; uv_fix="curl -LsSf https://astral.sh/uv/install.sh | sh"; fi

node_min=22.12.0
[ "$plugin" = 1 ] && node_min=22.18.0
if ! command -v node >/dev/null 2>&1; then
  missing+=("Node.js ${node_min%.0} or later is not installed: $node_fix")
else
  have="$(node --version 2>/dev/null | sed 's/^v//')"
  ver_ge "$have" "$node_min" || missing+=("Node.js is $have, and thimble needs ${node_min%.0} or later: $node_fix")
fi

if [ "$plugin" = 1 ]; then
  py="${THIMBLE_PYTHON:-python3}"
  # run from / so that no file in the current folder stands in for a module
  pyv="$(cd / && "$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
  if [ -z "$pyv" ]; then
    missing+=("Python 3.10 or later is not installed ($py), which the terminal plugin runs on: install python3")
  elif ! ver_ge "$pyv" 3.10; then
    missing+=("Python is $pyv ($py), and the terminal plugin needs 3.10 or later: install a newer python3, or set THIMBLE_PYTHON")
  fi
  if command -v claude >/dev/null 2>&1; then
    have="$(claude --version 2>/dev/null | awk '{print $1}')"
    ver_ge "$have" 2.1.307 || missing+=("Claude Code is $have, and the terminal plugin needs 2.1.307 or later: $(claude_update)")
  fi
fi

if [ "$web" = 1 ]; then
  command -v node >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1 && missing+=("npm is not installed, and the browser workbench needs it to build: install it with Node.js")
  if ! command -v uv >/dev/null 2>&1; then
    missing+=("uv is not installed, and the browser workbench's server needs it: $uv_fix")
  else
    have="$(uv --version 2>/dev/null | awk '{print $2}')"
    ver_ge "$have" 0.8.0 || missing+=("uv is $have, and the browser workbench needs 0.8 or later: uv self update")
  fi
  if [ "$macos" = 0 ] && ! command -v bwrap >/dev/null 2>&1; then
    notes+=("bubblewrap is not installed, so the browser workbench cannot run card code until you install it: sudo apt install bubblewrap, or your system's package")
  fi
fi

if [ ${#missing[@]} -gt 0 ]; then
  say "thimble needs these first:"
  for m in "${missing[@]}"; do say "  - $m"; done
  say "Then run scripts/install.sh again. Nothing was installed."
  exit 1
fi

# ---- thimble 0.9, which must go first (scripts/thimble09.py says why and how)

if [ "$plugin" = 1 ]; then
  old09() { (cd / && "$py" -I "$root/scripts/thimble09.py" "$@"); }
  found="$(old09 report)"
  if [ -n "$found" ]; then
    say "$found"
    if [ "$remove09" = 0 ]; then
      say "Or run scripts/install.sh --remove-0.9 in a terminal: it shows these steps, runs them after you answer y,"
      say "then installs 0.10."
      exit 1
    fi
    if [ ! -t 0 ] || [ ! -t 1 ]; then
      say ""
      say "--remove-0.9 asks you before it deletes anything, so it runs only in a terminal. Run it in your own terminal,"
      say "or run the commands above. Nothing was removed."
      exit 1
    fi
    say ""
    workspaces="$(old09 workspaces)"
    if [ -n "$workspaces" ]; then
      keep="$HOME/thimble-0.9-workspaces"
      [ -e "$keep" ] && keep="$keep-$(date +%Y%m%d-%H%M%S)"
      printf "Move 0.9's workspaces to %s first, to keep them? [Y/n]: " "$keep"
      read -r answer || { say ""; say "Nothing was removed."; exit 1; }
      case "$answer" in
        n | N | no | No) say "They stay where they are, and removing 0.9 deletes them." ;;
        *) mv "$workspaces" "$keep" || { say "They could not be moved, so nothing was removed."; exit 1; }
           say "Moved: $keep" ;;
      esac
    fi
    say "Removing 0.9 runs:"
    while IFS=$'\t' read -r shown _; do say "  $shown"; done < <(old09 commands)
    printf 'Remove thimble 0.9 now? This cannot be undone. [y/N]: '
    read -r answer || answer=""
    case "$answer" in
      y | Y | yes | Yes) ;;
      *) say "Nothing was removed or installed."; exit 1 ;;
    esac
    while IFS=$'\t' read -r -u 3 shown run; do
      say "+ $shown"
      eval "$run" </dev/null || { say "That step failed, so the install stopped. Do it by hand, then run scripts/install.sh again."; exit 1; }
    done 3< <(old09 commands)
    if [ -n "$(old09 report)" ]; then
      say "thimble 0.9 is still here:"
      old09 report
      exit 1
    fi
    say "thimble 0.9 is removed."
    notes+=("restart the claude sessions that were open during the upgrade, or run /reload-plugins in them: until then they report \"Plugin directory does not exist\" after each tool call")
  fi
fi
say "thimble: what the install needs is here."

# launcher NAME TEXT: writes the launcher NAME in bin_dir, unless another program has that name
launcher() {
  local to="$bin_dir/$1"
  mkdir -p "$bin_dir"
  if [ -e "$to" ] && ! grep -q 'written by thimble scripts/install.sh' "$to" 2>/dev/null; then
    say "$to is another program, so the launcher was not written. Pass --bin-dir to put it elsewhere."
    return 0
  fi
  printf '%s' "$2" > "$to.tmp"
  chmod +x "$to.tmp"
  mv -f "$to.tmp" "$to"
  say "The launcher: $to"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) notes+=("$bin_dir is not on your PATH: add it, or run $to by its full path") ;;
  esac
}
# link_cli TARGET: bin_dir/thimble, a link to TARGET (the installed plugin's bin/thimble), so that thimble is a command
# in a shell once bin_dir is on PATH. Once Claude Code loads thimble from ~/.thimble/fixes/live, thimble points the link
# at the command of ~/.thimble/fixes/release, the release no fix changes; cli-link in thimble's home names the link for
# it. Another program of that name is left alone.
link_cli() {
  local to="$bin_dir/thimble" home="${THIMBLE_HOME:-$HOME/.thimble}"
  mkdir -p "$bin_dir"
  if [ -L "$to" ]; then
    case "$(readlink "$to")" in
      */plugin/bin/thimble) ;;
      *) say "$to is another program, so the thimble command was not linked. Pass --bin-dir to put it elsewhere."; return 0 ;;
    esac
  elif [ -e "$to" ] && ! grep -q 'written by thimble scripts/install.sh' "$to" 2>/dev/null; then
    say "$to is another program, so the thimble command was not linked. Pass --bin-dir to put it elsewhere."
    return 0
  fi
  rm -f "$to.tmp"
  ln -s "$1" "$to.tmp" && mv -f "$to.tmp" "$to"
  mkdir -p "$home" && printf '%s\n' "$to" > "$home/cli-link"
  say "The thimble command: $to → $1"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) notes+=("$bin_dir is not on your PATH, so a new terminal does not find thimble. Add this line to your shell's startup file (~/.zshrc or ~/.bashrc): export PATH=\"$bin_dir:\$PATH\"") ;;
  esac
}
# sq TEXT: TEXT in single quotes, for a launcher
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# fresh_path: the PATH a new terminal starts with, where the claude the person starts finds the node the plugin's cards
# run on: their login shell ($SHELL), started as a terminal starts it (a login shell, interactive, so it reads their
# startup files) with no input, prints its environment; '' when it cannot say within 20 s. The shell runs in a session
# of its own, with no terminal: an interactive shell makes the terminal it finds its own and does not give it back, so
# the install's next question would stop it ("suspended (tty input)"), and a startup file that reads the terminal would
# wait there unseen. At 20 s the shell and what it started get SIGKILL (an interactive shell ignores SIGTERM). In the
# install's Python, as macOS has no setsid command; -I, so no file of the current folder stands in for a module
fresh_path() {
  local sh="${SHELL:-}"
  [ -n "$sh" ] && [ -x "$sh" ] || return 0
  "$py" -I -c '
import os, signal, subprocess, sys, tempfile
sh = sys.argv[1]
e = os.environ
env = {"HOME": e.get("HOME", ""), "USER": e.get("USER", ""), "LOGNAME": e.get("LOGNAME") or e.get("USER", ""), "SHELL": sh,
       "TERM": e.get("TERM") or "xterm-256color", "LANG": e.get("LANG") or "C.UTF-8"}
# its output in a file, read once the shell ends: a program its startup files leave running may keep a pipe open
with tempfile.TemporaryFile() as out:
    p = subprocess.Popen([sh, "-lic", "env"], stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL, env=env,
                         start_new_session=True)
    try:
        p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        p.wait()
        sys.exit(0)
    out.seek(0)
    paths = [line[5:] for line in out.read().decode(errors="replace").splitlines() if line.startswith("PATH=")]
print(paths[-1] if paths else "")
' "$sh" 2>/dev/null || true
}

# ---- the terminal plugin

if [ "$plugin" = 1 ]; then
  step "The terminal plugin"
  source="safety-research/thimble"
  [ "$local" = 1 ] && source="$root"
  # once a fix went on, Claude Code loads thimble from the fixes' live folder, and refuses another source for its
  # marketplace: thimble update moves that folder to the new release and keeps the fixes. Its source is such a folder
  # when it is a fixes/live checkout with release.json beside it, in this shell's THIMBLE_HOME or any other. A source
  # that names a fixes/live folder that is gone (its thimble home was deleted) is removed, and the plugin installs as
  # usual
  found="$(cd / && "$py" -c '
import json, os
cc = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
home = os.path.realpath(os.path.join(os.environ.get("THIMBLE_HOME") or os.path.expanduser("~/.thimble"), "fixes", "live"))
named = []
for at, keys in ((("plugins", "known_marketplaces.json"), ("thimble", "source")),
                 (("settings.json",), ("extraKnownMarketplaces", "thimble", "source"))):
    try:
        d = json.load(open(os.path.join(cc, *at)))
        for k in keys:
            d = d[k]
        p = os.path.realpath(d["path"]) if d.get("source") == "directory" else ""
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        p = ""
    live = home if p and (p + os.sep).startswith(home + os.sep) else p
    if live and os.path.basename(live) == "live" and os.path.basename(os.path.dirname(live)) == "fixes":
        named.append(live)
real = [p for p in named if os.path.exists(os.path.join(p, ".git"))
        and os.path.isfile(os.path.join(os.path.dirname(p), "release.json"))]
if real:
    print("live " + real[0])
elif named:
    print("gone " + named[0])
' || true)"
  fixes_live="" gone=""
  case "$found" in
    "live "*) fixes_live="${found#live }" ;;
    "gone "*) gone="${found#gone }" ;;
  esac
  if [ -n "$fixes_live" ]; then
    say "Claude Code loads thimble from your fixes ($fixes_live), so the plugin is left as it is: run thimble update, which updates both products and keeps your fixes."
  elif command -v claude >/dev/null 2>&1; then
    if [ -n "$gone" ]; then
      # when only Claude Code's settings name that folder, its list has no marketplace thimble: remove says that it is
      # not found and changes nothing, and Claude Code refuses the add below while its settings name thimble from
      # another source. Then the install removes thimble from the settings itself, only when they name it at that folder
      # or in it (written to a new file, which then replaces settings.json, with its mode)
      if removed="$(claude plugin marketplace remove thimble 2>&1)"; then
        say "$removed"
      else
        case "$removed" in
          *"not found"*)
            (cd / && "$py" -c '
import json, os, sys, tempfile
gone = sys.argv[1]
at = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "settings.json")
real = os.path.realpath(at)  # when settings.json is a link, the file it links to changes
try:
    with open(real, encoding="utf-8") as f:
        d = json.load(f)
    src = d["extraKnownMarketplaces"]["thimble"]["source"]
    p = os.path.realpath(src["path"]) if src.get("source") == "directory" else ""
except (OSError, ValueError, KeyError, TypeError, AttributeError):
    p = ""
if not p or (p != gone and not p.startswith(gone + os.sep)):
    sys.exit(0)  # the settings do not name thimble at that folder: the add says what is wrong, if anything is
del d["extraKnownMarketplaces"]["thimble"]
try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(real), prefix=".settings.json.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.chmod(tmp, os.stat(real).st_mode & 0o7777)
        os.replace(tmp, real)
    except BaseException:
        os.unlink(tmp)
        raise
except OSError as e:
    sys.exit("install.sh: could not remove the marketplace thimble from %s (%s), and Claude Code adds it again only "
             "after that. Remove extraKnownMarketplaces.thimble from that file, then run scripts/install.sh again."
             % (at, e.strerror or e))
print("Removed the marketplace thimble from %s: its folder %s is gone." % (at, gone))
' "$gone") ;;
          *) say "$removed" >&2; exit 1 ;;
        esac
      fi
    fi
    claude plugin marketplace add "$source"
    if claude plugin list --json 2>/dev/null | grep -q '"thimble@thimble"'; then
      claude plugin marketplace update thimble
      claude plugin update thimble@thimble
    else
      # each feature's default, from the userConfig of the plugin this installs (the marketplace just added: GitHub's,
      # or this checkout with --local), so a fresh install has no option left unset and none its version lacks
      config=()
      while IFS= read -r kv; do [ -n "$kv" ] && config+=(--config "$kv"); done < <(cd / && "$py" -c '
import json, os, sys
plugins = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "plugins")
try:
    at = json.load(open(os.path.join(plugins, "known_marketplaces.json")))["thimble"]["installLocation"]
    entry = next(p for p in json.load(open(os.path.join(at, ".claude-plugin", "marketplace.json")))["plugins"]
                 if p.get("name") == "thimble")
    manifest = json.load(open(os.path.join(at, entry["source"], ".claude-plugin", "plugin.json")))
except (OSError, ValueError, KeyError, TypeError, StopIteration):
    sys.exit(0)  # no defaults to give: Claude Code installs the plugin with its own
for k, v in (manifest.get("userConfig") or {}).items():
    d = v.get("default")
    # --config takes the value as typed: a string bare (quotes would be kept as part of it), a boolean as true or
    # false; it refuses an empty value, and one refused value drops them all, so an empty default stays unset
    if isinstance(d, bool):
        print(k + "=" + json.dumps(d))
    elif d not in (None, ""):
        print(k + "=" + str(d))
')
      claude plugin install thimble@thimble ${config[@]+"${config[@]}"}
    fi
    # the sandbox the plugin's cards run in: Anthropic's sandbox runtime, at the version the installed plugin pins, in
    # thimble's home (the plugin's sandbox/setup.mjs, which the plugin also runs at each session start)
    at="$(cd / && "$py" -c '
import json, os
plugins = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "plugins")
try:
    at = json.load(open(os.path.join(plugins, "known_marketplaces.json")))["thimble"]["installLocation"]
    entry = next(p for p in json.load(open(os.path.join(at, ".claude-plugin", "marketplace.json")))["plugins"]
                 if p.get("name") == "thimble")
    print(os.path.normpath(os.path.join(at, entry["source"])))
except (OSError, ValueError, KeyError, TypeError, StopIteration):
    pass
' || true)"
    if [ -n "$at" ] && [ -f "$at/sandbox/setup.mjs" ]; then
      say "The sandbox that cards run in (Anthropic's sandbox runtime)..."
      # the test draws a card as a session does: on the node and PATH of a new terminal (fresh_path), else on this
      # shell's; a failure it can repair (srt that does not load or start) it repairs (--repair)
      probe_path="$(fresh_path)"
      probe_node=""
      if [ -n "$probe_path" ]; then
        probe_node="$(PATH="$probe_path"; hash -r; command -v node 2>/dev/null || true)"
        [ -n "$probe_node" ] || notes+=("a new terminal finds no node, and the plugin's cards run on the node a new terminal finds. Add this line to your shell's startup file (~/.zshrc or ~/.bashrc): export PATH=\"$(dirname "$(command -v node)"):\$PATH\"")
      fi
      [ -n "$probe_node" ] || { probe_node="$(command -v node)"; probe_path="$PATH"; }
      # its line (npm's progress goes to stderr, and shows as it comes); when the sandbox does not work yet, the line's
      # why and fix again in the notes, at the end. The fix, on the line after the why, often ends in a command: it
      # keeps a line of its own, so that no words follow the command
      if sandbox="$(PATH="$probe_path" "$probe_node" "$at/sandbox/setup.mjs" --probe --repair)"; then
        say "$sandbox"
      else
        say "$sandbox"
        why="${sandbox%%$'\n'*}"
        fix="${sandbox#"$why"}"
        why="${why#thimble: }"
        notes+=("${why:-cards cannot run yet: the sandbox check failed, as it said above.} The next card tries again${fix:+ after this:$fix}")
      fi
    fi
    # thimble in a shell (thimble update, thimble fixes): a link to the plugin's own command, as 0.9 had it
    if [ -n "$at" ] && [ -x "$at/bin/thimble" ]; then
      link_cli "$at/bin/thimble"
    fi
    say "The plugin works in a new claude session, in a folder of data files that you trust."
  else
    say "Claude Code (the claude command) is not installed. Install it, then run:"
    if [ -n "$gone" ]; then
      say "  claude plugin marketplace remove thimble"
    fi
    say "  claude plugin marketplace add $source"
    say "  claude plugin install thimble@thimble"
  fi
fi

# ---- the browser workbench

if [ "$web" = 1 ]; then
  step "The browser workbench"
  say "The server's Python packages (uv sync in browser/backend)..."
  export NPM_CONFIG_UPDATE_NOTIFIER=false
  # with the test extras, so that thimble's dev agent can run the backend's tests in a checkout
  quietly uv sync --project "$browser/backend" --frozen --no-dev --no-install-project --extra dev
  say "The page and the sandbox runtime (npm ci in browser/frontend, then a build)..."
  quietly npm --prefix "$browser/frontend" ci --no-audit --no-fund
  quietly npm --prefix "$browser/frontend" run build

  launcher thimble-browser "#!/bin/sh
# thimble-browser, written by thimble scripts/install.sh: starts the browser workbench of this checkout.
exec $(sq "$browser/scripts/thimble-browser") \"\$@\"
"

  # how the workbench reaches Claude: asked here once, kept in its home (backend app/claude_access.py)
  browser_home="${THIMBLE_BROWSER_HOME:-$HOME/.thimble-browser}"
  mkdir -p "$browser_home" && chmod 700 "$browser_home"
  # thimble update links this checkout's packages into ~/.thimble/fixes/live while their lock files are the same
  printf '%s\n' "$browser" > "$browser_home/checkout"
  access() { (cd "$browser/backend" && THIMBLE_HOME="$browser_home" .venv/bin/python -m app.claude_access "$@"); }
  if [ "$setup" = 1 ] && [ -t 0 ]; then
    step "How the browser workbench reaches Claude"
    mkdir -p "$browser_home" && chmod 700 "$browser_home"
    ask=1
    if access status >/dev/null 2>&1; then
      access status
      printf 'Keep it? [Y/n]: '
      read -r keep || keep=""
      case "$keep" in n | N | no | No) ask=1 ;; *) ask=0 ;; esac
    fi
    if [ "$ask" = 1 ]; then
      access setup || notes+=("Claude access is not set up yet: the page asks at its first start, or run thimble-browser --setup")
    fi
  elif ! access status >/dev/null 2>&1; then
    # no terminal to ask in (an agent runs this script, or --no-setup): whoever runs it asks the person
    notes+=("Claude access is not set up yet. Ask the person which way the workbench reaches Claude, then set it with thimble-browser --setup, which checks that Claude answers. Their Claude Code sign-in, only after they accept \"This uses your Claude subscription through Claude Code and will launch headless Claude Code sessions in the background.\": --how claude-code --yes. An Anthropic API key: --key-file FILE, a file they write themselves from the clipboard (never take a key in a chat, and never read that file). Workload Identity Federation: --how wif --wif-file FILE (--find-wif lists the config files it finds). Skipped, the page asks at its first start")
  fi

  kb() { du -sk "$1" 2>/dev/null | awk '{print $1}' || echo 0; }
  page=$(kb "$browser/frontend/node_modules"); built=$(kb "$browser/frontend/dist"); venv=$(kb "$browser/backend/.venv")
  mb() { echo $((($1 + 512) / 1024)); }
  say "The browser workbench takes $(mb $((page + built + venv))) MB in this checkout: the page's packages and the sandbox" \
    "runtime $(mb "$page") MB (browser/frontend/node_modules), the server's Python packages $(mb "$venv") MB" \
    "(browser/backend/.venv) and the built page $(mb "$built") MB."
fi

if [ "$web" = 1 ]; then
  say ""
  say "To start the browser workbench, run this in a folder of files:"
  say ""
  say "  thimble-browser"
  say ""
  say "It starts the server on 127.0.0.1 (port 8300, or the next free one) and prints the page's sign-in link"
  say "(or: thimble-browser FOLDER). browser/README.md says more."
fi
# what does not work yet or is left to do, last
if [ ${#notes[@]} -gt 0 ]; then
  say ""
  for n in "${notes[@]}"; do say "Note: $n"; done
fi
