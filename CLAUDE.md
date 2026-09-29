# thimble — notes for Claude Code sessions in this repo

## The two install settings

install.sh changes two things in Claude Code's own files, each only after a yes, and `thimble uninstall` removes both:
- **Plugin**: adds thimble to `~/.claude/settings.json` and `~/.claude/plugins`, so thimble is available in every `claude` session from startup. The `thimble` command works either way.
- **Trust**: adds thimble's workspaces folder (`~/.thimble/app/workspaces` for a Global install, `<clone>/workspaces` for a Dev install) to `~/.claude.json`, so thimble can start its background agents without Claude Code stopping to ask. Everything works with a no, except Terminal-first mode (a Settings option for chatting in the terminal), whose background agents are then refused with a message saying how to trust the folder (`thimble trust`, which asks first).

## Installing

When the user asks you to install thimble (for example "install thimble from https://github.com/safety-research/thimble"), do the whole install for them:

1. If `thimble doctor` already runs, say what is installed and offer `thimble update` instead. Otherwise ask which install they want (with AskUserQuestion where it exists):
   - **Global** (recommended): the latest release into `~/.thimble/app` (`$THIMBLE_HOME/app` when THIMBLE_HOME is set), Node 20+ only for custom views, updated from releases by `thimble update`.
   - **Dev**: a git clone in a folder they choose, installed in place with the test tools, needs Node 20+, updated with `git pull` (which `thimble update` runs).
2. Before running install.sh, ask about both settings above with AskUserQuestion, explaining each in a sentence or two, and pass the answers as flags: `--plugin` / `--no-plugin` and `--trust-workspaces` / `--no-trust-workspaces`. Ask nothing else.
3. Global: in a `mktemp -d` folder download the latest release's `thimble-*.zip`: with gh, `gh release download --repo safety-research/thimble --pattern 'thimble-*.zip'`; without gh, fetch the `browser_download_url` of that asset from `https://api.github.com/repos/safety-research/thimble/releases/latest` with `curl -fsSL`. Unzip it, run `bash thimble-*/scripts/install.sh <flags>`, then delete the folder. If there is no release yet, say so and offer Dev. Dev: `git clone https://github.com/safety-research/thimble.git <folder>`, then `bash scripts/install.sh <flags>` in that folder; if this session already runs in a checkout, that checkout can be the folder.
4. Run `thimble doctor` (`~/.local/bin/thimble doctor` while `~/.local/bin` is not on PATH). If the installer's last step asks for lines in the shell startup file (PATH, THIMBLE_HOME), offer to add them for the user. End with a short reply: where thimble is installed and that they run `thimble` in a folder of transcripts. Mention doctor's output only for a check that failed.

If anything goes wrong that you can't fix, tell the user they can reach the maintainer, [@mjoerke](https://github.com/mjoerke) on GitHub, and that `thimble feedback "<what went wrong>"` writes a problem report to attach.

If install.sh fails, follow INSTALL.md. A Dev install uses the checkout in place (marketplace `thimble`, `backend/.venv`, the UI in `frontend/dist`); a Global install copies the release to `~/.thimble/app` (marketplace `thimble-local`). Both link `~/.local/bin/thimble` to the install's `plugin/bin/thimble`.

CONTRIBUTING.md says how to set up a checkout, run it in development and run the tests.
