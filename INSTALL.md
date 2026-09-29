# Installing thimble

thimble uses whichever auth path you have configured for `claude`: every model call runs through your own `claude`, in
your config dir with your user settings (thimble's sessions run in folders of their own, so auth set only in a
project's `.claude/` settings does not reach them). thimble tells you when `claude` is missing or not logged in.

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

A clone, installed in place with the backend's test tools:

```bash
git clone https://github.com/safety-research/thimble.git
cd thimble
bash scripts/install.sh
```

Either install links the `thimble` command into `~/.local/bin` (and prints the line to add to your shell startup file
when that folder is not on your PATH) and runs `thimble doctor`. It asks once whether to add thimble to
`~/.claude/settings.json` and `~/.claude/plugins`, so it is available in every `claude` session from startup (the
`thimble` command works either way), and whether to trust thimble's workspaces folder by adding it to `~/.claude.json`,
so thimble can start its background agents without Claude Code stopping to ask (with a no, only Terminal-first mode's
background agents are refused, with a message saying how to trust the folder). `--plugin`, `--no-plugin`,
`--trust-workspaces` and `--no-trust-workspaces` answer without asking. Later, `thimble trust` asks the trust question
again and `thimble trust --remove` takes the entry back. `install.sh --dry-run` prints every step and changes nothing.

## Package mirrors and your own Python

A Global install uses the package indexes your machine is set up with. It installs the backend's packages with `uv pip`
from uv's index (`UV_DEFAULT_INDEX`, `uv.toml`), or with pip where pip has an index (`PIP_INDEX_URL`, `pip.conf`) and
uv has none. Of the frontend's packages it installs only the few thimble loads at run time, with npm from its registry.
All are pinned with their hashes. When the index lacks a pinned version, install.sh says so and installs versions within
the ranges thimble allows; a file whose hash differs from the pinned one stops the install. A Dev install uses
`uv sync` and `npm ci`.

To use a Python environment you prepared, run `bash scripts/install.sh --python <venv>/bin/python`. install.sh checks
that it holds the packages `backend/pyproject.toml` asks for at versions it allows, links `backend/.venv` to it and
installs nothing into it. Updates keep the link and check it again. To go back to thimble's own environment, delete the
link and run install.sh again.

## Update

`thimble update` installs the latest release; in a Dev install it runs `git pull --ff-only` and the install steps,
which reinstall the frontend's packages when `package-lock.json` changed and rebuild the UI when its sources did.
`thimble update --from <zip>` installs a zip you downloaded, checked against the release's `SHA256SUMS` when that
file is beside it. A zip whose digest does not match is refused. Workspaces are kept. A running server keeps the old code
until `thimble server restart`.

## Uninstall

`thimble uninstall` asks, then removes the plugin registration and the trust entry the install added,
`~/.local/bin/thimble`, and `~/.thimble`, which holds a Global install's workspaces. `--keep-home` keeps `~/.thimble`.
A clone stays where it is.

To delete one workspace and keep the install, `thimble list` shows the workspaces by id and `thimble purge <id>` deletes
that one and prints each path it deleted. The folder it read and your Claude Code transcripts stay.

## Troubleshooting

- `thimble doctor` shows the server, the versions, the auth path and the log's recent errors.
- Cards are not checked, views are checked without loading their page, or screenshots are unavailable: the headless
  Chromium was not fetched at install, or the machine lacks its system libraries. thimble never fetches it by itself;
  `thimble doctor` names the commands that do. Run them, then `thimble restart`.
- `/thimble` is not recognised in a `claude` session: it works there only after `install.sh --plugin`; then run
  `/reload-plugins`, or start a new session.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
