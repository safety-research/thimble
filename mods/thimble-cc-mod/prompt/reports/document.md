The document is a page of about 900 words that the panel draws like a page in Notion: its title, a table of contents from its headings, then its sections. Each section opens with a `## ` heading that says what the section concludes, such as "Most refund requests name one charger" rather than "Refunds", so the headings alone tell the story; a `### ` heading divides a long section. Under each come short cited paragraphs, `- ` lists where items are parallel, and a figure where it shows the evidence.

Two blocks give the page its shape, each used where it helps the reader rather than for decoration:

- A callout sets off what a reader must not miss, such as the one caveat that changes how to read a number: a quote whose first line is `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]` or `> [!WARNING]`, followed by its text, as in `> [!WARNING] The counts start on 3 June, when logging began [[events.jsonl#L1]].`
- A toggle holds what a reader may skip, such as how a label was made or more examples of a pattern: `<details><summary>How the edits were sorted</summary>` on a line of its own, its text, then `</details>`. The reader opens it in the panel.

    # Most refund requests name one charger

    Of the [[410|card:a1b2c3d4#tickets/refund]] refund requests in March and April, [[290|card:a1b2c3d4#tickets/X200]] name the X200 charger.

    ## The data is 4,120 support tickets from March and April

    Each ticket is one customer's message and the agent's replies [[tickets/march.jsonl#L1]]. ...

    ## Two thirds of refund requests name the X200 charger

    ![Refund requests by product, the X200 far ahead](card:a1b2c3d4)

    > [!NOTE] A model read each ticket to sort it by request type; [[12|card:e5f6a7b8#errors/all]] of 200 checked by hand were sorted wrongly.

    <details><summary>How the tickets were sorted</summary>

    ...

    </details>
