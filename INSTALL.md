# Installing thimble

thimble has two products: the plugin for Claude Code, and the browser workbench, a web page that runs on your machine.
One script installs both, or the plugin alone, in `~/.thimble`.

## What you need

- **macOS or Linux**, with **git** and **curl**. On Windows, **WSL 2**: see [Windows](#windows) below.
- **Node.js 22.18 or later** (the workbench alone runs on 22.12 or later) and **Python 3.10 or later** (`python3`, or
  the Python that `THIMBLE_PYTHON` names). Check with `node --version` and `python3 --version`.
- **Claude Code 2.1.314 or later**. Check with `claude --version`. `claude update` updates it, unless a package manager
  installed it: then that package manager does (`brew upgrade claude-code`,
  `npm install -g @anthropic-ai/claude-code@latest`, or your system's), and the install names the one for yours.
- For the workbench: **[uv](https://docs.astral.sh/uv/) 0.8 or later**, **npm** (it comes with Node.js), and about
  2 GB of disk.
- On Linux, **bubblewrap, socat and ripgrep**, for Anthropic's [sandbox
  runtime](https://github.com/anthropics/sandbox-runtime), which the code Claude writes for a card runs in (on Ubuntu:
  `sudo apt-get install bubblewrap socat ripgrep`). macOS has its own sandbox.

The install checks these first, except the sandbox's packages. When something is missing, it says what, with the
command that installs it, and installs nothing until it is there. When the sandbox cannot start, the install finishes
and its last note says how to fix it.

### Windows

thimble runs in WSL 2, in a Linux distribution such as Ubuntu. It does not run on Windows itself yet, nor in WSL 1,
which has no namespaces for the sandbox that cards run in (`wsl --set-version NAME 2`, in Windows, converts a
distribution; the install stops in WSL 1 and says so). In the distribution:

- Install everything above there, with its package manager (on Ubuntu, `sudo apt-get install git python3 bubblewrap
  socat ripgrep`), and Node.js and Claude Code too. thimble needs Linux's `node`, `npm`, `python3` and `claude`, not
  the Windows ones that WSL puts on `PATH` from Windows' drives, under `/mnt`: `command -v node npm python3 claude`
  should name none there, and the install says which it finds there.
- Keep thimble and your data in Linux's file system, in your home folder (`~`), not on Windows' drives under `/mnt`:
  files there go through a slow bridge (9P), and the file modes thimble sets and checks do not hold there.
- thimble opens links in Windows' browser with `wslview`, from wslu (`sudo apt-get install wslu`). The workbench's link
  (127.0.0.1) opens in Windows' browser too, since WSL 2 passes localhost through.

## Install

Ask Claude Code:

    claude "install thimble from https://github.com/safety-research/thimble"

Claude asks whether you want both products or the plugin alone, and how the workbench reaches Claude, then runs the
script; its steps are in CLAUDE.md, "Installing thimble for a user". At the end, type `/reload-plugins`: a two-minute
tour of thimble starts in the same session. Or run the script yourself:

    curl -fsSL https://raw.githubusercontent.com/safety-research/thimble/main/scripts/install.sh | bash

In a terminal, it ends with the question whether to take the tour now. `thimble tour` copies made-up sample data into
`~/.thimble/tour` and opens Claude Code there. Claude writes an answer about the data, and thimble shows you one step
at a time under it, and goes on to the next step when you do the one before.

Options go after `bash -s --`:

- `--no-browser`: the plugin alone.
- `--sign-in claude-code`, `--sign-in api-key`, or `--sign-in wif --wif-file PATH`: how the workbench reaches Claude.
  - Your Claude Code sign-in: the workbench runs Claude Code in the background, on your Claude plan, with the
    environment as it is, so that Claude Code signs in as it does in your terminal.
  - An API key: `ANTHROPIC_API_KEY` when it is set where the workbench runs, otherwise a key you paste in the
    workbench's Settings, Claude access.
  - Workload Identity Federation: the path of your WIF config file (`browser/backend/app/wif.py` lists its keys).

  Without `--sign-in`, the script asks in a terminal, and otherwise the workbench asks when it starts. The script
  checks the choice with one small call. `thimble-browser --setup` changes it later.
- `--bin-dir DIR`: the commands go in `DIR`, not in `~/.local/bin`.
- `--ref REF`: a branch or tag of thimble in place of the newest release, to try a branch before its release: the
  release's file when the tag has one, else GitHub's archive of it. Put the same name in place of `main` in the
  address.
- `--remove-0.9`: see [thimble 0.9](#thimble-09).

You can run it again at any time: an install in `~/.thimble` stays as it is, with your fixes, and the script puts in
place any part that is missing. It does the same when you run it from a downloaded release or a clone.

## Where things go

- `~/.thimble/fixes/live`: the release, from its file (`thimble-X.Y.Z.tar.gz`, about 6 MB), as a git repository of its
  own, where `/thimble-fix` keeps your fixes as commits. Claude Code loads the plugin from here (`claude plugin marketplace add` with this folder, then
  `claude plugin install thimble@thimble`), and keeps a copy in its own folder of plugins. The plugin's settings
  (`/thimble-settings`) stay in Claude Code's settings (`pluginConfigs`).
- `~/.thimble/fixes/release`: the plain release, which no fix changes. `thimble fix off` and the rest of the way back
  from your fixes run from here.
- `~/.thimble/fixes/live/browser`: the workbench, with its packages and its page (about 1 GB).
- `~/.cache/ms-playwright` (`~/Library/Caches/ms-playwright` on macOS): the headless Chromium the workbench draws
  cards in, which the install downloads where it finds no Chrome, Edge or Chromium (about 650 MB).
- `~/.thimble`: also the plugin's records (labels, coverage) and the sandbox runtime (`~/.thimble/srt`).
  `THIMBLE_HOME` sets another folder.
- `~/.thimble-browser`: the workbench's workspaces and how it reaches Claude. `THIMBLE_BROWSER_HOME` sets another
  folder.
- `~/.local/bin/thimble` and `~/.local/bin/thimble-browser`: the commands, which run the code in `~/.thimble`.

An install from before 0.10.8 (in a clone such as `~/thimble`, or in `~/thimble-0.10.8`) moves into `~/.thimble`, with
its settings and fixes, when you run the script or `thimble update`.

## Update

    thimble update

Run it in a shell, not inside Claude Code. It downloads the newest release's file, moves both products to that release
and keeps your fixes: each one that still fits the release stays on, once thimble's checks pass with it there; one that
does not is off, kept in `thimble fixes`, until `thimble reapply` has Claude fit it. Then type `/reload-plugins` in
Claude Code, and start `thimble-browser` again. Claude Code sessions say when a newer release is out.

GitHub counts the downloads of each release's file; thimble sends nothing else.

## Uninstall

    claude plugin uninstall thimble@thimble
    claude plugin marketplace remove thimble
    rm -f ~/.local/bin/thimble ~/.local/bin/thimble-browser
    rm -rf ~/.thimble ~/.thimble-browser

The last line also deletes your fixes, the workbench's workspaces and the plugin's labels. Your data folders stay as
they are. The workbench's headless Chromium stays in `~/.cache/ms-playwright` (on macOS `~/Library/Caches/ms-playwright`):
delete it if nothing else uses it.

## The dev install

To work on thimble's own code, clone the repository and run the script with `--local` in the clone:

    git clone https://github.com/safety-research/thimble ~/thimble
    ~/thimble/scripts/install.sh --local

Claude Code then loads the plugin from the clone, and the workbench is built in it. `thimble update` follows the
clone: pull it, then run `thimble update`, which moves thimble and your fixes onto the commit you checked out (it never
pulls, and says when the clone is behind what it pulls from). Your fixes also live in the clone, as the branch `mine`
and the refs under `refs/thimble/`. To try a branch without working on it, use `--ref`.

A release installed in `~/.thimble` goes aside first, with its fixes, into a dated folder beside them, such as
`~/.thimble/fixes-release-20261103-183000`, and the script says where. Run the script without `--local` to switch back:
the release comes back with its fixes, and the dev install's fixes go aside in the same way
(`~/.thimble/fixes-dev-<date>`) until `--local` in the same clone brings them back.

## thimble 0.9

thimble 0.10 replaces 0.9: while 0.9's plugin is installed, Claude Code loads it and skips 0.10's, with no error. The
script stops when it finds 0.9, says what it found and prints the commands that remove it: run them, then the script
again. In a terminal, `--remove-0.9` runs them after you answer y, and first offers to move 0.9's workspaces (its
cards, notebooks, labels and reports, which 0.10 cannot open) to `~/thimble-0.9-workspaces`. Restart the `claude`
sessions that were open, or type `/reload-plugins` in them: until then they say "Plugin directory does not exist" after
each tool call. 0.9 also left a headless Chromium in `~/.cache/ms-playwright` (about 650 MB). Where the install
downloads the workbench's own there, it removes the builds that nothing uses; elsewhere, delete the folder if nothing
else uses it.

## When something does not work

Run `thimble doctor` in a shell: it checks each part thimble needs, and gives the fix for each problem it finds.

The install:

- **Claude Code is older than 2.1.314, and `claude update` says updates are disabled.** A package manager installed
  Claude Code (Homebrew, npm, or your system's packages, such as an AUR or Nix package), and it updates it: the
  install names the command for yours. On a machine that an organization manages, whoever manages it updates Claude
  Code. Then start a new `claude` session: one that was open keeps its version.
- **Claude Code's own sandbox is on** (`"sandbox": {"enabled": true}` in its settings, so Claude's commands run in it).
  When Claude installs thimble, the install writes outside the folder Claude works in (`~/.thimble`,
  `~/.thimble-browser`, `~/.claude/plugins`, `~/.local/bin`) and downloads packages, which that sandbox may refuse;
  Claude then asks to run the script outside it, or you run it in your own terminal. The install's check of the card
  sandbox may fail inside Claude Code's sandbox for that reason alone. The check that counts is a card drawn in a new
  `claude` session: a card that cannot draw says why in the line above the prompt.
- **The download failed.** The script says curl's line, or what is wrong with the release's file. A firewall must let
  github.com and release-assets.githubusercontent.com through (codeload.github.com too for `--ref`). Behind a proxy,
  the download goes through the one `https_proxy` names, else the one git's config names (`git config --global
  http.proxy`). Check the network, then run the script again: nothing was installed.
- **`~/.local/bin` is not on your `PATH`.** A note at the end of the install gives the line to add to your shell's
  startup file. Until then, start the commands by their full paths.

The plugin:

- **No line above the prompt.** The plugin is not loaded in this session. Check that the folder is trusted and that
  thimble is enabled in `/plugin`. Managed settings that set `disableAllHooks` turn thimble off.
- **`thimble: command not found` in Claude's Bash calls.** The same: the plugin is not loaded.
- **A line above the prompt says something failed.** It says what failed and why, and what to try when there is
  something to try. It goes when you type your next prompt.
- **thimble misbehaves, or does not load, after you used a fix.** `thimble fix off N` in a shell turns off fix N, and
  `thimble fix off` all of them; `sh ~/.thimble/fixes/off.sh` does the same when thimble does not load, and runs no
  thimble code. Then type `/reload-plugins`. `thimble doctor` names a fix that keeps Claude Code from loading thimble.
  These run from `~/.thimble/fixes/release`, a copy of the release that no fix changes, so a fix cannot break them, not
  even one that changed the launcher or the sandbox.
- **"Cards cannot draw: cards run only in Anthropic's sandbox runtime, which cannot start here".** Cards never run
  without the sandbox. The line says why and gives the fix: on Linux, the command that installs bubblewrap, socat or
  ripgrep, or, on a Linux whose AppArmor keeps bubblewrap from making namespaces, the command that allows it; when npm
  cannot reach its registry to install the sandbox, `npm ping` shows why. The next card tries again, with no new
  session. To test the sandbox by hand, run `node ~/.thimble/fixes/live/plugin/sandbox/setup.mjs --probe`, which draws
  a test card in it (add `--repair` to install the sandbox again when that fixes it, as the install does).
- **The line above the prompt says your Node is too old, though a newer one is installed.** The plugin runs on the
  `node` that the terminal you start `claude` from finds first. A Node manager (nvm, fnm, asdf) that your shell's
  startup file does not load is not used, even when the install loaded it in its own commands, as Claude may when it
  installs thimble. In a new terminal, `command -v node; node --version` says which Node that is. Add the manager's
  lines to `~/.zshrc` or `~/.bashrc` (or put the newer Node first on your `PATH`), open a new terminal, and start
  `claude` there: `/reload-plugins` keeps the session's old `PATH`.

The workbench:

- **`thimble-browser: command not found`.** `~/.local/bin` is not on your `PATH`. Add it, or run the launcher by its
  full path.
- **The install's sign-in line says that the check failed.** It says why, and the command to run after you fix that,
  such as `thimble-browser --setup --how wif --wif-file ~/wif.toml`. With your Claude Code sign-in, the line names the
  login Claude Code uses: an `ANTHROPIC_API_KEY` in the environment, or an `apiKeyHelper` in Claude Code's settings,
  takes the place of your Claude plan, as it does in your terminal.
- **Cards say that code does not run.** The sandbox does not work here, and the card says why. On Linux, install
  bubblewrap; on a Linux whose AppArmor keeps bubblewrap from making namespaces, the card says how to allow it.
  After the fix, run the card again.
- **The chat says the credentials failed (401).** It names the credentials it used and the time. Check them in
  Settings, Claude access; whoever manages the credentials can see the reason on the admin side.
