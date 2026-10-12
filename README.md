<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

**thimble** is an open source Claude Code plugin for human oversight. It opens a workbench where you and Claude make sense of large volumes of agent output together.

> [!CAUTION]
> - **thimble is in alpha.** It changes daily, so expect bugs and rough edges.
> - **thimble is not an official Anthropic product.**

For feedback, bug reports, or anything else, please reach out to [@mjoerke](https://github.com/mjoerke). I would love to hear from you!

## Demo

https://github.com/user-attachments/assets/e8b0c9d8-1bc0-4ccb-a5ac-4c311cea02d4

## Installation

### Quickstart (with Claude)

```
claude "install thimble from https://github.com/safety-research/thimble"
```

Instructions for agents installing thimble on the user's behalf are in [CLAUDE.md](CLAUDE.md).

### Manual

1. Download the zip from the [latest release](https://github.com/safety-research/thimble/releases/latest).
2. Unzip it.
3. Run `bash scripts/install.sh` inside the unzipped folder.

For a development build, clone the repo and run `bash scripts/install.sh`. [INSTALL.md](INSTALL.md) covers requirements, updating and troubleshooting.

## Usage

Run `thimble` in a directory with files you'd like to analyze, just like you would run `claude`.
- It starts a Claude Code session there with the thimble plugin loaded, inside thimble's sandbox, and prints the dashboard URL. 
- Each run starts a new conversation on the same workspace (cards, report, labels). `thimble --continue` picks up your last conversation in this folder instead.

### Terminal mode

In terminal mode, thimble operates as a Claude Code mod and shows its work directly in the terminal, with no server or browser.

![terminal mode: cards under a reply, and the citation panel beside the chat](docs/assets/thimble-term.png)

To switch to terminal mode, run `thimble mode terminal` before running `thimble` in a directory. You can switch back to browser mode by running `thimble mode browser`.

## Commands

**Inside a Claude Code session**

| Command | What it does |
|---|---|
| `/thimble` | start the thimble server and print the dashboard URL |
| `/thimble fresh` | archive this workspace and open an empty one |
| `/thimble restore [<name>]` | bring an archived workspace back; with no name, list them |
| `/thimble status` | one line: server, orientation, queue |
| `/thimble fix` | in a development install, repair a server that will not start |
| `/thimble feedback` | write a problem report (a zip) |
| `/thimble:ask <thread> [message]` | send a message to a thread |
| `/thimble:orient [focus] [flags]` | start an orientation, with Start's switches, model and effort as flags |
| `/thimble:label <name> [definition] [kind=regex\|code\|prompt] [paths=<glob>,…] [values=a,b] [limit=N]` | define a label and apply it to the corpus's records |
| `/thimble:write [report\|slides\|story\|<type>] [request]` | start a writer on a document, the report when none is named |

**From a shell** (`thimble help` lists these)

| Command | What it does |
|---|---|
| `thimble` | start thimble in this folder; `thimble -c` continues the last thimble session here |
| `thimble demo [<name>...]` | download public datasets (collusion-wiki, mythos-5, transluce-urlquery) from their publishers, asking before each, and open the start page that lists them in the browser, each on an orientation run ahead of time where [demos/](demos/README.md) has one; it starts no Claude Code session (`--attach` starts one; `cd <folder> && thimble` attaches one later, `thimble -c` continues). `thimble demo --export <workspace> <out>` writes a workspace whole, with the transcripts of its sessions, and lists what it holds ([INSTALL.md](INSTALL.md#demo-datasets)) |
| `thimble list` | list the workspaces by id (each folder's, and its archived runs), when each was last used and its open sessions |
| `thimble purge <id>... [-y] [--dry-run]` | delete workspaces or archived runs by id and print what was deleted (`--dry-run` only shows what would go); never your data folder or Claude Code's transcripts |
| `thimble extension add <folder\|git URL>` | add an extension and switch it on, after showing what it gives |
| `thimble extension list\|on\|off\|remove [<name>]` | list the extensions, switch one on or off everywhere, or remove it |
| `thimble mode [browser\|terminal] [--default]` | where `thimble` in this folder shows its work: in the browser, or in the terminal with no server (`--default`: every folder without a mode of its own) ([INSTALL.md](INSTALL.md#terminal-mode)) |
| `thimble plugin on\|off\|status` | thimble in every Claude Code session, or only in the sessions `thimble` starts |
| `thimble doctor` | what is installed and running, and what is wrong |
| `thimble feedback ["<what went wrong>"]` | write a problem report (a zip) and say where to send it; the top bar's bug icon does the same |
| `thimble update` | update to the latest release |
| `thimble uninstall` | uninstall the package |

A development install (a git clone) also has `thimble fix` and `thimble revert`, and the commands for running a checkout; [CONTRIBUTING.md](CONTRIBUTING.md) lists them.

## Requirements

Claude Code (tested with 2.1.295), with its hooks modules on, macOS or Linux, and Python 3.12+ ([uv](https://docs.astral.sh/uv/) recommended). Node 20+ is needed for custom views (the viewers the dev agent builds for your data), for the sandbox card code and code tickets run in, and for a development build. [INSTALL.md](INSTALL.md) has the details.

## License

Apache-2.0; see [LICENSE](LICENSE).
