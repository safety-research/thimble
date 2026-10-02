# Installing thimble

thimble uses whichever auth path you have configured for `claude`: every model call runs through your own `claude`, in
your config dir with your user settings (thimble's sessions run in folders of their own, so auth set only in a
project's `.claude/` settings does not reach them). thimble tells you when `claude` is missing or not logged in.

What thimble's agents may do, and on which models, is set in `~/.thimble/config.json`: [docs/config.md](docs/config.md).
Card code runs in the notebook kernel with your network, whatever that file says. The kernel runs in Anthropic's sandbox
runtime, which the install sets up with the frontend's packages: it sees only the corpus and the workspace. Without Node
it runs in bubblewrap on Linux and with your user's access on macOS.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.281), logged in (`claude auth status`).
- macOS or Linux, and Python 3.12+. [uv](https://docs.astral.sh/uv/getting-started/installation/) is recommended: it
  installs the pinned versions and fetches Python when the machine has none.
- Node 20+ for custom views and for the sandbox card code and code tickets run in; a Dev install needs 20.19+, 22.13+ or 24+, which the frontend's tests need.

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
when that folder is not on your PATH) and runs `thimble doctor`. A `thimble` command or Claude Code plugin that another
thimble install set up stays as it is unless you agree, on a terminal, to switch it. Before it installs anything, it
shows what it installs and where, then asks its questions:

- **A browser for screenshots.** thimble takes screenshots of the cards and views it draws, to check and improve them.
  For the best experience, download Playwright's headless Chromium (about 210 MB, 650 MB on disk). With a no, thimble
  uses the Chrome or Edge on your machine, which install.sh test-launches, since a policy can block automation. With
  neither, thimble can't check and improve its cards and views. `--browser bundled`, `--browser system` or
  `--browser off` answers it.
- **The sandbox's system packages** (Linux, when they are missing). thimble's agents run their Bash only in Claude
  Code's sandbox, which needs bubblewrap and socat, and on Ubuntu 23.10 or later an AppArmor profile for bwrap. A yes
  installs them with sudo and your package manager (apt, dnf or pacman). With a no, thimble's agents won't run until
  the sandbox works; run install.sh again to set it up. `--sandbox-deps` or `--no-sandbox-deps` answers it. macOS has
  the sandbox built in.
- **thimble in every Claude Code session.** A yes adds thimble to `~/.claude/settings.json` and `~/.claude/plugins`.
  The `thimble` command works either way. `--plugin` or `--no-plugin` answers it.
- **Trust of thimble's workspaces folder**, where thimble keeps each workspace and runs its agents. A yes adds it to
  `~/.claude.json`. The orientation, its critic, the writers and view builds need it: they run as Claude Code
  background agents, which Claude Code starts only in a trusted folder. `--trust-workspaces` or `--no-trust-workspaces` answers it.

Without a terminal, install.sh runs only when every question it would ask has its flag, and otherwise lists the
missing ones; a system Chrome or Edge it finds is used without asking. The browser, plugin and trust answers are kept,
so an update doesn't ask them again, and `thimble update` passes the same flags on. To change an answer, run
install.sh again with its flag; it skips the steps that are done. `install.sh --dry-run` prints the questions and
every step, and changes nothing.

## Package mirrors and your own Python

A Global install uses the package indexes your machine is set up with. It installs the backend's packages with `uv pip`
from uv's index (`UV_DEFAULT_INDEX`, `uv.toml`), or with pip where pip has an index (`PIP_INDEX_URL`, `pip.conf`) and uv
has none. Of the frontend's packages it installs only the few thimble loads at run time, with npm from its registry. All
are pinned with their hashes. When the index lacks a pinned version, install.sh installs the newest versions the index
has within the ranges thimble allows, and lists the packages that differ from the pinned versions. With uv it keeps
every other pin the index has and checks the index's hashes; otherwise nothing is checked against pinned hashes.
`--require-pinned` stops the install there instead. A file whose hash differs from the pinned one stops the install,
from either index. A Dev install uses `uv sync` and `npm ci`.

To use a Python environment you prepared, run `bash scripts/install.sh --python <venv>/bin/python`. install.sh checks
that it holds the packages `backend/pyproject.toml` asks for at versions it allows, links `backend/.venv` to it and
installs nothing into it. Updates keep the link and check it again. To go back to thimble's own environment, delete the
link and run install.sh again.

## Extensions

An extension adds views, card types, report types or changes to thimble's agents. Add a folder (used in place), a git
URL, or one thimble ships by name. Adding it switches it on:

```bash
thimble extension add swarm-orient     # checks it, lists what it adds and asks first; --yes for scripts
thimble extension off swarm-orient     # in every workspace; Settings > Extensions switches it for one workspace
thimble extension on swarm-orient
thimble extension list
thimble extension remove swarm-orient  # a folder used in place stays where it is
```

thimble ships three. `video`, the Video document with its video export, comes added. `swarm-orient` and
`multiagent-swimlane` are added with `thimble extension add`; Settings and `thimble extension list` name them until
then. One you remove stays removed. Its Python runs only in thimble's kernels. Its `extension.json` names the thimble
versions it works with and the Python packages and other extensions it needs: thimble installs no package, and while
one is missing, or thimble is outside that range, the extension stays unloaded and `thimble extension list`, `thimble
doctor` and Settings say why. `add` adds the extensions it needs that thimble ships on the same yes, and an extension
runs only where those run. Switching on one that adds to the orientation, where the orientation already ran, makes
Settings ask whether to run it now. To write your own, see [docs/extensions.md](docs/extensions.md).

Only its views check whether they fit: once per workspace, and again when their files change, a quick call to the
labels model reads the view's description and a few records of the files in its scope. Settings > Extensions shows each
view's reason, and its switch there overrides the check.

The views thimble builds for a workspace are that workspace's own extension, in `workspaces/<workspace>/extension/`.
No other workspace shows them. Settings > Extensions lists them under This workspace's views, each with its switch.

`swarm-orient` adds to the orientation for corpora where many agents act on shared pages and channels and address each
other. Many swarm-reader agents read every record, a label that fits the analyst's request marks each one, the counts
are checked, and the episodes are drawn as `multiagent-swimlane` cards, the card type that draws a swimlane of the
actions main chose. Test builds called it `swarm`: the commands still take that name for this release, and what was
set for it carries over.

## thimble-cc-mod

thimble-cc-mod is a single-agent thimble inside Claude Code, an exploration that ships with thimble as a second plugin
of its marketplace. Claude answers with cards drawn in the chat and citations you can check, with no server, browser or
background agents. Switch it on in a folder with `thimble cc-mod on`, which asks first, then writes the folder's
`.claude/settings.json` through `claude plugin`; then run `claude` there. `thimble cc-mod off` undoes it, and `thimble
cc-mod status` says whether each of the two plugins is on in the folder. They are switched independently: `on` and `off`
leave the thimble plugin as it is. Sessions you start with `thimble`, and thimble's background sessions (the
orientation, critic, writers, checks, task programs and builds), run without the mod; plain `claude` in the folder uses
it. To use it without installing thimble, see the [README](README.md#thimble-cc-mod).

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
- thimble's agents don't start because Claude Code's sandbox can't run: `thimble doctor` says what is missing, and on
  Linux `install.sh --sandbox-deps` installs it.
- An empty `.claude/.cc-writes/` folder appears in the folder you start `thimble` in: Claude Code's sandbox is on in
  your own settings, and it makes that folder for main's Bash, which runs in your session. thimble leaves your
  session's settings as they are, and `thimble doctor` says when that sandbox is on.
- thimble warns that Claude Code does not trust its workspaces folder: the orientation, its critic, the writers and
  view builds can't start until it does, while your own session keeps working. Run the command the warning gives,
  `bash <install dir>/scripts/install.sh --trust-workspaces`. Claude Code reads trust only up to the root of a git
  clone, so a trusted folder above a Dev install's clone doesn't count.
- Cards are not checked, views are checked without loading their page, or screenshots are unavailable: there is no
  browser (the install's answer, or no Chrome or Edge found), or the machine lacks the headless Chromium's system
  libraries. thimble never downloads a browser by itself. `install.sh --browser system` or `--browser bundled` sets one
  up, and `thimble doctor` names the command for missing libraries. Then run `thimble restart`.
- `/thimble` is not recognised in a `claude` session: it works there only after `install.sh --plugin`; then run
  `/reload-plugins`, or start a new session.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
