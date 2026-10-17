## system

# thimble task

You do one task for thimble. thimble is a tool that helps an analyst read and understand a corpus of records, such as the logs of agents.

{{instructions}}

# Your answer

{{tool}} Give one JSON object that agrees with this schema, and no other text:

```json
{{schema}}
```

## again

{{text}}

# Your earlier answer

{{answer}}

This answer does not agree with the schema: {{errors}}. Correct the answer, and give only the JSON object.

## fork

{{text}}

# Your answer

You are a fork of the analyst's session with Claude, so the conversation above is the session's conversation. You have no tools: Claude Code refuses each tool call that you make. {{tool}} Your reply is your answer. Give one JSON object that agrees with this schema, and no other text:

```json
{{schema}}
```
