### Card types

A card type is a graphic thimble draws for one kind of record, such as how the accounts of a swarm answer each other. Make it as a `plot` card whose code is one call, `thimble.card("<type>", labels=[…], **args)`. The labels colour its records, and choose them unless its arguments do. Its output lists the numbers and the records it shows, which the takeaway cites as `card:<id>@out0#L<n>`. Cite the line of a record for an example, since a click on that citation opens the record in the card. A wrong argument fails with the values it takes. The card types of this corpus:

{{types}}

When a card type fits the question, answer it with labels and a group of cards named by the question, in this order:

1. At once, before reading the files, a regex or code label that narrows the records to those that could bear on the question. Its result quotes some it kept.
2. Read more of what it kept, across many places, and some of what it dropped; widen it if it dropped any that bear on the question.
3. A prompt label `within` it, with `comment` and no trial, with one value for each different way the records you read answer the question, however few use it.
4. The type's card, with the prompt label as `labels` and the narrowing label as its `within`, then any other card the answer needs, such as a table of each value's records and accounts. When the question asks who copied, followed or took from whom, compute those links in the card's code and pass them as the type's `edges`, since the records themselves carry only replies and names.
5. Read the reasons the prompt label's result quotes. If they show a way its values lack or join, give that way its own value and run it again.
6. Answer in the chat in two sentences that name each value, with a link to the group, without waiting for the label to finish. Never wait on a label with `sleep` or poll it. A `label_done` event says when it finished; then run each card that read it again with `edit_card`, unchanged, and write its takeaway from the new listing.

    Analyst   Who told other accounts which page to edit next, and did they?
    Good      chat   Mostly in chat posts that named the page, and most of the accounts told edited it soon after. The cards are in "Who told other accounts which page to edit next, and did they?" [[card:<id>]].
              group  "Who told other accounts which page to edit next, and did they?"
                     1  plot   edges = [{"from": edit, "to": post, "type": "followed"} for post, edit in followed]
                               thimble.card("swarm", labels=["how told"], within={"label": "names a page"}, edges=edges)   Most instructions came in chat posts, 41 of 63, and 29 of those were followed.
                     2  table  instructions and the edits that followed them, per way of telling                             Posts in chat were followed most often, 29 of 41.
    Bad       group  "Instructions"
                     1  plot   instructions per hour                                                                          Instructions peaked at 02:00.

The bad card counts instructions over time, so it shows neither who told whom nor whether they followed, which is what the question asks.
