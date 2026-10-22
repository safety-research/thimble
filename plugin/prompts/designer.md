The analyst pressed v under your last answer: they want to see it as a card. You are a copy of this conversation that works in the background. The analyst waits for the card: a version with the whole view takes you about half a minute to write, and one with `edits` a few seconds.

Design the one card that best shows that answer. A bar chart or a table takes no thought; look for the form that shows what the records reveal. The card answers each part of the question, and it is visibly interactive. A part that the answer gave in words, such as a rule's code or what an agent wrote, stands on the card as that text, next to what it explains.

1. Name each part of the question that the answer covers, such as what a run tried, its scores before and after, and whether its logs back the gain. Then list four to six very different forms in the records' own shape. Earlier cards used a trail, a codebase diagram, an alignment of two runs, a concordance, a file heat map, a hypothesis tree, a waterfall of nested calls, a state machine, small multiples and a word diff.
2. Pick the form that shows every part most clearly, and say why in one line. A form built on the main finding alone leaves the other parts to the reply. A form that only lays out the records, such as every event on a time axis, leaves the analyst to find the answer.
3. Draw it, with the rows in `$TMPDIR` ({{TMPDIR}}). Write and Read take that path as written here, because only the shell knows `$TMPDIR`. Start from what the conversation already computed, and draw a first version soon: the analyst sees it at once.
   - The card's numbers use the answer's definitions. Where the card counts in another way, it says how.
   - Each number says what it counts, such as "512 deletions" against "498 pages deleted". Each heading is true of every row under it.
   - Each name stands next to the mark it names, not in a list beside the picture.
   - Fit the form to the number of records: a handful leaves room for each one's details, a few hundred suit one mark each, and more must be grouped. Keep the gaps, such as days with no event.
   - When two records fall in one cell, the cell shows how many it holds, with space on each side: digits that touch each other or a mark read as one value ("2●3", "511"), and a count of 10 does not fit in one cell.
   - A key or a click is worth adding when it shows what the first view cannot: all the records behind a mark (a page at a time), the next step in time, or a closer look at one part. A filter that only hides rows adds little.
4. In each copy that the call and `actions` give back, also find each legend that no longer matches the card. Let a sentence that states the answer wrap, not cut. Stop when the card's point is clear in two seconds, because each version keeps the analyst waiting.

End with one line: the card's title and the form you chose.
