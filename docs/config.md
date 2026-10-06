# thimble's config

thimble's agents take their settings from `~/.thimble/config.json` (`$THIMBLE_HOME/config.json` when THIMBLE_HOME is set). With no file, every agent runs on the defaults below. A workspace can override any key but `browser`, `cardWait` and `extensions` in `workspaces/<workspace>/config.json`. Objects merge key by key, and `null` means thimble's default.

The Settings pane writes this file for the models, efforts, fast mode and permission modes. Each change goes to the file the value came from, so a key the workspace's file sets is changed there. Edit the file by hand for everything else. A change applies to the next session an agent starts.

When one of thimble's agents edits this file or a workspace's `config.json`, it asks you first, in every permission mode, Bypass and Auto included, like an edit of the corpus with `data` at `"ask"`. The permission card shows the edit, and says that thimble asks because it changes thimble's config. A session that has nobody to ask, such as an extension's program run without a chat or `thimble fix`, can't edit these files.

thimble changes none of Claude Code's settings. Your own Claude Code settings still apply to every agent, and thimble's rules are added to them.

```json
{
  "installs": "ask",
  "sandbox": { "use": "when-available", "enforce": true },
  "browser": "system",
  "agents": {
    "orientation": { "model": "claude-opus-5-5", "effort": "ultracode" },
    "writer": { "data": "off" },
    "dev": { "web": "off" }
  }
}
```

If the file isn't valid JSON, or a key or value is unknown, no agent starts. The Settings pane and `thimble doctor` show the error, which names the file and the key. `thimble doctor` also prints which file is read and which browser is used.

## Top-level keys

| Key | Values | Default | What it does, and the risk |
|---|---|---|---|
| `installs` | `"ask"`, `"deny"`, `"allow"` | `"ask"` | Commands that install software or download files: package managers (`pip install`, `npm install`, `npx`, `uv add`, `apt`, `brew` and others), `curl`, `wget`, `git clone`, `playwright install`, `thimble extension add` and `sudo`. `"ask"` sends each one to you in every permission mode, Bypass and Auto included, also with options before the subcommand, inside `bash -c` or called by path. It catches ordinary commands, but it can't stop one written to get around it, such as a script that downloads files itself. `"deny"` refuses them. `"allow"` leaves them to the agent's permission mode, so in Bypass or Auto an agent can install software without asking you. View builds refuse them without asking you while the dev agent's `network` is `"off"`. |
| `sandbox.use` | `"when-available"`, `"never"` | `"when-available"` | Runs the agents' Bash in Claude Code's sandbox where it can run (Linux needs bubblewrap and socat; `thimble doctor` says what is missing). In the sandbox, Bash can't write outside the agent's own folder and has no network unless the agent's `network` is `"on"`. A code ticket's Bash can also commit to the ticket's branch. The ticket's checks, and the copy of thimble the server screenshots before and after the change, run in thimble's sandbox runtime (Anthropic's sandbox runtime, installed with thimble; it needs Node 20.11 or later, and on Linux bubblewrap, socat and ripgrep): no network, no view of your home folder, and writes only to the ticket's worktree and its cache. The edited code first runs outside a sandbox once merged into your install, so just before that thimble asks "Apply this change to thimble's own code?", in every permission mode, Bypass and Auto included, and merges only on your Allow, and only the change it named; otherwise the change stays on its branch. `thimble fix` asks the same in the terminal. Where the sandbox runtime can't run (`thimble doctor` says why), a ticket's checks run outside the sandbox, so thimble also asks before the ticket starts. `"never"` turns the sandbox off, so Bash runs with your user's full access, limited only by the permission mode; set `sandbox.enforce` to `false` as well, or no agent starts. |
| `sandbox.enforce` | `true`, `false` | `true` | `true` refuses to start an agent whose Bash would run outside the sandbox, and says why. On Linux, run the installer again with `--sandbox-deps` to install what the sandbox needs. With `false`, agents run without the sandbox where it can't run. Your own Claude Code session (main) runs either way. |
| `browser` | `"system"`, `"bundled"`, `"off"` | the system browser when one is found, else Playwright's Chromium if installed, else off | The browser for screenshots: card checks, view checks and reviews, and the screenshot tool. `"system"` uses Chrome, Edge or Chromium installed on the machine. `"bundled"` uses the Chromium that the installer downloaded. `"off"` takes no screenshots, so cards and views are checked without pictures and graphics aren't repaired. Only in the file in thimble's home. Run `thimble restart` after changing it. |
| `cardWait` | minutes, a number above 0 and up to 720 | `10` | How long a permission card waits for your answer. A request nobody answers in that time is declined, and the card says so, with the wait. It is the same for every agent and program thimble starts, and for the cards that ask before a change reaches thimble's own code or a view installs a package. A change applies to the next card. Only in the file in thimble's home. |
| `extensions.<name>.enabled` | `true`, `false` | `true` | `false` switches the extension off in every workspace. `thimble extension off <name>` writes it and `thimble extension on <name>` takes it out. Settings → Extensions switches one off for a single workspace. Only in the file in thimble's home. |

## Agents

`agents` has one entry per agent:

- **`orientation`**: the orientation and its subagents
- **`critic`**: the critique of the orientation, which runs only when Start's Critique and revise switch (off by default) or `/thimble:orient --critique` turns it on
- **`writer`**: the report writers
- **`checks`**: the report checks
- **`dev`**: code tickets and view builds
- **`labels`**: the label classifier, and the call that checks whether an extension's view fits a corpus
- **`cardCheck`**: the card check's reading of a card's picture, and a view review's reading of its pictures

`labels` and `cardCheck` are single model calls with no tools, so they take only `model`, `effort`, `fast` and `prompt`. Each such call runs at exactly the model, effort and fast mode Settings shows for its row, the defaults included (`labels`: Opus 5.5 at low effort, fast mode off; `cardCheck`: Opus 5.5 at high effort, fast mode on), and so does the dev agent's one call that proposes a viewer for a file type, at the `dev` row's. None of them takes your own Claude Code model, effort, fast mode or Ultracode. When an extension's program runs one of their tasks ([agents.md](agents.md)), they also take `network`, `data` and `env` for that program. It has no thread to ask you in, so with `data` at `"ask"` it can't edit the corpus. Set `data` to `"allow"` to let it.

An extension's agent has the entry `"<extension>:<agent>"`, such as `"swarm-orient:swarm-reader"`. It runs inside the orientation's session, under its sandbox, permission mode, fast mode and memory, so it takes only `model`, `effort`, `web`, `network` and `prompt`. Its `model` and `effort` default to those its extension's `agent.json` gives it, else the orientation's subagents', its `web` defaults to `"off"` and its `network` to `"on"`. They can only take away what the orientation's allow. With `web` off it has no web tools. With `network` off while the orientation's is on, it has no Bash, since all agents in a session share one sandbox network. Its `prompt` replaces the extension's prompt file for it. Settings has a row for each agent of the extensions running in the workspace, where its `model` and `effort` can be changed. An extension's `agents/orientation/agent.json` prompt is not an agent: it adds to the orientation's instructions, or replaces them, and the orientation keeps its own settings (`agents.orientation`).

| Key | Values | Default | What it does, and the risk |
|---|---|---|---|
| `model` | a model id, such as `"claude-opus-5-5"` | per agent: the orientation uses your own Claude Code `model`, else Opus 5.5; view builds use the model of the session that asked for the view | The agent's model. |
| `effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`; for the orientation also `"ultracode"` | per agent: `"ultracode"` for the orientation | Higher efforts use more tokens. |
| `fast` | `true`, `false` | per agent | Fast mode, on models that have it. |
| `permissionMode` | `"manual"`, `"auto"`, `"bypass"` | `null`: your Claude Code session's mode | Manual asks you about each call that isn't already allowed. Auto lets Claude Code's classifier decide. Bypass allows every call that would otherwise ask you, except the ones `installs` and `network` send to you. The permission-mode rows in Settings edit this key. |
| `web` | `"ask"`, `"off"`, `"allow"` | `"ask"`; `"off"` for `dev` | WebFetch and WebSearch. `"ask"` follows the permission mode: in Manual each fetch or search goes to you, except for sites you allowed for the workspace. `"off"` removes both tools. `"allow"` runs them unasked in every mode, so the agent can send text from your corpus to any website. |
| `network` | `"off"`, `"on"` | `"on"` | Network access for the agent's Bash, and for an extension's program that runs the agent or one of its tasks. With `"off"`, Bash has no network where the sandbox runs. Where it doesn't run (see `sandbox`), the dev agent's commands go to you first in every mode, and the other agents' Bash follows their permission mode, so in Auto or Bypass it can reach the network. With `"off"`, view builds also refuse network and install tools and run with package managers set offline; these rules catch mistakes, but they can't stop a command written to get around them. `"on"` lets Bash reach the network, as far as your own Claude Code sandbox settings allow. |
| `sandbox` | `"on"`, `"off"` | `"on"` | `"off"` runs this agent's Bash, and an extension's program that runs it, outside the sandbox, so they can write anywhere you can. `sandbox.enforce` then doesn't stop the agent. |
| `data` | `"ask"`, `"allow"`, `"off"` | `"ask"` | Edits of files in the corpus. `"ask"` sends each one to you in every permission mode, Bypass and Auto included. `"allow"` leaves them to the permission mode, and in the sandbox Bash can write the corpus too. `"off"` refuses them. |
| `env` | a list of environment variable names, such as `["OPENAI_API_KEY"]` | `[]` | Variables of thimble's server that an extension's program running this agent or one of its tasks gets, such as the API key of a harness that brings its own model. A program gets no other variable of yours. |
| `memory` | `"inherit"`, `"on"`, `"off"` | `"inherit"` | Claude Code's auto memory. `"inherit"` keeps your own setting. With memory on, an agent can write notes that your later sessions in that folder read back. |
| `prompt` | a file path, or `null` | `null` | Replaces the agent's prompt file from thimble's `prompts/` folder (`orient.md`, `critic.md`, `writer.md`, `check.md`, `dev.md`, `labels.md`, `card-check.md`). Copy the original and edit it. It is filled in the same way, and relative paths are resolved from the config file's folder. A replacement prompt can drop the rules that keep an agent within its task. |
| `auto` | `true`, `false`, `null` | `null`: on | Only for `cardCheck`: whether the card check reads each new card by itself. With `false`, a card is checked only when you click Check the card or Check again in its details. A card shows the check only for a real problem it found, as a red ✕ at its takeaway; a fix is applied in place, with Undo in the card's details. |
| `subagentModel` | a model id, or `null` | `null`: the orientation's model | Only for `orientation`: the model of its subagents and workflow agents. |

## What stays as it is

- Your own Claude Code session (main) keeps its own permissions. This file only sets the agents thimble starts.
- No agent thimble starts can read `server.json` in thimble's home, which holds the token of thimble's local API, or `session.key` beside it, which proves which of thimble's sessions a call comes from: its sessions deny both files to Read and Bash, and their sandbox hides them. An extension's program that runs an agent gets a token of its own instead, valid only for that agent's tools and only while it runs ([agents.md](agents.md)).
- Card code, an extension's code among it, runs in the notebook kernel as your user, with your network, whatever `installs`, `network` and `sandbox` say. An agent's card whose code installs software or downloads files the ordinary ways (`!pip install`, `%pip`, `subprocess` or `os.system` with such a command) is refused unless `installs` is `"allow"`, but code written to get around that check still runs.
- The kernel runs in Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime), which thimble installs (it uses Seatbelt on macOS and bubblewrap on Linux). The kernel reads the corpus, the workspace and the system, and writes only in the workspace, apart from its views and the card types and extensions thimble found there, which your session's and the orientation's prompts are made from. It can't read your home folder, thimble's config, other workspaces or your Claude Code login. It keeps the network, so it can also reach local services, thimble's own API among them. Without Node, the kernel runs in bubblewrap directly on Linux, with the same limits, and unsandboxed on macOS; `thimble doctor` says which. `"kernel_wrap"` in the workspace's `settings.json` picks one: `"srt"`, `"bwrap"` or `"none"` (no sandbox). A workspace set to a sandbox that can't run gets no kernel.
- `thimble fix` runs while the server is down, and only in a terminal: it asks you there before its change is applied, and before it starts too where the sandbox runtime can't run. While it works nobody can be asked, so it refuses what `installs` would ask about, and runs its Bash unasked, in the sandbox where it can run.
- Earlier versions kept the agents' models and permission modes in each workspace's `settings.json`. These settings are moved to that workspace's `config.json` the first time it is read, so each workspace keeps running as before. The old *View builds* permission row is now the dev agent's row. If the two rows were different, the stricter one is kept.
