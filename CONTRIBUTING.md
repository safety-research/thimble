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
session start or after `/reload-plugins`. When thimble's release is installed in `~/.thimble`, the script sets it
aside first, with its fixes, and the install without `--local` brings it back (INSTALL.md, The dev install). To load
your checkout for one session only, without installing it, start Claude Code in a folder of data files with
`claude --plugin-dir /path/to/thimble/plugin`.

Once you have fixes (thimble fix), Claude Code loads thimble from `~/.thimble/fixes/live` instead: after `git pull`,
`thimble update` moves thimble and your fixes onto the commit you checked out. The way back from a fix (`thimble fix`,
`thimble file`, `thimble update`, the fixer's sandbox and the tests it runs) runs from `~/.thimble/fixes/release`, a
checkout of that commit which no fix changes. A fix may change any text file but the fix flow and the privacy scan
(`plugin/engine/kernel/fixes.py`, PROTECTED_KINDS), and the line that asks whether to use it names the files it changes
of the sandbox, the hooks file and the command hooks, the launcher, thimble's scripts and the lock files (NOTICE_KINDS).

The browser workbench runs from the checkout too: `thimble-browser FOLDER` builds the page again when its sources
changed, so an edit to the page shows when you start it again.

## Run the tests

`scripts/check.sh` runs everything CI runs. Make it pass before you open a pull request. Each step can run alone:

```
scripts/check.sh validate   # claude plugin validate plugin
scripts/check.sh plugin     # the plugin's hooks tests, plugin/tests/*.test.ts, with claude plugin test
scripts/check.sh node       # node --test over plugin/**/*.test.mjs
scripts/check.sh python     # pytest over plugin/ (the kernel)
scripts/check.sh parity     # the browser's prompts render and name only what its code has
scripts/check.sh server     # the browser workbench's server tests (browser/backend/tests_public)
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
| the manifest: name, the switches (Minimal, Citations (its modes), Checker and Effort (the citation checker's model and effort), Cards (its modes), Rewrite, Catch-up, Comments (Explainers, Heads-ups, with their modes), Claims (its modes), Labels, Coverage; the old fields they replaced, and defaultsAt, stay, hidden); no version, since a release names its version by its tag: Claude Code names the copy it installs by its commit, and `thimble --version` names the release from `~/.thimble/fixes/release.json` | `plugin/.claude-plugin/plugin.json` |
| the `thimble` command (`label`, `coverage`, `fix` and `fixes`, `file`, `update`, `reapply`, `doctor`, `install`; `thimble dev prompts`, `thimble dev stats`, `thimble dev validate`) and its kernel, on the Python standard library | `plugin/bin/thimble`, `plugin/engine/` |
| the deterministic check of a checker's answer: a quote in its line, the marked words in the real output of a call that ran the code | `plugin/engine/kernel/evidence.py`, `plugin/engine/validate.py` |
| the hooks module, its order, the session's PATH and TMPDIR, the command hook that lets Claude read thimble's temp folder without a dialog (`temp_allow.py`), which files Claude read (for coverage), a `thimble` command in Claude Code's Bash sandbox run outside it (`handoff.ts`, with `engine/kernel/handoff.py`; a label's code such a command gives runs in thimble's sandbox, `engine/kernel/codebox.py`), and thimble's keys at an empty prompt with their word window (`keys.ts`) | `plugin/hooks/` |
| shared parts: where thimble keeps its records (`layout.mjs`, the same names as `engine/kernel/store.py`), a text's width, whether main's turn runs, the forks (checker, designer, side thread), what thimble tells Claude with the next prompt, or sooner of a card Claude drew (`tell.ts`, the one way a report reaches Claude; `engaged.ts`, what the person opened and asked), the change feed, the one side pane, the record of main's turns and answers (`answers.ts`), and where the features that act on answers draw and take keys (`answerview.ts`) | `plugin/core/` |
| the guidance: context beside the first prompt of every conversation | `plugin/guidance/` |
| the texts the model reads, and their registry | `plugin/prompts/` |
| marks: find `[words](#)` in a reply, draw them, run the checker fork and the validator, the evidence pane | `plugin/marks/` |
| cards: the `card` tool, the runner that runs the cards' views (`runner.mjs`) and the command that starts it in the sandbox (`argv.mjs`), drawing, a card's keys | `plugin/cards/` |
| the sandbox the card runner, a code label's code and a fix's fixer and tests run in (the browser workbench installs it for its fixes too): Anthropic's sandbox runtime (srt) pinned (`package.json`, `package-lock.json`), the launcher that runs one command in it (`run.mjs`, `bwrap.sh`), and `setup.mjs`, which installs srt in `~/.thimble/srt` and says whether it works | `plugin/sandbox/` |
| `v`: the designer fork that draws a card of the last answer | `plugin/designer/` |
| the observer: one look at each answer, a fork of the conversation, for the explainers, important details and claims (the claims on demand, f in their pane, unless Claims is auto); its lenses | `plugin/observer/` |
| the features that act on answers, each meeting the rest through its `seam.ts` (`core/answerview.ts` calls them): squeeze, stretch and catch-up; the explainers and important details; the claims; the side threads; the citation and explanation tray | `plugin/squeeze/`, `plugin/explain/`, `plugin/claims/`, `plugin/threads/`, `plugin/tray/` |
| the line above the prompt: busy step, failure line, counts | `plugin/bar/` |
| the settings and coverage panes | `plugin/panes/` |
| the switches, `featureOn(key)`, `/thimble-settings` | `plugin/settings/` |
| `/thimble-fix`: the person's changes to their own thimble, made by the fixer in a scratch copy and applied with their key | `plugin/fix/` |
| the skills Claude calls: `fix-thimble`, which starts the fix the person asks for | `plugin/skills/` |
| a `--prompt` label's model reads, and the labels pane; the labels an answer or a card used, and the ask before a large label run (`use.ts`) | `plugin/labels/` |
| each model call and turn in the session's events, per feature (`thimble dev stats`) | `plugin/telemetry/` |
| every `$.state` key, one block per module | `plugin/types/index.d.ts` |
| tests | `plugin/tests/` (hooks tests and pytest), and a `test/` folder beside the code it tests (node) |

The browser workbench, `browser/`:

| What | Where |
|---|---|
| the page (React and Vite), and its unit tests | `browser/frontend/src`, `browser/frontend/tests/public` |
| the server: the workspace, the tools, the agents' sessions, the card harness | `browser/backend/app/` |
| the texts Claude reads | `browser/prompts/` |
| the view kit's guides and worked examples, which the view builder reads | `browser/docs/`, `browser/plugin/viewers/` |
| the server's tests | `browser/backend/tests_public/` |
| the launcher that `scripts/install.sh` puts on `PATH` | `browser/scripts/thimble-browser` |

`scripts/` holds `install.sh`, `check.sh`, `scan.sh`, `release-file.sh` (which builds the file a release has attached: Releasing thimble, below), `thimble09.py` (which finds a thimble 0.9 install for `install.sh` and says how to remove it) and the git hooks.

## Changing what the model reads

Every text a model reads is one file in `plugin/prompts/`, each paragraph on one line:

| Text | File | Read by | As |
|---|---|---|---|
| guidance | `prompts/guidance.md` | `guidance/guidance.ts` | context beside the first prompt of every conversation, without the section of a switched-off feature |
| card tool | `prompts/card-tool.md` | `cards/tool.ts` | the description of the `card` tool |
| card check | `prompts/card-check.md` | `cards/fit.ts` | one model call when a version of a card does not fit on the screen, which writes the version the analyst sees |
| checker | `prompts/checker.md` | `marks/checker.ts` | the prompt of the fork that checks a reply's marks |
| designer | `prompts/designer.md` | `designer/v.ts` | the prompt of the fork that `v` starts |
| label classifier | `prompts/labels.md` | `labels/labels.ts` | each model call of a `--prompt` label |
| observer | `prompts/observer.md`, `prompts/observer-turn.md` | `observer/observer.ts` | the prompt of the look after each answer: its frame, then the messages to read and what thimble already gave |
| lenses | `prompts/lens-explain.md`, `prompts/lens-heads.md`, `prompts/lens-claims.md` | `observer/observer.ts` | the sections of the look's prompt, one per switch that is on |
| explainer on demand | `prompts/explain-expand.md` | `explain/expand.ts` | one model call when the person asks what words of an answer mean |
| squeeze | `prompts/squeeze.md` | `squeeze/term.ts` | one model call per change of an answer's chips |
| side thread | `prompts/thread.md` | `threads/thread.ts` | the prompt of the fork that answers a side thread |
| artifact | `prompts/artifact.md` | `cards/head.ts` | the prompt of the fork that p on a card starts, which publishes the card as a private claude.ai artifact |
| fix request | `prompts/fix-request.md` | `fix/register.ts` | beside the person's words after `/thimble-fix <words>`: name the fix they change, or ask one short question |
| fixer | `prompts/fixer.md` | `fix/fixer.ts`, `browser/backend/app/fixes.py` | the start of the first message of the fork that `/thimble-fix` starts |
| reapply | `prompts/reapply.md` | `engine/kernel/fixes.py` | the first message of the session `thimble reapply` opens, which brings back the fixes an update set aside |
| labels off | `prompts/labels-off.md` | `hooks/path.ts`, `browser/backend/app/labels_off.py` | the answer of `thimble label`, or of a label tool's call in the workbench, while Labels is off |

To change a text, edit its file; git keeps the earlier wording, so compare with `git diff` or `git log -p`.
`plugin/prompts/registry.mjs` names each text, the module that reads it in each mode and what it is for, and
`thimble dev prompts` lists them. A fork (the checker, the designer) is a copy of the conversation, so it reads the
guidance too.

When the model does something you do not want, change the cause, not the symptom:

1. Say what the model did, and what you want it to do instead.
2. Read the whole text the model receives at that point, and find what leads it there: a principle, an example, or a
   purpose it was never given. Check the guess on a few runs.
3. Change that: reword the principle, replace the example, or delete the text that pulls the wrong way. Removing text
   is better than adding it.
4. Never add a sentence that forbids the symptom. What is really about the interface (a color, a key, a line of
   status) is fixed in code.
5. Read every sentence again as if for a request nobody has thought of yet, and keep only what is still right there.

The browser workbench (`browser/`) keeps its own texts in `browser/prompts/`. Of these it
reads the texts of what it runs as the terminal does, the citation checker, the look and the fixer (`checker.md`,
`observer.md`, `observer-turn.md`, `lens-explain.md`, `lens-heads.md`, `fixer.md`). Both modes read
a text the same way: it may hold another text, `{{include:NAME}}`, and where the modes need different words it names
them with a slot, `{{NAME}}`, whose words for each mode stand in `plugin/prompts/slots.json`: a name or a clause of at
most one sentence. Its reader fills its other slots at each call (the registry's `fills`). A text of the workbench holds
one as `{{include:plugin:NAME}}`, and `thimble dev prompts NAME browser` shows one as the workbench reads it.

`scripts/check.sh parity` fails when the two modes read a text that both read differently, when another text a model
reads copies 20 or more of its words in a row, when a slot lacks a mode's words or stands in no such text, or when a
mode stops loading one. It also fails when what a model reads changes in either mode: when you meant the change, write
the new fingerprints as `browser/backend/tests_public/test_renders.py` says.

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

## Releasing thimble

Each release has one file attached, `thimble-X.Y.Z.tar.gz` (git archive of its tag), with `SHA256SUMS`. The install
and `thimble update` find the newest release from GitHub's page of the latest release, which counts nothing, then
download that file and check its sha256. GitHub counts each download of the file, which is how many people install
each version. `scripts/release-file.sh` builds both files, and the Action `.github/workflows/release-file.yml` attaches
them. A published release must never be without its file: the install and the update then stop and say that it is
missing, and install nothing. So the file goes on while the release is still a draft:

1. Merge the release's pull request into main.
2. Tag main's commit and push the tag: `git tag vX.Y.Z <commit> && git push origin vX.Y.Z`.
3. Make the release as a draft: `gh release create vX.Y.Z --draft --verify-tag --title "thimble X.Y.Z" --notes-file
   NOTES.md`.
4. Attach its file: `gh workflow run release-file.yml --ref vX.Y.Z -f tag=vX.Y.Z`, then `gh run watch`.
5. Check: `gh release view vX.Y.Z --json assets -q '.assets[].name'` lists `thimble-X.Y.Z.tar.gz` and `SHA256SUMS`.
6. Publish: `gh release edit vX.Y.Z --draft=false`. The Action runs again, sees both files and stops.

If a release is published without its file (step 4 skipped, or the Action failed), the Action attaches it within about
a minute. To replace a broken file, `gh release delete-asset vX.Y.Z thimble-X.Y.Z.tar.gz --yes`, then step 4 again.

The count per version:

    gh api --paginate repos/safety-research/thimble/releases --jq '.[] | "\(.tag_name) \([.assets[] | select(.name | endswith(".tar.gz")) | .download_count] | add // 0)"'

It counts fresh installs and the updates that a thimble with this file's code ran; an update by an older thimble
downloads with git, and a dev install (`--local`) or `--ref` with a branch downloads no release file.
