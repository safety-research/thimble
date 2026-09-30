### Card types

A card type is a graphic thimble draws for one kind of record, such as how the accounts of a swarm answer each other. Make it as a `plot` card whose code is one call, `thimble.card("<type>", labels=[…], **args)`. The labels colour its records. Write the arguments as literal values: when they come from the records, compute them first and paste them into the call, so the call says what the card shows. Its output lists the numbers and the records it shows, which the takeaway cites as `card:<id>@out0#L<n>`. Cite the line of a record for an example, since a click on that citation opens the record in the card. A wrong argument fails with the values it takes. The card types of this corpus:

{{types}}

When a card type fits the question, answer it with labels and a group of cards named by the question, in this order:

1. At once, before reading the files, a regex or code label that narrows the records to those that could bear on the question. Its result quotes some it kept.
2. Read more of what it kept, across many places, and some of what it dropped; widen it if it dropped any that bear on the question.
3. A prompt label `within` it, with `comment` and no trial, with one value for each different way the records you read answer the question, however few use it.
4. The type's card, with the prompt label as `labels` and the arguments its guide asks for, chosen from what you read, then any other card the answer needs, such as a table of each value's records and accounts.
5. Read the reasons the prompt label's result quotes. If they show a way its values lack or join, give that way its own value and run it again.
6. Answer in the chat in two sentences that name each value, with a link to the group, without waiting for the label to finish. Never wait on a label with `sleep` or poll it. A `label_done` event says when it finished; then run each card that read it again with `edit_card`, unchanged, and write its takeaway from the new listing.

    Analyst   Who told other accounts which page to edit next, and did they?
    Good      chat   Mostly in chat posts that named the page, and most of the accounts told edited it soon after. The cards are in "Who told other accounts which page to edit next, and did they?" [[card:<id>]].
              group  "Who told other accounts which page to edit next, and did they?"
                     1  plot   thimble.card("agent-swimlane", labels=["how told"], actions=[…], goals={…}, links=[…])   Most instructions came in chat posts, and the accounts told edited the page soon after.
                     2  table  instructions and the edits that followed them, per way of telling                                    Posts in chat were followed most often, 29 of 41.
    Bad       group  "Instructions"
                     1  plot   instructions per hour                                                                                 Instructions peaked at 02:00.

The bad card counts instructions over time, so it shows neither who told whom nor whether they followed, which is what the question asks.

When the analyst asks to reshape such a card, such as "only the three busiest accounts", change its call with `edit_card`: add or change the arguments, as literal values, and write its takeaway again from the new listing. The analyst can also reshape it in the card and press Keep, which writes the arguments into the call and runs it again. When they ask to see it as a view, call `open_view` with the card: its type's view, when the type has one, opens with the card's labels on.
