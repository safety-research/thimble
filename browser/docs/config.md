# thimble's config

thimble's agents take their settings from `config.json` in the workbench's home: `~/.thimble-browser/config.json`, or `$THIMBLE_BROWSER_HOME/config.json` when THIMBLE_BROWSER_HOME is set. With no file, every agent runs on the defaults below. A workspace can override any key but `browser`, `cardWait` and `askKey` in `workspaces/<workspace>/config.json`. Objects merge key by key, and `null` means thimble's default.

Settings writes this file for the models and efforts of its Models rows (`writer`, `dev`, `checks`, `labels`, `cardCheck` and `suggest`), their fast mode where the row's model has it (`labels`, `cardCheck`, `suggest` and `dev`), the Ask Claude with choice (`askKey`) and the View proposals switch (`views.propose`), each as soon as you pick it. A change goes to the file the value came from, so a key the workspace's file sets is changed there, and every other key stays as the file has it. Edit the file by hand for everything else. A change applies to the next start of an agent, with no restart. Its first row, Main and side threads, is main's own model, effort and fast mode, the same as the line under main's chat, kept in the workspace's `settings.json` (`models.main`), not in this file.

Settings' "Claude can edit files in this folder" switch is kept per workspace, in the workspace's `settings.json` (`corpus_edits`), not in this file. It is on by default: Claude in the chat and in side threads can write files into the corpus folder, as Claude Code does in its own folder. Turned off, they read the corpus but cannot write it. thimble's other agents (writers, view builds, comments agents) never write the corpus, and no agent writes thimble's own files. A change applies to the next message.

The Label tool switch, on or off at the head of the Labels sidebar, works as the terminal's Labels setting and is kept per workspace too, in the workspace's `settings.json` (`labels`). It is on by default. Turned off, Claude makes no labels: main's prompt, the shared text thimble's agents read and the tools' texts say nothing of labels, no agent has a label tool, a label tool's call changes nothing, and main hears of no label. Labels you make yourself in Files still work. A change applies to the next message.

Main and thimble's agents edit this file and a workspace's `config.json` under main's permission mode, as any file outside the folder you opened. A session thimble runs on its own, such as `thimble fix`, asks you before it edits them, and one with nobody to ask can't. A permission mode of `"bypass"` written into this file counts as Manual (`permissionMode` below).

thimble changes none of Claude Code's settings files. The writers, view builds, view reviews, comments agents and code tickets are subagents of main: they run in main's permission mode, and thimble adds no rules or sandbox to them. Only `thimble fix` keeps a permission mode and a sandbox of its own (the `dev` entry).

```json
{
  "sandbox": { "use": "when-available", "enforce": false },
  "browser": "system",
  "agents": {
    "writer": { "web": "off" },
    "dev": { "web": "off" }
  }
}
```

If the file isn't valid JSON, or a key or value is unknown, no agent starts. The Settings pane shows the error, which names the file and the key.

## Top-level keys

| Key | Values | Default | What it does, and the risk |
|---|---|---|---|
| `installs` | `"ask"`, `"deny"`, `"allow"` | read and ignored | Earlier versions sent each command that installs software to you. Such commands now follow main's permission mode, as every other command does: thimble adds no rule for them. |
| `sandbox.use` | `"when-available"`, `"never"` | `"when-available"` | Runs the Bash of `thimble fix` in Claude Code's sandbox where it can run (Linux needs bubblewrap and socat). Your own session and thimble's agents are not affected: they follow your Claude Code settings. In a development install, thimble's server commits a code ticket's change to its branch. The ticket's checks, and the copy of thimble the server screenshots before and after the change, run in thimble's sandbox runtime (Anthropic's sandbox runtime, installed with thimble; it needs Node 20.11 or later, and on Linux bubblewrap, socat and ripgrep): no network, no view of your home folder, and writes only to the ticket's worktree and its cache. The edited code first runs outside a sandbox once merged into your install, so just before that thimble asks "Apply this change to thimble's own code?", in every permission mode, Bypass and Auto included, and merges only on your Allow, and only the change it named; otherwise the change stays on its branch. `thimble fix` asks the same in the terminal. Where the sandbox runtime can't run, a ticket's checks run outside the sandbox, so thimble also asks before the ticket starts. `"never"` turns the sandbox off for `thimble fix`. |
| `sandbox.enforce` | `true`, `false` | `false` | `false` runs `thimble fix` without the sandbox where it can't run, after it asks you in the terminal. `true` refuses to start it there, and says why. |
| `browser` | `"system"`, `"bundled"`, `"off"` | the system browser when one is found, else Playwright's Chromium if installed, else off | The browser for screenshots: card checks, view checks and reviews, and the screenshot tool. `"system"` uses Chrome, Edge or Chromium installed on the machine. `"bundled"` uses the Chromium that the installer downloaded. `"off"` takes no screenshots, so cards and views are checked without pictures and graphics aren't repaired. Only in the file in thimble's home. Start thimble-browser again after changing it. |
| `cardWait` | minutes, a number above 0 and up to 720 | `10` | How long a code ticket's card waits for your answer to thimble's questions about its own code: whether the change may be applied, and, where the sandbox runtime can't run, whether the ticket may start. A question nobody answers in that time is a no, and the card says so, with the wait. Requests of main and of thimble's agents, a ticket's agent among them, are never declined on a timer. A change applies to the next card. Only in the file in thimble's home. |
| `askKey` | `"meta"`, `"alt"`, `null` | `null`, which is `"meta"` | The key you hold while you click something in the browser to ask about it: `"meta"` is ⌘-click on a Mac and Ctrl-click elsewhere, `"alt"` is ⌥-click on a Mac and Alt-click elsewhere. The other key places a card freely on the canvas while you drag it. Settings' Ask Claude with choice writes it. Only in the file in thimble's home. |
| `views.propose` | `true`, `false`, `null` | `null`, which is on | Whether thimble proposes views. After each of your messages and when a side thread answers, a card above the reply box may propose a view, and opening a file only Raw can show may propose a viewer for its type. Nothing builds until you accept. Deciding whether to propose takes one model call on a copy of main's context, on the `suggest` row. `false` turns view proposals off: the proposal's Don't ask again writes it, and Settings' View proposals switch writes it and takes it out. |

## Agents

`agents` has one entry per agent:

- **`writer`**: the report writers
- **`checks`**: the comments agents
- **`dev`**: view builds, view reviews and code tickets, each a subagent of main, and `thimble fix`
- **`labels`**: the label classifier
- **`cardCheck`**: the card check's reading of a card's picture
- **`suggest`**: the view proposals: the check for one after each of your messages and after a side thread answers, and the call that proposes a viewer for a file type
- **`refusal`**: the model and effort a classifier's call runs again on when its own model refuses it

A file that still holds `orientation` or `critic`, the entries of earlier versions' orientation and its critique, loads without an error.

Each agent runs on exactly the model and effort its entry gives, the defaults included, unless a start tool names another model or effort for one run. None of them takes your own Claude Code model or effort. thimble's model calls run without `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, so that none can change what runs. Your organization's managed settings rank above thimble's, so a variable an `env` block there sets still applies.

`labels`, `cardCheck` and `suggest` are single model calls with no tools, so they take only `model`, `effort`, `fast` and `prompt`. Each runs at exactly the model, effort and fast mode Settings shows for its row (`labels`: Opus 5.5 at low effort, fast mode off; `cardCheck`: Opus 5.5 at high effort, fast mode on; `suggest`: Opus 5.5 at medium effort, with the 1M-token window when main's context needs it). When a call's model refuses it, it runs once more on the `refusal` entry's `model` and `effort` (Opus 4.8 at high effort), or not again when its `off` is `true`. The check for a view proposal after a turn does not run again: when Claude's safeguards block it, a notice says so, with Try again and Turn off view proposals.


| Key | Values | Default | What it does, and the risk |
|---|---|---|---|
| `model` | a model id, such as `"claude-opus-5-5"` | per agent: Opus 5.5, and Opus 4.8 for `refusal` | The agent's model. |
| `effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | per agent | Higher efforts use more tokens. A stored `"ultracode"` reads as `"xhigh"`. A model without effort levels, such as Haiku, runs with none. |
| `fast` | `true`, `false` | per agent: on for `cardCheck` and `dev` | Fast mode, on models that have it, for `labels`, `cardCheck`, `suggest` and `dev`. A view build, a review, a code ticket and `thimble fix` run with `dev`'s. Read and ignored for the other agents, which run without a fast mode of their own. |
| `permissionMode` | `"manual"`, `"auto"`, `"bypass"` | `null`: main's mode, but Manual while main runs in Bypass | Only for `dev`: the permission mode of `thimble fix` and of a code ticket's card. Manual asks you about each call that isn't already allowed. Auto lets Claude Code's classifier decide. Bypass allows every call that would otherwise ask you, except the ones `network` sends to you. It takes effect only where an earlier version's Settings recorded it as your choice, where Claude's file tools can't change it (`bypass.json` in thimble's home); `"bypass"` written into this file alone counts as Manual. Read and ignored for every other agent. |
| `web` | `"ask"`, `"off"`, `"allow"` | `"ask"`; `"off"` for `dev` | WebFetch and WebSearch. `"off"` keeps the agent off them; `"ask"` and `"allow"` both leave them to your permission mode. The dev agent's and the classifiers' own `web` keep their meaning. |
| `network` | `"off"`, `"on"` | `"on"` | Network access for Bash. It doesn't apply to main or thimble's agents, which use your network as your Claude Code settings allow. `dev`'s sets it for `thimble fix`; a code ticket's agent has main's network. thimble's own writers and comments agents don't read theirs. `"on"` lets Bash reach the network, as far as your own Claude Code sandbox settings allow. |
| `sandbox` | `"on"`, `"off"` | `"on"` | Only for `dev`: `"off"` runs `thimble fix`'s Bash outside the sandbox, so it can write anywhere you can, and `sandbox.enforce` then doesn't stop it. |
| `data` | `"ask"`, `"allow"`, `"off"` | `"ask"` | Edits of files in the corpus. Shell commands follow your permission mode. `dev`'s sets them for `thimble fix`. thimble's own writers and comments agents don't read theirs. |
| `memory` | `"inherit"`, `"on"`, `"off"` | `"inherit"` | Whether the agent reads CLAUDE.md files. `"off"` leaves them out of its context; `"on"` and `"inherit"` give it the CLAUDE.md files main reads. |
| `prompt` | a file path, or `null` | `null` | Replaces the agent's prompt file from thimble's `prompts/` folder (`writer.md`, `check.md`, `dev.md`, `card-check.md`); the `labels` agent's is the label classifier's text, `plugin/prompts/labels.md`, which the terminal plugin reads too. Copy the original and edit it. It is filled in the same way, and relative paths are resolved from the config file's folder. A replacement prompt can drop the rules that keep an agent within its task. |
| `auto` | `true`, `false`, `null` | `null`: on | Only for `cardCheck`: whether the card check reads each new card by itself. With `false`, a card is checked only when you click Check the card or Check again in its details. A card shows the check only for a real problem it found, as a red ✕ at its takeaway; a fix is applied in place, with Undo in the card's details, and a fix that leaves all the card shows as it was is one more version in the card's History. |

## What stays as it is

- Your own Claude Code sessions keep their permission mode and your settings: thimble adds no rule, working directory or sandbox to them.
- No agent writes thimble's private files in the workbench's home: `server.json`, which holds the token of thimble's local API, `session.key`, `link.key`, which holds the key the sign-in link carries, `paired.json`, which holds a hash of each signed-in browser's cookie and of the key of its path, `claude-access.json` and `anthropic-api-key`. Everything you do in thimble's browser, and everything it shows, needs that browser's sign-in, which the link `thimble-browser` prints gives. The link is the same every time and signs in any browser, as a Jupyter link with its token does, until `thimble-browser --unpair` signs every browser out and changes it.
- Card code runs in the notebook kernel as your user, with your network, whatever `network` and `sandbox` say.
- The kernel runs in Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime), which thimble installs (it uses Seatbelt on macOS and bubblewrap on Linux). The kernel reads the corpus, the workspace and the system, and writes only its own folders of the workspace: `scratch` (its working folder, where a card's files go), `tmp` and `view-indexes`. The rest of the workspace is thimble's own record of your work (the chats, the cards, the labels, the undo history and the rest), which the kernel can read but not change. It can't read your home folder, thimble's config, other workspaces or your Claude Code login. It keeps the network, so it can also reach local services, thimble's own API among them. Without Node, the kernel runs in bubblewrap directly on Linux, with the same limits, and unsandboxed on macOS and on Linux where bubblewrap can't create a sandbox. A card check's revision runs on the kernel without asking you. `"kernel_wrap"` in the workspace's `settings.json` picks one: `"srt"`, `"bwrap"` or `"none"` (no sandbox). A workspace set to a sandbox that can't run gets no kernel.
- `thimble fix` runs only in a development install (a git clone of thimble), while the server is down, and only in a terminal: it asks you there before its change is applied, and before it starts too where the sandbox runtime can't run. While it works nobody can be asked, so it runs its Bash unasked, in the sandbox where it can run.
- Earlier versions of this file also gave each agent a permission mode and `fast`, and set `installs`. Those this page marks as read and ignored load without an error, and a change in Settings leaves them in the file.
