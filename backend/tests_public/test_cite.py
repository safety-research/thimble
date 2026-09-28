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


# --------------------------------------------------------------------------- the label encoding


# --- stable output indices; a table's values cited by column and row; a re-run's stale refs kept ---

_ACCOUNTS_HTML = ("<table><thead><tr><th></th><th>deletions</th><th>reviews</th></tr><tr><th>account</th><th></th><th></th></tr></thead>"
             "<tbody><tr><th>alpha</th><td>127</td><td>4</td></tr><tr><th>beta</th><td>3</td><td>1250</td></tr>"
             "<tr><th>gamma</th><td>44</td><td>3</td></tr></tbody></table>")
_ACCOUNTS_TEXT = "         deletions  reviews\naccount                    \nalpha          127        4\nbeta             3     1250\ngamma           44        3\n"
_ACCOUNTS_TABLE = {"text/html": _ACCOUNTS_HTML, "text/plain": _ACCOUNTS_TEXT}
_ACCOUNTS_PLOT = {"image/svg+xml": "<svg/>", "text/plain": "<Figure size 500x300 with 1 Axes>"}


# --- the markdown-link hybrid `[[56]](card:…)` and a number alone in brackets ---

_DESKS_HTML = ("<table><thead><tr><th></th><th>tickets</th><th>never_closed</th><th>median_min_to_first_reply</th></tr></thead><tbody>"
             "<tr><th>north-desk_q1</th><td>57</td><td>56</td><td>18.4</td></tr>"
             "<tr><th>south-desk_q1</th><td>56</td><td>0</td><td>41.2</td></tr>"
             "<tr><th>east-desk_q1</th><td>57</td><td>3</td><td>122.9</td></tr></tbody></table>")


# --- numbers compare by value; a decrease may cite a negative td ---

_DESKS_DELTA_HTML = ("<table><thead><tr><th></th><th>closed_staffed</th><th>delta_closed</th><th>delta_pp</th></tr></thead><tbody>"
                   "<tr><th>north | weekday | wk1</th><td>27.0</td><td>-14.0</td><td>8.30</td></tr>"
                   "<tr><th>south | weekend | wk3</th><td>1234.0</td><td>-33.0</td><td>-10.7</td></tr></tbody></table>")


# ----------------------------------------------------------------------------- a chart's inline rows
# A chart card shows only the chart; the rows it draws are its table for the model and for every td reader.

VL = "application/vnd.vegalite.v5+json"


def _altair(rows, **extra):
    """A chart bundle the way Altair stores one: the rows under `datasets`, named by `data`."""
    return {VL: {"data": {"name": "data-1"}, "datasets": {"data-1": rows}, "mark": "bar", **extra}, "text/plain": "alt.Chart(...)"}


# ----------------------------------------------------------------------------- totals and counts


# ----------------------------------------------------------------------------- links a value cannot pin down


RUNS = ("<table><thead><tr><th></th><th>finished</th><th>start</th></tr></thead><tbody>"
        + "".join(f"<tr><th>run{i}</th><td>{'True' if i < 8 else 'False'}</td><td>09:{30 + i:02d}:00</td></tr>" for i in range(9))
        + "</tbody></table>")
