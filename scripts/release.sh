#!/usr/bin/env bash
# scripts/release.sh — build the thimble release zip.
#
#   scripts/release.sh [--out DIR] [--dist DIR | --skip-frontend] [--marketplace-name NAME] [--repo OWNER/NAME]
#
# What it produces: <out>/thimble-<version>-<shortsha>.zip (default out: <repo>/release/, gitignored) whose single
# top-level folder thimble-<version>-<shortsha>/ holds exactly what an install needs and nothing else:
#   plugin/               the Claude Code plugin (skill, .mcp.json, bin/) — what the marketplace installs
#   backend/              the server (app/, tests_public/, pyproject.toml, uv.lock); never .venv or __pycache__
#   backend/requirements.txt  uv.lock's runtime packages with the hashes of their files (uv export), which install.sh
#                         installs with uv pip or pip from the package index the machine is set up with
#   prompts/              read by the server at run time (prompts.py)
#   frontend/dist/        the built UI (tsc --noEmit -p tsconfig.app.json + vite build here, or --dist DIR), served at /
#                         by the server when THIMBLE_DEV is off (main.py)
#   frontend/src/ public/ index.html package.json package-lock.json vite.config.ts tsconfig*.json
#                         the UI's source: every install carries the source so the dev agent works everywhere;
#                         with Node >= 20 install.sh installs its packages from package-lock.json (custom views need
#                         them) and builds dist when there is none. Never node_modules
#   frontend/runtime/     package.json and package-lock.json of the frontend packages the server and its scripts load
#                         (runtime_npm, below), cut from the frontend's own: what install.sh installs beside a built dist
#   .claude-plugin/       marketplace.json listing ./plugin, its name set to --marketplace-name (default thimble-local,
#                         so a zip install and the repo-as-marketplace "thimble" can coexist on one machine)
#   scripts/install.sh scripts/update.sh scripts/rebuild_ui.sh   what an install runs; scripts/dev/ never ships
#   scripts/view_shot.mjs the headless page of a view's checks (backend/app/views.py runs it)
#   scripts/ui_shot.mjs   the page screenshots of main's `screenshot` tool and of the dev agent (dev.py runs it)
#   README.md LICENSE INSTALL.md docs/config.md docs/assets/thimble-banner.svg   the readme, the Apache-2.0 license,
#                         the install guide, the config's reference it links and the banner the readme links; a link of
#                         these pages to a file the zip does not carry points at that file on GitHub, at the release's commit
#   THIRD_PARTY_NOTICES   the licenses of the npm packages and fonts frontend/dist bundles, which ask for their notices
#                         to travel with it; written by scripts/third_party_notices.py from frontend/node_modules, and
#                         only when the zip carries frontend/dist
#   RELEASE.json          {version, commit, date, dirty, frontend_dist, repo} — repo is the GitHub slug `thimble update`
#                         downloads from (--repo, else the `repository` of plugin/.claude-plugin/plugin.json)
# The zip is the only place the built UI is published: an install without Node uses the zip; a checkout builds the UI
# with Node >= 20 (scripts/install.sh).
# Never: data/, workspaces/, notes/, experiments/, context/, node_modules, .venv, .git, __pycache__ — a denylist check
# runs over the staged tree before zipping, then scripts/check_content.py (with gitleaks when it is installed).
# Beside the zip, <out>/SHA256SUMS lists its digest; upload both to the release, since `thimble update` checks one
# against the other.
#
# Files come from `git ls-files --cached` over the allowlist: the files in git's index, as the working tree holds them.
# An untracked file never ships; an uncommitted edit to a tracked file does, and RELEASE.json then says dirty.
# The version is plugin/.claude-plugin/plugin.json's — the one source; bump it for every release, or installed copies
# stay on their cached version (Claude Code updates a plugin only when its version string changes).
# Nothing here reads, asks for or stores a key: the release carries no credential of any kind.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="$repo/release"
dist=""
skip_frontend=0
mp_name="thimble-local"
gh_repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2;;
    --dist) dist="$2"; shift 2;;
    --skip-frontend) skip_frontend=1; shift;;
    --marketplace-name) mp_name="$2"; shift 2;;
    --repo) gh_repo="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "release.sh: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
done

die() { echo "release.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need git; need zip; need python3
# the frontend packages a release loads at run time: vega, vega-lite and vega-embed (a view page's libraries,
# backend/app/views.py LIBS, and a card's chart in its picture, tools.py VEGA_BUILDS), playwright (the headless page of
# scripts/view_shot.mjs and scripts/ui_shot.mjs) and the fonts view_shot.mjs gives a view's page
runtime_npm=(vega vega-lite vega-embed playwright @fontsource/geist-mono @fontsource/hanken-grotesk)

version="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/plugin/.claude-plugin/plugin.json")"
[ -n "$version" ] || die "plugin/.claude-plugin/plugin.json has no version"
sha="$(git -C "$repo" rev-parse --short HEAD)"
full_sha="$(git -C "$repo" rev-parse HEAD)"
allow=(plugin backend prompts .claude-plugin README.md INSTALL.md docs/config.md docs/assets/thimble-banner.svg LICENSE
       scripts/install.sh scripts/update.sh scripts/rebuild_ui.sh scripts/view_shot.mjs scripts/ui_shot.mjs
       frontend/src frontend/public frontend/index.html frontend/package.json
       frontend/package-lock.json frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json)
dirty=false
if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no -- "${allow[@]}" ':(exclude)backend/tests')" ]; then
  dirty=true
  echo "release.sh: tracked files the zip carries have uncommitted changes, which ship (RELEASE.json says dirty)" >&2
fi
date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
name="thimble-$version-$sha"
if [ -z "$gh_repo" ]; then  # plugin.json's `repository` (https://github.com/o/r), the one place that names the repo
  gh_repo="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("repository", ""))' \
    "$repo/plugin/.claude-plugin/plugin.json" | sed -e 's#^https\{0,1\}://github\.com/##' -e 's#\.git$##' -e 's#/$##')"
fi
[ -n "$gh_repo" ] || die "plugin/.claude-plugin/plugin.json has no repository; pass --repo OWNER/NAME"

# ---------------------------------------------------------------------------- frontend
src_dist=""
if [ -n "$dist" ]; then
  [ -f "$dist/index.html" ] || die "--dist $dist has no index.html"
  src_dist="$dist"
elif [ "$skip_frontend" = 1 ]; then
  echo "release.sh: --skip-frontend: the zip carries no frontend/dist" >&2
else
  need node; need npm
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "$major" -ge 20 ] || die "node >= 20 is required to build the frontend (found $(node -v)); or pass --dist DIR / --skip-frontend"
  # the app typecheck, then Vite bundles frontend/dist
  ( cd "$repo/frontend"
    [ -e node_modules ] || npm ci
    npx tsc --noEmit -p tsconfig.app.json
    npx vite build ) >&2
  [ -f "$repo/frontend/dist/index.html" ] || die "frontend build produced no frontend/dist/index.html"
  src_dist="$repo/frontend/dist"
fi

# ---------------------------------------------------------------------------- stage
stage_root="$(mktemp -d)"
trap 'rm -rf "$stage_root"' EXIT
stage="$stage_root/$name"
mkdir -p "$stage"
# backend/tests, where present, is not part of an install
git -C "$repo" ls-files -z --cached -- "${allow[@]}" ':(exclude)backend/tests' |
while IFS= read -r -d '' f; do
  [ -f "$repo/$f" ] || continue  # tracked but deleted in the working tree
  mkdir -p "$stage/$(dirname "$f")"
  cp -p "$repo/$f" "$stage/$f"
done
if [ -n "$src_dist" ]; then
  mkdir -p "$stage/frontend"
  cp -R "$src_dist" "$stage/frontend/dist"
  # the notices need the license texts the packages ship, which only node_modules holds
  [ -d "$repo/frontend/node_modules" ] || die "frontend/node_modules is missing, and THIRD_PARTY_NOTICES needs the license texts it holds: run npm ci in frontend/"
  python3 -I "$repo/scripts/third_party_notices.py" --root "$repo" --out "$stage/THIRD_PARTY_NOTICES" >&2
fi
if [ -f "$stage/backend/uv.lock" ]; then
  need uv
  (cd "$stage/backend" && uv export --frozen --no-dev --no-emit-project --quiet) > "$stage/backend/requirements.txt"
fi
if [ -f "$stage/frontend/package-lock.json" ]; then
  python3 -I - "$stage/frontend" "${runtime_npm[@]}" <<'PY' || die "frontend/runtime could not be cut from frontend/package-lock.json (above)"
import json, os, sys

fe, names = sys.argv[1], sys.argv[2:]
pkg = json.load(open(os.path.join(fe, "package.json")))
entries = json.load(open(os.path.join(fe, "package-lock.json")))["packages"]
ranges = {**pkg.get("devDependencies", {}), **pkg.get("dependencies", {})}


def find(at, name):
    """The lock entry Node resolves `name` to from the package at `at`: its own node_modules, then each one above."""
    while True:
        path = f"{at}/node_modules/{name}" if at else f"node_modules/{name}"
        if path in entries:
            return path
        if not at:
            return None
        at = at[:at.rfind("/node_modules/")] if "/node_modules/" in at else ""


keep, todo = {}, [f"node_modules/{n}" for n in names]
while todo:
    path = todo.pop()
    if path in keep:
        continue
    entry = dict(entries[path])
    # the registry npm is set up with serves each file; dev flags would leave packages out of the install
    for key in ("resolved", "dev", "devOptional"):
        entry.pop(key, None)
    if entries[path].get("devOptional"):
        entry["optional"] = True
    keep[path] = entry
    optional = {**entry.get("optionalDependencies", {}),
                **{d: 1 for d, m in entry.get("peerDependenciesMeta", {}).items() if m.get("optional")}}
    for field in ("dependencies", "optionalDependencies", "peerDependencies"):
        for dep in entry.get(field, {}):
            hit = find(path, dep)
            if hit:
                todo.append(hit)
            elif dep not in optional:
                sys.exit(f"{path} needs {dep}, which frontend/package-lock.json does not hold")
root = {"name": "thimble-runtime", "private": True, "dependencies": {n: ranges[n] for n in names}}
os.makedirs(os.path.join(fe, "runtime"), exist_ok=True)
with open(os.path.join(fe, "runtime", "package.json"), "w") as f:
    f.write(json.dumps(root, indent=2) + "\n")
with open(os.path.join(fe, "runtime", "package-lock.json"), "w") as f:
    f.write(json.dumps({"name": root["name"], "lockfileVersion": 3, "requires": True,
                        "packages": {"": root, **dict(sorted(keep.items()))}}, indent=2) + "\n")
PY
fi
python3 -I - "$stage/.claude-plugin/marketplace.json" "$mp_name" <<'PY'
import json, sys
p, name = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["name"] = name
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY
# the pages' links to files the zip does not carry (CLAUDE.md, docs/) go to GitHub, so none is broken in an install
python3 -I - "$stage" "$gh_repo" "$full_sha" <<'PY'
import os, re, sys
stage, repo, sha = sys.argv[1:]
for rel in ("README.md", "INSTALL.md", "docs/config.md"):
    p = os.path.join(stage, rel)
    if not os.path.isfile(p):
        continue
    here = os.path.dirname(rel)
    text = open(p, encoding="utf-8").read()
    def fix(m):
        target = m.group(2)
        path = target.split("#", 1)[0]
        if not path or re.match(r"^[a-z][a-z0-9+.-]*:", target) or os.path.exists(os.path.join(stage, here, path)):
            return m.group(0)
        whole = os.path.normpath(os.path.join(here, target)).replace(os.sep, "/")
        return f"{m.group(1)}https://github.com/{repo}/blob/{sha}/{whole})"
    open(p, "w", encoding="utf-8").write(re.sub(r"(\]\()([^)\s]+)\)", fix, text))
PY
python3 -I - "$stage/RELEASE.json" "$version" "$sha" "$full_sha" "$date" "$dirty" "$([ -n "$src_dist" ] && echo true || echo false)" "$gh_repo" <<'PY'
import json, sys
p, version, sha, full, date, dirty, fd, gh_repo = sys.argv[1:]
json.dump({"version": version, "commit": sha, "commit_full": full, "date": date,
           "dirty": dirty == "true", "frontend_dist": fd == "true", "repo": gh_repo}, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY

# the denylist, over the staged tree (the test repeats it over the zip)
bad="$(cd "$stage" && find . \( -name node_modules -o -name .venv -o -name __pycache__ -o -name .git -o -name '*.pyc' \
        -o -name .pytest_cache -o -path './data' -o -path './workspaces' -o -path './experiments' \
        -o -path './context' -o -path './notes' -o -path './frontend/node_modules' -o -name '*.tsbuildinfo' \) -print | head -5)"
[ -z "$bad" ] || die "staged tree contains denied paths:
$bad"
for top in "$stage"/* "$stage"/.[!.]*; do
  [ -e "$top" ] || continue
  case "$(basename "$top")" in
    plugin | backend | prompts | frontend | scripts | .claude-plugin | README.md | INSTALL.md | docs | LICENSE | \
      THIRD_PARTY_NOTICES | RELEASE.json) ;;
    *) die "unexpected top-level entry in the staged tree: $(basename "$top")";;
  esac
done
content_args=()
if ! command -v gitleaks >/dev/null 2>&1; then
  content_args=(--no-gitleaks)
  echo "release.sh: gitleaks is not installed, so the staged tree is checked without the secret scan" >&2
fi
python3 -I "$repo/scripts/check_content.py" "$stage" ${content_args[@]+"${content_args[@]}"} >&2 \
  || die "scripts/check_content.py found content that must not ship (above)"

# ---------------------------------------------------------------------------- zip
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
zip_path="$out/$name.zip"
rm -f "$zip_path"
( cd "$stage_root" && zip -q -r -X "$zip_path" "$name" )
if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum < "$zip_path" | cut -d' ' -f1)"
else digest="$(shasum -a 256 < "$zip_path" | cut -d' ' -f1)"; fi
printf '%s  %s\n' "$digest" "$name.zip" > "$out/SHA256SUMS"
files="$(unzip -Z1 "$zip_path" | grep -v '/$' | wc -l | tr -d ' ')"
size="$(du -h "$zip_path" | cut -f1 | tr -d ' ')"
echo "release: $zip_path ($size, $files files), its digest in $out/SHA256SUMS"
echo "version $version, commit $sha${dirty:+}$( [ "$dirty" = true ] && echo ' (dirty)' ), frontend/dist $( [ -n "$src_dist" ] && echo included || echo absent ), marketplace name $mp_name, repo $gh_repo"
