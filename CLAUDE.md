# thimble: notes for Claude Code sessions in this repository

## Installing thimble for a user

When the user asks you to install thimble (for example "install thimble from
https://github.com/safety-research/thimble"), follow [INSTALL.md](INSTALL.md):

1. Check what it needs: `claude --version` (2.1.301 or later), `node --version` (22 or later), and
   `python3 -c "import pandas"`. Say what is missing, with the command that fixes it, and run that command only when
   the user agrees.
2. If `~/.local/bin/thimble` exists, it is thimble 0.9's launcher. Tell the user, and offer `thimble uninstall` (or
   removing that file) before you go on.
3. Run `claude plugin marketplace add safety-research/thimble`, then `claude plugin install thimble@thimble`.
4. End with a short reply: thimble works in a new `claude` session in a folder of data files that they trust; the line
   above the prompt lists its keys; `/plugin` turns it, or its side agent, off.

## Working on thimble

The plugin is `plugin/`. [CONTRIBUTING.md](CONTRIBUTING.md) says how it is laid out and how to test it.
`scripts/check.sh` runs every check CI runs.

The repository is public. The pre-push hook stops a push whose commits hold private details (CONTRIBUTING.md, "Keep
private details out of commits"). When it does, fix the commit as it says. Never push with `--no-verify`.
