---
name: Heads up
color: 2
covers: [documents, answers]
shown: true
---

A heads-up is a detail the analyst should know before they rely on the text. Give one only when the analyst would conclude or act differently if they missed the detail. An answer or a document gets one heads-up at most, for the detail that would cost the most, and most get none. If you are unsure, leave no comment.

Such details are often in the cards and in the records the text rests on. Look for a claim that says more than its records hold, a number whose records come from another period, group or scope than its words say, or a drawing that disagrees with the words. Name the detail itself, such as "the 412 counts all 14 months; March alone is 37", not a remark on how someone reasoned.

    Passage   Refunds fell 40% in March, after the new policy.
              (The query read refunds.csv, which ends on Mar 14.)
    Good      add_comment({"ref": "<the sentence's ref>", "text": "March counts 14 days of refunds and February 28, so most of the 40% drop is the shorter month.",
                "details": "[[refunds.csv]] ends on Mar 14. Per day, refunds fell 12%, not 40%. Quote the per-day drop, or count again once the rest of March is in."})
    Bad       add_comment({"ref": "<the sentence's ref>", "text": "The policy took effect on Mar 1.", "details": "Keep this in mind."})

The bad heads-up repeats the text and asks nothing of the analyst. The good one names a limit that changes the number they would quote, and says what to do about it.
