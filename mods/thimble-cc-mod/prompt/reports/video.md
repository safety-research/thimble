The video is a narrated explainer of about a minute and a half that tells someone who has not seen the data what the work found. How to tell it is yours: the story, its order, what is on screen and how it looks. Aim for a video a bright fifteen-year-old could follow on one viewing, with pictures that make each point easier to grasp than the words alone. The cards and answers are material, not a template: use a card's numbers, show it, make a clearer one, or leave it out.

You write a storyboard; thimble-cc-mod films it from its own drawings. Under the `# ` title come one or two lines that open the video, over a title screen that lists the scenes. Then the scenes, each opening with a `## ` heading that states its point, which stands at the top of the screen. A scene shows at most one card, on a line of its own, `![what to take from it](card:<id>)`, so two things to show are two scenes. Then its narration: each paragraph is one line, one or two spoken sentences, in the order they are said, and a line may end with `(pause 0.8)`, the seconds of silence after it.

What the viewer sees:

- The card draws itself in over two seconds: bars grow, a line traces, a timeline's events and a table's rows arrive in turn, a diagram builds layer by layer. Then each line, while it is said, lights the value it cites on the card, with that value's label beside the card's question. So cite the card's values in the line that talks about them, in the order you want them lit; a line that cites nothing on the card can light a row or event named as the figure's step, `![...](card:<id> "week 11")`.
- A scene without a card shows the numbers and quotes its lines cite as tiles that count up, each lit while its line is said. Use one for a single striking number or a quotation, two or three tiles at most.
- Each line is a caption under the picture, and the narration is spoken when the machine has an offline voice. A line of 12 to 20 words lasts about five to nine seconds, so six to ten scenes of two or three lines make about a minute and a half.

The screen is a terminal of 136 columns, so a card reads best when it is small: up to about ten bars or table rows, or one line of a few series. Make a card for the video when the ones made so far are too large or show more than the scene's point.

The viewer cannot check the video against the data, so every number and quotation a line says comes from the evidence and is cited in the line that says it. The caption and the voice read a citation's shown text and skip its ref, so write numbers as digits. Claim no more than the sources show: a count, a cause or a certainty they do not give, or one example presented as a pattern, is flagged when the analyst checks the video.

    # One charger drove March's refunds

    In March, refund requests nearly doubled. This is the story of why.

    ## Refund requests doubled in March

    ![Refund requests per month](card:b2c3d4e5)

    February had [[118|card:b2c3d4e5#requests/February]] refund requests. March had [[212|card:b2c3d4e5#requests/March]]. (pause 0.6)

    ## Most of them name one charger

    ![Refund requests by product](card:a1b2c3d4)

    [[290|card:a1b2c3d4#tickets/X200]] of the [[410|card:a1b2c3d4#tickets/refund]] requests name the X200 charger.

    ## In the customers' words

    Most say the same thing: [["it stopped working after two days"|tickets/march.jsonl#L88]].
