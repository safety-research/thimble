## Claims

The claims graph beside the chat shows each statement of the work that could be true or false, grouped by the question it is about, so the analyst can check one claim at a time with the rows it cites. Give the claims of the answer and of the analyst's message it answers. A plan, a step or a question holds none.

A claim reads alone as a full sentence. It names what it is about and keeps its numbers and qualifiers, in the message's own words. One sentence can hold several claims that the analyst would check apart. The "quote" is the words of the message that say the claim, exactly, so thimble can find the sentence and the citations behind it.

A claim said again, in any words, is the same claim, and a claim that says an earlier one is wrong revises it. "Claims so far" holds every claim of the session. Link a claim to one it supports or that is about the same thing, so the analyst can follow an argument across the session. A cluster is one question the work looks into, named in a few plain words. Rename or split a cluster that has grown past one question.

```
So far    c2 · k2 · The edits after June 18 favor one side.
Analyst   I'll tell my manager the edits were biased after June 18 and bots drove it. Is that right?
Answer    The tilt is one editor: without Alice's [212 edits](r7#user=Alice@n), the two sides are
          even, and bots made only [4%](r5#bot=yes@share) of the edits.
Good      "claims": [
            {"same": "c2", "quote": "the edits were biased after June 18", "by": "analyst"},
            {"claim": "Bots drove the bias in the edits after June 18.", "quote": "bots drove it",
             "by": "analyst", "cluster": "what bots did"},
            {"claim": "The tilt in the edits after June 18 comes from one editor, Alice.",
             "quote": "The tilt is one editor", "cluster": "k2", "revises": "c2"},
            {"claim": "Without Alice's 212 edits, the two sides of the edits after June 18 are even.",
             "quote": "without Alice's 212 edits, the two sides are even", "cluster": "k2",
             "links": [{"to": "#3", "how": "supports"}]},
            {"claim": "Bots made only 4% of the edits after June 18.",
             "quote": "bots made only 4% of the edits", "cluster": "what bots did", "revises": "#2"}]
Bad       {"claim": "The tilt is one editor", "quote": "The tilt is one editor", "cluster": "analysis"}
```

Read alone, the bad claim does not say which tilt, and "analysis" names no question.

In the reply, "claims" holds this turn's claims in the order said, and #N names the Nth of them. A new claim is {"claim": "<a full sentence that reads alone>", "quote": "<exact words>", "by": "analyst" (only for the analyst's), "cluster": "<id, or a new name>", "revises": "<id or #N>", "links": [{"to": "<id or #N>", "how": "supports" | "same topic"}]}. A claim said again is {"same": "<id or #N>", "quote": "<exact words>", "by": "analyst" (only for the analyst's)}. "clusters" holds only a rename, {"id": "<id>", "name": "<new name>"}, or a split, {"split": "<id>", "name": "<new cluster>", "claims": ["<ids that move>"]}.

<!-- digest -->
Claims so far (id · cluster · claim):
{{CLAIMS}}

Clusters so far (id · name · size):
{{CLUSTERS}}
{{GROWN}}
