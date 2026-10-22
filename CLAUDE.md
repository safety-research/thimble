# thimble: notes for Claude Code sessions in this repository

This repository holds two products: the terminal plugin for Claude Code (`plugin/`) and the browser workbench
(`browser/`).

## Installing thimble for a user

When the user asks you to install thimble (for example "install thimble from
https://github.com/safety-research/thimble"), follow [INSTALL.md](INSTALL.md):

1. Ask whether they want the browser workbench too. It takes about 600 MB of disk and needs credentials for the Claude
   API; the terminal plugin alone needs neither.
2. If `~/.local/bin/thimble` exists, it is thimble 0.9's launcher. Tell the user, and offer `thimble uninstall` (or
   removing that file) before you go on.
3. Run `scripts/install.sh` in a clone, with `--no-browser` for the plugin alone. It checks what is needed first and
   says what is missing, one line each. Tell the user what is missing, with the command that fixes it, and run that
   command only when the user agrees. Then run the script again.
4. End with a short reply: the plugin works in a new `claude` session in a folder of data files that they trust; Claude
   adds a citation to each claim it makes and a second Claude checks them; the line above the prompt lists the keys that work, such
   as `v` for a card of the last answer; a click on `thimble` in that line (or `/thimble-settings`) turns each feature
   on or off, and `/plugin` turns thimble off. The browser workbench starts
   with `thimble-browser` in a folder of files (or `thimble-browser FOLDER`), and asks for credentials in its Settings.

## Working on thimble

[CONTRIBUTING.md](CONTRIBUTING.md) gives the layout of each product and how to test it. `scripts/check.sh` runs every
check CI runs, and `scripts/check.sh STEP` one of them.

- A change to a text the plugin's model reads is an edit of its one file (`plugin/prompts/<text>.md`), and follows
  CONTRIBUTING.md, "Changing what the model reads": change the cause in the text, never add a rule against the
  symptom.
- The browser workbench (`browser/`, thimble 0.8's browser mode) keeps its own texts in `browser/prompts/`; it reads
  none from `plugin/`. `scripts/check.sh parity` checks that they render and name only what its code has.
- In the plugin, Claude's card views run only in the card runner (`plugin/cards/runner.mjs`), which runs only in
  Anthropic's sandbox runtime (`plugin/cards/argv.mjs` gives its rules; `plugin/sandbox/` holds the pin and the
  launcher): no network, reads only the runner's code and the card copies, writes only its own folder. A `vm` context
  per card keeps the cards apart. When the sandbox cannot start, cards do not run. The hooks never run a view
  themselves. Keep it that way.
- The browser's server binds 127.0.0.1 only, and card code runs only in its kernels' sandbox
  (`browser/backend/app/kernel_wrap.py`). Keep both that way.
- The repository holds code, and what the code needs. Keep notes, screenshots and design documents out of it.

The repository is public. The pre-push hook stops a push whose commits hold private details (CONTRIBUTING.md, "Keep
private details out of commits"). When it does, fix the commit as it says. Never push with `--no-verify`.
