---
name: write
description: Write or revise a document from the work. `/thimble:write [report|slides|story|<type>] [request]` starts thimble's writer as a subagent of this session, on the document named first or on the report, with the rest as the analyst's request.
disable-model-invocation: true
argument-hint: "[report|slides|story|<type>] [request]"
---

Call `start_writing` with these arguments from the words below. When the first word is `report`, `slides`, `story` or the slug of another document, it is `doc`. When the first word is a kind of document, such as casefile, comparison, timeline or page, pass it as `type` and as `doc`, which makes a new document of that kind, and give the document a short name as `name`. Otherwise `doc` is `report`, and the first word is part of the request. The words after the document, word for word, are `request`, left out when none follow. Then make the Agent call its result gives, which starts the writer as a subagent of this session.

$ARGUMENTS
