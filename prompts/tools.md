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

Add a card, with its question and its content in one call. {{if:browser}}thimble runs the code and returns `card:<id>` and the start of each output.{{end}}{{if:terminal}}thimble returns `card:<id>` and a command that runs the code. Run it with Bash, and it prints the start of each output.{{end}} Give its takeaway here, or with `edit_card` once you have read the output.

```json
{
  "type": "object",
  "properties": {
    "question": {"type": "string", "description": "The one question the card answers."},
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom", "plan"], "description": "table, code, diagram, plot and timeline run `code`, example shows `refs`, note `text`, custom `html`, plan `steps`. Default code."},
    "code": {"type": "string", "description": "Python run in the corpus root. A table ends in a DataFrame of a few short columns indexed by what names each row, a plot in thimble.chart(kind, df) after import thimble when a kind fits, else in an Altair or matplotlib chart, its colours left to thimble's theme, and after import thimble a diagram in thimble.diagram(nodes, edges), each edge a (source, target, label), and a timeline in thimble.timeline(events), each event a (time, label). thimble.chart takes the DataFrame's columns in the kind's order, named as the axes: bar (category, value[, group]), line (x, y[, series]), area (x, y[, series]), scatter (x, y[, group]), dots (x, row[, group]), box (value, group), histogram (value[, group]), density (value[, group]), ecdf (value[, group]), range (item, before, after[, group]) or heatmap (x, y, value), and label=<label> draws a label's values in its colors; interval=(lo, hi) on bar or dots names the columns of each value's low and high ends; panels=True draws each group in a panel of its own; fit=\"linear\" or \"smooth\" on scatter adds a trend line. thimble.chart(..., show=False) returns the chart as an Altair chart to layer your own marks on, such as a few events called out above a daily bar chart, colored with thimble.theme.accent, .ink, .muted, .pale or .series[i]. Name nodes, edges and events in a few words, their numbers computed, as in f\"revisions.jsonl: {len(R):,} saves\"; an edge label over 36 characters becomes a numbered note under the diagram. In matplotlib, colour a label's values with thimble.colours(label, values), a {value: colour} dict. A plot can also be a card type's graphic, thimble.card(type, labels=[...], **args), from the card types under Cards."},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"} } } ] }, "description": "The records an example card shows, usually about three, adding one only when it shows something the others don't. Each is a ref, a moment of a video as <path>#t=<m:ss>, or {ref, quote} to highlight one passage of a long record, quoted exactly."},
    "text": {"type": "string", "description": "The markdown a note card shows."},
    "html": {"type": "string", "description": "The page a custom card shows, for what no other kind can show. Scripts run, the network does not. A chart in it takes thimble's chart style from CSS variables: `--viz-1` to `--viz-7` for series in order, `--viz-seq-1` to `--viz-seq-5` for an amount, `--viz-other` for the rest, `--viz-font` and `--viz-size`. Scripts also have thimble.colors.series, thimble.colors.seq and thimble.vegaConfig, the config of thimble's own Vega-Lite charts."},
    "libs": {"type": "array", "items": {"type": "string"}, "description": "The libraries a custom card's scripts use, loaded before its html: vega, vega-lite and vega-embed, or an npm package as name@version. If a package is not installed, the result gives the command that installs it."},
    "steps": {"type": "array", "items": {"type": "object", "properties": {"text": {"type": "string"}, "makes": {"type": "array", "items": {"type": "string"} }, "status": {"type": "string", "enum": ["not started", "running", "done", "needs you"]}, "note": {"type": "string", "description": "What happened in the step, in a line or two."}, "runs": {"type": "array", "items": {"type": "string"}, "description": "The description of each Agent call that runs the step, as you pass it to Agent. The card shows each one live."}, "details": {"type": "string", "description": "More about the step, such as how it works, which the analyst opens under it."} }, "required": ["text"] }, "description": "A plan card's steps in order, each one short line of what it does and the files or results it makes. A plan covers one phase, such as building and piloting, and its question names it, as in \"Plan: build the environment and pilot it\". A plan has no takeaway."},
    "follows": {"type": "string", "description": "For a plan of the next phase, card:<id> of the plan it follows."},
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
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom", "plan"]},
    "code": {"type": "string"},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"} } } ] } },
    "text": {"type": "string"},
    "html": {"type": "string"},
    "steps": {"type": "array", "items": {"type": "object", "properties": {"text": {"type": "string"}, "makes": {"type": "array", "items": {"type": "string"} }, "status": {"type": "string", "enum": ["not started", "running", "done", "needs you"]}, "note": {"type": "string", "description": "What happened in the step, in a line or two."}, "runs": {"type": "array", "items": {"type": "string"}, "description": "The description of each Agent call that runs the step, as you pass it to Agent. The card shows each one live."}, "details": {"type": "string", "description": "More about the step, such as how it works, which the analyst opens under it."} }, "required": ["text"] }, "description": "A plan's steps in order. They replace its steps, so you can change a step's status, note, runs or details at any time."},
    "libs": {"type": "array", "items": {"type": "string"} },
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

Define a category, apply it to every unit of a scope, and get the counts per value and a card where the analyst checks each unit. In files, a unit is a record, a whole file or a run directory (`unit`). A prompt label over many files takes minutes.

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
        "kind": {"type": "string", "enum": ["prompt", "regex", "code"], "description": "A model judges each unit, a regex matches its text, or code defines label(unit) returning (value, confidence), where a unit is a JSONL record as its dict, a text line or a sentence a dict with its words in unit['text'], a row of a database or a CSV file a dict of its columns, a record of a JSON document its value, a PDF page a dict with its page and text, a card a dict with its text, kind, question, takeaway, group and groups, the titles of the frames around it, a whole file a dict with its path, records and data, the whole file parsed or its text, and a run a dict with its paths, records and files, each file whole by its path. A record that saves a whole document again, such as a wiki page's revision, is read by a model or a regex as what it changed from the save before, and by code whole."},
        "text": {"type": "string", "description": "The description, pattern or function."}
      },
      "required": ["kind", "text"]
    },
    "values": {"type": "array", "items": {"type": "string"}, "description": "Positive first. Default yes and no."},
    "paths": {"type": "array", "items": {"type": "string"}, "description": "Globs, for files. A record of a file is a line of text, a row of a database's table, a page of a PDF, a value of a JSON document or a row of a CSV file. A glob followed by a record's place, such as `runs/*/forge.db#prs` for a table or `results.json#/runs`, keeps the records there."},
    "unit": {"type": "string", "enum": ["records", "files", "runs"], "description": "For files: records, the default, files for one value per file, or runs for one value per run directory. A label keeps its unit when you apply it again without one. A prompt label reads as much of each file or run as fits its model's context, and the result says how many it read only in part."},
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
    "colours": {"type": "object", "additionalProperties": {"type": "string", "enum": ["blue", "orange", "green", "sky blue", "olive", "teal", "brown", "navy", "grass green", "cerulean", "chestnut", "cyan", "red", "dark red", "purple", "dark purple", "pink", "dark pink"]}, "description": "A colour for each value named, which every card, view and Files show. A value that had the colour takes the one the other leaves."}
  },
  "required": ["name"]
}
```

## delete_label

Delete a label, with its marks, its card and any filter that uses it. A run of the label stops first. Use it only when the analyst asks for it.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The label's name or id."}
  },
  "required": ["name"]
}
```

## set_filter

Filter the cards, the records in Files or the report's sentences by a value of a label that exists, and the cards also by their kind, group, maker, card check, star, lock or words. It makes no label and no card. The parts you give replace those parts of the scope's filter, and the others stay.

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

{{if:browser}}Lay out the browser's main area, right of the chat, as panes that each show one surface: `files`, `canvas`, `report`, or a view on its own as `view:<slug>`. Call it when the analyst asks to see surfaces together, such as the files beside the report. The analyst can also drag the panes into place.{{end}}{{if:terminal}}Open thimble's panel in the terminal on surfaces, each in a pane: `files`, `canvas` for the cards, `report`, or a view on its own as `view:<slug>`. Call it when the analyst asks to see surfaces together, such as the files beside the report.{{end}}

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

Propose a view, a page that shows records in a form their files hide, or a viewer for one unusual file type. thimble's dev agent builds it from these fields alone, so name the fields, keys and counts it needs. When main proposes one, the result is the exact Agent call that starts its build as a subagent of main, which main then makes; an orientation's proposals are built without a call of its own. Pass a model or an effort only when the analyst names one, so that the build otherwise runs on the dev agent's values in thimble's Settings.

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
    "details": {"type": "string", "description": "What details might you want on demand?"},
    "model": {"type": "string", "description": "The model to build it on, such as opus, sonnet or a full model id, only when the analyst names one. Default: the dev agent's model in Settings."},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "The effort to build it at, only when the analyst names one. Default: the dev agent's effort in Settings."}
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

Comment on one sentence, paragraph or heading of a written document, or on a card or a step of a plan, a note the analyst reads beside it. The analyst sees `text` first and opens `details` when they want more. In a check's session, comment only on what you are checking.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "report:<doc>#<id> of a sentence or a heading, report:<doc>#p<id> of a paragraph, card:<id> of a card, card:<id>#step-<n> of a plan's step."},
    "text": {"type": "string", "description": "The statement: one short, clear sentence of about 20 words."},
    "details": {"type": "string", "description": "The evidence for the statement, with its citations, in plain sentences or a few bullets of about 120 words at most."}
  },
  "required": ["ref", "text"]
}
```

## resolve_comment

Resolve a comment on a document or a card, as the analyst's ✓ beside it does, or open a resolved one again.

```json
{
  "type": "object",
  "properties": {
    "comment": {"type": "string", "description": "The comment's id, as add_comment's result names it, or report:<doc>#<id> of a passage or card:<id> of a card, which resolves every open comment on it."},
    "how": {"type": "string", "enum": ["done", "known"], "description": "known when the analyst says they know it, as Know it does, so the check does not raise it again. Default done."},
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

Send a message the analyst typed in this terminal to a thread, as that thread's own composer sends it: a side thread's follow-up, or with no message its unanswered questions asked again, whose `thread` event, with the thread's anchor, comes back in the result for you to handle at once; a follow-up for the orientation; or a change to a view for the view's build thread. thimble shows the message in that thread. Call it for /thimble:ask.

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

## list_agents

List thimble's agents, the subagents of this session that thimble started, with what each is doing and its thread. Claude Code's agent tray lists the same subagents. Call it for /thimble:agents.

```json
{
  "type": "object",
  "properties": {}
}
```

## rename_thread

Rename a thread in thimble's thread list, when the analyst asks you to.

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

{{if:browser}}Get a picture of what the analyst sees in the browser, such as a card as thimble draws it.{{end}}{{if:terminal}}Get a picture of a card as thimble draws it. In terminal mode it takes no other picture.{{end}} It is slow, so use it only when the look matters, such as when the analyst asks you to fix how something appears.

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

Start an orientation, a broad analysis of the corpus that helps the analyst understand it, as a subagent of this session, which shows the analyst when it finishes the outputs its switches turn on. thimble shows it as a thread, Claude Code's agent tray shows it as a row, and an `orient` event tells you when it ends. Call it when the analyst asks for a new orientation, which adds to the cards the earlier ones left, and `message_orientation` to explore further within one that has finished. A question about the corpus, even a broad one, is no request for an orientation: answer it yourself, and after your answer you can ask whether they want one. Its result is the exact Agent call that starts the orientation, which you then make. Pass only the model, effort and switches the analyst named, so that the others take the values thimble's Settings give them. One orientation runs at a time, so while one runs the call starts nothing.

```json
{
  "type": "object",
  "properties": {
    "brief": {"type": "string", "description": "The analyst's request in their words, such as a focus, or empty for the whole corpus."},
    "final_notebook": {"type": "boolean", "description": "Leave a deck of cards for the analyst, the group `Orientation`, which appears when the orientation ends. Left out, Settings decide. Default true."},
    "propose_views": {"type": "boolean", "description": "Propose views of the files. Left out, Settings decide. Default true."},
    "generate_report": {"type": "boolean", "description": "Write the report when the orientation ends. Left out, Settings decide. Default false."},
    "critique": {"type": "boolean", "description": "Have a critic review the analysis before the outputs are written. Left out, Settings decide. Default false."},
    "model": {"type": "string", "description": "The model to run it on, such as opus, sonnet or a full model id, only when the analyst names one. Default: the orientation's model in Settings."},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "The effort to run it at, only when the analyst names one. Default: the orientation's effort in Settings."}
  }
}
```

## start_writing

Start a writer, as a subagent of this session, which writes or revises one document from this conversation, the cards and the documents. thimble shows its steps, and its last message reaches you as a `written` event when it ends. Its result is the exact Agent call that starts the writer, which you then make. Call it when the analyst asks for a document or for a change to one, and use `edit_document` yourself to change one passage, slide or layout of a written document. Pass a model or an effort only when the analyst names one, so that the writer otherwise runs on the values thimble's Settings give it.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, such as report, story or slides, or a `card` event's `doc`."},
    "request": {"type": "string", "description": "What the analyst asked for, in their words. Empty for the document as its form asks."},
    "after": {"type": "string", "description": "The passage the request is about, such as a `card` event's `after`."},
    "type": {"type": "string", "description": "Only for a document that does not exist yet, which is then made: casefile (one document, a section per case, such as an agent, a run or a session), comparison (a page with a grid of the cases against measures), timeline (dated events in phases), page, or document, slides or story for one the request describes."},
    "name": {"type": "string", "description": "The new document's name in thimble, such as Case file."},
    "model": {"type": "string", "description": "The model to run the writer on, such as opus, sonnet or a full model id, only when the analyst names one. Default: the writer's model in Settings."},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "The effort to run the writer at, only when the analyst names one. Default: the writer's effort in Settings."}
  },
  "required": ["doc"]
}
```

## critique

Have a critic review your whole analysis, from your transcript, and the cards and view proposals you drafted, for files and fields you never opened, rival accounts you did not test and claims no call supports. The call returns the Agent call that starts the critic as your subagent, which you then make. The critic changes nothing, and its report reaches you as a message when it ends.

```json
{
  "type": "object",
  "properties": {
    "context": {"type": "string", "description": "Your account of the corpus, the hypothesis and findings your drafts present, and what you could not read, in a few sentences."}
  }
}
```

## message_orientation

Send the orientation a message, such as a question its analysis did not answer, which continues it with its whole analysis in context and revises its outputs where the answer changes them. Its result is the exact SendMessage call that passes the message on, which you then make. A message sent while it runs reaches it after its current step, and an `orient` event tells you when it ends. Call it when the analyst asks for more from the orientation, and `start_orientation` for a new one.

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

Run a report check over the written documents or the cards, a question asked of every passage that leaves a comment beside each passage it applies to. A new name creates the check and a known one reruns it, and either way it is turned on. It runs again by itself after a writer saves a document, and after the analyst's own edits it shows the passages that changed until they run it. Its result is the exact Agent call that starts the check as a subagent of this session, which you then make. For one note on one passage, use `add_comment`.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The check's name, such as Unverified, or a new one."},
    "instructions": {"type": "string", "description": "What to comment on, in the analyst's words. Needed for a new check, and it replaces the instructions of an existing one."},
    "passages": {"type": "array", "items": {"type": "string"}, "description": "Passages to check again, report:<doc>#<id>. Default every passage but the locked ones already checked."},
    "on": {"type": "string", "enum": ["documents", "cards"], "description": "Run it on the documents or on the cards alone. A new check then covers that alone. Default what the check covers."}
  },
  "required": ["name"]
}
```

## stop_check

Turn a report check off, {{if:browser}}as the switch in the Comments pane does, {{end}}which hides its {{if:browser}}tints and {{end}}comments and stops its runs. Its comments are kept, and `run_check` turns it on again.{{if:terminal}} The terminal has no switch for a check, so the analyst asks you to turn one on or off.{{end}}

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

## view_check

Check the view you build or review, as often as you want: the checks thimble runs on every view, which say what failed and what they noted. Pass as `locators` the refs that sampling may miss, such as a key of each unit the view gives, and `picture` to get {{if:browser}}a picture of the page as it opens, whose path Read opens{{end}}{{if:terminal}}the view as it opens, drawn as text as the panel shows it{{end}}.

```json
{
  "type": "object",
  "properties": {
    "locators": {"type": "array", "items": {"type": "string"}, "description": "Refs to check beside the sampled lines, such as `<path>#L<n>` or `view:<slug>/<key>`."},
    "picture": {"type": "boolean", "description": "{{if:browser}}Also take a picture of the page as it opens, 1048 px wide with no label on.{{end}}{{if:terminal}}Also draw the view as text as it opens, 120 columns wide with no label on.{{end}}"}
  }
}
```

## finish_view

Finish the view you build: thimble runs the checks as the record of your build. When they pass, the view reaches the analyst. When they fail, the result says what failed and which attempt it was.

```json
{
  "type": "object",
  "properties": {}
}
```

## view_pictures

Take pictures of the view you review, whose paths Read opens. The first call of a round gives the view as it opens; ask for other states in `states`, up to three more in each round.

```json
{
  "type": "object",
  "properties": {
    "states": {
      "type": "array",
      "maxItems": 3,
      "description": "States to see beside the overview: `control`, the view as it opens after clicking `controls` in turn, each named by its text as the list of controls gives it, or by an option of a select; `labels`, the view as it opens with a test label on that marks about one record in seven in the colour the analyst's first label takes; `filtered`, the same filtered to the test label, which should keep only what it marks; `detail`, the place the first citation opens; `open`, the place a citation of `ref` opens, a record `<path>#L<n>` or a unit from the records; `narrow`, the view as it opens 798 px wide; `wide`, the view as it opens 1528 px wide.",
      "items": {
        "type": "object",
        "properties": {
          "state": {"type": "string", "enum": ["control", "labels", "filtered", "detail", "open", "narrow", "wide"]},
          "controls": {"type": "array", "maxItems": 3, "items": {"type": "string"}, "description": "For `control`: the controls to click in turn, by their text."},
          "ref": {"type": "string", "description": "For `open`: the ref whose place to see."},
          "why": {"type": "string", "description": "What you want to check in it, in a few words."}
        },
        "required": ["state", "why"]
      }
    }
  }
}
```

## view_pictures@terminal

Draw the view you review as text, as thimble's panel shows it. The first call of a round gives the view as it opens, 120 columns wide; ask for other states in `states`, up to three more in each round.

```json
{
  "type": "object",
  "properties": {
    "states": {
      "type": "array",
      "maxItems": 3,
      "description": "States to see beside the overview: `control`, the view after the keys in `controls`, pressed in turn; `detail`, the place the first citation opens; `open`, the place a citation of `ref` opens, a record `<path>#L<n>` or a unit from the records; `wide`, the view as it opens 200 columns wide.",
      "items": {
        "type": "object",
        "properties": {
          "state": {"type": "string", "enum": ["control", "detail", "open", "wide"]},
          "controls": {"type": "array", "maxItems": 8, "items": {"type": "string"}, "description": "For `control`: the keys to press in turn, such as `down`, `return` or `c`, or `click:<words>` for a click on the control that shows those words."},
          "ref": {"type": "string", "description": "For `open`: the ref whose place to see."},
          "why": {"type": "string", "description": "What you want to check in it, in a few words."}
        },
        "required": ["state", "why"]
      }
    }
  }
}
```

## finish_review

End a round of your review: thimble runs the view's checks on what you changed. Pass what you revised and what you leave, each as a short phrase; with nothing changed, the review is done.

```json
{
  "type": "object",
  "properties": {
    "revised": {"type": "array", "items": {"type": "string"}, "description": "What you revised in this round, one short phrase each."},
    "left": {"type": "array", "items": {"type": "string"}, "description": "The problems you leave as they are, one short phrase each, with why when the data shows the view is right."}
  }
}
```

## ticket_checks

Check the change in your ticket's worktree, as often as you want: thimble's checks run over what the worktree changed, in a sandbox of the server's, and say what failed. Nothing is committed.

```json
{
  "type": "object",
  "properties": {}
}
```

## finish_ticket

Finish your ticket: thimble commits every change in the worktree to the ticket's branch and runs the checks as the record of your work. When they pass, thimble asks the analyst whether to apply the change. When they fail, the result says what failed and which attempt it was.

```json
{
  "type": "object",
  "properties": {}
}
```

## instructions

These tools act on thimble, the analyst's workspace for this corpus beside this session: a chat, the corpus's files, cards and a report, which thimble shows {{if:browser}}in the browser{{end}}{{if:terminal}}in the terminal{{end}}. A session started with the `thimble` command, and each thimble subagent, also has thimble's full instructions in its system prompt. If yours has none, this session was started some other way and thimble cannot reach it, so tell the analyst to quit and start it again by running `thimble` in this folder.

## card-errored

This card errored. Fix the code with `edit_card`.

## card-timeout

The code was stopped after {limit}. Make it faster and run it again with `edit_card`.

## card-run

The card's code did not run yet. Run this command with Bash next: `{command}`. It runs the code and prints the card's result with the start of each output. thimble shows the card when its code has run.

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

## edit_card-same-outputs

The new code ran and gave the same outputs as before the edit, so this edit changed nothing that card:{cid} shows.

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

## label-run

The label's code did not run yet. Run this command with Bash next: `{command}`. It runs your function on each unit and prints the label's result with its counts.

## cards-stale

{cards} read this label before it changed, so their outputs are old. When the label's counts are final, run them again with Bash: `{command}`. It prints each card whose takeaway the new output leaves behind, or that fails, with that output. Write each of those takeaways again with `edit_card`, and fix each card that fails.

## show_label-not-files

{label} is a label over {units}, which Files does not show. To show it, filter {where} by one of its values.

## set_filter-set

The {scope} filter is now {filter}.

## set_filter-kept

It keeps {kept} of the {total} cards, and the analyst sees the rest dimmed.

## set_filter-files

Files shows the label turned on with that value highlighted, and its views keep only the records that take the value, leaving whole the files the label never ran over.

## set_layout-set

thimble shows {surfaces} {layout}.

## open_view-card

Opened {card} as the {view} view in Files, with its labels on and its arguments choosing the records.

## open_view-view

Opened the {view} view in Files, with no card's arguments.

## clear_filter-cleared

The {scope} filter is cleared.

## list_cards-filter

The card filter {filter} keeps {kept} of the {total} cards. The analyst sees the cards tagged filtered out dimmed.

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

## screenshot-terminal

screenshot cannot take this picture in terminal mode. There it draws only a card, and only when Chromium and thimble's built page are installed, which `thimble doctor` shows. `read_ref` on the card reads what the analyst sees.

## propose_view-proposed

Proposed the view {view} (view:{slug}) over {claims}. The dev agent is building it now, and it opens in {{if:browser}}Files{{end}}{{if:terminal}}thimble's panel in the terminal{{end}} when its checks pass.

## propose_view-suggested

Proposed the viewer {view} (view:{slug}) for {claims}. Files offers it beside Raw on those files, and it is built when the analyst picks it.

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

## file_dev_ticket-waits

Filed {label}. {running} runs now, and code tickets run one at a time, so this one waits until the analyst starts it with Start on its card{{if:browser}} in the browser{{end}}. Tell the analyst in one line.

## file_dev_ticket-start

Filed {label}: {title}. {start}

## ticket-terminal

This call filed nothing: code tickets run only in browser mode for now, since the analyst allows each one on its card there. Tell the analyst so in one line: to file it, they quit, run `thimble mode browser`, start `thimble` again and ask again.

## view-media-unplayable

The browser that takes the checks' and the review's pictures cannot play H.264 video or AAC audio, which most MP4, MOV and M4A recordings hold. A player of such a file stays blank or shows an error in the pictures, though the analyst's browser usually plays it, so that is not a problem of the view. A player that stays blank on a WebM, Ogg, MP3 or FLAC file is one.

## view-purple

The page writes purple colours: {colours}. Purple is thimble's colour for agents' work, so if any of them colours a category of the view, such as a speaker or a kind of record, give that category a viz colour (`--viz-*`) instead.

## view-own-parts

The page's styles change how thimble's parts look, or draw chips of their own: {found}. A view looks like the rest of thimble only when it uses thimble's parts as the frame styles them: `chip` (with `chip-sans`, `chip-tone-neutral`, `chip-tone-evidence`, `chip-act`, and `chip-key` with a `chip-sw` swatch for a value with its colour), `btn`, `seg` with `seg-opt`, and `field`. Set their width, margins, padding and place, but not their edges, fills, corners, colours, type or height. Give no chip, tag or small button corners rounder than `var(--radius-chip)`.

## view-built

The dev agent built the view {view}, so {claims} now open in it. In it {forms}.

## finish-view-pass

The checks passed, and the view is built: the analyst sees it now. Change nothing more, and end with one line saying what you built.

## finish-view-fail

The checks failed, attempt {n} of {of}:

{report}

Fix what failed, check the view again with `view_check`, then call `finish_view` again.

## finish-view-stop

No attempt is left, so stop now. Change nothing more, and end with one line saying what still fails; thimble shows the failure to the analyst or starts a new build from it.

## finish-ticket-pass

The checks passed, and the change is committed to the ticket's branch: thimble asks the analyst whether to apply it. Change nothing more, and end with one line saying what you changed.

## finish-ticket-fail

The checks failed, attempt {n} of {of}:

{report}

Fix what failed, check again with `ticket_checks`, then call `finish_ticket` again.

## finish-ticket-stop

No attempt is left, so stop now. Change nothing more, and end with one line saying what still fails; thimble shows the failure to the analyst.

## finish-ticket-empty

The worktree holds no change, so there is nothing to check. Make the change first. When the ticket cannot be done safely, end without `finish_ticket` and say why.

## ticket-checks-empty

The worktree holds no change yet, so there is nothing to check.

## finish-review-again

The checks passed, and the view as you revised it is what the analyst sees now. Take the pictures again with `view_pictures` and look once more, then call `finish_review`.

## finish-review-done

The checks passed, and the review is done. Change nothing more, and end with one line saying what you revised and what you left.

## finish-review-restored

The checks failed on your revision, so the view is as it was before your change. Change nothing more, and end with one line saying what you tried.

## view-pictures

The pictures, which Read opens:

{paths}

The records they show:

{records}

## view-pictures@terminal

The pictures, each the view drawn as text as the panel shows it:

{paths}

The records they show:

{records}

## view-review-program

{extension}'s program reviews views in this workspace in place of your own reading of the pictures. It read these pictures and found these problems:

{problems}

Fix these problems, and only these. When it found none, call `finish_review` with nothing revised.

## view-review-program-failed

{extension}'s program reviews views in this workspace in place of your own reading of the pictures, and it failed: {why}. Change nothing, and end with one line that says so.

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

## view-choice-error

{count} choices of the view's controls gave a script error when chosen: {choices}. Every choice the analyst can make must draw the view, None and Off among them: guard what the page reads of a choice that can be null (`rows.by`, `colour.by`, `filter.by`), and draw the records in one group, or uncolored, for it.

## view-term-error

The view's program failed {where}: {what}. It must draw the view with no error, also when a fetch fails or a file is missing.

## view-term-timeout

The view's program did not end its draw {where} within {s} s: {what}. Draw when an answer or an event comes, and do not draw on a timer.

## view-term-overflow

The view's program draws past the panel {where}: {what}. The panel cuts a row at its right edge and drops the rows below its last row. Fit each row in `d.cols` and the rows in `d.left`, with `cut`, `columns` and the list.

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

## start_orientation-unasked

No Start and no message from the analyst has asked for an orientation since the last one ended, so this call started none. Start one only when the analyst asks for it, and write nothing about this call.

## start_orientation-running

An orientation runs already, so this call started none: one orientation runs at a time. thimble shows the one that runs, so write nothing about it, unless the analyst asked for a new orientation in this turn: then tell them in one line that one runs and that they can stop it in its thread first.

## start_orientation-subagent

Start the orientation now as a subagent of this session, with one Agent call whose input is exactly this:

{input}

Change nothing in it, since thimble lets only this call through. Write no words about the call, since the analyst sees it. End the turn on it, unless the analyst also asked a question in this turn: then answer that question yourself after the call, while the orientation runs.

## start_orientation-program

The extension {extension} runs the orientation with its own program. The program has started, and thimble shows it, so this turn needs no words from you unless it has something else for the analyst. An `orient` event tells you when it ends.

## start_job-subagent

Start it now as a subagent of this session, with one Agent call whose input is exactly this:

{input}

Change nothing in it, since thimble lets only this call through, and end the turn on it, with no words before or after it: the analyst sees the call.

## subagent-request

[thimble request {request_id}]

## agent-check-exact

thimble starts its agents, and passes messages on to them, only with the call its tool gave: make the call again exactly as the result of start_orientation, start_writing, propose_view, run_check or message_orientation gave it, with nothing changed, or make none if the analyst did not ask for it.

## agent-check-message

thimble's agents continue only when the analyst asks. If they asked, call message_orientation and send what it gives; otherwise ask them first.

## start-plan-mode

Your Claude Code session is in plan mode, where thimble's agents would have to ask you before every card and every edit, so none of them starts or takes a message there. Switch out of plan mode first (shift+tab in your terminal).

## start-refused-not-launched

This session was not started with `thimble`, so it and its subagents run without thimble's sandbox and can change your files, and thimble's agents cannot start in it. Quit and run `thimble` in this folder.

## start_agent-fork

Filed {what}. Main is starting {agent}, and the analyst has nothing to do. Tell the analyst in one line in the thread that it is filed and main is starting {agent}.

## start_agent-event

The fork of {thread} filed {what}. A fork cannot start subagents, so start {agent} for it now as a subagent of this session, with one Agent call whose input is exactly this:

{input}

Change nothing in it, since thimble lets only this call through. The call needs no words before or after it: the analyst sees it, and the fork told them in the thread.

## ticket-from-thread

The analyst asked for this in the side thread {thread}, which they opened on this:
{anchor}

## start-refused-no-module

thimble's agents can't start in this session: Claude Code's hooks modules are off ({reason}). Main, its threads, cards and labels still work. Once modules are on, quit and run `thimble -c` in this folder.

## module-started-note

thimble: the analyst started thimble's {role} for {what} {how}, as your subagent {agent}. Its report goes to the analyst in thimble, so when it hands back, reply in one short line, and do nothing about it unless the analyst asks.

## module-started-note@terminal

thimble: the analyst started thimble's {role} for {what} {how}, as your subagent {agent}. When it hands back, reply as your prompt says for a hand-back, and do nothing more about it unless the analyst asks.

## follow-up-ran-on

This message ran on {model} · {effort}, the role's current settings.

## start_writing-running

A writer of {doc} is running already. Tell the analyst so in one line.

## start_writing-repeated

The writer of {doc} is running already, and thimble shows it, so this turn needs nothing more.

## agent-launched

{who} runs in the background, and the analyst sees it. End the turn now, with no words and no other call, unless the analyst asked for more in this turn. One short sentence is fine when it tells the analyst something thimble does not show. Do not make this call again.

## start_writing-subagent

Start the writer now as a subagent of this session, with one Agent call whose input is exactly this:

{input}

Change nothing in it, since thimble lets only this call through, and end the turn on it, with no words before or after it: the analyst sees the call.

## start_writing-program

An extension's program writes {doc}. The program has started, and thimble shows it, so this turn needs no words from you unless it has something else for the analyst. Its last message reaches you as a `written` event.

## writer-context-file

The workspace as it stands, each part under a heading that says what it holds, is in {path}. Read it whole before you write.

## start_writing-made

Made the new document {title}, report:{doc}.

## start_writing-no-doc

There is no document {doc}. The documents are {docs}. To make a new one, pass its `type`, one of {types}, and its `name`.

## run_check-started

check {check} started ({how}) on {doc}, {passages}

## run_check-no-doc

No document is written yet, so the check {check} has nothing to read. It is on, and it runs once a document is written.

## run_check-no-cards

The check {check} is on, and has no card to read yet.

## run_check-no-instructions

There is no check named {check}. Call `run_check` again with its `instructions` to create it. The checks are {names}.

## run_check-no-passage

None of {passages} is a passage of a written document. `read_ref` on a document gives each passage's id.

## check-task-file

Your task is in {path}: the check's instructions, the document with the id of every passage, the passages to comment on and what the workspace holds about them. Read it whole first.

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

## add_comment-no-card

{ref} is no card, or no step of a plan card. A card is card:<id>, and a plan's step card:<id>#step-<n>.

## check-canvas

The cards to comment on, each with its ref, kind and question, then its takeaway and a plan's steps. Comment on a card by its ref, or on one step of a plan by card:<id>#step-<n>. `read_ref` on a card gives its code and outputs. The analyst reads all of a card's comments beside it at once, so leave only the few that matter most on any one card.

{cards}

## check-known

The analyst said they know these. Do not raise them again.

{titles}

## check-replaces

When you finish, your comments replace the open comments this check left before on these passages, listed below. Leave again each one that still holds.

{comments}

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

## critique-subagent

Start the critic now as your subagent, with one Agent call whose input is exactly this:

{input}

Change nothing in it, since thimble lets only this call through. Then end your turn without calling SubagentHandback and without a report, since your run is not done: the critic works in the background, and its report reaches you as a message that starts your next turn. Follow up its report then, as your prompt says. If the call is refused or the critic fails, revise without its review and say so in your thread.

## critic-brief-file

Your brief is in {path}. Read it whole before anything else.

## critique-work-folder

Your own folder, where you may put a script or a scratch file, is {path}.

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

There are no cards yet.

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

## orient-subagent-prompt

[thimble request {request_id}]

The analyst's request: {request}

You should generate the following outputs (described in `### Outputs`): {outputs}
You should *not* generate the following outputs: {off}
Critique: {critique}

Start the orientation.

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

The orientation has the message, and thimble shows it, so this turn needs no words from you unless it has something else for the analyst. An `orient` event tells you when it ends.

## orient-subagent-message

Pass the message on now with one SendMessage call, with `to` "{agent}" and exactly the text below as `message`, and end the turn on that call, with no words before or after it. Change nothing in the text, since thimble lets only this message through. Claude Code defers SendMessage, so load it with ToolSearch first if you have not yet.

{text}

## orient-continue-earlier-session

This orientation ran in an earlier Claude Code session. To continue it, quit and run `{resume}` in this folder, or start a new orientation.

## orient-continue-earlier-version

This orientation ran in an earlier version of thimble and cannot be continued. Start a new orientation to explore further.

## orient-continue-stopped-by-user

This orientation was stopped with Esc in your terminal, and Claude Code does not continue an agent stopped that way. A message to it starts a new run in its thread that takes up its work.

## message_orientation-continues

The analyst stopped this orientation with Esc in their terminal, and Claude Code does not continue an agent stopped that way. So thimble continues it as a new orientation run in its thread, which gets the message and what the stopped run left. Start that run now with one Agent call whose input is exactly this:

{input}

Change nothing in it, since thimble lets only this call through, and end the turn on it, with no words before or after it: the analyst sees the call.

## orient-continuation-prompt

[thimble request {request_id}]

The analyst stopped the earlier run of this orientation with Esc in their terminal, and Claude Code does not continue a run stopped that way. You are a new run in its place, in the same thread. Take up its work from where it stopped, and do not do again what it did. What it left:

Its last text: {summary}

Its cards:
{cards}

Its transcript, which you can read for what it did and found:
{transcripts}

You should generate the following outputs (described in `### Outputs`): {outputs}
You should *not* generate the following outputs: {off}
Critique: {critique}

The analyst's message:

{message}

## orient-continuation-none

none

## message_orientation-none

No orientation has run in this workspace. Answer the analyst yourself, and call `start_orientation` only when they ask for an orientation.

## message_orientation-gone

Claude Code no longer keeps this orientation's transcript, so it cannot continue. Its outputs and call refs still open. Call `start_orientation` for a new orientation that takes up the message.

## message_orientation-precached

This orientation ran in advance, before this workspace was installed, and its session was not kept, so it cannot continue. Answer from its cards and the report yourself, or call `start_orientation` for a new orientation that takes up the message.

## precached-context

This workspace was installed from a pre-cache: its orientation ran in advance on these same files ({made}), and its Claude Code session was not kept, so `message_orientation` cannot reach it. What it left follows: the cards, the views and the documents, with the full text of each one written. Take it as what the analyst sees in thimble; read a card, a view or a ref with `read_ref` before you rely on its details, and answer what its cards already answer yourself.

## precached-context-kept

This workspace was installed from a full export: its orientation ran in advance on these same files ({made}), as a subagent of the exporter's Claude Code session, so `message_orientation` cannot reach it, though its thread shows every step it took. What it left follows: the cards, the views and the documents, with the full text of each one written. Take it as what the analyst sees in thimble; read a card, a view or a ref with `read_ref` before you rely on its details, and answer what its cards already answer yourself.

## thimble-terminal-home

thimble: this session runs in terminal mode, so thimble shows this workspace here in the terminal and starts no server. To switch to browser mode, quit, run `thimble mode browser` and start `thimble` again.

## agents-none

No agent of thimble's runs now.

## agents-print

Print the text below in a code block, as it is, and add nothing else.

{text}

## message_thread-event

thimble shows the message in the thread {thread}. Handle the thread's event now, as its bullet in your prompt says, and end the turn on that call, with no text after it: the terminal shows the call, and the thread shows the answer.

{event}

## message_thread-again

The analyst asks the thread {thread} its questions again. Handle the thread's event now, as its bullet in your prompt says, and end the turn on that call, with no text after it: the terminal shows the call, and the thread shows the answer.

{event}

## message_thread-queued

The message is in the thread {thread}, which waits for the fork you started for it and gets the message once that fork is known, so this turn needs no words from you.

## message_thread-empty

{thread} takes no empty message. Pass what the analyst wrote as `message`.

## message_thread-main

{thread} takes no messages of its own: its composer sends them to you. Do what the message asks yourself.

## stop-subagent

The analyst pressed Stop on {title}, your subagent `{agent_id}`, in thimble. Stop it with TaskStop.

## message_orientation-empty

The message is empty. Pass what the analyst asks the orientation as `message`.

## session-unfinished

Your session ended while agents or workflows you started in the background were still running, and they stopped with it. It has now been resumed. Continue each stopped agent with SendMessage, or start again what cannot be continued, then wait for all their results and use them before you finish.

## session-mode-changed

The analyst changed your permission mode, so your session was paused and has now been resumed with all its work. The call you were making when it paused may have been interrupted before it ran, so make it again if you still need it. {stopped}Carry on with your task from where you stopped.

## session-mode-stopped

The agents that were running stopped with it: {agents}. Continue each with SendMessage to its id, which keeps what it has done, and run a stopped workflow again from its run with `resumeFromRunId`, then use their results as before.

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
