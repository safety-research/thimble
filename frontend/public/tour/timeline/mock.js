'use strict'
// The Timeline view's side of thimble's scope header (shared/scope-head.js): its unit (a day), the files it reads by
// folder, its schema and labels.
;(() => {
  const D = window.DATA
  const plural = window.ScopeHead.plural
  const LOOKUP = { 'chat/users.json': 'names the people', 'tickets/index.csv': 'ticket fields' }
  const bad = {}
  for (const p of D.problems) { const f = p.ref.split('#')[0]; bad[f] = (bad[f] || 0) + 1 }
  const row = (f, dir) => ({
    path: f, dir: '', name: dir ? f.slice(dir.length + 1) : f,
    gives: LOOKUP[f] || plural(D.per_file[f] || 0, 'event'),
    bad: bad[f] ? [`${plural(bad[f], 'line')} could not be read`] : [],
  })
  function files() {
    const folders = new Map(), top = []
    for (const f of D.files) { const i = f.indexOf('/'); if (i < 0) top.push(f); else { const k = f.slice(0, i); folders.set(k, [...(folders.get(k) || []), f]) } }
    const events = (fs) => fs.reduce((s, f) => s + (D.per_file[f] || 0), 0)
    const groups = [...folders].map(([k, fs]) => ({ title: k + '/', note: `${plural(fs.length, 'file')} · ${plural(events(fs), 'event')}`, rows: fs.map((f) => row(f, k)), collapsed: fs.length > 8 }))
    groups.push({ title: 'ferry-ops/', note: `${plural(top.length, 'file')} · ${plural(events(top), 'event')}`, rows: top.map((f) => row(f)) })
    return { count: D.files.length, summary: `${plural(D.files.length, 'file')} read, none hidden, merged into ${plural(D.events.length, 'event')}`, groups }
  }
  const counts = {}
  for (const e of D.events) for (const m of e.marks) counts[m] = (counts[m] || 0) + 1
  const SIDE = '<button type="button" class="btn btn-ghost btn-sm btn-square view-pane-side-show" aria-label="Show labels" title="Show labels"><svg class="icon icon-sidebar btn-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14"></path></svg></button>'
  const head = window.ScopeHead.mount({
    host: document.querySelector('.view-pane-head.scope-head'),
    side: SIDE,
    unit: { label: 'Day', multi: false, options: [{ key: '2026-05-16', title: '16 May 2026', sub: '01:40–13:40 UTC', note: `${plural(D.events.length, 'event')}<br>${plural(D.files.length, 'file')}` }] },
    compare: false,
    files,
    problems: () => D.problems,
    derived: {
      records: D.records,
      count: (name) => name === 'event' ? D.events.length : name === 'incident' ? new Set(D.events.map((e) => e.incident).filter(Boolean)).size : null,
      labels: D.labels.map((l) => ({ name: l.name, colour: l.colour, how: `${l.kind}: ${l.re}`, n: plural(counts[l.name] || 0, 'event') })),
      labelsOn: 'on each event',
    },
  })
  window.mockHead = head
})()
