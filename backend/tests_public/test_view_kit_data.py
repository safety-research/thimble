"""Views drawn with the view kit's table, search, diff and text alone pass the whole view check, the headless page
included: an inbox whose table of 600 mails draws only the rows near its view (the check counts the rows it holds, each
anchored as it is drawn), with Color by, Filter by, the side panel and the search; a wiki page's history, each revision
a diff against the one before, with the search; and a forge's pull requests as cards, each body's markdown drawn by the
text. Each draws every choice of its controls, and the test label shows on the records it shows. What the parts do on
their own is frontend/tests/public/data-kit.test.ts."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from app import config, views
from test_views import _fresh, bound, inproc  # noqa: F401

INBOX_READER = '''
import json
from pathlib import Path


def build_index(paths):
    mails, bad = [], []
    for path in paths:
        with open(path) as f:
            for n, line in enumerate(f, 1):
                try:
                    r = json.loads(line)
                except ValueError:
                    bad.append({"ref": f"{path}#L{n}", "why": "not JSON"})
                    continue
                mails.append(dict(r, ref=f"{path}#L{n}"))
    return {"mails": mails, "bad": bad}


def problems(index):
    return index["bad"]


def records(index, query):
    return index["mails"]


def resolve(index, locator):
    ref = f"{locator['path']}#{locator['fragment']}"
    for m in index["mails"]:
        if m["ref"] == ref:
            return {"excerpt": m["body"], "label": m["subject"], "refs": [ref], "key": None, "target": {"ref": ref}}
    return None
'''

INBOX_HTML = """<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; } body { background: var(--surface-card); overflow: hidden; }
#view { height: 100%; display: flex; flex-direction: column; }
.top { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px 16px 8px; min-width: 0; }
#search { flex: 0 1 240px; min-width: 120px; }
#body { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--border-subtle); }
#list { flex: 1; min-height: 0; }
</style></head><body><div id="view">
<div class="top"><span id="search"></span><span id="filter"></span><span id="colour"></span></div>
<div id="body"><div id="list"></div></div></div>
<script>
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'folder', title: 'Folder' }] })
const filter = thimble.filterBy({ mount: '#filter', fields: [{ name: 'folder', title: 'Folder', values: ['Inbox', 'Ops', 'Billing'] }], onChange: () => table.draw() })
const side = thimble.side({ mount: '#body' })
const search = thimble.search({ mount: '#search', placeholder: 'Search mail' })
const table = thimble.table({ mount: '#list', side, search, filter, sort: { by: 't', desc: true },
  columns: [{ name: 'from', title: 'From', width: 180 }, { name: 'subject', title: 'Subject' }, { name: 't', title: 'Date', type: 'time' }],
  details: (m) => ({ title: m.subject, sub: m.from, render: (b) => { const p = document.createElement('p'); p.textContent = m.body; b.appendChild(p) } }) })
const loaded = thimble.fetch({}).then((rows) => table.draw(rows))
thimble.onOpen(async (place) => {
  await loaded
  const t = (place && place.target) || {}
  if (t.ref) table.open(t.ref)
})
</script></body></html>"""

WIKI_READER = '''
import json
from pathlib import Path


def build_index(paths):
    revs, bad = [], []
    for path in paths:
        with open(path) as f:
            for n, line in enumerate(f, 1):
                try:
                    r = json.loads(line)
                except ValueError:
                    bad.append({"ref": f"{path}#L{n}", "why": "not JSON"})
                    continue
                revs.append(dict(r, ref=f"{path}#L{n}"))
    return {"revs": revs, "bad": bad}


def problems(index):
    return index["bad"]


def records(index, query):
    query = query or {}
    page = query.get("page")
    if page:
        return [r for r in index["revs"] if r["page"] == page]
    return sorted({r["page"] for r in index["revs"]})


def resolve(index, locator):
    ref = f"{locator['path']}#{locator['fragment']}"
    for r in index["revs"]:
        if r["ref"] == ref:
            return {"excerpt": r["text"].split("\\n")[0], "label": f"{r['page']} rev {r['rev']}", "refs": [ref],
                    "key": None, "target": {"page": r["page"], "ref": ref}}
    return None
'''

WIKI_HTML = """<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; } body { background: var(--surface-card); overflow: hidden; }
#view { height: 100%; display: flex; flex-direction: column; }
.top { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px 8px; min-width: 0; }
#search { flex: 0 1 240px; min-width: 120px; }
#list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px 24px; border-top: 1px solid var(--border-subtle); }
.rev { margin: 0 0 18px; }
.rev h3 { margin: 0 0 6px; font: 500 var(--text-sm) / 1.4 var(--font-body); color: var(--text-primary); }
.rev h3 span { color: var(--text-tertiary); font-weight: 400; }
</style></head><body><div id="view">
<div class="top"><span id="search"></span><span id="colour"></span></div>
<div id="list"></div></div>
<script>
let current = 'Harbor'
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'author', title: 'Author' }], strip: '#list', onChange: () => show(current) })
const search = thimble.search({ mount: '#search', in: '#list', placeholder: 'Search revisions' })
async function show(page, ref) {
  current = page
  const revs = await thimble.fetch({ page })
  const list = document.getElementById('list')
  list.innerHTML = ''
  revs.slice().reverse().forEach((r, i, all) => {
    const prev = all[i + 1]
    const box = document.createElement('section')
    box.className = 'rev'
    box.innerHTML = '<div data-anchor="' + r.ref + '"' + colour.attr(r) + '><h3 data-thimble-chrome>Revision ' + r.rev + ' <span>by ' + r.author + '</span></h3><div class="d"></div></div>'
    list.appendChild(box)
    thimble.diff({ mount: box.querySelector('.d'), before: prev ? prev.text : '', after: r.text })
  })
  if (ref) { const el = document.querySelector('[data-anchor="' + ref + '"]'); if (el) el.scrollIntoView({ block: 'center' }) }
}
thimble.onOpen((place) => {
  const t = (place && place.target) || {}
  show(t.page || 'Harbor', t.ref)
})
</script></body></html>"""


def _mails(n: int) -> str:
    who = ["ana@harbor.org", "bo@harbor.org", "cy@coast.net", "dee@harbor.org"]
    subj = ["Ferry timetable for May", "Re: gale warning", "Invoice 2041", "Roster swap", "Lunch"]
    out = []
    for i in range(n):
        out.append(json.dumps({"from": who[i % 4], "subject": f"{subj[i % 5]} {i}", "t": 1775000000 + i * 3600,
                               "folder": ["Inbox", "Ops", "Billing"][i % 3], "body": f"The gale warning stands for day {i}."}))
    return "\n".join(out) + "\n"


def _revs() -> str:
    out = []
    for page in ["Harbor", "Ferries", "Contacts"]:
        lines = [f"# {page}"] + [f"- fact {k} about the {page.lower()}" for k in range(30)]
        for rev in range(1, 9):
            if rev > 1:
                lines[rev * 3 % 30 + 1] = f"- fact changed in revision {rev} about the {page.lower()}"
                lines.insert(rev * 2, f"- a new line in revision {rev}")
            out.append(json.dumps({"page": page, "rev": rev, "author": ["ana", "bo", "cy"][rev % 3], "t": 1775000000 + rev * 86400,
                                   "text": "\n".join(lines)}))
    return "\n".join(out) + "\n"


@pytest.fixture()
def corpora(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    for name, fname, text in [("inbox", "mail.jsonl", _mails(600)), ("wiki", "revisions.jsonl", _revs())]:
        (d / name).mkdir(parents=True)
        (d / name / "manifest.json").write_text(json.dumps({"name": name, "description": name}))
        (d / name / fname).write_text(text)
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d


@pytest.mark.parametrize("name", ["inbox", "wiki"])
async def test_a_kit_view_passes_the_checks(name, corpora, inproc, bound, tmp_path):
    if why := views.build_problem():
        pytest.skip(why)
    if name == "inbox":
        views.write_view("inbox", "inbox", name="Inbox", description="Mail in a table.", claims=["mail.jsonl"],
                         accepts=[{"form": "L<n>", "means": "one mail"}], reader=INBOX_READER, html=INBOX_HTML, libs=[])
        locs = ["mail.jsonl#L5", "mail.jsonl#L300"]
    else:
        views.write_view("wiki", "wiki", name="Wiki history", description="A page's revisions as diffs.",
                         claims=["revisions.jsonl"], accepts=[{"form": "L<n>", "means": "one revision"}],
                         reader=WIKI_READER, html=WIKI_HTML, libs=[])
        locs = ["revisions.jsonl#L3", "revisions.jsonl#L12"]
    rep = await views.check(name, name, locs, shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
    shown = next(s["shown"] for s in rep["shots"] if s["state"] == "overview")
    if name == "inbox":
        # the table drew a screen of its rows, too few for the check alone; the 600 it holds count
        fetched = max(int(s.get("fetched_records") or 0) for s in rep["shots"])
        assert shown["records"] < fetched // views.ANCHORED_SHARE and shown["held"] == 600, shown


FORGE_HTML = """<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; } body { background: var(--surface-card); overflow: hidden; }
#view { height: 100%; display: flex; flex-direction: column; }
.top { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px 8px; min-width: 0; }
#search { flex: 0 1 240px; min-width: 120px; }
#body { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--border-subtle); }
#list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px 24px; }
</style></head><body><div id="view">
<div class="top"><span id="search"></span><span id="colour"></span></div>
<div id="body"><div id="list"></div></div></div>
<script>
const mentions = [{ match: /#(\\d+)/g, ref: (m) => 'prs.jsonl#L' + m[1] }]
const colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'state', title: 'State' }], strip: '#list', onChange: () => draw() })
const side = thimble.side({ mount: '#body' })
const search = thimble.search({ mount: '#search', in: '#list', placeholder: 'Search pull requests' })
let prs = []
function draw() {
  document.getElementById('list').innerHTML = '<div class="thimble-cards">' + prs.map((pr) => thimble.recordCard({
    ref: pr.ref, record: pr, key: '#' + pr.number, meta: pr.state, title: pr.title,
    body: { html: thimble.text.html(pr.body, { mentions, fold: 0 }) } })).join('') + '</div>'
}
function open(ref) {
  const pr = prs.find((p) => p.ref === ref)
  if (pr) side.open({ title: pr.title, ref: pr.ref, render: (body) => thimble.text(body, pr.body, { ref: pr.ref, mentions }) })
}
document.getElementById('list').addEventListener('click', (e) => {
  const card = e.target.closest('.thimble-card')
  if (card) open(card.getAttribute('data-anchor'))
})
const loaded = thimble.fetch({}).then((rows) => { prs = rows; draw() })
thimble.onOpen(async (place) => {
  await loaded
  const t = (place && place.target) || {}
  if (t.ref) open(t.ref)
})
</script></body></html>"""


def _prs(n: int) -> str:
    out = []
    for i in range(1, n + 1):
        body = (f"## Summary\n\nFixes the **gale** warning for ferry {i}, after #{max(1, i - 1)}.\n\n"
                f"- [x] [Tests added](https://example.org/pull/{i})\n- [ ] Docs\n\n"
                f"```py\ndef gale(force):\n    return force >= {i % 12}\n```\n\n<script>window.pwned = {i}</script>\n")
        out.append(json.dumps({"number": i, "title": f"Fix the gale warning, part {i}",
                               "state": ["open", "merged", "closed"][i % 3], "body": body}))
    return "\n".join(out) + "\n"


async def test_a_forge_view_drawn_with_the_text_passes_the_checks(tmp_path, monkeypatch, workspaces_tmp, inproc, bound):
    """Pull requests as the kit's cards, each body in GitHub's markdown drawn by thimble.text (with the parser the
    interface builds, kit/markdown.js) in the card and whole in the side panel, its #123 mentions links to their pull
    requests: the view passes the whole check, the headless page included."""
    if why := views.build_problem():
        pytest.skip(why)
    d = tmp_path / "data" / "forge"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"name": "forge", "description": "forge"}))
    (d / "prs.jsonl").write_text(_prs(40))
    monkeypatch.setattr(config, "DATA_DIR", d.parent.resolve())
    dist = tmp_path / "dist"
    frontend = config.REPO_ROOT / "frontend"
    subprocess.run([str(frontend / "node_modules" / ".bin" / "esbuild"), "src/lib/kitMarkdown.ts", "--bundle",
                    "--format=iife", "--platform=browser", "--log-level=error", f"--outfile={dist / views.KIT_MARKDOWN_JS}"],
                   cwd=frontend, check=True, timeout=60)
    monkeypatch.setattr(config, "FRONTEND_DIST", dist)
    assert "window.__thimbleMarkdown" in (dist / views.KIT_MARKDOWN_JS).read_text("utf-8")
    reader = INBOX_READER.replace('"excerpt": m["body"], "label": m["subject"]', '"excerpt": m["title"], "label": m["title"]')
    views.write_view("forge", "pulls", name="Pull requests", description="Pull requests as cards.", claims=["prs.jsonl"],
                     accepts=[{"form": "L<n>", "means": "one pull request"}], reader=reader, html=FORGE_HTML, libs=[])
    rep = await views.check("forge", "pulls", ["prs.jsonl#L3", "prs.jsonl#L30"], shot_dir=tmp_path)
    assert rep["ok"], views.gate_lines(rep)
