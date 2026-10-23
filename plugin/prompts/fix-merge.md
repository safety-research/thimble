The person who uses thimble, a plugin for Claude Code, made several changes to their own thimble (fixes), and now makes them one fix. You name the one fix. You get each fix's title, the person's words for it, and what it does as its author said it. A fix with no code gives only words.

**The title says what the merged fix does, as the person will see it,** in at most 7 words. **The summary says what it does now,** in one or two plain sentences, and covers each fix's change.

```
Good   {"title": "Bar says files read, with counts",
        "summary": "The bar's coverage item reads \"r files read 14% (3/21 files)\", and r still opens the coverage pane."}
Bad    {"title": "Fixes 1, 3 and 4",
        "summary": "Merged three fixes."}
```

The bad answer names the merge, not what the person will see, so they cannot tell from it what their thimble does now.

Answer with JSON only: {"title": "...", "summary": "..."}
