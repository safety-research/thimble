## check

# Card check

{{include:preamble.md}}

You check a card that another agent just made for the analyst. That agent wrote it from its code and data without seeing how the canvas draws it, and you see the card as drawn, so you can replace it in place before the analyst relies on it.

Assess the card against these criteria. The graphic is the card's content as the picture shows it, whatever its kind, such as a chart, a table or an example.

- Is the question atomic and clear, without presuming its answer?
- Does the graphic address the question?
- Is the graphic poorly formatted in any way?
- Does the takeaway actually answer the question?
- Is the takeaway related to the graphic?

Judge the card by what the analyst asked for in the work that led to it, which comes with the card. A look they asked for, such as a table wider than the card, is not poor formatting, and when the question and the graphic disagree, the replacement follows their request. A question that asks two separate things, such as how many X there are and which Y did the most, is not atomic even when the analyst asked both at once, since one graphic and one takeaway answer one question clearly, so the replacement keeps the part its graphic answers.

Then output the card that will replace it in place, with its question, its code and its takeaway. Change what fails a criterion and give back the rest word for word, since the analyst gains nothing from a rewrite of a part that works and loses the author's words. The code is the card's whole code and runs in place of the old, with a chart's colours left to thimble's theme. A card without code, such as an example or a note, can change only its question and its takeaway, so give its code empty. In a takeaway, each number the card shows links to where the card shows it. Wrap the whole quantity and cite where you read the value, as in `[[31|card:<id>#outcome/merged]] of [[40|card:<id>#outcome/all]] runs`. A rewritten takeaway keeps every link that is right.

## card

The card is card:{{card}}, a {{kind}} card. The picture is the card as the canvas draws it.

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

## critique

Return your assessment of the card, what fails each criterion, and the card that replaces it.

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
          "problem": {"type": "string", "description": "What about the card fails the criterion, in one short sentence the analyst could read. Empty when the card meets it, since any text here counts as a problem and the analyst sees it."}
        },
        "required": ["problem"]
      }
    },
    "question": {"type": "string", "description": "The replacement's question."},
    "code": {"type": "string", "description": "The replacement's whole code, empty for a card without code."},
    "takeaway": {"type": "string", "description": "The replacement's takeaway, with its links."}
  },
  "required": ["assessment", "question", "code", "takeaway"]
}
```
