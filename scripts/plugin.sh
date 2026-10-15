#!/usr/bin/env bash
# scripts/plugin.sh — thimble's plugin in Claude Code: install.sh sources this file, and `thimble plugin status` runs it.
#
#   thimble plugin status      (or: bash scripts/plugin.sh status)
#
# install.sh adds thimble's plugin to Claude Code with Claude Code's own commands: it adds this install's folder as a
# marketplace (claude plugin marketplace add) and installs thimble from it at user scope (claude plugin install --scope
# user), so /thimble works in any claude session; a re-run updates it when its version changed. `status` says which
# thimble plugin Claude Code has, and whether it is on. /plugin in Claude Code turns it off or on.
set -euo pipefail
# How it works (not printed by --help):
# A thimble plugin from a marketplace added from another folder, or from GitHub, is another install's: install.sh never
# changes it, and prints the commands that switch it. $THIMBLE_HOME/plugin.json, which 0.7 kept for its plugin question,
# is removed once this install's plugin is in place, so that `thimble uninstall` goes by what Claude Code lists.
# When sourced, the caller defines the output functions (say, run, ok, warn, note) and the variables dir, home, tmp, dry,
# have_claude, mp_name and version; run as a script, plugin_main sets them up.

plugin_regs() {  # the thimble plugins Claude Code lists, a line each: ours or other, the marketplace, the folder that
  # marketplace was added from (else what its source is), on or off, and the version. Only a marketplace added from this
  # install's folder is ours; of several rows for one plugin, the user scope's comes first. Fails when the lists can't be
  # read
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
for p in sorted(plugins, key=lambda p: p.get("scope", "user") != "user"):
    name, _, market = str(p.get("id", "")).partition("@")
    if name == "thimble" and market:
        w = where.get(market, "a marketplace Claude Code does not list")
        on = "off" if p.get("enabled") is False else "on"
        print("ours" if w == mine else "other", market, w, on, str(p.get("version") or ""), sep="\t")
PY
}

plugin_record() {  # the thimble plugins Claude Code has: plugin_reg, the marketplace of the one added from this install's
  # folder, with plugin_on (on or off) and plugin_version; other_reg and other_from, one added from anywhere else, which
  # is another install's. plugin_known=0 when Claude Code's lists can't be read
  plugin_reg="" plugin_on="" plugin_version="" other_reg="" other_from="" plugin_known=1
  local regs kind m w on v
  if regs="$(plugin_regs)"; then
    while IFS=$'\t' read -r kind m w on v; do
      if [ "$kind" = ours ] && [ -z "$plugin_reg" ]; then plugin_reg="$m" plugin_on="$on" plugin_version="$v"
      elif [ "$kind" = other ] && [ -z "$other_reg" ]; then other_reg="$m" other_from="$w"; fi
    done <<< "$regs"
  else
    plugin_known=0
  fi
  return 0
}

plugin_switch_cmds() {  # the commands that take another install's thimble plugin out, so that install.sh adds this one
  printf '%s\n' "claude plugin uninstall thimble@$other_reg && claude plugin marketplace remove $other_reg, then bash $(tilde "$dir")/scripts/install.sh"
}

plugin_done() {  # this install's plugin is in place: plugin_ok=1, and 0.7's record of its plugin question goes
  plugin_ok=1
  [ -f "$home/plugin.json" ] || return 0
  say "+ rm -f $home/plugin.json"
  [ "$dry" = 1 ] || rm -f "$home/plugin.json"
}

plugin_apply() {  # thimble's plugin from this install's folder in Claude Code, at user scope: added (claude plugin
  # marketplace add, then claude plugin install), or updated when the version Claude Code has differs from this
  # install's, left on or off as the user set it. Another install's is left as it is, with the commands that switch it.
  # One line says what is so now (ok or warn); returns 1 when the plugin could not be added or updated
  if [ "$have_claude" != 1 ]; then
    warn "Claude Code is not installed, so thimble's plugin is not added to it"
    note "Install Claude Code (https://docs.anthropic.com/en/docs/claude-code), then in a shell: bash $(tilde "$dir")/scripts/install.sh"
    return 1
  fi
  if [ -n "$other_reg" ] && [ -z "$plugin_reg" ]; then
    warn "Claude Code has another install's thimble plugin, thimble@$other_reg from $(tilde "$other_from"), so this install's is not added"
    note "To use this install's plugin instead, in a shell: $(plugin_switch_cmds)"
    return 0
  fi
  if [ -n "$plugin_reg" ] && [ "$plugin_reg" != "$mp_name" ]; then  # this folder, added under another name before
    { run claude plugin uninstall "thimble@$plugin_reg" && run claude plugin marketplace remove "$plugin_reg"; } \
      || say "(thimble@$plugin_reg, which an earlier install added, is still there: claude plugin uninstall thimble@$plugin_reg && claude plugin marketplace remove $plugin_reg takes it out)"
    plugin_reg="" plugin_version=""
  fi
  local off=""
  [ "$plugin_on" != off ] || off="; it is off in Claude Code, and /plugin turns it on"
  if [ "$plugin_reg" = "$mp_name" ] && [ "$plugin_version" = "$version" ]; then
    say "Claude Code has thimble@$mp_name $version from this install already"
    ok "thimble's plugin in Claude Code is this install's (thimble@$mp_name $version)$off"
    plugin_done
    return 0
  fi
  if [ "$plugin_reg" = "$mp_name" ]; then
    run claude plugin marketplace update "$mp_name" || say "(marketplace update failed; the plugin update reads the folder anyway)"
    if ! run claude plugin update --scope user "thimble@$mp_name"; then
      tail_out
      warn "thimble's plugin in Claude Code could not be updated from ${plugin_version:-its version} to $version (above)"
      note "In a shell: claude plugin update --scope user thimble@$mp_name"
      return 1
    fi
    ok "Updated thimble's plugin in Claude Code to $version (thimble@$mp_name): a claude session uses it from its next start, or after /reload-plugins$off"
    plugin_done
    return 0
  fi
  if ! run claude plugin marketplace add "$dir"; then
    tail_out
    warn "Claude Code could not add $(tilde "$dir") as the marketplace \"$mp_name\" (above), so thimble's plugin is not added"
    note "A marketplace of that name may come from elsewhere: claude plugin marketplace list shows it, and claude plugin marketplace remove $mp_name takes it out; or run install.sh with --marketplace-name <another name>. Managed settings can also limit the marketplaces you may add."
    return 1
  fi
  if ! run claude plugin install --scope user "thimble@$mp_name"; then
    tail_out
    warn "Claude Code could not install thimble@$mp_name (above), so thimble's plugin is not added"
    note "In a shell: claude plugin install --scope user thimble@$mp_name"
    return 1
  fi
  ok "Added thimble's plugin to Claude Code (thimble@$mp_name): /thimble works in any claude session (in one open since before, run /reload-plugins first)"
  plugin_done
}

plugin_status() {  # the line `thimble plugin status` prints
  if [ "$plugin_known" = 0 ]; then
    printf 'thimble plugin: unknown: Claude Code'"'"'s plugin list could not be read%s\n' "$( [ "$have_claude" = 1 ] || echo ' (no claude CLI)')"
  elif [ -n "$plugin_reg" ]; then
    printf 'thimble plugin: %s: thimble@%s %s, from this install (%s). /plugin in Claude Code turns it off or on.%s\n' \
      "$plugin_on" "$plugin_reg" "$plugin_version" "$(tilde "$dir")" \
      "$( [ -z "$plugin_version" ] || [ "$plugin_version" = "$version" ] || printf ' This install is %s: claude plugin update --scope user thimble@%s updates it.' "$version" "$plugin_reg")"
  elif [ -n "$other_reg" ]; then
    printf 'thimble plugin: another install'"'"'s: thimble@%s, from %s. To use this install'"'"'s instead: %s\n' "$other_reg" "$(tilde "$other_from")" "$(plugin_switch_cmds)"
  else
    printf 'thimble plugin: not added: bash %s/scripts/install.sh adds it, or claude plugin marketplace add %s && claude plugin install --scope user thimble@%s\n' \
      "$(tilde "$dir")" "$(tilde "$dir")" "$mp_name"
  fi
}

plugin_main() {  # `thimble plugin status`; `on` and `off`, 0.7's, say what replaced them
  local cmd="${1:-}"
  case "$cmd" in
    status | on | off) shift;;
    -h | --help | help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; return 0;;
    *) printf 'usage: thimble plugin status\n' >&2; return 2;;
  esac
  [ $# = 0 ] || { printf 'thimble plugin: unknown argument %s\n' "$1" >&2; return 2; }
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  home="${THIMBLE_HOME:-$HOME/.thimble}"
  dry=0 have_claude=0
  ! command -v claude >/dev/null 2>&1 || have_claude=1
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mp_name="$(json_get "$dir/.claude-plugin/marketplace.json" name)"
  version="$(json_get "$dir/plugin/.claude-plugin/plugin.json" version)"
  [ -n "$mp_name" ] || { printf 'thimble plugin: %s names no marketplace\n' "$dir/.claude-plugin/marketplace.json" >&2; return 1; }
  plugin_record
  if [ "$cmd" != status ]; then
    printf 'thimble plugin %s was removed in 0.8.0: install.sh adds thimble'"'"'s plugin to Claude Code. To turn it off or on, use /plugin in Claude Code, or in a shell: claude plugin %s thimble@%s\n' \
      "$cmd" "$( [ "$cmd" = on ] && echo enable || echo disable )" "${plugin_reg:-${other_reg:-$mp_name}}"
    return 0
  fi
  plugin_status
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # run as a script: lines for the terminal
  say()  { :; }
  json_get() {  # json_get FILE KEY: a top-level string value (python3 when present, else a sed for the flat case)
    if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null
    else sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1; fi
  }
  tilde() { case "$1" in "$HOME"/*) printf '~%s\n' "${1#"$HOME"}";; *) printf '%s\n' "$1";; esac; }
  plugin_main "$@"
fi
