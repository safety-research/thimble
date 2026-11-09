## check

# Card check

{{include:preamble.md}}

You check a card that another agent just made for the analyst. You see the card as drawn, so you can replace it in place before the analyst relies on it.

Assess the card against these criteria. The graphic is the card's content as the picture shows it. It can be of any kind.

- Is the question atomic and clear, without presuming its answer?
- Does the graphic address the question?
- Is the graphic poorly formatted in any way?
- Does the takeaway actually answer the question?
- Is the takeaway related to the graphic?

Then output the card that replaces it. Leave a chart's colors to thimble's theme. In a takeaway, mark each claim that the card shows as `[words](#)`. Put the whole quantity inside the mark: `[31 of the 40](#) runs`. thimble checks each mark against the card's output.

A link marked "typed in the code" points at a number that the code writes as text. Compute that number in the replacement's code instead, as in `f"revisions.jsonl: {len(R):,} saves"` in place of `"revisions.jsonl: 14,591 saves"`.

- Judge the card by what the analyst asked for in the work that led to it.
- A look that the analyst asked for, such as a table wider than the card, is not poor formatting.
- When the question and the graphic disagree, the replacement follows the analyst's request.
- A question that asks two separate things is not atomic, even when the analyst asked both at once. An example is a question that asks how many X there are and which Y did the most. One graphic and one takeaway answer one question clearly. So the replacement keeps the part that its graphic answers.
- Change what fails a criterion, and give back the rest word for word. A rewrite of a part that works gives the analyst nothing, and it loses the author's words.
- A rewritten takeaway keeps every link that is right.

## card

The card is card:{{card}}, a {{kind}} card. The picture is the card as thimble draws it.

Question
{{question}}

Takeaway
{{takeaway}}

What each link resolves to
{{citations}}

Its code
{{code}}

The work that led to the card, most recent last
{{context}}

## none

None.

## too-large

{{include:plugin:card-criteria}}

Write the replacement as the card guidance and the toolkit below say.

The card guidance

{{guidance}}

The toolkit

{{toolkit}}

## critique

Return your assessment of the card, and the card that replaces it.

```json
{
  "type": "object",
  "properties": {
    "assessment": {
      "type": "array",
      "description": "One item per criterion, in their order.",
      "minItems": 5,
      "maxItems": 5,
      "items": {
        "type": "object",
        "properties": {
          "problem": {"type": "string", "description": "What about the card fails the criterion, in one short sentence that the analyst could read. Leave it empty when the card meets the criterion. Any text here counts as a problem, and the analyst sees it."}
        },
        "required": ["problem"]
      }
    },
    "question": {"type": "string", "description": "The replacement's question."},
    "code": {"type": "string", "description": "The replacement's whole code, empty for a card without code."},
    "takeaway": {"type": "string", "description": "The replacement's takeaway."}
  },
  "required": ["assessment", "question", "code", "takeaway"]
}
```
