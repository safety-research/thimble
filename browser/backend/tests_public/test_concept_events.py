"""The `concepts` record on the workspace stream names where the label shows (`scope`: files, canvas or report) and
whether it is on in Files (`shown`), so the page lights the Files tab's dot only for marks that appear there
(frontend src/shell/dots.ts). A label already deleted goes out without them."""
from __future__ import annotations

from app import concepts

CORPUS = "mini"


def _sent(monkeypatch) -> list[dict]:
    out: list[dict] = []
    monkeypatch.setattr(concepts, "_emit", lambda c, event: out.append(event))
    return out


def test_the_record_names_the_label_s_scope_and_whether_it_is_on_in_files(workspaces_tmp, monkeypatch):
    sent = _sent(monkeypatch)
    ws = concepts._ws(CORPUS)
    files = concepts.new_concept("ran a command", "a Bash call", unit="record", shown=True)
    cards = concepts.new_concept("about deploys", "a card about a deploy", unit="cell")
    for k in (files, cards):
        concepts.write_concept(ws, k)
    concepts._notify(CORPUS, files["id"], "applied")
    concepts._notify(CORPUS, cards["id"], "applied")
    concepts._notify(CORPUS, "deadbeef", "deleted")
    assert sent[0] == {"type": "concepts", "concept": files["id"], "what": "applied", "rows": True, "scope": "files", "shown": True}
    assert (sent[1]["scope"], sent[1]["shown"]) == ("canvas", False)
    assert sent[2] == {"type": "concepts", "concept": "deadbeef", "what": "deleted", "rows": True}
