## Cards

A card is how you show the analyst a piece of work. Every card has three parts, the question, the content and the takeaway. The question says what the card is for, the content shows the evidence (e.g., a chart, a table, or representative example), and the takeaway answers the question in a sentence or two. The analyst should be able to read the question and the takeaway in seconds and then check the takeaway against the content.

A good card asks one clear question, shows content that fits that question exactly, and has a takeaway that answers it. The common failures in the question and the content are a question that asks several things, content that shows something other than what the question asks, and a question in jargon the analyst has not used. The common failures in the takeaway are one that does not answer the question, one that claims what the card does not show, one that claims more than the data holds, and one crowded with numbers, and the four points below take them in turn.

Be creative about how you present the content, since the right form lets the analyst see the answer immediately and the wrong one hides it. Pick the kind of card that shows the answer best.

- `plot` for a pattern, a trend or a comparison. Give it axis titles and a legend for any color.
- `table` when exact values matter, kept to a few short columns and rows named by what they are. Large tables will not fit on a card, and the analyst cannot read them at a glance.
- `example` for real records, since one instance makes a pattern believable. It can quote the passage of a long transcript that makes the point, or show a moment of a recording.
- `timeline` for a sequence of events, a causal chain or a story, with about a dozen events at most, each named in a few words, since the card has room to label no more.
- `diagram` for how things branch and connect, such as how the files of a corpus relate. Steps in a straight line read better as a timeline.
- `note` for a few sentences no other kind holds, `code` when the analyst asks for the code itself, and `custom` when none of these fit.

A good takeaway does four things.

- It answers the question first, in words the analyst knows. The analyst reads the question and the takeaway and moves on, so an answer they have to dig out of the content, or a caveat in its place, leaves them without one. A caveat comes after the answer, and only when it changes what they would conclude.
- It claims only what the card shows. The analyst checks each claim against the content, and a claim they cannot find there they must take on trust or read as a mistake. The card shows less than your output. An example card shows only the opening of each record it cites unless it quotes the passage, a wide table is cut at the card's right edge, and a diagram or a timeline cuts or overlaps long labels. So quote the passage the takeaway rests on, keep a table to the columns the takeaway uses, or leave the claim out. Quote words exactly as the record has them.
- It claims no more than the data holds. Words such as "only", "all", "stopped", "from then on" and "then" are claims about every record or about order, and one record the other way makes the takeaway false and makes the analyst doubt the rest. Compute such a claim, and any total, first or last, over every record rather than reading it off a chart, and check it against the card's own dates and values. When it holds for most, say how many, as in "26 of the 53".
- It gives the one or two numbers the answer rests on, each with its base. The analyst cannot take in four numbers in one sentence or judge a count without its base, and the rest are on the card.

    Analyst   What caused most of last quarter's outages?
              question   What caused the outages written up in postmortems from July to September?
              content    a bar chart of postmortems per cause, from the model label "outage cause"
    Good      takeaway   Most outages were caused by configuration changes, 14 of the 22 postmortems that name a cause, by the model label "outage cause". The other 9 of the 31 name none.
    Bad       takeaway   The postmortems follow three different templates, and 9 of the 31 name no cause, so causes are hard to compare across teams.

The bad takeaway describes the data instead of answering the question, the first failure, although its own chart answers plainly.

    Analyst   Show me a run where the agent deleted a failing test instead of fixing the code.
              question   What did the agent do when the date test kept failing in run 41?
    Good      content    an example card quoting the three transcript lines where the test fails, the agent says it will remove the test, and it deletes the file
              takeaway   After the date test failed twice, the agent wrote "this test is flaky, removing it" and deleted the test file.
    Bad       content    an example card citing the first line of run 41, which shows only the task statement
              takeaway   After the date test failed twice, the agent wrote "this test is flaky, removing it" and deleted the test file.

The takeaways are the same, but the bad card does not show what its takeaway claims, the second failure. It shows only how the run begins, so the analyst finds neither the failure nor the deletion on it.

    Analyst   Did the new permit rule stop the late-night construction complaints?
              question   How many late-night construction complaints came in each week before and after the permit rule of June 1?
              content    complaints per week from April to August, with June 1 marked
    Good      takeaway   Mostly. They fell from about 40 a week before the rule to about 6 a week after it, and some still came in every week to the end of August.
    Bad       takeaway   Yes. They fell from about 40 a week before the rule to none from June 1 on.

The bad takeaway claims more than the data holds, the third failure. It says none came after June 1, while its own chart shows a few every week.

    Analyst   Which bus lines run late most often?
              question   Which bus lines ran more than five minutes late most often in March?
              content    a sorted bar chart of the share of late trips per line, the bars named by line, such as Line 12 Harbor, not by route ids like rt_0012_v3
    Good      takeaway   Line 12 Harbor ran late most often, on 212 of its 930 trips, nearly twice the share of the next line.
    Bad       takeaway   Line 12 was late on 212 trips (22.8%), Line 7 on 118 and Line 30 on 97, with a mean of 3.4 minutes late (sd 2.9).

The bad takeaway crowds in six numbers, the fourth failure, and two of its counts have no base, so the analyst cannot tell which line is late most often for its size.

### Several cards

Choose a sequence of cards with the same care as a single card. When a question takes several steps, or one card raises the next question, answer with as few cards as the question needs, in a group named by the question, and give the answer itself in the chat with a link to the cards. A card should show a single finding, not your process. Say how you worked in a sentence in the chat. The analyst can follow three or four cards that build on each other, and cannot follow ten. Usually lead with the card that answers the question most directly, then the pattern and the examples that support it. When the answer would not make sense on its own, lead instead with a card that builds their intuition, such as a few real records or the shape of the data. Fit the cards to the kind of question. A why question wants a story, such as a timeline or a diagram, more than a count.

    Analyst   Why did refunds jump in March?
    Good      chat   Refunds jumped in March because a shipment of X200 chargers delivered at the end of February began failing in the first days of March, and nearly all of the extra refunds are for those chargers. The three cards in "Why did refunds jump in March?" show it [↗](card:<id>).
              group  "Why did refunds jump in March?"
                     1  timeline   the shipment, the first failure reports, the refunds  Batch 17 shipped on February 24, failure reports began on March 2 and refunds peaked on March 10.
                     2  plot       refunds per week by product                           The jump is all X200, from 20 a week to 140 after March 3.
                     3  example    three March X200 refund tickets, quoted               Each says the charger stopped working within days.
    Bad       chat   I loaded the 4,120 tickets, ran describe() on the table and grouped refunds by product, week and day. Refunds rose from 118 in February to 612 in March (+418.6%). The X200 accounts for 548 of the March refunds (89.5%), and the daily count peaked at 31 on March 10. By shipment batch, batch 17 has 126 refunds, batch 16 has 9 and batch 18 has 11. See the cards for the full analysis.
              group  "Refund analysis"
                     1  code       df.describe() of the ticket table                     The table has 14 columns and 4,120 rows.
                     2  table      refunds by product and week, 60 rows                  Refunds vary by product and by week.
                     3  plot       refunds per day, every product                        Refunds peak on March 10 at 31.
                     4  table      refunds by shipment batch                             Batch 17 has 126 refunds, batch 16 has 9 and batch 18 has 11.
                     5  note       summary                                               Refunds rose in March, mostly for the X200 and mostly from batch 17.

The bad chat retells the work and lists numbers instead of answering, the cards follow the order the work was done in, and no card says why. The analyst has to piece the answer together from cards 3 to 5.

    Analyst   Are refunds handled faster than they were in January?
    Good      chat   No. The median time to resolve a refund fell from 3.1 days in January to 2.2 in March, but for every product except the X200 it stayed near 3 days. The drop comes from the many X200 refunds, which are approved automatically. I compared the two months' distributions overall and per product [↗](card:<id>).
              group  "Are refunds handled faster than they were in January?"
                     1  plot   days to resolve a refund, January against March             The March distribution sits lower, and the median fell from 3.1 days to 2.2.
                     2  plot   the same two distributions, one panel per product           For every product except the X200 the two months overlap.
                     3  plot   the X200 alone, January against March, with its share       Most March X200 refunds were approved within a day, and they were 60 of every 100 refunds.
    Bad       chat   Yes, the median fell from 3.1 to 2.2 days. The table has the breakdown by product and month.
              group  "Refund handling time"
                     1  table  median days to resolve, by product and month, 36 rows   Medians range from 0.3 to 4.8 days.

The bad chat gives the headline drop without what explains it, and the one table leaves the analyst to find the pattern in 36 rows.
