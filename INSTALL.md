# Installing thimble

thimble uses whichever auth path you have configured for `claude`: every model call runs through your own `claude`, in
your config dir with your settings. thimble tells you when `claude` is missing or not logged in.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.281), logged in (`claude auth status`).
- macOS or Linux, and Python 3.12+. [uv](https://docs.astral.sh/uv/getting-started/installation/) is recommended: it
  installs the pinned versions and fetches Python when the machine has none.
- Node 20+ for a Dev install and for custom views.

## Global install (recommended)

The latest release, copied into `~/.thimble/app` (`$THIMBLE_HOME/app` when `THIMBLE_HOME` is set).

1. Download `thimble-<version>-<sha>.zip` from the [latest release](https://github.com/safety-research/thimble/releases/latest),
   or run `gh release download --repo safety-research/thimble --pattern 'thimble-*.zip'`.
2. Unzip it and run `bash scripts/install.sh` inside the unzipped folder.

## Dev install

A clone, installed in place:

```bash
git clone https://github.com/safety-research/thimble.git
cd thimble
bash scripts/install.sh
```

Either install registers the plugin with Claude Code, links the `thimble` command into `~/.local/bin` (and prints the
line to add to your shell startup file when that folder is not on your PATH), and runs `thimble doctor`. It asks once
whether to mark thimble's workspaces folder trusted in Claude Code's config, which Terminal-first's background sessions
need; `--trust-workspaces` or `--no-trust-workspaces` answers without asking. `install.sh --dry-run` prints every step
and changes nothing.

## Update

`thimble update` installs the latest release; in a Dev install it runs `git pull --ff-only` and the install steps,
which reinstall the frontend's packages when `package-lock.json` changed and rebuild the UI when its sources did.
`thimble update --from <zip>` installs a zip you downloaded, checked against the release's `SHA256SUMS` when that
file is beside it. A zip whose digest does not match is refused. Workspaces are kept. A running server keeps the old code
until `thimble server restart`.

## Uninstall

`thimble uninstall` asks, then removes the plugin registration, `~/.local/bin/thimble`, the trust entry the install
added, and `~/.thimble`, which holds a Global install's workspaces. `--keep-home` keeps `~/.thimble`. A clone stays where
it is.

To delete one workspace and keep the install, `thimble list` shows the workspaces by id and `thimble purge <id>` deletes
that one and prints each path it deleted. The folder it read and your Claude Code transcripts stay.

## Troubleshooting

- `thimble doctor` shows the server, the versions, the auth path and the log's recent errors.
- `/thimble` is not recognised right after an install: run `/reload-plugins`, or start a new session.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
