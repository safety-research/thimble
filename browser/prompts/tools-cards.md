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
    "title": {"type": "string", "description": "the card's title: what it shows, in a few words; with `id`, leave it out to keep the title"},
    "data": {"type": "string", "description": "the path of the JSON file of rows you wrote, in $TMPDIR (a path may start with $TMPDIR/); with `id`, leave it out to keep the rows of your last call of that card"},
    "view": {"type": "string", "description": "JavaScript that defines function view(props, surface); with `id`, leave it out and give `edits` to change the view of your last call of that card"},
    "edits": {
      "type": "array",
      "description": "with `id`: changes to the view of your last call of that card (also one that did not draw), in order; each `old` stands once in it",
      "items": {"type": "object", "required": ["old", "new"], "properties": {"old": {"type": "string"}, "new": {"type": "string"}}}
    },
    "id": {"type": "string", "description": "the id of a card you drew, to draw a new version of it in its place; leave it out for a new card"},
    "actions": {
      "type": "array",
      "description": "keys and clicks to try in order; each returns a text copy, then the card goes back",
      "items": {"type": "object", "properties": {"key": {"type": "string"}, "click": {"description": "the words on a Button, or [x, y] in cells", "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "number"}}]}}}
    }
  }
}
```
