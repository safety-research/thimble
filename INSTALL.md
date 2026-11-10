# Installing thimble

## What you need

- **macOS or Linux**, with **git** and **curl**. On Windows, **WSL 2**: see [Windows](#windows).
- **Claude Code 2.1.307 or later**; the tour needs 2.1.314 or later.
- **Node.js 22.18 or later** and **Python 3.10 or later**.
- On Linux, **bubblewrap, socat and ripgrep**, for the sandbox that cards run in (on Ubuntu:
  `sudo apt-get install bubblewrap socat ripgrep`).
- For the browser workbench: **[uv](https://docs.astral.sh/uv/) 0.8 or later**, **npm**, and about 2 GB of disk.

### Windows

thimble runs in WSL 2, not in WSL 1 or on Windows itself. In the Linux distribution:

- Install everything above there: `command -v node npm python3 claude` should name nothing under `/mnt`.
- Keep your data in your Linux home folder (`~`), not under `/mnt`.

## Install

    curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash

Options go after `bash -s --`:

- `--no-browser`: the plugin alone, without the browser workbench.
- `--sign-in claude-code`, `--sign-in api-key`, or `--sign-in wif --wif-file PATH`: how the workbench reaches Claude:
  your Claude Code sign-in, `ANTHROPIC_API_KEY` (else a key you paste in the workbench's Settings, Claude access), or
  your Workload Identity Federation config file. Without it, the install asks in a terminal, else the workbench asks
  when it starts. `thimble-browser --setup` changes it later.
- `--bin-dir DIR`: the commands go in `DIR`, not in `~/.local/bin`.
- `--ref REF`: a branch or tag of thimble in place of the newest release. Put it in place of `main` in the address too.

Running the install again is safe: it keeps your install and your fixes, and puts back any part that is missing.

Take the two-minute tour at any time: `thimble tour` in a shell, or `/thimble:tour` in Claude Code.

## Update

    thimble update

Run it in a shell, then type `/reload-plugins` in Claude Code and start `thimble-browser --continue` again. It keeps
your fixes; a fix that does not fit the new release is set aside until `thimble reapply`.

## Uninstall

    claude plugin uninstall thimble@thimble
    claude plugin marketplace remove thimble
    rm -f ~/.local/bin/thimble ~/.local/bin/thimble-browser
    rm -rf ~/.thimble ~/.thimble-browser

The last line also deletes your fixes, the plugin's labels and the workbench's workspaces. The workbench's headless
Chromium stays: delete `~/.cache/ms-playwright` (`~/Library/Caches/ms-playwright` on macOS) if nothing else uses it.

## When something does not work

Run `thimble doctor` in a shell: it checks each part, and gives the fix for each problem it finds.

- **Claude Code is older than 2.1.307, and `claude update` says updates are disabled.** Update it with the package
  manager that installed it (Homebrew, npm or your system's); on a managed machine, ask whoever manages it. Then start
  a new `claude` session.
- **Claude Code's sandbox is on.** It may refuse the install's writes outside the folder Claude works in. Let Claude
  run the install outside the sandbox, or run it in your own terminal.
- **The download failed.** Let github.com and release-assets.githubusercontent.com through your firewall
  (codeload.github.com too, for `--ref`). Behind a proxy, set `https_proxy`. Then run the install again.
- **`thimble: command not found` in a shell** (or `thimble-browser`). Add `export PATH="$HOME/.local/bin:$PATH"` to
  your shell's startup file, such as `~/.zshrc` or `~/.bashrc`, and open a new terminal.
- **No thimble line above the prompt, or `thimble: command not found` in Claude's Bash calls.** The plugin is not
  loaded: trust the folder, and turn thimble on in `/plugin`. Managed settings that set `disableAllHooks` turn it off.
- **Cards cannot draw**, in Claude Code or in the workbench. The sandbox that cards run in cannot start here: do what
  the message says, then try the card again.
- **The line above the prompt says your Node is too old, though a newer one is installed.** Add your Node manager's
  lines (nvm, fnm, asdf) to `~/.zshrc` or `~/.bashrc`, or put the newer Node first on your `PATH`. Then start `claude`
  in a new terminal.
- **thimble misbehaves after a fix.** `thimble fix off N` turns fix N off, and `thimble fix off` all of them. When
  thimble does not load, `sh ~/.thimble/fixes/off.sh` turns them all off. Then type `/reload-plugins`.
- **The workbench says Claude refused the credentials (401).** Check the credentials it names. Whoever manages them
  can see the reason: give them the time in the message.
