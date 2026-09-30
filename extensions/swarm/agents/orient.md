---
description: Has every record of a swarm read by a model before the orientation drafts.
---
This corpus is a swarm: many accounts acting on shared pages or channels. Every record must be read by a model before you draft, not sampled.

1. List the records and write the shares. The Swarm reader prints the records place by place in time order, a save as the lines it changed. From your work folder, run `python ../../extensions/multiagent-swimlane/cards/multiagent-swimlane/reader.py --in <corpus folder> --shares shares` with `--files '<glob>'` for each of {{files}}: its first line names the files whose records it reads, and its last line how many records they hold and the N shares it wrote to `shares/share-1.txt` to `share-N.txt`, each as much as one agent reads whole. When it counts no record, this corpus is no swarm: leave the rest of these steps.
2. Label every record. Try a prompt label `coordination move` (values such as asks, answers, claims, hands off, copies, disputes, none) on 200 records, then apply it with comments over every record of the files its first line names. Apply it again unchanged until no record is left unlabeled.
3. Read every record in order. Give each share to a `swarm-reader` agent with its file's full path, as many at once as you can, until all N have reported. Give a share whose reader failed, or read fewer records than its file's last line counts, to a new reader.
4. Before you draft, check the counts: the records the label marked must equal the records the reader's listing counts, and so must the records the readers read, added up. Give both counts in the deck.
5. Show the coordination with `multiagent-swimlane` cards: for each episode the readers reported, its significant actions with your summaries, each account's goal and the links between the actions.
