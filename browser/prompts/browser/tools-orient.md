# The orientation's tools

Each `## <tool>` section is one tool, in the same form as tools.md (server/thimble_browser/orient.py and calls.py).

## start_orientation

Start an orientation, a broad analysis of the folder that helps the analyst understand it. It runs on its own, beside you, and leaves its findings as cards in the group `Orientation`. thimble shows it as a thread under main. Call it when the analyst asks for an orientation, or when their question needs a broad analysis of the folder, such as "what's going on in this dataset?", and then answer what you can yourself while it runs, with a quick look and a few cards. Answer a narrower question yourself. A new orientation adds to the cards the earlier ones left. Call `message_orientation` to explore further within one that has finished. One orientation runs at a time, so while one runs the call starts nothing. Once it has started, say nothing more about it than one line, since thimble shows it.

```json
{
  "type": "object",
  "properties": {
    "brief": {"type": "string", "description": "The analyst's request in their words, such as a focus, or empty for the whole folder."}
  }
}
```

## message_orientation

Send the orientation a message, such as a question its analysis did not answer, which continues it with its whole analysis in context and revises its cards where the answer changes them. A message sent while it runs reaches it when its current run ends. Call it when the analyst asks for more from the orientation, and answer yourself what its cards already answer. Call `start_orientation` only for a new orientation.

```json
{
  "type": "object",
  "properties": {
    "message": {"type": "string", "description": "What the analyst asks the orientation, in their words."}
  },
  "required": ["message"]
}
```

## critique

Have a critic review your whole analysis, from your thread, and the cards you drafted, for files and fields you never opened, rival accounts you did not test and claims no call supports. The critic changes nothing. The call waits for its review, which can take several minutes, and returns its report.

```json
{
  "type": "object",
  "properties": {
    "context": {"type": "string", "description": "Your account of the folder, the hypothesis and findings your drafts present, and what you could not read, in a few sentences."}
  },
  "required": ["context"]
}
```
