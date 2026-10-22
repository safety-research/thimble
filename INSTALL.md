# Installing thimble

thimble has two products: the terminal plugin for Claude Code, and the browser workbench, a web page that runs on your
machine. `scripts/install.sh` installs one or both.

## What you need

For both:

- **macOS or Linux.**
- **Node.js** on your `PATH`: 22.18 or later for the plugin, 22.12 or later for the browser workbench. Check with
  `node --version`.

For the terminal plugin:

- **Claude Code** 2.1.307 or later. Check with `claude --version`.
- **Python 3.10 or later**, on `python3` (or the Python that `THIMBLE_PYTHON` names). thimble's kernel needs nothing
  beyond the standard library.

For the browser workbench:

- **[uv](https://docs.astral.sh/uv/)** 0.8 or later, which installs the server's Python packages, and a Python 3.11
  or later when you have none.
- **bubblewrap**, on Linux, for the sandbox that Claude's code runs in (`sudo apt install bubblewrap`). macOS has its
  own sandbox.
- **Credentials for the Claude API**: an API key, or Workload Identity Federation. You give them when it runs; see
  [browser/README.md](browser/README.md#credentials). The browser workbench does not use your Claude Code login.
- **About 600 MB of disk** in the checkout: the page's packages (about 290 MB), the server's Python packages (about
  280 MB), the sandbox runtime and the built page.

## If you used thimble 0.10 or earlier

thimble 0.11 no longer runs Claude's queries itself, so it needs no pandas: you can delete the Python that 0.10 made in
`~/.thimble/python`. The `thimble/` folder in a data folder keeps only labels now; 0.11 reads none of its other files
(the queries, the cards and the record of each reply). 0.11 keeps its own records in new folders of `~/.thimble`, so
you can also delete `~/.thimble/lean`.

## If you used thimble 0.9

thimble 0.10 replaces 0.9, whose browser workbench worked beside a Claude Code session and had its own `thimble`
launcher. Remove 0.9 first:

```
thimble uninstall
```

If that command is gone already, remove the old launcher by hand (`rm ~/.local/bin/thimble`), and remove the old
plugin with `/plugin` in Claude Code. An old launcher left on your `PATH` would answer in place of the new `thimble`
command. The 0.10 browser workbench has a launcher of another name, `thimble-browser`.

## Install

```
git clone https://github.com/safety-research/thimble
cd thimble
scripts/install.sh
```

The script first checks what the products need and says what is missing, one line each; then it installs nothing
until you fix it and run it again. Then it:

1. adds the marketplace `safety-research/thimble` to Claude Code and installs the plugin `thimble@thimble` from it.
   Without the `claude` command, it prints the two commands to run once Claude Code is installed.
2. installs the browser workbench from the checkout: the server's Python packages (`uv sync` in `browser/server`), the
   page (`npm ci` and a build in `browser/frontend`), and the sandbox runtime (`npm ci` in `browser/server/sandbox`).
3. writes a `thimble-browser` launcher in `~/.local/bin` (`--bin-dir DIR` puts it elsewhere), and says when that folder
   is not on your `PATH`.
4. says how much disk space the browser workbench takes, and whether the sandbox works on this machine.

Options:

- `--no-browser`: the terminal plugin only.
- `--no-plugin`: the browser workbench only.
- `--local`: the plugin from this checkout in place of GitHub, to try a branch. Claude Code then loads the plugin from
  the checkout's `plugin/` folder.

You can run it again at any time. It installs again what it installed, and updates the plugin and the browser
workbench to what the checkout and the marketplace hold now.

### The plugin without a clone

```
claude plugin marketplace add safety-research/thimble
claude plugin install thimble@thimble
```

You can do the same inside Claude Code: run `/plugin`, add the marketplace `safety-research/thimble`, and install
thimble from it.

### Python

The plugin runs `python3`. To use another Python 3.10 or later, set `THIMBLE_PYTHON` before you start Claude Code, for
example `export THIMBLE_PYTHON="$HOME/venvs/data/bin/python"`, or add it under `"env"` in `~/.claude/settings.json`.
thimble installs nothing into any Python. The code Claude writes to read your data runs with the Python it chooses, as
in any Claude Code session.

## Check that it works

The terminal plugin:

1. Go to a folder with a CSV or JSONL file and run `claude`. The first time, Claude Code asks whether you trust the
   folder. thimble works only in folders you trust.
2. Ask: "How many rows does this file have per value of its first column? Show it as a card."
3. Claude answers with a card, and the numbers in its answer are underlined in purple, each with a spinner until the
   checker is done. The line above the prompt starts with `thimble` and says how much of the folder Claude has read.

The browser workbench:

1. Run `thimble-browser --check-sandbox`. It prints one line per check of the sandbox, each `pass`.
2. Run `thimble-browser` in a folder of files, or `thimble-browser browser/samples/agent-runs` in the checkout. The
   server prints a sign-in link and opens it, on 127.0.0.1 port 8000 or the next free one.
3. In Settings, give your credentials. Ask in the chat: "How many runs failed, and why?" Claude answers with a card,
   and the numbers in its answer are links.

## Settings

- **The plugin's features.** Marks, Cards (with `v`), and Labels and coverage on the bar can each be turned on or
  off: click `thimble` at the left of the bar or run `/thimble-settings`. Claude Code keeps the values in its settings
  (`pluginConfigs`). With Marks off, the checker makes no model call.
- **Permissions.** Claude runs `thimble` through its Bash tool, so your permission mode applies to it as to any other
  command. To let it run without asking, add `"Bash(thimble:*)"` to `permissions.allow` in your Claude Code settings.
- **`THIMBLE_HOME`** sets where the plugin keeps its per-session files (default `~/.thimble`).
- **The browser workbench's Settings**, in the page: the credentials, the model, the effort, and each feature on or
  off. `THIMBLE_BROWSER_HOME` sets where it keeps its workspaces (default `~/.thimble-browser`).

## Update and uninstall

To update both, pull the checkout and run `scripts/install.sh` again. The plugin alone:

```
claude plugin update thimble@thimble
claude plugin uninstall thimble@thimble
```

To remove the browser workbench, delete `~/.local/bin/thimble-browser` and the checkout. Uninstalling leaves your data
alone. To remove what thimble wrote, delete the `thimble/` folder in each data folder you used the plugin in,
`~/.thimble`, and `~/.thimble-browser`.

## When something does not work

The terminal plugin:

- **No line above the prompt, and no marks.** The plugin is not loaded in this session. Check that the folder is
  trusted and that thimble is enabled in `/plugin`. Managed settings that set `disableAllHooks` turn thimble off.
- **`thimble: command not found` in Claude's Bash calls.** The same: the plugin is not loaded.
- **A line above the prompt says something failed.** It says what failed and why. `f` asks Claude to fix it in thimble
  for you, and `F` writes a report only.

The browser workbench:

- **`thimble-browser: command not found`.** `~/.local/bin` is not on your `PATH`. Add it, or run the launcher by its
  full path.
- **Cards say that code does not run.** The sandbox does not work here, and the card says why. On Linux, install
  bubblewrap; on a Linux whose AppArmor keeps bubblewrap from making namespaces, the card says how to allow it.
  `thimble-browser --check-sandbox` tests it again.
- **The chat says the credentials failed (401).** It names the credentials it used and the time. Check them in
  Settings; whoever manages the credentials can see the reason on the admin side.
