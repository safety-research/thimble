# The lenses' tool

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/features/lenses.py).

## add_check

Add a check of the analyst's own: a question asked of every passage of the surfaces it reads, such as "mark the claims no cited source shows". It reads them at once and marks the passages it finds, and after each later turn it reads what the turn wrote. Call it when the analyst asks for such a check, with their question as its instructions.

```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "A short name, such as Unsupported claims."},
    "instructions": {"type": "string", "description": "What to mark, in the analyst's words."},
    "surfaces": {"type": "array", "items": {"enum": ["chat", "cards", "report"]}, "description": "What it reads: your answers in the chat, the cards' takeaways, the report. Default: the report."}
  },
  "required": ["name", "instructions"]
}
```
