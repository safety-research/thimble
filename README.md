<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

**thimble** is an open source Claude Code plugin for human oversight. It opens a workbench where you and Claude make sense of large volumes of agent output together. Where Claude Code answers in paragraphs that are hard to understand and verify, thimble answers visually, with charts and cards that cite every claim.

> [!CAUTION]
> - **thimble is in alpha.** It changes daily, so expect bugs and rough edges.
> - **thimble is not an official Anthropic product.**

For feedback, bug reports, or anything else, please reach out to [@mjoerke](https://github.com/mjoerke). I would love to hear from you!

## Demo

https://github.com/user-attachments/assets/e8b0c9d8-1bc0-4ccb-a5ac-4c311cea02d4

## Installation

### With Claude (recommended)

    claude "install thimble from https://github.com/safety-research/thimble"

Claude installs thimble for you, following the Installing section of [CLAUDE.md](CLAUDE.md). It asks you only the
questions the installer lists, often none.

### With the installer

1. Download the zip from the [latest release](https://github.com/safety-research/thimble/releases/latest).
2. Unzip it.
3. Run `bash scripts/install.sh` inside the unzipped folder.

For a development build, clone the repo and run `bash scripts/install.sh`. The installer adds thimble's plugin to
Claude Code with Claude Code's own plugin commands, and the `thimble` command to `~/.local/bin`. It runs no sudo and adds
no permission rules or sandbox to your Claude Code setup.

### By hand

[INSTALL.md, Manual install](INSTALL.md#manual-install) lists each step. A few things work differently there, and
INSTALL.md says which.

## Usage

In a folder with files you'd like to analyze, start `claude` and type `/thimble`. It prints the dashboard's link under
its reply; open it to sign your browser in. In a session that was open when you installed thimble, run
`/reload-plugins` first.

- `thimble` in the folder does the same in one step, and adds terminal mode and `thimble -c`, which continues your
  last conversation there ([what it adds](INSTALL.md#start-thimble)).
- Each start is a new conversation on the same workspace (cards, report, labels).
- thimble follows your Claude Code permission mode. For fewer prompts, start in auto mode: `claude --permission-mode
  auto` or `thimble --permission-mode auto`. For API keys and cloud providers, see [Authentication](INSTALL.md#authentication).

### Terminal mode

In terminal mode, thimble operates as a Claude Code mod and shows its work directly in the terminal, with no server or browser.

![terminal mode: cards under a reply, and the citation panel beside the chat](docs/assets/thimble-term.png)

To switch a directory to terminal mode, run `thimble mode terminal` in it, then `thimble`. `thimble mode browser` switches it back.

## Commands

**Inside a Claude Code session**

| Command | What it does |
|---|---|
| `/thimble` | open this folder in thimble and print the dashboard link |
| `/thimble fresh` | archive this workspace and open an empty one |
| `/thimble restore [<name>]` | bring an archived workspace back |
| `/thimble:orient [focus]` | start an orientation |
| `/thimble:label <name> [definition]` | define a label and apply it to the records |
| `/thimble:write [report\|slides\|story] [request]` | start a writer on a document |

**From a shell** (`thimble help` lists every command)

| Command | What it does |
|---|---|
| `thimble` | start Claude Code with thimble in this folder (a shortcut for `claude`, then `/thimble`); `thimble -c` continues the last session |
| `thimble demo` | download the [demo datasets](demos/README.md) and open them in the browser |
| `thimble mode browser\|terminal` | show thimble's work in the browser or in the terminal |
| `thimble list`, `thimble purge <id>` | list the workspaces, or delete one |
| `thimble doctor` | a checklist of what is installed and running, with the fix for each problem (`--verbose` for the details) |
| `thimble unpair` | sign out every browser |
| `thimble feedback` | write a problem report (a zip) |
| `thimble update`, `thimble uninstall` | update to the latest release, or uninstall |

## Requirements

Claude Code (tested with 2.1.300), with its hooks modules on, macOS or Linux, and Python 3.12+ ([uv](https://docs.astral.sh/uv/) recommended). Node 20+ is needed for custom views (the viewers the dev agent builds for your data), for the sandbox card code and code tickets run in, and for a development build. [INSTALL.md](INSTALL.md) has the details. On Linux, card code runs in a sandbox where bubblewrap can create one (`thimble doctor` says whether it does).

## Security & Privacy

thimble is a research prototype. Please report any security issues privately to [@mjoerke](https://github.com/mjoerke). thimble runs on top of Claude Code: it does not collect any data of its own and all authentication and billing is managed by `claude`. It adds no sandbox or permission rules to your Claude Code session. Its local server answers only on this computer, and only to a browser signed in with thimble's link or to thimble's own programs.

## License

Apache-2.0; see [LICENSE](LICENSE).
