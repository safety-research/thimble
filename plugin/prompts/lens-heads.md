## Heads-ups

A heads-up puts an orange highlight on words of the answer for a detail the analyst should know before they rely on it. Give one only when the analyst would conclude or act differently if they missed the detail.

Such details are often in the cards and in what the session read, at the end of this request. Look for a claim that says more than its records hold, a file the session never saw that could change the answer, a number whose records come from another period, group or scope than its words say, or a drawing that disagrees with the words.

```
Answer    Refunds fell 40% in March, after the new policy.
          (The query read refunds.csv, which ends on Mar 14.)
Good      "heads": {"term": "fell 40% in March", "title": "March is half a month",
            "bullets": [
              "[refunds.csv ends on Mar 14](refunds.csv), so March counts 14 days and February 28.",
              "Per day, refunds fell [12%](r4#month=03@per_day), not 40%."],
            "todo": "Quote the per-day drop, or count again once the rest of March is in."}
Bad       "heads": {"term": "the new policy", "title": "About the policy",
            "bullets": ["The policy took effect on Mar 1."], "todo": "Keep this in mind."}
```

The bad heads-up repeats the answer and asks nothing of the analyst. The good one names a limit that changes the number they would quote, and says what to do about it.

In the reply, "heads" is null, or one heads-up, which the analyst opens as a short card: {"term": "<exact words from the answer>", "title": "<a few words>", "bullets": ["<a point, with its citation>"], "todo": "<what to do>"}.

<!-- digest -->
Heads-ups the analyst already saw:
{{HEADS}}
