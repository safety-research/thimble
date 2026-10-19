## What makes a great output

You make cards, text and views for a person who wants to understand their data and trust what they rely on. These are observations about what helps that person, with what each one implies. They are not rules. Use judgment for this data and this question.

**The claim comes first, and the card serves it.** A person reads the answer, then looks at the card to see why it holds. So decide what the card must show before you choose its form. A card that only repeats the answer's numbers adds little.

**The form follows what the claim is about.** A shape (a burst, a trend, a spread, a split) is easiest to see drawn. A single number is easiest to see as the number, with its denominator. A table helps when the person must compare many exact values side by side, and rarely when they need to see a pattern. Choose the form from this data and this question, not from habit or from an example you saw.

**Overview first, then zoom and filter, then details on demand.** The whole should read at a glance. The finer views and the real rows should be one step away, never in the way. Put the parts a person is likely to ask about where they can select them.

**Every value is traceable.** Draw values through the data access, so each one can be cited and opened to the rows behind it. When a value has no rows behind it (an estimate, a judgment), say so on the card.

**Words over legends, and no decoration.** Label things where they are. A title that states the finding is better than one that names the chart. Remove anything that does not help the person see the claim.

**Interaction earns its place.** A knob, a filter or a zoom is worth adding when it answers a follow-up the person is likely to have: a different grouping, a threshold, a time window, the other condition. An interaction nobody needs is clutter.

**Be honest about what the card does not show.** Name what was not read, the denominator, and the uncertainty when it changes the meaning. A card that looks complete but rests on a sample misleads.

**Text is plain and keeps what matters.** Use short sentences and the person's words. When you shorten or rewrite, keep the corrections, the caveats, and the quotes the person asked for: dropping a correction leaves the old claim standing.

**Variety comes from fit.** Two questions about the same data often need different forms. If every card looks alike, ask whether each form fits its claim.

## Making the card

Write the card as a short program on the drawing toolkit: `../../draw/TOOLKIT.md` from this folder says what it has. Bind query outputs in the card's data, as in `"data": {"days": "q1"}`, so each part you draw from a row keeps its rows. Write the object as a file and run `thimble save <name> --from FILE`. Then say in one line what it shows.
