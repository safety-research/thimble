# thimble browser's label tools

The tools of the labels feature (server/thimble_browser/labels/chat.py), in the form of tools.md. The texts come from
thimble 0.8's, with what thimble browser does not have left out.

## apply_label

Define a category, apply it to every unit of a scope, and get the counts per value and a card where the analyst checks each unit. In files, a unit is a record, a whole file or a folder of files (`unit`). The call waits until every unit has its value, which for a prompt label over many records takes a few minutes; the analyst sees the run go on in the label's card and in Files.

```json
{
  "type": "object",
  "properties": {
    "scope": {"type": "string", "enum": ["files", "canvas", "report"], "description": "Records of files, cards, or report sentences."},
    "name": {"type": "string", "description": "The label's name, a few words. The same name again redefines the label."},
    "question": {"type": "string", "description": "The one question its card answers."},
    "predicate": {
      "type": "object",
      "properties": {
        "kind": {"type": "string", "enum": ["prompt", "regex", "code"], "description": "A model judges each unit against your definition, a Python regex searches its text, or code defines label(unit) returning a value, or (value, confidence). For code, a unit is a JSON lines record as its dict, a line of text {\"text\": the line}, a row of a CSV file a dict of its columns, a value of a JSON document its value, a card a dict with its text, kind, question, takeaway and group, a sentence {\"text\"}, a whole file {\"path\", \"data\", \"records\"} with data the parsed JSON document, the JSON lines' records, the CSV rows or the text, and a folder {\"path\", \"paths\", \"records\", \"files\"} with each file whole by its path. A model and a regex read a JSON lines record as its line, and a CSV row as one `column: value` line per column."},
        "text": {"type": "string", "description": "The definition, the pattern or the function."}
      },
      "required": ["kind", "text"]
    },
    "values": {"type": "array", "items": {"type": "string"}, "description": "Positive first. Default yes and no. A regex gives a unit that matches the first value and any other the second."},
    "paths": {"type": "array", "items": {"type": "string"}, "description": "Globs or folders, for files, such as runs/*.jsonl. Default every file."},
    "unit": {"type": "string", "enum": ["records", "files", "runs"], "description": "For files: records, the default, files for one value per file, or runs for one value per folder of files. A label keeps its unit when you apply it again without one."},
    "limit": {"type": "integer", "minimum": 1, "description": "Units to label, spread over the files, for a trial."},
    "within": {
      "type": "object",
      "properties": {
        "label": {"type": "string"},
        "value": {"type": "string", "description": "Default its first."}
      },
      "required": ["label"],
      "description": "For files: label only the records another label gave this value, such as the few a regex or code label kept before a prompt label reads them."
    },
    "comment": {"type": "boolean", "description": "For a prompt label: a one-line reason per unit."},
    "show": {"type": "boolean", "description": "For files: turn it on in Files as it runs, as show_label does."},
    "filter": {"type": "boolean", "description": "Make it the scope's filter."},
    "group": {"type": "string", "description": "The group of its card. Default a group named after the label."}
  },
  "required": ["scope", "name", "predicate"]
}
```

## show_label

Turn a label over files on or off in Files, where it marks the records that have the values it highlights, or give its values colors. It runs nothing, so a label is shown or hidden with it rather than with `apply_label`. The analyst turns labels on and off in Files too, so call it whenever they ask to show or hide one, or to color a value.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The label's name or id."},
    "on": {"type": "boolean", "description": "Left out, the label stays on or off as it is."},
    "values": {"type": "array", "items": {"type": "string"}, "description": "The values to highlight while it is on, when not the ones it highlights now."},
    "colors": {"type": "object", "additionalProperties": {"type": "string", "enum": ["blue", "orange", "green", "sky blue", "olive", "teal", "brown", "navy", "grass green", "cerulean", "chestnut", "cyan", "red", "dark red", "purple", "dark purple", "pink", "dark pink"]}, "description": "A color for each value named, which every card and Files show. A value that had the color takes the one the other leaves."}
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
    "makers": {"type": "array", "items": {"type": "string"}, "description": "Who made the cards, as each card names them, such as main or a thread's name."},
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
