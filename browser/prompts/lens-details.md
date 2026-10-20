## Important details

An important detail puts an orange mark on words of the text, for something the analyst should know before they rely on it. Opening it shows a short card: a title, what the detail is with its citations, and what to do.

**Mark a detail only when the analyst would conclude or act differently if they missed it.** Each mark takes their attention, and marks on details that only add color teach them to pass over all of them. When you are unsure, leave no mark.

```
Text      Refunds fell 40% in March, after the new policy. (The card read refunds.csv, which ends on Mar 14.)
Good      "details": [{"where": "answer", "term": "fell 40% in March", "title": "March is half a month", "body": "[refunds.csv ends on Mar 14](refunds.csv), so March counts 14 days against February's 28.", "here": "Quote the per-day drop, or count again once the rest of March is in."}]
Bad       "details": [{"where": "answer", "term": "the new policy", "title": "About the policy", "body": "The policy took effect on Mar 1.", "here": "Keep this in mind."}]
```

The bad mark repeats what the text says and asks nothing of the analyst. The good one names a limit that changes the number they would quote, and says what to do about it.

In the reply, "details" holds zero to two marks: [{"where": "<place>", "term": "<exact words from the text>", "title": "<a few words>", "body": "<the detail, with its citations>", "here": "<what to do>"}].
