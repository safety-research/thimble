# thimble: notes for Claude Code sessions in this repository

This repository holds two products: the terminal plugin for Claude Code (`plugin/`) and the browser workbench
(`browser/`).

## Installing thimble for a user

When someone asks you to install thimble, ask what they want, run the install script, and pass on what it says.

1. Ask, with your question tool:
   - **The plugin and the workbench** (recommended): in Claude Code, Claude cites its claims, a second Claude checks
     them, and Claude draws cards of the data; the workbench does the same in a web page on this machine. About 1 GB.
   - **The plugin alone**: only the Claude Code part.

   When they choose the workbench, then ask how it reaches Claude:
   - **Claude Code sign-in** (recommended): it runs Claude Code in the background, on their Claude plan.
   - **API key**: it uses `ANTHROPIC_API_KEY` when that is set, and otherwise takes a key pasted in its Settings,
     Claude access. Never ask for the key yourself.
   - **Workload Identity Federation**: ask for the path of their WIF config file.

2. Run the install script:

       curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash -s -- OPTIONS

   with OPTIONS from their answers: `--sign-in claude-code`, `--sign-in api-key`, or
   `--sign-in wif --wif-file PATH`; `--no-browser` for the plugin alone. When they named a branch, tag or version of
   thimble, put it in place of `main` in the address and add `--ref` with it.

   It downloads the newest release into `~/.thimble` and installs it from there; with the workbench it takes a few
   minutes. When it stops because something is missing, it says what and the command that fixes it: tell them, run
   that command only on their yes, then run the script again.

3. When it is done, reply briefly: one sentence on what is installed, then the workbench's line if the script printed
   one, then what does not work yet, if anything. End with the script's last line, word for word, on a line of its
   own, in bold, with the command in backticks, such as **Type `/reload-plugins` to enable thimble and start the
   tour.** Write nothing after it: it is the one thing the person must do, and you cannot run it. Do not start
   the tour yourself.

To work on thimble's own code, clone this repository and run `scripts/install.sh --local` in the clone. Only do this
when they ask for it.

## Working on thimble

[CONTRIBUTING.md](CONTRIBUTING.md) gives the layout of each product and how to test it. `scripts/check.sh` runs every
check CI runs, and `scripts/check.sh STEP` one of them.

- A change to a text the plugin's model reads is an edit of its one file (`plugin/prompts/<text>.md`), and follows
  CONTRIBUTING.md, "Changing what the model reads": change the cause in the text, never add a rule against the
  symptom.
- The browser workbench (`browser/`) keeps its own texts in `browser/prompts/`; from
  `plugin/` it reads the texts that both modes share, such as the citation checker, the look at each answer, a side
  thread's instructions, the label classifier, the guidance on labels and on what a card shows, and main's Citing claims
  (`plugin/prompts/registry.mjs` names each one's readers). `scripts/check.sh parity` checks that both modes read a
  shared text the same, and that the workbench's texts render and name only what its code has.
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
