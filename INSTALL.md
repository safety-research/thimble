# Installing thimble

> **Installing thimble for someone, as an agent?** Follow the Installing section of [CLAUDE.md](CLAUDE.md), which
> Claude Code loads only in a session started inside the clone: run `bash scripts/install.sh --dry-run`, ask the
> person each question it lists (often there are none), and pass the flag for each of their answers. Answer none of
> them yourself.

thimble uses whichever auth path you have configured for `claude`, and starts no Claude Code session of its own: its
agents (the orientation, its critic, writers, view builds and reviews, code tickets, the checks and the card check) run
as subagents of your Claude Code session, under its permission mode and sign-in, and its single model calls (prompt
labels, label drafts, whether an extension's view fits, viewer suggestions, view proposals) run through your session's
own API client and sign-in, with no tools, so they ask nothing and leave no row in your terminal. A view proposal reads
your session's conversation. With no Claude Code session running thimble in the folder, these features say so and how
to start one. thimble tells you when `claude` is missing or not logged in.

What thimble's agents may do, and on which models, is set in `~/.thimble/config.json`: [docs/config.md](docs/config.md).
Card code runs in the notebook kernel with your network, whatever that file says. The kernel runs in Anthropic's sandbox
runtime, which the install sets up with the frontend's packages: it sees only the corpus and the workspace. Without Node
it runs in bubblewrap on Linux and with your user's access on macOS. On Linux it runs in bubblewrap only where
bubblewrap can create a sandbox, and otherwise with your user's access; `thimble doctor` says which.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.301), logged in (`claude auth status`)
  or set up with an API key or a cloud provider ([Authentication](#authentication)), with
  its hooks modules on, which thimble's agents need: managed settings with `disableAllHooks` or
  `allowManagedHooksOnly`, or a folder Claude Code doesn't trust, turn them off.
- macOS or Linux, and Python 3.12+. [uv](https://docs.astral.sh/uv/getting-started/installation/) is recommended: it
  installs the pinned versions and fetches Python when the machine has none.
- Node 20+ for custom views and for the sandbox card code and code tickets run in; a Dev install needs 20.19+, 22.13+ or 24+, which the frontend's tests need.
  install.sh checks Node first: when it is missing or too old, it says so with the command that gets Node 22 on your
  machine (nvm, fnm, Volta or Homebrew), or the folder to put first on PATH when a newer Node is installed already.

## Authentication

thimble has no login of its own and starts no Claude Code session of its own: every model call runs in your Claude
Code session, on its sign-in. Any way you sign in to Claude Code works.

- **Claude login.** Run `claude auth login`, or `/login` in a `claude` session.
- **API key.** Export `ANTHROPIC_API_KEY` in your shell before you start `claude` or `thimble`. Claude Code asks once
  whether to use the key, which then overrides a Claude login.
- **apiKeyHelper (most robust).** Put `"apiKeyHelper": "<a command that prints the key>"` in `~/.claude/settings.json`
  (your Claude Code config dir). It reaches your session whatever your shell exports, and with it every model call of
  thimble's, which runs in your session.
- **Bedrock, Vertex or Foundry.** Set `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1` or
  `CLAUDE_CODE_USE_FOUNDRY=1` and the provider's credentials, as Claude Code's docs say, before Claude Code starts.
  thimble names Anthropic's model ids, such as `claude-opus-5-5`. If your provider needs other ids, set each agent's
  model in Settings or as `agents.<agent>.model` in `~/.thimble/config.json` ([docs/config.md](docs/config.md)), or set
  `THIMBLE_<ROLE>_MODEL` (such as `THIMBLE_ORIENT_MODEL`) in the server's environment.

After you change credentials, start Claude Code again, and run `thimble server restart` so that
`thimble doctor --verbose`, which shows the auth path, reads them. When your organization's managed settings set
`forceLoginMethod`, Claude Code blocks API keys and `apiKeyHelper`: sign in with the method it names.

## Permissions

thimble follows your Claude Code session's permission mode and settings. It adds no permission rule, working directory or
sandbox to your session, whether you start it with `claude` or `thimble`, and it approves none of its own tools.

thimble's agents run in your session's permission mode. Auto mode is recommended: Claude Code's classifier judges each
call, so thimble's agents keep working while you watch the browser. Start with `claude --permission-mode auto` (or
`thimble --permission-mode auto`), press shift+tab in the terminal, or set `"permissions": {"defaultMode": "auto"}` in
`~/.claude/settings.json` (a project's settings can't choose auto). The first time Claude reads a file outside the folder
you opened, such as an agent's notes in thimble's workspaces folder, Claude Code asks once whether to allow such reads.

In Manual mode Claude Code asks before the first call of each of main's thimble tools, before every call of the tools
thimble's agents have of their own (a view's builder and reviewer, a card check, the orientation's critique and a code
ticket's agent), for which it offers no "don't ask again", before each edit thimble's agents make in their work folders
(which are outside the folder you opened), and before most commands. Every permission request shows
in the terminal, and you answer it there: the browser shows a waiting request read-only, with a line that says to answer
it in the terminal. A card check runs as a subagent with two tools of its own, and Claude Code asks before it reads its
task and before it sends its answer. A model call of thimble's (a prompt label, a label draft, a viewer suggestion, a
view proposal) has no tools and asks nothing, in any mode. While your session reports Manual mode, thimble shows a red row
above the prompt (and a red notice above the browser's chat) that says how to switch, or who turned auto mode off; it
goes when you switch, and once you dismiss it, it stays off for that workspace.

Code tickets and view builds are subagents of your session, so they run in its mode, Bypass included. An extension's
program that runs the dev agent, a job of thimble's server, follows your session's mode, but never Bypass: Settings
offers Manual and Auto for it, and a session in Bypass, or `"bypass"` in thimble's config, counts as Manual.
`thimble fix` starts no Claude Code session: it says what `thimble doctor` finds, and you make the repair in your own
Claude Code session, opened in thimble's checkout.

To be asked less, add this to `~/.claude/settings.json`, with the path from the `workspaces_dir` line of
`thimble doctor --verbose` (in a development install, also `~/.thimble/dev/trees`, made first with `mkdir -p`):

```json
{
  "permissions": {
    "allow": ["mcp__plugin_thimble_thimble", "mcp__thimble-orientation", "mcp__thimble-view-builder",
              "mcp__thimble-view-reviewer", "mcp__thimble-call", "mcp__thimble-dev-ticket", "Bash(thimble-run:*)"],
    "additionalDirectories": ["/home/you/.thimble/app/workspaces"]
  }
}
```

The `mcp__thimble-…` rules other than `mcp__plugin_thimble_thimble` are the only way to stop the asks of the agents'
own tools. `additionalDirectories` lets Claude read thimble's workspaces without asking; edits there still ask.

`Bash(thimble-run:*)` lets Claude run a card's code, or a code label, with `thimble-run` without asking. That code runs
with your access, as any command Claude runs does, so leave this rule out if you want to see each run first.

What protects what:

| | thimble, always | Claude Code's sandbox (optional) | Your permission mode |
|---|---|---|---|
| thimble's token files | Claude's file tools can't read or edit them; once thimble is on, a shell command that names them literally is refused | Shell commands can't read or write them | A shell command that reads them asks (Manual) or is judged (auto) |
| A sign-in code | Only in a redirect file or a link file that only your account can read; never in a command line, a log, the terminal's output or Claude's context; works once, for 60 s (5 minutes for a link you copy) | Shell commands can't read the files | Shell commands that try follow your mode |
| Reading or acting as you in the browser | Needs this browser's sign-in, which the browser sends to thimble alone; each new sign-in shows a notice with Sign it out | Shell commands can't make a sign-in | Shell commands that try follow your mode |
| Another account on this computer | Can't read your codes; on Linux a sign-in from its connection is refused; reads nothing without a sign-in | — | — |
| A tab whose server stopped | Stops, and sends its sign-in to nothing that can't prove it is thimble's server | — | — |
| Permission requests | Answered in the terminal only; the browser shows them read-only | — | Your session's mode |
| The folder you opened | File-tool edits refused when `data` is `"off"` | Shell commands can still write it | Edits ask (Manual), are judged (auto) or run (Bypass) |
| thimble's own jobs | Never in Bypass | — | Follow your session's mode, Bypass as Manual |
| Code tickets and view builds | You approve each change before it reaches thimble's code | Their shell commands are contained like yours | Your session's mode, Bypass included |

In every mode, thimble's plugin refuses some calls of Claude's file tools (Read, Edit, Write, Grep, Glob and the others),
in your session and in its agents: reads and edits of thimble's token files (`server.json`, `session.key`, `paired.json`
and `links/` in `~/.thimble`), edits of thimble's records (in the workspace, and the permission modes it keeps in
`~/.thimble`), and the edits and web calls you turned off in thimble's config (`data` or `web` set to `"off"`,
[docs/config.md](docs/config.md)). Apart from the token files, thimble does not limit shell commands: they follow your
permission mode, as in any Claude Code session. thimble's keys in the terminal panel act as you, as the terminal itself
does. To keep Claude from editing the folder you open, add a deny rule to your Claude Code settings, such
as `"deny": ["Edit(//path/to/folder/**)"]` (two slashes for a path from `/`). To keep shell commands away from
thimble's token files too, turn on Claude Code's sandbox (`/sandbox`, or in your settings) and add:

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.thimble/server.json", "~/.thimble/session.key", "~/.thimble/paired.json", "~/.thimble/links",
                   "~/.thimble/open"],
      "allowWrite": ["/home/you/.thimble/app/workspaces"]
    }
  }
}
```

The `allowWrite` entry lets thimble's agents write their notes. `/thimble browser` starts thimble's server outside the
sandbox. `thimble doctor` says whether the sandbox is on.

### Signing in

thimble's browser page opens on a press: `/thimble browser` in Claude Code, `o` or `↗` in thimble's terminal panel, `↗` on a
card, or the `thimble` command. The press starts thimble's server if none runs, makes this session the one the page
follows, and opens the page on what you pressed, signed in. The terminal keeps working, and closing the tab changes
nothing. A browser still signed in from an earlier session needs no press: when it opens the page or sends a message
while thimble's server runs, the page follows this session, and shows its permission requests.

How the press signs the browser in. It asks the server for a one-time code, which works once, for 60 seconds. It writes
the page's address with the code into a file in `~/.thimble/open/`, and gives your browser opener (`$BROWSER`, `open`,
`xdg-open`, `gio open` or `wslview`) the file's path. The browser opens the file, which forwards it to the page, and the
page trades the code for a cookie: the server deletes the file and the code then works no more. When the default
browser is a snap or a flatpak, which can't read hidden folders, and in VS Code's remote terminal, the opener gets the
address itself; thimble's log says so, without the code. In a remote terminal (SSH, Eternal Terminal, or no display),
thimble opens no browser. `/thimble browser` then says so, and a row above the prompt says what to do: run the tunnel
command, `ssh -N -L <port>:127.0.0.1:<port> <your ssh host>`, on your own computer (set `THIMBLE_SSH_HOST` to fill in
the host), then press **copy link**, which copies a one-time link that works for 5 minutes, and open the link in your
browser there. The row goes once a browser signs in with it. On Claude Code's main screen, which takes no clicks, the
panel opens on that row, and `2` copies the link. `thimble open` in a shell prints where the page runs, never the code.

Same user only. A sign-in code is only in two places: the file the press writes (readable by your account alone, in a
folder only your account can open, in `~/.thimble`, which only your account can open) and, for a remote terminal, the
link in `~/.thimble/links/<session>.json` (readable by your account alone). It is never in a command line, which other
accounts on the computer can see, nor in thimble's output, logs, notices or Claude's context. So another account on the
same computer can't learn a code, and a code works once. On Linux, thimble's server also asks the system which account
owns the connection a sign-in comes on, and refuses one from another account; an SSH or VS Code forward connects as
your own account. thimble's server answers only on this computer (127.0.0.1), and only to a signed-in browser or to
thimble's own programs, since another account can reach the port too.

The sign-in is a cookie that the browser sends to thimble and to no other program. A browser sends a cookie for
127.0.0.1 or localhost to every server on that address, whatever its port, so thimble's cookie is scoped to a path that
holds a random key, which only thimble's page in this browser knows. A web page that another program on this computer
serves, such as a project's development server, never gets the cookie. The cookie lasts 30 days and each use renews it;
a browser not used for 30 days signs in again. If this browser loses the page's stored data (you clear the site's data,
use a private window, or the browser removes data it has not used for some days), the page shows the sign-in line:
type `/thimble browser` in your Claude Code terminal, or press `o` in thimble's panel.

When the Claude Code session ends, the page stops: it shows that it stopped and how to open it again, and it sends
nothing more. A tab whose server went away first asks the address it reconnects to to prove, without any credential,
that it is the same thimble server; another program that later uses the port can't, and the page stops without sending
it the cookie. After 6 failed reconnects the page stops too. A demo (`thimble demo`) needs no session: while its page
is open, the server stays up when the last session ends, and a demo page that stops says to run `thimble demo` again.

Each new sign-in shows a notice with **Sign it out**, in the browser and above the prompt in your terminal (only in the
Claude Code session it happened in: a later session's terminal does not show it again); a terminal without thimble's
panel shows a line under Claude's next reply instead. The browser that signed in can't dismiss its
own notice. If a sign-in was not you, click Sign it out, or run `thimble unpair` in a shell, which signs out every
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
  Manual mode and no "don't ask again" is offered. Add `mcp__plugin_thimble_thimble` and the agents' own servers
  (`mcp__thimble-orientation`, `mcp__thimble-view-builder`, `mcp__thimble-view-reviewer`, `mcp__thimble-call`,
  `mcp__thimble-dev-ticket`) to managed `permissions.allow`.
- **`disableSideloadFlags`** makes Claude Code reject `--plugin-dir`. Sessions that load the installed plugin are not
  affected. Extension programs can't start.
- **`allowManagedModsOnly`** keeps thimble's terminal UI from loading. `/thimble` and `/thimble browser` still work, through
  the skill, but Claude's first read of a data file does not turn thimble on, and the terminal draws no cards or panel.
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

- installs the Python and Node packages and a browser for screenshots;
- adds thimble's plugin to Claude Code with Claude Code's own commands: `claude plugin marketplace add <install
  folder>`, then `claude plugin install --scope user thimble@<name>` (`thimble-local` for a release, `thimble` for a
  clone). Claude Code records the plugin in `~/.claude/settings.json` (`enabledPlugins`) and `~/.claude/plugins`.
  `/thimble` then works in any `claude` session. A re-run updates the plugin when its version or its files changed and
  leaves it on or off as you set it. When Claude Code has another install's thimble plugin, or the one from GitHub, install.sh
  leaves it and prints the commands that switch it. Like any Claude Code plugin, thimble is then on in every session;
  `/plugin` turns it off, everywhere or for one project;
- links the `thimble` command into `~/.local/bin`, and when that folder is not on your PATH (or `THIMBLE_HOME` is not
  `~/.thimble`), prints the line to add to your shell's startup file so that a new terminal finds it;
- runs `thimble doctor`.

install.sh changes nothing else in your Claude Code setup: no permission rule, no trust, no other setting. It installs
no system package and never runs sudo.

install.sh opens with one screen: what it found (Claude Code, Python or uv, Node, a browser, and on Linux whether card
code and terminal-mode views can run in bubblewrap), what it installs where and about how big, and what it changes in
your Claude Code setup. It asks nothing. Then it prints a line per step: ✓ when the step is done, ! when it needs you,
with what fixes it under it. Every command it runs, with its output, goes to `~/.thimble/install.log`. A re-run that
finds nothing to do says so in one line, and one that changes something shows only what changed. After a failed
install, run it again: it makes the Python environment again when the failed run left it unfinished or broken. It
removes only an environment it made itself; for one you made, it says what to do.

**A browser for screenshots.** thimble takes screenshots of the cards and views it draws, to check how they look.
install.sh uses a Chrome or Edge it finds that starts under automation, and downloads nothing. Otherwise it downloads
Playwright's headless Chromium (about 210 MB from Microsoft's Playwright CDN, cdn.playwright.dev, 650 MB on disk) into
Playwright's cache. The opening screen says which, in one line. `--browser off` takes no screenshots and downloads
nothing; `--browser bundled` or `--browser system` picks one of the two. The flag is kept, so an update keeps it.

`install.sh --dry-run` prints the opening screen and changes nothing; `--verbose` also prints every command.

## Start thimble

Start Claude Code in a folder of transcripts or other data, as usual:

    cd <folder>
    claude

thimble is a regular Claude Code plugin: once installed it is on from the start of every session, in every folder but
the ones it refuses (your home folder, `/` and the folders above them). The line above the prompt shows it is on. To turn
it off, use `/plugin` (everywhere, or for one project). `/thimble` opens its panel in the terminal.

Once on, Claude makes cards and checked citations, which the terminal draws under its replies, and one dim line under an
answer that read data says how much of the data Claude's tool calls saw (Coverage). The line above the prompt sums up
what is new; a press on an item opens thimble's panel at that section: Coverage, Citations, Labels, Threads, Views and
Checks, then Cards, Documents and Files. In Claude Code's fullscreen layout the panel opens on the right (from 110
columns when you open it, from 144 when thimble opens it), and above the prompt below that. On Claude Code's main
screen (the classic renderer) it always opens above the prompt, and nothing takes a click there: the line above the
prompt then ends with `/thimble to use these with keys`. `/thimble` opens home, which lists the rows above the prompt
first (a view proposal, notices, the browser's sign-in row); Enter on one shows its actions on number keys.
`/thimble coverage`, `citations`, `labels`, `threads` and `checks` open the line's sections.

`/thimble browser`, or `o` in the panel, opens the browser workbench on the same session ([Signing in](#signing-in)): the
chat, the canvas, the File browser, labels, views and report writing. The report is written and edited in the browser;
the terminal panel shows documents read-only. In a session open before the install, run `/reload-plugins` first.

The `thimble` command starts `claude` in the folder (all its arguments pass on) and opens the browser workbench at the
start; `thimble -c` continues the last session. It adds 127.0.0.1 and localhost to `NO_PROXY` for the session. If you
start `claude` yourself and your shell sets `HTTP_PROXY` or `HTTPS_PROXY`, start it with
`NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"`, or thimble's plugin may not reach its server; thimble's panel
says so when it sees a proxy.

Each feature can be turned off: `/config` → thimble, or the browser's Settings, has a switch for each ("View
proposals", "Labels", "Checks", "Citation marks", "Coverage", "Card check"), and the two
places show the same switches ([docs/config.md](docs/config.md#features)).

Don't move one of thimble's agents to the background (← or "Move to background"): thimble loses track of a moved agent.
thimble says so, in the terminal and in the browser, when `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL` or
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, since each would change the models and efforts thimble's Settings give its
agents.

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

On a Mac with Apple silicon, use a native Python: an Intel one, which a terminal under Rosetta finds first, gets no
wheel for some packages and builds them from source, which needs Xcode. With uv, write
`--python cpython-3.12-macos-aarch64-none` in place of `--python '>=3.12'` below, and add `--no-build` to its install
commands.

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

On Linux, card code runs in a sandbox, and the terminal shows views, only where bubblewrap can create a sandbox:
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
  update thimble` and `claude plugin update thimble@thimble`. To update by hand: get the new folder and keep `workspaces/`, do steps 2 and 3 again, run `claude plugin
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
  propose takes one model call over your session's conversation, which uses no tools, runs on its model and sign-in
  and reads most of the conversation from the prompt cache. In the terminal the proposal is a row above the prompt
  with accept, reject and don't ask again. Settings'
  View proposals switch and `/config` → thimble → "View proposals" turn them on and off
  ([docs/config.md](docs/config.md)).
- **Models and efforts.** Each agent runs on exactly the model and effort that Settings name for it, and a change
  applies to the next start, with no restart. `/thimble:orient --model <model> --effort <level>` and the start tools
  take a model and an effort for one run. The orientation's own subagents run on the "orientation subagents" row
  when it starts them as `thimble:orient-helper`; one it starts as another type runs on the orientation's own model and
  effort. A follow-up runs on its run's model and effort, except one typed in the terminal to an agent started from
  the browser after that role's settings changed, which runs on the new ones; its thread says so. The `thimble` command
  doesn't change them: thimble says so for each of `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL` and
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` that is set, in the terminal and in the browser.
- **Ending.** When an agent finishes, its report reaches your session, and Claude answers in one short line; the result
  is in the terminal and the browser. Quitting Claude Code stops every agent, and nothing restarts on its own:
  `claude -c` (or `thimble -c`) and a message in an agent's thread continue it, and Retry starts a view build, review or
  check again. An orientation from an earlier session, not the one `-c` continues, goes on only in that session:
  `claude -r <its session id>`, which its thread shows. A finished agent leaves the ↓ tray; `/tasks` opens it. Don't
  move one of thimble's agents to the background, since thimble loses track of a moved agent. `/clear` keeps the agents
  running, but it stops the orientation's current command, which it may run again or skip.
- **Failures.** When one of thimble's agents fails, a notice tells you where you are looking: in the browser above the
  reply box of the chat you have open, main's or a thread's, and in the terminal in the rows above the prompt, with a
  toast. It
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
  Ask Claude to fix it, or ask Claude in the chat. Its agent, `thimble:dev-ticket`, works in a git worktree of thimble's
  code, which it edits from your session, in your session's permission mode; its checks run in thimble's sandbox
  runtime where it can run, and otherwise thimble asks you before the ticket starts, and the browser asks you before its
  change reaches thimble's code. Code tickets run one at a time.
- **thimble's rules.** thimble adds no sandbox: the shell commands of your session and its agents follow your
  permission mode. thimble's plugin refuses file-tool reads and edits of its token files, edits of its records, and
  what you set to "off" in its config. View builders use your session's network. A view reaches you only as its checks
  last passed it, whatever was written in its folder since.
- **Permissions.** Every agent runs in your session's permission mode, which you change in the terminal; auto mode
  asks least ([Permissions](#permissions)). Every request is answered in the terminal; the browser shows a waiting
  request read-only. For an agent the browser started, Claude Code names the request as from the thimble plugin and
  offers Yes and No without an always-allow. When auto
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

## The terminal and the browser

thimble 0.9.0 has no modes. thimble's terminal UI, which draws cards, citations, the coverage line and the panel, is
always there once thimble is on, and the browser workbench joins on a press ([Signing in](#signing-in)). Before the
press, thimble runs without a server: the tools run in Claude Code's own processes. After the press, the server runs
for the rest of the session. `thimble mode` from earlier versions only says so and changes nothing. A view built from
the terminal draws in the terminal, and the browser builds its page the first time it opens it; on Linux, views in the
terminal need bubblewrap (`thimble doctor` says whether it runs).

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

The command then registers each folder. Where [demos/](demos/README.md) in the repository has a pre-cached orientation
for the dataset, it installs it as the folder's workspace: the cards, labels, views and report. A pre-cache holds the
orientation's outputs alone, so its Claude Code session is not included. A dataset without one opens with no analysis
yet; to run one, start a session in its folder (`cd ~/.thimble/demo/<name> && thimble`) and ask Claude for an
orientation. It prints one URL and opens it in your browser without a Claude Code session: thimble's start page, which
lists the datasets you downloaded (and any other folder open in thimble), each row opening its workspace on the
dataset's main view rather than on Files; in a workspace, the folder name in the top bar opens the same list.
Until a session attaches, each dataset's workspace is a demo page: the top bar shows a Demo tag, everything that works
without Claude works, and the orientation's thread says it ran in advance. The chat's composer is disabled, and
hovering it says "This is a demo and thimble isn't connected to a live Claude Code session." Any other action that
needs Claude shows the same note in the chat.

The product tour (offered on the first launch, and under Settings, Take the tour) runs in a demo dataset's workspace,
never over your own files: it opens that workspace in a frame over the page, under a banner that says it is example
data, with Exit tour, and when it ends your folder is as you left it. Without a demo dataset installed, the tour sets
up a small example workspace from files every install ships (`example-timeline`, with no download) and runs there.

The demo is static: it starts no Claude Code session and asks nothing about one. `--attach` starts one in the
dataset's folder, once `claude auth status` says you are logged in (when you are not, it says how to log in). Without
it, it prints for each dataset the command that starts a live session there; `thimble -c` in the same folder
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
until `thimble server restart`. It also updates thimble's plugin in Claude Code when its version changed. When the
version is the same but the plugin's files changed, as after a `git pull` between releases, and Claude Code loads a copy
of the plugin, the update uninstalls and installs the plugin again with Claude Code's own commands, keeping its options
and its on or off. When Claude Code reads the plugin from the install folder itself, nothing needs updating. Either way
the update says what it did, and a `claude` session open since before uses the new plugin after `/reload-plugins`.
After an update from 0.7, every browser signs in again: type `/thimble browser` in each session.

`thimble update --dry-run` shows what the update would do and changes nothing: the `git pull` it would run, or the
release zip's check, then the install's own dry run (what it would install where, and the question it would ask). In a
Dev install that dry run reads the files as they are before the pull.

## Uninstall

`thimble uninstall` asks, then removes the trust entry an install before 0.6.0 added, thimble's plugin and marketplace
when their folder is this install's, `~/.local/bin/thimble`, the lines an install before 0.8.0 added to your shell's
startup files (and a startup file it created, once nothing else is in it), and `~/.thimble`, which holds a Global
install's workspaces. Before it asks, it lists what it removes and what stays. `--keep-home` keeps `~/.thimble`: your
settings, the demo datasets you downloaded, the logs and thimble's own state, and in a Global install thimble itself with
your workspaces. It still removes the browsers' sign-in files and keys in it, so every browser signs in again, and the
markers of the sessions and folders thimble was on in. A Dev install keeps your workspaces in the clone's `workspaces/`
folder, and the clone stays where it is. So does a downloaded headless Chromium, in Playwright's cache folder
(`~/.cache/ms-playwright`; on macOS `~/Library/Caches/ms-playwright`), which other programs may use too.

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
  proposals. An accepted view that fails to build has a notice with Retry.
- A notice says Anthropic's API refused Claude Code's sign-in, or that its credit balance is too low: it names the login
  Claude Code uses, as `claude auth status` reports it. An API key your shell exports, such as `ANTHROPIC_API_KEY`,
  overrides a `/login`: quit, unset it (in your shell's startup file too) and start claude again in a new terminal,
  or run `/login`. Then press Try again where the notice has it.
- A chat says Claude's safeguards stopped a request: rephrase or narrow the request and send it again. A notice that
  Claude's safeguards switched a reply to another model names both models; the reply, or the view proposal, came from
  the second.
- Cards are not checked, views are checked without loading their page, or screenshots are unavailable: there is no
  browser (`--browser off`, or its download failed), or the machine lacks the headless Chromium's system libraries.
  `install.sh --browser system` or `--browser bundled` sets one up, and `thimble doctor --verbose` names the command for
  missing libraries. Then run `thimble restart`.
- `/thimble` is not recognized in a `claude` session: Claude Code doesn't have thimble's plugin, or it is off. `thimble
  doctor` says which. `bash <install folder>/scripts/install.sh` adds it, `/plugin` turns it on, and a session open
  since before then needs `/reload-plugins`.
- Each thimble tool call asks you: answer "Yes, and don't ask again" once for each of main's tools in the terminal, add
  the allow line in [Permissions](#permissions), which is the only way for the tools of thimble's agents, or use auto
  mode.
- thimble's agents never start in a session you started with `claude`, and your shell sets a proxy: start claude with
  127.0.0.1 and localhost in `NO_PROXY` ([Start thimble](#start-thimble)).
- The browser says it isn't signed in: type `/thimble browser` in your Claude Code terminal, or press `o` in thimble's
  panel. A code works once, for 60 seconds (a link you copy, for 5 minutes).
- The browser did not open on `/thimble browser`: the panel shows a notice with **copy link**; open the link in the browser
  of your choice. Over SSH, run the tunnel command the panel shows on your own computer first.
- The page says it stopped: its Claude Code session ended, or the server stopped. Type `/thimble browser` in the terminal
  to open it again.
- To report a problem, run `thimble feedback "<what went wrong>"`. It writes a zip of the logs, chats and Claude
  Code transcripts, with keys removed, and says where to send it. The chats and transcripts quote your corpus.
