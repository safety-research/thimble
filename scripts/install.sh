#!/usr/bin/env bash
# install.sh: installs thimble in ~/.thimble: its plugin for Claude Code and its browser workbench.
#
#   curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash -s -- OPTIONS
#
# It downloads the newest release's file from GitHub (thimble-X.Y.Z.tar.gz, checked against its SHA256SUMS) and makes
# it ~/.thimble/fixes/live, a git repository of its own, so that /thimble-fix can keep your fixes as commits, with the
# plain release beside it in ~/.thimble/fixes/release; it adds the plugin to Claude Code from there, builds the
# workbench there, and puts the commands thimble and thimble-browser in ~/.local/bin. thimble update moves both
# products to a newer release later. GitHub counts the downloads of each release's file; thimble sends nothing else.
# Run from a downloaded release or a clone, it does the same; only --local, in a clone, installs from that clone. The
# steps that change ~/.thimble and Claude Code are thimble's own code, in the release it downloads
# (plugin/engine/kernel/install.py). THIMBLE_RELEASES_URL stands in for GitHub's address in tests (a 127.0.0.1 server).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [--no-browser] [--sign-in claude-code|api-key|wif] [--wif-file PATH] [--bin-dir DIR] [--ref REF]
                  [--local] [--remove-0.9]

Installs thimble in ~/.thimble: the newest release, its plugin for Claude Code, and its browser workbench (about 1 GB).
It checks first what thimble needs, and installs nothing while something is missing. Run it again at any time: an
install in ~/.thimble stays as it is, with your fixes, and thimble update moves it to a newer release.

  --no-browser       the plugin alone, without the workbench
  --sign-in HOW      how the workbench reaches Claude: claude-code (your Claude Code sign-in), api-key
                     (ANTHROPIC_API_KEY when it is set, else a key you paste in the workbench's Settings) or wif
                     (Workload Identity Federation, with --wif-file). Without it, the install asks in a terminal;
                     elsewhere the workbench asks when it starts
  --wif-file PATH    your WIF config file, for --sign-in wif
  --bin-dir DIR      put the commands thimble and thimble-browser in DIR, not in ~/.local/bin
  --ref REF          install this branch or tag of thimble, not the newest release: a release's file when the tag has
                     one, else GitHub's archive of it (to try a branch before its release); --version X.Y.Z is the
                     same as --ref vX.Y.Z
  --local            in a clone of thimble: install from the clone (the dev install, for work on thimble's own code).
                     thimble update then follows the clone, which you pull yourself. A release installed in ~/.thimble
                     goes aside with its fixes, and the install without --local brings it back
  --remove-0.9       when thimble 0.9 is here, remove it first: the install shows the steps, and runs them after you
                     answer y, in a terminal
EOF
}

say() { printf '%s\n' "$*"; }
# stop TEXT: an option or a system that cannot work, said before anything is installed or run
stop() { printf 'install.sh: %s\n' "$*" >&2; exit 2; }
# tilde PATH: a path as the person reads it, with ~ for their home
tilde() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
# terminal: whether a person can answer here; through a pipe (curl ... | bash) the script asks on /dev/tty
terminal() { [ -t 1 ] && (exec </dev/tty) 2>/dev/null; }
# kernel ARGS...: thimble's own code, from the release in $code (engine/kernel/install.py holds the install's steps)
kernel() { "$py" -B "$code/plugin/engine/thimble.py" "$@" --notes "$notes" --state "$state"; }
# browser 1: the kernel's option for a step that has the workbench to install, or installed
browser() { if [ "$1" = 1 ]; then echo --browser; fi; }
# web ARGS...: curl as thimble reads its releases: no ~/.curlrc (-q), over HTTPS alone (plain http too while
# THIMBLE_RELEASES_URL stands in for GitHub), its error line in $work/err
web() {
  local proto="=https"
  [ -z "${THIMBLE_RELEASES_URL:-}" ] || proto="=http,https"
  curl -q --proto "$proto" --proto-redir "$proto" -sS --connect-timeout 20 --retry 2 "$@" 2>"$work/err"
}
# why_curl: what curl said in $work/err, in one line, without its `curl: (N) `
why_curl() { local why; why="$(sed -n 's/^curl: ([0-9]*) //p' "$work/err" | tail -n 1)"; printf '%s' "${why%.}"; }
# failed WHY FIX: the end of the download's line, then what to do; nothing was installed, and the install stops
failed() { say " failed: ${1%.}."; say "$2 Nothing was installed."; exit 1; }
# again: what to do after a download that failed
again() {
  if [ -n "$asked" ]; then printf 'Check the network and the name %s, then run the install again.' "$asked"
  else printf 'Check the network, then run the install again.'; fi
}
# sha FILE: its sha256 (macOS has shasum, Linux sha256sum; both have the Python that step 1 checked)
sha() {
  (cd / && "$py" -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1")
}
# unpack FILE DIR: the archive FILE into DIR, its one folder named on stdout; every member is checked before anything
# is written: an absolute path, a .. part, anything but a file or a folder (a link, a device), or a path outside the
# first member's folder refuses it, with that member's name on stderr (Python's data filter, where it has one, checks
# again)
unpack() {
  (cd / && "$py" -I -c 'import sys, tarfile; t = tarfile.open(sys.argv[1]); m = t.getmembers(); '\
'm or sys.exit("it holds no files"); top = m[0].name.split("/")[0]; bad = [x.name for x in m if '\
'x.name.startswith("/") or ".." in x.name.split("/") or not (x.isfile() or x.isdir()) or '\
'x.name.split("/")[0] != top]; bad and sys.exit("refused: " + bad[0]); '\
'safe = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}; t.extractall(sys.argv[2], m, **safe); '\
'print(top)' "$1" "$2")
}
# newest: the newest release's tag in $ref, from where GitHub's page of the latest release points, which reads no file;
# '' when it names none, with the HTTP status of GitHub's answer in $status (curl ends well on a 503, once its tries
# are over)
newest() {
  local got
  got="$(web -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 60 "$releases/releases/latest")" || got=""
  status="${got%% *}"
  ref="$(printf '%s\n' "${got#* }" | sed -n 's|.*/releases/tag/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p')"
}

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

# fix NAME: the command that installs NAME here
fix() {
  if [ "$(uname -s)" = Darwin ]; then
    case "$1" in
      node | npm) say "brew install node" ;;
      python) say "brew install python" ;;
      git) say "xcode-select --install" ;;
      uv) say "brew install uv" ;;
      curl) say "brew install curl" ;;
    esac
    return 0
  fi
  case "$1" in
    node) say "install Node.js 22 or later from https://nodejs.org/en/download" ;;
    uv) say "curl -LsSf https://astral.sh/uv/install.sh | sh" ;;
    *)
      local name="$1" m
      [ "$name" = python ] && name=python3
      for m in "apt-get:sudo apt-get install" "dnf:sudo dnf install" "yum:sudo yum install" "pacman:sudo pacman -S" \
               "zypper:sudo zypper install" "apk:sudo apk add"; do
        command -v "${m%%:*}" >/dev/null 2>&1 && { say "${m#*:} $name"; return 0; }
      done
      say "install $name with your system's package manager" ;;
  esac
}

# claude_update: how to update Claude Code, by where its claude lives: a build that a package manager installed (the
# system's, Homebrew, npm) is updated by it, since its own claude update may say that updates are disabled
claude_update() {
  local at
  at="$(command -v claude)"
  at="$(cd / && "$py" -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$at" 2>/dev/null)" ||
    at="$(command -v claude)"
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

# needs: what thimble needs, checked before anything is installed: Node.js, Python and git, curl to download the
# release, Claude Code for the plugin, uv and npm for the workbench. It says each version, or what is missing with its
# fix, and then installs nothing
needs() {
  say "Checking what thimble needs..."
  local have=() missing=() v
  if v=$(node --version 2>/dev/null) && v=${v#v} && ver_ge "$v" 22.18; then have+=("Node.js $v")
  else missing+=("Node.js 22.18 or later${v:+ (the one here is $v)}: $(fix node)"); fi
  if v=$(cd / && "$py" -I -c 'import platform; print(platform.python_version())' 2>/dev/null) && ver_ge "$v" 3.10; then
    have+=("Python $v")
  else missing+=("Python 3.10 or later${v:+ (the one here is $v)}: $(fix python)"); fi
  if v=$(git --version 2>/dev/null | awk '{print $3}') && [ -n "$v" ]; then have+=("git $v")
  else missing+=("git: $(fix git)"); fi
  # every system has curl, so it is named only when it is missing; the dev install downloads no release
  [ "$local" = 1 ] || command -v curl >/dev/null 2>&1 || missing+=("curl: $(fix curl)")
  v=$(claude --version 2>/dev/null | awk '{print $1}') || v=""
  if [ -n "$v" ] && ver_ge "$v" 2.1.307; then have+=("Claude Code $v")
  elif [ -n "$v" ]; then missing+=("Claude Code 2.1.307 or later (the one here is $v): $(claude_update)")
  else missing+=("Claude Code 2.1.307 or later: curl -fsSL https://claude.ai/install.sh | bash"); fi
  if [ "$web" = 1 ]; then
    v=$(uv --version 2>/dev/null | awk '{print $2}') || v=""
    if [ -n "$v" ] && ver_ge "$v" 0.8; then have+=("uv $v")
    elif [ -n "$v" ]; then missing+=("uv 0.8 or later (the one here is $v): uv self update")
    else missing+=("uv: $(fix uv)"); fi
    if v=$(npm --version 2>/dev/null) && [ -n "$v" ]; then have+=("npm $v"); else missing+=("npm: $(fix npm)"); fi
  fi
  case "$(uname -r)" in  # Windows: WSL 1 has no namespaces for the cards' sandbox; WSL 2 has Windows' drives in /mnt
    *Microsoft*) missing+=("WSL 2 (this is WSL 1): in Windows, wsl --set-version ${WSL_DISTRO_NAME:-DISTRO} 2") ;;
    *microsoft*) for v in node npm "$py" claude; do case "$(command -v "$v")" in "${THIMBLE_WSL_DRIVES:-/mnt}"/*)
      say "  $v here is Windows' own, on its drives: install a Linux one in WSL, first on PATH." ;; esac; done ;; esac
  if [ ${#missing[@]} -gt 0 ]; then
    say "thimble needs these first:"
    for v in "${missing[@]}"; do say "  - $v"; done
    say "Run the install again after that. Nothing was installed."
    exit 1
  fi
  v=$(printf '%s, ' "${have[@]}")
  say "  ${v%, }: all here."
}

# download REF: thimble's release REF (vX.Y.Z): its SHA256SUMS, then its file, which must have the sha256 that
# SHA256SUMS gives; with --ref, a branch, or a tag that has no file, is GitHub's archive of it (which GitHub does not
# count). Then the file is unpacked, with $file, $tag (for a release's file) and $code (its folder) set. On a failure,
# what went wrong and what to do, and the install stops
download() {
  local name got at why want
  file="" tag="" name="thimble-${1#v}.tar.gz" at="$releases/releases/download/$1"
  mkdir -p "$work/get"
  case "$1" in
    v[0-9]*)
      got=$(web -L -o "$work/get/SHA256SUMS" -w '%{http_code}' --max-time 120 "$at/SHA256SUMS") ||
        failed "$(why_curl)" "$(again)"
      if [ "$got" = 200 ]; then
        got=$(web -L -o "$work/get/$name" -w '%{http_code}' --max-time 600 "$at/$name") || {
          [ $? = 23 ] && failed "$(why_curl)" "Make room on the disk (${TMPDIR:-/tmp}), then run the install again."
          failed "$(why_curl)" "$(again)"; }
        [ "$got" != 404 ] || failed "thimble ${1#v}'s release file is missing on GitHub ($name)" \
          "Run the install again in a few minutes; if it says this again, report it at $issues."
        [ "$got" = 200 ] || failed "GitHub answered $got" "$(again)"
        want="$(awk -v n="$name" '$2 == n || $2 == "*" n { print tolower($1) }' "$work/get/SHA256SUMS")"
        why="$name does not have the sha256 its SHA256SUMS gives, so the download is broken"
        [ -n "$want" ] && [ "$want" = "$(sha "$work/get/$name")" ] || failed "$why" "Run the install again."
        file="$work/get/$name" tag="$1"
      elif [ "$got" != 404 ]; then failed "GitHub answered $got" "$(again)"
      elif [ -z "$asked" ]; then failed "thimble ${1#v} has no release file on GitHub ($name)" \
        "Run the install again in a few minutes; if it says this again, report it at $issues."
      fi ;;
  esac
  if [ -z "$file" ]; then
    file="$work/get/thimble-$(printf '%s' "$1" | tr / -).tar.gz"
    got=$(web -L -o "$file" -w '%{http_code}' --max-time 600 "$releases/archive/$1.tar.gz") || {
      [ $? = 23 ] && failed "$(why_curl)" "Make room on the disk (${TMPDIR:-/tmp}), then run the install again."
      failed "$(why_curl)" "$(again)"; }
    [ "$got" != 404 ] || failed "GitHub has no branch or tag named $1" "Check the name $1, then run the install again."
    [ "$got" = 200 ] || failed "GitHub answered $got" "$(again)"
  fi
  mkdir "$work/release"
  if ! code="$(unpack "$file" "$work/release" 2>"$work/err")"; then
    why="$(sed -n 's/^refused: //p' "$work/err" | head -n 1)"
    [ -z "$why" ] || failed "$(basename "$file") holds $why, a link or a path out of its folder" "Report it at $issues."
    failed "$(basename "$file") could not be unpacked ($(sed '/^ *$/d' "$work/err" | tail -n 1))" "$(again)"
  fi
  code="$work/release/$code"
  # a release from before release files has a kernel that cannot install from one: its own script can
  why="https://raw.githubusercontent.com/safety-research/thimble/$1/scripts/install.sh"
  grep -q -- '"--file"' "$code/plugin/engine/kernel/cli.py" 2>/dev/null ||
    failed "thimble ${1#v} comes from before thimble's releases had files, so this script cannot install it" \
      "Its own script can: curl -fsSL $why | bash -s -- --ref $1."
}

# no09 DIR: stops while thimble 0.9 is here, with what it found and the commands that remove it (DIR's
# scripts/thimble09.py); with --remove-0.9, in a terminal, it runs them after the person's y
no09() {
  local found noun answer workspaces keep shown run restart
  old09() { (cd / && "$py" -I "$1/scripts/thimble09.py" "${@:2}"); }
  found="$(old09 "$1" report)"
  [ -n "$found" ] || return 0
  if [ "$open" = 1 ]; then say ""; fi  # the line that says the download, left open
  say ""
  say "$found"
  if [ "$remove09" = 0 ]; then
    say ""
    say "Remove it with the commands above, then run the install again. Nothing was installed."
    exit 1
  fi
  say ""
  if ! terminal; then
    say "--remove-0.9 asks you before it deletes anything, so it runs only in a terminal. Run the commands above, or"
    say "run the install in your own terminal. Nothing was installed."
    exit 1
  fi
  workspaces="$(old09 "$1" workspaces)"
  if [ -n "$workspaces" ]; then
    keep="$HOME/thimble-0.9-workspaces"
    [ -e "$keep" ] && keep="$keep-$(date +%Y%m%d-%H%M%S)"
    printf "Move 0.9's workspaces to %s first, to keep them? [Y/n]: " "$(tilde "$keep")"
    read -r answer </dev/tty || answer=n
    case "$answer" in
      n | N | no | No) say "They stay where they are, and removing 0.9 deletes them." ;;
      *) mv "$workspaces" "$keep" || { say "They could not be moved, so nothing was removed."; exit 1; }
         say "Moved: $(tilde "$keep")" ;;
    esac
  fi
  # what it removes, by its name: thimble 0.9, or the link to a thimble folder that is gone, which names no version
  noun="$(old09 "$1" noun)"
  printf 'Remove %s now, with the commands above? This cannot be undone. [y/N]: ' "$noun"
  read -r answer </dev/tty || answer=""
  case "$answer" in y | Y | yes | Yes) ;; *) say "Nothing was removed or installed."; exit 1 ;; esac
  while IFS=$'\t' read -r -u 3 shown run; do
    say "+ $shown"
    if ! eval "$run" </dev/null; then
      say "That step failed, so the install stopped. Do it by hand, then run the install again."
      exit 1
    fi
  done 3< <(old09 "$1" commands)
  if [ -n "$(old09 "$1" report)" ]; then say "$noun is still here."; exit 1; fi
  say "$noun is removed."
  restart="Note: restart the claude sessions that were open, or type /reload-plugins in them: until then they say"
  say "$restart \"Plugin directory does not exist\" after each tool call." >>"$notes"
}

# signin BROWSER: how the workbench in BROWSER reaches Claude, set by its own setup (thimble-browser --setup): the way
# --sign-in names, else one chosen before, else asked in a terminal; its lines go under The workbench
signin() {
  local args=(--keep) tty=/dev/null
  if ! grep -q -- '"--keep"' "$1/backend/app/claude_access.py" 2>/dev/null; then
    # a workbench from before 0.10.8 (an install whose fixes are on an older release), whose setup asks again: the way
    # it had stays, and while there is none, the page asks
    if [ -f "${THIMBLE_BROWSER_HOME:-$HOME/.thimble-browser}/claude-access.json" ]; then
      say "  Sign-in: as it was before."
    else
      say "  Sign-in: not chosen yet. The workbench asks when it starts."
    fi
    return 0
  fi
  [ -z "$sign_in" ] || args=(--how "$sign_in")
  [ -z "$wif_file" ] || args+=(--wif-file "$wif_file")
  terminal && tty=/dev/tty
  "$1/scripts/thimble-browser" --setup "${args[@]}" <"$tty" | sed 's/^/  /' || true
}

# finish WHAT: the end: what is installed, how to try it (in the Claude Code session that runs the install, which sets
# CLAUDECODE for its commands, or in a terminal), then what does not work yet
finish() {
  say ""
  say "$1."
  say ""
  if [ -n "${CLAUDECODE:-}" ]; then say "Try it now: type /reload-plugins in this Claude Code session."
  else say "Try it now: run claude in a folder of data files."; fi
  if [ "$built" = 1 ]; then
    say "The browser workbench: run thimble-browser in a folder of files, in a terminal of its own, and open the link" \
      "it prints."
  fi
  if [ -s "$notes" ]; then say ""; cat "$notes"; fi
}

main() {
  # the options
  web=1 local=0 remove09=0 sign_in="" wif_file="" asked="" bin_dir="$HOME/.local/bin"
  while [ $# -gt 0 ]; do
    case "$1" in
      -h | --help) usage; exit 0 ;;
      --no-browser) web=0 ;;
      --sign-in | --wif-file | --bin-dir | --ref | --version)
        [ $# -ge 2 ] || stop "$1 needs a value (see --help)"
        case "$1" in
          --sign-in) sign_in="$2" ;;
          --wif-file) wif_file="$2" ;;
          --bin-dir) bin_dir="$2" ;;
          --ref) asked="$2" ;;
          --version) asked="v${2#v}" ;;
        esac
        shift ;;
      --local) local=1 ;;
      --remove-0.9) remove09=1 ;;
      --no-setup) ;;  # an earlier install's option: the workbench asks when it starts, as it does now with no terminal
      *) stop "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  # the name goes into an address on GitHub
  case "$asked" in *[!A-Za-z0-9._/+@-]* | *..* | [-/]*)
    stop "--ref takes the name of a branch or tag of thimble, such as main or v0.10.13" ;; esac
  case "$sign_in" in "" | claude-code | api-key | wif) ;; *) stop "--sign-in is claude-code, api-key or wif" ;; esac
  [ -z "$wif_file" ] || [ -n "$sign_in" ] || sign_in=wif
  [ "$sign_in" != wif ] || [ -n "$wif_file" ] || terminal ||
    stop "--sign-in wif needs --wif-file PATH, the path of your WIF config file"
  [ "$web" = 1 ] || [ -z "$sign_in" ] || stop "--sign-in sets up the workbench, which --no-browser leaves out"
  case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) stop "thimble runs on Windows only inside WSL 2. In PowerShell:" \
    "wsl --install (restart if asked), then open Ubuntu from the Start menu and run this install command there." ;; esac
  py="${THIMBLE_PYTHON:-python3}" releases="${THIMBLE_RELEASES_URL:-https://github.com/safety-research/thimble}"
  releases="${releases%/}" issues="https://github.com/safety-research/thimble/issues"
  home="${THIMBLE_HOME:-$HOME/.thimble}" fixes="${THIMBLE_HOME:-$HOME/.thimble}/fixes"
  # the install's own folder: the kernel takes --notes and --state only in one so named (install.py in_work)
  work="$(mktemp -d "${TMPDIR:-/tmp}/thimble-install.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  notes="$work/notes" state="$work/state.json" built=0 open=0
  : >"$notes"
  # the plugin hands a command that cannot write ~/.thimble to Claude Code; the install's own steps run here
  unset THIMBLE_HANDOFF

  say "Installing thimble."
  say ""
  # 1. what thimble needs, checked before anything is installed
  needs

  if [ "$local" = 1 ]; then
    # the dev install: the plugin and the workbench from this clone, which thimble update then follows
    code="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/.." 2>/dev/null && pwd -P)" || code=""
    [ -f "${BASH_SOURCE[0]:-}" ] && [ "$(git -C "$code" rev-parse --show-toplevel 2>/dev/null)" = "$code" ] ||
      stop "--local installs from a clone of thimble: git clone https://github.com/safety-research/thimble, then" \
        "run scripts/install.sh --local in it"
    no09 "$code"
    # the release installed in ~/.thimble goes aside with its fixes, and this clone's fixes set aside before come back
    kernel install switch --folder "$code" || exit 1
    say ""
    say "The plugin"
    kernel install plugin --folder "$code" || { say "After you fix that, run the install again."; exit 1; }
    kernel install sandbox --folder "$code"
    if [ "$web" = 1 ]; then
      say ""
      say "The workbench"
      if kernel install browser --folder "$code"; then built=1; signin "$code/browser"; fi
    fi
    say ""
    kernel install commands --folder "$code" --bin-dir "$bin_dir" $(browser "$built")
    finish "thimble is installed from your clone $(tilde "$code")"
    return 0
  fi

  # 2. the release: the newest, which GitHub's page of the latest release names, or the branch or tag that --ref names
  if [ -n "$asked" ]; then
    ref="$asked"
  else
    newest
    if [ -z "$ref" ]; then
      say ""
      printf 'Downloading thimble into %s...' "$(tilde "$home")"
      why="$(why_curl)"
      failed "${why:-thimble found no release at $releases (GitHub answered ${status:-nothing})}" \
        "Check the network, then run the install again."
    fi
  fi
  name="$ref"
  case "$name" in v[0-9]*.[0-9]*.[0-9]*) name="${name#v}" ;; esac

  say ""
  if [ -e "$fixes/live/.git" ] && [ -f "$fixes/release.json" ] && ! grep -q '"kind": "clone"' "$fixes/release.json"; then
    # 3. an install in ~/.thimble stays, with its fixes; it runs its own code, unless it is older than this install
    code="$fixes/release"
    if [ ! -f "$code/plugin/engine/kernel/install.py" ]; then
      printf 'Downloading thimble %s for its install steps...' "$name"
      download "$ref"
      say " done."
    fi
    no09 "$code"
    kernel install release ${asked:+--ref "$asked"} --bin-dir "$bin_dir" $(browser "$web") || {
      [ $? = 3 ] && return 0  # every part is in place
      exit 1
    }
  else
    # 3. the release's file, downloaded and checked, then made ~/.thimble/fixes/live. A dev install's fixes there
    # (--local) go aside first, and the release that --local set aside comes back in place of the download
    back=""
    for d in "$fixes"-release-*; do if [ -e "$d/live/.git" ] && [ -f "$d/release.json" ]; then back=1; fi; done
    if [ -n "$back" ]; then printf 'Downloading thimble %s for its install steps...' "$name"
    else printf 'Downloading thimble %s into %s...' "$name" "$(tilde "$home")"; fi
    open=1
    download "$ref"
    no09 "$code"
    if out="$(kernel install release --file "$file" ${tag:+--tag "$tag"} ${asked:+--ref "$asked"} \
      --bin-dir "$bin_dir" $(browser "$web") 2>&1)"; then say " done."
    else say " failed: $out"; exit 1; fi
    open=0
    [ -z "$out" ] || say "$out"
  fi

  # 4. the plugin: Claude Code loads it from ~/.thimble/fixes/live, with its settings as they were
  say ""
  say "The plugin"
  kernel install plugin || { say "After you fix that, run the install again."; exit 1; }
  # 5. the sandbox that cards run in: it draws a test card
  kernel install sandbox

  # 6. the workbench: its packages and its page, built in ~/.thimble/fixes/live/browser, then how it reaches Claude
  if [ "$web" = 1 ]; then
    say ""
    say "The workbench"
    if kernel install browser; then built=1; signin "$fixes/live/browser"; fi
  fi

  # 7. the commands thimble and thimble-browser, and the folders of an earlier install that nothing uses now
  say ""
  kernel install commands --bin-dir "$bin_dir" $(browser "$built")

  # 8. what is installed, how to try it, and what does not work yet
  finish "thimble $(kernel install name) is installed"
}

main "$@"
