"""The citation check (app/cite.py): a number is linked only where its value has exactly one home in the card's
outputs, ambiguous numbers and small integers among others are reported and never guessed, numbers compare by value, a
decrease may cite a negative td, the markup is normalised idempotently, td labels are encoded, and a chart's rows are
its table. All tables here are invented."""
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


def test_tier2_unique_shell_line():
    out = [{"text/plain": "total 3\n-rw-r--r-- 1 ann ann 92 board.jsonl\n", "_stream": "stdout"}]
    r = cite.resolve("c9", "There are 92 rows.", out)
    assert "[[92|" not in r.annotated and r.unresolved == ["92"]  # 2-digit: reported, not linked
    r = cite.resolve("c9", "There are 1,204 rows.", [{"text/plain": "hdr\nrows 1204\n"}])
    assert "[[1,204|card:c9@out0#L2]]" in r.annotated and r.unresolved == []  # specific: linked


def test_ambiguous_number_is_not_linked():
    out = [{"text/plain": "5\n5\n", "_stream": "stdout"}]
    r = cite.resolve("c1", "The value is 5.", out)
    assert r.annotated == "The value is 5."  # appears twice -> not linked
    assert r.unresolved == ["5"]


def test_unresolved_number_reported():
    r = cite.resolve("c1", "About 212 tickets.", [])
    assert r.annotated == "About 212 tickets."
    assert r.unresolved == ["212"]


def test_commas_and_percent_normalize():
    out = [{"text/plain": "count 1048576\n"}]
    r = cite.resolve("c1", "It is 1,048,576 bytes.", out)
    assert "[[1,048,576|card:c1@out0#L1]]" in r.annotated


def test_does_not_grab_digits_inside_refs():
    # 'out0' / 'L2' inside a ref-like token must not be matched as numbers
    r = cite.resolve("c1", "See card:ab12 and out3.", [])
    assert r.annotated == "See card:ab12 and out3."
    assert r.unresolved == []


def test_clock_time_hour_is_not_linked():
    """The hour of "16:51" is not a quantity: it must not be re-pointed at a table cell holding 16."""
    html = "<table><thead><tr><th></th><th>count</th></tr></thead><tbody><tr><th>git.ref</th><td>16</td></tr></tbody></table>"
    outputs = [{"text/html": html}]
    r = cite.resolve("c1", "The log covers 14:00 to 16:51 UTC; 16 ref updates.", outputs)
    assert "[[16|" not in r.annotated.split("16:51")[0] + "16:51"  # the time is untouched
    assert "16:51" in r.annotated
    assert "[[16|" not in r.annotated  # a 2-digit integer is too ambiguous to auto-link; it is reported instead
    assert "16" in r.unresolved


def test_a_printed_count_links_a_small_integer_when_it_is_the_only_number_in_the_outputs():
    """`print(len(files))` shows 12 and nothing else; the takeaway's 12 has nothing to be confused
    with, so the small-integer guard of `_specific` does not apply."""
    out = [{"text/plain": "12\n", "_stream": "stdout"}]
    r = cite.resolve("c1", "There are 12 agent transcript files under agents/.", out)
    assert r.annotated == "There are [[12|card:c1@out0#L1]] agent transcript files under agents/."
    assert [(l.token, l.tier) for l in r.links] == [("12", 2)] and r.unresolved == []
    # a second number the output does not show is still reported
    r = cite.resolve("c1", "There are 12 files totalling 840 lines.", out)
    assert "[[12|card:c1@out0#L1]]" in r.annotated and r.unresolved == ["840"]
    # the same 12 among other numbers keeps the guard (its row may mean something else)
    r = cite.resolve("c1", "There are 12 files.", [{"text/plain": "files 12\nlines 840\n"}])
    assert "[[12|" not in r.annotated and r.unresolved == ["12"]
    # a table's lone small integer keeps it too (test_clock_time_hour_is_not_linked is the case)
    html = "<table><tr><th></th><th>n</th></tr><tr><th>files</th><td>12</td></tr></table>"
    r = cite.resolve("c1", "There are 12 files.", [{"text/html": html, "text/plain": "n 12"}])
    assert "[[12|" not in r.annotated and r.unresolved == ["12"]
    # a printed count beside a table with numbers is not the only number
    r = cite.resolve("c1", "There are 12 files.", [{"text/plain": "12\n"}, {"text/html": html}])
    assert "[[12|" not in r.annotated and r.unresolved == ["12"]


def test_bounded_stream_bundle_numbers_lines_as_the_complete_output():
    """notebook.py stores an oversized stream as head + marker + tail (`truncated`): the tail keeps its complete-output
    line numbers and the marker's own number is never a source. (The takeaway path hydrates the bundle first so the
    omitted region is searched too; this is the pure fallback when a caller passes the stored bundle.)"""
    head = "a 111111\nb 222222\n"
    tail = "y 888888\nz 999999\n"
    bundle = {"text/plain": head + "… 996 lines omitted; full output kept …\n" + tail, "_stream": "stdout",
              "truncated": {"total_lines": 1000, "kept_head": 2, "kept_tail": 2, "path": "notebooks/outputs/c1-0.txt"}}
    assert cite.numbered_lines(bundle) == [(1, "a 111111"), (2, "b 222222"), (999, "y 888888"), (1000, "z 999999")]
    assert cite.output_line([bundle], 0, 1000) == "z 999999" and cite.output_line([bundle], 0, 500) is None
    assert cite.output_line([bundle], 0, 3) is None and cite.output_line([bundle], 1, 1) is None
    r = cite.resolve("c1", "First 111111, last 999999, omitted 996 and 555555.", [bundle])
    assert "[[111111|card:c1@out0#L1]]" in r.annotated and "[[999999|card:c1@out0#L1000]]" in r.annotated
    assert "[[996|" not in r.annotated and "[[555555|" not in r.annotated and r.unresolved == ["996", "555555"]
    # a model-written span verifies against the complete-output numbering; a wrong one is re-derived
    r = cite.resolve("c1", "[[999999|card:c1@out0#L1000]] and [[888888|card:c1@out0#L4]]", [bundle])
    assert "[[999999|card:c1@out0#L1000]]" in r.annotated and "[[888888|card:c1@out0#L999]]" in r.annotated
    # ordinary bundles, and a bounded bundle whose text does not match its counts, number as stored
    assert cite.numbered_lines({"text/plain": "p 1\nq 2\n"}) == [(1, "p 1"), (2, "q 2")]
    odd = {**bundle, "truncated": {"total_lines": 1000, "kept_head": 3, "kept_tail": 2}}
    assert cite.numbered_lines(odd) == list(enumerate((head + "… 996 lines omitted; full output kept …\n" + tail).splitlines(), start=1))


# --------------------------------------------------------------------------- the label encoding


def test_encode_label_escapes_what_breaks_a_ref_and_keeps_the_rest():
    cases = {
        "count": "count",
        "mean score": "mean%20score",
        "p*": "p%2A",
        "a|b": "a%7Cb",
        "_id": "%5Fid",
        "#items": "%23items",
        "share %": "share%20%25",
        "a/b": "a%2Fb",
        "x~y": "x%7Ey",
        "`code`": "%60code%60",
        "a[1]": "a%5B1%5D",
        "<b>": "%3Cb%3E",
        "a&b": "a%26b",
        "back\\slash": "back%5Cslash",
        "tab\there": "tab%09here",
        "Ünïcode ✓": "Ünïcode%20✓",
        "α/β": "α%2Fβ",
        "north-desk_q1": "north-desk%5Fq1",
        "1,204.5": "1,204.5",
        "a:b;c=d+e(f)!?'@$^": "a:b;c=d+e(f)!?'@$^",
    }
    for label, enc in cases.items():
        assert cite.encode_label(label) == enc, label
        assert cite.decode_label(enc) == label, label
        assert cite.decode_label(cite.encode_label(enc)) == enc, label  # idempotent through a second round
    # a raw label with no valid %XX in it decodes to itself
    assert cite.decode_label("%change") == "%change" and cite.decode_label("n rows") == "n rows" and cite.decode_label("a|b") == "a|b"


def test_td_ref_for_odd_labels_matches_the_grammar_and_survives_markup():
    import re

    from app import refs

    strict = refs._CELL_TD
    bracket = re.compile(r"\[\[([^\[\]\n]+?)\]\]")  # the frontend's [[…]] token (chat/markdown.tsx TOKEN_RE, first branch)
    for col, row in [("mean score", "α/β"), ("p*", "x~y"), ("a|b", "r 1"), ("_id", "id_2"), ("#items", "α"), ("Ünïcode ✓", "✓"), ("share %", "50%")]:
        ref = cite.td_ref("c0ffee01", col, row)
        assert ref and strict.match(ref), (col, row, ref)
        m = bracket.search(f"see [[1234|{ref}]] here")
        assert m and m.group(1).split("|", 1)[1] == ref, ref
        p = refs.parse_ref(ref)
        assert (p["col"], p["row"]) == (col, row)
        assert not re.search(r"[\s|\[\]*_~`\\<>]", ref.split("#", 1)[1]), ref


def test_a_number_with_its_unit_links_to_the_line_holding_the_same_pair():
    """A takeaway's "16 runs" over an output line that reads "16 runs": the bare 16 is a small integer, unlinkable alone
    once the outputs hold another number, so the number with the word after it is one token: it links when exactly one text line holds that pair,
    case-folded and singular/plural alike; two such lines stay ambiguous; a pair the outputs do not hold stays unresolved."""
    out = [{"text/plain": "16 runs\n3 agents\nrun-01 2026-03-12\n", "_stream": "stdout"}]
    r = cite.resolve("c1", "There are 16 runs by 3 agents.", out)
    assert r.annotated == "There are [[16|card:c1@out0#L1]] runs by [[3|card:c1@out0#L2]] agents."
    assert [(l.token, l.ref, l.tier) for l in r.links] == [("16", "card:c1@out0#L1", 2), ("3", "card:c1@out0#L2", 2)]
    assert r.unresolved == []
    # singular / plural and case do not matter; a different unit does
    assert "[[16|card:c1@out0#L1]] run" in cite.resolve("c1", "One Run? No: 16 run.", out).annotated
    r = cite.resolve("c1", "16 files were read.", out)
    assert "[[16|" not in r.annotated and r.unresolved == ["16"]
    # the pair appearing on two lines is ambiguous
    two = [{"text/plain": "16 runs finished\n16 runs failed\n"}]
    r = cite.resolve("c1", "16 runs finished.", two)
    assert "[[16|" not in r.annotated and r.unresolved == ["16"]
    # a value-ref whose display carries the unit resolves the same way (the model wrote [[16 runs|card:c1]])
    r = cite.resolve("c1", "[[16 runs|card:c1]] in all.", out)
    assert r.annotated == "[[16 runs|card:c1@out0#L1]] in all." and r.unresolved == []
    # the unit never reaches into a table: a td has no unit word
    html = "<table><tr><th></th><th>n</th></tr><tr><th>runs</th><td>16</td></tr><tr><th>agents</th><td>3</td></tr></table>"
    r = cite.resolve("c1", "16 runs.", [{"text/html": html, "text/plain": "n\nruns 16\nagents 3"}])
    assert "[[16|" not in r.annotated and r.unresolved == ["16"]
    # the helpers
    assert cite._unit_after("16 runs", 2) == "runs" and cite._unit_after("16%", 3) is None and cite._unit_after("16, then", 2) is None
    assert cite._norm_unit("Runs") == "run" and cite._norm_unit("gas") == "gas" and cite._norm_unit("files") == "file"


def test_qualify_bare_spans_prefixes_the_citing_cell():
    """A span written without its card id (a value-ref or a bare ref, an output line or a td) is a span of the
    takeaway's own card, and is stored with the id in front. Everything that carries an id, a file
    line or a db row is untouched; the rewrite is idempotent."""
    text = ("Lisa opened [[5|@out0#L3]] PRs; [[@out0#L4]]; [[12|#count/total]] and [[#count/alpha]]; "
            "[[7|card:zz@out0#L1]] [[board.jsonl#L2]] [[forge.db#prs/1]] [[#items|card:zz#p/q]].")
    out = cite.qualify_bare_spans("c1", text)
    assert out == ("Lisa opened [[5|card:c1@out0#L3]] PRs; [[card:c1@out0#L4]]; [[12|card:c1#count/total]] and "
                   "[[card:c1#count/alpha]]; [[7|card:zz@out0#L1]] [[board.jsonl#L2]] [[forge.db#prs/1]] [[#items|card:zz#p/q]].")
    assert cite.qualify_bare_spans("c1", out) == out
    # the prompts' placeholder id, copied into a takeaway given with add_card, is the takeaway's own card too
    placeholder = "Up [[290|card:<id>#product/X200]] of [[410|cell:<id>@out0#L2]], see [[card:<id>]] and [[card:ab12]]."
    assert cite.qualify_bare_spans("c1", placeholder) == (
        "Up [[290|card:c1#product/X200]] of [[410|card:c1@out0#L2]], see [[card:c1]] and [[card:ab12]].")


def test_resolve_reads_a_bare_span_as_this_cells_and_verifies_it():
    """Through resolve: the bare span gets the cell's id and is then checked like any self-span — kept when its line
    holds the value, re-pointed at the unique line that does when it does not; a bare [[@out0#L3]] is prefixed as is."""
    out = [{"text/plain": "author n\nagent-11 312\ngh:lisa 5\n", "_stream": "stdout"}]
    r = cite.resolve("c1", "Lisa opened [[5|@out0#L3]] PRs ([[@out0#L3]]); agent-11 [[312|@out0#L9]].", out)
    assert r.annotated == "Lisa opened [[5|card:c1@out0#L3]] PRs ([[card:c1@out0#L3]]); agent-11 [[312|card:c1@out0#L2]]."
    assert [(l.token, l.ref) for l in r.links] == [("5", "card:c1@out0#L3"), ("312", "card:c1@out0#L2")]
    assert "@out0#L" not in r.annotated.replace("card:c1@out0#L", "")


# --- stable output indices; a table's values cited by column and row; a re-run's stale refs kept ---

_G57_HTML = ("<table><thead><tr><th></th><th>deletions</th><th>reviews</th></tr><tr><th>account</th><th></th><th></th></tr></thead>"
             "<tbody><tr><th>alpha</th><td>127</td><td>4</td></tr><tr><th>beta</th><td>3</td><td>1250</td></tr>"
             "<tr><th>gamma</th><td>44</td><td>3</td></tr></tbody></table>")
_G57_TEXT = "         deletions  reviews\naccount                    \nalpha          127        4\nbeta             3     1250\ngamma           44        3\n"
_G57_TABLE = {"text/html": _G57_HTML, "text/plain": _G57_TEXT}
_G57_PLOT = {"image/svg+xml": "<svg/>", "text/plain": "<Figure size 500x300 with 1 Axes>"}


def test_output_index_is_the_stored_out_field_else_the_position():
    plain = [{"text/plain": "a\nb\n", "_stream": "stdout"}, _G57_TABLE]
    assert [i for i, _ in cite.iter_outputs(plain)] == [0, 1]
    assert cite.output_at(plain, 1) is plain[1] and cite.output_at(plain, 2) is None
    # a revision drew a plot before the table: the table keeps @out0 (notebook.number_outputs wrote `_out`)
    revised = [{**_G57_PLOT, "_out": 1}, {**_G57_TABLE, "_out": 0}]
    assert [i for i, _ in cite.iter_outputs(revised)] == [1, 0]
    assert cite.output_at(revised, 0) is revised[1]
    assert cite.output_line(revised, 0, 3) == "alpha          127        4" and cite.output_line(revised, 1, 1) == "<Figure size 500x300 with 1 Axes>"
    assert cite.output_line(revised, 2, 1) is None
    table, text, _ = cite._output_sources("c1", revised)
    assert table["127"] == ["card:c1#deletions/alpha"] and text == {}  # a chart's repr line is never a source
    # a bad or absent field falls back to the position
    assert cite.output_index({"_out": -1}, 4) == 4 and cite.output_index({"_out": True}, 4) == 4 and cite.output_index("x", 2) == 2


def test_a_line_span_into_a_table_is_written_by_column_and_row():
    r = cite.resolve("c1", "alpha made [[127|card:c1@out0#L3]] deletions and beta [[1,250|card:c1@out0#L4]] reviews.", [_G57_TABLE])
    assert r.annotated == "alpha made [[127|card:c1#deletions/alpha]] deletions and beta [[1,250|card:c1#reviews/beta]] reviews."
    assert [(l.token, l.ref) for l in r.links] == [("127", "card:c1#deletions/alpha"), ("1,250", "card:c1#reviews/beta")]
    # the same value twice in the row: the line span stays (no one td to name); a line no row's label starts too
    twice = {"text/html": _G57_HTML.replace("<td>4</td>", "<td>127</td>"), "text/plain": _G57_TEXT.replace("127        4", "127      127")}
    r = cite.resolve("c1", "alpha: [[127|card:c1@out0#L3]].", [twice])
    assert "[[127|card:c1@out0#L3]]" in r.annotated
    r = cite.resolve("c1", "the header [[deletions|card:c1@out0#L1]].", [_G57_TABLE])
    assert "[[deletions|card:c1@out0#L1]]" in r.annotated
    # a line of a text output stays a line span
    r = cite.resolve("c1", "[[127|card:c1@out0#L2]] rows", [{"text/plain": "account deletions\nalpha 127\n", "_stream": "stdout"}])
    assert r.annotated == "[[127|card:c1@out0#L2]] rows"
    assert cite.line_td("c1", _G57_TABLE, "gamma           44        3", "44") == "card:c1#deletions/gamma"
    assert cite.line_td("c1", _G57_TABLE, "gamma           44        3", "3") == "card:c1#reviews/gamma"
    assert cite.line_td("c1", _G57_TABLE, "nobody 44", "44") is None and cite.line_td("c1", _G57_PLOT, "x 44", "44") is None
    # two columns of the same header: `#n/a` reads back as the FIRST n, so a line span on the
    # second column's value stays a line span; one on the first column's value converts, since the td shows it
    dup = {"text/html": "<table><tr><th></th><th>n</th><th>n</th></tr><tr><th>a</th><td>1</td><td>2</td></tr></table>", "text/plain": "   n  n\na  1  2\n"}
    assert cite.line_td("c1", dup, "a  1  2", "2") is None and cite.line_td("c1", dup, "a  1  2", "1") == "card:c1#n/a"
    r = cite.resolve("c1", "[[2|card:c1@out0#L2]] and [[1|card:c1@out0#L2]]", [dup])
    assert r.annotated == "[[2|card:c1@out0#L2]] and [[1|card:c1#n/a]]"
    # two rows of the same label: the span names the first row, whose value differs, so the line span stays
    rows = {"text/html": "<table><tr><th></th><th>n</th></tr><tr><th>a</th><td>1</td></tr><tr><th>a</th><td>2</td></tr></table>", "text/plain": "   n\na  1\na  2\n"}
    assert cite.line_td("c1", rows, "a  2", "2") is None and cite.line_td("c1", rows, "a  1", "1") == "card:c1#n/a"


def test_resolve_keeps_a_stale_ref_when_asked_and_moves_one_whose_value_still_has_one_home():
    after = [{**_G57_PLOT, "_out": 1}, {"text/html": _G57_HTML.replace("<tr><th>gamma</th><td>44</td><td>3</td></tr>", ""),
                                        "text/plain": _G57_TEXT.replace("gamma           44        3\n", ""), "_out": 0}]
    text = "alpha [[127|card:c1@out0#L3]], beta [[1250|card:c1#reviews/beta]], gamma [[44|card:c1#deletions/gamma]]."
    r = cite.resolve("c1", text, after, keep_stale=True)
    assert r.annotated == "alpha [[127|card:c1#deletions/alpha]], beta [[1250|card:c1#reviews/beta]], gamma [[44|card:c1#deletions/gamma]]."
    assert [(l.token, l.ref, l.tier) for l in r.stale] == [("44", "card:c1#deletions/gamma", 0)] and r.unresolved == []
    # at takeaway time (the default) the same ref is unwrapped and its number reported
    r = cite.resolve("c1", text, after)
    assert r.annotated.endswith("gamma 44.") and r.unresolved == ["44"] and r.stale == []


# --- the markdown-link hybrid `[[56]](card:…)` and a number alone in brackets ---

_G70_HTML = ("<table><thead><tr><th></th><th>tickets</th><th>never_closed</th><th>median_min_to_first_reply</th></tr></thead><tbody>"
             "<tr><th>north-desk_q1</th><td>57</td><td>56</td><td>18.4</td></tr>"
             "<tr><th>south-desk_q1</th><td>56</td><td>0</td><td>41.2</td></tr>"
             "<tr><th>east-desk_q1</th><td>57</td><td>3</td><td>122.9</td></tr></tbody></table>")


def test_normalise_markup_reads_the_hybrid_as_a_value_ref_and_a_bracketed_number_as_the_number():
    """A takeaway written `[[56]](card:227f3dc3#never_closed/…)` would read as a bare ref to a file named 56 and never
    resolve. Such a hybrid becomes the value-ref it means; a number alone in brackets is the number; a bare ref followed by a parenthesised word, a
    value-ref that is already right and a markdown link on prose are untouched; the rewrite is idempotent."""
    text = ("North never closed [[56]](card:227f3dc3#never_closed/north-desk_q1) of its "
            "[[57]](card:227f3dc3#tickets/north-desk_q1) tickets, a median of "
            "[[41.2]](card:227f3dc3#median_min_to_first_reply/south-desk_q1) min; east [[3]] never closed, "
            "[[29]](card:a57a0f74@out0#L2) in the other card and [[0]]( card:227f3dc3#never_closed/south-desk_q2 ).")
    out = cite.normalise_markup(text)
    assert out == ("North never closed [[56|card:227f3dc3#never_closed/north-desk_q1]] of its "
                   "[[57|card:227f3dc3#tickets/north-desk_q1]] tickets, a median of "
                   "[[41.2|card:227f3dc3#median_min_to_first_reply/south-desk_q1]] min; east 3 never closed, "
                   "[[29|card:a57a0f74@out0#L2]] in the other card and [[0|card:227f3dc3#never_closed/south-desk_q2]].")
    assert cite.normalise_markup(out) == out
    same = "see [[card:c1]](above) and [[5|card:c1#a/b]] (ok), [a link](https://example.org), [[1,250]](README.md#L3)"
    assert cite.normalise_markup(same) == "see [[card:c1]](above) and [[5|card:c1#a/b]] (ok), [a link](https://example.org), [[1,250|README.md#L3]]"
    # a hybrid whose ref names no card is a span of the citing card once resolve has qualified it
    assert cite.normalise_markup("[[5]](@out0#L3) and [[12]](#count/total)") == "[[5|@out0#L3]] and [[12|#count/total]]"
    # a td label with a space or a parenthesis runs to the closing paren; a whole file is a ref; a display
    # that is a number is never read as a file (`3.5`); a hybrid nothing converts stays whole — never `48(…)` as prose
    assert cite.normalise_markup("[[56]](card:x#col/row label) [[56]](card:x#a/b(1)) [[12]](README.md) [[3.5]](card:x#a/b)") == (
        "[[56|card:x#col/row label]] [[56|card:x#a/b(1)]] [[12|README.md]] [[3.5|card:x#a/b]]")
    assert cite.normalise_markup("[[56]](nonsense here) and [[56]] alone") == "[[56]](nonsense here) and 56 alone"
    spaced = _G70_HTML.replace("never_closed", "never closed").replace("north-desk_q1", "north desk")
    r = cite.resolve("c1", "North never closed [[56]](card:c1#never closed/north desk) tickets.", [{"text/html": spaced, "text/plain": "t"}])
    assert r.annotated == f"North never closed [[56|{cite.td_ref('c1', 'never closed', 'north desk')}]] tickets." and r.unresolved == []


def test_normalise_markup_reads_a_single_bracketed_value_ref_as_the_value_ref():
    """A takeaway with its citations in single brackets, `[4 failing|runs/…/board.jsonl#L85]`, draws as literal text in
    markdown. Such a token becomes
    `[[4 failing|…]]` when the part after the bar looks like a ref and the part before it does not; a right value-ref, a
    bare ref, a markdown link, a pair of words and a token before a `(` are untouched; the rewrite is idempotent."""
    text = ('agent-31 says a change made ["six parser tests fail"|runs/run-b/board.jsonl#L410], and '
            'agent-09 traces [4 failing|runs/run-c/board.jsonl#L85] wrapping tests to a stale build.')
    out = cite.normalise_markup(text)
    assert out == ('agent-31 says a change made [["six parser tests fail"|runs/run-b/board.jsonl#L410]], and '
                   'agent-09 traces [[4 failing|runs/run-c/board.jsonl#L85]] wrapping tests to a stale build.')
    assert cite.normalise_markup(out) == out
    assert cite.normalise_markup("[12|card:c1#a/b] of [[40|card:c1#a/all]]") == "[[12|card:c1#a/b]] of [[40|card:c1#a/all]]"
    same = "[[5|card:c1#a/b]], [[card:c1]], [a link](https://example.org), [yes|no], [card:c1|card:c2], [2|card:c1#a/b](x)"
    assert cite.normalise_markup(same) == same


def test_resolve_links_the_hybrid_tokens_where_they_point_and_reads_the_bracketed_number_like_any_other():
    table = [{"text/html": _G70_HTML, "text/plain": "table"}]
    text = ("North never closed [[56]](card:c1#never_closed/north-desk_q1) of its "
            "[[57]](card:c1#tickets/north-desk_q1) tickets; east [[3]] never closed; "
            "[[122.9]](card:c1#median_min_to_first_reply/east-desk_q1) min to the first reply.")
    r = cite.resolve("c1", text, table)
    assert "]](" not in r.annotated and "[[3]]" not in r.annotated
    # the td spans come back in the grammar's encoded form (cite.encode_label: `_` is %5F)
    never, tickets, median = (cite.td_ref("c1", "never_closed", "north-desk_q1"), cite.td_ref("c1", "tickets", "north-desk_q1"),
                              cite.td_ref("c1", "median_min_to_first_reply", "east-desk_q1"))
    assert r.annotated == (f"North never closed [[56|{never}]] of its [[57|{tickets}]] tickets; east 3 never closed; "
                           f"[[122.9|{median}]] min to the first reply.")
    assert [(l.token, l.ref, l.tier) for l in r.links] == [("56", never, 2), ("57", tickets, 2), ("122.9", median, 2)]
    # `3` is a one-digit number in a table of other numbers: not linked on uniqueness alone, reported for the cite model
    assert r.unresolved == ["3"] and r.stale == []
    # a bare `[[5]]` at takeaway time with a re-run's keep_stale: still the number, never a stale ref
    r2 = cite.resolve("c1", "North never closed [[56]](card:c1#never_closed/north-desk_q1); [[5]] more.", table, keep_stale=True)
    assert r2.annotated == f"North never closed [[56|{never}]]; 5 more." and r2.stale == []


# --- numbers compare by value; a decrease may cite a negative td ---

_G70_DELTA_HTML = ("<table><thead><tr><th></th><th>closed_staffed</th><th>delta_closed</th><th>delta_pp</th></tr></thead><tbody>"
                   "<tr><th>north | weekday | wk1</th><td>27.0</td><td>-14.0</td><td>8.30</td></tr>"
                   "<tr><th>south | weekend | wk3</th><td>1234.0</td><td>-33.0</td><td>-10.7</td></tr></tbody></table>")


def test_norm_compares_numbers_by_value():
    """`29` against a td `29.0` and "12 fewer" against `-12.0` compare by value: the float and sign forms and their
    edges."""
    assert cite._norm("29") == cite._norm("29.0") == cite._norm("29.00") == "29"
    assert cite._norm("1,234") == cite._norm("1234") == cite._norm("1234.0") == "1234"
    assert cite._norm("12") != cite._norm("-12.0") == "-12"  # the sign is the prose's to say (says_decrease), not _norm's
    assert cite._norm("31") != cite._norm("-31.0") == "-31"
    assert cite._norm("0.50") == cite._norm(".5") == "0.5" and cite._norm("12%") == "12" and cite._norm("-0.0") == "0"
    assert cite._norm("1250") == "1250" and cite._norm("100") == "100"  # never an exponent
    assert cite._norm("16 runs") == "16 runs" and cite._norm("") == "" and cite._norm("1,250 rows") == "1250 rows"
    # only a plain decimal number is read as a value: forms _NUM_RE never finds in prose compare as
    # the text they are, so a scientific td, an id with leading zeros or a signed `+12` vouch for nothing they do not spell
    assert cite._norm("1e3") == "1e3" and cite._norm("1E+2") == "1E+2" and cite._norm("+12") == "+12" and cite._norm("1_000") == "1_000"
    assert cite._norm("007") == "007" != cite._norm("7") and cite._norm("\u0663") == "\u0663" and cite._norm("29.") == "29"


def test_says_decrease_reads_the_word_next_to_the_number():
    t = "Team A runs merged 12 fewer imported PRs ([[-31|card:c#delta_merged/x]]) and saw a drop of 1,234; the total was 29 PRs. Down 5 overall."
    at = lambda tok: (t.index(tok), t.index(tok) + len(tok))
    assert cite.says_decrease(t, *at("12")) and cite.says_decrease(t, *at("1,234")) and cite.says_decrease(t, *at("5"))
    assert not cite.says_decrease(t, *at("29"))  # "was" before, "PRs" after
    # a value-ref token: the words around the whole token, markup read as its display
    v = "south merged [[31|card:c#delta_merged/y]] fewer PRs than the [[29|card:c#merged_north/x]] north."
    assert cite.says_decrease(v, v.index("[[31"), v.index("]] fewer") + 2)
    assert not cite.says_decrease(v, v.index("[[29"), v.index("]] north") + 2)
    # the shapes that count: the word right before or after, or one bridge word (by, of, a, an) away; a bracket is stepped over
    # the words of a size with no direction count too ("a gap of [[291|…]]" against a td of -291)
    for text, tok in (("a gap of 291", "291"), ("the difference of 291", "291"), ("differ by 291", "291"), ("291 apart", "291")):
        assert cite.says_decrease(text, text.index(tok), text.index(tok) + len(tok)), text
    for text, tok in (("fewer by 12", "12"), ("down 12", "12"), ("a drop of 12", "12"), ("fell 12 short", "12"), ("12% fewer", "12%"),
                      ("merged (12 fewer than x)", "12"), ("a decrease (12) overall", "12"), ("lost 12", "12"), ("negative 12", "12")):
        i = text.index(tok)
        assert cite.says_decrease(text, i, i + len(tok)), text
    assert not hasattr(cite, "DECREASE_WINDOW")


def test_says_decrease_never_flips_a_threshold_a_starting_value_or_a_number_past_the_next_word():
    """None of these may link its number to a negative td (`-3.5`, `-290`), which would be false provenance. Relation
    words (below, lower,
    behind, minus) are not deltas; "from N" is where a change started; a decrease word past the neighbouring word says
    nothing about this number."""
    for text, tok in (("Scores below 3.5 were dropped.", "3.5"), ("The lower bound was 3.5.", "3.5"), ("Down from 290 to 41.", "290"),
                      ("Down from 290 to 41.", "41"), ("Team A closed 12 fewer than the 290 baseline.", "290"), ("less than 12", "12"),
                      ("fell to 12", "12"), ("290 minus 12", "12"), ("merged 12, a decrease of 5", "12"), ("drop. 12 more", "12"), ("behind by 12", "12")):
        i = text.index(tok)
        assert not cite.says_decrease(text, i, i + len(tok)), text
    for w in ("below", "lower", "behind", "minus"):
        assert w not in cite.DECREASE_WORDS
    # through resolve: a table whose only 3.5 / 290 is negative links neither sentence
    html = ("<table><thead><tr><th></th><th>delta</th></tr></thead><tbody><tr><th>a</th><td>-3.5</td></tr>"
            "<tr><th>b</th><td>-290.0</td></tr></tbody></table>")
    table = [{"text/html": html, "text/plain": "table"}]
    for text in ("Scores below 3.5 were dropped.", "The lower bound was 3.5.", "Down from 290 to 41.", "Team A closed 12 fewer than the 290 baseline."):
        r = cite.resolve("c1", text, table)
        assert r.links == [] and "[[" not in r.annotated, (text, r.annotated)
    r = cite.resolve("c1", "The delta was 290 fewer.", table)  # the shape that does say it
    assert r.annotated == f"The delta was [[290|{cite.td_ref('c1', 'delta', 'b')}]] fewer."


def test_unresolved_lists_each_token_as_written():
    """A takeaway stating `29` and `29.0` lists both tokens when neither links, so each is cited by hand; here the two
    tds `29.0` and `29` make the value ambiguous."""
    html = ("<table><thead><tr><th></th><th>closed</th></tr></thead><tbody><tr><th>north</th><td>29.0</td></tr>"
            "<tr><th>south</th><td>29</td></tr></tbody></table>")
    r = cite.resolve("c1", "North closed 29 tickets; south also closed 29.0. North again: 29.", [{"text/html": html, "text/plain": "table"}])
    assert r.links == [] and r.unresolved == ["29", "29.0"]
    assert r.annotated == "North closed 29 tickets; south also closed 29.0. North again: 29."


def test_a_number_cites_the_td_holding_it_as_a_float_and_a_decrease_cites_a_negative_td():
    """Through resolve: a value-ref the model wrote to a td holding the float form is kept; a
    thousands-separated number finds the td `1234.0`; "12 fewer" written as a value-ref to the td `-12.0` is kept and
    "1,234 fewer" finds `-1234`-shaped values by itself — while the same numbers without a decrease word are not
    matched to a negative td, and a signed `-12` never matches a positive one."""
    table = [{"text/html": _G70_DELTA_HTML, "text/plain": "table"}]
    closed, delta, s_closed, s_delta = (cite.td_ref("c1", "closed_staffed", "north | weekday | wk1"), cite.td_ref("c1", "delta_closed", "north | weekday | wk1"),
                                        cite.td_ref("c1", "closed_staffed", "south | weekend | wk3"), cite.td_ref("c1", "delta_closed", "south | weekend | wk3"))
    r = cite.resolve("c1", f"North closed [[27|{closed}]] tickets, [[14|{delta}]] fewer than unstaffed; south closed 1,234, 33 fewer.", table)
    assert r.annotated == f"North closed [[27|{closed}]] tickets, [[14|{delta}]] fewer than unstaffed; south closed [[1,234|{s_closed}]], 33 fewer."
    assert [(l.token, l.ref) for l in r.links] == [("27", closed), ("14", delta), ("1,234", s_closed)]
    assert r.unresolved == ["33"]  # two digits: reported, and a hand citation of the td -33.0 is accepted
    # the same value-ref without a decrease word: the td holds -14.0, the prose says 14, so it is unwrapped and reported
    r = cite.resolve("c1", f"North closed [[14|{delta}]] more than unstaffed.", table)
    assert r.annotated == "North closed 14 more than unstaffed." and r.unresolved == ["14"]
    # a signed number in the prose against the positive td: never
    r = cite.resolve("c1", f"North closed [[-27|{closed}]] tickets, down.", table)
    assert r.annotated == "North closed -27 tickets, down." and r.unresolved == ["-27"]
    # a specific decrease with no source of its own links to the negative td by value
    r = cite.resolve("c1", "South closed 1,234 tickets; a drop of 1,234.0 is not it, but south's 33.0 fewer is.", table)
    assert f"[[33.0|{s_delta}]]" in r.annotated and f"[[1,234|{s_closed}]]" in r.annotated


def test_a_typographic_minus_is_the_numbers_sign():
    """A takeaway's "−57.8%" (U+2212) tokenises with its sign and compares equal to the
    table's `-57.8`, instead of being read as `57.8%` and contradicted by the place that shows -57.8."""
    assert [m.group(0) for m in cite._NUM_RE.finditer("self-approval \u221257.8%, total items \u22123.7% (p=0.0312)")] == ["\u221257.8%", "\u22123.7%", "0.0312"]
    assert cite._norm("\u221257.8%") == cite._norm("-57.8") == "-57.8"
    assert cite._PLAIN_NUM_RE.fullmatch("\u221212.0") and cite._norm("\u221212.0") == "-12"
    # the ASCII hyphen's behaviour is unchanged: a hyphenated word is no number, a leading minus is a sign
    assert [m.group(0) for m in cite._NUM_RE.finditer("north-desk, -12 fewer, 6-0")] == ["-12", "6"]


def test_a_label_over_the_cell_or_one_of_its_outputs_is_kept_and_pointed_at_the_cell():
    """A takeaway may write `[[chart|card:X@out1]]`, a whole output, which the grammar has no ref for. A display with no
    number over the cell or one of its outputs names the link, not a value: kept, written with the
    cell's ref (cite.whole_output_cell), listed neither as a link nor as stale. A number over a whole output is still
    looked up like any self-ref."""
    outputs = [{"image/svg+xml": "<svg/>", "text/plain": "<Figure>"},
               {"text/html": "<table><tr><th></th><th>n</th></tr><tr><th>a</th><td>127</td></tr></table>", "text/plain": "   n\na  127\n"}]
    assert cite.whole_output_cell("card:c1@out1") == "card:c1" and cite.whole_output_cell("card:c1@out1#L2") is None
    assert cite.whole_output_cell("card:c1") is None and cite.whole_output_cell("README.md") is None
    assert cite.is_label_display("chart") and cite.is_label_display("per-run table") and not cite.is_label_display("31 merges")
    r = cite.resolve("c1", "Fewer reopened tickets, as the [[chart|card:c1@out0]] and the [[table|card:c1]] show.", outputs)
    assert r.annotated == "Fewer reopened tickets, as the [[chart|card:c1]] and the [[table|card:c1]] show."
    assert r.links == [] and r.stale == []
    r = cite.resolve("c1", "Alpha has [[127|card:c1@out1]] rows.", outputs, keep_stale=True)
    assert r.annotated == "Alpha has [[127|card:c1#n/a]] rows." and r.stale == []
    # a label over another cell passes through as written
    r = cite.resolve("c1", "See the [[chart|card:other@out0]].", outputs)
    assert r.annotated == "See the [[chart|card:other@out0]]."


# ----------------------------------------------------------------------------- a chart's inline rows
# A chart card shows only the chart; the rows it draws are its table for the model and for every td reader.

VL = "application/vnd.vegalite.v5+json"


def _altair(rows, **extra):
    """A chart bundle the way Altair stores one: the rows under `datasets`, named by `data`."""
    return {VL: {"data": {"name": "data-1"}, "datasets": {"data-1": rows}, "mark": "bar", **extra}, "text/plain": "alt.Chart(...)"}


def test_chart_table_reads_altairs_datasets_and_labels_rows_by_the_first_distinct_text_column():
    t = cite.chart_table(_altair([{"n": 412, "sender": "agent-3", "week": "w1"}, {"n": 201.5, "sender": "agent-7", "week": "w1"}]))
    assert (t.label, t.columns, t.labels, t.cells, t.total) == ("sender", ["n", "week"], ["agent-3", "agent-7"], [["412", "w1"], ["201.5", "w1"]], 2)
    assert t.text().splitlines() == ["sender   n      week", "agent-3  412    w1", "agent-7  201.5  w1"]
    assert cite.table_cells(t.html()) == [("n", "agent-3", "412"), ("week", "agent-3", "w1"), ("n", "agent-7", "201.5"), ("week", "agent-7", "w1")]


def test_chart_table_numbers_the_rows_when_no_column_can_label_them():
    b = {VL: {"data": {"values": [{"x": 1, "y": 2}, {"x": 1, "y": None}]}, "mark": "line"}}
    t = cite.chart_table(b)
    assert t.label is None and t.labels == ["0", "1"] and t.cells == [["1", "2"], ["1", ""]]
    assert t.text().splitlines()[0].split() == ["x", "y"]


def test_chart_table_labels_rows_by_the_axis_when_no_text_column_can():
    """A line chart over training steps has no distinct text column, so its rows are labelled by the field its x axis
    draws, a whole float without `.0`, and a ref written when the rows were numbered by position still reads."""
    rows = [{"step": 500.0, "score": 0.0125, "trend": "first"}, {"step": 1000.0, "score": 0.0, "trend": "lower"},
            {"step": 1500.0, "score": 0.05, "trend": "higher"}, {"step": 2000.0, "score": 0.05, "trend": "higher"}]
    layer = [{"mark": "line", "encoding": {"x": {"field": "step", "type": "quantitative"}, "y": {"field": "score"}}},
             {"mark": "point", "encoding": {"x": {"field": "step"}, "color": {"field": "trend"}}}]
    out = [{VL: {"datasets": {"d": rows}, "data": {"name": "d"}, "layer": layer}}]
    t = cite.chart_table(out[0])
    assert (t.label, t.by_axis, t.labels) == ("step", True, ["500", "1000", "1500", "2000"])
    assert cite.find_td(out, "score", "1500")[0] == "0.05" and cite.find_td(out, "score", "1")[0] == "0.0"
    assert cite.find_td(out, "score", "9999") is None
    # an axis whose values repeat labels nothing, and the rows keep their positions
    same = [{VL: {"data": {"values": [{"x": 1, "y": 2}, {"x": 1, "y": 3}]}, "encoding": {"x": {"field": "x"}}}}]
    assert cite.chart_table(same[0]).labels == ["0", "1"] and not cite.chart_table(same[0]).by_axis
    # a y axis of numbers is the measure, which names no row even when its values happen to differ
    long = [{VL: {"data": {"values": [{"week": "w1", "agent": "a", "n": 3}, {"week": "w1", "agent": "b", "n": 5},
                                      {"week": "w2", "agent": "a", "n": 4}, {"week": "w2", "agent": "b", "n": 6}]},
                  "encoding": {"x": {"field": "week", "type": "nominal"}, "y": {"field": "n", "type": "quantitative"},
                               "color": {"field": "agent", "type": "nominal"}}}}]
    t = cite.chart_table(long[0])
    assert (t.label, t.labels, t.columns) == (None, ["0", "1", "2", "3"], ["week", "agent", "n"])
    turned = [{VL: {"data": {"values": [{"n": 3, "day": "2026-06-01"}, {"n": 3, "day": "2026-06-02"}]},
                    "encoding": {"x": {"field": "n", "type": "quantitative"}, "y": {"field": "day", "type": "temporal"}}}}]
    assert cite.chart_table(turned[0]).label == "day", "a y axis of dates still names the rows"


def test_a_frame_row_can_be_named_by_its_key_column():
    """A frame printed with pandas' default index numbers its rows 0, 1, 2, and a reader names a row by the column that
    tells the rows apart, such as the run."""
    html = ("<table><tr><th></th><th>run</th><th>calls</th><th>share</th></tr>"
            "<tr><th>0</th><td>run-a</td><td>184</td><td>0.5</td></tr>"
            "<tr><th>1</th><td>run-b</td><td>105</td><td>0.5</td></tr></table>")
    out = [{"text/html": html, "text/plain": "..."}]
    assert cite.find_td(out, "calls", "run-a")[0] == "184" and cite.find_td(out, "calls", "1")[0] == "105"
    assert cite.find_td(out, "calls", "run-c") is None
    labelled = [{"text/html": html.replace("<th>0</th>", "<th>x</th>").replace("<th>1</th>", "<th>y</th>")}]
    assert cite.find_td(labelled, "calls", "run-a") is None, "a table with its own row labels is read by them alone"


def test_chart_table_finds_rows_in_layers_facets_and_vega_and_none_when_they_are_not_inline():
    layered = {VL: {"datasets": {"d": [{"a": "p", "v": 3}]}, "layer": [{"data": {"name": "d"}, "mark": "bar"}, {"mark": "rule"}]}}
    assert cite.chart_table(layered).cells == [["3"]]
    faceted = {VL: {"datasets": {"d": [{"a": "p", "v": 4}]}, "spec": {"data": {"name": "d"}}, "facet": {"field": "a"}}}
    assert cite.chart_table(faceted).cells == [["4"]]
    vega = {"application/vnd.vega.v5+json": {"data": [{"name": "t", "values": [{"a": "p", "v": 5}]}]}}
    assert cite.chart_table(vega).cells == [["5"]]
    assert cite.chart_table({VL: {"data": {"url": "data.csv"}, "mark": "bar"}}) is None
    assert cite.chart_table({"image/png": "iVBOR"}) is None and cite.chart_table({"text/plain": "3"}) is None
    assert cite.chart_table({VL: '{"data": {"values": [{"a": "p", "v": 6}]}}'}).cells == [["6"]], "a spec stored as JSON text"


def test_chart_table_keeps_the_first_rows_and_counts_them_all():
    rows = [{"i": i} for i in range(cite.CHART_ROWS_MAX + 5)]
    t = cite.chart_table(_altair(rows))
    assert len(t.labels) == cite.CHART_ROWS_MAX and t.total == cite.CHART_ROWS_MAX + 5


def test_a_charts_values_resolve_and_verify_by_column_and_row():
    out = [_altair([{"sender": "agent-3", "messages": 412}, {"sender": "agent-7", "messages": 201}])]
    assert cite.table_html(out[0]) == cite.chart_table(out[0]).html()
    assert cite.find_td(out, "messages", "agent-3")[0] == "412"
    r = cite.resolve("c1", "agent-3 wrote 412 messages.", out)
    assert r.annotated == "agent-3 wrote [[412|card:c1#messages/agent-3]] messages." and r.links[0].tier == 2
    r = cite.resolve("c1", "agent-7 wrote [[201|card:c1#messages/agent-7]].", out)
    assert "[[201|card:c1#messages/agent-7]]" in r.annotated and not r.unresolved
    from app import heal

    places = heal.places({"id": "c1", "outputs": out})
    assert [(p.ref, p.value) for p in places] == [("card:c1#messages/agent-3", "412"), ("card:c1#messages/agent-7", "201")]


def test_a_charts_own_html_is_never_read_as_a_table():
    b = {**_altair([{"a": "p", "v": 7}]), "text/html": "<div id='vis'></div><script>vegaEmbed('#vis', spec)</script>"}
    assert cite.table_cells(cite.table_html(b)) == [("v", "p", "7")]
    assert cite.table_html({"text/html": "<table><tr><th></th><th>c</th></tr><tr><th>r</th><td>1</td></tr></table>"}).startswith("<table>")
    assert cite.table_html({"text/plain": "x"}) == ""


def test_the_heal_index_over_the_notebook_reads_runnable_cards_and_charts():
    """heal.Cache.index, the whole-notebook search the healing pass falls back to, skips a card with no outputs (a note)
    and finds a value in a chart's rows as in a table's tds."""
    from app import heal

    cells = [{"id": "n1", "kind": "note", "payload": {"text": "412"}},
             {"id": "c1", "kind": "plot", "code": "chart", "outputs": [_altair([{"sender": "agent-3", "messages": 412}])]}]
    index = heal.Cache().index(lambda: cells)
    assert [(rank, p.ref) for rank, p in index[cite._norm("412")]] == [(0, "card:c1#messages/agent-3")]


# ----------------------------------------------------------------------------- totals and counts


def test_a_total_or_count_the_chart_s_data_holds_is_supported_without_a_link():
    """A takeaway may state a total the chart draws no mark for ("3,155 tickets in all" over tickets per day). A total
    or count of the card's data is supported: left plain, listed in `totals`, not in `unresolved`."""
    out = [_altair([{"day": "Monday", "tickets": 1200}, {"day": "Tuesday", "tickets": 1105}, {"day": "Wednesday", "tickets": 850}])]
    assert cite.data_totals(out) == ["3", "3155"]
    r = cite.resolve("c1", "Tickets were opened 3,155 times over the 3 days, most on Monday with 1,200, and 99 more.", out)
    assert "[[1,200|card:c1#tickets/Monday]]" in r.annotated
    assert "3,155 times" in r.annotated and "[[3,155|" not in r.annotated, "a total stays plain"
    assert r.totals == ["3,155", "3"] and r.unresolved == ["99"], "a number the data does not hold is still reported"


def test_a_frame_s_totals_are_its_rows_sums_and_distinct_values_and_a_cut_frame_gives_its_row_count_alone():
    from app import frames

    whole = frames.bundle(frames.normalize({"columns": ["queue", "kind", "tickets"],
                                            "rows": [["billing", "email", 3861], ["returns", "email", 601], ["setup", "chat", 12]],
                                            "total": 3}))
    assert cite.data_totals([whole]) == ["3", "2", "1", "4474"], "3 rows, 2 kinds (2 email, 1 chat), 4,474 tickets"
    cut = frames.bundle(frames.normalize({"columns": ["queue", "tickets"], "rows": [["billing", 3861], ["returns", 601]], "total": 40}))
    assert cite.data_totals([cut]) == ["40"], "a sum over the rows kept is not the data's"
    r = cite.resolve("c1", "The 40 queues hold 4,462 tickets.", [cut])
    assert r.totals == ["40"] and r.unresolved == ["4,462"]


def test_an_html_table_s_counts_and_a_value_the_card_shows_is_never_a_total():
    """A number the card shows is a value: one that cannot link on uniqueness (a small integer among others) stays
    unresolved, so its author cites it by hand, even when it also equals a count."""
    html = {"text/html": "<table><tr><th></th><th>n</th><th>kind</th></tr><tr><th>a</th><td>2</td><td>x</td></tr>"
                         "<tr><th>b</th><td>250</td><td>y</td></tr></table>"}
    assert cite.data_totals([html]) == ["2", "252"]
    r = cite.resolve("c1", "The 2 rows add up to 252.", [html])
    assert r.unresolved == ["2"] and r.totals == ["252"]


# ----------------------------------------------------------------------------- links a value cannot pin down


RUNS = ("<table><thead><tr><th></th><th>finished</th><th>start</th></tr></thead><tbody>"
        + "".join(f"<tr><th>run{i}</th><td>{'True' if i < 8 else 'False'}</td><td>09:{30 + i:02d}:00</td></tr>" for i in range(9))
        + "</tbody></table>")


def test_a_count_word_a_clock_time_and_a_range_over_a_place_that_exists_are_kept():
    """A display with no number (a count word, a clock time) names its place rather than a value the place shows: kept
    at a td or a line that exists, a clock time only where the place shows it; a range of lines holds a value one of
    its lines shows, or the clock times the display writes."""
    log = {"text/plain": "step 1 00:52 start\nstep 2 00:56 edit\nstep 3 00:58 test\nstep 4 01:00 done\n", "_stream": "stdout"}
    out = [{"text/html": RUNS, "text/plain": "..."}, log]
    text = ("[[Eight|card:c1#finished/run0]] runs finished, the first at [[09:30|card:c1#start/run0]]; the edit took "
            "[[00:56–01:00|card:c1@out1#L2-L4]], and step [[3|card:c1@out1#L2-L4]] tested it.")
    r = cite.resolve("c1", text, out)
    assert r.annotated == text, r.annotated
    assert [link.token for link in r.links] == ["Eight", "09:30", "00:56–01:00", "3"] and r.unresolved == []
    # a clock time the place does not show, and a range that runs past the output, are unwrapped
    r = cite.resolve("c1", "It began at [[10:15|card:c1#start/run0]] and ran [[00:56–01:00|card:c1@out1#L3-L9]].", out)
    assert r.annotated == "It began at 10:15 and ran 00:56–01:00."
    assert cite.clocks_in("9:30", "09:30:00") and not cite.clocks_in("09:30:15", "09:30:00")


def test_a_number_cited_to_the_whole_card_stays_on_the_card_as_a_word_does():
    """`[[5|card:X]]` is read as `[[five|card:X]]` is: a number with no one place on the card (a count of its rows, a
    value shown in several places) keeps its link to the card; the count of rows holding a value is a total of the
    data, and a number the card shows nowhere is named in `unresolved` too."""
    out = [{"text/html": RUNS, "text/plain": "..."}]
    assert "8" in cite.data_totals(out) and "9" in cite.data_totals(out)
    r = cite.resolve("c1", "[[8|card:c1]] of the [[9|card:c1]] runs finished; [[five|card:c1]] ran long.", out)
    assert r.annotated == "[[8|card:c1]] of the [[9|card:c1]] runs finished; [[five|card:c1]] ran long."
    assert r.unresolved == [] and {(link.token, link.tier) for link in r.links} == {("8", 1), ("9", 1)}
    r = cite.resolve("c1", "[[12|card:c1]] runs finished.", out)
    assert r.annotated == "[[12|card:c1]] runs finished." and r.unresolved == ["12"]


def test_normalise_markup_writes_a_file_line_cited_through_a_card_as_the_line():
    """`[[refused|card:<id>#<path>#L<n>…]]`, a model's citation of an example card's excerpt, is stored as the file's line
    it names; a td span, a card's output line and a bare card are untouched, and the rewrite is idempotent."""
    text = ("One agent [[refused a user install|card:3d10aa2b#runs/one/agent-39.jsonl#L103.b0:c12-109]], reporting "
            "[[0+untagged.12|card:3d10aa2b#runs/one/agent-39.jsonl#L118.b0:c0-25]] [[card:3d10aa2b#a b/c.jsonl#L4-L6]]; "
            "[[31|card:3d10aa2b#outcome/merged]] [[8|card:3d10aa2b@out0#L2]] [[card:3d10aa2b]]")
    out = cite.normalise_markup(text)
    assert out == ("One agent [[refused a user install|runs/one/agent-39.jsonl#L103.b0:c12-109]], reporting "
                   "[[0+untagged.12|runs/one/agent-39.jsonl#L118.b0:c0-25]] [[a b/c.jsonl#L4-L6]]; "
                   "[[31|card:3d10aa2b#outcome/merged]] [[8|card:3d10aa2b@out0#L2]] [[card:3d10aa2b]]")
    assert cite.normalise_markup(out) == out


def test_a_quote_cited_through_its_example_card_and_file_is_written_as_the_quote():
    """`card:<id>#<path>` in an example's takeaway names the file of a record it quotes, not a table's cell: it is
    written as that quote's ref. A card that is no example, a file it does not quote and a table's cell are kept."""
    example = {"id": "ex12ab34", "kind": "example", "payload": {"refs": [
        "trial-ep04/logs/u1.json#L1.b0:c10-40", "trial-ep04/logs/u3.json#L1.b0:c90-120", "trial-ep04/logs/u3.json#L1.b0:c300-320"]}}
    text = ('Agent 1 said [["I lead"|card:ex12ab34#trial-ep04/logs/u1.json]] and agent 3 '
            "[[unverifiable|card:ex12ab34#trial-ep04/logs/u3.json]]; see [[card:ex12ab34#trial-ep04/logs/u9.json]] and "
            "[[card:ex12ab34#count/total]].")
    out = cite.quote_refs(example, text)
    assert '[["I lead"|trial-ep04/logs/u1.json#L1.b0:c10-40]]' in out
    assert "[[unverifiable|trial-ep04/logs/u3.json#L1.b0:c90-120]]" in out
    assert "[[card:ex12ab34#trial-ep04/logs/u9.json]]" in out and "[[card:ex12ab34#count/total]]" in out
    assert cite.quote_refs(example, out) == out
    assert cite.quote_refs({**example, "kind": "table"}, text) == text
    assert cite.quote_refs(None, text) == text


def test_a_quoted_phrase_is_at_its_place_without_its_quotation_marks():
    assert cite.value_in('"I lead the cutover"', "My brief says I lead the cutover now")
    assert cite.value_in("“unverifiable”", "their claim is unverifiable")
    assert not cite.value_in('"no referee is reachable"', "the referee is not reachable")
