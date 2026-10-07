"""The citation check (app/cite.py): a number is linked only where its value has exactly one home in the card's outputs.
The table here is invented."""
from app import cite


def test_tier2_unique_table_cell():
    html = (
        "<table><thead><tr><th></th><th>assignments</th></tr></thead>"
        "<tbody><tr><th>north-desk</th><td>250</td></tr>"
        "<tr><th>south-desk</th><td>30</td></tr></tbody></table>"
    )
    r = cite.resolve("c1", "North 250, South 30.", [{"text/html": html, "text/plain": "..."}])
    assert "[[250|card:c1#assignments/north-desk]]" in r.annotated
    assert "[[30|" not in r.annotated  # a 2-digit integer is too ambiguous to auto-link on uniqueness alone
    assert r.unresolved == ["30"]


def test_a_day_and_a_month_in_words_cite_a_date_written_in_digits():
    """Live check term-fix6, new quirk 7: a document's `23 June` and `19 June` citing the cells `06-23` and `06-19` were
    marked red. A day and a month in words is at a place that writes the date as ISO or as month and day, the year
    compared when both give one; any other day, month or year is not."""
    from app import verify

    for display, cell in [("23 June", "06-23"), ("19 June", "06-19"), ("June 23", "2026-06-23"),
                          ("23rd Jun", "2026-06-23T18:21:02Z"), ("June 23, 2026", "2026-06-23"), ("23 June 2026", "06-23"),
                          ("Sept. 3", "09-03")]:
        assert verify._value_matches(display, cell), (display, cell)
    for display, cell in [("23 June", "06-24"), ("23 May", "06-23"), ("June 23, 2025", "2026-06-23"), ("23", "06-23"),
                          ("23 Junk", "06-23"), ("32 June", "06-32")]:
        assert not verify._value_matches(display, cell), (display, cell)


def test_a_rows_name_cited_by_its_label_column_is_the_value():
    """Live check term-fix7: main cited `[23 June](card:…#day/06-23)`, the day of a table whose rows are named by their
    day, and the place was missing, since only a value column was read. The header over the row names, with a row's
    name, is that name; a date in words is checked against it (date_in)."""
    from app import frames, verify

    f = frames.normalize({"columns": ["day", "deletion events"], "rows": [["06-23", 602], ["07-07", 522]], "index": "day"})
    out = [frames.bundle(f)]
    assert cite.find_td(out, "day", "06-23")[0] == "06-23"
    assert cite.find_td(out, "deletion%20events", "07-07")[0] == "522"
    assert cite.find_td(out, "day", "06-24") is None
    assert verify._value_matches("23 June", "day × 06-23 = 06-23")
    html = ("<table><thead><tr><th>day</th><th>n</th></tr></thead>"
            "<tbody><tr><th>06-23</th><td>602</td></tr></tbody></table>")
    assert cite.find_td([{"text/html": html}], "day", "06-23")[0] == "06-23"
    # a table with no header over its row names has no such column
    blank = html.replace("<th>day</th>", "<th></th>")
    assert cite.find_td([{"text/html": blank}], "day", "06-23") is None


def test_a_citation_whose_value_is_the_link_arrow_is_a_bare_ref():
    """Live check term-fix7: a fork wrote `[[↗|collusion-wiki/events.jsonl#L1063]]` in a takeaway, and the links check
    looked for `↗` on that line and marked it red. The arrow is the link text of a citation without a value."""
    assert cite.normalise_markup("on line 1063 of events.jsonl [[↗|events.jsonl#L1063]].") == "on line 1063 of events.jsonl [[events.jsonl#L1063]]."
    assert cite.normalise_markup("in [↗](events.jsonl#L3) and [[4|events.jsonl#L4]]") == "in [[events.jsonl#L3]] and [[4|events.jsonl#L4]]"
    assert cite.normalise_markup("[[a↗|x.jsonl#L1]]") == "[[a↗|x.jsonl#L1]]"
