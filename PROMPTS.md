# Prompt text of the no-claude change, phase 1 (branch 090/noclaude)

Every text a model or the analyst reads that this phase adds or changes, old text first, then new text. "None" means
the text is new. Placeholders are in braces: `{{x}}` in prompt files, `{x}` in tools.md hints and code.

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

# Phase 2b (branch 090/noclaude-2b): view proposals, `thimble fix`, extension programs

## 9. The view proposal's message: a fork of main (prompts/call-task.md `fork`)

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

## 10. The fork guard's refusal (plugin/bin/.thimble-watch FORK_NO_TOOLS)

The reason Claude Code gives a fork of main that calls a tool. Before, the fork had no tools (`--tools ""`).

Old: none.

New:

> You answer for thimble, and you have no tools: thimble refuses every tool call that you make. Give your answer as
> your report: the JSON object that your task asks for, and no other text.

## 11. What main's terminal shows

Old: nothing (the fork ran as a separate `claude -p`).

New: while the fork runs, Claude Code's agent list shows `thimble: view proposal`. When it ends, nothing: Claude Code
sent no hand-back of a fork that the plugin started (live check, auto mode). If one comes, the terminal UI drops it
with the row `thimble checked for a view proposal`.

## 12. `thimble fix` with the server down (backend/app/cli.py FIX_IN_SESSION)

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

## 13. Extension programs (backend/app/harness.py, agent_kit)

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

## 14. INSTALL.md

Old (line 10, after phase 1): "its other single model calls (labels, view proposals) and `thimble fix` run as
`claude -p` jobs in folders of their own". New: "and so do view proposals, as a fork of your session that reads its
conversation and uses no tools; its other single model calls (labels) run as `claude -p` jobs in folders of their own".

Old (Permissions): "`thimble fix` asks you in the terminal before its change reaches thimble's code, and before it
starts where its sandbox can't run. Nobody can answer it while it works, so it runs its commands without asking, in its
sandbox where that can run." New: "`thimble fix` starts no Claude Code session: it says what `thimble doctor` finds, and
you make the repair in your own Claude Code session, opened in thimble's checkout."
