# thimble — notes for Claude Code sessions in this repo

## What install.sh asks

install.sh asks nothing. Where there is a choice, it picks a default and its opening screen names it, with the flag that changes it. Pass such a flag only when the user asks for another choice. A flag is kept, so `thimble update` keeps it:
- **Browser** (`--browser bundled | system | off`). thimble takes screenshots of the cards and views it draws, to check how they look. install.sh test-launches a Chrome or Edge it finds where Playwright looks and uses one that starts, downloading nothing. Otherwise it downloads Playwright's headless Chromium (about 210 MB from Microsoft's Playwright CDN, 650 MB on disk). The opening screen says which in one line.

install.sh adds thimble's plugin to Claude Code with Claude Code's own commands (`claude plugin marketplace add <install folder>`, then `claude plugin install --scope user thimble@<name>`), so `/thimble` works in any `claude` session, and it doesn't ask about it: its opening screen says so. When another thimble install's plugin is in Claude Code already, it leaves that one and prints the commands that switch it. It runs no sudo. Pass `--no-plugin` only when the user asks for that.

install.sh writes no shell startup file. When `~/.local/bin` is not on PATH, or THIMBLE_HOME is not `~/.thimble`, it prints the line a new terminal needs for `thimble`. Offer to add that line to the user's startup file, and add it only on a yes. `claude` and /thimble need neither line.

## Installing

When the user asks you to install thimble (for example "install thimble from https://github.com/safety-research/thimble"), do the whole install for them:

1. If `thimble doctor` already runs, say what is installed and offer `thimble update` instead. Otherwise ask which install they want (with AskUserQuestion where it exists):
   - **Global** (recommended): the latest release into `~/.thimble/app` (`$THIMBLE_HOME/app` when THIMBLE_HOME is set), Node 20+ only for custom views and the sandbox card code and code tickets run in, updated from releases by `thimble update`.
   - **Dev**: a git clone in a folder they choose, installed in place with the test tools, needs Node 20.19+, 22.13+ or 24+, updated with `git pull` (which `thimble update` runs).
2. Get the files. Global: in a `mktemp -d` folder download the latest release's `thimble-*.zip`: with gh, `gh release download --repo safety-research/thimble --pattern 'thimble-*.zip'`; without gh, fetch the `browser_download_url` of that asset from `https://api.github.com/repos/safety-research/thimble/releases/latest` with `curl -fsSL`. Unzip it. If there is no release yet, say so and offer Dev. Dev: `git clone https://github.com/safety-research/thimble.git <folder>`; if this session already runs in a checkout, that checkout can be the folder.
3. Before installing anything, run `bash scripts/install.sh --dry-run` in the unzipped folder or the clone. It changes nothing. It prints one screen (what it found, with the browser it picked for screenshots and what that downloads from where, what it installs where, what it changes in the user's Claude Code setup), then "Nothing to ask". Show the user that screen in brief, with the browser's line, and ask nothing; go on to step 4. When the dry run lists questions (an older install.sh), ask each with AskUserQuestion, in its words and with its answers as the options, and ask nothing else. Don't answer a question for the user, even one whose answer looks obvious: each changes their machine or their Claude Code setup, and only they know what they want of it.
4. Run `bash scripts/install.sh` there, with a flag only for an answer from step 3 or a choice the user asked for (such as `--browser off`), then (Global) delete the download folder. It prints a line per step; every command it ran, with its output, is in `~/.thimble/install.log`. If it, or its dry run, says Node is older than a checkout needs, tell the user and offer to upgrade Node the way this machine manages it (Homebrew, nvm, their package manager); do it only on a yes, then run install.sh again.
5. Run `thimble doctor` (`~/.local/bin/thimble doctor` while `~/.local/bin` is not on this session's PATH). End with a short reply: where thimble is installed, and that they run `claude` in a folder with their files, where thimble is on in every session; `/thimble browser` opens the browser workbench, and `/plugin` turns thimble on or off (in a session that was open before the install, /reload-plugins first). When install.sh printed a line for the startup file, say whether you added it. For a step install.sh marked with `!`, tell them what it printed under it. Mention doctor's output only for a check that failed.

To change the browser later, run install.sh again with `--browser`. When `thimble update` stops because a question has no flag (an older install), ask the questions it lists as in step 3 and run `thimble update` again with their flags, which it passes on to install.sh. An install older than 0.3.0 has a `thimble update` that takes no flags: unzip the latest release and run its `bash scripts/install.sh --dir <the install folder>` with the flags instead. A re-run skips the steps that are done and never downloads the browser again once it is there.

If anything goes wrong that you can't fix, tell the user they can reach the maintainer, [@mjoerke](https://github.com/mjoerke) on GitHub, and that `thimble feedback "<what went wrong>"` writes a problem report to attach.

If install.sh fails, follow INSTALL.md's Manual install. A Dev install uses the checkout in place (marketplace `thimble`, `backend/.venv`, the UI in `frontend/dist`); a Global install copies the release to `~/.thimble/app` (marketplace `thimble-local`). Both link `~/.local/bin/thimble` to the install's `plugin/bin/thimble`.

CONTRIBUTING.md says how to set up a checkout, run it in development and run the tests.
