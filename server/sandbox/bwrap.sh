#!/bin/sh
# bubblewrap as srt runs it on Linux (sandbox.rules names this file as srt's bwrapPath), with two more rules just
# before the command:
#   --unshare-ipc             System V shared memory and semaphores of its own: the command cannot attach to another
#                             program's (srt leaves this namespace shared);
#   --tmpfs /tmp/claude       an empty folder over srt's own temp folder, which srt shows, writable, whenever it
#                             exists on the machine.
# The command's /tmp is empty and its own (srt hides every top folder), so /tmp/claude is always an empty folder there.
# Exits 3, running nothing, when the arguments have no `--` before the command.
n=$#
found=
while [ "$n" -gt 0 ]; do
  a=$1
  shift
  n=$((n - 1))
  if [ -z "$found" ] && [ "$a" = "--" ]; then
    set -- "$@" --unshare-ipc --tmpfs /tmp/claude
    found=1
  fi
  set -- "$@" "$a"
done
if [ -z "$found" ]; then
  echo "thimble browser: srt ran bubblewrap with no command" >&2
  exit 3
fi
exec bwrap "$@"
