# thimble: notes for Claude Code sessions in this repository

This repository holds two products: the terminal plugin for Claude Code (`plugin/`) and the browser workbench
(`browser/`).

## Installing thimble for a user

When the user asks you to install thimble (for example "install thimble from
https://github.com/safety-research/thimble"), do this. [INSTALL.md](INSTALL.md) has the details and the fixes.

1. Ask first, with your question tool (AskUserQuestion) when you have it, which they want:
   - **The terminal plugin alone**: in their Claude Code sessions, Claude cites its claims, a second Claude checks
     them, and Claude draws cards of the data. It needs Node.js and Python, and no other access.
   - **The browser workbench too**: the same work in a web page on this machine. It takes about 1 GB of disk and needs
     access to the Claude API: an API key, Workload Identity Federation, or their Claude Code sign-in.
2. If `~/.local/bin/thimble` exists, it is thimble 0.9's launcher. Tell the user, and offer `thimble uninstall` (or
   removing that file) before you go on.
3. Clone the repository (or use the local folder the user names) and run `scripts/install.sh` in it, with
   `--no-browser` for the plugin alone. Add `--local` when the source is a local folder, so the plugin comes from it.
   The script checks what is missing first, one line each, and installs nothing until all of it is there. Tell the
   user what is missing and the command that fixes it, run that command only when the user agrees, then run the
   script again.
   For the workbench, run the script with `--no-setup` (its own question needs a terminal) and ask how the
   workbench should reach Claude, with your question tool: an Anthropic API key, the user's Claude Code sign-in, or
   Workload Identity Federation. For the Claude Code sign-in, show this text and get a yes first: "This uses your
   Claude subscription through Claude Code and will launch headless Claude Code sessions in the background." Then
   run `thimble-browser --setup --how claude-code --yes`. For WIF, ask for the path of its config file and run
   `thimble-browser --setup --how wif --wif-file <path>`. Never ask for an API key or let one pass through you: say
   the page asks for it at its first start.
4. End with a short reply on how to use what was installed:
   - The plugin: open `claude` in a folder of data files. Claude cites each claim, and a second Claude checks it
     against the files; a click on the underlined words opens the evidence. The line above the prompt shows the keys:
     `v` card, `s` squeeze, `c` claims, `r` coverage. A click on `thimble` in that line, or `/thimble-settings`, opens
     the settings; `/plugin` turns thimble off.
   - The workbench: run `thimble-browser` in a folder of files and open the sign-in link it prints.
5. When the plugin was installed, offer to show it in this session, in one short line: "Type /reload-plugins, then
   try it." (You cannot type `/reload-plugins` for them; it loads thimble here.) When they answer after the reload,
   look at `examples/sample/runs.csv` yourself (40 made-up nightly test runs) and answer: did the failures start
   after the config change? Answer it as thimble's guidance says: one card, and checked citations. Never ask the
   user to type the question or a path. If the line above the prompt does not show `thimble` after the reload, say
   that a new `claude` session in a folder of their own files will have it.

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
