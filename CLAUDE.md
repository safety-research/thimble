# thimble: notes for Claude Code sessions in this repository

This repository holds two products: the terminal plugin for Claude Code (`plugin/`) and the browser workbench
(`browser/`).

## Installing thimble for a user

When the user asks you to install thimble (for example "install thimble from
https://github.com/safety-research/thimble"), do this. The install is done when what they chose works for them: the
plugin in the next `claude` they start in a terminal, and the workbench when they run `thimble-browser`.
[INSTALL.md](INSTALL.md) has the details and the fixes.

1. Ask first, with your question tool (AskUserQuestion) when you have it, which they want, in this order:
   - **The terminal plugin and the browser workbench** (the default; mark it recommended): in their Claude Code
     sessions, Claude cites its claims, a second Claude checks them, and Claude draws cards of the data; the browser
     workbench does the same work in a web page on this machine. The workbench takes about 1 GB of disk and needs
     access to the Claude API: an API key, Workload Identity Federation, or their Claude Code sign-in.
   - **The terminal plugin alone**: only the Claude Code part. It needs Node.js and Python, and no other access.
2. thimble 0.9 is here when `scripts/install.sh` (step 3) stops with what it found and the commands that remove it.
   0.10 does not load while 0.9's plugin is installed.
   Before you remove anything, tell the user plainly that removing 0.9 deletes its workspaces (cards, notebooks,
   labels, reports), which 0.10 cannot open, and offer to move them aside first (`mv ~/.thimble/app/workspaces
   ~/thimble-0.9-workspaces`; a 0.9 clone keeps them in its own `workspaces/`, which removal leaves alone). Remove 0.9
   only on a yes, with the commands the script printed (for `thimble uninstall`, run `~/.local/bin/thimble uninstall
   --yes`, since you cannot answer its question; when it fails, the commands it lists after it). Never pass
   `--remove-0.9`: it needs a terminal. When this session had 0.9 loaded, each tool call then reports "Plugin
   directory does not exist": tell the user to type `/reload-plugins`, and go on.
3. Clone the repository into a folder of its own, such as `~/thimble`, or use the local folder the user names; the
   folder this session runs in may be their own project. The checkout stays where it is: the workbench builds about 1 GB
   in it, and `thimble-browser` runs from it. Run `scripts/install.sh` in the checkout, with `--no-browser` for the
   plugin alone, and `--no-setup` (step 4 asks instead). Leave out `--local` unless the user is working on thimble's own
   code or trying a branch: with it, `thimble update` follows that checkout, which the user then pulls themselves. The
   script prints a few dozen lines, one or two per step, and with the workbench it runs for a few minutes (uv sync, npm
   ci and a build of the page). It checks what is missing first, one line each, and installs nothing until all of it is
   there. Tell the user what is missing and the command that fixes it, run that command only when the user agrees, then
   run the script again.

   The script runs in your shell, and its checks pass or fail there. The plugin runs in the `claude` that the user
   starts from a terminal, on the `node` that terminal finds first: a Node that only your own command loads
   (`nvm use`, fnm, asdf) is not that one. After a change to Node, check what a new terminal finds:
   `$SHELL -ic 'command -v node; node --version'`.
4. When the workbench was installed, set up how it reaches Claude before you reply. Ask with your question tool, in a
   few words per option, since people do not read long ones: their Claude Code sign-in (first; mark it recommended),
   an Anthropic API key, or Workload Identity Federation (WIF). Then:
   - **Claude Code sign-in**: show this text and get a yes: "This uses your Claude subscription through Claude Code
     and will launch headless Claude Code sessions in the background." Run `thimble-browser --setup --how claude-code
     --yes`.
   - **API key**: never see the key. Give the user one command to run in their own terminal (not with `!` here)
     that writes it from the clipboard to a file only they can read, such as `(umask 077; pbpaste >
     ~/.thimble-api-key)` on macOS (Linux: `wl-paste` or `xclip -selection clipboard -o`). When they say it is done,
     run `thimble-browser --setup --key-file ~/.thimble-api-key`. Never read, print or copy that file. Offer to delete it, and delete it only on a yes.
   - **WIF**: ask for the path of its config file, or offer to look for one; on a yes, run `thimble-browser --setup
     --find-wif`, which lists the files it can use, by path only. Run `thimble-browser --setup --how wif --wif-file
     <path>`. Never print the file.

   Each command ends with a check that Claude answers. When the check fails, tell the user what failed and the next
   step, and run the command again after the fix. Say that the page asks at its first start only when the user
   chooses to skip this step.
5. While something the user chose does not work yet, the install is not done: the script's notes, its sandbox line
   and the checks of steps 3 and 4 say what. Fix it, with the user's yes, or give them the step that only they can
   take. Once it works, end with a short reply on how to use what was installed, and when to use each:
   - The plugin, when they work in Claude Code: `/reload-plugins` loads it in this session and in their other open
     ones, and each `claude` they open in a folder of data files has it. A session keeps the PATH and the Claude Code
     it started with, so after a change to Node or Claude Code, they start `claude` in a new terminal. Claude cites
     each claim, and a second Claude checks it against the files; a click on the underlined words opens the evidence.
     The line above the prompt shows the keys: `v` visualize, `s` rewrite, `w` claims, `r` coverage. A click on
     `thimble` in that line, or `/thimble-settings`, opens the settings; `/plugin` turns thimble off.
   - The workbench, when they want to work in a web page, with the folder's files and views of them beside the chat, a
     canvas of cards, labels and a report: run `thimble-browser` in a folder of files and open the sign-in link it
     prints.
6. When the plugin works, offer to show it on the checkout's `examples/sample/runs.csv` (40 made-up nightly test
   runs), in one short line, and never ask the user to type the question or a path. When the checkout lies outside
   this session's folder (a citation can name only files in the folder its session works in), or after a change to
   Node or Claude Code, the line gives a command to run in a new terminal, which starts `claude` in the sample's folder
   with the question, such as:
   `cd ~/thimble/examples/sample && claude "Did the failures start after the config change? Show it as a card."`
   Otherwise the line is "Type /reload-plugins, then try it." (You cannot type `/reload-plugins` for them; it loads
   thimble here.) When they answer after the reload, look at the sample yourself and answer: did the failures start
   after the config change? Answer it as thimble's guidance says: one card, and checked citations. If the line above
   the prompt does not show `thimble` after the reload, say that a new `claude` session in a folder of their own files
   will have it.

## Working on thimble

[CONTRIBUTING.md](CONTRIBUTING.md) gives the layout of each product and how to test it. `scripts/check.sh` runs every
check CI runs, and `scripts/check.sh STEP` one of them.

- A change to a text the plugin's model reads is an edit of its one file (`plugin/prompts/<text>.md`), and follows
  CONTRIBUTING.md, "Changing what the model reads": change the cause in the text, never add a rule against the
  symptom.
- The browser workbench (`browser/`, thimble 0.8's browser mode) keeps its own texts in `browser/prompts/`; from
  `plugin/` it reads only what it runs as the terminal does: the citation checker and the look at each answer.
  `scripts/check.sh parity` checks that they render and name only what its code has.
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
