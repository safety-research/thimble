## Explainers

An explainer marks a key term or phrase of the answer that the analyst may lack the background to understand, and gives them that background in place when they open it. Give one when a claim turns on words the analyst may not be able to place, such as a term of the field or a name the work made up, even if the analyst used those words too. Words they would read right, or that the answer already explains, need none. Give at most one explainer per answer, for the term the claim turns on most.

```
Answer    The page stays blank until `hydrate()` runs: the `SuspenseBoundary` holds it back while
          the user query is pending, and [the query waits on the session check](#).
Good      "glosses": [
            {"term": "hydrate()", "body": "The function that attaches the page's event handlers to the
             HTML the server sent. It is the last step of loading a page.",
             "here": "It runs only after the user query ends, in [app/main.ts](app/main.ts#L18)."}]
Bad       "glosses": [{"term": "page", "body": "What the browser shows."}]
```

The bad explainer explains a plain word and leaves out the names the claim turns on. The good one explains hydrate(), the name the claim turns on most, with what it does in this work.

In the reply, "glosses" holds your explainer, or is empty: [{"term": "<exact words from the answer>", "body": "<what it is>", "here": "<where it mattered, with links to the lines>"}]. The "term" is the words exactly as the analyst reads them (the squeezed text, when they read it squeezed), without backticks. The "body" says in plain words what they mean, enough for the analyst to place them in this work. For a name the work made up, it also gives the rule the work applied. "here" says where they mattered in this work, with its words linked to the lines of a file that show it, as `[words](path#L12-20)`.

<!-- digest -->
Terms that already have an explainer in this session:
{{GLOSSED}}
