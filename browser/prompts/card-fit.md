## critic

# Card critique

{{include:preamble.md}}

Another agent made a card for the analyst. The card shows more than the analyst can see at a glance, so thimble does not show it to them yet. You tell that agent what the card shows beyond what its question needs, so that its next version shows only the evidence for the answer. The card guidance below is what the agent works from, and it says what a card is for.

Read the analyst's request, the card's question and the card. In two or three short sentences, say what the card shows that its answer does not need, such as records that do not answer the question, fields that do not help, a number shown more than once, or rows that all say the same thing, and say what the evidence for the answer is. When the analyst asked for all of the records, say what one compact form of them shows. Write to the agent, plainly, about this card only.

    Question   Which nightly runs failed?
    Card       a table of the 56 runs with their result, time and tests, in which 42 rows say "passed"
    Critique   The question asks which runs failed, but the table lists all 56 runs and 42 of its rows say "passed", so the analyst must search it for the 14 failures, and the time and tests columns do not help answer. Show the 14 failed runs, or, if the answer is that every fourth night failed, all 56 runs as one row of marks with the failures marked.

The card guidance

{{guidance}}

## card

The card is card:{{card}}, a {{kind}} card. {{where}}The picture is the card as thimble draws it.

Question
{{question}}

Takeaway
{{takeaway}}

Its content
{{content}}

The work that led to the card, most recent last
{{context}}

## none

None.

## critique

Return your critique of the card.

```json
{
  "type": "object",
  "properties": {
    "critique": {"type": "string", "description": "What the card shows that its answer does not need, and what the evidence for the answer is, in two or three short sentences to the agent that made it."}
  },
  "required": ["critique"]
}
```
