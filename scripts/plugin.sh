#!/usr/bin/env bash
# scripts/plugin.sh — thimble's plugin in Claude Code: install.sh sources this file, and `thimble plugin status` runs it.
#
#   thimble plugin status      (or: bash scripts/plugin.sh status)
#
# install.sh adds thimble's plugin to Claude Code with Claude Code's own commands: it adds this install's folder as a
# marketplace (claude plugin marketplace add) and installs thimble from it at user scope (claude plugin install --scope
# user), so thimble is on in every claude session; a re-run updates it when its version or its files changed. `status`
# says which thimble plugin Claude Code has, and whether it is on. /plugin in Claude Code turns it off or on.
set -euo pipefail
# How it works (not printed by --help):
# A thimble plugin from a marketplace added from another folder, or from GitHub, is another install's: install.sh never
# changes it, and prints the commands that switch it. $THIMBLE_HOME/plugin.json, which 0.7 kept for its plugin question,
# is removed once this install's plugin is in place, so that `thimble uninstall` goes by what Claude Code lists.
# Claude Code loads this install's plugin from one of two places, which `claude plugin list --json` names: the folder
# itself (readFromFolder, as Claude Code 2.1.299 to 2.1.302 do for a directory marketplace), whose edits a session takes
# at its next start or /reload-plugins; or its own copy (installPath), which `claude plugin update` makes again only for
# a new version. So while the version stays the same (a checkout between releases), install.sh compares the copy's files
# with plugin/'s and, when they differ, uninstalls and installs the plugin again, keeping its options and its on or off.
# When sourced, the caller defines the output functions (say, run, ok, warn, note) and the variables dir, home, tmp, dry,
# have_claude, mp_name and version, and src when the plugin to install is not yet in dir (a release before its copy);
# run as a script, plugin_main sets them up.

plugin_regs() {  # the thimble plugins Claude Code lists, a line each: ours or other, the marketplace, the folder that
  # marketplace was added from (else what its source is), on or off, the version, and for ours what Claude Code loads
  # (plugin_files). Only a marketplace added from this install's folder is ours; of several rows for one plugin, the
  # user scope's comes first. Fails when the lists can't be read
  [ "$have_claude" = 1 ] && command -v python3 >/dev/null 2>&1 || return 1
  claude plugin list --json > "$tmp/plugins.json" 2>/dev/null || return 1
  claude plugin marketplace list --json > "$tmp/markets.json" 2>/dev/null || return 1
  python3 -I - "$tmp/plugins.json" "$tmp/markets.json" "$dir" "${src:-$dir}/plugin" <<'PY'
import hashlib, json, os, sys

# what running or browsing a plugin copy adds to it, and what Claude Code's copy leaves out: backend/app/cli.py's
# COPY_IGNORED, COPY_LEFT_OUT and COPY_LEFT_OUT_SUFFIX (test_install_scripts.py keeps them the same)
COPY_IGNORED = ("__pycache__", ".DS_Store")
COPY_LEFT_OUT = ("hooks/tests", "hooks/term/tests", "hooks/term/types", "hooks/term/tsconfig.json", ".claude-plugin/types",
                 "tsconfig.json")
COPY_LEFT_OUT_SUFFIX = ".test.ts"


def rows(path):
    data = json.load(open(path, encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit(1)
    return [r for r in data if isinstance(r, dict)]


def files(root):
    """Each file under root that a copy keeps: its path → the SHA-256 of its bytes, and whether it is executable."""
    out = {}
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in COPY_IGNORED]
        for n in names:
            p = os.path.join(d, n)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if (n in COPY_IGNORED or n.endswith(".pyc") or rel.endswith(COPY_LEFT_OUT_SUFFIX) or not os.path.isfile(p)
                    or any(rel == x or rel.startswith(x + "/") for x in COPY_LEFT_OUT)):
                continue
            with open(p, "rb") as f:
                out[rel] = (hashlib.sha256(f.read()).hexdigest(), os.access(p, os.X_OK))
    return out


def loads(p, folder, new):
    """What Claude Code loads of plugin row p (the folder it reads in place, else its copy): inplace (this install's
    plugin folder itself), same or differs (a copy whose files equal those of the plugin to install, or not), or '' when
    the row names no place."""
    at = next((v for v in (p.get("readFromFolder"), p.get("installPath")) if isinstance(v, str) and v), "")
    if not at:
        return ""
    at = os.path.realpath(at)
    if at == folder:
        return "inplace"
    return "same" if os.path.isdir(at) and files(at) == files(new) else "differs"


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
        how = loads(p, os.path.realpath(os.path.join(mine, "plugin")), sys.argv[4]) if w == mine else ""
        print("ours" if w == mine else "other", market, w, on, str(p.get("version") or ""), how, sep="\t")
PY
}

plugin_record() {  # the thimble plugins Claude Code has: plugin_reg, the marketplace of the one added from this install's
  # folder, with plugin_on (on or off), plugin_version and plugin_files (what Claude Code loads: inplace, this install's
  # plugin/ itself; same or differs, its copy, whose files equal plugin/'s or not; '' when not known); other_reg and
  # other_from, one added from anywhere else, which is another install's. plugin_known=0 when Claude Code's lists can't
  # be read
  plugin_reg="" plugin_on="" plugin_version="" plugin_files="" other_reg="" other_from="" plugin_known=1
  local regs kind m w on v how
  if regs="$(plugin_regs)"; then
    while IFS=$'\t' read -r kind m w on v how; do
      if [ "$kind" = ours ] && [ -z "$plugin_reg" ]; then plugin_reg="$m" plugin_on="$on" plugin_version="$v" plugin_files="$how"
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

plugin_options() {  # the options of thimble's plugin that the user set (/config, /plugin), as the JSON object `claude
  # plugin configure --values-stdin` reads, or nothing when none is set; fails when Claude Code can't say
  claude plugin configure --json "thimble@$mp_name" > "$tmp/options.json" 2>/dev/null || return 1
  python3 -I -c 'import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
inputs, configured = d["inputs"], d["configured"]
if configured:
    print(json.dumps({k: inputs[k] for k in configured}))' "$tmp/options.json"
}

configure_from() { claude plugin configure --values-stdin "$2" < "$1"; }  # configure_from FILE ID: ID's options from FILE

plugin_reinstall() {  # this install's plugin, whose version Claude Code has but whose files differ from Claude Code's
  # copy, uninstalled and installed again with Claude Code's commands, so that Claude Code copies plugin/ anew (claude
  # plugin update keeps a copy of the same version as it is); the options the user set and its on or off are kept, and
  # its data folder (--keep-data). A warn line and 1 when that fails
  local id="thimble@$mp_name" opts="$tmp/plugin-options.json"
  if ! plugin_options > "$opts"; then
    warn "thimble's plugin in Claude Code ($id $version) differs from this install's, but Claude Code did not list its options, so it is not installed again"
    note "In a shell: claude plugin uninstall --keep-data --scope user $id && claude plugin install --scope user $id, then set its options again in /config"
    return 1
  fi
  if ! run claude plugin uninstall --keep-data --scope user "$id"; then
    tail_out
    warn "thimble's plugin in Claude Code ($id $version) differs from this install's, and could not be uninstalled to install it again (above)"
    note "In a shell: claude plugin uninstall --keep-data --scope user $id && claude plugin install --scope user $id"
    return 1
  fi
  if ! run claude plugin install --scope user "$id"; then
    tail_out
    warn "thimble's plugin was uninstalled from Claude Code to install it again, and could not be installed (above)"
    note "In a shell: claude plugin install --scope user $id$( [ ! -s "$opts" ] || printf ', then set its options again in /config: %s' "$(cat "$opts")")"
    return 1
  fi
  local word=""; [ ! -s "$opts" ] || { word="$(cat "$opts")"; word="'${word//\'/\'\\\'\'}'"; }  # as one shell word
  if [ -n "$word" ] && ! _run "+ claude plugin configure --values-stdin $id <<< $word" configure_from "$opts" "$id"; then
    tail_out
    warn "thimble's plugin was installed again, without the options you had set (above): set them again in /config: $(cat "$opts")"
  fi
  if [ "$plugin_on" = off ] && ! run claude plugin disable --scope user "$id"; then
    tail_out
    warn "thimble's plugin was installed again and is on, though you had turned it off (above): /plugin turns it off"
  fi
  return 0
}

plugin_apply() {  # thimble's plugin from this install's folder in Claude Code, at user scope: added (claude plugin
  # marketplace add, then claude plugin install), updated when the version Claude Code has differs from this install's,
  # or installed again when the version is the same but Claude Code loads a copy whose files differ (plugin_reinstall),
  # left on or off as the user set it. Another install's is left as it is, with the commands that switch it. One line
  # says what is so now (ok or warn), and whether a claude session open since before needs /reload-plugins; returns 1
  # when the plugin could not be added or updated
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
    case "$plugin_files" in
      inplace) ok "thimble's plugin in Claude Code is this install's (thimble@$mp_name $version), read from $(tilde "$dir")/plugin itself: nothing to update. A claude session open since before uses any changed files after /reload-plugins$off";;
      same) ok "thimble's plugin in Claude Code is this install's, unchanged (thimble@$mp_name $version): nothing to update$off";;
      differs)
        plugin_reinstall || return 1
        if [ "$dry" = 0 ] && plugin_record && [ "$plugin_files" = differs ]; then
          warn "thimble's plugin was installed in Claude Code again (thimble@$mp_name $version), and Claude Code's copy still differs from this install's"
          note "In a shell: claude plugin list --json shows the copy (installPath); claude plugin uninstall --keep-data --scope user thimble@$mp_name && claude plugin install --scope user thimble@$mp_name installs it again"
          return 1
        fi
        ok "Installed thimble's plugin in Claude Code again (thimble@$mp_name $version), since its files had changed: a claude session uses it from its next start, or after /reload-plugins$off";;
      *) say "Claude Code has thimble@$mp_name $version from this install already (claude plugin list --json names no folder or copy to compare)"
         ok "thimble's plugin in Claude Code is this install's (thimble@$mp_name $version)$off";;
    esac
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
  ok "Added thimble's plugin to Claude Code (thimble@$mp_name): thimble is on in every claude session (in one open since before, run /reload-plugins first)"
  plugin_done
}

plugin_status() {  # the line `thimble plugin status` prints
  if [ "$plugin_known" = 0 ]; then
    printf 'thimble plugin: unknown: Claude Code'"'"'s plugin list could not be read%s\n' "$( [ "$have_claude" = 1 ] || echo ' (no claude CLI)')"
  elif [ -n "$plugin_reg" ]; then
    printf 'thimble plugin: %s: thimble@%s %s, from this install (%s). /plugin in Claude Code turns it off or on.%s\n' \
      "$plugin_on" "$plugin_reg" "$plugin_version" "$(tilde "$dir")" \
      "$( if [ -n "$plugin_version" ] && [ "$plugin_version" != "$version" ]; then
            printf ' This install is %s: claude plugin update --scope user thimble@%s updates it.' "$version" "$plugin_reg"
          elif [ "$plugin_files" = differs ]; then
            printf ' Its files differ from this install'"'"'s: bash %s/scripts/install.sh installs it again.' "$(tilde "$dir")"
          fi )"
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
