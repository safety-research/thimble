# Installing thimble

> **Installing thimble for someone, as an agent?** Follow the Installing section of [CLAUDE.md](CLAUDE.md), which
> Claude Code loads only in a session started inside the clone: run `bash scripts/install.sh --dry-run`, ask the
> person each question it lists (often there are none), and pass the flag for each of their answers. Answer none of
> them yourself.

thimble uses whichever auth path you have configured for `claude`: every model call runs through your own `claude`, in
your config dir with your user settings. thimble's agents run as subagents of the session you start with `thimble`;
its single model calls (labels, card checks) and `thimble fix` run as `claude -p` jobs in folders of their own, so auth
set only in a project's `.claude/` settings does not reach them. thimble tells you when `claude` is missing or not
logged in.

What thimble's agents may do, and on which models, is set in `~/.thimble/config.json`: [docs/config.md](docs/config.md).
Card code runs in the notebook kernel with your network, whatever that file says. The kernel runs in Anthropic's sandbox
runtime, which the install sets up with the frontend's packages: it sees only the corpus and the workspace. Without Node
it runs in bubblewrap on Linux and with your user's access on macOS.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.291), logged in (`claude auth status`), with
  its hooks modules on, which thimble's agents need: managed settings with `disableAllHooks` or
  `allowManagedHooksOnly`, or a folder Claude Code doesn't trust, turn them off.
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

Either install links the `thimble` command into `~/.local/bin` and runs `thimble doctor`. While that folder is not on
your PATH, it adds a line that puts it there to your shell's startup file, so that a new terminal finds `thimble`:
`~/.zshrc` for zsh, `~/.bashrc` and the file a login shell reads for bash, `~/.config/fish/conf.d/thimble.fish` for fish,
`~/.profile` for sh. With a `THIMBLE_HOME` other than `~/.thimble`, a second line sets it. Each line ends with
`# added by thimble's installer`, goes in only once, and `thimble uninstall` removes exactly those lines.
`--no-modify-path` leaves the startup files alone, then and in later updates (`--modify-path` takes that back). A
`thimble` command or Claude Code plugin that another thimble install set up stays as it is unless you agree, on a
terminal, to switch it.

install.sh opens with one screen: what it found (Claude Code, Python or uv, Node, a browser, Claude Code's sandbox),
what it installs where and about how big, the line it adds to your shell's startup file, what it changes in your
Claude Code setup, and how many questions remain. Then it asks those, and prints a line per step: ✓ when the step is
done, ! when it needs you, with what fixes it under it. It ends with the command to run, and when the terminal you ran
it in started before the new line, the command that works in that terminal. Every command it runs, with its output,
goes to `~/.thimble/install.log`.

It asks a question only when this machine leaves it open, so often it asks none:

- **A browser for screenshots**, only when it finds no Chrome or Edge that starts under automation. thimble takes
  screenshots of the cards and views it draws, to check how they look. install.sh test-launches a Chrome or Edge it
  finds where Playwright looks (a policy can block automation), and uses one that starts, downloading nothing.
  Otherwise it offers Playwright's headless Chromium (about 210 MB to download, 650 MB on disk); with a no, thimble
  works without screenshots, or tries the Chrome it found anyway. `--browser bundled`, `--browser system` or
  `--browser off` answers it.
- **The sandbox's system packages** (Linux, while Claude Code's sandbox can't run). thimble's agents run their shell
  commands in Claude Code's sandbox, so they can read only the folder you open with thimble and write only their
  workspace. On Linux the sandbox needs bubblewrap and socat, and on Ubuntu 23.10 or later an AppArmor profile for
  bwrap. A yes installs them with sudo and your package manager (apt, dnf or pacman); the question shows the exact
  commands. With a no, thimble's agents won't start until the sandbox works; run install.sh again to set it up.
  `--sandbox-deps` or `--no-sandbox-deps` answers it. macOS has the sandbox built in.

install.sh no longer asks whether Claude Code should trust thimble's folder: thimble's agents run as subagents of your
own session, in the folder you start `thimble` in, which Claude Code asks you to trust the first time, as for any
folder. They need that trust, since Claude Code loads a plugin's hooks module only in a trusted folder. install.sh
accepts and ignores `--trust-workspaces` and `--no-trust-workspaces` from an earlier version's command line.

install.sh doesn't add thimble to every Claude Code session, and doesn't ask about it: the `thimble` command loads
thimble's plugin into the sessions it starts. If an earlier install added thimble to every session, that stays;
`thimble plugin off` or `install.sh --no-plugin` takes it out.

Without a terminal, install.sh runs only when every question that remains has its flag, and otherwise lists the missing
ones. The answers are kept, so an update doesn't ask them again, and `thimble update` passes the same flags on. To change
an answer, run install.sh again with its flag; it skips the steps that are done. `install.sh --dry-run` prints the
opening screen and the questions that remain, and changes nothing; `--verbose` also prints every command.

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

## How thimble's agents run

The orientation, its critic, the writers, view builds, view reviews and report checks are subagents of the Claude Code
session you start with `thimble`. Claude Code's agent tray (↓) lists them, and each has its thread in the browser.

- **Starting one.** Start, Write, Build, Run and the other buttons in the browser start their agent at once through
  thimble's plugin, without a turn of Claude's; Claude's context gets a one-line note that names it. Asked in the
  terminal, Claude calls a thimble tool (`start_orientation`, `start_writing`, `propose_view`, `run_check`) and then
  makes the Agent call it gives, which Claude Code's auto mode judges as it judges any call. A start that doesn't happen
  shows in the browser with its reason.
- **Models and efforts.** Each agent runs on exactly the model and effort that Settings name for it, and a change
  applies to the next start, with no restart. Start, `/thimble:orient --model <model> --effort <level>` and the start
  tools take a model and an effort for one run. The orientation's own subagents run on the "orientation subagents" row
  when it starts them as `thimble:orient-helper`; one it starts as another type runs on the orientation's own model and
  effort. A follow-up runs on its run's model and effort, except one typed in the terminal to an agent started from
  the browser after that role's settings changed, which runs on the new ones; its thread says so. The launcher unsets
  `CLAUDE_CODE_EFFORT_LEVEL` (passing it on as your session's own effort), `CLAUDE_CODE_SUBAGENT_MODEL` and
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` for the session, blanks them where an `env` block of your Claude Code settings sets
  them, and prints a line for each, so that they can't change the agents' models and efforts.
- **Ending.** When an agent finishes, its report reaches your session, and Claude answers in one short line; the result
  is in the browser. Quitting Claude Code stops every agent, and nothing restarts on its own: `thimble -c` and a
  message in an agent's thread continue it, and Retry starts a view build, review or check again. An orientation from
  an earlier session, not the one `-c` continues, goes on only in that session: `thimble -r <its session id>`, which
  its thread shows. A finished agent leaves the ↓ tray; `/tasks` opens it. "Move to background" and the ← agent view
  are turned off. `/clear` keeps the agents running, but it stops the orientation's current command, which it may run
  again or skip.
- **Report checks** run after a writer saves a document. After your own edits a check shows how many passages changed,
  and Run starts it.
- **Code tickets**, in a development install only, are changes to thimble's own code: file one with Report a problem →
  File a code ticket, or ask Claude. Its agent, `thimble:dev-ticket`, works in a git worktree of thimble's code, which
  your session's sandbox lets its Bash write; its checks run in thimble's sandbox runtime, and the browser asks you before
  its change reaches thimble's code. Code tickets run one at a time.
- **One sandbox.** Your session and its agents share one fence: Bash can write only thimble's work folders, the
  folder you opened is read-only, an edit of it or of thimble's config asks you, and so do web fetches and searches as
  Settings say. View builders use your session's network. Installs follow your Claude Code permission mode; thimble
  adds no rule for them. A view reaches you only as its checks last passed it, whatever was written in its folder since.
- **Permissions.** Every agent runs in your session's permission mode, which you change in the terminal. Your
  session's own requests show on the browser's card and in the terminal, and either place answers them. An agent's
  request shows only in the terminal; for one the browser started, Claude Code names the request as from the thimble
  plugin and offers Yes and No without an always-allow. When auto mode refuses an agent's call, `/permissions` →
  Recently denied approves it.
- **Limits.** Claude Code runs at most 20 subagents at once in a session. thimble's agents, their own subagents and side
  threads count, and thimble queues view builds and checks at the limit. Raise it with
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`; it doesn't apply while your session runs Ultracode. The agents have no
  Workflow tool, which Claude Code gives only to your session and its forks, and no Ultracode mode; its effort, xhigh,
  is one of the efforts Settings offer them. Start is refused while your session is in plan mode, where an agent would
  have to ask before every card; shift+tab leaves it. Agents that already run go on in plan mode, as Claude Code's own
  subagents do, and can only read and plan there; one that ends there without its work shows failed, with what to do.
  Safe mode (`--safe-mode`) turns thimble's plugin off entirely.

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
`.claude/settings.json` through `claude plugin`; then run `claude` there. When Claude Code does not know thimble's
marketplace yet (a default install doesn't register it), `on` lists its registration from the install's folder among
the steps it asks about and runs it first. That adds no plugin to your sessions, and `thimble
uninstall` takes it back. `thimble cc-mod off` undoes it, and `thimble
cc-mod status` says whether each of the two plugins is on in the folder. They are switched independently: `on` and `off`
leave the thimble plugin as it is. Sessions you start with `thimble`, with the agents thimble starts in them, and the jobs thimble's server
starts (classifier calls, task programs and `thimble fix`), run without the mod; plain `claude` in the folder uses
it. To use it without installing thimble, see the [mod's README](mods/thimble-cc-mod/README.md).

## Demo datasets

`thimble demo` opens thimble on public data. It lists three datasets with their sources, publishers and sizes, asks
before each download (`--yes` answers for all, or name the ones you want), and rebuilds each from its publisher's files
into `~/thimble-demo/<name>` (`--dir` moves it). thimble redistributes none of them: each is downloaded from its
publisher on your machine.

| dataset | source | download |
|---|---|---|
| `collusion-wiki` | the logs of a wiki AI agents used as a message board, from [collusion.wiki](https://collusion.wiki/) | 4.4 MB |
| `mythos-5` | the [Mythos 5 transcript](https://github.com/anthropics/mythos-5-incident-transcript) Anthropic released | 2.6 MB |
| `transluce-urlquery` | Transluce's catalog of 38,160 urlquery.net reports likely made by AI agents, from its report [Early rogue AI agent activity and attempts to hack found on urlquery.net](https://transluce.org/agent-activity) (2026-09-23) | 4.6 MB |

Each build is checked against the copy the demo's orientations ran on; a source that changed since is named in a
warning, and the Transluce build goes on with what it got. `~/thimble-demo/SOURCES.md` lists who published each
dataset, where it was downloaded from and what each build changes. The Transluce dataset states no licence.

The command then registers each folder. Where [demos/](demos/README.md) in the repository has a pre-cached
orientation for the dataset, it installs it as the folder's workspace: the cards, labels, views and report. A
pre-cache holds the orientation's outputs alone, so its Claude Code session is not included. A dataset without one
opens with no analysis yet, and Start in the page runs the orientation. It opens the workspace in your browser without
a Claude Code session; in the orientation's thread, "Attach a fresh session" shows the command that attaches one.

On a terminal it then asks `Attach a Claude Code session now? (requires claude to be logged in)`, Enter for yes, once
`claude auth status` says you are logged in (when you are not, it says how to log in and asks nothing). `--attach`
answers yes, `--no-attach` no. Either way it prints how to attach later:

```bash
cd ~/thimble-demo/collusion-wiki && thimble     # main, the session you chat with in the page
cd ~/thimble-demo/collusion-wiki && thimble -c  # continue the last session there
```

A session attached to a pre-cached workspace starts fresh, with the orientation's cards and report as its context.

A workspace that holds an analysis already is left as it is unless `--replace`, which archives it first. Run again,
it downloads nothing it already has.

`thimble demo --export <workspace> <out>` writes everything in a workspace as `<out>/<dataset>/`: the cards, labels,
views and documents, every chat and call output, the work files, and the Claude Code transcripts of your sessions
and of the agents thimble ran in them (the orientation, its critic, the writers, view builds, reviews and checks). It ends with an inventory of what it wrote:
the transcripts, the chats, the call outputs, the label rationales, how much of the dataset's text it holds, what may
be private (your user name, absolute paths, gitleaks' findings), what it left out and the size of each. It holds the
dataset's text, so share it only where you may share the dataset. `thimble demo <dataset> --precaches <out>` installs
it; its orientation ran as a subagent of the exporter's session, so it can be read but not continued. `--outputs-only` writes the
orientation's outputs alone, the pre-caches demos/ holds; [demos/README.md](demos/README.md) says what one holds and
how a maintainer makes one.

## Update

`thimble update` installs the latest release; in a Dev install it runs `git pull --ff-only` and the install steps,
which reinstall the frontend's packages when `package-lock.json` changed and rebuild the UI when its sources did.
`thimble update --from <zip>` installs a zip you downloaded, checked against the release's `SHA256SUMS` when that
file is beside it. A zip whose digest does not match is refused. Workspaces are kept. A running server keeps the old code
until `thimble server restart`.

## Uninstall

`thimble uninstall` asks, then removes the trust entry an earlier install added, the plugin registration that put
thimble in every Claude Code session, if there is one (or the marketplace `thimble cc-mod on` registered, which turns
thimble-cc-mod off in the folders it is on in), `~/.local/bin/thimble`, the lines install.sh added to your shell's
startup files (and a startup file it created, once nothing else is in it), and `~/.thimble`, which holds a Global
install's workspaces. `--keep-home` keeps `~/.thimble`. A clone stays where it is, and so does a downloaded headless Chromium, in
Playwright's cache folder.

To delete one workspace and keep the install, `thimble list` shows the workspaces by id and `thimble purge <id>` deletes
that one and prints each path it deleted. The folder it read and your Claude Code transcripts stay.

## Troubleshooting

- `thimble doctor` shows the server, the versions, the auth path and the log's recent errors.
- thimble's agents don't start because Claude Code's sandbox can't run: `thimble doctor` says what is missing, and on
  Linux `install.sh --sandbox-deps` installs it.
- thimble's agents don't start, and the browser says Claude Code's hooks modules are off: managed settings
  (`disableAllHooks`, `allowManagedHooksOnly`) turn them off, or Claude Code doesn't trust the folder. `thimble doctor`
  names the reason. Fix it, then run `thimble -c`. Claude, its threads, cards and labels work meanwhile.
- Start is greyed out with a line about plan mode: your session is in plan mode, where an agent would ask before every
  card. Leave it with shift+tab in the terminal.
- An empty `.claude/.cc-writes/` folder appears in the folder you start `thimble` in: Claude Code's sandbox makes it
  for Bash, and thimble runs your session in that sandbox. Your Claude Code settings files stay as they are.
- Cards are not checked, views are checked without loading their page, or screenshots are unavailable: there is no
  browser (the install's answer, or no Chrome or Edge found), or the machine lacks the headless Chromium's system
  libraries. thimble never downloads a browser by itself. `install.sh --browser system` or `--browser bundled` sets one
  up, and `thimble doctor` names the command for missing libraries. Then run `thimble restart`.
- `/thimble` is not recognised in a `claude` session: a session started with plain `claude` doesn't load thimble. Quit
  it and run `thimble` in that folder; sessions you start with `thimble` have `/thimble`.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
