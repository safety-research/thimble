## The claims of this turn

The analyst sees the work's claims as a graph beside the chat, grouped by what they are about. They select one claim and read it alone, with the rows it cites under it, away from the message that said it. You give this turn's claims, from the analyst's message and everything Claude wrote in the turn.

**A claim is one statement that could be true or false on its own.** Claims are what the analyst has to trust or check, one at a time, whether Claude said them or the analyst did. A sentence can hold several claims, while a qualifier stays with the claim it qualifies: "bots made 4% of the edits after June 18" is one claim. A plan, a step or a question holds none, because nothing in it can be wrong.

**A claim reads as a full sentence on its own.** It names what it is about, says what was measured or compared, and keeps its numbers. Use the message's own words, and add from the words around them only what the claim needs to be understood alone.

**A claim is found by its quote.** Quote the words of the message that say it, exactly, so thimble can find the sentence and the citations that back it. The quote finds the claim; the claim says it.

**A claim keeps its history.** A claim said again, in any words, is the same claim. A claim that says an earlier one is wrong corrects it, and the correction keeps what it corrects, so the analyst sees how often a claim was said and which claim replaced which. "Claims so far" holds every claim of the session.

**A claim can bear on another.** It can support it or be about the same thing, and these links let the analyst follow an argument across the session.

**A cluster is one question the work looks into.** The analyst reads the graph by its clusters, so name each in a few plain words. When a cluster has grown past one question, split or rename it.

```
So far    c2 · k2 · The edits after June 18 favor one side.
Analyst   I'll tell my manager the edits were biased after June 18, and that bots drove it. Anything to fix?
Answer    The tilt is one editor: without Alice's [212 edits](r7#user=Alice@n), the two sides are even, and bots made only [4%](r5#bot=yes@share) of the edits.
Good      "claims": [{"same": "c2", "quote": "the edits were biased after June 18", "by": "analyst"}, {"claim": "Bots drove the bias in the edits after June 18.", "quote": "bots drove it", "by": "analyst", "cluster": "what bots did"}, {"claim": "The tilt in the edits after June 18 comes from one editor, Alice.", "quote": "The tilt is one editor", "cluster": "k2", "revises": "c2"}, {"claim": "Without Alice's 212 edits, the two sides of the edits after June 18 are even.", "quote": "without Alice's 212 edits, the two sides are even", "cluster": "k2", "links": [{"to": "#3", "how": "supports"}]}, {"claim": "Bots made only 4% of the edits after June 18.", "quote": "bots made only 4% of the edits", "cluster": "what bots did", "revises": "#2"}]
Bad       "claims": [{"claim": "The tilt is one editor", "quote": "The tilt is one editor", "cluster": "analysis"}, {"claim": "Without Alice's edits the sides are even, and bots made 4%", "quote": "without Alice's 212 edits, the two sides are even, and bots made only 4% of the edits", "cluster": "analysis"}]
```

Read alone, the first bad claim does not say which tilt; the second joins two statements the analyst would check apart and drops the 212; and "analysis" names no question.

In the reply, "claims" holds this turn's claims in the order said, and #N names the Nth of them: a new claim is {"claim": "<the claim as a full sentence that reads alone>", "quote": "<exact words>", "by": "analyst" (only for the analyst's), "cluster": "<id, or a new name>", "revises": "<id or #N>", "links": [{"to": "<id or #N>", "how": "supports" | "same topic"}]}; a claim said again is {"same": "<id, or #N>", "quote": "<exact words>", "by": "analyst" (only for the analyst's)}. "clusters" holds only a rename, {"id": "<id>", "name": "<new name>"}, or a split, {"split": "<id>", "name": "<new cluster>", "claims": ["<ids that move>"]}.

<!-- digest -->
Claims so far (id · cluster · claim):
{{CLAIMS}}

Clusters so far (id · name · size):
{{CLUSTERS}}
{{GROWN}}
