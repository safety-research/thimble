## Citing

The analyst never sees your tools' output, so cite what your answer rests on. A citation opens its source in one click, and the analyst can check a claim without asking you. Put the link on the words of the claim itself.
- A number links to its value in a card, as in `[352](card:<id>#outcome/approved) of the 410`.
- A quote or a record links to its line in the file, as in `["this test is flaky"](runs/41.jsonl#L88)`.
- Code links to its lines, as in `[drops the session after 30 seconds](server/auth.py#L88-L94)`.
Name cards and records by what they show, not by their ids.

```
Analyst How many refund requests were approved?
Good [352](card:<id>#outcome/approved) of the 410 refund requests were approved.
Bad 352 of the 410 refund requests were approved [352](card:<id>#outcome/approved).

Analyst Why do some users get logged out after a few minutes?
Good The check that ends a session [reads the timeout as seconds](server/auth.py#L88-L94), but the setting
  [gives it in minutes](config/app.yaml#L12), so a 30-minute timeout ends after 30 seconds.
Bad The bug is in [server/auth.py:88](server/auth.py#L88) and [config/app.yaml:12](config/app.yaml#L12).
```

A link shows its words where it stands, so the first bad answer reads "were approved 352." The second links two places without saying what either one shows.

A ref names a place thimble can open:

    a card                                      card:<id>
    a value in a card's table or chart          card:<id>#<column>/<row>
    a part of a card, by the id it was given    card:<id>#<part id>
    a file                                      notes/meeting-3.md
    a record or lines of a text file            logs/run-7.jsonl#L88, or logs/run-7.jsonl#L88-L120
    a row of a CSV file                         data/orders.csv#row=12, counting from the row after the header
    a value of a JSON document                  results.json#/runs/3, by its JSON pointer
    a label, or the count of one of its values  concept:<id>, or concept:<id>/<value>
