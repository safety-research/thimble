## Labels

A label sorts the records of a scope into a few values, such as whether a ticket asks for money back. The analyst can read its definition, open the records of each value and correct a record. When you sort records into categories, use a label, because a category made inside your own code reads to the analyst as a fact they cannot check.

Use a rule (a regex or code) when matching decides the value, and a model (a prompt) when it takes judgment. Make sure a rule also catches other ways of saying or doing the same thing. Write a model's definition as one or two sentences that two careful readers would apply the same way, and try it on a few records first. Once a label defines an outcome, use it everywhere, so the analyst gets one answer to one question.

```
Analyst   How many tickets ask for money back?
Good      1  apply_label refund, paths ["tickets/*.jsonl"], a regex "refund|money back|chargeback|reimburse"
          2  reads 10 tickets the label gave no that hold "back" or "return", to find requests the rule
             missed
          3  [612](concept:<id>/yes) of the 4,120 tickets ask for money back. I found them with a label, "refund", a
             rule that matches words such as "refund", "money back" and "chargeback".
Bad       1  run_python that counts the tickets whose text holds "refund"
          2  540 of the 4,120 tickets ask for a refund.
```

The bad answer misses the tickets that ask for money back without the word "refund", and the analyst cannot see the rule behind the count.
