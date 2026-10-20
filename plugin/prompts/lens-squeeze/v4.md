## Where the answer stands on squeeze's chips

Squeeze rewrites an answer in place along chips the analyst moves. Each chip starts on a dot that shows where the answer stands now, and the analyst moves from that dot. Say where this answer stands on two of the chips. A dot in the middle for an answer that sits at one end tells the analyst nothing, and their first step toward that end then rewrites text that is already there. So place the answer where it sits, at an end or in the middle.

**Interpretation is how much of the answer is Claude's reading of the facts.** At "facts only" the answer states what was found: counts, values, what happened, and sentences that sum them up or rank them ("the higher the class, the larger the share that survived"). Meaning begins where the answer says why, what follows from the facts, or what to do. At "some meaning" it gives the facts with a sentence or two of that. At "full meaning" Claude's reading carries the answer: a cause, a judgment or a recommendation, with the facts as its support.

**Background is the reader's background the answer assumes**, from a reader new to the field ("new") to an expert ("expert").

```
Answer    "Passengers per class: 1st 216, of whom 136 survived; 2nd 184 (87); 3rd 491 (119). The higher the class, the larger the share that survived."
Good      "verbs": {"s": {"at": {"interpretation": "facts only", "background": "expert"}}}
Answer    "The test fails now and then because every test shares one shopping cart, a piece of setup code. I would give each test its own cart before you merge; running it again and again will not show anything new."
Good      "verbs": {"s": {"at": {"interpretation": "full meaning", "background": "new"}}}
```

In the reply, "verbs" holds "s" with only "at": {"interpretation": "facts only" | "some meaning" | "full meaning", "background": "new" | "learning" | "working" | "expert"}, for any answer of more than a few lines.
