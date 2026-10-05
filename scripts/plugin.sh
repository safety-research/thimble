#!/usr/bin/env bash
# scripts/plugin.sh — thimble in every Claude Code session: on, off, or which it is now.
#
#   thimble plugin on | off | status      (or: bash scripts/plugin.sh on | off | status)
#
# The `thimble` command loads thimble's plugin into the sessions it starts either way. `on` adds it to every Claude Code
# session, so /thimble works in any `claude` session: it registers this install's folder as a Claude Code marketplace
# and installs thimble from it at user scope (~/.claude/settings.json and ~/.claude/plugins). `off` takes back what `on`
# added. thimble-cc-mod is switched on its own (`thimble cc-mod on`), and `off` keeps the marketplace while it is on.
set -euo pipefail
# How it works (not printed by --help):
# A registration from another install's folder is never changed unasked: `on` names that install, and only on a
# terminal asks to switch it. $THIMBLE_HOME/plugin.json records the answer and what is registered, for install.sh, which
# sources this file for its --plugin and --no-plugin flags, and for `thimble uninstall`, which removes only what it names.
# When sourced, the caller defines the output functions (say, run, ok, warn, note) and the variables dir, home, tmp,
# dry, have_claude, mp_name and version; run as a script, plugin_main sets them up.

plugin_regs() {  # the thimble plugins Claude Code lists, a line each: ours or other, the marketplace, and the folder that
  # marketplace was added from (else what its source is). Only a marketplace added from this install's folder is ours.
  # Also a line "mod", the marketplace and the folder, for each folder where thimble-cc-mod from ours is on.
  # Fails when the lists can't be read
  [ "$have_claude" = 1 ] && command -v python3 >/dev/null 2>&1 || return 1
  claude plugin list --json > "$tmp/plugins.json" 2>/dev/null || return 1
  claude plugin marketplace list --json > "$tmp/markets.json" 2>/dev/null || return 1
  python3 -I - "$tmp/plugins.json" "$tmp/markets.json" "$dir" <<'PY'
import json, os, sys


def rows(path):
    data = json.load(open(path, encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit(1)
    return [r for r in data if isinstance(r, dict)]


plugins, markets = rows(sys.argv[1]), rows(sys.argv[2])
where = {}
for m in markets:
    src = m.get("source")
    kind, path = (src.get("source"), src.get("path")) if isinstance(src, dict) else (src, m.get("path"))
    if kind == "directory" and isinstance(path, str) and path:
        where[m.get("name")] = os.path.realpath(path)
    else:
        where[m.get("name")] = " ".join(str(v) for v in (kind, m.get("repo") or m.get("url")) if v) or "an unknown source"
mine = os.path.realpath(sys.argv[3])
for p in plugins:
    name, _, market = str(p.get("id", "")).partition("@")
    if name == "thimble" and market:
        w = where.get(market, "a marketplace Claude Code does not list")
        print("ours" if w == mine else "other", market, w, sep="\t")
    elif name == "thimble-cc-mod" and market and where.get(market) == mine:
        print("mod", market, p.get("projectPath") or "a folder", sep="\t")
PY
}

plugin_record() {  # the earlier answer ($home/plugin.json) and the thimble plugins Claude Code has: plugin_reg, the
  # marketplace of the one added from this install's folder, the only registration changed unasked; other_reg and
  # other_from, one added from anywhere else, which is another install's. Without the record, this install's own
  # registration counts as an earlier yes. When Claude Code's lists can't be read, plugin_kept is the registration the
  # record names, which is then left as it is, and plugin_known=0. mod_in: the folders where thimble-cc-mod from this
  # install's marketplace is on, which a `claude plugin marketplace remove` would turn it off in
  plugin_prev="" plugin_reg="" plugin_kept="" other_reg="" other_from="" mod_in="" plugin_known=1
  local regs kind m w
  [ ! -f "$home/plugin.json" ] || plugin_prev="$(json_get "$home/plugin.json" answer)"
  if regs="$(plugin_regs)"; then
    while IFS=$'\t' read -r kind m w; do
      if [ "$kind" = mod ]; then mod_in="${mod_in:+$mod_in, }$w"
      elif [ "$kind" = ours ]; then plugin_reg="$m"
      elif [ "$kind" = other ] && [ -z "$other_reg" ]; then other_reg="$m" other_from="$w"; fi
    done <<< "$regs"
    [ -f "$home/plugin.json" ] || [ -z "$plugin_reg" ] || plugin_prev=yes
  else
    plugin_known=0
    [ ! -f "$home/plugin.json" ] || plugin_kept="$(json_get "$home/plugin.json" registered)"
  fi
}

other_plugin() {  # the line naming another install's thimble plugin
  printf '%s\n' "Claude Code's thimble plugin is another install's: thimble@$other_reg, from $other_from."
}

plugin_listed() {  # the version of thimble@$mp_name that Claude Code lists, or nothing
  command -v python3 >/dev/null 2>&1 || return 0
  claude plugin list --json 2>/dev/null | python3 -I -c 'import json, sys
try:
    rows = json.load(sys.stdin)
except ValueError:
    rows = []
print(next((r.get("version") or "" for r in rows if isinstance(r, dict) and r.get("id") == sys.argv[1]), ""))' "thimble@$mp_name" || true
}

plugin_write() {  # plugin_write ANSWER REGISTERED: $home/plugin.json
  say "+ record in $home/plugin.json: answer $1${2:+, registered thimble@$2}"
  [ "$dry" = 1 ] || { mkdir -p "$home"; printf '{"answer": "%s", "registered": "%s"}\n' "$1" "$2" > "$home/plugin.json"; }
}

PLUGIN_ON="thimble plugin on"
PLUGIN_OFF="thimble plugin off"

plugin_apply() {  # plugin_apply ANSWER: yes registers the tree as a marketplace and installs thimble from it at user
  # scope, then updates both, so a re-run refreshes Claude Code's cached copy; no takes back what an earlier yes
  # registered; "" (no answer) changes nothing. plugin_switch=yes allows taking out another install's registration
  # first. One line says what is so now (ok or warn); returns 1 when a yes could not be carried out
  local answer="$1" left="" other=""
  if [ -n "$other_reg" ] && [ "${plugin_switch:-}" != yes ]; then
    other="another install's thimble, thimble@$other_reg from $(tilde "$other_from"), is in every Claude Code session; left as it is"
    if [ "$answer" = yes ] && [ -z "$plugin_reg" ]; then
      warn "$other"
      note "to use this install's instead: claude plugin uninstall thimble@$other_reg && claude plugin marketplace remove $other_reg, then $PLUGIN_ON"
      plugin_write yes ""
      return 1
    fi
  fi
  if [ "$answer" = yes ] && [ "$have_claude" = 1 ] && [ "$plugin_reg" = "$mp_name" ] && [ "$(plugin_listed)" = "$version" ]; then
    ok "thimble is in every Claude Code session ($PLUGIN_OFF takes it out)"
    return 0
  fi
  if [ "$answer" = yes ] && [ "$have_claude" = 1 ]; then
    if [ -n "$plugin_reg" ] && [ "$plugin_reg" != "$mp_name" ]; then  # this folder, registered under another name
      { run claude plugin uninstall "thimble@$plugin_reg" && run claude plugin marketplace remove "$plugin_reg"; } \
        || say "(thimble@$plugin_reg, which an earlier install registered, is still there: claude plugin uninstall thimble@$plugin_reg && claude plugin marketplace remove $plugin_reg takes it back)"
    fi
    if [ "${plugin_switch:-}" = yes ] && [ -n "$other_reg" ] \
       && ! { run claude plugin uninstall "thimble@$other_reg" && run claude plugin marketplace remove "$other_reg"; }; then
      warn "thimble@$other_reg, from $(tilde "$other_from"), could not be taken out, so this install's plugin is not added beside it"
      plugin_write yes ""
      return 1
    fi
    if ! run claude plugin marketplace add "$dir"; then
      warn "could not register $dir as Claude Code's marketplace \"$mp_name\", so thimble is not in every session"
      note "a marketplace of that name may point elsewhere: claude plugin marketplace list, then claude plugin marketplace remove $mp_name (or install.sh --marketplace-name <other>)"
      return 1
    fi
    run claude plugin marketplace update "$mp_name" || say "(marketplace update failed; continuing)"
    if ! run claude plugin install --scope user "thimble@$mp_name"; then
      warn "claude plugin install thimble@$mp_name failed, so thimble is not in every session"
      return 1
    fi
    run claude plugin update --scope user "thimble@$mp_name" || say "(plugin update failed; the installed copy stays as it is)"
    plugin_write yes "$mp_name"
    ok "thimble is in every Claude Code session now: /thimble works in any claude session (in an open one, run /reload-plugins first). $PLUGIN_OFF takes it out"
    return 0
  fi
  if [ "$answer" = yes ]; then
    warn "no claude CLI, so thimble is not added to your Claude Code sessions; once Claude Code is installed, run: $PLUGIN_ON"
    return 1
  fi
  if [ -z "$answer" ]; then
    ok "Claude Code's plugins left as they are ($PLUGIN_ON adds thimble to every session)"
    return 0
  fi
  left="${plugin_reg:-$plugin_kept}"
  if [ -n "$plugin_reg" ] && [ -n "$mod_in" ]; then  # the marketplace stays: removing it turns thimble-cc-mod off too
    if run claude plugin uninstall "thimble@$plugin_reg"; then
      left=""
      note "kept marketplace \"$plugin_reg\", since thimble-cc-mod from it is on in $mod_in; thimble uninstall removes it"
    fi
  elif [ -n "$plugin_reg" ] && run claude plugin uninstall "thimble@$plugin_reg" && run claude plugin marketplace remove "$plugin_reg"; then left=""; fi
  plugin_write no "$left"
  if [ -n "$left" ]; then
    warn "thimble is still in every Claude Code session: claude plugin uninstall thimble@$left && claude plugin marketplace remove $left takes it out"
    return 1
  fi
  if [ -n "$other" ]; then warn "$other"; return 0; fi
  ok "thimble is not in your other Claude Code sessions: the thimble command loads it for its own ($PLUGIN_ON adds it to every session)"
}

plugin_status() {  # the line `thimble plugin status` prints
  if [ "$plugin_known" = 0 ]; then
    printf 'thimble plugin: unknown: Claude Code'"'"'s plugin list could not be read%s\n' "$( [ "$have_claude" = 1 ] || echo ' (no claude CLI)')"
  elif [ -n "$plugin_reg" ]; then
    printf 'thimble plugin: on: thimble@%s, from this install (%s), loads in every Claude Code session. `%s` takes it out.\n' "$plugin_reg" "$(tilde "$dir")" "$PLUGIN_OFF"
  elif [ -n "$other_reg" ]; then
    printf 'thimble plugin: another install'"'"'s: thimble@%s, from %s, loads in every Claude Code session. `%s` asks to switch it to this install.\n' "$other_reg" "$(tilde "$other_from")" "$PLUGIN_ON"
  else
    printf 'thimble plugin: off: sessions you start with `thimble` load it. `%s` adds it to every Claude Code session.\n' "$PLUGIN_ON"
  fi
}

plugin_main() {  # `thimble plugin on | off | status`
  local cmd="${1:-}" ans
  case "$cmd" in
    on | off | status) shift;;
    -h | --help | help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; return 0;;
    *) printf 'usage: thimble plugin on | off | status\n' >&2; return 2;;
  esac
  [ $# = 0 ] || { printf 'thimble plugin: unknown argument %s\n' "$1" >&2; return 2; }
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  home="${THIMBLE_HOME:-$HOME/.thimble}"
  dry=0 have_claude=0 plugin_switch=""
  ! command -v claude >/dev/null 2>&1 || have_claude=1
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mp_name="$(json_get "$dir/.claude-plugin/marketplace.json" name)"
  version="$(json_get "$dir/plugin/.claude-plugin/plugin.json" version)"
  [ -n "$mp_name" ] || { printf 'thimble plugin: %s names no marketplace\n' "$dir/.claude-plugin/marketplace.json" >&2; return 1; }
  plugin_record
  case "$cmd" in
    status) plugin_status; return 0;;
    off) plugin_apply no; return;;
  esac
  [ "$have_claude" = 1 ] || { printf 'thimble plugin: the claude CLI is not on PATH; install Claude Code, then run %s\n' "$PLUGIN_ON" >&2; return 1; }
  if [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
    if [ -t 0 ]; then
      printf '%s Switch it to this install (%s)? [y/N] ' "$(other_plugin)" "$dir"
      read -r ans || ans=""
      case "$ans" in y | Y | yes | YES | Yes) plugin_switch=yes;; esac
    fi
  fi
  plugin_apply yes
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # run as a script: lines for the terminal, and each claude command as it runs
  say()  { :; }
  ok()   { printf '✓ %s\n' "$*"; }
  warn() { printf '! %s\n' "$*"; }
  note() { printf '  %s\n' "$*"; }
  run()  { printf '+'; printf ' %q' "$@"; printf '\n'; "$@"; }
  tilde() { case "$1" in "$HOME"/*) printf '~%s\n' "${1#"$HOME"}";; *) printf '%s\n' "$1";; esac; }
  json_get() {  # json_get FILE KEY: a top-level string value (python3 when present, else a sed for the flat case)
    if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null
    else sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1; fi
  }
  plugin_main "$@"
fi
