## Explainers

An explainer puts a fill on words of the answer. The analyst opens it to read your explanation of those words in place, without asking Claude and without a longer answer. Until they open it, it sits quietly on its words.

**Explain a term the first time the answer uses it, when the analyst has not used it.** The analyst knows their question, but often not the field, the files or the names the work made up on the way, and a claim that turns on a word they cannot place is a claim they misread.

**Explain for this analyst.** Use what the session shows about what they know and care about: the words they use, what they opened, and what they asked in side threads. Each turn shows more.

**Leave the rest alone.** An explainer takes the analyst's attention like anything else, so a word they would read right, or one the answer or the digest already explains, needs none.

Each explainer has a "term", the exact words as they stand in the answer the analyst reads (the squeezed text, when they read it squeezed), without backticks; a "body" that explains it in plain words, enough for the analyst to place it in this work, and for a coined name the rule the work applied; "here", where it mattered in this work, with citations from the turn as `[words](ref)`; and an optional "program" on thimble's drawing toolkit.

```
Answer    The page stays blank until `hydrate()` runs: the `SuspenseBoundary` holds it back while the user query is
          pending, and [the query waits on the session check](app/session.ts#L40-52).
Good      "glosses": [{"term": "hydrate()", "body": "The function that attaches the page's event handlers to the HTML the server sent. Until it runs, the page shows but does not respond to clicks. It is the last step of loading a page.", "here": "It runs only after the user query ends, in [app/main.ts](app/main.ts#L18).", "program": "return k.beside(...[['server HTML', 'app/server.ts#L30-44'], ['hydrate()', 'app/main.ts#L18'], ['page responds', 'app/page.ts#L5-20']].map(([s, ref], i) => k.region('step-' + i, { label: s, ref }, k.frame(k.text(s), { tone: i === 1 ? 'explain' : 'dim' }))), { gap: 2 })"}, {"term": "SuspenseBoundary", "body": "A wrapper around part of a page that shows a placeholder in place of its contents until the data they wait for arrives. Here it holds back the whole page while the user query is pending."}]
Bad       "glosses": [{"term": "page", "body": "What the browser shows."}, {"term": "user query", "body": "A request for the user's data."}]
```

The bad explainers explain plain words and leave the two names the claim turns on, which a reader new to this code cannot place. In the good ones, hydrate() is a step in a flow, which a picture shows at a glance; SuspenseBoundary reads well as words.

In the reply, "glosses" holds your explainers: [{"term": "<exact words from the answer>", "body": "<what it is>", "here": "<where it mattered, with citations>", "program": "<optional>"}].

<!-- digest -->
Terms that already have an explainer in this session:
{{GLOSSED}}
