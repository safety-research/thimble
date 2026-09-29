# Installing thimble

thimble uses whichever auth path you have configured for `claude`: every model call runs through your own `claude`, in
your config dir with your user settings (thimble's sessions run in folders of their own, so auth set only in a
project's `.claude/` settings does not reach them). thimble tells you when `claude` is missing or not logged in.

What thimble's agents may do, and on which models, is set in `~/.thimble/config.json`: [docs/config.md](docs/config.md).
Card code runs in the notebook kernel with your user's access and network, whatever that file says.

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
when that folder is not on your PATH) and runs `thimble doctor`. Before it installs anything, it shows what it installs
and where, then asks three questions:

- **A browser for screenshots.** thimble checks the cards and views it draws in screenshots, and repairs graphics that
  look wrong. It uses the Chrome or Edge on your machine (no download), Playwright's headless Chromium (a download of
  about 210 MB that takes 650 MB on disk), or none, which means no screenshot checks: no self-repair of graphics and no view review.
  `--browser system`, `--browser bundled` or `--browser off` answers it.
- **thimble in every Claude Code session.** A yes adds thimble to `~/.claude/settings.json` and `~/.claude/plugins`.
  The `thimble` command works either way. `--plugin` or `--no-plugin` answers it.
- **Trust of thimble's workspaces folder**, where thimble keeps each workspace and runs its agents. A yes adds it to
  `~/.claude.json`. With a no, the orientation, its critic and the writers run as `claude -p` sessions and don't show
  in your terminal's agent tray. `--trust-workspaces` or `--no-trust-workspaces` answers it.

Without a terminal, a question no flag answers gets a no. Answers are kept, so an update doesn't ask again. To change
one, run install.sh again with its flag; it skips the steps that are done. `install.sh --dry-run` prints the questions
and every step, and changes nothing.

## Package mirrors and your own Python

A Global install uses the package indexes your machine is set up with. It installs the backend's packages with `uv pip`
from uv's index (`UV_DEFAULT_INDEX`, `uv.toml`), or with pip where pip has an index (`PIP_INDEX_URL`, `pip.conf`) and
uv has none. Of the frontend's packages it installs only the few thimble loads at run time, with npm from its registry.
All are pinned with their hashes. When the index lacks a pinned version, install.sh says so and installs versions within
the ranges thimble allows; a file whose hash differs from the pinned one stops the install, from either index. A Dev
install uses `uv sync` and `npm ci`.

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
A clone stays where it is, and so does a downloaded headless Chromium, in Playwright's cache folder.

To delete one workspace and keep the install, `thimble list` shows the workspaces by id and `thimble purge <id>` deletes
that one and prints each path it deleted. The folder it read and your Claude Code transcripts stay.

## Troubleshooting

- `thimble doctor` shows the server, the versions, the auth path and the log's recent errors.
- Cards are not checked, views are checked without loading their page, or screenshots are unavailable: there is no
  browser (the install's answer, or no Chrome or Edge found), or the machine lacks the headless Chromium's system
  libraries. thimble never downloads a browser by itself. `install.sh --browser system` or `--browser bundled` sets one
  up, and `thimble doctor` names the command for missing libraries. Then run `thimble restart`.
- `/thimble` is not recognised in a `claude` session: it works there only after `install.sh --plugin`; then run
  `/reload-plugins`, or start a new session.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
