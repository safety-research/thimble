# Installing thimble

> **Installing thimble for someone, as an agent?** Follow the Installing section of [CLAUDE.md](CLAUDE.md), which
> Claude Code loads only in a session started inside the clone: run `bash scripts/install.sh --dry-run`, ask the
> person each question it lists (often there are none), and pass the flag for each of their answers. Answer none of
> them yourself.

thimble uses whichever auth path you have configured for `claude`: every model call runs through your own `claude`, in
your config dir with your user settings. thimble's agents run as subagents of your Claude Code session;
its single model calls (labels, card checks, view proposals) and `thimble fix` run as `claude -p` jobs in folders of
their own, so auth
set only in a project's `.claude/` settings does not reach them. thimble tells you when `claude` is missing or not
logged in.

What thimble's agents may do, and on which models, is set in `~/.thimble/config.json`: [docs/config.md](docs/config.md).
Card code runs in the notebook kernel with your network, whatever that file says. The kernel runs in Anthropic's sandbox
runtime, which the install sets up with the frontend's packages: it sees only the corpus and the workspace. Without Node
it runs in bubblewrap on Linux and with your user's access on macOS. On Linux it runs in bubblewrap only where
bubblewrap can create a sandbox, and otherwise with your user's access; `thimble doctor` says which.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.295), logged in (`claude auth status`)
  or set up with an API key or a cloud provider ([Authentication](#authentication)), with
  its hooks modules on, which thimble's agents need: managed settings with `disableAllHooks` or
  `allowManagedHooksOnly`, or a folder Claude Code doesn't trust, turn them off.
- macOS or Linux, and Python 3.12+. [uv](https://docs.astral.sh/uv/getting-started/installation/) is recommended: it
  installs the pinned versions and fetches Python when the machine has none.
- Node 20+ for custom views and for the sandbox card code and code tickets run in; a Dev install needs 20.19+, 22.13+ or 24+, which the frontend's tests need.

## Authentication

thimble has no login of its own: every model call runs your own `claude`. Any way you sign in to Claude Code works.

- **Claude login.** Run `claude auth login`, or `/login` in a `claude` session.
- **API key.** Export `ANTHROPIC_API_KEY` in your shell before thimble's server starts. The server keeps the environment
  it started with, so if a server already runs, run `thimble server restart` from that shell. Claude Code asks once
  whether to use the key.
- **apiKeyHelper (most robust).** Put `"apiKeyHelper": "<a command that prints the key>"` in `~/.claude/settings.json`
  (your Claude Code config dir). It reaches your session and thimble's server calls, whatever your shell exports. Auth
  set only in a project's `.claude/` settings does not reach thimble's server calls.
- **Bedrock, Vertex or Foundry.** Set `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1` or
  `CLAUDE_CODE_USE_FOUNDRY=1` and the provider's credentials, as Claude Code's docs say, before the server starts.
  thimble names Anthropic's model ids, such as `claude-opus-5-5`. If your provider needs other ids, set each agent's
  model in Settings or as `agents.<agent>.model` in `~/.thimble/config.json` ([docs/config.md](docs/config.md)), or set
  `THIMBLE_<ROLE>_MODEL` (such as `THIMBLE_ORIENT_MODEL`) in the server's environment.

After you change credentials, run `thimble server restart`. `thimble doctor --verbose` shows the auth path. When your
organization's managed settings set `forceLoginMethod`, Claude Code blocks API keys and `apiKeyHelper`: sign in with the
method it names.

## Permissions

thimble follows your Claude Code session's permission mode and settings. It adds no permission rule, working directory or
sandbox to your session, whether you start it with `claude` or `thimble`, and it approves none of its own tools.

thimble's agents run in your session's permission mode. Auto mode is recommended: Claude Code's classifier judges each
call, so thimble's agents keep working while you watch the browser. Start with `claude --permission-mode auto` (or
`thimble --permission-mode auto`), press shift+tab in the terminal, or set `"permissions": {"defaultMode": "auto"}` in
`~/.claude/settings.json` (a project's settings can't choose auto). The first time Claude reads a file outside the folder
you opened, such as an agent's notes in thimble's workspaces folder, Claude Code asks once whether to allow such reads.

In Manual mode Claude Code asks before the first call of each thimble tool, before each edit thimble's agents make in
their work folders (which are outside the folder you opened), and before most commands. An agent's requests show only
in the terminal, and for an agent the browser started Claude Code offers only Yes and No. While your session reports
Manual mode, thimble shows a red notice above the browser's chat (in terminal mode, a red row above the prompt) that
says how to switch, or who turned auto mode off; it goes when you switch, and once you dismiss it, it stays off for that
workspace. In browser mode the terminal also prints that line once per session.

Code tickets and view builds are subagents of your session, so they run in its mode, Bypass included. thimble's own
jobs (an extension's program that runs the dev agent, and the sessions thimble's server runs) follow your session's
mode, except Bypass: they run in Bypass only when you choose Bypass for them in thimble's Settings. `"bypass"` written
into thimble's config by hand counts as Manual until you choose it in Settings. `thimble fix` asks you first and then
runs in Manual mode.

To be asked less, add this to `~/.claude/settings.json`, with the path from the `workspaces_dir` line of
`thimble doctor --verbose` (in a development install, also `~/.thimble/dev/trees`, made first with `mkdir -p`):

```json
{
  "permissions": {
    "allow": ["mcp__plugin_thimble_thimble", "Skill(thimble:shared)"],
    "additionalDirectories": ["/home/you/.thimble/app/workspaces"]
  }
}
```

What protects what:

| | thimble, always | Claude Code's sandbox (optional) | Your permission mode |
|---|---|---|---|
| thimble's token files | Claude's file tools can't read or edit them | Shell commands can't read or write them | A shell command that reads them asks (Manual) or is judged (auto) |
| Acting as you in the browser | Needs this browser's sign-in; a link's code works once, for 5 minutes; each new sign-in shows a line in your terminal | Shell commands can't make a sign-in | Shell commands that try follow your mode |
| The folder you opened | File-tool edits refused when `data` is `"off"` | Shell commands can still write it | Edits ask (Manual), are judged (auto) or run (Bypass) |
| thimble's own jobs | Never in Bypass unless you choose it in Settings | — | Follow your session's mode, Bypass as Manual |
| Code tickets and view builds | You approve each change before it reaches thimble's code | Their shell commands are contained like yours | Your session's mode, Bypass included |

In every mode, thimble's plugin refuses some calls of Claude's file tools (Read, Edit, Write, Grep, Glob and the others),
in your session and in its agents: reads and edits of thimble's token files (`server.json`, `session.key`, `paired.json`
and `links/` in `~/.thimble`), edits of thimble's records (in the workspace, and the permission modes it keeps in
`~/.thimble`), and the edits and web calls you turned off in thimble's config (`data` or `web` set to `"off"`,
[docs/config.md](docs/config.md)). thimble does not limit shell commands: they follow your permission mode, as in any
Claude Code session. In terminal mode there is no browser to sign in: thimble's keys in the terminal, and any shell
command, act as you. To keep Claude from editing the folder you open, add a deny rule to your Claude Code settings, such
as `"deny": ["Edit(//path/to/folder/**)"]` (two slashes for a path from `/`). To keep shell commands away from
thimble's token files too, turn on Claude Code's sandbox (`/sandbox`, or in your settings) and add:

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.thimble/server.json", "~/.thimble/session.key", "~/.thimble/paired.json", "~/.thimble/links"],
      "allowWrite": ["/home/you/.thimble/app/workspaces"]
    }
  }
}
```

The `allowWrite` entry lets thimble's agents write their notes. /thimble starts thimble's server from a hook, which runs
outside the sandbox. `thimble doctor` says whether the sandbox is on.

### Signing in the browser

/thimble shows the dashboard's link under its reply. The link carries a one-time code: opening it signs this browser in
to thimble. The code then stops working, as it does 5 minutes after it was shown or when a newer link for the workspace
is shown; opening it in a browser that is signed in already changes nothing. A browser that is not signed in shows
thimble, but each change it tries says to open the link. For a new link, run `thimble up` in a shell.

Each new sign-in prints a line in your terminal under Claude's next reply, and shows a notice in thimble with
**Sign it out**. If a sign-in was not you, click Sign it out, or run `thimble unpair` in a shell, which signs out every
browser.

## For administrators

What thimble needs from a managed Claude Code setup:

- **Hooks modules on.** Managed `disableAllHooks` turns them off, and so does `allowManagedHooksOnly`, unless managed
  `enabledPlugins` force-enables thimble's plugin. Without them thimble's agents can't start; chat, cards and labels
  still work.
- **Folder trust.** Claude Code loads a plugin's hooks module only in a folder it trusts. Each user accepts the trust
  dialog once in the folder they open.
- **Plugins.** install.sh adds thimble's plugin with `claude plugin marketplace add` and `claude plugin install --scope
  user`. Managed settings that limit which marketplaces or plugins users may add stop that; force-enable thimble's
  plugin in managed `enabledPlugins` instead. A plugin that managed settings force on also loads in the sessions of
  extension programs beside the copy thimble gives them.
- **`allowManagedPermissionRulesOnly`** makes Claude Code ignore the rules users save, so each thimble tool call asks in
  Manual mode and no "don't ask again" is offered. Add `mcp__plugin_thimble_thimble` and `Skill(thimble:shared)` to
  managed `permissions.allow`.
- **`disableSideloadFlags`** makes Claude Code reject `--plugin-dir`. Sessions that load the installed plugin are not
  affected. Terminal mode's renderer, which the `thimble` command loads with `--plugin-dir`, can't start, and neither
  can extension programs.
- **`forceLoginMethod`** blocks API keys and `apiKeyHelper` ([Authentication](#authentication)).
- **`disableAutoMode`** turns auto mode off, so users answer many more prompts ([Permissions](#permissions)).
- **A sandbox (optional).** Managed `sandbox.enabled` with the `denyRead` block in [Permissions](#permissions) keeps
  shell commands away from thimble's token files.

## Install

### With Claude (recommended)

    claude "install thimble from https://github.com/safety-research/thimble"

Claude follows the Installing section of [CLAUDE.md](CLAUDE.md): it downloads the latest release (or clones the
repository for a development build), runs `scripts/install.sh --dry-run`, asks you each question it lists, often none,
and installs.

### With install.sh

Global install, the latest release copied into `~/.thimble/app` (`$THIMBLE_HOME/app` when `THIMBLE_HOME` is set):

1. Download `thimble-<version>-<sha>.zip` from the [latest release](https://github.com/safety-research/thimble/releases/latest),
   or run `gh release download --repo safety-research/thimble --pattern 'thimble-*.zip'`.
2. Unzip it and run `bash scripts/install.sh` inside the unzipped folder.

Dev install, a clone installed in place with the backend's test tools:

    git clone https://github.com/safety-research/thimble.git
    cd thimble
    bash scripts/install.sh

Either install:

- installs the Python and Node packages and, if you want one, a browser for screenshots;
- adds thimble's plugin to Claude Code with Claude Code's own commands: `claude plugin marketplace add <install
  folder>`, then `claude plugin install --scope user thimble@<name>` (`thimble-local` for a release, `thimble` for a
  clone). Claude Code records the plugin in `~/.claude/settings.json` (`enabledPlugins`) and `~/.claude/plugins`.
  `/thimble` then works in any `claude` session. A re-run updates the plugin when its version changed and leaves it on
  or off as you set it. When Claude Code has another install's thimble plugin, or the one from GitHub, install.sh
  leaves it and prints the commands that switch it. `--no-plugin` leaves your Claude Code plugins as they are;
- links the `thimble` command into `~/.local/bin`, and when that folder is not on your PATH (or `THIMBLE_HOME` is not
  `~/.thimble`), prints the line to add to your shell's startup file so that a new terminal finds it;
- runs `thimble doctor`.

install.sh changes nothing else in your Claude Code setup: no permission rule, no trust, no other setting. It installs
no system package and never runs sudo.

install.sh opens with one screen: what it found (Claude Code, Python or uv, Node, a browser, and on Linux whether card
code and terminal-mode views can run in bubblewrap), what it installs where and about how big, what it changes in your
Claude Code setup, and whether a question remains. Then it prints a line per step: ✓ when the step is done, ! when it
needs you, with what fixes it under it. Every command it runs, with its output, goes to `~/.thimble/install.log`.

It asks one question, and only when it finds no Chrome or Edge that starts under automation: **a browser for
screenshots**. thimble takes screenshots of the cards and views it draws, to check how they look. It offers Playwright's
headless Chromium (about 210 MB to download, 650 MB on disk); with a no, thimble works without screenshots.
`--browser bundled`, `--browser system` or `--browser off` answers it.

Without a terminal, install.sh runs only when the question, if it remains, has its flag. The answer is kept, so an update
doesn't ask it again. `install.sh --dry-run` prints the opening screen and the question, and changes nothing;
`--verbose` also prints every command.

## Start thimble

In a folder of transcripts, start Claude Code and type `/thimble`:

    cd <folder>
    claude

In a session that was open before the install, run `/reload-plugins` first. /thimble starts thimble's server, opens the
folder as a workspace and shows the dashboard's link under its reply; open it to sign this browser in
([Signing in the browser](#signing-in-the-browser)). The browser chat, cards, labels and reports work, and thimble's
agents can start a few seconds after the link shows. If your shell sets `HTTP_PROXY` or `HTTPS_PROXY`, start claude with
`NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"`, or thimble's plugin may not reach its server; /thimble says so
when it sees a proxy.

In a session you start with `claude`:

- don't move one of thimble's agents to the background (← or "Move to background"): thimble loses track of a moved agent.
  The `thimble` command turns both off;
- /thimble says so, in the terminal and in the browser, when `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL` or
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, since each would change the models and efforts thimble's Settings give its
  agents.

The `thimble` command does the same in one step, and adds:

- thimble's prompt in the system prompt. /thimble gives it as a message instead: each /thimble adds it again, and
  /clear and /compact give it back;
- thimble's agents from the first message, since it starts the server before Claude Code;
- terminal mode (`thimble mode terminal`), which only the `thimble` command starts;
- `thimble -c`, which continues the last thimble session in the folder. With `claude`, use `claude --continue` or
  `claude --resume`, then type /thimble again;
- thimble's status line, the composer's fast mode and Ultracode at the start, the name `thimble:main · <folder>` in
  `/resume`, and effort `high` when your settings name none;
- it unsets the three variables above for the session, turns off "Move to background" and the ← agent view, and adds
  127.0.0.1 to `NO_PROXY`.

### Start it by hand with everything but terminal mode

Replace `<thimble folder>` with the path in `~/.thimble/app-dir`:

    NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost" no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost" \
    CLAUDE_CODE_DISABLE_AGENT_VIEW=1 \
    env -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE \
      claude --name "thimble:main · ${PWD##*/}" --effort high \
      --settings '{"statusLine": {"type": "command", "command": "<thimble folder>/plugin/bin/thimble-agents --statusline", "refreshInterval": 2}}' \
      /thimble

- `NO_PROXY` and `no_proxy` keep thimble's traffic to 127.0.0.1 away from a proxy your shell sets.
- `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` turns off "Move to background" and the ← agent view.
- `env -u` removes the three variables that override thimble's models and efforts. If an `env` block of your Claude
  Code settings sets them, add `"env": {"CLAUDE_CODE_EFFORT_LEVEL": "", "CLAUDE_CODE_SUBAGENT_MODEL": "",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": ""}` to the `--settings` value.
- `--name` sets the name `/resume` and `claude agents` show.
- `--effort high` is thimble's effort for your session. Leave it out when your settings choose one.
- `--settings` adds thimble's status line. To keep your own, add `--chain '<your command>'` after `--statusline`.
- Add `--permission-mode auto` for fewer prompts.

For terminal mode and `-c` too, run the `thimble` command by its path, `<thimble folder>/plugin/bin/thimble`. It needs
no link in `~/.local/bin`.

## Manual install

install.sh is the recommended install. You can also install thimble by hand. The browser workspace and thimble's agents
work the same way; [What works differently](#what-works-differently) lists what does not.

thimble has two parts: the plugin, which Claude Code installs like any plugin, and the thimble folder, which holds the
server, its Python environment and the web interface. The plugin finds the folder through the file
`~/.thimble/app-dir`. The plugin and the folder must be the same version.

### 1. Get the thimble folder

A release is recommended. Download it, check it, and move it to `~/.thimble/app` (if `~/.thimble/app` exists, this is
an update: see Updates under [What works differently](#what-works-differently)):

    mkdir -p ~/.thimble && chmod 700 ~/.thimble
    cd "$(mktemp -d)"
    gh release download --repo safety-research/thimble --pattern 'thimble-*.zip' --pattern SHA256SUMS
    sha256sum -c SHA256SUMS            # on macOS: shasum -a 256 -c SHA256SUMS
    unzip -q thimble-*.zip
    mv thimble-*/ ~/.thimble/app

For a development build, clone the repository: `git clone https://github.com/safety-research/thimble.git`.

The commands below call the thimble folder `$T`; set it first, for example `T=~/.thimble/app`. thimble keeps your
workspaces in `$T/workspaces`. Keep that folder when you replace `$T`.

### 2. Install the Python packages

thimble needs Python 3.12 or later. [uv](https://docs.astral.sh/uv/getting-started/installation/) is recommended: it
installs the tested versions, and it gets Python if the machine has none.

From a release, with uv:

    uv venv --python '>=3.12' "$T/backend/.venv"
    uv pip sync --require-hashes "$T/backend/requirements.txt" --python "$T/backend/.venv/bin/python"

From a release, with pip:

    python3 -m venv "$T/backend/.venv"
    "$T/backend/.venv/bin/python" -m pip install --require-hashes --no-deps -r "$T/backend/requirements.txt"

From a clone, with uv (add `--extra dev` for the test tools): `(cd "$T/backend" && uv sync --frozen --no-install-project)`.
From a clone without uv: `python3 -m venv "$T/backend/.venv"`, then
`"$T/backend/.venv/bin/python" -m pip install -e "$T/backend"`. pip installs the newest versions that
`backend/pyproject.toml` allows, not the tested ones.

To use a Python environment you prepared, link it and check it:

    ln -s /path/to/your/venv "$T/backend/.venv"
    "$T/backend/.venv/bin/python" -I "$T/backend/app/env_check.py" "$T/backend/pyproject.toml"

### 3. Install the Node packages and the web interface

Custom views, pictures of chart cards and the sandbox card code runs in need Node 20 or later; a clone needs Node
20.19+, 22.13+ or 24+. Without Node, the rest of thimble works.

A release has the web interface. Install only the packages the server uses:

    npm ci --prefix "$T/frontend/runtime" --no-audit --no-fund
    rm -rf "$T/frontend/node_modules" && mv "$T/frontend/runtime/node_modules" "$T/frontend/node_modules"

A clone needs all the packages and a build:

    (cd "$T/frontend" && npm ci --no-audit --no-fund && npx tsc --noEmit -p tsconfig.app.json && npx vite build)

### 4. Optional: a browser for screenshots, and the sandbox on Linux

thimble uses Chrome or Edge when it finds one. If you have neither:

    "$T/backend/.venv/bin/python" -m playwright install chromium-headless-shell
    "$T/frontend/node_modules/.bin/playwright" install chromium-headless-shell

If the browser does not start on Linux, `sudo "$T/backend/.venv/bin/python" -m playwright install-deps
chromium-headless-shell` installs its libraries. `"browser": "off"` in `~/.thimble/config.json` turns screenshots off.

On Linux, card code runs in a sandbox, and terminal mode shows views, only where bubblewrap can create a sandbox:
bubblewrap installed, and on Ubuntu 23.10 or later an AppArmor profile that lets it. `thimble doctor` (step 7) says
whether it can, and `thimble doctor --verbose` prints the commands that add it.

### 5. Tell the plugin where the thimble folder is

    mkdir -p ~/.thimble && chmod 700 ~/.thimble
    (cd "$T" && pwd -P) > ~/.thimble/app-dir

With a `THIMBLE_HOME` other than `~/.thimble`, write `app-dir` there and export `THIMBLE_HOME` in your shell's startup
file, so that Claude Code, its hooks and thimble's server get it.

### 6. Add the plugin to Claude Code

From the thimble folder, so that the plugin is always the folder's version (install.sh does the same):

    claude plugin marketplace add "$T"
    claude plugin install --scope user thimble@thimble-local    # from a clone: thimble@thimble

The name after `@` is the `name` in `$T/.claude-plugin/marketplace.json`.

You can also add it from GitHub, in a `claude` session: `/plugin marketplace add safety-research/thimble`, then
`/plugin install thimble@thimble`, then `/reload-plugins`. That marketplace has the plugin of the repository's default
branch: use it only with a thimble folder of the same version (`claude plugin list` shows the plugin's version,
`$T/plugin/.claude-plugin/plugin.json` the folder's). Claude Code does not update plugins from GitHub by itself. Add the
plugin from one marketplace only; a clone's marketplace and the GitHub one are both named `thimble`.

### 7. Check the install

    "$T/plugin/bin/thimble" doctor

Its Plugin line says whether Claude Code has the plugin and, when the versions differ, gives the command that updates
it. To get the `thimble` command, link it into a folder on your PATH:
`mkdir -p ~/.local/bin && ln -s "$T/plugin/bin/thimble" ~/.local/bin/thimble`.

Then [start thimble](#start-thimble).

### What works differently

- **Updates.** `thimble update` runs install.sh, which turns a manual install into an install.sh install. It adds the
  plugin from the folder, unless Claude Code has the plugin from GitHub (or another install's): install.sh leaves that one
  as it is and prints the commands that switch it, so update the GitHub one yourself, with `claude plugin marketplace
  update thimble` and `claude plugin update thimble@thimble`. `thimble update --no-plugin` leaves Claude Code's plugins
  alone. To update by hand: get the new folder and keep `workspaces/`, do steps 2 and 3 again, run `claude plugin
  marketplace update <name>` and `claude plugin update thimble@<name>`, then `thimble server restart`. Claude Code installs
  a new plugin copy only when its version changes, and a session uses it only after a restart.
- **Uninstall.** `thimble uninstall` removes `~/.thimble`, with a release in `~/.thimble/app` and its workspaces, and the
  plugin only when its marketplace is that folder. To remove one from GitHub: `claude plugin uninstall
  thimble@thimble`, then `claude plugin marketplace remove thimble`.
- **Checks.** install.sh checks the packages' hashes, the Node version and the browser, and keeps a log that `thimble
  feedback` adds to its report. A manual install has only `thimble doctor`.
- **Two plugin copies.** When the plugin from GitHub differs from the folder's, the `thimble` command also loads the
  folder's copy. Add the plugin from the folder (step 6) if you use the `thimble` command.

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

The orientation, its critic, the writers, view builds, view reviews and report checks are subagents of your Claude Code
session. Claude Code's agent tray (↓) lists them, and each has its thread in the browser.

- **Starting one.** Write, a view proposal's Accept, Build, Run and the other buttons in the browser start their agent
  at once through thimble's plugin, without a turn of Claude's; Claude's context gets a one-line note that names it.
  Asked in the terminal, Claude calls a thimble tool (`start_orientation`, `start_writing`, `propose_view`, `run_check`)
  and then makes the Agent call it gives, which Claude Code's auto mode judges as it judges any call. A start that
  doesn't happen shows in the browser with its reason.
- **The orientation.** Claude starts one when you ask for it, or when your question needs a broad look at the corpus;
  `/thimble:orient [focus]` asks for one directly. It explores as far as your request and its effort call for, leaves
  its findings as cards in the group Orientation, and may have a critic review its analysis before it finishes. It
  writes no report and proposes no views: ask Claude for a report (`/thimble:write report`) when you want one.
- **View proposals.** After each of your messages, when a side thread answers, and once when an orientation ends,
  thimble may propose a view, a page that shows your records in a form their files hide. The proposal waits on a card
  above the reply box, with the view's name, what it shows and the task it serves, until you answer it: Accept builds
  the view, Reject drops the proposal, and Don't ask again turns view proposals off. Nothing builds before you accept.
  When you open a file that only Raw can show, the same card can propose a viewer for its type. Deciding whether to
  propose takes one model call on a copy of your session's context, made with the sign-in thimble's card checks and
  labels use. Settings' View proposals switch turns them on and off. In terminal mode the proposal is a row above the
  prompt with accept, reject and don't ask again; to turn proposals on again there, remove `views.propose` from
  `~/.thimble/config.json` or set it to true ([docs/config.md](docs/config.md)).
- **Models and efforts.** Each agent runs on exactly the model and effort that Settings name for it, and a change
  applies to the next start, with no restart. `/thimble:orient --model <model> --effort <level>` and the start tools
  take a model and an effort for one run. The orientation's own subagents run on the "orientation subagents" row
  when it starts them as `thimble:orient-helper`; one it starts as another type runs on the orientation's own model and
  effort. A follow-up runs on its run's model and effort, except one typed in the terminal to an agent started from
  the browser after that role's settings changed, which runs on the new ones; its thread says so. The `thimble` command
  unsets `CLAUDE_CODE_EFFORT_LEVEL` (passing it on as your session's own effort), `CLAUDE_CODE_SUBAGENT_MODEL` and
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` for the session, blanks them where an `env` block of your Claude Code settings sets
  them, and prints a line for each; in a session you start with `claude`, /thimble says so for each that is set, in the
  terminal and in the browser.
- **Ending.** When an agent finishes, its report reaches your session, and Claude answers in one short line; the result
  is in the browser. Quitting Claude Code stops every agent, and nothing restarts on its own: `thimble -c` (or
  `claude -c`, then /thimble) and a message in an agent's thread continue it, and Retry starts a view build, review or
  check again. An orientation from an earlier session, not the one `-c` continues, goes on only in that session:
  `thimble -r <its session id>` (or `claude -r`, then /thimble), which its thread shows. A finished agent leaves the ↓
  tray; `/tasks` opens it. The `thimble` command turns "Move to background" and the ← agent view off; in a session you
  start with `claude`, don't use them, since thimble loses track of a moved agent. `/clear` keeps the agents running, but it stops the orientation's current command, which it may run
  again or skip.
- **Failures.** When one of thimble's agents fails, a notice tells you where you are looking: in the browser above the
  reply box of the chat you have open, main's or a thread's, and in terminal mode in the rows above the prompt. It
  names the agent, such as Orientation, View build: Agent Network or Card check, says in one line what failed and how
  to fix it, and has a button for the fix where the browser can run it (Retry, Try again, Open Settings) and Open for
  the agent's thread. A fix only your terminal can run, such as `/login` or `/model`, says "In your terminal:". It stays
  until you dismiss it (×) or the fix works, and the agent's thread keeps it as a line. A request of Claude's own that
  fails shows as an error card in main, with its fix, and as a notice while you are in another chat. This covers
  the orientation and its subagents, the critic, the writers, view builds and reviews, report checks, code tickets,
  card checks, label runs and view proposals: a request Claude's safeguards blocked or switched to another model, an
  API error that stopped the agent (sign-in, access, a model not found, overload or rate limits after Claude Code's
  own retries, the connection), an agent that ended failed or could not start, and a build, check or label run that
  failed.
- **Report checks** run after a writer saves a document. After your own edits a check shows how many passages changed,
  and Run starts it.
- **Code tickets**, in a development install only, are changes to thimble's own code: file one with Report a problem →
  File a code ticket, or ask Claude. Its agent, `thimble:dev-ticket`, works in a git worktree of thimble's code, which
  it edits from your session, in your session's permission mode; its checks run in thimble's sandbox runtime where it
  can run, and otherwise thimble asks you before the ticket starts, and the browser asks you before its change reaches
  thimble's code. Code tickets run one at a time.
- **thimble's rules.** thimble adds no sandbox: the shell commands of your session and its agents follow your
  permission mode. thimble's plugin refuses file-tool reads and edits of its token files, edits of its records, and
  what you set to "off" in its config. View builders use your session's network. A view reaches you only as its checks
  last passed it, whatever was written in its folder since.
- **Permissions.** Every agent runs in your session's permission mode, which you change in the terminal; auto mode
  asks least ([Permissions](#permissions)). Your session's own requests show on the browser's card and in the
  terminal, and either place answers them. An agent's request shows only in the terminal; for one the browser started,
  Claude Code names the request as from the thimble plugin and offers Yes and No without an always-allow. When auto
  mode refuses an agent's call, `/permissions` → Recently denied approves it.
- **Limits.** Claude Code runs at most 20 subagents at once in a session. thimble's agents, their own subagents and side
  threads count, and thimble queues view builds and checks at the limit. Raise it with
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`; it doesn't apply while your session runs Ultracode. The agents have no
  Workflow tool, which Claude Code gives only to your session and its forks, and no Ultracode mode; its effort, xhigh,
  is one of the efforts Settings offer them. A start is refused while your session is in plan mode, where an agent would
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

## Terminal mode

`thimble mode terminal` in a folder, then `thimble` there, starts Claude Code with thimble's plugin and its terminal
renderer ([mods/thimble-term](mods/thimble-term/README.md)), with no server, port or browser. Cards and citations are
drawn under Claude's replies, and home, threads, cards, citations, labels, documents and files open in a panel beside
the chat. Views are not drawn in the terminal: a view's line says to open it in browser mode. `thimble mode terminal
--default` makes terminal mode the default for every folder that has no mode of its own, `thimble mode browser`
switches a folder back, and `thimble mode` says which mode a folder starts in. A workspace is open in one mode at a
time. Only the `thimble` command starts it; /thimble in a session you start with `claude` opens the browser workspace.
On Linux, views in terminal mode need bubblewrap (`thimble doctor` says whether it runs).

## Demo datasets

`thimble demo` opens thimble on public data. It lists three datasets with their sources, publishers and sizes, asks
before each download (`--yes` answers for all, or name the ones you want), and rebuilds each from its publisher's files
into `~/.thimble/demo/<name>` (`$THIMBLE_HOME/demo`; `--dir` moves it). thimble redistributes none of them: each is downloaded from its
publisher on your machine.

| dataset | source | download |
|---|---|---|
| `collusion-wiki` | the logs of a wiki AI agents used as a message board, from [collusion.wiki](https://collusion.wiki/) | 4.4 MB |
| `mythos-5` | the [Mythos 5 transcript](https://github.com/anthropics/mythos-5-incident-transcript) Anthropic released | 2.6 MB |
| `transluce-urlquery` | Transluce's catalog of 38,160 urlquery.net reports likely made by AI agents, from its report [Early rogue AI agent activity and attempts to hack found on urlquery.net](https://transluce.org/agent-activity) (2026-09-23) | 4.6 MB |

Each build is checked against the copy the demo's orientations ran on; a source that changed since is named in a
warning, and the Transluce build goes on with what it got. `~/.thimble/demo/SOURCES.md` lists who published each
dataset, where it was downloaded from and what each build changes. The Transluce dataset states no license.

The command then registers each folder. Where [demos/](demos/README.md) in the repository has a pre-cached
orientation for the dataset, it installs it as the folder's workspace: the cards, labels, views and report. A
pre-cache holds the orientation's outputs alone, so its Claude Code session is not included. A dataset without one
opens with no analysis yet; ask Claude in the page or the terminal for an orientation. It prints one URL and opens it
in your browser without a Claude Code session: thimble's start page, which lists the datasets you downloaded (and any
other folder open in thimble), each row opening its workspace on the dataset's main view rather than on Files; in a
workspace, the folder name in the top bar opens the same list.
The orientation's thread opens with a card that says it is a frozen demo session, with the command that starts a live
session from scratch with the dataset.

The demo is static: it starts no Claude Code session and asks nothing about one. `--attach` starts one in the
dataset's folder, once `claude auth status` says you are logged in (when you are not, it says how to log in). Without
it, it prints for each dataset the command the card gives, which starts a live session; `thimble -c` in the same folder
continues the last session later:

```bash
cd ~/.thimble/demo/collusion-wiki && thimble     # a live session: main, which you chat with in the page
cd ~/.thimble/demo/collusion-wiki && thimble -c  # later, to continue the last session there
```

A session attached to a pre-cached workspace starts fresh, with the orientation's cards and report as its context.

A workspace that holds an analysis already is left as it is unless `--replace` or `--refresh`, which archives it and
installs the pre-cache again. When it holds an older pre-cache than this thimble ships, `thimble demo` says so and
names the command, `thimble demo --refresh <dataset>`. Run again, it downloads nothing it already has.

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
until `thimble server restart`. It also updates thimble's plugin in Claude Code when its version changed. After an update
from 0.7, open the link /thimble shows once more in each browser: every browser signs in again.

## Uninstall

`thimble uninstall` asks, then removes the trust entry an install before 0.6.0 added, thimble's plugin and marketplace
when their folder is this install's, `~/.local/bin/thimble`, the lines an install before 0.8.0 added to your shell's
startup files (and a startup file it created, once nothing else is in it), and `~/.thimble`, which holds a Global
install's workspaces. `--keep-home` keeps `~/.thimble`. A clone stays where it is, and so does a downloaded headless Chromium, in
Playwright's cache folder.

To delete one workspace and keep the install, `thimble list` shows the workspaces by id and `thimble purge <id>` deletes
that one and prints each path it deleted. The folder it read and your Claude Code transcripts stay.

## Troubleshooting

- `thimble doctor` shows a checklist with the fix under each problem; `thimble doctor --verbose` adds the paths, the
  auth path and the log's recent errors.
- thimble's agents don't start, and a refused start in the browser says Claude Code's hooks modules are off: managed
  settings (`disableAllHooks`, `allowManagedHooksOnly`) turn them off, or Claude Code doesn't trust the folder.
  `thimble doctor` names the reason. Fix it, then restart Claude Code in the folder (`claude -c`) and type /thimble, or
  run `thimble -c`. Claude, its threads, cards and labels work meanwhile.
- A start or a view proposal's Accept is refused with a line about plan mode: your session is in plan mode, where an
  agent would ask before every card. Leave it with shift+tab in the terminal, then try again.
- A notice says thimble couldn't check for a view proposal: it gives the reason, with Try again and Turn off view
  proposals. When it says Claude Code isn't signed in for thimble's server, run `/login` in your terminal (or
  `claude auth login` in a shell); if you changed your sign-in after the server started, such as by exporting
  `ANTHROPIC_API_KEY`, run `thimble server restart` from that shell. Then press Try again. An accepted view that fails
  to build has a notice with Retry.
- A chat says Claude's safeguards stopped a request: rephrase or narrow the request and send it again. A notice that
  Claude's safeguards switched a reply to another model names both models; the reply, or the view proposal, came from
  the second.
- Cards are not checked, views are checked without loading their page, or screenshots are unavailable: there is no
  browser (the install's answer, or no Chrome or Edge found), or the machine lacks the headless Chromium's system
  libraries. thimble never downloads a browser by itself. `install.sh --browser system` or `--browser bundled` sets one
  up, and `thimble doctor --verbose` names the command for missing libraries. Then run `thimble restart`.
- `/thimble` is not recognized in a `claude` session: Claude Code doesn't have thimble's plugin, or it is off. `thimble
  doctor` says which. `bash <install folder>/scripts/install.sh` adds it, `/plugin` turns it on, and a session open
  since before then needs `/reload-plugins`.
- Each thimble tool call asks you: answer "Yes, and don't ask again" once for each tool, in the terminal, add the allow
  line in [Permissions](#permissions), or use auto mode.
- thimble's agents never start in a session you started with `claude`, and your shell sets a proxy: start claude with
  127.0.0.1 and localhost in `NO_PROXY` ([Start thimble](#start-thimble)).
- A change in the browser says to open the link: this browser is not signed in. Open the link /thimble shows in your
  terminal, or run `thimble up` in a shell for a new one. A link works once, for 5 minutes.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
