"""The view kit's tree (backend/app/viewer_tree.js, thimble.tree) on the server's side: every view page loads it after
the row controls, whose shared helpers it uses, and the table, and before the range takes the bridge's part away; its
styles are the kit's parts, which a page lays out but does not restyle (views.own_parts). What it draws is
frontend/tests/public/browser/view-tree.test.ts."""
from app import views


def test_the_tree_loads_after_the_row_controls_and_the_table_and_before_the_range(tmp_path):
    d = tmp_path / "view"
    d.mkdir()
    (d / views.VIEW_HTML).write_text("<style>.mine{}</style><script>const t = thimble.tree({ mount: '#pages' })</script>")
    doc = views.frame_document({"dir": str(d), "slug": "wiki", "name": "Wiki"})
    order = [doc.index(s) for s in ("thimble.rows = function", "shared.controls = {", "thimble.table = function",
                                    "thimble.tree = function", "thimble.timeRange = function", "const t = thimble.tree(")]
    assert order == sorted(order), order
    assert doc.index(".thimble-tree-row") < doc.index(".mine{}")


def test_a_page_lays_the_tree_out_but_does_not_restyle_its_rows():
    assert views.own_parts("<style>.thimble-tree-row.active { background: #fde }</style>") == [
        "`.thimble-tree-row.active` sets background"]
    assert views.own_parts("<style>#side .thimble-tree { width: 240px; flex: none }</style>") == []
