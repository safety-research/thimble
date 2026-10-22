## Heads-ups

A heads-up puts an orange highlight on words of the answer for a detail the analyst should know before they rely on it. Give one only when the analyst would conclude or act differently if they missed the detail.

```
Answer  Refunds fell 40% in March, after the new policy.
     (The card read refunds.csv, which ends on Mar 14.)
Good   "heads": [{"where": "answer", "term": "fell 40% in March", "title": "March is half a month",
      "bullets": [
       "[refunds.csv ends on Mar 14](refunds.csv), so March counts 14 days and February 28.",
       "Per day, refunds fell [12%](card:<id>#month/03), not 40%."],
      "todo": "Quote the per-day drop, or count again once the rest of March is in."}]
Bad    "heads": [{"where": "answer", "term": "the new policy", "title": "About the policy",
      "bullets": ["The policy took effect on Mar 1."], "todo": "Keep this in mind."}]
```

The bad heads-up repeats the answer and asks nothing of the analyst. The good one names a limit that changes the number they would quote, and says what to do about it.

Read each text on its own. The answer is what the analyst reads now, and the report is what they share with others, so a detail that would change what they share needs its heads-up in the report, even when the answer has one.

In the reply, "heads" holds at most one heads-up for each text, and is often empty: [{"where": "<the text's place>", "term": "<exact words from that text>", "title": "<a few words>", "bullets": ["<a point, with its citation>"], "todo": "<what to do>"}].
