<p align="center"><img src="docs/assets/thimble-banner.svg" alt="thimble" width="100%"></p>

**thimble** is an open source Claude Code plugin for human oversight. It opens a workbench where you and Claude make sense of large volumes of agent output together.

> [!CAUTION]
> - **thimble is in alpha.** It changes daily, so expect bugs and rough edges.
> - **thimble is not an official Anthropic product.**

For feedback, bug reports, or anything else, please reach out to [@mjoerke](https://github.com/mjoerke). I would love to hear from you!

## Demo

https://github.com/user-attachments/assets/3c21e405-6b8d-4ba6-85a8-24211800596c

## Installation

### Installing with Claude

```
claude "install thimble from https://github.com/safety-research/thimble"
```

### Manual

1. Download the zip from the [latest release](https://github.com/safety-research/thimble/releases/latest).
2. Unzip it.
3. Run `bash scripts/install.sh` inside the unzipped folder.

For a development build, clone the repo and run `bash scripts/install.sh` (requires Node 20+).

[INSTALL.md](INSTALL.md) covers requirements, updating and troubleshooting.

## Usage

- Run `thimble` in a directory, just as you would run `claude` 
- It starts a Claude Code session there with the thimble plugin loaded and prints the dashboard URL. The session is named `thimble:main · <workspace>` (as `claude agents` and `/resume` list it), and each agent thimble starts is named the same way, such as `thimble:orient · <workspace>`.
- Each run starts a new conversation on the same workspace (cards, report, labels). `thimble --continue` picks up your last conversation in this folder instead.
- Quitting the session stops thimble's agents, and its server once no other thimble session runs. An orientation or a writer that was working goes on at your next `thimble`.
- The orientation, its critic and the writers run as Claude Code background sessions. ↓ at the prompt opens the agent tray, where you can follow and message them, and `claude attach <id>` opens one in another terminal. They need Claude Code to trust thimble's workspaces folder, which install.sh asks about (`--trust-workspaces`).

### From a running Claude Code session

Type `/thimble` to start the thimble server and print the dashboard URL. A plain `claude` session has `/thimble` only if you answered yes to install.sh's plugin question (`--plugin`); in one started before that, run `/reload-plugins`.

> **Please note:** thimble connects the browser to your Claude Code session through [channels](https://code.claude.com/docs/en/channels). While thimble is under development, a Claude Code session needs to be started with `--dangerously-load-development-channels` (`thimble` from the CLI handles this for you) and a warning screen will appear before starting your Claude Code session (this warning is expected). Without this flag, or if channels are disabled by your org, thimble connects through the plugin's hooks instead and `/thimble` prints a note with the exact command.

## Commands

**Inside a Claude Code session**

| Command | What it does |
|---|---|
| `/thimble` | start the thimble server and print the dashboard URL |
| `/thimble fresh` | archive this workspace and open an empty one |
| `/thimble restore [<name>]` | bring an archived workspace back; with no name, list them |
| `/thimble status` | one line: server, orientation, queue |
| `/thimble fix` | repair a server that will not start |
| `/thimble feedback` | write a problem report (a zip), even with the server down |
| `/thimble:ask <thread> [message]` | send a message to a thread, as its composer in the browser would |
| `/thimble:orient [focus] [flags]` | start an orientation, with Start's switches as flags |

**From a shell**

| Command | What it does |
|---|---|
| `thimble update` | update to the latest release |
| `thimble server up\|status\|stop\|restart` | manage the thimble server |
| `thimble doctor` | print the install state |
| `thimble list` | list the workspaces by id (each folder's, and its archived runs), when each was last used and its open sessions |
| `thimble purge <id>... [-y] [--dry-run]` | delete workspaces or archived runs by id and print what was deleted (`--dry-run` only shows what would go); never your data folder or Claude Code's transcripts |
| `thimble feedback ["<what went wrong>"]` | write a problem report (a zip) and say where to send it; the top bar's bug icon does the same |
| `thimble revert` | undo the last change thimble's dev agent applied |
| `thimble uninstall` | uninstall the package |

## Requirements

Claude Code (tested with 2.1.281), macOS or Linux, and Python 3.12+ ([uv](https://docs.astral.sh/uv/) recommended). Node 20+ is needed for custom views (the viewers the dev agent builds for your data) and for a development build. [INSTALL.md](INSTALL.md) has the details.

## Security and privacy

- **thimble is a research prototype.** Its server has no login, so any program on your machine can use it, and Claude's code runs in a notebook kernel without a sandbox: treat a corpus like code you are about to run.
- **Your data stays with you.** The server runs on localhost. What leaves your machine is what Claude Code sends to the model and what Claude's notebook code or Claude Code's web tools reach on the network, as in any Claude Code session. A video's narration is read by a voice on your machine.
- **Auth and billing work through Claude Code**; thimble doesn't touch them.
- **Report security issues** privately to [@mjoerke](https://github.com/mjoerke).

## License

Apache-2.0; see [LICENSE](LICENSE).
