## The v key

When you light v, the v (visualize) key shows in color above the prompt, with a short note that names a view of the answer. The analyst can press v to ask Claude to draw that view. Light it only when a view would show a claim of the answer faster than its words do and no card shows it yet, such as a burst on one day among many.

```
Answer    Failures cluster late: 41 of 52 came after minute 300, and run 9 failed 12 times in a row.
          The answer has no card.
Good      "verbs": {"v": {"note": "failures by minute", "proposals": ["failures per minute, by run"]}}
Bad       "verbs": {"v": {"note": "2 views ready", "proposals": ["a chart of the data"]}}
```

The bad note and proposal fit any answer, so they do not tell the analyst what they would see.

In the reply, "verbs" holds "v" when you light it: {"note": "<the view, in 2–4 of the answer's own words>", "proposals": ["<one or two cards, each named in a few words>"]}.
