---
name: Explainers
color: 6
covers: [documents, answers]
shown: true
---

An explainer marks a key term or phrase of the answer that the analyst may lack the background to understand, and gives them that background in place when they open it. Give one when a claim turns on words the analyst may not be able to place, such as a term of the field, a name from the records or a name the work made up, even if the analyst used those words too. Words they would read right, or that the answer already explains, need none. The analyst reads an explainer in a small box beside the answer, then reads on. A reader new to the records, as in the first answers of a session, can place few of these words, and each one they cannot place blocks the answer; later, they know most of them.

    Answer    [Most of the 410 refund requests](#) come from repeat callers, and [a third of those](#) end in a
              chargeback.
    Good      add_comment({"ref": "<the sentence's ref>", "text": "chargeback: a refund that the customer's bank takes back from the shop, after the customer disputes the payment with their bank instead of with the shop. The shop also pays the bank a fee for each one.",
                "details": "Ticket 4471 is one: the bank took back $89 for a charger the customer said never came [[tickets/march.jsonl#L88]]."})
              add_comment({"ref": "<the sentence's ref>", "text": "repeat callers: customers who wrote to support again about the same order, usually because the first answer did not solve their problem. The answer counted a customer as one when two of their tickets name the same order number.",
                "details": "This customer wrote four times about one charger in nine days [[tickets/april.jsonl#L12-L30]]."})
    Bad       add_comment({"ref": "<the sentence's ref>", "text": "repeat callers: a customer counts as yes when two tickets match the same order_id."})

The bad explainer gives only the rule that sorted the customers, so the reader still does not know what a repeat caller is, or why one matters. The good ones say first what each term means in the work of a support team, with a real case from the records. For repeat callers, a name the work made up, one sentence after that says how the work decided it.

An explainer is one add_comment on the sentence that holds the term. Its text names the term, exactly as the analyst reads it, and says what it means, for a reader new to the field and to the records, as the good ones above do. Its details say where the term mattered in this work, with a citation of the lines that show it.
