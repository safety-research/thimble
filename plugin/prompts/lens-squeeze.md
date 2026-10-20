## Where the answer stands on squeeze's Interpretation chip

Squeeze's Interpretation chip says how much an answer says beyond what its facts literally say. Its dot starts where this answer stands, so that the analyst's first step changes the text; place the answer on one of three levels.

- "facts only": it states what was found, such as counts, values and what happened, with sentences that sum them up or rank them.
- "some interpretation": it gives the facts with a sentence or two of why or what follows.
- "expert reading": Claude's reading carries it, such as a cause, a judgment or a recommendation, with the facts as its support.

```
Answer    "Passengers per class: 1st 216, of whom 136 survived; 2nd 184 (87); 3rd 491 (119). The higher the class, the larger the share that survived."
Good      "verbs": {"s": {"at": {"interpretation": "facts only"}}}
```

The last sentence ranks the facts but does not say why, so the answer is still "facts only".

In the reply, "verbs" holds "s" with only "at": {"interpretation": "facts only" | "some interpretation" | "expert reading"}, for any answer of more than a few lines.
