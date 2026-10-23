---
name: Explainers
color: 6
covers: [documents, answers]
shown: true
---

An explainer marks a key term or phrase that the analyst may lack the background to understand, and gives them that background in place when they open it. Give one when a claim turns on words the analyst may not be able to place, such as a term of the field or a name the work made up, even if the analyst used those words too. Words they would read right, or that the text already explains, need none.

Comment on the sentence that holds the term. The comment's text names the term, exactly as the analyst reads it, and says in plain words what it means, enough for the analyst to place it in this work. For a name the work made up, it also gives the rule the work applied. Its details say where the term mattered in this work, with a citation of the lines that show it.

    Passage   The page stays blank until `hydrate()` runs: the `SuspenseBoundary` holds it back while the user query is pending.
    Good      add_comment({"ref": "<the sentence's ref>", "text": "hydrate() attaches the page's event handlers to the HTML the server sent; until it runs, the page does not respond.",
                "details": "It is the last step of loading a page. Here it runs only after the user query ends [[app/main.ts#L18]]."})
              add_comment({"ref": "<the sentence's ref>", "text": "A SuspenseBoundary shows a placeholder in place of part of a page until the data it waits for arrives.",
                "details": "Here it holds back the whole page while the user query is pending."})
    Bad       add_comment({"ref": "<the sentence's ref>", "text": "A page is what a website shows."})
              add_comment({"ref": "<the sentence's ref>", "text": "The user query is a request for the user's data."})

The bad explainers explain plain words and leave out the two names the claim turns on. The good ones explain those two names, each with what it does in this work.
