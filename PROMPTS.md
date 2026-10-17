# Prompt text of the no-claude change (branches 090/noclaude, -2a, -2b and -3)

Every text a model or the analyst reads that the change adds or changes, old text first, then new text, gathered from
the three phases' PROMPTS.md files (phase 1, 2a, 2b) and phase 3's own (the last part). "None" means the text is new.
Placeholders are in braces: `{{x}}` in prompt files, `{x}` in tools.md hints and code.

# Phase 1: the mechanism and the card check (branch 090/noclaude)

## 1. The role prompt of `thimble:call` (prompts/call.md)

The system prompt of the agent that answers a model call. It replaces no prompt: before, each call was an Agent SDK
session with the caller's own system prompt and no role prompt.

Old: none.

New, the description (Claude Code shows it in the agent's registration; the type is never offered to a model):

> Does one task for thimble, such as a check of a card, and sends its answers with thimble's tools. thimble starts it.
> Do not start it yourself.

New, the body:

> # thimble task
>
> You do one task for thimble. thimble is a tool that helps an analyst read and understand a corpus of records, such
> as the logs of agents. thimble's server does not ask a model itself, so it gives the task to you.
>
> Your first message is the task. It gives the instructions, the schema of an answer, and the part to answer or how to
> get the parts.
>
> - Send each answer with send_answer. Give `answer` as a JSON object that agrees with the schema in your task. Give
>   `part` when you have more than one part.
> - When send_answer says that the answer does not agree with the schema, correct the answer and send it again.
> - Use read_call when your task tells you to. It gives you a part and its pictures.
> - You have no other tools. Everything that you need is in your task and in the results of read_call.
> - Nobody reads your text or your report. When a tool result tells you to stop, give only the word Done as your
>   report.

## 2. The agent's first message (prompts/call-task.md)

Old: none. Before, the caller's `system` text was the session's system prompt, the caller's prompt its first message,
and the schema the input schema of an in-process tool.

New, `## task` (the whole first message):

> [thimble call {{call}}]
>
> {{instructions}}
>
> # Your answer
>
> {{tool}} Send it with send_answer. The answer is a JSON object that agrees with this schema:
>
> ```json
> {{schema}}
> ```
>
> {{parts}}

`{{instructions}}` is the caller's own system text (for the card check: card-check.md `## check`, unchanged),
`{{tool}}` the description of the caller's output schema (card check: card-check.md `## critique`, unchanged).

New, `## one-part` (`{{parts}}` of a call of one part):

> # The part to answer
>
> {{text}}

New, `## pictures` (after one-part, when the part has pictures; `{{count}}` is "1 picture" or "2 pictures"):

> This part has {{count}}. Call read_call to see them before you answer.

New, `## many-parts` (`{{parts}}` of a call of many parts):

> Call read_call to get the first part. Answer each part with send_answer, then call read_call again for the next
> part. Do this until a result tells you to end your turn.

## 3. The agent's tools (prompts/tools.md)

Old: none.

New, `read_call` (no arguments):

> Get a part of your task: its text and its pictures. When you have a part that you did not answer, you get that part
> again. Else you get the next part.

New, `send_answer`:

> Send your answer to a part of your task. The answer must agree with the schema in your task. When it does not agree,
> the result gives the errors. Then correct the answer and send it again.

- `part`: The number of the part. Leave it out when you have only one part.
- `answer`: Your answer: a JSON object that agrees with the schema in your task.

## 4. The tools' results (prompts/tools.md hints)

All new. Old: none.

| Hint | When | Text |
|---|---|---|
| read_call-part | a part | `# Part {part}` then a blank line, then `{text}` |
| read_call-pictures | after a part's text, before its pictures | The {count} of part {part} follow. |
| read_call-pictures-only | the pictures of a part whose text is in the first message | The {count} of part {part} follow. Its text is in your first message. |
| read_call-none | no part is left | No parts are left. Stop now. Give only the word Done as your report. |
| read_call-wait | a lazy source has not given the next part within 20 s | The next part is not ready yet. Call read_call again. |
| read_call-share | the agent read its share of the text | You answered your share of the parts. Another agent gets the parts that are left. Stop now. Give only the word Done as your report. |
| send_answer-more | an answer was recorded and parts are left | thimble has your answer to part {part}. Call read_call to get the next part. |
| send_answer-last | the agent's last answer was recorded | thimble has your answer to part {part}. That was your last part. Stop now. Give only the word Done as your report. |
| send_answer-invalid | the answer does not fit the schema | The answer does not agree with the schema: {errors}. Correct the answer and send it again. |
| send_answer-which | the agent holds several parts and named none | You have more than one part. Give the number of the part as `part`: {parts}. |
| send_answer-not-held | the part is not the agent's | You do not have part {part}. Call read_call to get a part. |
| call-not-yours | a caller that is no call's agent | Only the agent of a thimble task can use {tool}. |
| call-stopped | the call ended or was stopped | thimble stopped this task. Stop now. Give only the word Done as your report. |

A first version of the end lines said "End your turn now. Write only the word Done." Live, in auto mode, Claude Code
told the agent to end with `SubagentHandback({message: <your full report>})`, and the agent wrote a two-sentence
report; the lines now ask for the report itself.

## 5. What the analyst sees in main's terminal

Old (each card check was a `claude` session of the server's own): nothing in main's terminal.

New, the agent's line in Claude Code's agent list while it runs (card_check.TITLE; `{card}` the card's question, at most
60 characters):

> thimble card check: {card}

New, the row of the dropped hand-back (card_check.DONE). Claude Code prints it as
`● Prompt dropped by a hook: <reason>`; seen live only in auto mode, where the agent hands back with
SubagentHandback. In Manual mode the hand-back reached neither main's terminal nor its context.

> thimble checked the card "{card}"

New, the reason for a call whose caller gave none (agent_call.DONE_DEFAULT, plugin/hooks/thimble.ts CALL_DONE):

> thimble finished a task

The module appends no note to main for a call's agent (module_bridge._note returns '' for the role `call`, as for a
report check). Before, every other role's start appends hint `module-started-note`.

## 6. Failure text

New, a call with no Claude Code session running thimble in the folder (agent_call.NO_SESSION, the call's detail):

> no Claude Code session runs thimble in this folder. Run `thimble` in the corpus folder, or open Claude Code there and
> type /thimble

New, the lead the card's details give such a failure (card_check._read_failure, status `no_session`):

> the check could not start

The card check's notice is unchanged (`The card check of the card "{card}" failed: {why}.`), so with no session it
reads:

> The card check of the card "How many replies were curt?" failed: the check could not start (no Claude Code session
> runs thimble in this folder. Run `thimble` in the corpus folder, or open Claude Code there and type /thimble).

## 7. The card check's own prompt (prompts/card-check.md)

Text unchanged. Where it goes changed: `## check` was the system prompt of an Agent SDK session and `## card` its first
message, with the picture as an image block; now both are the first message of `thimble:call` (section 2), and the
picture comes from read_call. `## critique` was the description of the output tool; now it is `{{tool}}` in the first
message, and its JSON schema follows it there.

## 8. INSTALL.md

Old:

> thimble's agents run as subagents of your Claude Code session; its single model calls (labels, card checks, view
> proposals) and `thimble fix` run as `claude -p` jobs in folders of their own, so auth set only in a project's
> `.claude/` settings does not reach them.

New:

> thimble's agents and its card checks run as subagents of your Claude Code session, under its permission mode; its
> other single model calls (labels, view proposals) and `thimble fix` run as `claude -p` jobs in folders of their own,
> so auth set only in a project's `.claude/` settings does not reach them.

# Phase 2a: labels, the label draft, view fit, the viewer suggestion and a program's ask (branch 090/noclaude-2a)

The same form: old text first, then new text. These callers now make their model call as a subagent of main
(`thimble:call`), so the texts they sent as an Agent SDK session's system prompt and first message now fill the slots
of the agent's first message (call-task.md, section 2 above): `{{instructions}}`, `{{tool}}` and the part.

## 9. A call of many parts (prompts/call-task.md `## many-parts`)

Old:

> Call read_call to get the first part. Answer each part with send_answer, then call read_call again for the next
> part. Do this until a result tells you to end your turn.

New (send_answer's result now gives the next part, which saves the agent one request per part):

> Call read_call to get the first part. Answer each part with send_answer. The result of send_answer gives your next
> part, or it tells you to call read_call or to stop. Do this until a result tells you to stop.

## 10. send_answer (prompts/tools.md `## send_answer`)

Old:

> Send your answer to a part of your task. The answer must agree with the schema in your task. When it does not agree,
> the result gives the errors. Then correct the answer and send it again.

New:

> Send your answer to a part of your task. The answer must agree with the schema in your task. When it does not agree,
> the result gives the errors. Then correct the answer and send it again. When it agrees, the result gives your next
> part, if there is one.

## 11. New tool results (prompts/tools.md hints)

Old: none.

| Hint | When | Text |
|---|---|---|
| send_answer-next | an answer was recorded, and the next part follows in the same result | thimble has your answer to part {part}. Your next part follows. |
| read_call-page | a page of a part longer than 40,000 characters (agent_call.PAGE_CHARS) | `# Part {part}, page {page} of {pages}` then a blank line, then `{text}` |
| read_call-page-next | after a page that is not the last | Part {part} continues. Call read_call to get page {page}. Do not answer part {part} before you read all its pages. |
| read_call-page-last | after the last page | This is the last page of part {part}. Answer part {part} now. |

A part is paged because Claude Code (2.1.301) saves a tool result of more than 50,000 characters to a file and shows
the agent a 2KB preview, and the call's agent has no tool to read that file. A prompt label's batch stays under one
page (concepts.BATCH_CHARS is now 36,000, was 40,000); only a whole file or run, read as far as the model's context
holds, takes more than one page.

## 12. The prompt label's classifier (prompts/labels.md, head)

Text unchanged. Where it goes changed. Before: labels.md's head (the label's name, unit, definition, values, the
rationale line and the analyst's examples) was the system prompt of one Agent SDK session per batch of 50 records, the
batch's items (`### item {i} [{ref}]` and the text) were its first message, and "Return one entry per numbered item:
its value against the category's definition." was the description of the `labels` output tool. Now one call holds the
whole run: labels.md's head is `{{instructions}}` of the first message of each of its agents, the tool's description is
`{{tool}}`, with the `labels` JSON schema after it, and each batch's items are one part, which the agent gets from
read_call or from send_answer's result. A run of one batch puts its items in the first message itself
(`## one-part`).

## 13. The label draft (prompts/labels.md `## draft`), view fit (prompts/view-fit.md) and the viewer suggestion (prompts/file-viewer.md)

Text unchanged. Before, each was the first message of an Agent SDK session (the viewer suggestion's `## suggest` its
system prompt and `## file` its first message), and the output tool's description was the tool's. Now the first
message of a `thimble:call` agent holds them: the draft's and view fit's whole prompt as the part, with empty
`{{instructions}}`; the viewer suggestion's `## suggest` as `{{instructions}}` and `## file` as the part; and the tool
descriptions as `{{tool}}` (draft: "Define the label the analyst described."; view fit: "Your decision on whether the
view fits this corpus."; viewer suggestion: file-viewer.md `## proposal`).

## 14. A program's ask (harness.ask)

Text unchanged: the program's prompt is the part, "Give your answer with this tool." is `{{tool}}`, and its pictures
come from read_call. Before, they were an Agent SDK session's first message, its output tool's description and image
blocks in the first message.

## 15. What the analyst sees in main's terminal

Old (each was a `claude` session of the server's own): nothing in main's terminal.

New, the agent's line in Claude Code's agent list while it runs, and the row of its dropped hand-back
(`● Prompt dropped by a hook: <reason>`), per caller:

| Caller | Agent line | Row of the dropped hand-back |
|---|---|---|
| prompt label (concepts.LABEL_TITLE, LABEL_DONE) | thimble label: {name} | thimble labeled {noun}s for the label "{name}" |
| label draft (DRAFT_TITLE, DRAFT_DONE) | thimble label draft | thimble drafted a label |
| view fit (view_fit.TITLE, DONE) | thimble view fit: {name} | thimble decided whether the view "{name}" fits |
| viewer suggestion (views.SUGGEST_TITLE, SUGGEST_DONE) | thimble viewer suggestion: {files} | thimble checked whether {files} need a viewer |
| a program's ask (harness.ASK_TITLE, ASK_DONE) | thimble {who}: ask | thimble answered {who} |

`{noun}` is record, file, run, card or sentence; `{files}` is ".cast files" or "files without a suffix"; `{who}` is
"{extension}'s program". A prompt label shows one agent line and one row per agent it started (the smoke in
section 4 of NOCLAUDE.md gives the counts).

## 16. Failure text

A prompt label with no Claude Code session running thimble in the folder. Old (`claude` missing or not signed in,
config.auth_problem, which still applies to a run an extension's program makes):

> prompt labels cannot run: {problem}

New, the same lead with agent_call.NO_SESSION as the detail (the run's error and its notice):

> prompt labels cannot run: no Claude Code session runs thimble in this folder. Run `thimble` in the corpus folder, or
> open Claude Code there and type /thimble

Label from prompt with no session. Old (any failed draft):

> the labels model gave no label ({status}): {detail}

New, for no session only (other failures keep the old text):

> Label from prompt needs Claude Code: no Claude Code session runs thimble in this folder. Run `thimble` in the corpus
> folder, or open Claude Code there and type /thimble

View fit and the viewer suggestion keep their own words; with no session their detail is agent_call.NO_SESSION, so
Settings shows "thimble could not tell whether it fits here: no Claude Code session runs thimble in this folder. …",
and a view fit that failed so is asked again as soon as a session runs thimble there (before: after 5 minutes).

## 17. The docs

INSTALL.md. Old:

> thimble's agents and its card checks run as subagents of your Claude Code session, under its permission mode; its
> other single model calls (labels, view proposals) and `thimble fix` run as `claude -p` jobs in folders of their own,
> so auth set only in a project's `.claude/` settings does not reach them.

New:

> thimble's agents and its single model calls (card checks, prompt labels, label drafts, whether an extension's view
> fits, viewer suggestions) run as subagents of your Claude Code session, under its permission mode; its view proposals
> and `thimble fix` run as `claude -p` jobs in folders of their own, so auth set only in a project's `.claude/`
> settings does not reach them.

docs/agents.md, a program's `ask`. Old: "one model call on your own Claude, at the model, effort and fast mode Settings
shows for the role or the task's agent". New: "one model call as a subagent of your Claude Code session (it fails when
no session runs thimble in the folder), at the model and effort Settings shows for the role or the task's agent".

docs/config.md, the classifier rows. Added after "so they take only `model`, `effort`, `fast` and `prompt`.": "A prompt
label's batches, a label draft, whether an extension's view fits, a card check and a viewer suggestion run as subagents
of your Claude Code session, at its speed, so `fast` changes only the check for a view proposal after a turn." Old
"Each runs at exactly the model, effort and fast mode Settings shows for its row", new "Each runs at exactly the model
and effort Settings shows for its row".

# Phase 2b (branch 090/noclaude-2b): view proposals, `thimble fix`, extension programs

## 18. The view proposal's message: a fork of main (prompts/call-task.md `fork`)

The proposer's text (prompts/view-propose.md and its sections: the threads, the orientation, the views, Now) is the
same. Before, it was the first user message of `claude -p --resume <main> --fork-session --tools ""`, after main's
conversation. Now Claude Code's fork type carries main's conversation, and Claude Code puts its own fork text before
the message ("You are a worker fork. … Execute ONE directive, then stop." with its rules, then "Your directive:"). thimble
adds this section after the proposer's text.

Old: none.

New (`{{text}}` is the proposer's text, `{{tool}}` the answer's description below, `{{schema}}` the answer's schema):

> {{text}}
>
> # Your answer
>
> You are a fork of the analyst's session with Claude, so the conversation above is the session's conversation. You
> have no tools: thimble refuses each tool call that you make. {{tool}} Your report is your answer. Give one JSON object
> that agrees with this schema, and no other text:
>
> ```json
> {{schema}}
> ```

New, the answer's description (proposer.ANSWER):

> Your decision, as the section "Your answer" above describes it.

New, the schema: `show` (boolean), `why` (text), `proposal` (null, or an object with `name`, `description`, `task` and
`claims`, a text or a list of texts), all three required, and `proposal` an object when `show` is true.

## 19. The fork guard's refusal (plugin/bin/.thimble-watch FORK_NO_TOOLS)

The reason Claude Code gives a fork of main that calls a tool. Before, the fork had no tools (`--tools ""`).

Old: none.

New:

> You answer for thimble, and you have no tools: thimble refuses every tool call that you make. Give your answer as
> your report: the JSON object that your task asks for, and no other text.

## 20. What main's terminal shows

Old: nothing (the fork ran as a separate `claude -p`).

New: while the fork runs, Claude Code's agent list shows `thimble: view proposal`. When it ends, nothing: Claude Code
sent no hand-back of a fork that the plugin started (live check, auto mode). If one comes, the terminal UI drops it
with the row `thimble checked for a view proposal`.

## 21. `thimble fix` with the server down (backend/app/cli.py FIX_IN_SESSION)

Printed after `thimble doctor`'s text by `thimble fix` and by /thimble fix, which main reads.

Old: thimble fix ran a `claude -p` session on prompts/dev-fix.md (removed):

> ## The server is down
>
> You bring the server back, as a Claude Code session in a git worktree of the live checkout, at {{worktree}}, with
> no validation stack. `thimble fix` fast-forwards the live checkout to your branch and restarts the server. …

New:

> thimble fix starts no Claude Code session of its own: thimble's model calls run only as subagents of your Claude
> Code session. To repair the server, open Claude Code in thimble's checkout ({repo}) and ask it to fix what thimble
> doctor reports above, then run `thimble server restart`. While the server runs, ask Claude in a thimble session to
> file a code ticket instead.

The /thimble skill's description, old: "`/thimble fix` repairs a server that will not start". New: "`/thimble fix` says
how to repair a server that will not start". `thimble --help`, old: "repair a server that will not start, with
thimble's dev agent". New: "a server that will not start: what doctor finds, and how to repair it".

## 22. Extension programs (backend/app/harness.py, agent_kit)

An Agent SDK program does not start. Old: none (it started). New (NO_SDK, the start's error, which main or the
browser shows; `{name}` the extension, `{who}` the role or task):

> The {name} extension runs the {who} as an Agent SDK program, which starts Claude Code sessions of its own, and
> thimble no longer starts any: each model call runs as a subagent of your Claude Code session. Turn the extension off
> in Settings to run thimble's own {who}, or ask its author for a `command` program, which asks a model with `ask`.

A `session` request, the kit's session() and options(), and the session route. Old: a Claude Code session ran. New
(NO_SESSION, the error the program reads):

> thimble starts no Claude Code session for a program: each model call runs as a subagent of the analyst's Claude Code
> session. Ask a model with `ask` instead.

Settings' line for an SDK program, old: "runs {who} as an Agent SDK program". New: "runs {who} as an Agent SDK
program, which thimble no longer starts".

## 23. INSTALL.md

Old (line 10, after phase 1): "its other single model calls (labels, view proposals) and `thimble fix` run as
`claude -p` jobs in folders of their own". New: "and so do view proposals, as a fork of your session that reads its
conversation and uses no tools; its other single model calls (labels) run as `claude -p` jobs in folders of their own".

Old (Permissions): "`thimble fix` asks you in the terminal before its change reaches thimble's code, and before it
starts where its sandbox can't run. Nobody can answer it while it works, so it runs its commands without asking, in its
sandbox where that can run." New: "`thimble fix` starts no Claude Code session: it says what `thimble doctor` finds, and
you make the repair in your own Claude Code session, opened in thimble's checkout."

# Phase 3 (branch 090/noclaude-3): the merge, the removal, the docs

No prompt file changed in phase 3 (prompts/*.md). The texts below are Settings' words and the docs, which the analyst
reads.

## 24. The merge of call-task.md (prompts/call-task.md)

Phase 2a's `## many-parts` (section 9) and phase 2b's `## fork` (section 18) are both kept, as each phase wrote them.

## 25. Settings: the model calls' permission cell (frontend/src/shell/SettingsPopover.tsx CALL_CELL)

The cell of the Labels and Card check rows, where an extension's dev program shows its permission mode.

Old:

> Asks nothing

Old tooltip:

> It has no permission mode. thimble runs it as one model call with no tools, and an extension's program that runs its
> tasks has no thread to ask you in.

New:

> Your session's

New tooltip:

> It runs as a subagent of your Claude Code session, in its permission mode: Manual mode asks before it reads its task
> and before it sends its answer.
> An extension's program that runs its tasks has no thread to ask you in.

## 26. Settings: the model table (SettingsPopover.tsx ROLE_LABEL, ROLE_NOTE, TICKET_FAST, lockedWhy)

The `suggest` row's name. Old: "view proposals". New: "viewer suggestion".

The `suggest` row's note. Old: none. New:

> which viewer a file of an unknown type needs; a view proposal runs on your session's model

The `refusal` row's note. Old: "if a classifier's model refuses: run again on this, or switch it off". New: "if a model
call's model refuses: run again on this, or switch it off".

The dev row's switch "thimble fix's fast mode" and the fast switches of the labels, card check and `suggest` rows are
gone; only main's fast switch is left, so the reason "<model> has no fast mode" no longer shows on another row.

## 27. Settings: an Agent SDK program's line (SettingsPopover.tsx runsWords, agentTip)

Old: "{extension}, Agent SDK". New: "{extension}, Agent SDK, which thimble no longer starts".

Old tooltip: "{extension} runs it with an Agent SDK program." New: "{extension} replaces it with an Agent SDK program,
which thimble no longer starts: it starts no Claude Code session of its own."

## 28. INSTALL.md

The opening paragraph, after the merge of phases 2a and 2b. Old (2a): "thimble's agents and its single model calls (card
checks, prompt labels, label drafts, whether an extension's view fits, viewer suggestions) run as subagents of your
Claude Code session, under its permission mode; its view proposals and `thimble fix` run as `claude -p` jobs in folders
of their own, so auth set only in a project's `.claude/` settings does not reach them." New:

> thimble uses whichever auth path you have configured for `claude`, and starts no Claude Code session of its own: its
> agents and its single model calls (card checks, prompt labels, label drafts, whether an extension's view fits, viewer
> suggestions) run as subagents of your Claude Code session, under its permission mode and sign-in, and so do view
> proposals, as a fork of your session that reads its conversation and uses no tools. With no Claude Code session
> running thimble in the folder, these features say so and how to start one. thimble tells you when `claude` is missing
> or not logged in.

Authentication. Old: "thimble has no login of its own: every model call runs your own `claude`." New: "thimble has no
login of its own and starts no Claude Code session of its own: every model call runs in your Claude Code session, on its
sign-in."

API key. Old: "Export `ANTHROPIC_API_KEY` in your shell before thimble's server starts. The server keeps the environment
it started with, so if a server already runs, run `thimble server restart` from that shell." New: "Export
`ANTHROPIC_API_KEY` in your shell before you start `claude` or `thimble`."

apiKeyHelper. Old: "It reaches your session and thimble's server calls, whatever your shell exports. Auth set only in a
project's `.claude/` settings does not reach thimble's server calls." New: "It reaches your session whatever your shell
exports, and with it every model call of thimble's, which runs in your session."

Bedrock, Vertex or Foundry. Old: "before the server starts". New: "before Claude Code starts".

After a change of credentials. Old: "run `thimble server restart`. `thimble doctor --verbose` shows the auth path."
New: "start Claude Code again, and run `thimble server restart` so that `thimble doctor --verbose`, which shows the auth
path, reads them."

Manual mode, added: "A model call of thimble's (a card check, a prompt label, a label draft, a viewer suggestion) runs as
a subagent with two tools of its own, and Claude Code asks before it reads its task and before it sends its answer; a
prompt label asks about once per batch of 50 records."

Permissions. Old: "thimble's own jobs (an extension's program that runs the dev agent, and the sessions thimble's server
runs) follow your session's mode, but never Bypass: Settings offers Manual and Auto for them". New: "An extension's
program that runs the dev agent, a job of thimble's server, follows your session's mode, but never Bypass: Settings
offers Manual and Auto for it".

View proposals. Old: "Deciding whether to propose takes one model call on a copy of your session's context, made with
the sign-in thimble's card checks and labels use." New: "Deciding whether to propose takes a fork of your session, a
subagent that reads its conversation, uses no tools and runs on its model and sign-in."

## 29. docs/config.md

The Settings pane's list. Old: "the models and efforts, the fast mode of the classifiers, the permission mode …". New:
"the models and efforts, the permission mode …".

`views.propose`. Old: "Deciding whether to propose takes one model call on a copy of your session's context, on the
`suggest` row." New: "Deciding whether to propose after a turn takes a fork of your session, which reads its
conversation and runs on your session's model and effort; whether a file type needs a viewer is a model call on the
`suggest` row."

`refusal`. Old: "a classifier's call". New: "a model call".

The launcher's variables. Old: "thimble's single model calls run without them, so that none can change what runs." New:
"thimble's model calls are subagents of that session too."

The model calls' rows. Old (after the merge): "`labels`, `cardCheck` and `suggest` are single model calls with no tools,
so they take only `model`, `effort`, `fast` and `prompt`. A prompt label's batches, a label draft, whether an
extension's view fits, a card check and a viewer suggestion run as subagents of your Claude Code session, at its speed,
so `fast` changes nothing for them." New:

> `labels`, `cardCheck` and `suggest` are model calls: a prompt label's batches, a label draft, whether an extension's
> view fits, a card check and a viewer suggestion each run as a `thimble:call` subagent of your Claude Code session, with
> two tools of its own (one reads its task, one sends its answer), so they take only `model`, `effort` and `prompt`.
> thimble starts no Claude Code session of its own for them, and with no session running thimble in the folder each
> says so, with how to start one.

The `fast` key. Old: "Fast mode, on models that have it, for `labels`, `cardCheck` and `suggest`. `dev`'s reaches
nothing, since `thimble fix` starts no Claude Code session. …" (default "on for `cardCheck` and `dev`"). New (no
default):

> Read and ignored: every agent and model call of thimble's runs as a subagent of your Claude Code session, which Claude
> Code gives no fast mode of its own. Your session's own fast mode is the composer's switch, applied at its next start.

## 30. README.md

Added after "all authentication and billing is managed by `claude`.": "It starts no Claude Code session of its own: its
agents and model calls run as subagents of your session, in its permission mode."

## 31. The config check's words for an old `fast` (backend/app/userconf.py)

Old: `agents.labels.fast` (and `cardCheck`, `suggest`, `dev`) was a setting. New: it is read and ignored, listed with the
other ignored keys ("thimble's config holds settings this version ignores: agents.labels.fast. Saving here drops
them."), as an agent's `fast` already was.
