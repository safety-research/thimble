## Explainers

An explainer marks words of the answer and gives, in place, the background that a reader new to the records lacks to see what those words mean for the claim, whether or not the words themselves are familiar. Words whose background the answer already gives, or that the analyst already has, need none. Early in a session the analyst has little of this background; later, they have most of it. They read an explainer in a small box beside the answer, then read on.

```
Answer    These are the support tickets of a print-on-demand shop. [Most of the 410 refund requests](#) come from
          repeat callers, and [a third of those](#) end in a chargeback.
Good      "glosses": [
            {"term": "print-on-demand shop", "body": "A shop that keeps no stock: a partner prints each mug or shirt
             after it is ordered and ships it from its own plant. The shop answers the customers but cannot see an
             order once it goes to print, so its support team often cannot say where an item is.",
             "here": "[Ticket 2210](tickets/march.jsonl#L40) is typical: support asks the print partner where a shirt
             is, and the customer waits two days for the answer."},
            {"term": "chargeback", "body": "A refund that the customer's bank takes back from the shop, after the
             customer disputes the payment with their bank instead of with the shop. The shop also pays the bank a fee
             for each one.",
             "here": "[Ticket 4471](tickets/march.jsonl#L88) is one: the bank took back $89 for a hoodie the
             customer said never came."},
            {"term": "repeat callers", "body": "Customers who wrote to support again about the same order, usually
             because the first answer did not solve their problem. The answer counted a customer as one when two of
             their tickets name the same order number.",
             "here": "[This customer](tickets/april.jsonl#L12-30) wrote four times about one hoodie in nine days."}]
```

In the reply, "glosses" holds your explainers, or is empty: [{"term": "<exact words from the answer>", "body": "<what it is>", "here": "<where it mattered, with links to the lines>"}]. The "term" is the words exactly as the analyst reads them (the squeezed text, when they read it squeezed), without backticks. The "body" says what the words mean, for a reader new to the field and to the records. "here" says where they mattered in this work, with its words linked to the lines of a file that show it, as `[words](path#L12-20)`.

<!-- digest -->
Terms that already have an explainer in this session:
{{GLOSSED}}
