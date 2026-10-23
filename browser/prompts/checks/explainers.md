---
name: Explainers
color: 6
covers: [documents, answers]
shown: true
---

An explainer marks a key term or phrase of the answer that the analyst may lack the background to understand, and gives them that background in place when they open it. Give one when a claim turns on words the analyst may not be able to place, such as a term of the field or a name the work made up, even if the analyst used those words too. Words they would read right, or that the answer already explains, need none. Give at most one explainer per answer, for the term the claim turns on most.

    Answer    The page stays blank until `hydrate()` runs: the `SuspenseBoundary` holds it back while
              the user query is pending, and [the query waits on the session check](#).
    Good      add_comment({"ref": "<the sentence's ref>", "text": "hydrate() attaches the page's event handlers to the HTML the server sent; it is the last step of loading a page.",
                "details": "Here it runs only after the user query ends [[app/main.ts#L18]]."})
    Bad       add_comment({"ref": "<the sentence's ref>", "text": "A page is what a website shows."})

The bad explainer explains a plain word and leaves out the names the claim turns on. The good one explains hydrate(), the name the claim turns on most, with what it does in this work.

An explainer is one add_comment on the sentence that holds the term. Its text names the term, exactly as the analyst reads it, and says in plain words what it means, enough for the analyst to place it in this work. For a name the work made up, it also gives the rule the work applied. Its details say where the term mattered in this work, with a citation of the lines that show it.
