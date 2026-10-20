# thimble browser's tools

Each `## <tool>` section is one tool Claude gets: its description, then its input schema. The server reads this file
(server/thimble_browser/tools.py). The texts come from thimble 0.8's tools, with citations written as Markdown links,
as the terminal plugin writes them.

## read_ref

Read anything thimble can cite, as the analyst sees it, such as a card with its outputs or a record of a file. The analyst may edit a card at any time, so read it again before you rely on it. Read a plain file with Read.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "A ref, as it stands inside a citation's parentheses."}
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

Add a card, with its question and its content in one call. thimble runs the code in a sandbox and returns `card:<id>` and the start of each output. Give its takeaway here, or with `edit_card` once you have read the output.

```json
{
  "type": "object",
  "properties": {
    "question": {"type": "string", "description": "The one question the card answers."},
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom"], "description": "table, code, diagram, plot and timeline run `code`, example shows `refs`, note `text`, custom `html`. Default code."},
    "code": {"type": "string", "description": "Python run in the folder's root, on its own: it loads the data it needs. It can read the folder and cannot change it or reach the network. A table ends in a DataFrame of a few short columns indexed by what names each row, a plot in thimble.chart(kind, df) after import thimble when a kind fits, else in an Altair or matplotlib chart, its colors left to thimble's theme, and after import thimble a diagram in thimble.diagram(nodes, edges), each edge a (source, target, label), and a timeline in thimble.timeline(events), each event a (time, label). thimble.chart takes the DataFrame's columns in the kind's order, named as the axes: bar (category, value[, group]), line (x, y[, series]), area (x, y[, series]), scatter (x, y[, group]), dots (x, row[, group]), box (value, group), histogram (value[, group]), density (value[, group]), violin (value, group), ecdf (value[, group]), range (item, before, after[, group]) or heatmap (x, y, value); panels=True draws each group in a panel of its own. Name nodes, edges and events in a few words, their numbers computed."},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"}}}]}, "description": "The records an example card shows. Each is a ref, or {ref, quote} to highlight one passage of a long record, quoted exactly."},
    "text": {"type": "string", "description": "The markdown a note card shows."},
    "html": {"type": "string", "description": "The page a custom card shows, for what no other kind can show. Scripts run, the network does not."},
    "group": {"type": "string", "description": "The group's title or id. A new title makes a group."},
    "takeaway": {"type": "string", "description": "The answer to the question in one or two sentences. Each number the card shows links to where the card shows it. Wrap the whole quantity and cite where you read the value, as in `[31](card:<id>#outcome/merged) of [40](card:<id>#outcome/all) runs`. On an example card, link the words of each claim to the record that shows them, as in `[posted the answer](runs/r3.jsonl#L88)`. The card's own id is written `card:<id>`, which thimble fills in."}
  },
  "required": ["question"]
}
```

## edit_card

Change a card in place and run it again, rather than adding a second card. It takes the fields of `add_card`; a `takeaway` alone sets the card's answer without a run.

```json
{
  "type": "object",
  "properties": {
    "card": {"type": "string", "description": "card:<id>"},
    "question": {"type": "string"},
    "kind": {"type": "string", "enum": ["example", "table", "code", "diagram", "plot", "timeline", "note", "custom"]},
    "code": {"type": "string"},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"}}}]}},
    "text": {"type": "string"},
    "html": {"type": "string"},
    "group": {"type": "string", "description": "The group to move the card to, its title or id. A new title makes a group."},
    "takeaway": {"type": "string", "description": "The answer to the question in one or two sentences, with each number cited as in add_card."}
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

## write_document

Save the report whole, as Markdown in the report's form. The result names each citation that does not open, so you can fix it before you end.

```json
{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "report"},
    "text": {"type": "string", "description": "The whole report: `# ` its title, `## ` each section, cited paragraphs, and figures as `![what to take from it](card:<id>)` on lines of their own."}
  },
  "required": ["doc", "text"]
}
```

## propose_view

Start building a view: a page in the Files tab that shows the folder's records in a form their files hide, such as a timeline, a network or a forge's pull requests. thimble's view builder builds it on its own from these fields and reads the files itself, and the view appears in the Files tab when it passes its checks. Call it only when the analyst asks for a view.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "A short name in Title Case, as its tab shows it, such as Message Board."},
    "description": {"type": "string", "description": "What the analyst sees, in one sentence, such as a wiki page with its edit history or a graph of who replies to whom."},
    "task": {"type": "string", "description": "What the analyst wants to accomplish, in their words, not how."},
    "claims": {"type": "array", "items": {"type": "string"}, "description": "Globs of every file that holds its records, relative to the folder, by pattern rather than one file, such as runs/*.jsonl."}
  },
  "required": ["name", "description", "task", "claims"]
}
```

## write_view_file

Write one of the view's three files whole: `view.json`, `reader.py` or `view.html`. It writes only into the view's own folder.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "enum": ["view.json", "reader.py", "view.html"]},
    "text": {"type": "string"}
  },
  "required": ["name", "text"]
}
```

## view_check

Check the view: its three files, the files its `scope` claims, and its reader run on the folder in thimble's sandbox. It says what to fix.

```json
{"type": "object", "properties": {}}
```

## finish_view

Run the checks as the record of the build. When they pass, the view appears in the analyst's Files tab.

```json
{"type": "object", "properties": {}}
```
