# The report checks' tools

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/checks.py).

## add_comment

Comment on one sentence or paragraph of the report, a note the analyst reads beside it. The analyst sees `text` first and opens `details` when they want more. Comment only on the passages your task names.

```json
{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "report:report#t<id> of a sentence, report:report#p<id> of a paragraph, as the task names them."},
    "text": {"type": "string", "description": "The statement: one short, clear sentence of about 20 words."},
    "details": {"type": "string", "description": "The evidence for the statement, with its citations, in plain sentences or a few bullets of about 120 words at most."}
  },
  "required": ["ref", "text"]
}
```

## run_check

Run a report check over the report, a question asked of every passage that leaves a comment beside each passage it applies to, such as which examples depend on one file. A new name creates the check and a known one runs it again, and either way it is turned on. It runs on its own, beside you, and thimble shows its comments beside the report. It runs again by itself after the writer saves the report. Call it when the analyst asks to highlight, flag or find passages of the report and judging one means reading what it rests on. Once it has started, say no more about it than one line.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The check's name, such as Unverifiable, or a new one."},
    "instructions": {"type": "string", "description": "What to comment on, in the analyst's words. Needed for a new check, and it replaces the instructions of an existing one."},
    "passages": {"type": "array", "items": {"type": "string"}, "description": "Passages to check again, report:report#<id>. Default every passage the check has not seen as it stands."}
  },
  "required": ["name"]
}
```

## stop_check

Turn a report check off, as the switch in the report's Comments pane does, which hides its comments and stops its runs. Its comments are kept, and `run_check` turns it on again.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "The check's name, such as Unverifiable."}
  },
  "required": ["name"]
}
```
