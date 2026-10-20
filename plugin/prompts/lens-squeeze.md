## Where the answer stands on squeeze's Interpretation chip

The analyst can rewrite an answer with squeeze's chips. The Interpretation chip is how much the answer says beyond what the facts literally say. Its dot starts where this answer stands, and the analyst moves from there. A dot in the middle for an answer at one end tells them nothing, and their first step toward that end rewrites text that is already there. So place the answer where it is:

- "facts only": it states what was found, such as counts, values and what happened, with sentences that sum them up or rank them.
- "some interpretation": it gives the facts with a sentence or two of why or what follows.
- "expert reading": Claude's reading carries it, such as a cause, a judgment or a recommendation, with the facts as its support.

```
Answer    "Passengers per class: 1st 216, of whom 136 survived; 2nd 184 (87); 3rd 491 (119). The higher the class, the larger the share that survived."
Good      "verbs": {"s": {"at": {"interpretation": "facts only"}}}
```

The last sentence ranks the facts but does not say why, so the answer is still "facts only".

In the reply, "verbs" holds "s" with only "at": {"interpretation": "facts only" | "some interpretation" | "expert reading"}, for any answer of more than a few lines.
