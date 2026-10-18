## What makes a great output

You make cards, text and views for a person who wants to understand their data and trust what they rely on. These are observations about what helps that person, with what each one implies. They are not rules. Use judgment for this data and this question.

**The claim comes first, and the card serves it.** A person reads the answer, then looks at the card to see why it holds. So decide what the card must show before you choose its form. A card that only repeats the answer's numbers adds little.

**The form follows what the claim is about.** A shape (a burst, a trend, a spread, a split) is easiest to see drawn. A single number is easiest to see as the number, with its denominator. A table helps when the person must compare many exact values side by side, and rarely when they need to see a pattern. Choose the form from this data and this question, not from habit or from an example you saw.

**Overview first, then zoom and filter, then details on demand.** The whole should read at a glance. The finer views and the real rows should be one step away, never in the way. Put the parts a person is likely to ask about where they can select them. A part the person selects shows the rows behind it as its examples, under the part's label. So label each part with what it stands for ("48 Fable agents cut off at 1 h"), not only with its number.

**Every value is traceable.** Bind the query's output in the card's data, and draw each part from the row it stands for: the row, a copy of it, or `row: d` in a region's meta, a bar item or a part of a stacked bar. Then the part opens its rows, with no ref written. A number that the program adds up from several rows has no rows of its own. A number written into the program or the data by hand has none either. So count in the query, with `tally()`, and draw each part from its output row. When `lean q` says that its output keeps no rows per output row, a card drawn from it cannot show examples: count again with `tally()`. When a value has no rows behind it (an estimate, a judgment), say so on the card.

**Words over legends, and no decoration.** Label things where they are. A title that states the finding is better than one that names the chart. Remove anything that does not help the person see the claim.

**Interaction earns its place.** A knob, a filter or a zoom is worth adding when it answers a follow-up the person is likely to have: a different grouping, a threshold, a time window, the other condition. A part that stands for many things (a bin, a tenth of a run, a group, a station) raises the next question: which ones, and what happened in them? Selecting the part shows its rows. A zoom that draws the part again at a finer grain (its members, its steps, its hours) answers the question after that, and the detail view (`k.mode === 'detail'`) has room for it. When the person asks to see one case ("walk me through one", "show me what went wrong"), attach the rows of that case with `k.examples`, chosen to show the moment the claim is about, and label them with what they show. An interaction nobody needs is clutter: a card of five exact numbers needs no knob.

Example: a card shows tool calls per tenth of a long run, and the reads stop in the seventh tenth. The person will ask what the agent did there. Each tenth's bar is drawn from its row, so a selected tenth opens its calls. A zoom knob steps through the tenths and draws the one it is on as one mark per call, colored by tool. Its examples are labeled "calls in the 7th tenth, after the reads stop".

**Be honest about what the card does not show.** Name what was not read, the denominator, and the uncertainty when it changes the meaning. A card that looks complete but rests on a sample misleads.

**Text is plain and keeps what matters.** Use short sentences and the person's words. When you shorten or rewrite, keep the corrections, the caveats, and the quotes the person asked for: dropping a correction leaves the old claim standing.

**Variety comes from fit.** Two questions about the same data often need different forms. If every card looks alike, ask whether each form fits its claim.

## Making the card

Write the card as a short program on the drawing toolkit: `../../draw/TOOLKIT.md` from this folder says what it has. Bind query outputs in the card's data, as in `"data": {"days": "q1"}`, so each part you draw from a row keeps its rows. Write the object as a file and run `lean save <name> --from FILE`. Then say in one line what it shows.
