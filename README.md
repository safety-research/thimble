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

Instructions for agents installing thimble on the user's behalf are in [CLAUDE.md](CLAUDE.md).

### Manual

1. Download the zip from the [latest release](https://github.com/safety-research/thimble/releases/latest).
2. Unzip it.
3. Run `bash scripts/install.sh` inside the unzipped folder.

For a development build, clone the repo and run `bash scripts/install.sh`. 

[INSTALL.md](INSTALL.md) covers requirements, updating and troubleshooting.

## Usage

- Run `thimble` in a directory, just as you would run `claude` 
- It starts a Claude Code session there with the thimble plugin loaded, inside thimble's sandbox, and prints the dashboard URL. 
- Each run starts a new conversation on the same workspace (cards, report, labels). `thimble --continue` picks up your last conversation in this folder instead.

### thimble's agents

- The orientation, its critic, the writers, view builds, view reviews and report checks run as subagents of your Claude Code session. Claude Code's agent tray shows them beside the browser's threads, and they run in your session's permission mode and sandbox.
- A button in the browser, such as Start or Write, starts its agent at once, without a turn of Claude's. Asked in the terminal, Claude starts it with its own Agent call.
- When an agent finishes, your terminal shows its report arriving and one short line from Claude.
- Quitting Claude Code stops them, and nothing restarts them on its own: `thimble -c` and a message in the agent's thread continue one, and Retry starts a view build, review or check again.
- Models and efforts in Settings apply to the next start, with no restart. Start, `/thimble:orient` and Claude's start tools take a model and an effort for one run.

### From a running Claude Code session

In a session started with `thimble`, type `/thimble` to start the thimble server and print the dashboard URL. If a session you started with plain `claude` doesn't recognise `/thimble`, quit it and run `thimble` in that folder. A plain `claude` session that has thimble's plugin runs without thimble's sandbox and can't start thimble's agents, and `/thimble` warns about it.

> **Please note:** thimble connects the browser to your Claude Code session through the plugin's [hooks](https://code.claude.com/docs/en/hooks). If your settings or your organization turn the plugin's hooks off, thimble connects through a Monitor instead: permission prompts appear only in the terminal, you say `/thimble` again after `/clear` (in a session `thimble` started, you quit and run `thimble -c` instead, since thimble's sandbox lets out only the `/thimble` of the session it started), and `/thimble` prints a warning that says so. thimble's agents start through the plugin's hooks module, so where Claude Code's hooks modules are off (managed settings with `disableAllHooks` or `allowManagedHooksOnly`, or a folder Claude Code doesn't trust), they can't start. The launcher and the browser say so, and Claude, its threads, cards and labels still work.

## Claude Code Mod (Experimental)

Thimble can also operate as a [Claude Code Mod](https://code.claude.com/docs/en/plugins/mods/overview) that operates directly in the Claude Code terminal UI, with no server or browser. Plots, verification links, and threads are all rendered in the terminal. The `thimble-cc-mod` plugin is experimental and may break.

![thimble-cc-mod in the Claude Code terminal](docs/assets/thimble-cc-mod.png)

```
cd <directory you want to analyze>
thimble cc-mod on
claude
```

## Commands

**Inside a Claude Code session**

| Command | What it does |
|---|---|
| `/thimble` | start the thimble server and print the dashboard URL |
| `/thimble fresh` | archive this workspace and open an empty one |
| `/thimble restore [<name>]` | bring an archived workspace back; with no name, list them |
| `/thimble status` | one line: server, orientation, queue |
| `/thimble fix` | in a development install, repair a server that will not start |
| `/thimble feedback` | write a problem report (a zip), even with the server down |
| `/thimble:ask <thread> [message]` | send a message to a thread, as its composer in the browser would |
| `/thimble:orient [focus] [flags]` | start an orientation, with Start's switches, model and effort as flags |

**From a shell** (`thimble help` lists these)

| Command | What it does |
|---|---|
| `thimble` | start thimble in this folder; `thimble -c` continues the last thimble session here |
| `thimble demo [<name>...]` | download public datasets (collusion-wiki, mythos-5, transluce-gov, transluce-urlquery) from their publishers, asking before each, and open each in the browser, on an orientation run ahead of time where [demos/](demos/README.md) has one; then asks whether to attach a Claude Code session (`cd <folder> && thimble` later, `thimble -c` to continue). `thimble demo --export <workspace> <out>` writes a workspace whole, with the transcripts of its sessions, and lists what it holds ([INSTALL.md](INSTALL.md#demo-datasets)) |
| `thimble list` | list the workspaces by id (each folder's, and its archived runs), when each was last used and its open sessions |
| `thimble purge <id>... [-y] [--dry-run]` | delete workspaces or archived runs by id and print what was deleted (`--dry-run` only shows what would go); never your data folder or Claude Code's transcripts |
| `thimble extension add <folder\|git URL>` | add an extension and switch it on, after showing what it gives |
| `thimble extension list\|on\|off\|remove [<name>]` | list the extensions, switch one on or off everywhere, or remove it |
| `thimble cc-mod on\|off\|status` | switch thimble-cc-mod, a single-agent thimble inside Claude Code, on or off in this folder ([INSTALL.md](INSTALL.md#thimble-cc-mod)) |
| `thimble plugin on\|off\|status` | thimble in every Claude Code session, or only in the sessions `thimble` starts |
| `thimble doctor` | what is installed and running, and what is wrong |
| `thimble feedback ["<what went wrong>"]` | write a problem report (a zip) and say where to send it; the top bar's bug icon does the same |
| `thimble update` | update to the latest release |
| `thimble uninstall` | uninstall the package |

A development install (a git clone) also has `thimble fix` and `thimble revert`, and the commands for running a checkout; [CONTRIBUTING.md](CONTRIBUTING.md) lists them.

## Requirements

Claude Code (tested with 2.1.291), with its hooks modules on, macOS or Linux, and Python 3.12+ ([uv](https://docs.astral.sh/uv/) recommended). Node 20+ is needed for custom views (the viewers the dev agent builds for your data), for the sandbox card code and code tickets run in, and for a development build. [INSTALL.md](INSTALL.md) has the details.

## Security and privacy

- **thimble is a research prototype.** Its server has no login, so any program on your machine can use it. Claude's notebook code runs in a sandbox that keeps the network, so it can reach local services, thimble's server among them: treat a corpus like code you are about to run.
- **Your data stays with you.** The server runs on localhost. What leaves your machine is what Claude Code sends to the model and what Claude's notebook code or Claude Code's web tools reach on the network, as in any Claude Code session. A video's narration is read by a voice on your machine.
- **Auth and billing work through Claude Code**; thimble doesn't touch them.
- **Report security issues** privately to [@mjoerke](https://github.com/mjoerke).

## License

Apache-2.0; see [LICENSE](LICENSE).
