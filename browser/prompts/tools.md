# Tools

This file holds the texts of thimble's tools. The server reads each `## ` section by its name.

The tools come first. Each tool's section holds its description, which a model reads to choose the tool, and under it the input schema.

The hints come last: the lines thimble adds to a tool's result in one situation. Each hint is named by its situation, for example `card-errored`. The server fills in each `{name}` in it.

## read_ref

Read anything thimble can cite, as the analyst sees it. The analyst may edit a card at any time, so read it again before you rely on it. Read a plain file with Read.

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

List a group's cards.

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

Add a card with its question and its content in one call. thimble runs the code and returns `card:<id>` and the start of each output. Give the card's takeaway here, or with `edit_card` after you read the output.

```json
{
  "type": "object",
  "properties": {
    "question": {"type": "string", "description": "The one question the card answers."},
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom"], "description": "table, code, diagram, plot and timeline run `code`. A code card shows the code itself, with what it prints under it. The other kinds show only what the code makes. example quotes `refs`, note shows `text`, and custom shows `html`. Default code. Use note for a few sentences that no other kind holds, code when the analyst asks for the code itself, and custom when none of these fit."},
    "code": {"type": "string", "description": "Python run in the corpus root. Call thimble's functions after import thimble. A table ends in a DataFrame of a few short columns, indexed by what names each row. A plot ends in thimble.chart(kind, df) when a kind fits. Otherwise it ends in an Altair or matplotlib chart. Leave its colors to thimble's theme. A diagram ends in thimble.diagram(nodes, edges), each edge a (source, target, label). A timeline ends in thimble.timeline(events), each event a (time, label). thimble.chart takes the DataFrame's columns in the kind's order, named as the axes: bar (category, value[, group]), line (x, y[, series]), area (x, y[, series]), scatter (x, y[, group]), dots (x, row[, group]), box (value, group), histogram (value[, group]), density (value[, group]), violin (value, group), ecdf (value[, group]), range (item, before, after[, group]) or heatmap (x, y, value). interval=(lo, hi) on bar, dots or line names the columns of each value's low and high ends. fit=\"linear\" or \"smooth\" on scatter adds a trend line. panels=True draws each group in a panel of its own, and label=<label> draws a label's values in its colors. thimble.chart(..., show=False) returns the chart as an Altair chart to layer your own marks on. Color them with thimble.theme.accent, .ink, .muted, .pale or .series[i]. Name nodes, edges and events in a few words, with their numbers computed, as in f\"revisions.jsonl: {len(R):,} saves\". An edge label over 36 characters becomes a numbered note under the diagram. In matplotlib, color a label's values with thimble.colors(label, values), a {value: color} dict."},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"} } } ] }, "description": "The records an example card quotes. Each item is a ref, a moment of a video as <path>#t=<m:ss>, or {ref, quote} to highlight a passage of a long record, quoted exactly. Give one item per passage."},
    "text": {"type": "string", "description": "The markdown a note card shows."},
    "html": {"type": "string", "description": "The page a custom card shows. It answers one question on one screen, about 690 px wide and 800 px tall in its card. The card shows its question above the page and its takeaway under it. So start the page with its content, and do not say the answer again. The page's frame has thimble's card stylesheet. The stylesheet gives thimble's type and the paper's colors to plain HTML. So write the page without colors, borders or fonts of your own. Scripts run, but the network does not. A chart in the page takes thimble's chart style from CSS variables: `--viz-1` to `--viz-7` for series in order, `--viz-seq-1` to `--viz-seq-5` for an amount, `--viz-other` for the rest, `--viz-font`, `--viz-size` and `--viz-bar-radius` for the corners at a bar's end. Scripts also have thimble.colors.series, thimble.colors.seq and thimble.vegaConfig, the config of thimble's own Vega-Lite charts."},
    "libs": {"type": "array", "items": {"type": "string"}, "description": "The libraries a custom card's scripts use, loaded before its html. Give vega, vega-lite and vega-embed by name, or an npm package as name@version."},
    "group": {"type": "string", "description": "The group of a sequence of cards that answer one question together, in order. Name the group by the question. A new title makes a group, and a group's title or id puts the card in it. Leave it out for a single card."},
    "takeaway": {"type": "string", "description": "The answer to the question in one or two sentences. Mark each claim the card shows as `[words](#)`, as in the chat. Put the whole quantity inside the mark: `[31 of the 40](#) runs`. thimble checks the takeaway against the card's output. The card shows less than your output. An example card shows only the opening of each record it cites, unless it quotes the passage. A wide table is cut at the card's right edge. A diagram or a timeline cuts or overlaps long labels. On an example card, link the words of each claim to the record that shows them, as in `[[posted the answer|runs/r3.jsonl#L88]]`. A rewritten takeaway keeps every link that is right. Write the card's own id as `card:<id>`, and thimble fills it in."}
  },
  "required": ["question"]
}
```

## edit_card

Change a card in place and run it again, instead of adding a second card. It takes the fields of `add_card` and `after`. A `takeaway` alone sets the card's answer without a run.

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
    "libs": {"type": "array", "items": {"type": "string"} },
    "group": {"type": "string", "description": "The group to move the card to, its title or id."},
    "after": {"type": "string", "description": "The card to place it right after, card:<id>, or first."},
    "takeaway": {"type": "string"}
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

Define a category and apply it to every unit of a scope. You get the counts per value, and a card where the analyst checks each unit. A prompt label over many files takes minutes. The label card answers a question like any card. So when its counts are final, write its takeaway: what the label found.

```json
{
  "type": "object",
  "properties": {
    "scope": {"type": "string", "enum": ["files", "report"], "description": "Records of files, or report sentences."},
    "name": {"type": "string"},
    "question": {"type": "string", "description": "The one question its card answers."},
    "predicate": {
      "type": "object",
      "properties": {
        "kind": {"type": "string", "enum": ["prompt", "regex", "code"], "description": "prompt: a model judges each unit. regex: a regex matches its text. code: your code defines label(unit), which returns (value, confidence). In label(unit), each unit takes this form. A JSONL record is its dict. A text line or a sentence is a dict with its words in unit['text']. A row of a database or a CSV file is a dict of its columns. A record of a JSON document is its value. A PDF page is a dict with its page and text. A whole file is a dict with its path, records and data (the whole file parsed, or its text). A run is a dict with its paths, records and files (each file whole, by its path). Some records save a whole document again, for example a wiki page's revision. A model or a regex reads such a record as what it changed from the save before. Code reads it whole."},
        "text": {"type": "string", "description": "The description, pattern or function."}
      },
      "required": ["kind", "text"]
    },
    "values": {"type": "array", "items": {"type": "string"}, "description": "Positive first. Default yes and no."},
    "paths": {"type": "array", "items": {"type": "string"}, "description": "Globs, for files. A glob followed by a record's place keeps the records there, for example `runs/*/forge.db#prs` for a table or `results.json#/runs`."},
    "unit": {"type": "string", "enum": ["records", "files", "runs"], "description": "For files: records (the default), files for one value per file, or runs for one value per run directory. A label keeps its unit when you apply it again without one. A prompt label reads as much of each file or run as fits its model's context."},
    "limit": {"type": "integer", "description": "Units to label, for a trial."},
    "within": {
      "type": "object",
      "properties": {
        "label": {"type": "string"},
        "value": {"type": "string", "description": "Default its first."}
      },
      "required": ["label"],
      "description": "For files: label only the records that another label gave this value. For example, let a prompt label read only the few records that a regex or code label kept."
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

Turn a label over files on or off in Files and the views, or give its values colors. `show_label` runs nothing, so show or hide a label with it, not with `apply_label`.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The label's name or id."},
    "on": {"type": "boolean", "description": "Leave it out to keep the label on or off as it is."},
    "values": {"type": "array", "items": {"type": "string"}, "description": "The values to highlight while the label is on, if not the ones it highlights now."},
    "colors": {"type": "object", "additionalProperties": {"type": "string", "enum": ["blue", "orange", "green", "sky blue", "olive", "teal", "brown", "navy", "grass green", "cerulean", "chestnut", "cyan", "red", "dark red", "purple", "dark purple", "pink", "dark pink"]}, "description": "A color for each value named."}
  },
  "required": ["name"]
}
```

## delete_label

Delete a label, with its marks, its card and any filter that uses it. Use it only when the analyst asks for it.

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

Filter the records in Files or the report's sentences by a value of a label that exists, and the cards by their kind, group, maker, card check, star, lock or words. It makes no label and no card. The parts you give replace those parts of the scope's filter. The other parts stay.

```json
{
  "type": "object",
  "properties": {
    "scope": {"type": "string", "enum": ["canvas", "files", "report"]},
    "label": {"type": "string", "description": "A label's name or id. An empty string drops the label from the filter."},
    "value": {"type": "string", "description": "The label's value to keep. Default its first."},
    "kinds": {"type": "array", "items": {"type": "string"}, "description": "Card kinds."},
    "groups": {"type": "array", "items": {"type": "string"}, "description": "Groups' titles or ids."},
    "makers": {"type": "array", "items": {"type": "string"}, "description": "Who made the cards, as each card names them, such as main, a thread's name or writer."},
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

Lay out the browser's main area, right of the chat, as panes. Each pane shows one surface: `files`, `canvas`, `report`, or a view on its own as `view:<slug>`. Call it when the analyst asks to see surfaces together.

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

Open a view in Files. Call it when the analyst asks to see a view.

```json
{
  "type": "object",
  "properties": {
    "view": {"type": "string", "description": "A view's slug or name."}
  },
  "required": ["view"]
}
```

## propose_view

Propose a view. A view shows the records in a form that their files hide. Any page the analyst will come back to is a view, whatever they call it, for example a dashboard or a tracker. You can also propose a viewer for one unusual file type. thimble's dev agent builds it from these fields and reads the files itself.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "A short name in Title Case, as its tab shows it."},
    "description": {"type": "string", "description": "What the analyst sees, in one sentence."},
    "task": {"type": "string", "description": "What the analyst wants to accomplish, in their words, not how."},
    "claims": {"type": "array", "items": {"type": "string"}, "description": "Globs of every file that holds its records. Give a pattern rather than one file, for example runs/*/events.jsonl. For a viewer of one file type, give the extension's glob, for example **/*.vtt."},
    "model": {"type": "string", "description": "The model to build it on, for example opus, sonnet or a full model id. Give it only when the analyst names one."},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "The effort to build it at. Give it only when the analyst names one."}
  },
  "required": ["name", "description", "task", "claims"]
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

Replace one sentence, paragraph or heading of a written document, insert a passage after it, or delete it. Inserted text that opens with a `## ` heading is a new section in the document's markdown. It goes after the section that holds the span. `block_type` alone turns a heading, paragraph or list item into another kind of block and keeps its text.

```json
{
  "type": "object",
  "properties": {
    "span": {"type": "string"},
    "text": {"type": "string"},
    "insert": {"type": "boolean"},
    "delete": {"type": "boolean"},
    "block_type": {"enum": ["heading", "subheading", "text", "bullets", "numbers"]}
  },
  "required": ["span"]
}
```

## add_comment

Comment on one sentence, paragraph or heading of a written document, or on a card.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "report:<doc>#<id> of a sentence or a heading, report:<doc>#p<id> of a paragraph, card:<id> of a card, answer:<turn>#s<n> of a sentence of Claude's answer."},
    "words": {"type": "string", "description": "For a sentence of Claude's answer: the words of it that the comment is about, exactly as it says them."},
    "text": {"type": "string", "description": "The statement: one short, clear sentence of about 20 words."},
    "details": {"type": "string", "description": "The evidence for the statement, with its citations. Use plain sentences or a few bullets, about 120 words at most."}
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
    "comment": {"type": "string", "description": "The comment's id, as add_comment's result names it. Or give report:<doc>#<id> of a passage, or card:<id> of a card, to resolve every open comment on it."},
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

Delete a thread and its chat from the workspace. Use it only when the analyst asks for it. You cannot delete main.

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

Get a picture of what the analyst sees in the browser. It is slow. Use it only when the look matters.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "card:<id>, view:<slug>, a file ref a view opens, report:<slug>#<id> of a figure, thread:<id>, or an http address of thimble's own interface on this machine."},
    "selector": {"type": "string", "description": "With an http address, the CSS selector of the one element to shoot."}
  },
  "required": ["ref"]
}
```

## export_card

Write a card's figure as files into a folder of the corpus, in the figure style the analyst chose, as the card's Export menu saves them. Use it when the analyst asks for a card as a figure or as files.

```json
{
  "type": "object",
  "properties": {
    "card": {"type": "string", "description": "card:<id>"},
    "folder": {"type": "string", "description": "The folder for the files, relative to the corpus folder. Default figures."}
  },
  "required": ["card"]
}
```

## start_writing

Start a writer as a subagent of this session. The writer writes or revises one document from this conversation, the cards and the documents. Call it when the analyst asks for a document or for a change to one. To change one passage of a written document, use `edit_document` yourself.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "The document's slug, such as report, or a `card` event's `doc`."},
    "request": {"type": "string", "description": "What the analyst asked for, in their words. Leave it empty to write the document as its form asks."},
    "after": {"type": "string", "description": "The passage the request is about, such as a `card` event's `after`."},
    "type": {"type": "string", "description": "Only for a new document, which thimble then makes: casefile (one document with a section per case), comparison (a page with a grid of the cases against measures), timeline (dated events in phases), page, or document for one the request describes."},
    "name": {"type": "string", "description": "The new document's name in thimble."},
    "model": {"type": "string", "description": "The model to run the writer on, for example opus, sonnet or a full model id. Give it only when the analyst names one."},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "The effort to run the writer at. Give it only when the analyst names one."}
  },
  "required": ["doc"]
}
```

## run_check

Run a comments agent over the written documents or the cards. A comments agent asks one question of every passage. It leaves a comment beside each passage that the question applies to. A new name creates the comments agent, and a known name runs it again. For one note on one passage, use `add_comment`.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The comments agent's name, or a new one."},
    "instructions": {"type": "string", "description": "What to comment on, in the analyst's words. A new comments agent needs it. For an existing comments agent, it replaces the instructions."},
    "passages": {"type": "array", "items": {"type": "string"}, "description": "Passages to comment on again, report:<doc>#<id>. Default every passage but the locked ones already read."},
    "on": {"type": "string", "enum": ["documents", "cards"], "description": "Run it on the documents alone or on the cards alone. A new comments agent then covers only that. Default: what the comments agent covers."}
  },
  "required": ["name"]
}
```

## stop_check

Turn a comments agent off, as the switch in the Comments pane does. This hides its tints and comments and stops its runs.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The comments agent's name."}
  },
  "required": ["name"]
}
```

## file_dev_ticket

File a ticket for thimble's developer agent to change a view that it built for this corpus. A change to thimble itself is a fix of the person's thimble. They ask for it with /thimble-fix.

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

## fix_thimble

Start the fix the person asks for with /thimble-fix. thimble is the person's own tool. So when it misbehaves in this session, you may tell them that /thimble-fix <what should work differently> asks for a fix.

```json
{
  "type": "object",
  "properties": {
    "words": {"type": "string", "description": "`N` to change the person's fix N, or `new` for a new fix."}
  },
  "required": ["words"]
}
```

## view_check

Run thimble's checks on the view you build or review, as often as you want.

```json
{
  "type": "object",
  "properties": {
    "locators": {"type": "array", "items": {"type": "string"}, "description": "Refs to check beside the sampled lines, such as `<path>#L<n>` or `view:<slug>/<key>`."},
    "picture": {"type": "boolean", "description": "Also take a picture of the page as it opens, 1048 px wide with no label on."}
  }
}
```

## finish_view

Finish the view you build.

```json
{
  "type": "object",
  "properties": {}
}
```

## view_pictures

Take pictures of the view you review.

```json
{
  "type": "object",
  "properties": {
    "states": {
      "type": "array",
      "maxItems": 4,
      "description": "States to see beside the overview. `control`: the view as it opens after clicking `controls` in turn. Name each control by its text as the list of controls gives it, or by an option of a select. `labels`: the view as it opens with a test label on. The test label marks about one record in seven, in the color the analyst's first label takes. `filtered`: the same view filtered to the test label, which should keep only what it marks. `detail`: the place the first citation opens. `open`: the place a citation of `ref` opens, a record `<path>#L<n>` or a unit from the records. `narrow`: the view as it opens 798 px wide. `wide`: the view as it opens 1528 px wide.",
      "items": {
        "type": "object",
        "properties": {
          "state": {"type": "string", "enum": ["control", "labels", "filtered", "detail", "open", "narrow", "wide"]},
          "controls": {"type": "array", "maxItems": 3, "items": {"type": "string"}, "description": "For `control`: the controls to click in turn, by their text. For example, `Color by: State`, `State` and `Approval` color by Approval in place of State."},
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

End your review.

```json
{
  "type": "object",
  "properties": {
    "revised": {"type": "array", "items": {"type": "string"}, "description": "What you revised, one short phrase each."},
    "left": {"type": "array", "items": {"type": "string"}, "description": "The problems you leave as they are, one short phrase each. Say why when the data shows the view is right."}
  }
}
```

## ticket_checks

Check the change in your ticket's worktree.

```json
{
  "type": "object",
  "properties": {}
}
```

## finish_ticket

Finish your ticket.

```json
{
  "type": "object",
  "properties": {}
}
```

## card-errored

This card errored. Fix the code with `edit_card`.

## card-timeout

The code was stopped after {limit}. Make it faster and run it again with `edit_card`.

## card-tall

card:{cid}'s body draws {height} px tall at the card's width. About {limit} px of a card's body fit on the analyst's screen with its question and takeaway. So the analyst cannot see the whole card at once.

## card-wide

card:{cid}'s page lays out {width} px wide, and the card gives it {frame} px. So the analyst does not see all of the page at the card's width.

## card-replaced

thimble's card check replaced card:{cid} in place, so the analyst sees its version, not yours. Its version is {what}, with the question “{question}”. Its takeaway reads: {takeaway} It changed the {changed}{why}

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

card:{cid}, the {kind} card, has no code. Pass a new `{field}` or `question`. Or add a card whose code computes what it shows.

## edit_card-kind

card:{cid} is of kind {kind} and cannot change to {new}. Add a new card instead.

## example-quote-missing

The quote "{quote}" is not in {ref}. Quote the record's words exactly, or cite the record without a quote.

## edit_card-check-kept

The card check had rewritten card:{cid}'s {field}. Your call gave back the {field} that the check replaced, so the check's {field} stays. Read the card, and pass a new {field} to change it.

## edit_card-check-merged

The card check had rewritten card:{cid}'s {field}. So your change was made to the check's {field}, which the card now shows.

## edit_card-takeaway-errored

The card errored, so the takeaway was not saved. Fix the code, then give the takeaway again.

## edit_card-same-outputs

The new code ran and gave the same outputs as before the edit. So this edit changed nothing that card:{cid} shows.

## edit_card-after

`after` places card:{cid} in a group. It takes another card, card:<id>, or first.

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

card:{cid} has no takeaway. Write it with `edit_card` and `takeaway`: one or two sentences that answer its question from the output above.

## takeaway-stale

card:{cid} kept its takeaway, which was written before this run changed its output. Write it again now with `edit_card` and `takeaway`, from the output above. Do this before any other call.

## takeaway-missing-shown

card:{cid} has no takeaway. Write it with `edit_card` and `takeaway`: one or two sentences that answer its question from what the card shows.

## apply_label-rows

Count and cite from the label's rows in a card's code. thimble's Python module is there, not in Bash. thimble.labels("{label}") is a DataFrame (path, line, effective, label, source, verdict, confidence, ref) of the units that got the first value. thimble.labels("{label}", negatives=True) is the same DataFrame of every labeled unit.

## apply_label-unchanged

The label already held these values from the same predicate over the same units, so nothing ran again.

## apply_label-other-scope

{label} [[{ref}]] is already a label over {scope}. A label over {new} needs a name of its own.

## apply_label-takeaway-stale

The takeaway of its card card:{cid} was written for the run before. Write it again with `edit_card` from these counts.

## apply_label-stale

{cards} read this label before it changed. When its counts are final, thimble runs each of them again on the label as it is now. So leave them as they are.

## show_label-not-files

{label} is a label over {units}, which Files does not show. Filter {where} by one of its values to show it.

## set_filter-set

The {scope} filter is now {filter}.

## set_filter-kept

It keeps {kept} of the {total} cards. The analyst sees the rest dimmed.

## set_filter-files

Files shows the label turned on, with that value highlighted. Its views keep only the records that take the value. They leave whole the files that the label never ran over.

## set_layout-set

thimble shows {surfaces} {layout}.

## open_view-view

Opened the {view} view in Files.

## export_card-written

Wrote the figure of {card} in the {style} figure style: {paths}.

## clear_filter-cleared

The {scope} filter is cleared.

## list_cards-filter

The card filter {filter} keeps {kept} of the {total} cards. The analyst sees the cards tagged `filtered out` dimmed.

## takeaway-long

The takeaway runs to {words} words. Cut it to 40 at most with `edit_card` and `takeaway`.

## takeaway-uncited-example

The takeaway cites none of the records the card shows. Link the words of each claim to the record that shows them, as in `[[posted the answer|{ref}]]`. Use `edit_card` and `takeaway`.

## card-installs

{tool}: this code installs software or downloads files. Card code may not do that. Use what is already installed, or tell the analyst what the analysis needs and why.

## takeaway-reminder

Your last card, card:{cid}, still has no takeaway. Write it with `edit_card` and `takeaway`.

## not-found-in-outputs

NOT found in this card's outputs: {values}. Cite each where the output shows it, or drop it.

## shown-not-linked

Found in this card's outputs but not linked: {values}. More than one place shows each of them, or each is a small number that could stand for several places. Link each to the place your words mean, as `[[value|card:{cid}#<column>/<row>]]`.

## add_card-more

… {more}. `read_ref` on {ref} shows all of it.

## write_document-locked

A change to {blocks} that the analyst locked was reverted: {refs}. A locked block stays word for word as the analyst left it.

## edit_document-locked

The analyst locked {ref}, so it stays as it is. Leave it, or change the passages around it.

## read_ref-document

Each passage carries its id. Cite or edit a sentence or a heading as report:{slug}#<id> and a paragraph as report:{slug}#p<id>.

## read_ref-frame

The analyst's frame: the sections they want, the figures they pinned and the points to make. Write a cited passage for each point. Do not copy the points.

## read_ref-new

The analyst laid out no frame, so the shape is yours.

## screenshot-none

{what}, so screenshot cannot take it. `read_ref` on it reads what the analyst sees.

## propose_view-proposed

Proposed the view {view} (view:{slug}) over {claims}. The dev agent is building it now. It opens in Files when its checks pass.

## propose_view-unmatched

No file of the corpus matches {claims}. So the view was not proposed. {near} Propose it again with claims that match files the corpus holds.

## propose_view-near

The files nearest {claim} are {paths}.

## propose_view-cannot-build

Proposed the view {view} (view:{slug}). But views cannot be built on this machine, so its build failed at once: {why} Tell the analyst, because only they can install this.

## view-changing

The dev agent is changing the view {view} (view:{slug}) now. When its checks pass, the view has the change. When they fail, the view stays as it was.

## view-no-anchors

No element of the page has a `data-anchor` that names a record (its citation form, for example `<path>#L<n>` or `<db>#<table>/<key>`) or a unit of the view (`view:{slug}/<key>`). So no label the analyst turns on can show in the page. Give each element that shows a record its file ref, and each unit's element its key.

## file_dev_ticket-no-view

No view is named {view}. The views are {views}. File the ticket again with one of them.

## file_dev_ticket-fix

This call filed nothing. A change to thimble itself is a fix of the person's thimble. They ask for it with /thimble-fix <what should work differently>.

## file_dev_ticket-fix-off

Nothing was filed: {why}. Tell the analyst, because only they can change this.

## fix_thimble-new

thimble started a fork of this conversation that fixes thimble in the background, in a copy ("{fix}"). The chat shows its work above your reply. Once the fix passes thimble's checks, thimble asks the person to use it. Tell the person in one short line, then go on with their request.

## fix_thimble-round

thimble started a fork of this conversation that changes the person's fix "{fix}" in the background, in a copy. The chat shows its work above your reply. Once the changed fix passes thimble's checks, thimble asks the person to use it. Tell the person in one short line, then go on with their request.

## fix_thimble-round-on

thimble started a fork of this conversation that changes the person's fix "{fix}" in the background, in a copy. The version they have stays until they use the changed one. The chat shows its work above your reply. Once the changed fix passes thimble's checks, thimble asks the person to use it. Tell the person in one short line, then go on with their request.

## fix_thimble-live

thimble gave these words to the fork that is already fixing "{fix}". Tell the person in one short line, then go on with their request.

## fix_thimble-failed

thimble started no fix: {why} Tell the person in one short line.

## view-media-unplayable

The browser that takes the pictures for the checks and the review cannot play H.264 video or AAC audio. Most MP4, MOV and M4A recordings hold these. In the pictures, a player of such a file stays blank or shows an error. The analyst's browser usually plays it, so that is not a problem of the view. A player that stays blank on a WebM, Ogg, MP3 or FLAC file is a problem of the view.

## view-purple

The page writes purple colors: {colours}. If any of them colors a category of the view, show that category as text, as a glyph or through Color by instead. A category is, for example, a speaker or a kind of record.

## view-own-parts

The page's styles change how thimble's parts look, or draw chips of their own: {found}. The parts are `chip` (with `chip-sans`, `chip-tone-neutral`, `chip-tone-evidence`, `chip-act`, and `chip-key` with a `chip-sw` swatch for a value with its color), `btn`, `seg` with `seg-opt`, and `field`. Set their width, margins, padding and place, but not their edges, fills, corners, colors, type or height. Give no chip, tag or small button corners rounder than `var(--radius-chip)`.

## view-built

The dev agent built the view {view}, so {claims} now open in it. In it, {forms}.

## finish-view-pass

The checks passed, and the view is built. Change nothing more. End with one line that says what you built.

## finish-view-fail

The checks failed, attempt {n} of {of}:

{report}

Fix what failed, check the view again with `view_check`, then call `finish_view` again.

## finish-view-unchanged

The view's files are as they were built. So there is nothing to check, and the view stays as it is.

## finish-view-stop

No attempt is left, so stop now. Change nothing more. End with one line that says what still fails.

## finish-ticket-pass

The checks passed, and the change is committed to the ticket's branch. Change nothing more. End with one line that says what you changed.

## finish-ticket-fail

The checks failed, attempt {n} of {of}:

{report}

Fix what failed, check again with `ticket_checks`, then call `finish_ticket` again.

## finish-ticket-stop

No attempt is left, so stop now. Change nothing more. End with one line that says what still fails.

## finish-ticket-empty

The worktree holds no change, so there is nothing to check. Make the change first. If the ticket cannot be done safely, end without `finish_ticket` and say why.

## ticket-checks-empty

The worktree holds no change yet, so there is nothing to check.

## finish-review-again

The checks passed. Take the pictures again with `view_pictures` and look once more. Then call `finish_review`.

## finish-review-done

The checks passed, and the review is done. Change nothing more. End with one line that says what you revised and what you left.

## finish-review-restored

The checks failed on your revision, so the view is as it was before your change. Change nothing more. End with one line that says what you tried.

## view-pictures

The pictures come with this answer, in this order:

{paths}

The records they show:

{records}

## view-no-forms

no citation resolves, because its `accepts` and `units` are empty

## view-no-screenshots

Screenshots are unavailable on this machine. So the checks did not load the page and took no pictures. Check the page by reading it and what the reader answers. Do not take pictures any other way.

## view-few-anchors

The reader handed the page {fetched} records. But only {records} shown elements carry a record's citation form as their `data-anchor`, for example `<path>#L<n>`. So the labels the analyst turns on show on almost nothing in the page. Give each element that shows a record its file ref.

## view-marks-missing

In the {state} state, {missing} of the {due} shown records or units that the test label marks do not show its mark. thimble draws a mark on the outermost visible element whose `data-anchor` names the record. It draws no mark on a canvas. So draw records as HTML or SVG elements, or put the `data-anchor` on an element beside the canvas drawing.

## view-marks-unseen

In the {state} state, a picture of the page does not show the test label's color on {unseen} of the {checked} marked records or units in view, for example {refs}. thimble draws a mark as a 3 px bar in the label's color along the left edge of the outermost element whose `data-anchor` names the record. The bar goes inside the element when its left padding is 6 px or more, or when a box that hides overflow would cut a bar outside it. Otherwise the bar goes just outside. The bar does not show when the page's CSS sets `box-shadow` on that element with `!important`. It also does not show when another element or a cell's background covers the element's left edge. An element with `data-anchor-unmarked` gets no bar. So the page must draw the label's color on it itself, at full strength, for example a dot or a fill in the color that `thimble.markOf(ref).bar` gives. Redraw it in `thimble.onMarks`.

## view-no-label-controls

The page draws no label controls: {why}. thimble draws none above a view. So the page lists the labels that `thimble.onLabels` gives in `all`, each with its colors and a switch. The switch calls `thimble.setLabel(id, on)` on the analyst's click. The page also shows each label that is on in the view, for example in a legend. Each such element carries `data-label` with the label's id.

## view-labels-by-itself

The page made {made} by itself, on load, on a timer or from its own script: {calls}. thimble refuses a label change that does not come from the analyst's own click or key press in the view. So call these only from a control's click or key handler.

## view-filter-unkept

Filtered to the test label, the page shows {records} records. The filter does not keep the line that anchors {unkept} of them. That is right for a record that the page draws for several lines, one of which the label marks. Otherwise, keep only the records for which `thimble.kept(ref)` holds in the reader's answers, and fetch again in `thimble.onLabels`. Or leave the filtering to thimble: register no `onLabels`.

## view-missing

The claims expect files that the corpus lacks: {files}. The analyst sees them above the view as missing.

## view-choice-error

{count} choices of the view's controls gave a script error when chosen: {choices}. Guard what the page reads of a choice that can be null (`rows.by`, `color.by`, `filter.by`). For such a choice, draw the records in one group, or uncolored.

## view-robust-reader

With {what}, the reader failed: {error}. Read what is there, and report each line you cannot parse with problems().

## view-robust-torn

thimble added a line cut short at {ref}, and problems() does not report it. Report each line the reader cannot parse with problems().

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

{count} claimed files are neither read to the end by build_index nor listed with a why by hidden(index): {files}. Read each file whole in build_index, with Python's `open()`. Or return it from hidden(index) with its `path` and a `why` that says why the view leaves it out.

## view-not-claimed

{count} files sit in folders beside the ones the view claims: {files}. These folders hold the same files, for example another run's. If the view is for all of them, claim them and let the analyst choose among the folders.

## view-derived-unlisted

Some fields of the records the reader answered hold values that the lines they cite do not hold. These fields are not listed as derived: {fields}. List each of these fields in view.json's `records` with its `type` and `"derived": "cleaned"`, or `"computed"` for a value the files do not state. Give it `from` and `how`, each a short plain phrase without semicolons. Or return it from the reader's derived(index).

## ticket-from-thread

The analyst asked for this in the side thread {thread}, which they opened on this:
{anchor}

## follow-up-ran-on

This message ran on {model} · {effort}, the role's current settings.

## start_writing-running

A writer of {doc} is running already. Tell the analyst so in one line.

## agent-started

thimble started it. It runs in the background, and the analyst sees it in the chat. End the turn now, with no words and no other call, unless the analyst asked for more in this turn.

## agent-started-fork

Filed {what}, and thimble started {agent}. The analyst has nothing to do. Tell the analyst in one line in the thread that it is filed and {agent} is running.

## writer-context-file

The workspace as it stands is in {path}. Read it whole before you write.

## writer-context-files

The workspace as it stands is in {n} files, in this order: {paths}. Read each file whole, in that order, before you write.

## start_writing-made

Made the new document {title}, report:{doc}.

## start_writing-no-doc

There is no document {doc}. The documents are {docs}. To make a new one, pass its `type` (one of {types}) and its `name`.

## run_check-started

comments agent “{check}” started ({how}) on {doc}, {passages}

## run_check-no-doc

No document is written yet, so the comments agent “{check}” has nothing to read. It is on, and it runs once a document is written.

## run_check-no-cards

The comments agent “{check}” is on, and has no card to read yet.

## run_check-no-instructions

There is no comments agent named {check}. Call `run_check` again with its `instructions` to create it. The comments agents are {names}.

## run_check-no-passage

None of {passages} is a passage of a written document. `read_ref` on a document gives each passage's id.

## check-task-file

Your task is in {path}. Read it whole first.

## check-task-files

Your task is in {n} files, in this order: {paths}. Read each one whole, in that order, first.

## add_comment-no-passage

{ref} is no passage of report:{doc}. `read_ref` on report:{doc} gives each passage's id.

## add_comment-uncovered

{ref} is not among the passages this run checks. Comment only on the passages your task lists.

## add_comment-held

Not added. In {ref}, a comment of {check} already holds “{words}”. An explainer and a heads-up never share words. Give other words, here or in another sentence, or leave it out.

## add_comment-no-words

Not added. {ref} does not say “{words}”. It says “{sentence}”. Give `words` exactly as it says them.

## add_comment-not-check

Only the analyst's session and a check's own session comment with `add_comment`.

## add_comment-no-document

{ref} is no passage of a written document. A passage is report:<doc>#<id>, and `read_ref` on a document gives each passage's id. The written documents are {docs}.

## add_comment-added

commented on report:{doc}#{sid}, comment {comment}

## add_comment-no-card

{ref} is no card. A card is card:<id>.

## check-canvas

The cards to comment on. The analyst reads all of a card's comments beside it at once. So leave only the few comments that matter most on any one card.

{cards}

## check-replaces

When you finish, your comments replace the open comments that this check left before on these passages. Leave again each one that still holds.

{comments}

## resolve_comment-done

{action} comment {comment} on {ref} · {who} · {text}

## resolve_comment-none

{comment} names no {state} comment. `read_ref` on a document lists its open comments, each with the id of the passage it is on.

## stop_check-stopped

comments agent “{check}” turned off, its runs stopped on {docs}

## stop_check-off

comments agent “{check}” turned off, with no run running

## stop_check-none

There is no comments agent named {check}. The comments agents are {names}.

## check-document

The document, `{ref}`, with the id of every passage.

{document}

## check-instructions

The comments agent “{check}”, which says what to comment on.

{prompt}

## check-passages

Comment only on these passages.

{passages}

## check-every-passage

Comment on any passage of the document.

## check-tags

The sentences the citation check tagged unverified, each with its note. Confirm each before you comment.

{tags}

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

## context-brief-checked

· the answer you check

## context-brief-oldest

[The {n} oldest turns are left out here, since the whole conversation is too long.]

## context-evidence-cites

The answer cites these:

{refs}

## context-none-given

None yet.

## context-cut-oldest

[The {n} oldest entries are left out here, since the whole conversation is too long.]

## agent-continue-earlier-session

This agent ran in an earlier session of main, {session}, and cannot be continued from this one.

## agent-continue-earlier-version

This agent ran in an earlier version of thimble and cannot be continued.

## stop-subagent

The analyst pressed Stop on {title}, your subagent `{agent_id}`, in thimble. Stop it with TaskStop.

## main-stopped-note

thimble: the analyst pressed Stop in thimble and ended your turn. Any command that turn was running was stopped too. Leave that work stopped. Do not run its calls again or take up its request unless the analyst asks again.

## thread-stopped-note

thimble: the analyst pressed Stop in thimble on the side thread {thread}. This stopped its fork `{agent_id}`. Leave it stopped. Do not message, continue or restart it unless the analyst asks.
