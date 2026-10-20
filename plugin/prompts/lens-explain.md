## Explainers

An explainer highlights a key term or phrase of the answer that the analyst may lack the background to understand, and gives them that background in place when they open it. Give one when a claim turns on words the analyst may not be able to place, such as a term of the field or a name the work made up, even if the analyst used those words too. Words they would read right, or that the answer already explains, need none.

```
Answer    The page stays blank until `hydrate()` runs: the `SuspenseBoundary` holds it back while
          the user query is pending, and [the query waits on the session check](app/session.ts#L40-52).
Good      "glosses": [
            {"term": "hydrate()", "body": "The function that attaches the page's event handlers to the
             HTML the server sent. Until it runs, the page shows but does not respond to clicks. It is
             the last step of loading a page.",
             "here": "It runs only after the user query ends, in [app/main.ts](app/main.ts#L18).",
             "program": "return k.beside(...[['server HTML', 'app/server.ts#L30-44'],
             ['hydrate()', 'app/main.ts#L18'], ['page responds', 'app/page.ts#L5-20']]
             .map(([s, ref], i) => k.region('step-' + i, { label: s, ref },
             k.frame(k.text(s), { tone: i === 1 ? 'explain' : 'dim' }))), { gap: 2 })"},
            {"term": "SuspenseBoundary", "body": "A wrapper around part of a page that shows a
             placeholder in place of its contents until the data they wait for arrives. Here it holds
             back the whole page while the user query is pending."}]
Bad       "glosses": [{"term": "page", "body": "What the browser shows."},
            {"term": "user query", "body": "A request for the user's data."}]
```

The bad explainers explain plain words and leave out the two names the claim turns on. In the good ones, hydrate() is a step in a flow, which a picture shows at a glance; SuspenseBoundary reads well as words.

In the reply, "glosses" holds your explainers: [{"term": "<exact words from the answer>", "body": "<what it is>", "here": "<where it mattered, with citations>", "program": "<optional>"}]. The "term" is the words exactly as the analyst reads them (the squeezed text, when they read it squeezed), without backticks. The "body" says in plain words what they mean, enough for the analyst to place them in this work. For a name the work made up, it also gives the rule the work applied. "here" says where they mattered in this work, with citations as `[words](ref)`. Give a "program" on thimble's drawing toolkit only when a picture shows the term better than words.

<!-- digest -->
Terms that already have an explainer in this session:
{{GLOSSED}}
