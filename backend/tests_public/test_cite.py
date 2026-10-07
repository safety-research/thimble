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


def test_a_date_with_a_time_cites_the_time_stamp_that_writes_both():
    """Live check term-fix7, new quirk 1: `4 June 2026 at 10:53:40 UTC` against a line holding 2026-06-04T10:53:40Z was
    not found. A day and a month with a time after it is at a time stamp of that date with that time; another time, or a
    time with no stamp of that date, is not."""
    from app import verify

    stamp = "2026-06-04T10:53:40Z TestFoobaAgent deleted"
    for display, line in [("4 June 2026 at 10:53:40 UTC", stamp), ("4 June at 10:53", stamp), ("June 4, 2026, 10:53 UTC", stamp),
                          ("4 June 2026 at 10:53:40", "2026-06-04 10:53:40"), ("4 June 2026, 10:53 GMT", "06-04 | 10:53:00")]:
        assert verify._value_matches(display, line), (display, line)
    for display, line in [("4 June 2026 at 10:53:41 UTC", stamp), ("4 June 2026 at 11:53 UTC", stamp),
                          ("5 June 2026 at 10:53:40 UTC", stamp), ("4 June 2025 at 10:53 UTC", stamp),
                          ("4 June 2026 at 10:53 UTC", "2026-06-04T09:00:00Z, then 2026-06-05T10:53:00Z")]:
        assert not verify._value_matches(display, line), (display, line)


def test_edit_card_keeps_a_date_in_words_its_cited_line_writes_in_digits():
    """Live check term-fix7, new quirk 4: main cited `[[23 June|…@out0#L2]]` and `[[13 July|…#L6]]` in a takeaway, the
    result said "NOT found in this card's outputs, 23, 13", and both links were dropped. A date in words is kept at a
    line or a cell that writes the date in digits."""
    from app import frames

    out = [{"text/plain": "busiest days\n2026-06-23  602\n2026-07-13  512 at 2026-07-13T21:04:00Z"}]
    r = cite.resolve("c1", "The busiest day was [[23 June|card:c1@out0#L2]], then [[13 July|card:c1@out0#L3]] at "
                           "[[13 July 2026 at 21:04 UTC|card:c1@out0#L3]].", out)
    assert r.annotated == ("The busiest day was [[23 June|card:c1@out0#L2]], then [[13 July|card:c1@out0#L3]] at "
                           "[[13 July 2026 at 21:04 UTC|card:c1@out0#L3]].")
    assert r.unresolved == []
    f = frames.normalize({"columns": ["day", "n"], "rows": [["06-23", 602]], "index": "day"})
    r = cite.resolve("c2", "On [[23 June|card:c2#day/06-23]].", [frames.bundle(f)])
    assert r.annotated == "On [[23 June|card:c2#day/06-23]]." and r.unresolved == []
    # a date the line does not write is still not found there
    r = cite.resolve("c1", "On [[24 June|card:c1@out0#L2]].", out)
    assert "[[24 June|" not in r.annotated


def test_a_takeaways_value_at_the_row_its_words_name_stays_there():
    """Live check term-fix7, new quirk 1, in a takeaway: a value cited at the row its words name, which shows another
    value, stays at that row (named in `misplaced`), never moved to the one row that shows it."""
    from app import frames

    f = frames.normalize({"columns": ["hour", "deletions"], "rows": [["22:00", 40], ["23:00", 89]], "index": "hour"})
    out = [frames.bundle(f)]
    r = cite.resolve("c1", "A last [[89|card:c1#deletions/22:00]] in the 22:00 hour.", out)
    assert r.annotated == "A last [[89|card:c1#deletions/22:00]] in the 22:00 hour."
    assert [(l.token, l.ref) for l in r.misplaced] == [("89", "card:c1#deletions/22:00")]
    r = cite.resolve("c1", "A last [[89|card:c1#deletions/22:00]] deletions.", out)
    assert r.annotated == "A last [[89|card:c1#deletions/23:00]] deletions." and not r.misplaced


def test_an_uncited_date_in_words_is_linked_whole_or_left_plain():
    """Live check term-fix8, quirk 4: main wrote plain "On 23 June", and the check linked its `23` alone, with `June` as
    its unit, to the agent's answer at 23:41 ("On 23 ✓ June"). A day and a month in words is one value: linked whole to
    the one line or cell that writes that date in digits, else left plain; its day and its year are never numbers."""
    from app import frames

    out = [{"_stream": "stdout", "text/plain": "2026-06-22 deletes 40\n23 runs at 23:41 answered\n2026-06-24 deletes 7\n"}]
    r = cite.resolve("c1", "On 23 June there were 40 deletes.", out)
    assert r.annotated == "On 23 June there were 40 deletes." and "23 June" in r.unresolved and "23" not in r.unresolved
    assert all("23" != link.token for link in r.links)
    r = cite.resolve("c1", "By 24 June 2026 the deletes fell.", out)
    assert r.annotated == "By [[24 June 2026|card:c1@out0#L3]] the deletes fell." and r.unresolved == []
    r = cite.resolve("c1", "From June 22 on, and 4 June 2026 at 10:53 UTC.", out)
    assert "[[June 22|card:c1@out0#L1]]" in r.annotated and "[[4|" not in r.annotated and "[[10|" not in r.annotated
    # two places write the date: left plain, as an ambiguous number is, and not called missing
    twice = [{"text/plain": "2026-06-23 20:00 deletes\n2026-06-23 23:41 answer\n"}]
    r = cite.resolve("c1", "On 23 June they deleted.", twice)
    assert r.annotated == "On 23 June they deleted." and r.unresolved == [] and not r.links
    # a table's cell that writes the date
    f = frames.normalize({"columns": ["day", "n"], "rows": [["06-23", 602], ["07-07", 522]], "index": "day"})
    r = cite.resolve("c2", "The busiest was 23 June.", [frames.bundle(f)])
    assert r.annotated == "The busiest was [[23 June|card:c2#day/06-23]]."
    # `may` in lower case is the verb
    assert [d[2] for d in cite.dates_in_text("3 may fail; May 3rd; 10 marches")] == ["May 3rd"]


def test_a_date_in_words_is_found_where_a_cell_a_row_name_or_a_line_writes_it_in_words():
    """Live check term-fix9, quirk 11: edit_card said "NOT found in this card's outputs, 23 June" for a table whose row is
    named `23 June`, and "30 June" for an output that writes `30 June 2026 at 22:47:51 UTC`; main rewrote correct
    takeaways twice because of it. A day and a month in words is at a cell, a row's name or a line that gives the same
    day and month in words, the year and the time compared when both give one."""
    from app import frames, verify

    for display, place in [("23 June", "23 June"), ("June 23", "23 June"), ("23 June", "last delete on 23 June"),
                           ("30 June", "30 June 2026 at 22:47:51 UTC"), ("30 June 2026", "June 30, 2026"),
                           ("30 June 2026 at 22:47 UTC", "30 June 2026 at 22:47:51 UTC")]:
        assert cite.date_in(display, place) and verify._value_matches(display, place), (display, place)
    for display, place in [("23 June", "24 June"), ("23 June", "23 July"), ("30 June 2025", "30 June 2026 at 22:47"),
                           ("30 June 2026 at 21:00 UTC", "30 June 2026 at 22:47:51 UTC"), ("23 June", "it may 23 fail")]:
        assert not cite.date_in(display, place), (display, place)
    # a frame whose rows are named by their day in words: the date is linked to its row's name, and found
    f = frames.normalize({"columns": ["day (UTC)", "deletes"], "rows": [["22 June", 11], ["23 June", 602], ["total", 613]],
                          "index": "day (UTC)"})
    r = cite.resolve("d5", "23 June had the most, [[602|card:d5#deletes/23%20June]].", [frames.bundle(f)])
    assert r.annotated.startswith("[[23 June|card:d5#day%20(UTC)/23%20June]] had the most") and r.unresolved == []
    r = cite.resolve("d5", "On [[23 June|card:d5#day%20(UTC)/23%20June]].", [frames.bundle(f)])
    assert r.annotated == "On [[23 June|card:d5#day%20(UTC)/23%20June]]." and r.unresolved == []
    # a date the output writes in words in two cells and a row's name: found, left plain as an ambiguous value is
    g = frames.normalize({"columns": ["event", "when"], "index": "event",
                          "rows": [["gamma cleanup post", "30 June 2026 at 22:47:51 UTC"],
                                   ["last delete on 30 June", "30 June 2026 at 21:17:24 UTC"]]})
    r = cite.resolve("e1", "The last delete on 30 June came earlier.", [frames.bundle(g)])
    assert r.annotated == "The last delete on 30 June came earlier." and r.unresolved == []
    # a line of text that writes it in words
    r = cite.resolve("e2", "Alpha started on 23 June.", [{"text/plain": "alpha  started on 23 June at 10:53\nbeta  watched"}])
    assert r.annotated == "Alpha started on [[23 June|card:e2@out0#L1]]." and r.unresolved == []
    # a date the output does not write is still missing
    r = cite.resolve("d5", "On 27 June there were none.", [frames.bundle(f)])
    assert "27 June" in r.unresolved
