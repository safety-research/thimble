# Running a role with your own program

An extension can run one of thimble's roles its own way: the orientation, the critic, the writer or the dev agent.
Main, your own Claude Code session, takes prompt additions only. `agents/<role>/agent.json` names one of three ways:

| way | agent.json | what thimble runs |
|---|---|---|
| prompt | `"prompt": "prompt.md"` | thimble's own agent with your prompt added, or in place of thimble's with `"replace": true` |
| Agent SDK | `"sdk": "orient.py"` | your Python program's `run(input)`, written with the Claude Agent SDK |
| command | `"command": ["node", "orient.mjs"]` | any program, started from the role's folder, speaking the JSON lines below |

A program replaces thimble's agent for that role. When two active extensions replace the same role, thimble runs its
own agent and Settings names both. [examples/orient-sdk](examples/orient-sdk) is a whole orientation written with the
Agent SDK.

## What a program gets

thimble starts the program in the role's folder (`agents/<role>/`). The input arrives as the first line on stdin,
`{"input": {...}}`, and in the file `$THIMBLE_INPUT`:

| role | input | its thimble tools | what it returns |
|---|---|---|---|
| orientation | `request`, `outputs`, `follow_up`, `choices`, `cards`, `corpus`, `tools` | `read_ref`, `list_cards`, `add_card`, `edit_card`, `delete_card`, `apply_label`, `propose_view`, `screenshot` (as `outputs` allows) | the line main hears |
| critic | `digest` (what thimble's critic reads), `transcript`, `context` | `read_ref`, `list_cards` | the report the orientation's critique call gets |
| writer | `doc`, `type`, `request`, `after`, `context` | `read_ref`, `list_cards`, `add_card`, `edit_card`, `delete_card`, `screenshot`, `write_document`, `edit_document` | the line main hears |
| dev | one turn of a view build: `slug`, `name`, `description`, `scope`, `spec`, `change`, `folder`, `corpus`, `examples`, `message` | `read_ref` | the turn's reply; thimble then checks the view's files in `folder` and runs the program again with what failed in `message` |

The environment:

| variable | |
|---|---|
| `THIMBLE_WORK` | the program's own folder, where it may write; `TMPDIR` is inside it |
| `THIMBLE_CORPUS` | the corpus, read-only unless thimble's config allows edits |
| `THIMBLE_ROLE`, `THIMBLE_WORKSPACE` | the role and the workspace |
| `THIMBLE_AGENT_DIR` | the role's folder in the extension |
| `THIMBLE_API`, `THIMBLE_AGENT_TOKEN` | thimble's local API and a token of the program's own (below) |
| `THIMBLE_CLAUDE` | the `claude` an Agent SDK program's sessions start with |
| `THIMBLE_KIT_JS` | thimble's JavaScript module |
| `THIMBLE_NETWORK` | `on` or `off`, the role's network |

and the variables thimble's config passes on (`agents.<role>.env`), such as an API key for a harness that brings its
own model.

## How it answers

Each line the program writes on stdout is one JSON object. thimble answers each request on stdin.

| program writes | thimble does |
|---|---|
| `{"id": 1, "tool": {"name": "add_card", "args": {...}}}` | calls one of the role's thimble tools as the role, answers `{"id": 1, "result": {"content", "is_error"}}` |
| `{"id": 2, "ask": {"prompt": "...", "schema": {...}}}` | one model call on your own Claude: the object `schema` describes, or text |
| `{"id": 3, "session": {"prompt": "...", "system": "...", "tools": [...]}}` | runs a Claude Code session as the role and answers with its last reply |
| `{"log": "text"}` | adds a line to the agent's thread |
| `{"output": ...}` | what the role returns; the last line |

A refused or failed request is answered `{"id": 1, "error": "why"}`. Any other line on stdout, and everything on stderr,
goes to thimble's log. The run is done when the program exits 0. Any other exit fails it, with the end of stderr as the
error the thread shows. Stop ends the program and its sessions.

In Python, the `thimble` module is on the path: `thimble.serve(run)` reads the input, calls `run`, sends what it returns
and exits. `thimble.tool`, `thimble.ask`, `thimble.session`, `thimble.log` and `thimble.prompt("file.md", **slots)` make
the requests. An `sdk` program only defines `run(input)`. In JavaScript or TypeScript:

```js
import { query } from '@anthropic-ai/claude-agent-sdk'
const thimble = await import(process.env.THIMBLE_KIT_JS)

thimble.serve(async (input) => {
  let survey = ''
  for await (const m of query({ prompt: 'Survey the corpus.', options: thimble.options({ maxTurns: 40 }) })) {
    if (m.type === 'result') survey = m.result
  }
  await thimble.tool('add_card', { question: 'What does the corpus hold?', kind: 'note', text: survey })
  return survey.split('\n')[0]
})
```

`thimble.options()` (in both languages) hands the Agent SDK thimble's `claude`. Its sessions then start on your own
Claude Code login, in the role's work folder with the corpus added, under the role's permission mode, sandbox and
config, with thimble's tools. Your program chooses the prompt, the system prompt, the model, the turns and the
subagents. thimble keeps the permission mode, the settings, the hooks and the folders. So a subagent's
`permissionMode`, `hooks` and `memory` are dropped, and so are MCP servers that would run outside the program (only
the SDK's own `sdk` servers and servers named by their name stay). A request to change the permission mode, the
settings, the plugins, the login or the environment is answered with an error, and a hook of yours can deny or ask
but not allow a call.

The local API takes the program's token on `POST $THIMBLE_API/api/tools/<tool>` for the role's own tools, with
`{"args": {...}}` as the body. The token is valid while the program runs. Each request carries `x-thimble-agent` (the
token's part before the dot), `x-thimble-nonce` (a fresh random string) and `x-thimble-auth`, the hex HMAC-SHA256 of
`hook:<nonce>` keyed with the whole token.

## The same guardrails as thimble's own agents

These come from `agents.<role>` in thimble's config ([config.md](config.md)) and hold for every agent thimble starts,
its own included.

- **Sandbox** (`sandbox`, on by default): the program runs in Anthropic's sandbox runtime and writes only its own
  folder (and, for the dev agent, the view's folder). Off, it writes anywhere you can.
- **Network** (`network`, on by default): off, the program reaches no host and talks to thimble only on
  stdin and stdout, so `session` and `ask` work and the Agent SDK's own sessions do not.
- **Your data** (`data`, `ask` by default): an edit of a file in the corpus goes to you first in every permission mode.
  `allow` leaves it to the permission mode, and `off` refuses it. The program itself can't ask, so in its sandbox it
  writes the corpus only with `allow`. Its sessions' edits are asked.
- **thimble's key**: no agent, program or session can read `server.json`, which holds the local API's token. A program
  uses its own token instead, and can't read Claude Code's credentials file either.
- A program's sessions ask for permission as thimble's agents do: on the agent's card in the browser, by its row of the
  permission modes in Settings.
