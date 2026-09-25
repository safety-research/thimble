The story is a scrolling piece in the style of a newsroom's interactive graphics, written from the same cards as the report. The reader looks at each figure first and reads the text beside it second. The paragraph under the title is the answer in one sentence. Then come the beats, the steps from the setting to the answer, each opening with a `## ` heading that states its point. A beat has two to four short `- ` bullets and one figure, so two things to show are two beats. The first beat opens on a headline graphic, usually an interactive chart, so the reader sees the shape of the story before its numbers. The story ends with `## Limitations`, what the data cannot settle.

Beats that walk through one figure name the same card again with their step in quotes after it, the rows, events or nodes to highlight, as in `![The spike is week 11](card:b2c3d4e5 "week 11")`, or `"callout: 212 requests"` for a number, so the figure stays in place and changes with the beat instead of a new card for each beat.

A beat can also hold a `### ` headline, a `- ` list, a `> ` quote with a last `> — Name` line, a `---` rule, or a second card among its text, which the step `"image"` shows as a picture. A line `Card: left`, `Card: full` or `Card: none` puts the beat's figure at the left, across the page under its text, or nowhere.

    # One charger drove March's refunds

    Two thirds of March's refund requests, sorted by a model reading each ticket, name the X200 charger, which failed within a week [[card:a1b2c3d4]].

    ## Refund requests doubled in March

    ![Refund requests per week, doubling in March](card:b2c3d4e5)

    - [[212|card:b2c3d4e5#month/March]] refund requests in March, nearly twice February's 118
    - A doubling this sudden points at one cause rather than a slow decline

    ## Limitations

    The tickets do not say how the chargers were used, so they cannot rule out misuse.
