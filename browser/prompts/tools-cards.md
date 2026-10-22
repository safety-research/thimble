# The cards' tool

The `card` tool, in the same form as tools.md (server/thimble_browser/features/cards.py). Its description is the
terminal plugin's own (plugin/prompts/card-tool.md, through shared.json), and its input schema is the one the plugin's
cards/tool.ts gives.

## card

{{shared:card-tool}}

```json
{
  "type": "object",
  "properties": {
    "title": {"type": "string", "description": "what the card shows, in a few words; with `id`, leave out to keep the title"},
    "data": {"type": "string", "description": "the path of the JSON file of rows, in $TMPDIR (may start with $TMPDIR/); with `id`, leave out to keep the rows"},
    "view": {"type": "string", "description": "JavaScript that defines function view(props, surface); with `id`, give `edits` instead, or only new `data` to keep the view"},
    "edits": {
      "type": "array",
      "description": "with `id`: changes to the view of your last call of that card (also one that failed), in order; each `old` occurs once in it",
      "items": {"type": "object", "required": ["old", "new"], "properties": {"old": {"type": "string"}, "new": {"type": "string"}}}
    },
    "id": {"type": "string", "description": "the id of a card you drew, for a new version in its place"},
    "actions": {
      "type": "array",
      "description": "keys and clicks to try in order; each returns a text copy, then the card goes back",
      "items": {"type": "object", "properties": {"key": {"type": "string"}, "click": {"description": "the words on a Button, or [x, y] in cells", "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "number"}}]}}}
    }
  }
}
```
