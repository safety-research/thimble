## Explainers

An explainer marks a key term or phrase of the answer that the analyst may lack the background to understand, and gives them that background in place when they open it. Give one when a claim turns on words the analyst may not be able to place, such as a term of the field, a name from the records or a name the work made up, even if the analyst used those words too. Words they would read right, or that the answer already explains, need none. A reader new to the records, as in the first answers of a session, can place few of these words, and each one they cannot place blocks the answer; later, they know most of them.

```
Answer    [Most of the 410 refund requests](#) come from repeat callers, and [a third of those](#) end in a
          chargeback.
Good      "glosses": [
            {"term": "chargeback", "body": "A refund that the customer's bank takes back from the shop, after the
             customer disputes the payment with their bank instead of with the shop. The shop also pays the bank a fee
             for each one.",
             "here": "[Ticket 4471](tickets/march.jsonl#L88) is one: the bank took back $89 for a charger the
             customer said never came."},
            {"term": "repeat callers", "body": "Customers who wrote to support again about the same order, usually
             because the first answer did not solve their problem. The answer counted a customer as one when two of
             their tickets name the same order number.",
             "here": "[This customer](tickets/april.jsonl#L12-30) wrote four times about one charger in nine days."}]
Bad       "glosses": [{"term": "repeat callers", "body": "A customer counts as yes when two tickets match the same
             order_id."}]
```

The bad explainer gives only the rule that sorted the customers, so the reader still does not know what a repeat caller is, or why one matters. The good ones say first what each term means in the work of a support team, with a real case from the records. For repeat callers, a name the work made up, one sentence after that says how the work decided it.

In the reply, "glosses" holds your explainers, or is empty: [{"term": "<exact words from the answer>", "body": "<what it is>", "here": "<where it mattered, with links to the lines>"}]. The "term" is the words exactly as the analyst reads them (the squeezed text, when they read it squeezed), without backticks. The "body" is for a reader new to the field and to the records: it says first what the words mean in the field the records come from, with a concrete case, and for a name the work made up, one sentence after that gives the rule the work applied. Explain any other word the body needs that such a reader may not know, or say it another way. "here" says where they mattered in this work, with its words linked to the lines of a file that show it, as `[words](path#L12-20)`.

<!-- digest -->
Terms that already have an explainer in this session:
{{GLOSSED}}
