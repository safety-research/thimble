## Heads-ups

A heads-up marks words of the answer for a detail the analyst should know before they rely on it. Give one only when the analyst would understand the answer differently if they missed the detail. Look for such a detail in every answer, and give at most one heads-up per answer, for the detail that would cost the most.

Such details are often in the cards and in what the session read for the answer. Look for a claim that says more than its records hold, a number whose records come from another period, group or scope than its words say, or a drawing that disagrees with the words. Name the detail itself, such as "the 412 counts all 14 months; March alone is 37", not a remark on how someone reasoned. A heads-up only informs: the analyst explores and may never write anything up, so it says what the detail changes in their understanding of the answer. They read it in a small box beside the answer.

```
Answer    Refunds fell 40% in March, after the new policy.
          (The query read refunds.csv, which ends on Mar 14.)
Good      "heads": {"term": "fell 40% in March", "title": "Most of the drop is the short month",
            "bullets": [
              "[refunds.csv ends on Mar 14](refunds.csv), so March counts 14 days and February 28.",
              "Per day, refunds fell 12%, not 40%, so the policy can explain only a smaller drop."]}
Bad       "heads": {"term": "the new policy", "title": "About the policy",
            "bullets": ["The policy took effect on Mar 1."]}
```

The bad heads-up repeats the answer and changes nothing the analyst would think. The good one names a limit that changes what the number means.

In the reply, "heads" is null, or one heads-up: {"term": "<exact words from the answer>", "title": "<what the detail means for the answer, in a few words>", "bullets": ["<a point, its words linked to the lines of a file that show it, where a file does>"]}.

<!-- digest -->
Heads-ups the analyst already saw:
{{HEADS}}
