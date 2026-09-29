# thimble — notes for Claude Code sessions in this repo

## What install.sh asks

install.sh asks three questions before it installs anything, and each flag below answers one without asking. `thimble uninstall` takes back the plugin and the trust:
- **Browser** (`--browser system | bundled | off`): thimble takes screenshots of the cards and views it draws to check them, and repairs graphics that look wrong. It can use the Chrome or Edge installed on the machine (nothing is downloaded), download Playwright's headless Chromium (about 350 MB), or have no browser: then there are no screenshot checks of cards and views, so no self-repair of graphics and no view review.
- **Plugin** (`--plugin` / `--no-plugin`): adds thimble to `~/.claude/settings.json` and `~/.claude/plugins`, so thimble is available in every `claude` session from startup. The `thimble` command works either way.
- **Trust** (`--trust-workspaces` / `--no-trust-workspaces`): adds thimble's workspaces folder (`~/.thimble/app/workspaces` for a Global install, `<clone>/workspaces` for a Dev install), where thimble keeps each workspace and runs its agents, to `~/.claude.json`. With a no, the orientation, its critic and the writers run as `claude -p` sessions, which do the same work but don't show in the terminal's agent tray.

## Installing

When the user asks you to install thimble (for example "install thimble from https://github.com/safety-research/thimble"), do the whole install for them:

1. If `thimble doctor` already runs, say what is installed and offer `thimble update` instead. Otherwise ask which install they want (with AskUserQuestion where it exists):
   - **Global** (recommended): the latest release into `~/.thimble/app` (`$THIMBLE_HOME/app` when THIMBLE_HOME is set), Node 20+ only for custom views, updated from releases by `thimble update`.
   - **Dev**: a git clone in a folder they choose, installed in place with the test tools, needs Node 20+, updated with `git pull` (which `thimble update` runs).
2. Get the files. Global: in a `mktemp -d` folder download the latest release's `thimble-*.zip`: with gh, `gh release download --repo safety-research/thimble --pattern 'thimble-*.zip'`; without gh, fetch the `browser_download_url` of that asset from `https://api.github.com/repos/safety-research/thimble/releases/latest` with `curl -fsSL`. Unzip it. If there is no release yet, say so and offer Dev. Dev: `git clone https://github.com/safety-research/thimble.git <folder>`; if this session already runs in a checkout, that checkout can be the folder.
3. Before installing anything, run `bash scripts/install.sh --dry-run` in the unzipped folder or the clone. It changes nothing. It prints what install.sh installs and where, then the questions it would ask on a terminal, each with the flag for every answer. Show the user that list, then ask each of its questions with AskUserQuestion, in its words and with its answers as the options. Ask nothing else, and don't answer a question for the user.
4. Run `bash scripts/install.sh` there with one flag per answer, then (Global) delete the download folder.
5. Run `thimble doctor` (`~/.local/bin/thimble doctor` while `~/.local/bin` is not on PATH). If the installer's last step asks for lines in the shell startup file (PATH, THIMBLE_HOME), offer to add them for the user. End with a short reply: where thimble is installed and that they run `thimble` in a folder of transcripts. Mention doctor's output only for a check that failed.

To change an answer later, or to answer questions an update run without a terminal reports as not asked, run install.sh again with their flags (ask them as in step 3). It skips the steps that are done and never downloads the browser again once it is there.

If anything goes wrong that you can't fix, tell the user they can reach the maintainer, [@mjoerke](https://github.com/mjoerke) on GitHub, and that `thimble feedback "<what went wrong>"` writes a problem report to attach.

If install.sh fails, follow INSTALL.md. A Dev install uses the checkout in place (marketplace `thimble`, `backend/.venv`, the UI in `frontend/dist`); a Global install copies the release to `~/.thimble/app` (marketplace `thimble-local`). Both link `~/.local/bin/thimble` to the install's `plugin/bin/thimble`.

CONTRIBUTING.md says how to set up a checkout, run it in development and run the tests.
