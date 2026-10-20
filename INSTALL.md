# Installing thimble

## What you need

- **Claude Code** 2.1.301 or later. Check with `claude --version`.
- **macOS or Linux.**
- **Python 3.10 or later, with pandas.** thimble's kernel runs on `python3`. Check with `python3 -c "import pandas"`;
  if that fails, see [Python](#python) below.
- **Node.js 22 or later** on your `PATH`. thimble draws each card in a Node process. Check with `node --version`.

## If you used thimble 0.9

thimble 0.10 replaces 0.9, which had a browser workbench and its own `thimble` launcher. Remove 0.9 first:

```
thimble uninstall
```

If that command is gone already, remove the old launcher by hand (`rm ~/.local/bin/thimble`), and remove the old
plugin with `/plugin` in Claude Code. An old launcher left on your `PATH` would answer in place of the new `thimble`
command.

## Install

```
claude plugin marketplace add safety-research/thimble
claude plugin install thimble@thimble
```

You can do the same inside Claude Code: run `/plugin`, add the marketplace `safety-research/thimble`, and install
thimble from it.

### Python

thimble runs `python3` unless you tell it otherwise. If that Python has no pandas, do one of these:

- Install pandas for it: `python3 -m pip install --user pandas`.
- Point thimble at another Python that has pandas. Set `THIMBLE_PYTHON` before you start Claude Code, for example
  `export THIMBLE_PYTHON="$HOME/venvs/data/bin/python"`, or add it under `"env"` in `~/.claude/settings.json`.

## Check that it works

1. Go to a folder with a CSV or JSONL file and run `claude`. The first time, Claude Code asks whether you trust the
   folder. thimble works only in folders you trust.
2. Ask: "How many rows does this file have per value of its first column? Show it as a card."
3. Claude runs `thimble` commands, then answers. A card appears under the answer, and the line above the prompt reads
   `thimble  v visualize · s squeeze · …`.

## Settings

- **The side agent** (Observer) reads each reply after Claude writes it. It makes one model call per reply. To turn it
  off: run `/plugin configure thimble@thimble` in Claude Code and set Observer to off.
- **Permissions.** Claude runs `thimble` through its Bash tool, so your permission mode applies to it as to any other
  command. To let it run without asking, add `"Bash(thimble:*)"` to `permissions.allow` in your Claude Code settings.
- **`THIMBLE_HOME`** sets where thimble keeps its per-session files (default `~/.thimble`).

## Update and uninstall

```
claude plugin update thimble@thimble
claude plugin uninstall thimble@thimble
```

Uninstalling leaves your data alone. To remove what thimble wrote, delete the `thimble/` folder in each data folder you
used it in, and `~/.thimble`.

## When something does not work

- **No line above the prompt, and no cards.** The plugin is not loaded in this session. Check that the folder is
  trusted and that thimble is enabled in `/plugin`. Managed settings that set `disableAllHooks` turn thimble off.
- **`thimble: command not found` in Claude's Bash calls.** The same: the plugin is not loaded.
- **`No module named 'pandas'`.** See [Python](#python).
- **`1` does not open a card's detail.** Below 144 columns Claude Code does not open a side pane from a key. Type
  `/card` instead, or widen the terminal.

## Install from a checkout

To try a branch or work on thimble:

```
git clone https://github.com/safety-research/thimble
cd your-data-folder
claude --plugin-dir /path/to/thimble/plugin
```

`scripts/check.sh` in the checkout runs the plugin's validation and its three test suites. It needs Claude Code, Node.js
and a Python with pandas and pytest (set `THIMBLE_PYTHON` to it).
