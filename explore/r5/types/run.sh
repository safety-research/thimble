#!/usr/bin/env bash
# The checker's test: thimble-profile on each corpus of views round 5, with the types in this folder (written by hand,
# as main would write them), then the plain per-file profile. Outputs in OUT (default
# /mnt/store/scratch/rel/views-r5/checker-tests/out and out-plain).
#   explore/r5/types/run.sh [corpus ...]
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bin="$here/../../../plugin/bin/thimble-profile"
corpora=/mnt/store/scratch/rel/views-r5/corpora
out=${OUT:-/mnt/store/scratch/rel/views-r5/checker-tests}
for c in "${@:-pandas-swarm ml-tasks collusion-wiki rosetta pilot}"; do
  for k in $c; do
    (cd "$corpora/$k" && "$bin" types --out "$out/out/$k" < "$here/$k.ts" > /dev/null && \
      "$bin" files --out "$out/out-plain/$k" < /dev/null > /dev/null)
    echo "$k: $(head -1 "$out/out/$k/profile.txt") | $(head -1 "$out/out-plain/$k/profile.txt")"
  done
done
