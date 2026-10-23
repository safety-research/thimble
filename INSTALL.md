# Installing thimble

thimble has two products: the terminal plugin for Claude Code, and the browser workbench, a web page that runs on your
machine. `scripts/install.sh` installs one or both.

## What you need

For both:

- **macOS or Linux.**
- **Node.js** on your `PATH`: 22.18 or later for the plugin, 22.12 or later for the browser workbench. Check with
  `node --version`.

- **bubblewrap, socat and ripgrep**, on Linux, for Anthropic's [sandbox
  runtime](https://github.com/anthropics/sandbox-runtime), which the code Claude writes for a card runs in (on Ubuntu:
  `sudo apt-get install bubblewrap socat ripgrep`). The install says which are missing, with the one command for your
  system. macOS has its own sandbox.

For the terminal plugin:

- **Claude Code** 2.1.307 or later. Check with `claude --version`.
- **Python 3.10 or later**, on `python3` (or the Python that `THIMBLE_PYTHON` names). thimble's kernel needs nothing
  beyond the standard library.
- **npm**, which comes with Node.js: the plugin installs the sandbox runtime with it, about 10 MB, in `~/.thimble/srt`.

For the browser workbench:

- **[uv](https://docs.astral.sh/uv/)** 0.8 or later, which installs the server's Python packages, and a Python 3.11
  or later when you have none.
- **Credentials for the Claude API**: an API key, or Workload Identity Federation. You give them when it runs; see
  [browser/README.md](browser/README.md#credentials). The browser workbench does not use your Claude Code login.
- **About 1 GB of disk** in the checkout: the page's packages, the server's Python packages, the sandbox runtime and
  the built page.

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

The simplest way is to ask Claude Code:

```
claude "install thimble from https://github.com/safety-research/thimble"
```

Claude asks whether you want the browser workbench too, runs the script below, helps you fix what is missing, and
says how to use what it installed. To do it yourself:

```
git clone https://github.com/safety-research/thimble
cd thimble
scripts/install.sh
```

The script first checks what the products need and says what is missing, one line each; then it installs nothing
until you fix it and run it again. Then it:

1. adds the marketplace `safety-research/thimble` to Claude Code and installs the plugin `thimble@thimble` from it.
   Without the `claude` command, it prints the two commands to run once Claude Code is installed. Then it installs
   the sandbox the plugin's cards run in: the version of Anthropic's sandbox runtime the plugin pins, with `npm ci`, in
   `~/.thimble/srt`. It starts the card runner in it once, and says whether it works; on Linux, when bubblewrap, socat
   or ripgrep is missing, it prints the one command that installs them (it never runs `sudo` itself).
2. installs the browser workbench (thimble 0.8's browser mode) from the checkout: the server's Python packages (`uv sync`
   in `browser/backend`), and the page with the sandbox runtime (`npm ci` and a build in `browser/frontend`).
3. writes a `thimble-browser` launcher in `~/.local/bin` (`--bin-dir DIR` puts it elsewhere), and says when that folder
   is not on your `PATH`.
4. asks how the browser workbench reaches Claude: 1 an Anthropic API key (the default; you paste it, and it is kept in
   `~/.thimble-browser` readable by you alone), 2 your Claude Code sign-in (it shows that this launches headless Claude
   Code sessions in the background and asks you to confirm), or 3 Workload Identity Federation (the path of its config
   file). It checks the choice with one small call.
5. says how much disk space the browser workbench takes, and whether the sandbox works on this machine.

Options:

- `--no-browser`: the terminal plugin only.
- `--no-plugin`: the browser workbench only.
- `--no-setup`: do not ask how the browser workbench reaches Claude; the page asks at its first start, and
  `thimble-browser --setup` asks again.
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
thimble from it. The plugin installs its sandbox runtime at the first session start, in the background; when the
sandbox cannot work here, the line above the prompt says why and the command that fixes it.

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

`examples/sample/runs.csv` in the checkout holds 40 made-up nightly test runs to try it on. Run `claude` in
`examples/sample`, and ask: "Did the failures start after the config change? Show it as a card."

The browser workbench:

1. Run `thimble-browser` in a folder of files. It starts the server on 127.0.0.1, port 8300 or the next free one, and
   prints the page's sign-in link. The installer asked how it reaches Claude (an API key, Workload Identity
   Federation, or your Claude Code sign-in); when it did not, the page asks at its first start.
2. Open the link, and ask in the page's chat: "How many runs failed, and why?" Claude answers with a card whose claims
   cite the files.

## Settings

- **The plugin's features.** Citations, Cards (with `v`), and Labels and coverage on the bar can each be turned on or
  off: click `thimble` at the left of the bar or run `/thimble-settings`. Claude Code keeps the values in its settings
  (`pluginConfigs`). With Citations off, the checker makes no model call.
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

- **No line above the prompt, and no citations.** The plugin is not loaded in this session. Check that the folder is
  trusted and that thimble is enabled in `/plugin`. Managed settings that set `disableAllHooks` turn thimble off.
- **`thimble: command not found` in Claude's Bash calls.** The same: the plugin is not loaded.
- **A line above the prompt says something failed.** It says what failed and why. `f` asks Claude to fix it in thimble
  for you, and `F` writes a report only.
- **"Cards cannot draw: cards run only in Anthropic's sandbox runtime, which cannot start here".** Cards never run
  without the sandbox. The line says why and gives the fix: on Linux, the command that installs bubblewrap, socat or
  ripgrep, or, on a Linux whose AppArmor keeps bubblewrap from making namespaces, the command that allows it; when npm
  cannot reach its registry to install the sandbox, `npm ping` shows why. The next card tries again, with no new
  session. To test the sandbox by hand, run `node <plugin>/sandbox/setup.mjs --probe`, where
  `<plugin>` is the installed plugin's folder, `~/.claude/plugins/cache/thimble/thimble/<version>`.

The browser workbench:

- **`thimble-browser: command not found`.** `~/.local/bin` is not on your `PATH`. Add it, or run the launcher by its
  full path.
- **Cards say that code does not run.** The sandbox does not work here, and the card says why. On Linux, install
  bubblewrap; on a Linux whose AppArmor keeps bubblewrap from making namespaces, the card says how to allow it.
  `thimble-browser --check-sandbox` tests it again.
- **The chat says the credentials failed (401).** It names the credentials it used and the time. Check them in
  Settings; whoever manages the credentials can see the reason on the admin side.
