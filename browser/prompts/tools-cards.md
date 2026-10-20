# The cards' tools

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/features/cards.py). The
texts come from thimble 0.8's, with citations written as Markdown links, as the terminal plugin writes them.

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

Add a card, with its question and its content in one call. A card is a short program, as the card guide says: `code` is Python whose last value is the card's `data`, and `program` draws that data on the toolkit. thimble runs both in a sandbox and returns `card:<id>`, the parts you can cite, and any error or warning. Give its takeaway here, or with `edit_card` once you have read the result. For real records, give `kind` example and `refs`; for a few sentences, `kind` note and `text`.

```json
{
  "type": "object",
  "properties": {
    "question": {"type": "string", "description": "The one question the card answers."},
    "kind": {"type": "string", "enum": ["program", "example", "note", "table", "code", "diagram", "plot", "timeline", "custom"], "description": "program, the default when `program` is given, draws `data` with `program`; example shows `refs`, note `text`. table, plot, code, diagram, timeline and custom are older kinds, drawn from what `code` ends in or from `html`."},
    "code": {"type": "string", "description": "Python run in the folder's root, on its own: it loads the data it needs. It can read the folder and cannot change it or reach the network. For a program card it ends in the card's data: a dict of lists of rows or a list of rows, each row with the `ref` of the record it came from when it has one, such as \"runs/run-07.jsonl#L12\". Compute every count in it, over every record."},
    "program": {"type": "string", "description": "The body of (k, data) => node, on the toolkit the card guide lists, which draws `data`. Give each part the analyst may select an id that names what it is."},
    "refs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"ref": {"type": "string"}, "quote": {"type": "string"}}}]}, "description": "The records an example card shows. Each is a ref, or {ref, quote} to highlight one passage of a long record, quoted exactly."},
    "text": {"type": "string", "description": "The markdown a note card shows."},
    "html": {"type": "string", "description": "The page a custom card shows, for what no other kind can show. Scripts run, the network does not."},
    "group": {"type": "string", "description": "The group's title or id. A new title makes a group."},
    "takeaway": {"type": "string", "description": "The answer to the question in one or two sentences. Each number the card shows links to the part that shows it: wrap the whole quantity and cite the part's id, as in `[31](card:<id>#merged) of [40](card:<id>#all) runs`. On an example card, link the words of each claim to the record that shows them, as in `[posted the answer](runs/r3.jsonl#L88)`. The card's own id is written `card:<id>`, which thimble fills in."}
  },
  "required": ["question"]
}
```

## edit_card

Change a card in place and run it again, rather than adding a second card. It takes the fields of `add_card`; a `takeaway` alone sets the card's answer without a run, and a new `code` or `program` runs the card again.

```json
{
  "type": "object",
  "properties": {
    "card": {"type": "string", "description": "card:<id>"},
    "question": {"type": "string"},
    "kind": {"type": "string", "enum": ["program", "example", "table", "code", "diagram", "plot", "timeline", "note", "custom"]},
    "code": {"type": "string"},
    "program": {"type": "string"},
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
