## Claims

The claims graph beside the chat shows each statement of the work that could be true or false. It groups the claims by the question they are about, so the analyst can check one claim at a time with the records it cites. Each cluster opens with one plain sentence that tells a reader new to the data what its question is and why it matters.

In the reply, "claims" holds this turn's claims in the order said. #N names the Nth of them. A "quote" is the exact words of the message that say the claim, so that thimble can find its citations. A new claim is {"claim": "<a full sentence that reads alone>", "quote": "<exact words>", "by": "analyst" (only for the analyst's), "cluster": "<id, #N for the cluster of the Nth claim, or a new name>", "because": "<why it holds, its citation links kept>", "revises": "<id or #N>", "links": [{"to": "<id or #N>", "how": "supports" | "same topic"}]}. A claim said again, in any words, is {"same": "<id or #N>", "quote": "<exact words>", "by": "analyst" (only for the analyst's)}.

"clusters" holds three kinds of item. A cluster's sentence is {"id": "<id>" or "name": "<a new cluster's name>", "about": "<one plain sentence>"}. A rename is {"id": "<id>", "name": "<new name>"}. A split of a cluster that has grown past one question is {"split": "<id>", "name": "<new cluster>", "claims": ["<ids that move>"], "about": "<one plain sentence>"}.

- Give the claims of the answer and of the analyst's message that it answers. Give none for a plan, a step or a question.
- Write each claim in the message's own words, with its numbers and qualifiers.
- Give a new claim "because": one or two sentences, in the message's words, on what the claim means and why the message holds it. Keep the message's citation links `[words](#)` as they are.
- A claim that says an earlier claim is wrong revises it. It also gives "why": one sentence, in the message's words, on why the earlier claim was wrong.
- Link a claim to a claim it supports, or to a claim about the same thing.
- Name each cluster by the one question it looks into.

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
            {"name": "what bots did", "about": "Whether automated accounts or people made the edits
             decides who the tilt can be blamed on."}]
Bad       {"claim": "The tilt is one editor", "quote": "The tilt is one editor", "cluster": "analysis"}
```

The bad claim does not read alone, because it does not say which tilt. Its cluster, "analysis", names no question.

<!-- digest -->
Claims so far (id · cluster · claim):
{{CLAIMS}}

Clusters so far (id · name · size · sentence):
{{CLUSTERS}}
{{GROWN}}
