# Contributing to thimble

Bug reports, suggestions and pull requests are welcome.

## Set up a checkout

You need what [INSTALL.md](INSTALL.md) lists for both products, with Node.js 22.18 or later, and a Python 3.10 or later
with pytest for the plugin's tests. The plugin's kernel needs nothing else.

```
git clone https://github.com/safety-research/thimble.git
cd thimble
python3 -m venv .venv && .venv/bin/pip install pytest
export THIMBLE_PYTHON="$PWD/.venv/bin/python"
scripts/install.sh --local
```

`--local` installs the plugin from your checkout, so Claude Code loads it from `plugin/` and most edits show at the next
session start or after `/reload-plugins`. To load it for one session only, without installing it, start Claude Code in
a folder of data files with `claude --plugin-dir /path/to/thimble/plugin`.

The browser workbench runs from the checkout too: `thimble-browser FOLDER` builds the page again when its sources
changed, so an edit to the page shows when you start it again.

## Run the tests

`scripts/check.sh` runs everything CI runs. Make it pass before you open a pull request. Each step can run alone:

```
scripts/check.sh validate   # claude plugin validate plugin
scripts/check.sh plugin     # the plugin's hooks tests, plugin/tests/*.test.ts, with claude plugin test
scripts/check.sh node       # node --test over plugin/**/*.test.mjs
scripts/check.sh python     # pytest over plugin/ (the kernel)
scripts/check.sh parity     # the browser's shared prompts still apply to the plugin's texts
scripts/check.sh server     # the browser workbench's server tests (browser/server/tests)
scripts/check.sh page       # the page's type check, unit tests and build (browser/frontend)
```

The tests run on small made-up data and fake every model call. They cover what must not break; a test does not pin
wording or layout. The plugin's Node tests start the card runner in its sandbox, as a session does: they install the
sandbox runtime in the test's own `THIMBLE_HOME` (with `npm ci`, so the first run needs the npm registry) and fail
when the sandbox does not work on the machine (on Linux it needs bubblewrap, socat and ripgrep). The server's sandbox
tests need the sandbox runtime that `scripts/install.sh` installs, and skip without it.

## Layout

The terminal plugin, `plugin/`. Each module has one job; `plugin/hooks/register.ts` registers them in order.

| What | Where |
|---|---|
| the manifest: name, the three switches (Citations, Cards, Labels and coverage on the bar); a release commit adds its version (with none, Claude Code names an install by its commit, so an install from a branch takes each new commit) | `plugin/.claude-plugin/plugin.json` |
| the `thimble` command (`label`, `coverage`, `fix`; `thimble dev prompts`, `thimble dev stats`, `thimble dev validate`) and its kernel, on the Python standard library | `plugin/bin/thimble`, `plugin/engine/` |
| the deterministic check of a checker's answer: a quote in its line, the marked words in the real output of a call that ran the code | `plugin/engine/kernel/evidence.py`, `plugin/engine/validate.py` |
| the hooks module, its order, the session's PATH and TMPDIR, which files Claude read (for coverage), and thimble's keys at an empty prompt with their word window (`keys.ts`) | `plugin/hooks/` |
| shared parts: where thimble keeps its records (`layout.mjs`, the same names as `engine/kernel/store.py`), a text's width, whether main's turn runs, the forks (checker, designer), what thimble tells Claude with the next prompt, the change feed, the one side pane | `plugin/core/` |
| the guidance: context beside the first prompt of every conversation | `plugin/guidance/` |
| the texts the model reads, and their registry | `plugin/prompts/` |
| marks: find `[words](#)` in a reply, draw them, run the checker fork and the validator, the evidence pane | `plugin/marks/` |
| cards: the `card` tool, the runner that runs the cards' views (`runner.mjs`) and the command that starts it in the sandbox (`argv.mjs`), drawing, a card's keys | `plugin/cards/` |
| the sandbox the card runner runs in, shared with the browser workbench: Anthropic's sandbox runtime (srt) pinned (`package.json`, `package-lock.json`), the launcher that runs one command in it (`run.mjs`, `bwrap.sh`), and `setup.mjs`, which installs srt in `~/.thimble/srt` and says whether it works | `plugin/sandbox/` |
| `v`: the designer fork that draws a card of the last answer | `plugin/designer/` |
| the line above the prompt: busy step, failure line, fix line, counts | `plugin/bar/` |
| the settings, coverage and fix-share panes | `plugin/panes/` |
| the switches, `featureOn(key)`, `/thimble-settings` | `plugin/settings/` |
| a `--prompt` label's model reads, and the labels pane | `plugin/labels/` |
| each model call and turn in the session's events, per feature (`thimble dev stats`) | `plugin/telemetry/` |
| every `$.state` key, one block per module | `plugin/types/index.d.ts` |
| `/thimble:fix` | `plugin/commands/fix.md` |
| tests | `plugin/tests/` (hooks tests and pytest), and a `test/` folder beside the code it tests (node) |

The browser workbench, `browser/`:

| What | Where |
|---|---|
| the page (React and Vite), and its unit tests | `browser/frontend/src`, `browser/frontend/tests/public` |
| the server: sign-in, the folder's readers, the workspace, the agents' loop and their tools | `browser/server/thimble_browser/` |
| the features (cards, citations, lenses, labels, report, views), registered in one place, each one module with its routes, tools and prompt part | `browser/server/thimble_browser/features/` |
| the sandbox that card code and view readers run in: its rules, and srt's install (`browser/server/sandbox`, whose `package.json` and lock file link to the plugin's pin) | `browser/server/thimble_browser/cards/sandbox.py`, `browser/server/sandbox/` |
| the card toolkit that card code draws with, in the sandbox and the page | `browser/kit/` |
| the texts Claude reads, and the parts it reads from the plugin | `browser/prompts/`, `browser/prompts/shared.json` |
| the view kit's guides and worked examples, which the view builder reads | `browser/docs/`, `browser/samples/views/` |
| the server's tests | `browser/server/tests/` |
| the launcher that `scripts/install.sh` puts on `PATH` | `browser/scripts/thimble-browser` |

`scripts/` holds `install.sh`, `check.sh`, `scan.sh` and the git hooks.

## Changing what the model reads

Every text a model reads is one file in `plugin/prompts/`, each paragraph on one line:

| Text | File | Read by | As |
|---|---|---|---|
| guidance | `prompts/guidance.md` | `guidance/guidance.ts` | context beside the first prompt of every conversation, without the section of a switched-off feature |
| card tool | `prompts/card-tool.md` | `cards/tool.ts` | the description of the `card` tool |
| checker | `prompts/checker.md` | `marks/checker.ts` | the prompt of the fork that checks a reply's marks |
| designer | `prompts/designer.md` | `designer/v.ts` | the prompt of the fork that `v` starts |
| label classifier | `prompts/labels.md` | `labels/labels.ts` | each model call of a `--prompt` label |

To change a text, edit its file; git keeps the earlier wording, so compare with `git diff` or `git log -p`.
`plugin/prompts/registry.mjs` names each text, its reader and what it is for, and `thimble dev prompts` lists them. A
fork (the checker, the designer) is a copy of the conversation, so it reads the guidance too.

When the model does something you do not want, change the cause, not the symptom:

1. Say what the model did, and what you want it to do instead.
2. Read the whole text the model receives at that point, and find what leads it there: a principle, an example, or a
   purpose it was never given. Check the guess on a few runs.
3. Change that: reword the principle, replace the example, or delete the text that pulls the wrong way. Removing text
   is better than adding it.
4. Never add a sentence that forbids the symptom. What is really about the interface (a color, a key, a line of
   status) is fixed in code.
5. Read every sentence again as if for a request nobody has thought of yet, and keep only what is still right there.

The browser workbench reads one of those texts from `plugin/` when it makes a prompt: the label classifier. Its few
changes for the browser, each a pair of exact strings, are listed in `browser/prompts/shared.json`. When you reword the
classifier, the parity test says which change no longer applies; fix the pair in `shared.json`. The browser keeps its
own copies of the other texts it used to share.

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
