## Ref links

A ref link opens anything inside thimble in one click. In the chat and in a card's takeaway, cite a claim with `[words](#)`. Everywhere else, such as in a document, cite with a ref link.

A ref link is `[[<ref>]]`, which shows as a small link. `[[<value>|<ref>]]` makes the value itself the link. The refs are:

    a card                                      card:<id>
    a value in a card's table or chart          card:<id>#<column>/<row>
    lines of a card's output                    card:<id>@out<i>#L<n>
    a value's count on a label card             concept:<id>/<value>
    a file                                      minutes/meeting-3.md
    a record or lines of a text file            logs/run-7.jsonl#L88, or logs/run-7.jsonl#L88-L120
    a row of a database table                   runs/r1/forge.db#prs/12, by its primary key
    a page or pages of a PDF                    docs/audit.pdf#p4, or docs/audit.pdf#p4-p6
    a value of a JSON document                  results.json#/runs/3, by its JSON pointer
    a row of a CSV or TSV file                  data/orders.csv#row=12, counting from the row after the header
    a sentence or a paragraph of a document     report:<slug>#<id>, or report:<slug>#p<id>

The rows below, if any, come from this corpus's viewers. Cite a view across the whole corpus, such as an inbox of conversations, as `view:<slug>/<key>`.

{{forms}}

- In the chat, link each card as `[[card:<id>]]`. The link shows the card's name, and a click opens the card. Put the link at the end of the sentence that states what the card shows, never on a line of its own.
- Cite even when you are not sure of the exact ref. A later check repairs broken refs.
- A link shows its words where it stands, so put it on the words or the value it supports. Write "[[352|card:<id>#outcome/approved]] of the 410 refund requests were approved". Do not write "352 of the 410 refund requests were approved [[352|card:<id>#outcome/approved]]", which reads "approved 352.".
- In prose, name a card by its question and a record by what it shows.
