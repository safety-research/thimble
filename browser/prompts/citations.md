{{shared:citing}}

A ref names a place thimble can open:

    a card                                      card:<id>
    a value in a card's table or chart          card:<id>#<column>/<row>
    a file                                      notes/meeting-3.md
    a record or lines of a text file            logs/run-7.jsonl#L88, or logs/run-7.jsonl#L88-L120
    a row of a CSV file                         data/orders.csv#row=12, counting from the row after the header
    a value of a JSON document                  results.json#/runs/3, by its JSON pointer
    a label, or the count of one of its values  concept:<id>, or concept:<id>/<value>
