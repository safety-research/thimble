# Writing an extension

An extension is a folder of parts: views, card types, report types and changes to thimble's agents. Fields go in
`.json` files, prose a model reads in `.md`, pages in `.html` and optional code in `.py`. Write the folder, then add it:

```bash
thimble extension add ./tally     # checks the folder, lists what it adds, asks once, and switches it on
thimble extension off tally       # in every workspace; Settings > Extensions switches it for one workspace
thimble extension on tally
thimble extension list
thimble extension remove tally    # the folder stays where it is
```

A folder you add is used in place, so later edits take effect without adding it again. One from a git URL is copied.
When a file has a problem, `add` names the file and line of each one and adds nothing.

A view shows in a workspace where a quick model check finds it fits the files, and once there it runs the checks a view
the dev agent builds passes: every file it reads is read or hidden with a reason, its derived fields are declared, and
a test label's marks show on its records. A view that fails them is hidden there, and Settings > Extensions names the
first failure.

The JSON files follow [backend/app/extension.schema.json](../backend/app/extension.schema.json).

## The folder

| file | what it is |
|---|---|
| `extension.json` | the manifest, below |
| `views/<name>/view.json`, `view.html`, `reader.py` | a view: a tab in Files, or a mode of one file in the File browser |
| `cards/<name>/card.json`, `card.html`, `card.py`, `card.md` | a card type main draws with `thimble.card("<name>", …)` |
| `reports/<name>/report.json`, `report.md`, `writer.md` | a report type: `report.md` is the form the writer follows, `writer.md` is added to the writer's prompt |
| `agents/<role>/agent.json` and the files it names | a change to one of the five roles |
| `tasks/<task>/task.json` and the files it names | a change to one of the seven tasks; test inputs in `fixtures/*.json` |
| `checks/<name>/check.json`, `check.md` | a report check (not run yet) |
| `lib/`, `sample/` | code every part can import, and a small corpus to try the parts on |

Names are lower-case letters, digits and hyphens. A part's name is its folder's name.

## extension.json

```json
{"name": "tally", "version": "0.1.0", "description": "Counts tally lines by who made them.",
 "scope": ["tally/*.jsonl"], "thimble": ">=0.4", "python": ["pypdf>=4"], "needs": ["multiagent-swimlane"]}
```

| field | |
|---|---|
| `name`, `version` | required; the name is the folder's |
| `description` | what it adds, in a sentence or two; `add` and Settings show it |
| `scope` | the files it is about; a view or card type without a scope of its own uses these |
| `thimble` | the thimble versions it works with, as package.json's `engines` writes them |
| `python` | packages its code needs; thimble installs none, and the extension waits until they import |
| `needs` | other extensions it needs; one thimble ships is added with it |

## Roles and tasks

The roles are `main`, `orientation`, `critic`, `writer` and `dev`. The tasks are `labels`, `label-draft`, `card-check`,
`view-review`, `view-fit`, `file-viewer` and `checks`. thimble checks a `task.json` but does not run tasks yet.
`agent.json` or `task.json` defines one in one of three ways:

| key | what thimble does |
|---|---|
| `"prompt": "prompt.md"` | adds the file to thimble's prompt for it, or replaces that prompt with `"replace": true` |
| `"sdk": "critic.py"` | calls the program's `async def run(input)`, written with the Claude Agent SDK |
| `"command": ["python", "labels.py"]` | starts the program, sends the input as JSON lines on stdin and reads the output on stdout |

Both files take `description` (shown by `add` and Settings), `model` and `effort` (defaults your config overrides).
`agent.json` also takes `tools` and `disallowedTools`, which can only narrow what the role has, and with `prompt`,
`subagents`: Claude Code subagents the role can call, in the fields of Claude Code's `--agents` JSON, each prompt in
its own file. main takes a prompt addition only. [agents.md](agents.md) says what a program that runs a role gets
and how it answers. Permission modes and hooks are yours, and an extension cannot set them.

```json
{"description": "Has every record of a swarm read by a model before the orientation drafts.",
 "prompt": "prompt.md",
 "subagents": {"swarm-reader": {"description": "Reads one share of a swarm's records.",
                                "prompt": "swarm-reader.md", "tools": ["Read", "Grep"]}}}
```

Prompts can use `{{default}}` or `{{default#<heading>}}` (thimble's own prompt, or one section of it), `{{dir}}` (the
extension's folder, read-only) and `{{files}}` (the files its scope, views and card types cover in the workspace).

Switching on an extension that adds to the orientation, in a workspace where the orientation already ran, makes
Settings ask whether to run it there now.
