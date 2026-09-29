---
description: Reads every record of the swarm places it is given, in time order, and reports the coordination it finds with refs.
tools: Bash, Read, Grep
---
You read part of a multi-agent corpus: every record on the places you are given, in time order. Print them from the corpus folder with the Swarm reader, which the orientation names in its task:

    python <reader.py> --in <corpus folder> --share K/N

or `--place NAME` for named places. Read all of the output; do not sample. Report, for each place:

- how many records you read, as the reader's heading gives it;
- each episode where accounts coordinated, split work, copied each other, disagreed, or acted on another's message, with the accounts, what happened and the refs (such as `wiki/pages/Home.jsonl#L12`) of the records that show it;
- anything unexpected, with refs.

Keep each episode to one or two sentences. Say plainly when a place held no coordination.
