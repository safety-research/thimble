## Claims

The claims graph beside the chat shows each statement of the work that could be true or false, grouped by the question it is about, so the analyst can check one claim at a time with the records it cites. Each cluster opens with one plain sentence that tells a reader new to the data what its question is and why it matters. Give the claims of the answer and of the analyst's message it answers, and none for a plan, a step or a question.

Write each claim as a full sentence that reads alone, in the message's own words, with its numbers and qualifiers. Give a new claim "because": one or two sentences, in the message's words, on what it means and why the message holds it, with the message's citation links `[words](#)` kept as they are, so the analyst who picks it sees why it holds. A claim said again, in any words, is the same claim, and one that says an earlier claim is wrong revises it. A claim that revises another also gives "why": one sentence, in the message's words, on why the earlier claim was wrong. Link a claim to one it supports or that is about the same thing, and name each cluster by the one question it looks into.

```
So far    c2 · k2 · The edits after June 18 favor one side.
Analyst   I'll tell my manager the edits were biased after June 18 and bots drove it. Is that right?
Answer    The tilt is one editor: without Alice's [212 edits](#), the two sides are
          even.
Good      "claims": [
            {"same": "c2", "quote": "the edits were biased after June 18", "by": "analyst"},
            {"claim": "Bots drove the bias in the edits after June 18.", "quote": "bots drove it",
             "by": "analyst", "cluster": "what bots did"},
            {"claim": "The tilt in the edits after June 18 comes from one editor, Alice.",
             "quote": "The tilt is one editor", "cluster": "k2", "revises": "c2",
             "because": "Without Alice's [212 edits](#), the two sides are even."},
            {"claim": "Without Alice's 212 edits, the two sides of the edits after June 18 are even.",
             "quote": "without Alice's 212 edits, the two sides are even", "cluster": "k2",
             "links": [{"to": "#3", "how": "supports"}]}],
          "clusters": [
            {"name": "what bots did", "about": "Whether automated accounts, not people, made
             the edits; it decides who the tilt can be blamed on."}]
Bad       {"claim": "The tilt is one editor", "quote": "The tilt is one editor", "cluster": "analysis"}
```

Read alone, the bad claim does not say which tilt, and "analysis" names no question.

In the reply, "claims" holds this turn's claims in the order said, and #N names the Nth of them. A "quote" is the exact words of the message that say the claim, so thimble can find its citations. A new claim is {"claim": "<a full sentence that reads alone>", "quote": "<exact words>", "by": "analyst" (only for the analyst's), "cluster": "<id, #N for the cluster of the Nth claim, or a new name>", "because": "<why it holds, its citation links kept>", "revises": "<id or #N>", "links": [{"to": "<id or #N>", "how": "supports" | "same topic"}]}. A claim said again is {"same": "<id or #N>", "quote": "<exact words>", "by": "analyst" (only for the analyst's)}. "clusters" holds a cluster's sentence, {"id": "<id>" or "name": "<a new cluster's name>", "about": "<one plain sentence>"}, a rename of a cluster, {"id": "<id>", "name": "<new name>"}, or a split of one that has grown past one question, {"split": "<id>", "name": "<new cluster>", "claims": ["<ids that move>"], "about": "<one plain sentence>"}.

<!-- digest -->
Claims so far (id · cluster · claim):
{{CLAIMS}}

Clusters so far (id · name · size · sentence):
{{CLUSTERS}}
{{GROWN}}
