# Contributing to thimble

Bug reports, suggestions and pull requests are welcome.

## Set up a checkout

You need Claude Code 2.1.301 or later, Node.js 22.18 or later, and a Python 3.10 or later with pandas and pytest.

```
git clone https://github.com/safety-research/thimble.git
cd thimble
python3 -m venv .venv && .venv/bin/pip install pandas pytest
export THIMBLE_PYTHON="$PWD/.venv/bin/python"
```

To try your checkout, start Claude Code in a folder of data files with the plugin loaded from it:

```
cd your-data-folder
claude --plugin-dir /path/to/thimble/plugin
```

Claude Code reloads the plugin's hooks module when its files change, so most edits show in a running session.

## Run the tests

`scripts/check.sh` runs everything CI runs. Make it pass before you open a pull request. Each step can run alone:

```
scripts/check.sh validate   # claude plugin validate plugin
scripts/check.sh plugin     # the hooks tests, plugin/tests/*.test.ts, with claude plugin test
scripts/check.sh node       # node --test over plugin/**/*.test.mjs
scripts/check.sh python     # pytest over plugin/ (the kernel)
```

The tests run on small made-up data and fake every model call. They cover what must not break; a test does not pin
wording or layout.

## Layout

| What | Where |
|---|---|
| the manifest, with the plugin's one setting (the side agent) | `plugin/.claude-plugin/plugin.json` |
| the `thimble` command and the kernel it runs: sources, queries, cards, lineage, labels | `plugin/bin/thimble`, `plugin/engine/` |
| the hooks module: what it registers, in order | `plugin/hooks/register.ts` |
| the shell: cards under replies, citations, the tray, the bar, the side panel (a card's detail, a citation, any pane) and its side thread, labels | `plugin/shell/` |
| the card runtime that a card's program draws through, and its terminal renderer | `plugin/draw/` |
| the panes thimble draws as programs on that runtime (detail, tray, chips, proposals, the side panel's mark and thread list) | `plugin/panes/` |
| the side agent that reads each reply, and its lenses | `plugin/observer/` |
| the rewrite behind `s`, and the catch-up | `plugin/squeeze/` |
| Claims: the session's claims, the Claims pane behind `c`, and the map of the folder's claims | `plugin/claims/` |
| the texts the model reads: the skill and card guide, and the versioned prompts | `plugin/skills/`, `plugin/prompts/` |
| the session's events and its cost per feature (`thimble dev stats`) | `plugin/telemetry/` |
| tests | `plugin/tests/` (hooks tests and pytest), and a `test/` folder beside the code it tests (node) |

A change to a text the model reads goes in a new version of that prompt (`plugin/prompts/<feature>/`), and
`thimble dev prompts` lists the versions and which is active.

## Pull requests

A contribution is licensed under Apache-2.0, as section 5 of the LICENSE says.

`git config core.hooksPath scripts/hooks` turns on a commit-msg hook that refuses a message linking a Claude Code
session (`git commit --no-verify` skips it).
