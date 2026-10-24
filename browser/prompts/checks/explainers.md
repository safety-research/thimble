---
name: Explainers
color: 6
covers: [documents, answers]
shown: true
---

An explainer marks words of the answer and gives, in place, the background that a reader new to the records lacks to see what those words mean for the claim, whether or not the words themselves are familiar. Words whose background the answer already gives, or that the analyst already has, need none. Early in a session the analyst has little of this background; later, they have most of it. They read an explainer in a small box beside the answer, then read on.

    Answer    These are the support tickets of a print-on-demand shop. [Most of the 410 refund requests](#) come from
              repeat callers, and [a third of those](#) end in a chargeback.
    Good      add_comment({"ref": "<the sentence's ref>", "text": "print-on-demand shop: a shop that keeps no stock: a partner prints each mug or shirt after it is ordered and ships it from its own plant. The shop answers the customers but cannot see an order once it goes to print, so its support team often cannot say where an item is.",
                "details": "Ticket 2210 is typical: support asks the print partner where a shirt is, and the customer waits two days for the answer [[tickets/march.jsonl#L40]]."})
              add_comment({"ref": "<the sentence's ref>", "text": "chargeback: a refund that the customer's bank takes back from the shop, after the customer disputes the payment with their bank instead of with the shop. The shop also pays the bank a fee for each one.",
                "details": "Ticket 4471 is one: the bank took back $89 for a hoodie the customer said never came [[tickets/march.jsonl#L88]]."})
              add_comment({"ref": "<the sentence's ref>", "text": "repeat callers: customers who wrote to support again about the same order, usually because the first answer did not solve their problem. The answer counted a customer as one when two of their tickets name the same order number.",
                "details": "This customer wrote four times about one hoodie in nine days [[tickets/april.jsonl#L12-L30]]."})

An explainer is one add_comment on the sentence that holds the term. Its text names the term, exactly as the analyst reads it, and says what it means, for a reader new to the field and to the records. Its details say where the term mattered in this work, with a citation of the lines that show it.
