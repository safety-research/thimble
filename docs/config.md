# thimble's config

thimble's agents take their settings from `~/.thimble/config.json` (`$THIMBLE_HOME/config.json` when THIMBLE_HOME is set). With no file, every agent runs on the defaults below. A workspace can override any key but `browser` and `extensions` in `workspaces/<workspace>/config.json`. Objects merge key by key, and `null` means thimble's default.

The Settings pane writes this file for the models, efforts, fast mode and permission modes. Each change goes to the file the value came from, so a key the workspace's file sets is changed there. Edit the file by hand for everything else. A change applies to the next session an agent starts.

thimble changes none of Claude Code's settings. Your own Claude Code settings still apply to every agent, and thimble's rules are added to them.

```json
{
  "installs": "ask",
  "sandbox": { "use": "when-available", "enforce": true },
  "browser": "system",
  "agents": {
    "orientation": { "model": "claude-opus-5-5", "effort": "ultracode" },
    "dev": { "web": "off", "network": "off" }
  }
}
```

If the file isn't valid JSON, or a key or value is unknown, no agent starts. The Settings pane and `thimble doctor` show the error, which names the file and the key. `thimble doctor` also prints which file is read and which browser is used.

## Top-level keys

| Key | Values | Default | What it does, and the risk |
|---|---|---|---|
| `installs` | `"ask"`, `"deny"`, `"allow"` | `"ask"` | Commands that install software or download files: package managers (`pip install`, `npm install`, `npx`, `uv add`, `apt`, `brew` and others), `curl`, `wget`, `git clone`, `playwright install`, `thimble extension add` and `sudo`. `"ask"` sends each one to you in every permission mode, Bypass and Auto included, also with options before the subcommand, inside `bash -c` or called by path. It catches ordinary commands, but it can't stop one written to get around it, such as a script that downloads files itself. `"deny"` refuses them. `"allow"` leaves them to the agent's permission mode, so in Bypass or Auto an agent can install software without asking you. View builds refuse them without asking you while the dev agent's `network` is `"off"`. |
| `sandbox.use` | `"when-available"`, `"never"` | `"when-available"` | Runs the agents' Bash in Claude Code's sandbox where it can run (Linux needs bubblewrap and socat; `thimble doctor` says what is missing). In the sandbox, Bash can't write outside the agent's own folder and has no network unless the agent's `network` is `"on"`. A code ticket's Bash can also commit to the ticket's branch, and can't reach the validation stack, so the server takes the ticket's screenshots. Code tickets and `thimble fix` are not contained: thimble runs the edited code outside the sandbox (the ticket's validation stack serves it as the agent edits, its checks test it, the server runs git in its worktree, and once merged your install runs it). So thimble asks you before each one starts, in every permission mode, Bypass and Auto included, and starts it only on your Allow. Full containment is planned for 0.3.1. `"never"` turns the sandbox off, so Bash runs with your user's full access, limited only by the permission mode; set `sandbox.enforce` to `false` as well, or no agent starts. |
| `sandbox.enforce` | `true`, `false` | `true` | `true` refuses to start an agent whose Bash would run outside the sandbox, and says why. On Linux, run the installer again with `--sandbox-deps` to install what the sandbox needs. With `false`, agents run without the sandbox where it can't run. Your own Claude Code session (main) runs either way. |
| `browser` | `"system"`, `"bundled"`, `"off"` | the system browser when one is found, else Playwright's Chromium if installed, else off | The browser for screenshots: card checks, view checks and reviews, and the screenshot tool. `"system"` uses Chrome, Edge or Chromium installed on the machine. `"bundled"` uses the Chromium that the installer downloaded. `"off"` takes no screenshots, so cards and views are checked without pictures and graphics aren't repaired. Only in the file in thimble's home. Run `thimble restart` after changing it. |
| `extensions.<name>.enabled` | `true`, `false` | `true` | `false` switches the extension off in every workspace. Settings → Extensions switches one off for a single workspace. Only in the file in thimble's home. |

## Agents

`agents` has one entry per agent:

- **`orientation`**: the orientation and its subagents
- **`critic`**: the critique of the orientation
- **`writer`**: the report writers
- **`checks`**: the report checks
- **`dev`**: code tickets and view builds
- **`labels`**: the label classifier, and the call that decides whether an extension applies to a corpus
- **`cardCheck`**: the card check's reading of a card's picture, and a view review's reading of its pictures

`labels` and `cardCheck` are single model calls with no tools, so they take only `model`, `effort`, `fast` and `prompt`.

An extension's agent has the entry `"<extension>:<agent>"`, such as `"swarm:swarm-reader"`. It runs inside the orientation's session, under its sandbox, permission mode, fast mode and memory, so it takes only `model`, `effort`, `web`, `network` and `prompt`. Its `model` and `effort` default to its agent file's, else the orientation's subagents', and its `web` and `network` default to `"off"`. They can only take away what the orientation's allow. With `web` off it has no web tools. With `network` off while the orientation's is on, it has no Bash, since all agents in a session share one sandbox network. Its `prompt` replaces the extension's agent file.

| Key | Values | Default | What it does, and the risk |
|---|---|---|---|
| `model` | a model id, such as `"claude-opus-5-5"` | per agent: the orientation uses your own Claude Code `model`, else Opus 5.5; view builds use the model of the session that asked for the view | The agent's model. |
| `effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`; for the orientation also `"ultracode"` | per agent: `"ultracode"` for the orientation | Higher efforts use more tokens. |
| `fast` | `true`, `false` | per agent | Fast mode, on models that have it. |
| `permissionMode` | `"manual"`, `"auto"`, `"bypass"` | `null`: your Claude Code session's mode | Manual asks you about each call that isn't already allowed. Auto lets Claude Code's classifier decide. Bypass allows every call that would otherwise ask you, except the ones `installs` and `network` send to you. The permission-mode rows in Settings edit this key. |
| `web` | `"ask"`, `"off"`, `"allow"` | `"ask"`; `"off"` for `dev` | WebFetch and WebSearch. `"ask"` follows the permission mode: in Manual each fetch or search goes to you, except for sites you allowed for the workspace. `"off"` removes both tools. `"allow"` runs them unasked in every mode, so the agent can send text from your corpus to any website. |
| `network` | `"off"`, `"on"` | `"off"` | Network access for the agent's Bash. With `"off"`, Bash has no network where the sandbox runs. Where it doesn't run (see `sandbox`), the dev agent's commands go to you first in every mode, and the other agents' Bash follows their permission mode, so in Auto or Bypass it can reach the network. With `"off"`, view builds also refuse network and install tools and run with package managers set offline; these rules catch mistakes, but they can't stop a command written to get around them. `"on"` lets Bash reach the network, as far as your own Claude Code sandbox settings allow. |
| `memory` | `"inherit"`, `"on"`, `"off"` | `"inherit"` | Claude Code's auto memory. `"inherit"` keeps your own setting. With memory on, an agent can write notes that your later sessions in that folder read back. |
| `prompt` | a file path, or `null` | `null` | Replaces the agent's prompt file from thimble's `prompts/` folder (`orient.md`, `critic.md`, `writer.md`, `check.md`, `dev.md`, `labels.md`, `card-check.md`). Copy the original and edit it. It is filled in the same way, and relative paths are resolved from the config file's folder. A replacement prompt can drop the rules that keep an agent within its task. |
| `subagentModel` | a model id, or `null` | `null`: the orientation's model | Only for `orientation`: the model of its subagents and workflow agents. |

## What stays as it is

- Your own Claude Code session (main) keeps its own permissions. This file only sets the agents thimble starts.
- Card code, an extension's code among it, runs in the notebook kernel as your user, with your network, whatever `installs`, `network` and `sandbox` say. An agent's card whose code installs software or downloads files the ordinary ways (`!pip install`, `%pip`, `subprocess` or `os.system` with such a command) is refused unless `installs` is `"allow"`, but code written to get around that check still runs. On Linux, where bubblewrap works, the kernel runs in it by default: it sees only the corpus and the workspace, and can neither read nor change thimble's config or your Claude Code login. It still has the network. `"kernel_wrap": "none"` in the workspace's `settings.json` turns the wrapper off.
- On macOS, card code runs unwrapped for now, so it can write your files, thimble's config among them, and a card could loosen these settings and the permission modes for later sessions.
- `thimble fix` runs while the server is down. It asks you in the terminal before it starts, and doesn't run without one. After that nobody can be asked, so it refuses what `installs` would ask about, and runs its Bash unasked, in the sandbox where it can run.
- Earlier versions kept the agents' models and permission modes in each workspace's `settings.json`. These settings are moved to that workspace's `config.json` the first time it is read, so each workspace keeps running as before. The old *View builds* permission row is now the dev agent's row. If the two rows were different, the stricter one is kept.
