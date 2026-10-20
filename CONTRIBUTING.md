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

`git config core.hooksPath scripts/hooks` turns on the repository's two hooks: the pre-push guard below, and a
commit-msg hook that refuses a message linking a Claude Code session.

## Keep private details out of commits

The repository is public, and so is every commit in its history: a later commit that deletes a line does not take it
out of the commit that added it. Never commit:

- absolute paths from your machine, such as your home folder or paths under /mnt (tests use the made-up home
  `/home/t/`);
- the names, email addresses or host names of real people and machines, other than the author and owner in the plugin
  manifests (tests use made-up names);
- an organization's internal details: names of its teams, orgs, accounts or credential tiers, and how its machines or
  credentials are set up;
- keys, tokens, passwords, or any value from a private env file.

The pre-push hook runs `scripts/scan.sh` on every commit a push sends, before anything leaves your machine. It reads
the lines each commit adds, the names of the files it adds, and its message, and looks for:

- absolute home and mount paths, private key headers, and the shapes of common tokens;
- what gitleaks finds, if you have it installed;
- the patterns in your own deny-list, `~/.config/thimble/deny-patterns` (one Python regular expression per line), and
  the values in the env files that `~/.config/thimble/deny-env-files` lists (one path or glob per line). Both files
  are optional and stay outside the repository; the top of `scripts/scan.sh` describes their format.

When it finds something, it stops the push and names the commit, the file and line, and the pattern, never the text
that matched. Take the text out of the commit that holds it (`git commit --amend` for the last commit, `git rebase -i`
for an older one) and push again. If a finding is wrong, change the line so it no longer matches, or add an
allow-pattern, a line that starts with `!`, to your deny-list. Never push with `--no-verify`, which skips the check;
an agent never uses it. CI runs the same scan with the generic patterns only.

To scan by hand, `scripts/scan.sh origin/main..HEAD` scans a range of commits, `scripts/scan.sh --all` every commit of
the remote branches and tags, and `scripts/scan.sh --tree HEAD` every file at a commit.
