# Tools

The file has three parts, and the server reads each `## ` section by its name. First comes each tool, its description, which a model reads to choose the tool, and under it the input schema. Then `instructions`, the short text the thimble server gives every session that loads the plugin. Last come the lines thimble adds to a tool's result in one situation, each named by that situation, such as `card-errored`, with each `{name}` in it filled in by the server.

## read_ref

Read anything thimble can cite, as the analyst sees it, such as a card with its outputs. The analyst may edit a card at any time, so read it again before you rely on it. Read a plain file with Read.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "A ref without its brackets."}
  },
  "required": ["ref"]
}
```

## list_cards

List a group's cards, one line each with its id, kind, question and the start of its takeaway.

```json
{
  "type": "object",
  "properties": {
    "group": {"type": "string", "description": "A group's title or id, or all."}
  },
  "required": ["group"]
}
```

## add_card

Add a card to the canvas, with its question and its content in one call. thimble runs the code and returns `card:<id>` and the start of each output. Give its takeaway here, or with `edit_card` once you have read the output.

```json
{
  "type": "object",
  "properties": {
    "question": {"type": "string", "description": "The one question the card answers."},
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom"], "description": "table, code, diagram, plot and timeline run `code`, example shows `refs`, note `text`, custom `html`. Default code."},
    "code": {"type": "string", "description": "Python run in the corpus root. A table ends in a DataFrame of a few short columns indexed by what names each row, a plot in an Altair or matplotlib chart, its colours left to thimble's theme, and after import thimble a diagram in thimble.diagram(nodes, edges), each edge a (source, target, label), and a timeline in thimble.timeline(events), each event a (time, label). Name nodes, edges and events in a few words; an edge label over 36 characters becomes a numbered note under the diagram. In matplotlib, colour a label's values with thimble.colours(label, values), a {value: colour} dict. A plot can also be a card type's graphic, thimble.card(type, labels=[...], **args), from the card types under Cards."},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"} } } ] }, "description": "The records an example card shows, usually about three, adding one only when it shows something the others don't. Each is a ref, a moment of a video as <path>#t=<m:ss>, or {ref, quote} to highlight one passage of a long record, quoted exactly."},
    "text": {"type": "string", "description": "The markdown a note card shows."},
    "html": {"type": "string", "description": "The page a custom card shows, for what no other kind can show. Scripts run, the network does not."},
    "group": {"type": "string", "description": "The group's title or id. A new title makes a group."},
    "takeaway": {"type": "string", "description": "The answer to the question in one or two sentences. In a takeaway, each number the card shows links to where the card shows it. Wrap the whole quantity and cite where you read the value, as in `[[31|card:<id>#outcome/merged]] of [[40|card:<id>#outcome/all]] runs`. On an example card, link the words of each claim to the record that shows them, as in `[[posted the answer|runs/r3.jsonl#L88]]`. A rewritten takeaway keeps every link that is right. The card's own id is written `card:<id>`, which thimble fills in."}
  },
  "required": ["question"]
}
```

## edit_card

Change a card in place and run it again, rather than adding a second card. It takes the fields of `add_card`, a `takeaway`, which alone sets the card's answer without a run and with a change is checked against the new output, and `after`, which reorders a group.

```json
{
  "type": "object",
  "properties": {
    "card": {"type": "string"},
    "question": {"type": "string"},
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom"]},
    "code": {"type": "string"},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"} } } ] } },
    "text": {"type": "string"},
    "html": {"type": "string"},
    "group": {"type": "string", "description": "The group to move the card to, its title or id. A new title makes a group."},
    "after": {"type": "string", "description": "The card to place it right after, card:<id>, or first."},
    "takeaway": {"type": "string", "description": "The answer to the question in one or two sentences. In a takeaway, each number the card shows links to where the card shows it. Wrap the whole quantity and cite where you read the value, as in `[[31|card:<id>#outcome/merged]] of [[40|card:<id>#outcome/all]] runs`. On an example card, link the words of each claim to the record that shows them, as in `[[posted the answer|runs/r3.jsonl#L88]]`. A rewritten takeaway keeps every link that is right."}
  },
  "required": ["card"]
}
```

## delete_card

Remove a copy of a card, or an attempt another card replaced. Fix a wrong card with `edit_card` instead.

```json
{
  "type": "object",
  "properties": {
    "card": {"type": "string"}
  },
  "required": ["card"]
}
```

## apply_label

Define a category, apply it to every unit of a scope, and get the counts per value and a card where the analyst checks each unit. A prompt label over many files takes minutes.

```json
{
  "type": "object",
  "properties": {
    "scope": {"type": "string", "enum": ["files", "canvas", "report"], "description": "Records of files, cards, or report sentences."},
    "name": {"type": "string"},
    "question": {"type": "string", "description": "The one question its card answers."},
    "predicate": {
      "type": "object",
      "properties": {
        "kind": {"type": "string", "enum": ["prompt", "regex", "code"], "description": "A model judges each unit, a regex matches its text, or code defines label(unit) returning (value, confidence), where a unit is a JSONL record as its dict, a text line or a sentence a dict with its words in unit['text'], a row of a database or a CSV file a dict of its columns, a record of a JSON document its value, a PDF page a dict with its page and text, and a card a dict with its text, kind, question, takeaway, group and groups, the titles of the frames around it. A record that saves a whole document again, such as a wiki page's revision, is read by a model or a regex as what it changed from the save before, and by code whole."},
        "text": {"type": "string", "description": "The description, pattern or function."}
      },
      "required": ["kind", "text"]
    },
    "values": {"type": "array", "items": {"type": "string"}, "description": "Positive first. Default yes and no."},
    "paths": {"type": "array", "items": {"type": "string"}, "description": "Globs, for files. A record of a file is a line of text, a row of a database's table, a page of a PDF, a value of a JSON document or a row of a CSV file. A glob followed by a record's place, such as `runs/*/forge.db#prs` for a table or `results.json#/runs`, keeps the records there."},
    "limit": {"type": "integer", "description": "Units to label, for a trial."},
    "within": {
      "type": "object",
      "properties": {
        "label": {"type": "string"},
        "value": {"type": "string", "description": "Default its first."}
      },
      "required": ["label"],
      "description": "For files: label only the records another label gave this value, such as the few a regex or code label kept before a prompt label reads them."
    },
    "comment": {"type": "boolean", "description": "A one-line reason per unit."},
    "show": {"type": "boolean", "description": "For files: turn it on in Files and the views as it runs, as show_label does."},
    "filter": {"type": "boolean", "description": "Make it the scope's filter."},
    "group": {"type": "string"}
  },
  "required": ["scope", "name", "predicate"]
}
```

## show_label

Turn a label over files on or off in Files and the views, where it marks the records that have the values it highlights, or give its values colours. It runs nothing, so a label is shown or hidden with it rather than with `apply_label`. The analyst turns labels on and off in Files too, so call it whenever they ask to show or hide one, or to colour a value.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The label's name or id."},
    "on": {"type": "boolean", "description": "Left out, the label stays on or off as it is."},
    "values": {"type": "array", "items": {"type": "string"}, "description": "The values to highlight while it is on, when not the ones it highlights now."},
    "colours": {"type": "object", "additionalProperties": {"type": "string", "enum": ["blue", "orange", "green", "sky blue", "olive", "teal", "brown", "navy", "grass green", "cerulean", "chestnut", "cyan"]}, "description": "A colour for each value named, which every card, view and Files show. A value that had the colour takes the one the other leaves."}
  },
  "required": ["name"]
}
```

## set_filter

Filter the canvas's cards, the records in Files or the report's sentences by a value of a label that exists, and the canvas's cards also by their kind, group, maker, card check, star, lock or words. It makes no label and no card. The parts you give replace those parts of the scope's filter, and the others stay.

```json
{
  "type": "object",
  "properties": {
    "scope": {"type": "string", "enum": ["canvas", "files", "report"]},
    "label": {"type": "string", "description": "A label's name or id. An empty string drops the label from the filter."},
    "value": {"type": "string", "description": "The label's value to keep. Default its first."},
    "kinds": {"type": "array", "items": {"type": "string"}, "description": "Card kinds, such as table or plot."},
    "groups": {"type": "array", "items": {"type": "string"}, "description": "Groups' titles or ids."},
    "makers": {"type": "array", "items": {"type": "string"}, "description": "Who made the cards, as each card names them, such as main, a thread's name or orient."},
    "checks": {"type": "array", "items": {"type": "string", "enum": ["verified", "unverified", "failed", "not checked"]}, "description": "What the card check found, as each card's check mark shows it."},
    "starred": {"type": "boolean"},
    "locked": {"type": "boolean"},
    "text": {"type": "string", "description": "Words that a card's question or takeaway holds."}
  },
  "required": ["scope"]
}
```

## clear_filter

Clear a scope's whole filter, so all its cards, records or sentences show again.

```json
{
  "type": "object",
  "properties": {
    "scope": {"type": "string", "enum": ["canvas", "files", "report"]}
  },
  "required": ["scope"]
}
```

## set_layout

Lay out the browser's main area, right of the chat, as panes that each show one surface: `files`, `canvas`, `report`, or a view on its own as `view:<slug>`. Call it when the analyst asks to see surfaces together, such as the files beside the report. The analyst can also drag the panes into place.

```json
{
  "type": "object",
  "properties": {
    "layout": {"type": "string", "enum": ["one", "columns", "rows", "three", "quadrants"], "description": "One pane, two side by side, two stacked, one large beside two stacked, or four."},
    "surfaces": {"type": "array", "items": {"type": "string"}, "description": "One surface per pane, in reading order: left to right, then top to bottom."}
  },
  "required": ["layout", "surfaces"]
}
```

## open_view

Open a card of a card type as its view in Files, as the card's Open as view does: the card's labels turn on and its arguments choose the view's records, which follow the labels live. Call it when the analyst asks to see such a card as a view, or with `view` to open a view with no card's arguments.

```json
{
  "type": "object",
  "properties": {
    "card": {"type": "string", "description": "The card, card:<id>."},
    "view": {"type": "string", "description": "A view's slug or name, opened with no card's arguments, in place of `card`."}
  }
}
```

## propose_view

Propose a view, a page that shows records in a form their files hide, or a viewer for one unusual file type. thimble's dev agent builds it from these fields alone, so name the fields, keys and counts it needs.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "A short name in Title Case, as its tab shows it, such as Message Board."},
    "why": {"type": "string", "description": "What the analyst sees and why that helps, in whatever form fits the records, such as a wiki page with its edit history or a graph of who replies to whom."},
    "claims": {"type": "array", "items": {"type": "string"}, "description": "Globs of every file that holds its records, by pattern rather than one file, such as runs/*/events.jsonl. For a viewer of one file type, the extension's glob, such as **/*.vtt."},
    "unit": {"type": "string", "description": "What one row, mark or card stands for, the field that keys it, and how many there are."},
    "overview": {"type": "string", "description": "What does the overview look like?"},
    "zoom": {"type": "string", "description": "How do you zoom?"},
    "filter": {"type": "string", "description": "How do you filter? Labels are the main filter, every field the records carry can be selected, and several runs or sources can be compared side by side."},
    "details": {"type": "string", "description": "What details might you want on demand?"}
  },
  "required": ["name", "why", "claims", "unit", "overview", "zoom", "filter", "details"]
}
```

## write_document

Save a whole document as markdown in its type's form. To change one passage, use `edit_document`.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, such as report."},
    "text": {"type": "string"}
  },
  "required": ["doc", "text"]
}
```

## edit_document

Replace one sentence, paragraph or heading of a written document, insert a passage after it, or delete it. Inserted text that opens with a `## ` heading is a new section, slide or beat after the one the span is in, in the document's markdown. `layout` alone sets a slide's layout, `block_type` alone turns a heading, paragraph or list item into another kind of block, its text kept, and `card` alone sets where a story section's card stands.

```json
{
  "type": "object",
  "properties": {
    "span": {"type": "string"},
    "text": {"type": "string"},
    "insert": {"type": "boolean"},
    "delete": {"type": "boolean"},
    "layout": {"enum": ["title", "bullets", "paragraph", "bullets + card", "paragraph + card", "bullets + two cards", "paragraph + two cards", "card", "two cards", "three cards", "four cards", "card grid", "quote"]},
    "block_type": {"enum": ["heading", "subheading", "text", "bullets", "numbers"]},
    "card": {"enum": ["right", "left", "full", "none"]}
  },
  "required": ["span"]
}
```

## add_comment

Comment on one sentence, paragraph or heading of a written document, a note the analyst reads beside it. In a check's session, comment only on the document you are checking.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "report:<doc>#<id> of a sentence or a heading, report:<doc>#p<id> of a paragraph."},
    "text": {"type": "string"}
  },
  "required": ["ref", "text"]
}
```

## resolve_comment

Resolve a comment on a document, as the analyst's ✓ beside it does, or open a resolved one again.

```json
{
  "type": "object",
  "properties": {
    "comment": {"type": "string", "description": "The comment's id, as add_comment's result names it, or report:<doc>#<id> of a passage, which resolves every open comment on it."},
    "reopen": {"type": "boolean"}
  },
  "required": ["comment"]
}
```

## reply_in_thread

Post the reply the analyst reads in a thread.

```json
{
  "type": "object",
  "properties": {
    "thread": {"type": "string", "description": "The `thread` attribute of the thread's event."},
    "text": {"type": "string"}
  },
  "required": ["thread", "text"]
}
```

## message_thread

Send a message the analyst typed in this terminal to a thread, as that thread's composer in the browser sends it: a side thread's follow-up, or with no message its unanswered questions asked again, whose `thread` event, with the thread's anchor, comes back in the result for you to handle at once; a follow-up for the orientation; or a change to a view for the view's build thread. The browser shows the message in that thread. Call it for /thimble:ask.

```json
{
  "type": "object",
  "properties": {
    "thread": {"type": "string", "description": "The thread's name or id as the thread list shows it, such as main/why-the-spike, orient or dev/board."},
    "message": {"type": "string", "description": "The analyst's message, word for word. Leave it out to ask a side thread's unanswered questions again."}
  },
  "required": ["thread"]
}
```

## wait_session

Only for a tray entry of thimble's agents, as its instructions file says; main never calls it. Waits for news from the agent the entry shows: its replies, tool calls and messages, its state, or its end. It returns as soon as there is news, or within a few seconds.

```json
{
  "type": "object",
  "properties": {
    "session": {"type": "string", "description": "The session's whole name, such as thimble:writer · logs."}
  },
  "required": ["session"]
}
```

## list_agents

List thimble's agents that run now and what each is doing. Call it for /thimble:agents.

```json
{
  "type": "object",
  "properties": {}
}
```

## rename_thread

Rename a thread in the browser's thread list, when the analyst asks you to.

```json
{
  "type": "object",
  "properties": {
    "thread": {"type": "string", "description": "The thread's id, or its name as the thread list shows it, such as main/why-the-spike."},
    "name": {"type": "string", "description": "The new name."}
  },
  "required": ["thread", "name"]
}
```

## delete_thread

Delete a thread and its chat from the workspace, stopping its session if it runs. Use it only when the analyst asks for it; main cannot be deleted.

```json
{
  "type": "object",
  "properties": {
    "thread": {"type": "string", "description": "The thread's id, or its name as the thread list shows it, such as main/why-the-spike."}
  },
  "required": ["thread"]
}
```

## screenshot

Get a picture of what the analyst sees in the browser, such as a card as the canvas draws it. It is slow, so use it only when the look matters, such as when the analyst asks you to fix how something appears.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "card:<id>, view:<slug>, a file ref a view opens, report:<slug>#<id> of a figure, report:<slug> of a video, thread:<id>, or an http address of thimble's own interface on this machine."},
    "selector": {"type": "string", "description": "With an http address, the CSS selector of the one element to shoot."},
    "t": {"type": "array", "items": {"type": "number"}, "description": "With a video, the seconds of its film to shoot, up to six frames, such as [2, 12.5]. Left out, a frame in the middle of each line, up to six."}
  },
  "required": ["ref"]
}
```

## start_orientation

Start an orientation, a broad analysis of the corpus that helps the analyst understand it, in a Claude Code session of its own beside yours, which shows the analyst when it finishes the outputs its switches turn on. The browser shows it as a thread, and an `orient` event tells you when it ends. Call it once for a `start` event with the event's switches, or when the analyst asks for a new orientation, which adds to the cards the earlier ones left, and `message_orientation` to explore further within one that has finished. One orientation runs at a time, so while one runs the call starts nothing.

```json
{
  "type": "object",
  "properties": {
    "brief": {"type": "string", "description": "The analyst's request in their words, such as a focus, or empty for the whole corpus."},
    "final_notebook": {"type": "boolean", "description": "Leave a deck of cards for the analyst, the group `Orientation`, which appears when the orientation ends. Default true."},
    "propose_views": {"type": "boolean", "description": "Propose views of the files. Default true."},
    "generate_report": {"type": "boolean", "description": "Write the report when the orientation ends. Default false."},
    "critique": {"type": "boolean", "description": "Have a critic review the analysis before the outputs are written. Default false."}
  }
}
```

## start_writing

Start a writer, in a Claude Code session of its own beside yours, which writes or revises one document from this conversation, the canvas and the documents. The browser shows its steps, and its last message reaches you as a `written` event when it ends. Call it for a `write` event or when the analyst asks for a document, and use `edit_document` yourself to change one passage, slide or layout of a written document.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, such as report, story or slides, the write event's `doc`."},
    "request": {"type": "string", "description": "What the analyst asked for, in their words, the write event's text. Empty for the document as its form asks."},
    "after": {"type": "string", "description": "The passage the request is about, the write event's `after`."},
    "type": {"type": "string", "description": "Only for a document that does not exist yet, which is then made: casefile (one document, a section per case, such as an agent, a run or a session), comparison (a page with a grid of the cases against measures), timeline (dated events in phases), page, or document, slides or story for one the request describes."},
    "name": {"type": "string", "description": "The new document's name in the browser, such as Case file."}
  },
  "required": ["doc"]
}
```

## critique

Have a critic review your whole analysis, from your transcript, and the cards and view proposals you drafted, for files and fields you never opened, rival accounts you did not test and claims no call supports. The critic runs in a Claude Code session of its own and changes nothing. The call returns its report when it ends.

```json
{
  "type": "object",
  "properties": {
    "context": {"type": "string", "description": "Your account of the corpus, the hypothesis and findings your drafts present, and what you could not read, in a few sentences."}
  }
}
```

## message_orientation

Send the orientation a message after it finished, such as a question its analysis did not answer, which continues its session with its whole analysis in context and revises its outputs where the answer changes them. A message sent while it runs waits until that run ends, and an `orient` event tells you when it ends. Call it when the analyst asks for more from the orientation, and `start_orientation` for a new one.

```json
{
  "type": "object",
  "properties": {
    "message": {"type": "string", "description": "What the analyst asks the orientation, in their words."}
  },
  "required": ["message"]
}
```

## run_check

Run a report check over the written documents, a question asked of every passage that leaves a comment beside each passage it applies to. A new name creates the check and a known one reruns it, and either way it is turned on and reruns when a document changes. For one note on one passage, use `add_comment`.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The check's name, such as Unverified, or a new one."},
    "instructions": {"type": "string", "description": "What to comment on, in the analyst's words. Needed for a new check, and it replaces the instructions of an existing one."},
    "passages": {"type": "array", "items": {"type": "string"}, "description": "Passages to check again, report:<doc>#<id>. Default every passage but the locked ones already checked."}
  },
  "required": ["name"]
}
```

## stop_check

Turn a report check off, as the switch in the Checks pane does, which hides its tints and comments and stops its runs. Its comments are kept, and `run_check` turns it on again.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The check's name, such as Unverified."}
  },
  "required": ["name"]
}
```

## file_dev_ticket

File a ticket for thimble's developer agent when thimble itself should change, such as a bug or a missing control, never for a question about the data.

```json
{
  "type": "object",
  "properties": {
    "title": {"type": "string"},
    "body": {"type": "string", "description": "What happened and what was expected, with the exact error text when there is one."},
    "urgent": {"type": "boolean"},
    "view": {"type": "string", "description": "The name of a view the dev agent built for this corpus, when the change is to that view."}
  },
  "required": ["title", "body"]
}
```

## instructions

These tools act on thimble, the workspace beside this session where the analyst reads a chat, the corpus's files, a canvas of cards and a report in the browser. A session started with the `thimble` command, and each thimble subagent, also has thimble's full instructions in its system prompt. If yours has none, this session was started some other way and the browser cannot reach it, so tell the analyst to quit and start it again by running `thimble` in this folder.

## card-errored

This card errored. Fix the code with `edit_card`.

## card-timeout

The code was stopped after {limit}. Make it faster and run it again with `edit_card`.

## kind-mismatch

card:{cid} is a `{kind}` card but its output is {shape}. Change the code or the `kind` with `edit_card`.

## chart-rows

[out{out}: a chart drawn from {rows} rows, each value cited as card:{cid}#<column>/<row> with the row named by its {label}]

## chart-rows-numbered

[out{out}: a chart drawn from {rows} rows, each value cited as card:{cid}#<column>/<row> with the row named by its position from 0]

## chart-no-rows

[out{out}: a chart whose values are not in its output. Print them in this card to cite them]

## edit_card-no-card

Name the card with `card`.

## edit_card-gone

card:{cid} does not exist.

## edit_card-data

card:{cid}, the {kind} card, has no code. Pass a new `{field}` or `question`, or add a card whose code computes what it shows.

## edit_card-kind

card:{cid} is of kind {kind} and cannot change to {new}. Add a new card instead.

## example-quote-missing

The quote "{quote}" is not in {ref}. Quote the record's words exactly, or cite the record without a quote.

## edit_card-check-kept

The card check had rewritten card:{cid}'s {field}, and your call gave back the {field} it replaced, so the check's {field} stays. Read the card, and pass a new {field} to change it.

## edit_card-check-merged

The card check had rewritten card:{cid}'s {field}, so your change was made to the check's {field}, which the card now shows.

## edit_card-takeaway-errored

The card errored, so the takeaway was not saved. Fix the code, then give the takeaway again.

## edit_card-after

`after` takes another card, card:<id>, or first, to place card:{cid} in a group.

## edit_card-after-group

card:{after} is not in the group this card can go to. Name a card of that group in `after`, or leave `group` out.

## frame-rows

[out{out}: the {rows} rows card:{cid} shows, formatted as it shows them, each value cited as card:{cid}#<column>/<row> with the row named by its {label}]

## frame-rows-numbered

[out{out}: the {rows} rows card:{cid} shows, formatted as it shows them, each value cited as card:{cid}#<column>/<row> with the row named by its position from 0]

## delete_card-deleted

Deleted card:{cid}, the card that asked: {question}

## delete_card-cited

card:{cid} is cited in {docs}, so it was kept. Take those citations out with `edit_document` first.

## card-locked

The analyst locked card:{cid}, so it stays as it is. Leave it, or add a new card.

## takeaway-missing

card:{cid} has no takeaway. Write it with `edit_card` and `takeaway`, one or two sentences answering its question from the output above.

## takeaway-stale

card:{cid} kept its takeaway, written before this run changed its output. Write it again now with `edit_card` and `takeaway` from the output above, before any other call.

## takeaway-missing-shown

card:{cid} has no takeaway. Write it with `edit_card` and `takeaway`, one or two sentences answering its question from what the card shows.

## apply_label-rows

Count and cite from the rows in a card's code, since thimble's Python module is there and not in Bash. thimble.labels("{label}") is a DataFrame (path, line, effective, label, source, verdict, confidence, ref) of the units that got the first value, and thimble.labels("{label}", negatives=True) of every labeled unit.

## apply_label-unchanged

The label already held these values from the same predicate over the same units, so nothing ran again.

## apply_label-other-scope

{label} [[{ref}]] is already a label over {scope}. A label over {new} needs a name of its own.

## apply_label-takeaway-stale

The takeaway of its card card:{cid} was written for the run before; write it again with `edit_card` from these counts.

## apply_label-stale

{cards} read this label before it changed. Once its counts are final, thimble runs each of them again on the label as it is now, so leave them as they are.

## show_label-not-files

{label} is a label over {units}, which Files does not show. To show it, filter {where} by one of its values.

## set_filter-set

The {scope} filter is now {filter}.

## set_filter-kept

It keeps {kept} of the canvas's {total} cards, and the analyst sees the rest dimmed.

## set_filter-files

Files shows the label turned on with that value highlighted, and its views keep only the records that take the value, leaving whole the files the label never ran over.

## set_layout-set

The browser shows {surfaces} {layout}.

## open_view-card

Opened {card} as the {view} view in Files, with its labels on and its arguments choosing the records.

## open_view-view

Opened the {view} view in Files, with no card's arguments.

## clear_filter-cleared

The {scope} filter is cleared.

## list_cards-filter

The canvas filter {filter} keeps {kept} of the canvas's {total} cards. The analyst sees the cards tagged filtered out dimmed.

## takeaway-long

The takeaway runs to {words} words. Cut it to 40 at most with `edit_card` and `takeaway`.

## takeaway-uncited-example

The takeaway cites none of the records the card shows. Link the words of each claim to the record that shows them, as in `[[posted the answer|{ref}]]`, with `edit_card` and `takeaway`.

## card-installs

{tool}: this code installs software or downloads files, which card code may not do. Use what is already installed, or tell the analyst what the analysis needs and why.

## takeaway-reminder

card:{cid}, your last card, still has no takeaway. Write it with `edit_card` and `takeaway`.

## not-found-in-outputs

NOT found in this card's outputs, {values}. Cite each where the output shows it, or drop it.

## add_card-more

… {more}. `read_ref` on {ref} shows all of it.

## write_document-form

The {doc} has a form of its own, not markdown, so `write_document` cannot save it.

## write_document-locked

A change to {blocks} the analyst locked was reverted: {refs}. A locked block stays word for word as the analyst left it, so those changes are not in the document.

## edit_document-locked

The analyst locked {ref}, so it stays as it is. Leave it, or change the passages around it.

## read_ref-document

Each passage carries its id. Cite or edit a sentence or a heading as report:{slug}#<id> and a paragraph as report:{slug}#p<id>.

## read_ref-frame

The analyst's frame, the sections they want, the figures they pinned and the points to make. Write a cited passage for each point rather than copying it.

## read_ref-new

The analyst laid out no frame, so the shape is yours.

## screenshot-none

{what}, so screenshot cannot take it. `read_ref` on it reads what the analyst sees.

## screenshot-frames

The film of {ref}, {duration} s long, its lines at {windows} s.

## screenshot-frames-errors

The film reported: {errors}

## propose_view-proposed

Proposed the view {view} (view:{slug}) over {claims}. The dev agent is building it now, and it opens in Files when its checks pass.

## propose_view-suggested

Proposed the viewer {view} (view:{slug}) for {claims}. The File browser offers it beside Raw on those files, and it is built when the analyst picks it.

## propose_view-unmatched

No file of the corpus matches {claims}, so the view was not proposed and the dev agent has nothing to build. {near} Propose it again with claims that match files the corpus holds.

## propose_view-cap

{view} was not proposed: a workspace gets at most {n} views from the orientation, and it has had {views}, counting any the analyst deleted. To improve one, propose it again under its name.

## propose_view-deleted

{view} was not proposed: the analyst deleted it, so it is not proposed again.

## propose_view-near

The files nearest {claim} are {paths}.

## propose_view-cannot-build

Proposed the view {view} (view:{slug}), but views cannot be built on this machine, so its build failed at once: {why} Tell the analyst, since only they can install this.

## view-changing

The dev agent is changing the view {view} (view:{slug}) now. When its checks pass the view has the change, and when they fail it stays as it was.

## view-no-anchors

The page shows no element whose `data-anchor` names a record (its citation form, such as `<path>#L<n>` or `<db>#<table>/<key>`) or one of its units (`view:{slug}/<key>`), so no label the analyst turns on can show in it. Give each element that shows a record its file ref, and each unit's element its key.

## file_dev_ticket-no-view

No view is named {view}. The views are {views}. File the ticket again with one of them, or without `view` for a change to thimble itself.

## file_dev_ticket-cannot-run

Filed {label}, but it cannot run here, so it failed at once: {why} Tell the analyst, since only they can change this.

## view-media-unplayable

The browser that takes the checks' and the review's pictures cannot play H.264 video or AAC audio, which most MP4, MOV and M4A recordings hold. A player of such a file stays blank or shows an error in the pictures, though the analyst's browser usually plays it, so that is not a problem of the view. A player that stays blank on a WebM, Ogg, MP3 or FLAC file is one.

## view-purple

The page writes purple colours: {colours}. Purple is thimble's colour for agents' work, so if any of them colours a category of the view, such as a speaker or a kind of record, give that category a viz colour (`--viz-*`) instead.

## view-built

The dev agent built the view {view}, so {claims} now open in it. In it {forms}.

## view-no-forms

no citation resolves, because its `accepts` and `units` are empty

## view-no-screenshots

Screenshots are unavailable on this machine, so the checks did not load the page and took no pictures. Check the page by reading it and what the reader answers, and take no pictures any other way.

## view-few-anchors

The reader handed the page {fetched} records, but only {records} shown elements carry a record's citation form, such as `<path>#L<n>`, as their `data-anchor`, so the labels the analyst turns on show on almost nothing in it. Give each element that shows a record its file ref.

## view-marks-missing

In the {state} state, {missing} of the {due} shown records or units the test label marks do not show its mark. thimble draws a mark on the outermost visible element whose `data-anchor` names the record, but not on a canvas: draw records as HTML or SVG elements, or put the `data-anchor` on an element beside the canvas drawing.

## view-marks-unseen

In the {state} state, a picture of the page does not show the test label's colour on {unseen} of the {checked} marked records or units in view, such as {refs}. thimble draws a mark as a 3 px bar in the label's colour along the left edge of the outermost element whose `data-anchor` names the record, inside the element when its left padding is 6 px or more or when a box that hides overflow would cut a bar outside it, else just outside. The bar does not show when the page's CSS sets `box-shadow` on that element with `!important`, or when another element or a cell's background covers the element's left edge. An element with `data-anchor-unmarked` gets no bar, so the page must draw the label's colour on it itself, at full strength, such as a dot or a fill in the colour `thimble.markOf(ref).bar` gives, redrawn in `thimble.onMarks`.

## view-no-label-controls

The page draws no label controls: {why}. thimble draws none above a view, so the page lists the labels `thimble.onLabels` gives in `all`, each with its colours and a switch that calls `thimble.setLabel(id, on)` on the analyst's click, and shows each label that is on in view, such as in a legend, each such element carrying `data-label` with the label's id.

## view-labels-by-itself

The page made {made} by itself, on load, on a timer or from its own script: {calls}. thimble refuses a label change outside the analyst's own click or key press in the view, so call these only from a control's click or key handler.

## view-filter-unkept

Filtered to the test label, the page shows {records} records, and the filter keeps the line that anchors {unkept} of them. That is right for a record the page draws for several lines, one of which the label marks. Otherwise keep only the records for which `thimble.kept(ref)` holds in the reader's answers and fetch again in `thimble.onLabels`, or leave the filtering to thimble by registering no `onLabels`.

## view-missing

The claims expect files the corpus lacks, which the analyst sees above the view as missing: {files}.

## view-robust-reader

With {what}, the reader failed: {error}. A real corpus can lack a file or hold a line cut short, so read what is there, and report each line you cannot parse with problems().

## view-robust-torn

thimble added a line cut short at {ref}, and problems() does not report it. Report each line the reader cannot parse with problems(), so the analyst sees it above the view.

## view-robust-page

With {what}, the page failed: {errors}. One missing file or bad line must leave the rest of the view working.

## view-robust-empty

With {what}, the page shows no record, though over the whole corpus it shows records. One missing file or bad line must leave the rest of the view working.

## view-layout

The page {where}: {parts}.

## view-layout-overlap

text overlaps other text in {places}, such as {pairs}

## view-layout-cut

{n} run past a box that hides them without an ellipsis, such as {texts}

## view-layout-sideways

{n} scroll sideways, such as the one that starts {texts}

## view-layout-outside

{n} of the {of} records and units it draws are out of view until the analyst scrolls

## view-layout-overflow

it is {px} px wider than its pane, so it scrolls sideways

## view-layout-empty

its text and graphics span {used} of its {width} px, so the rest of the pane is empty

## view-not-shown

{count} claimed files are neither read to the end by build_index nor listed with a why by hidden(index): {files}. The analyst sees each one above the view as not shown. Read each file whole in build_index, with Python's `open()`, or return it from hidden(index) with its `path` and a `why` that says why the view leaves it out.

## view-not-claimed

{count} files sit in folders beside the ones the view claims and hold the same files, such as another run's: {files}. The analyst sees each one above the view as not read. If the view is for all of them, claim them and let the analyst choose among the folders.

## view-derived-unlisted

Fields of the records the reader answered hold values that the lines they cite do not, and they are not listed as derived: {fields}. The analyst counts on that list to tell what the files say from what the reader made of them. List each of these fields in view.json's `records` with its `type` and `"derived": "cleaned"`, or `"computed"` for a value the files do not state, and give it `from` and `how`, each a short plain phrase without semicolons, or return it from the reader's derived(index).

## check-unread

{n} of {total} files were opened by no card and no Read call, {files}.

## check-unused

In {file}, no card names the field `{field}`, filled in {filled} of {sampled} sampled records.

## check-unused-kind

In {file}, no card names `{value}`, a value of `{field}` in {count} of {sampled} sampled records.

## check-none

No check found anything.

## orient-coverage

Coverage: viewed only {viewed} · {shares}

## orient-coverage-every

Coverage: viewed every file · {shares}

## orient-coverage-nothing

Coverage: viewed no file · {shares}

## orient-coverage-shares

{files} of files · {share} of {measure}

## orient-coverage-files

{files} of files

## orient-coverage-lead

When your first run ended, thimble measured how much of the corpus it saw, from the lines and records its tool outputs showed (Read ranges, and lines or records that commands and cards printed), and showed the analyst this line in your thread.

{coverage}

## start_orientation-started

The orientation has started in its own session, and the browser shows it, so this turn needs no words from you unless it has something else for the analyst. An `orient` event tells you when it ends.

## start_orientation-running

An orientation runs already, so this call started none: one orientation runs at a time. The browser shows the one that runs, so write nothing about it, unless the analyst asked for a new orientation in this turn: then tell them in one line that one runs and that they can stop it in its thread first.

## start_writing-started

The writer of {doc} has started in its own session, and the browser shows it, so this turn needs no words from you unless it has something else for the analyst. Its last message reaches you as a `written` event.

## start_writing-running

A writer of {doc} is running already. Tell the analyst so in one line.

## start_writing-made

Made the new document {title}, report:{doc}.

## start_writing-no-doc

There is no document {doc}. The documents are {docs}. To make a new one, pass its `type`, one of {types}, and its `name`.

## run_check-started

check {check} started ({how}) on report:{doc}, {passages}

## run_check-no-doc

No document is written yet, so the check {check} has nothing to read. It is on, and it runs once a document is written.

## run_check-no-instructions

There is no check named {check}. Call `run_check` again with its `instructions` to create it. The checks are {names}.

## run_check-no-passage

None of {passages} is a passage of a written document. `read_ref` on a document gives each passage's id.

## add_comment-no-passage

{ref} is no passage of report:{doc}. `read_ref` on report:{doc} gives each passage's id.

## add_comment-uncovered

{ref} is not among the passages this run checks. Comment only on the passages your task lists.

## add_comment-not-check

Only the analyst's session and a check's own session comment with `add_comment`.

## add_comment-no-document

{ref} is no passage of a written document. A passage is report:<doc>#<id>, and `read_ref` on a document gives each passage's id. The written documents are {docs}.

## add_comment-added

commented on report:{doc}#{sid}, comment {comment}

## resolve_comment-done

{action} comment {comment} on {ref} · {who} · {text}

## resolve_comment-none

{comment} names no {state} comment. `read_ref` on a document lists its open comments, each with the id of the passage it is on.

## stop_check-stopped

check {check} turned off, its runs stopped on {docs}

## stop_check-off

check {check} turned off, with no run running

## stop_check-none

There is no check named {check}. The checks are {names}.

## check-document

The document, `{ref}`, with the id of every passage.

{document}

## check-instructions

The check {check}, which says what to comment on.

{prompt}

## check-passages

Comment only on these passages. The others were checked before and keep the comments the check left.

{passages}

## check-every-passage

Comment on any passage of the document.

## check-tags

The sentences the citation check tagged unverified, each with its note. Confirm each before you comment.

{tags}

## critique-task

Review the orientation's analysis and its drafts.

## critique-deck

Its drafted deck is the group `{deck}`, which `list_cards` lists.

## critique-proposals

The views it proposed, each with what it is for, the files it reads and its layout.

{proposals}

## critique-transcript

Its transcript, rendered as its steps, is `{path}`, which Read opens.

## critique-no-transcript

Its transcript was not found, so review its analysis from its cards.

## critique-context

What the orientation wrote about its analysis, in its words.

{context}

## critique-checks

What code found in the corpus and the cards.

{checks}

## critique-transcript-cut

[{n} more lines]

## critique-running

A critique of your analysis is running already. Wait for its report.

## critique-not-orientation

Only the orientation calls `critique`, which reviews its analysis and drafts before it finishes.

## critique-ended

The critique {status} before it returned its report, and it wrote this.

{text}

## writer-task

Write `report:{doc}`, the document named {title}.

## writer-request

The analyst asked for this, in their words.

{request}

## writer-after

Their request is about the passage `{after}`.

## context-no-conversation

The analyst's session has no conversation yet.

## context-no-cards

The canvas has no cards yet.

## context-cut

[{shown} of {total} characters shown. read_ref {ref} reads it whole.]

## context-cut-plain

[{shown} of {total} characters shown.]

## context-cut-oldest

[The {n} oldest entries are left out here, since the whole conversation is too long.]

## context-no-orientation

No orientation has run, or Claude Code no longer keeps its session.

## context-orientation-cut

[The thread is cut to fit, its oldest entries or its calls' results left out. read_ref {ref} reads it whole, a page at a time.]

## orient-start

Start the orientation.

## orient-no-request

The analyst asked for nothing in particular, so cover the whole corpus.

## orient-finished

The orientation has finished: {made}.

## orient-stopped

The orientation was stopped: {made}.

## orient-failed

The orientation failed: {made}. Its error: {error}

## orient-made-views

{views} proposed

## orient-views-built

{views} built

## orient-views-failed

{views} failed

## orient-views-building

{views} building

## orient-views-stopped

{views} stopped

## orient-views-suggested

{views} suggested for file types

## orient-made-nothing

no outputs, only its thread

## orient-follow-up

The analyst's side sent you this after you finished. Follow it up as `### Follow-ups` says.

{messages}

## orient-from-main

This message is from the analyst's own session.

## orient-from-analyst

This message is from the analyst, typed in your thread.

## orient-from-terminal

This message is from the analyst, typed in Claude Code's agent tray.

## orient-from-extension

The analyst switched on the extension {extension} and asked you to run its instructions for the orientation now. Follow them as far as the work you did allows.

## orient-followed-up

The orientation's follow-up has finished: {changed}.

## orient-follow-up-stopped

The orientation's follow-up was stopped: {changed}.

## orient-follow-up-failed

The orientation's follow-up failed: {changed}. Its error: {error}

## orient-changed-added

{cards} added

## orient-changed-revised

{cards} revised

## orient-changed-deleted

{cards} deleted

## orient-changed-views

{views} proposed

## orient-changed-nothing

nothing changed

## orient-report-revision

A follow-up of the orientation changed these cards, which the report cites: {cards}. Revise the passages that rest on them.

## message_orientation-started

The orientation has taken up the message in its session, and the browser shows it, so this turn needs no words from you unless it has something else for the analyst. An `orient` event tells you when it ends.

## message_orientation-queued

The orientation is running, so the message waits and goes to it when this run ends. The browser shows it waiting, so this turn needs no words from you unless it has something else for the analyst.

## message_orientation-none

No orientation has run in this workspace. Call `start_orientation` to start one.

## message_orientation-gone

Claude Code no longer keeps this orientation's session, so it cannot continue. Its outputs and call refs still open. Call `start_orientation` for a new orientation that takes up the message.

## message_orientation-precached

This orientation ran in advance, before this workspace was installed, and its session was not kept, so it cannot continue. Answer from its cards and the report yourself, or call `start_orientation` for a new orientation that takes up the message.

## precached-context

This workspace was installed from a pre-cache: its orientation ran in advance on these same files ({made}), and its Claude Code session was not kept, so `message_orientation` cannot reach it. What it left follows: the cards on the canvas, the views and the documents, with the full text of each one written. Take it as what the analyst sees in the browser; read a card, a view or a ref with `read_ref` before you rely on its details, and answer what its cards already answer yourself.

## precached-context-kept

This workspace was installed from a full export: its orientation ran in advance on these same files ({made}), and its Claude Code session came with it, so `message_orientation` continues it. What it left follows: the cards on the canvas, the views and the documents, with the full text of each one written. Take it as what the analyst sees in the browser; read a card, a view or a ref with `read_ref` before you rely on its details, and answer what its cards already answer yourself.

## bg-carry-on

Carry on with your task from where you left off.

## bg-from-terminal

From the analyst, typed in Claude Code's agent tray: {text}

Answer it in your own reply, which the analyst reads in your session, not with SendMessage.

## bg-from-main

From main: {text}

Answer it in your own reply, which main hears when you end.

## bg-proxy

You show {session}, one of thimble's agents, in the analyst's Claude Code agent tray. Every message that reaches you here, from the analyst or from main, is for {session}, and thimble passes it on. You write no words of your own and use no other tools. "{session}" is the agent's whole name, spaces and `·` included: write it exactly so wherever it goes.

Claude Code defers `wait_session`, so first load it with one ToolSearch call, query "select:mcp__plugin_thimble_thimble__wait_session". Then loop until `wait_session` tells you to end your turn:

1. Call `wait_session` with `session` "{session}". It returns as soon as there is news, or within a few seconds.
2. Copy the block of news lines it returns into one reply, exactly as it is, each line on its own line, without shortening, rewording, explaining or formatting them, or write nothing when it says nothing is new.
3. When a message reaches you, do not answer it or act on it: call `wait_session` at once, which passes it on.

Stop only when `wait_session` tells you to end your turn, never because of what a news line says, and then do as it says.

## bg-proxy-start

One of thimble's agents, {session}, runs for this workspace. Show it in the agent tray now with one call of the Agent tool, with `subagent_type` "{type}", `run_in_background` true, `description` "{session}" and `{prompt}` as the whole prompt, and end the turn on that call. The terminal shows the call, so write nothing before it or after it. The agent runs already and the tray entry follows it by itself, so start nothing else for it.

## bg-proxy-keep

Keep showing {session}: call `wait_session` with `session` "{session}" again, and stop only when it tells you to end your turn.

## wait_session-none

thimble follows no agent named {session}. Write one line saying so and end your turn.

## wait_session-main

Only a tray entry calls `wait_session`, and the tray entry you started shows the session already. End your turn, with no text.

## wait_session-duplicate

Another tray entry already shows {session}. Write nothing and end your turn now.

## wait_session-ended

{session} has ended. Write one line saying so and end your turn.

## wait_session-finished

{session} has finished its task. Write one line saying so and end your turn.

## wait_session-quiet

Nothing new; {session} is {state}. Call `wait_session` again.

## wait_session-copy

Write all the news lines above in one reply, exactly as they are, each on its own line, adding and changing nothing.

## wait_session-rule

A message that reaches you now is for {session}: do not answer it, call `wait_session`, which passes it on.

## agents-none

No agent of thimble's runs now.

## agents-help

↓ to follow any of them

## agents-print

Print the text below in a code block, as it is, and add nothing else.

{text}

## message_thread-event

The browser shows the message in the thread {thread}. Handle the thread's event now, as its bullet in your prompt says, and end the turn on that call, with no text after it: the terminal shows the call, and the thread shows the answer.

{event}

## message_thread-again

The analyst asks the thread {thread} its questions again. Handle the thread's event now, as its bullet in your prompt says, and end the turn on that call, with no text after it: the terminal shows the call, and the thread shows the answer.

{event}

## message_thread-queued

The message is in the thread {thread}, which waits for the fork you started for it and gets the message once that fork is known, so this turn needs no words from you.

## message_thread-view

The change is queued for the view's build in {thread}, which the browser shows, so this turn needs no words from you.

## message_thread-empty

{thread} takes no empty message. Pass what the analyst wrote as `message`.

## message_thread-main

{thread} takes no messages of its own: its composer sends them to you. Do what the message asks yourself.

## stop-subagent

The analyst pressed Stop on {title}, your subagent `{agent_id}`, in the browser. Stop it with TaskStop.

## message_orientation-empty

The message is empty. Pass what the analyst asks the orientation as `message`.

## session-retry

Your session stopped because Anthropic's API was at capacity, and it has now been resumed. Carry on with your task from where you stopped.

## session-unfinished

Your session ended while agents or workflows you started in the background were still running, and they stopped with it. It has now been resumed. Continue each stopped agent with SendMessage, or start again what cannot be continued, then wait for all their results and use them before you finish.

## session-mode-changed

The analyst changed your permission mode, so your session was paused and has now been resumed with all its work. The call you were making when it paused may have been interrupted before it ran, so make it again if you still need it. {stopped}Carry on with your task from where you stopped.

## session-mode-stopped

The agents that were running stopped with it: {agents}. Continue each with SendMessage to its id, which keeps what it has done, and run a stopped workflow again from its run with `resumeFromRunId`, then use their results as before.

## session-resumed

Your session ended before its task was done and has now been resumed with all its work. Make again any call that did not run, if you still need it. {stopped}Carry on with your task from where you stopped.

## session-model-fallback

A safety classifier stopped {model}'s responses in your session, so it has been resumed on {fallback} with all its work. Make again any call that did not run, if you still need it. {stopped}Carry on with your task from where you stopped.

## session-server-stopped

thimble's server stopped while this session ran, which ended it before its task was done.

## session-restarted

thimble's server restarted while your session ran, which stopped it, and it has now been resumed with all its work. Make again any call that did not run, if you still need it. {stopped}Carry on with your task from where you stopped.

## session-not-resumed

It could not be resumed: {why}

## session-scratch

Your own scratch folder is {folder}. Put the files you make for your own work there, such as a script or an intermediate result, rather than in $TMPDIR or /tmp, which the session's other agents share.

## work-budget

The session's work folder {folder} now holds {size}, more than {budget}. Delete the extracts and copies there that you no longer need, and read the corpus in place rather than copying it.

## session-mode-switching

This call did not run, because the analyst is switching your permission mode, which pauses your session. Once it has resumed, make this call again if you still need it.

## session-unproven

`{tool}` did not run: thimble could not confirm that this call came from the session it names. Stop here and tell the analyst, who can start this session again from thimble.

## call-ref

This call's ref is `{ref}`.

## digest-more

[{total} lines in all. read_ref {ref} reads the next page.]
