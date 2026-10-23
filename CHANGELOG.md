# Changelog

## thimble 0.10.0

**Breaking change:** thimble is now a regular Claude Code plugin. The `thimble` launcher is gone: run `claude` and thimble is on. The browser workbench is now its own command, `thimble-browser`. X% less code, Y% less context than 0.9.

**New:** claims map (`c`), squeeze (`s`), improved terminal cards (`v`), explainers and heads-ups, citations that fix themselves, and `thimble-browser` with `-c` / `-r` like Claude Code.

**Upgrade from 0.9:** run `thimble uninstall`, then `claude "install thimble from https://github.com/safety-research/thimble"`. 0.10 can't open 0.9 workspaces; to keep them, move `~/.thimble/app/workspaces` first. [More in INSTALL.md](INSTALL.md#if-you-used-thimble-09)

**Uninstall:** `claude plugin uninstall thimble@thimble`, then delete `~/.local/bin/thimble-browser`, `~/.thimble` and `~/.thimble-browser`.
