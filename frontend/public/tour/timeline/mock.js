'use strict'
// The Timeline view's side of thimble's scope header (shared/scope-head.js): its unit (a day), the files it reads by
// folder, its schema and labels. Before the strip, thimble's label control says how many labels are on in the page;
// after it, the page's Only these shows as thimble's filter chip with how many events it hides, and the chip clears it.
;(() => {
  const D = window.DATA
  const plural = window.ScopeHead.plural
  const LOOKUP = { 'chat/users.json': 'names the people', 'tickets/index.csv': 'ticket fields' }
  const bad = {}
  for (const p of D.problems) { const f = p.ref.split('#')[0]; bad[f] = (bad[f] || 0) + 1 }
  const row = (f, dir) => ({
    path: f, dir: '', name: dir ? f.slice(dir.length + 1) : f,
    gives: LOOKUP[f] || plural(D.per_file[f] || 0, 'event'),
    bad: bad[f] ? [`${bad[f]} unreadable ${bad[f] === 1 ? 'line' : 'lines'}`] : [],
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
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const icon = (name, d, size, cls) => `<svg class="icon icon-${name} ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${name === 'label' ? 2 : 1.75}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`
  const LABEL = 'M4 4h8l8 8-8 8-8-8zM8 8h.01', X = 'M6 6l12 12M18 6L6 18'
  const page = document.querySelector('.view-pane-frame')
  const pageApi = () => { try { return page.contentWindow.mock || null } catch { return null } }
  let on = D.labels.length
  let filter = null
  const side = () => `<button type="button" class="btn btn-ghost btn-sm view-pane-side-show" title="Show labels">${icon('label', LABEL, 14, 'btn-ico')}<span class="btn-label">${on ? `${plural(on, 'label')} on` : 'Labels'}</span></button>`
  const tail = () => {
    if (!filter) return ''
    const l = D.labels.find((x) => x.name === filter)
    const hidden = D.events.filter((e) => !e.marks.includes(filter)).length
    return `<button type="button" class="chip chip-value chip-tone-neutral chip-act active view-pane-filter" aria-pressed="true" aria-label="Clear the filter ${esc(filter)} ${esc(l.value)}" data-clear>${icon('label', LABEL, 10, 'chip-ico')}<span class="chip-text">${esc(filter)} · ${esc(l.value)}</span>${icon('x', X, 10, 'chip-ico chip-ico-trail')}</button>` +
      (hidden ? `<span class="view-pane-hidden" title="Events of this view the filter ${esc(filter)} · ${esc(l.value)} hides">${hidden} hidden</span>` : '')
  }
  const wire = (host) => {
    const b = host.querySelector('[data-clear]')
    if (b) b.onclick = (e) => {
      e.stopPropagation()
      filter = null
      const m = pageApi()
      if (m) { m.thimble.state.iso = null; m.render() }
      head.render()
    }
  }
  addEventListener('message', (e) => {
    if (e.source !== page.contentWindow || e.data?.thimbleMock !== 'filter' || !D.labels.some((l) => l.name === e.data.label)) return
    filter = e.data.label
    head.render()
  })
  // the page's labels as they are switched on and off, heard once its page has loaded
  let heard = null
  const hear = () => {
    const m = pageApi()
    if (!m || heard === m) return
    heard = m
    const count = () => { const n = m.thimble.labels().length; if (n !== on) { on = n; head.render() } }
    m.thimble.onColour(count)
    count()
  }
  page.addEventListener('load', hear)
  const head = window.ScopeHead.mount({
    host: document.querySelector('.view-pane-head.scope-head'),
    side,
    tail,
    wire,
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
  hear()
  window.mockHead = head
})()
