# thimble starts no `claude` of its own

The owner's decision (2026-10-17): thimble's server and CLI never start a Claude Code session of their own, neither an
Agent SDK session nor `claude -p`. Every model call runs as a subagent of the analyst's Claude Code session (main),
started through thimble's plugin module, so it runs under main's permission settings. The server stores data and draws
the browser. Phase 1 (this branch) inventories every start, builds one mechanism for model calls, and moves the card
check onto it.

## 1. Inventory

### A. Starts a model session (to remove)

| # | Where | Command | Feature | Main's context? | Reached |
|---|---|---|---|---|---|
| A1 | `model.py` `_structured` (`structured()`), through `sdk.build` | Agent SDK `ClaudeSDKClient`: `claude --system-prompt … --model … --effort … --permission-mode dontAsk --strict-mcp-config --safe-mode --no-session-persistence`, one in-process output tool | Every structured call, by caller below | No (a fresh session) | Normal use |
| A1a | `concepts.labels_task` ← `classify_structured` ← `_apply_prompt` | A1 | Prompt labels: `apply_label`, the browser's Re-run, `thimble act label-run`, a card re-run after its labels changed | No | Normal use |
| A1b | `concepts.draft_task` ← `POST /ws/{c}/concepts/draft` | A1 | "Label from prompt" in the new-label card | No | Normal use |
| A1c | `card_check._call` ← `check_task` ← `_read` | A1 | The card check after `add_card`/`edit_card` | No | Normal use. **Moved in phase 1.** |
| A1d | `view_fit.ask` ← `fit_task` ← `extensions._decide` | A1 | Whether an extension's view fits the corpus | No | Only with an extension that has views |
| A1e | `views._suggest_call` ← `file_viewer_task` ← `POST /ws/{c}/views/suggest` | A1 | The viewer suggestion for a file of an unknown type | No | Normal use |
| A1f | `harness.ask` | A1 | An extension program's `ask` | No | Extension programs only |
| A2 | `proposer.py` `_fork` (`_argv`) | `claude -p --resume <main> --resume-session-at <cut> --fork-session --no-session-persistence --tools "" --safe-mode …` | View proposals after main's turns, a thread's answer and the first orientation's end; Try again | **Yes** (forks main's transcript) | Normal use while View proposals is on. **Moved in phase 2b** (a fork of main, §5) |
| A3 | `dev.py` `Sessions._spawn` | `claude -p --session-id/--resume … --output-format stream-json` | `thimble fix` | No | Dev install, server down. **Gone in phase 2b** (refuses, §5) |
| A4 | `harness.py` `session_route` (WebSocket `/agent/claude`) | `claude <program's flags> --plugin-dir … --settings …` | An extension program's Agent SDK session | No (a program may resume its own) | Extension programs only. **Gone in phase 2b** (refuses, §5) |
| A5 | `harness.py` `session_call` | `claude -p --output-format json …` | A program's `session` request; a report check run by a program | No | Extension programs only. **Gone in phase 2b** (refuses, §5) |
| A6 | `harness.py` `_run` | the program itself (`run_sdk.py` or its command), whose sessions are A4, A5, A1f | Every role or task an extension's program replaces | No | Extension programs only. **Phase 2b**: an `sdk` program no longer starts; a `command` program runs, with no session (§5) |

`model.py`'s docstring also names view review and the checks task as callers: `view_review.review_task` only returns
an error (the review is a subagent already), and `checks.check_task` runs only under a program (A5).

### B. Starts `claude` with no model session (allowed)

- `config.auth_status`: `claude auth status --json` (before a prompt label runs, `thimble doctor`, `server up`, `/thimble`).
- `cli.claude_code_version`, `feedback.py`, `install.sh`: `claude --version`; `harness.py:780`: `claude -v` for a program.
- `cli.plugin_facts`, `plugin/bin/thimble` (uninstall), `scripts/plugin.sh`, `install.sh`: `claude plugin …`.
- `subagents._stop_background`: `claude stop <id>`, once, for agents a 0.5.0 build left running.
- `terminal_tools.py` reads the `claude` binary and starts nothing.

### C. The analyst's own session (allowed)

- `plugin/bin/thimble`: `exec claude [--plugin-dir …] <args>`, the analyst's main; `thimble demo --attach` execs it.

Dev and test tools also start `claude` (`scripts/e2e/contract_print.py`, `contract_module.py`, `precache_orientation.py`,
`e2e_release.sh`); they ship with no release path.

Count: 6 places start a model session (A1 with its 6 callers, A2 to A6); 9 start `claude` with no model session; 1 is
the analyst's own. Only A2 needs main's conversation.

## 2. The mechanism: a model call as a subagent of main

`backend/app/agent_call.py`, the role `thimble:call`, two private tools.

1. **Start.** A caller describes a call (`Spec`: instructions, the answer's schema as a `ToolSpec`, the model and
   effort of its Settings row, the refusal row, the agent's task line `title`, the drop reason `done`) and gives one
   or more parts (`Part`: text and pictures). `run()` writes the call to `trusted/calls/<id>/` in the workspace (read-only
   to kernels) and starts a `thimble:call` agent through the module (`subagents.start_job`, a follow-on start), with
   `$.agent.spawn` in main's session. The agent's first message holds the instructions, the schema and, for a call of
   one part, the part's text.
2. **Answer.** The agent has two tools from its own shim (`thimble-mcp --private call`) and no others: `read_call`
   gives a part's text and pictures (as image blocks), `send_answer` takes `{part?, answer}`. The server checks the
   answer against the call's schema and returns the errors when it does not fit, so the agent sends it again. The
   answer is in the caller's hands as soon as it is recorded; the agent's end does not have to be waited for.
3. **Hand-back.** The module appends no note of the start to main and never offers the type to a model. When the
   agent's hand-back enters main as a prompt (auto mode, through SubagentHandback), the terminal UI drops it with the
   call's `done` line: `● Prompt dropped by a hook: thimble checked the card "…"`. In Manual mode the hand-back
   reached neither main's terminal nor its context (live check below).
4. **Many parts.** One agent answers one part at a time; it reads parts until it has read `budget_chars` of text
   (200k by default), then `read_call` tells it to stop and the caller starts a fresh agent for the rest. `agents`
   (1 by default, 4 at most) agents run at once. A lazy source (an async iterator) is read only two parts per agent
   ahead of the answers, and each answer reaches `on_answer` as it comes.
5. **Failures.** A start refused at Claude Code's subagent limit waits 5 s and tries again. No module (no Claude Code
   session runs thimble in the folder, such as a browser opened with no session): the call ends `no_session`, whose
   detail is the fix ("Run `thimble` in the corpus folder, or open Claude Code there and type /thimble"). Plan mode
   or a hook: `error` with the refusal's own words, which carry their fix. An agent that ends without its answer gives
   the part back, and a second agent tries; then the part fails `no_tool_call` with the agent's last words, or
   `refused`/`rate_limited`/`error` for an API error. A refused run runs again once on the refusal row's model. A
   caller's cancel stops the call's agents (TaskStop through the module) and refuses a late answer. Nothing changes for
   `IDLE_S` (900 s): the parts left fail `timeout`.
6. **Files, not memory.** On local transport the caller (main's shim, where a card check runs), the agent's own shim
   and the hooks' backend process are three processes, so `call.json` (under an flock), the part files and the answer
   files carry the call, and the caller reads `call.json` every 0.2 s. After the press all three are the server. The
   agent's end reaches the call through `Type.ended` (`subagent_ended`), with the registry as a fallback.

The registration (`definition`): prompts/call.md as system prompt, `tools` = the two private tools, `omitClaudeMd`,
`background`; `subagents.TYPES["call"]` has no chat (nobody reads it), `own_notices` (the caller tells its failures).
Each start registers the run's model and effort when they differ from the registration, as every role's start does.

### How a caller uses it

One part, in place of `model.structured` (the arguments only an SDK session took, such as `speed`, `cwd`,
`on_retry`, are accepted and ignored):

```python
from . import agent_call
from .call_result import ToolSpec

role = config.call_settings(c, "labels")
res = await agent_call.structured(
    c, prompt, tool=ToolSpec(name="verdict", description="…", input_schema=schema),
    model=role["model"], effort=role["effort"], refusal=role["refusal"], system=instructions,
    images=[(png_bytes, "image/png")], what="view fit", title="thimble view fit: Board",
    done='thimble decided whether "Board" fits')
if res.status == "ok":
    use(res.output)
elif res.status == "no_session":
    notices.post(c, kind=…, text=f"… {res.detail}")  # the detail is the fix
```

Many parts (a prompt label's batches):

```python
spec = agent_call.Spec(what="labels", instructions=system, tool=labels_tool(label), model=…, effort=…,
                       refusal=…, title=f"thimble labels: {name}", done=f'thimble labeled records for "{name}"',
                       agents=2)

async def batches():                      # or a list
    for items in batched_units():
        yield agent_call.Part(render(items))

def heard(o: agent_call.Outcome):         # each part's answer as it comes, in any order
    if o.status == "ok":
        store(o.part, o.output)

outcomes = await agent_call.run(c, spec, batches(), on_answer=heard)
```

`call_result.py` holds `ToolSpec`, `CallResult` and `Status` without the Agent SDK; `model.py` names them too until it
is deleted.

## 3. Phase 1 status

- Built: `agent_call.py`, `call_result.py`, the `call` role in `subagents.TYPES`, `subagent_files.ROLES`, the watch
  hook's role types and `thimble.ts`, the tools `read_call` and `send_answer`, prompts/call.md and call-task.md, the
  module's `drop` argument, and the terminal UI's drop.
- Moved: the card check (`card_check._call`); it no longer imports `model`.
- Tests: `backend/tests_public/test_agent_call.py` (one part with a schema error then a fit, no session, an agent that
  ends without an answer, a cancel, many parts over two agents, the card check's picture through read_call, the card
  check's Settings row, the role's registration); `thimble.test.ts` "model calls". Updated: `test_subagents.py`,
  `test_call_settings.py`, `test_local.py`.

### Live check (Claude Code 2.1.301, local transport, the toy-incident corpus)

- Auto mode: main made a card. The first check was superseded when main edited the card; its agent was stopped and
  left no row. The second check's agent read the picture with `read_call`, answered with `send_answer` (no schema
  error) and handed back; the reading took 10.0 s (3 model requests), the check ended `ok`, and main showed one row,
  `● Prompt dropped by a hook: thimble checked the card "How many events of each action does events.jsonl hold?"`.
- Manual mode: the check ended `ok` in 17 to 21 s, with the agent's two tools asking in main's terminal
  (`thimble-call — Read Call Tool`, `Send Answer Tool`). Claude Code offers only Yes and No there, no "don't ask
  again", so each card check asks twice. The agent ended with the text "Done"; no row appeared, and main's transcript
  holds nothing of the agent (asked on its next turn, main said no agent's message had reached it).

## 4. What the next phases need

1. **Labels (A1a, A1b).** Move `labels_task` to `agent_call.run` with one Part per batch (`build_classify_prompt`'s
   user text), `on_answer` writing each batch's labels, and `agents` = 2 to 4 in place of CONCURRENCY 24. A large run's
   speed against 24 SDK sessions needs measuring; the budget per agent and `AHEAD` are the knobs. The label draft is
   one part. `config.auth_problem` (B) before a run can stay or go: a refusal now says what is wrong.
2. **View proposals (A2)** need main's conversation. Done in phase 2b: a fork of main started by the module (§5).
3. **View fit, the viewer suggestion (A1d, A1e)**: one part each, as the card check.
4. **Extension programs (A4 to A6, A1f)**: programs that start `claude` contradict the decision. Phase 2b: programs
   lose `sdk` and sessions, and keep `command`, whose model calls (`ask`, A1f) phase 2a moves to an `agent_call` (§5).
   Then `model.py`, `sdk.py` and `claude_agent_sdk` go.
5. **`thimble fix` (A3)** is a developer command. Phase 2b: it refuses with its fix, the repair in the analyst's own
   Claude Code (§5).
6. **Manual mode.** Two asks per card check. Options: accept it (Claude Code's own behavior), keep pictures out of
   the check (one ask), or let the module answer the permission decision for a call agent's own two tools, which only
   read the call and record an answer. The owner's call.
7. **Fast mode.** A subagent runs at main's speed; Settings' fast switch of the classifier rows no longer reaches
   these calls. Settings should say so, or lose the switch for moved rows.
8. **Docs.** docs/agents.md and docs/config.md describe tasks as model calls of thimble's; update them as each caller
   moves. The card check's lines are updated in INSTALL.md.

## 5. Phase 2b (branch 090/noclaude-2b)

### View proposals (A2): a fork of main

The mod API can fork main as a subagent: `$.agent.spawn({ subagentType: "fork", prompt, description })` from thimble's
module starts Claude Code's fork type, which inherits main's conversation, model and effort (spike, Claude Code
2.1.301: the fork read main's earlier turns, 23k tokens served from the prompt cache, and answered in 3 s). So the
proposer forks main, which keeps its input closest to `--resume --fork-session`, at no extra cost for main's context;
the transcript-text alternative would send main's conversation again, cut, with no cache.

- `agent_call` takes `fork` (Spec.fork, `structured(fork=True)`): one part, no pictures; the module spawns the fork
  (`spawn` with `fork`, no registration, no note); its first message is the part's text with the answer's schema
  (call-task.md `fork`); its answer is its report, a JSON object checked against the schema when its run ends
  (`_agent_ended`). An answer that does not fit gives the part to a second fork once; a refusal or an API error fails at
  once, since a fork cannot change its model (no refusal-row rerun).
- **Tools.** A fork has main's tools, and the module's hooks never see the calls of an agent the module started (the
  recursion skip: a spike fork's Bash ran, unseen by the module's `tool.call` hook). So the module lists each running
  fork in `<home>/up/<session>/forks`, and the fork guard, a PreToolUse hook on every tool (`.thimble-watch
  --fork-guard`), refuses every call of a listed agent. Its first shell line exits unless the list holds a fork, so no
  Python starts on main's calls.
- **Main.** The fork runs in the background and never interrupts main. Claude Code sends no hand-back of a fork the
  plugin started (spike and smoke, auto mode), so main's chat shows nothing; were one sent, the terminal UI drops it
  with `thimble checked for a view proposal`. While it runs, Claude Code's agent list shows `thimble: view proposal`.
- **The mirror** makes no chat for a model call's agent or fork (a role with no chat role): phase 1's card checks had
  made a stray agent chat in main for each call agent, which this fixes too.
- **The proposer**: plan mode holds the job (thimble starts nothing in plan mode); the threads part is cut to the room
  main's context leaves (`_threads_budget`); the model that replied, for the fallback notice, comes from the fork's
  transcript; `no_session` is a notice with its fix. Proposals run on main's model and effort: the `suggest` row now
  reaches only the viewer suggestion (A1e).
- `$.model.fork` (one tool-less completion over main's transcript, in main's process) would need no guard, but it is
  no subagent and shows nowhere in Claude Code; the owner's rule asks for a subagent.

### `thimble fix` (A3): refuses with its fix

`thimble fix` runs when the server is down, from a shell or /thimble fix: there is no server, often no Claude Code
session with thimble on, and its work (a worktree, gates, an apply) is a code ticket's, which needs the server. A
subagent of main cannot take it. So it refuses: it prints what thimble doctor finds and says to open Claude Code in
thimble's checkout and ask it for the repair (the analyst's own session makes it), then `thimble server restart`; with the
server up it asks for a code ticket, a subagent of main, as before. dev.Sessions, run_fix, fix_offline and
prompts/dev-fix.md are gone.

### Extension programs (A4 to A6): no session from thimble

A program's model calls go through `ask` (A1f, phase 2a's). What needed a Claude Code session refuses:

- an Agent SDK program (`sdk`) does not start (harness.NO_SDK names the extension, Settings and the `command` way),
  since its whole work is sessions of its own; Settings' line says thimble no longer starts it;
- a `session` request, the kit's `session()` and `options()`, and the session route (`/agent/claude`, which still
  answers `claude -v`) answer harness.NO_SESSION;
- a `command` program runs as before, in its box. claude_shim.py, run_sdk.py, the session flag code (claude_argv,
  StdinFilter) and docs/examples/orient-sdk are gone; docs/agents.md and docs/extensions.md say so.

### Tests and the live smoke

- Backend: test_agent_call (a fork's answer checked against the schema, a second fork, a refused fork, no pictures),
  test_proposer (the fork call, plan mode, the schema, the threads budget, the fork's transcript, no_session),
  test_subagent_mirror (no chat for a call's agent or fork), test_subagent_hooks (the fork guard, its hooks.json entry),
  test_module_bridge (the `fork` argument), test_cli (`thimble fix`'s refusal), test_agent_programs and
  test_task_programs (an SDK program does not start; a session request is refused and starts no claude).
- The module: thimble.test.ts "spawns a model call's fork of main …" (fork type, the forks list, the report posted).
- Live (Claude Code 2.1.301, local transport, auto mode, toy-incident): main answered a question about the board in
  71 s with three cards; 3 s after its turn ended the fork ran (6.2 s, no tool call, a JSON answer), and the row `view
  proposal Board Threads` showed above the prompt. Main's transcript holds nothing of the fork, main had no new turn,
  the forks list was empty after it, and the workspace has no chat for it.

### Left for later

1. Settings' dev-row fast switch ("thimble fix's fast mode") and `config.FAST_OF_TICKETS` now reach nothing; the
   doctor's `bash sandbox` line and `sandbox.use` reach only an extension program's box.
2. The extension schema still accepts `sdk`, so an old extension loads and says why it does not run; a later release
   can drop the key.
3. Manual mode with a fork: its tool calls are refused before Claude Code asks, so no prompt should show; not checked
   live.

