#!/usr/bin/env bash
# release-file.sh TAG [DIR]: the file a release of thimble has attached, built from its tag: thimble-X.Y.Z.tar.gz (git
# archive of the tag, under the folder thimble-X.Y.Z) and SHA256SUMS (its sha256, as sha256sum writes it), in DIR (dist/
# by default). The install and thimble update download that file and check it against SHA256SUMS; GitHub counts its
# downloads. The release's GitHub Action (.github/workflows/release-file.yml) runs this script, and so do thimble's tests,
# so that the file has one build. Run it in a clone that has the tag (CONTRIBUTING.md, Releasing thimble).
set -euo pipefail

stop() { printf 'release-file.sh: %s\n' "$*" >&2; exit 2; }

tag="${1:-}" dir="${2:-dist}"
case "$tag" in v[0-9]*) ;; *) stop "the first argument is a release's tag, such as v0.10.13" ;; esac
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || stop "there is no tag $tag here"
# the install refuses a file that holds a link, so the build stops first
if git ls-tree -r "$tag" | awk '$1 == "120000" || $1 == "160000" { found = 1 } END { exit !found }'; then
  stop "$tag holds a symbolic link or a submodule, which the install refuses"
fi
name="thimble-${tag#v}"
mkdir -p "$dir"
git archive --format=tar.gz --prefix="$name/" -o "$dir/$name.tar.gz" "$tag"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dir" && sha256sum "$name.tar.gz") >"$dir/SHA256SUMS"
else
  (cd "$dir" && shasum -a 256 "$name.tar.gz") >"$dir/SHA256SUMS"
fi
printf '%s\n' "$dir/$name.tar.gz" "$dir/SHA256SUMS"
