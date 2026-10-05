# thimble workspace export

This zip holds every usage record thimble keeps for one workspace: what the analyst did in the browser, what every
Claude Code session did, how the canvas, the labels, the views and the documents changed, and when. It is meant for
reconstructing how an analysis was done (timelines of what the analyst did, chat cadence, time per activity). The corpus itself is not in the zip: `manifest.json` lists
its files by path, size and SHA-256.

All times are UTC in ISO 8601 on the server's clock (`ts`), except the browser's own clock on telemetry rows
(`client_ts`) and Claude Code's clock in transcripts (`timestamp`), which is the same machine's in a normal install.
Every `.jsonl` file has one JSON object per line.

## Files

| file | what it holds |
|---|---|
| `manifest.json` | schema name and version, the workspace (name, corpus manifest, settings), the time range of the records, the corpus's files (path, bytes, sha256; not their contents), every file of this zip (path, bytes, sha256, rows) and `omitted`, the files left out (path, bytes, sha256, why) |
| `telemetry/ui.jsonl` | the browser's acts as `telemetry.jsonl` stores them: `{ts, seq, boot, actor, session, client_seq, client_ts, kind, target, target_kind, detail, duration_ms}`. `session` is one browser page load; `seq` the log's counter; `boot` the server process. Also the rows the server writes itself: `lock`, `unlock`, `lock-refused` |
| `telemetry/files-opened.jsonl` | every file the analyst opened in the browser, `{ts, actor, by, path, kind}` (a model's reads are its Read, Grep and Glob calls in the transcripts) |
| `telemetry/events.jsonl` | the workspace event stream, `{ts, seq, type, …}`: `chat` (a chat changed), `cell` (a card ran, was edited, moved or deleted), `concepts` (a label was defined, applied, deleted), `filter`, `view`, `report`, `orient`, `ticket`, `job`, `feedback`, `server` |
| `chats/index.jsonl` | one row per chat: its meta (`id`, `kind` main, thread or agent, `role`, `title`, `parent`, `anchor`, `created_at`, `status`, `ts_end`, `session`, `agent_id`, `fork`, `group`, `result`), with `log`, `records`, `first_ts`, `last_ts`, `trashed` |
| `chats/<id>.jsonl` | the chat as the browser showed it: `user {text, by, event?}`, `text {delta}` (no `ts`; it belongs to the next record that has one), `tool_use {id, name, input}`, `tool_result {id, summary, cell_id?, notebook?}`, `refs`, `done`, `error`, `chip {kind, text, ref?}`, `agent {chat, role, title}`. A record's line number (from 0) is its id. A deleted thread's log is under `chats/trash/` |
| `sessions/index.jsonl` | one row per transcript file: `session`, `role` (`main`, `orient`, `writer`, `dev`, `step` for a session started as a step of another, such as the critique of an orientation, `thread`, `worker`), `chat`, `file` (`session`, `subagent`, `workflow-agent`, `journal`), `path`, `agent_id`, `meta` (Claude Code's `.meta.json` for a subagent: its description and type), `workflow_run`, `rows`, `first_ts`, `last_ts`, and for main's sessions `since`, `ended`, `reason`, `cwd` |
| `sessions/<session>.jsonl` | a Claude Code session's transcript as Claude Code wrote it: every user message and browser event, assistant text, tool call with its input, tool result, and system record |
| `sessions/<session>/subagents/agent-<id>.jsonl` | a subagent of that session (a thread's fork, a reader, the critic, verify), with its `.meta.json` |
| `sessions/<session>/subagents/workflows/<run>/` | the agents of one Workflow run and its `journal.jsonl` (when each agent started, under what label, and returned); the script is under `sessions/<session>/workflows/` |
| `canvas/groups.jsonl` | every group (frame) now and in the trash, without its cards: `id`, `title`, `parent`, `kind`, `role`, `anchor`, `chat`, `cards`, `trashed` |
| `canvas/cards.jsonl` | every card now: `card`, `group`, `kind`, `title` (the question), `code` or `payload`, `takeaway`, `takeaway_author`, `labels`, `locked`, `starred`, `status`, `exec_count`, `created_by`, `created_ts`, `created_at_event`, `edited [{by, ts}]`, `previous_code`, `outputs` (each output's mime types, the first 4,000 characters of its text, its size) |
| `canvas/history.jsonl` | every change to a card, oldest first: `{ts, op, card, group, by, changed, state, source}`. `op` is `created`, `seen`, `edited`, `ran`, `credited`, `moved` or `deleted`; `state` is the card after the change (for `deleted`, as it was). A group moved as a whole is a line of its own with no `card`: `{ts, op: "group-moved", group, title, by, from, to, cards}`. `source: log` lines come from `canvas-history.jsonl`; `source: reconstructed` lines cover changes that log does not hold, rebuilt from what the other records still hold (a creation with the card's current content, an edit's time and author without content, a deletion from the event stream) |
| `labels/definitions.jsonl` | every label: `id`, `name`, `unit` (record, cell, span), `kind` (prompt, regex, code), `spec`, `labels` (its values), `applications` (each run: when, over which paths, how many units), `created_by`, `ts` |
| `labels/results.jsonl` | the label files as written, in order: a row per labeled unit, `label` (the definition's id), `ref` (the unit), `value`, `confidence`, `source`, `ts`, `comment`. A run over the records of whole files writes rows only for the records that took another value than the negative: a `cover` row (`cover` the file, `from` and `to` its records, `value`) stands for the records in that range with no row of their own, and a `clear` row (`clear`, `from`, `to`, open-ended when `to` is null) drops the rows and covers an earlier run left on those records |
| `labels/filters.json` | the filters set per scope |
| `views/` | `proposals.json`, the view tickets with their state, and thimble's other records of the views (the versions that passed their checks, their reviews) |
| `extension/` | the workspace's local extension: `extension.json` and each view's definition as the dev agent wrote it for its view ticket (`views/<view>/view.json`, `reader.py`, `view.html`); the caches are left out |
| `documents/documents.jsonl` | every stored state of every document: `{doc, state, file, document}` with `state` `current`, `frame` (the analyst's pinned figures and bullets before a write), `archive` (a replaced generation) or `version` (a revision record: who asked, the instruction, what changed, and the generation it replaced in `previous`) |
| `documents/comments.jsonl` | every comment once (the analyst's and the verifier's marks, with replies and resolution), as the newest state holding it has it: `doc`, `id`, `sentence_id`, `author`, `kind`, `text`, `status`, `generation`, `ts` |
| `orientation/` | the orientation's record (`run.json`) and summary |
| `tickets.jsonl` | the dev tickets filed from this workspace |

## How the files join

- **A chat and its session.** Main's chat is `main`; its transcripts are the `sessions/index.jsonl` rows with `role:
  main` (one per launch). The orientation's and each writer's session: the agent chat's `session` is the transcript's
  name. A subagent's chat: its `agent_id` names `agent-<agent_id>.jsonl` under its `session`'s directory. A thread's
  fork: the thread's `fork.agent_id` names its transcript under main's session directory.
- **A message sent in the browser.** A `user` record with `by: browser` in `chats/main.jsonl` (or in a thread's log)
  carries `event`; the same id is `event="<id>"` in the `<thimble-event …>` tag of the transcript record where the
  session received it (`<channel source="plugin:thimble:thimble" …>` in a transcript thimble 0.5.0 or earlier wrote,
  where such a record may have `origin.kind: "channel"`). Send time is the chat record's `ts`, pickup the transcript record's
  `timestamp`, and the answer is finished at the next `done` record in the chat. `telemetry/ui.jsonl` has the send as
  `ask-send` (target `chat:<id>`, `detail.event` the event kind, `detail.chars`), with the page load it came from.
- **A card.** `card:<id>` (or `cell:<id>`) in telemetry targets, citations and label refs is
  the `card` of `canvas/*.jsonl`. `created_by` is `chat:<id>` (the chat whose agent made it), `terminal` (main's
  session), or `user` (the analyst by hand); `created_at_event` is the line number of the `tool_use` record that made
  it in that chat. A chat's `tool_result` record names the card in `cell_id`.
- **A label.** `labels/results.jsonl` `label` is `labels/definitions.jsonl` `id`, and `concept:<id>` in telemetry. A
  unit's `ref` is a record (`path#L<n>`), a card (`card:<id>`), or a passage of a document (`report:<slug>#<id>`).
- **A document.** `report:<slug>` in telemetry is `doc`; a comment's `sentence_id` is a sentence's `id` in that
  document's `document.sections[].paragraphs[].sentences`.
- **Browser telemetry targets.** `panel:<files|canvas|report|chat>` (the surface), `ui:<name>` (a control, with
  `detail.panel` and `detail.label`), a file path (`path` or `path#L<n>`), `group:<id>` (a canvas frame), `view:<slug>`,
  `chat:<id>`, `orient:<switch>`. `tab-activate` names the surface shown (`panel:…`) or the file in front in Files (a
  path); `notebook-switch` the canvas frame the analyst selected. `page-load`, `page-unload` and `visibility` rows mark
  when the page was open and in front.

## Reconstructing the analysis

- **What the analyst did over time** (swimlanes, first use, transitions): `telemetry/ui.jsonl` in `ts` order, with the
  surface from `tab-activate` targets and each click's `detail.panel`; add the file opens from
  `telemetry/files-opened.jsonl` and the sends from the chats.
- **Chat cadence** (sent, answered, latency, main against threads): `chats/index.jsonl` for each chat's kind, then in
  each log each `user` record from the browser or the terminal and the next `done` record.
- **Phases**: the Start card's `start-run` row (and the orientation chat's `created_at`), the orientation's end (its
  chat's `ts_end`), documents written (`documents/documents.jsonl`, `generated_at`).
- **Sensemaking steps and facts**: coded by a reader from the whole record in time order: the transcripts (every
  prompt, tool call and output), the chats, `canvas/history.jsonl` and the telemetry.

## What is not here

The corpus's contents, and the long tool results Claude Code writes beside a transcript (listed in `omitted`: mostly
corpus text a model read). Scrolling, hovering and the viewport are not recorded, so what was on screen between clicks
is known only from the surface shown, the files opened and the page's visibility. thimble records no audio or
screen capture.
