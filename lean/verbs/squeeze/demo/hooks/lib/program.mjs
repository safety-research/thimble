// program.mjs: the program every squeeze object carries, written against the drawing contract (lean/draw/TOOLKIT.md).
//
// It draws the version at data.at: one region per squeezed line (`line-1`, `line-2`, ...), each with a cite that holds
// the original spans it came from, then one dim line with the dimensions Claude chose and where this version sits on
// each, and, when the version left something out, one dim line naming it. Wide (k.w >= 110), or with data.show set to
// 'original', the original is drawn beside it (or under it): the spans this version uses are links to the line they
// feed, so selecting a line lights its sources too, and the spans it left out are dim.
//
// The program is the real function below; PROGRAM is its text as an object keeps it, the body of (k, data) => node.

export function squeezeProgram(k, data) {
  const spans = data.spans || []
  const byId = {}
  spans.forEach(s => { byId[s.id] = s })
  const dims = data.dims || []
  const versions = data.versions || []
  const at = data.at || {}
  const dist = v => dims.reduce((n, d) => n + Math.abs(((v.at || {})[d.id] || 0) - (at[d.id] || 0)), 0)
  const v = versions.slice().sort((a, b) => dist(a) - dist(b))[0] || { lines: [], out: [] }

  // Markdown of a line or span as toolkit markup: **bold** stays, `code` in its own tone, links keep their words
  const md = s => k.escape(String(s || ''))
    .replace(/\\\[([^\]\n]*?)\\\]\([^)\s]*\)/g, '$1')
    .replace(/`([^`]*)`/g, (m, c) => '{c2:' + c + '}')
    .replace(/\\\*\\\*([^*]+?)\\\*\\\*/g, '**$1**')
  const words = s => String(s || '').replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/`|\*\*/g, '').replace(/[\[\]{}\\]/g, '').replace(/\s+/g, ' ').trim()
  const ids = from => (from || []).filter(id => byId[id])
  const span = id => byId[id].kind === 'h' ? words(byId[id].text).toUpperCase() : words(byId[id].text)
  const range = list => {
    // "2.1-2.3, 4.2": runs of neighbors in one block shown as a range
    if (!list.every(id => /^\d+\.\d+$/.test(id))) return list.join(', ')
    const out = []
    list.forEach(id => {
      const [b, s] = id.split('.').map(Number)
      const last = out[out.length - 1]
      if (last && last.b === b && last.to + 1 === s) last.to = s
      else out.push({ b, from: s, to: s })
    })
    return out.map(r => r.from === r.to ? `${r.b}.${r.from}` : `${r.b}.${r.from}-${r.b}.${r.to}`).join(', ')
  }

  // the squeezed lines: one region each, its cite the spans it came from
  const used = {}
  const lines = (v.lines || []).map((l, i) => {
    const id = 'line-' + (i + 1)
    const from = ids(l.from)
    from.forEach(s => { if (used[s] == null) used[s] = id })
    k.cite(id, {
      text: from.map(span).join(' '),
      source: from.length ? `the original, ${from.length === 1 ? 'span' : 'spans'} ${range(from)}` : 'no span of the original',
      rows: from.map(s => ({ span: s, text: span(s) })),
      note: l.problem || undefined,
    })
    return k.region(id, { label: words(l.text), cite: id, from, problem: l.problem || undefined },
      k.text(md(l.text) + (l.problem ? ' {warn:?}' : '')))
  })

  // where this version sits: each dimension Claude chose, as a region whose note says why it matters here
  const dot = (d, lvl) => (d.levels || []).map((_, i) => i === lvl ? '{accent:●}' : '{dim:○}').join('')
  const n = data.of && data.of.lines
  const kept = (v.lines || []).length
  const dimParts = dims.map(d => {
    const lvl = Math.max(0, Math.min((d.levels || []).length - 1, (v.at || {})[d.id] || 0))
    const name = d.name || d.id
    return k.region('dim-' + d.id, { label: `${name}: ${(d.levels || [])[lvl] || ''}`, note: d.why, levels: d.levels, at: lvl },
      k.text(`{dim:${k.escape(name)}} ${k.escape((d.levels || [])[lvl] || '')} ${dot(d, lvl)}`, { wrap: false }))
  })
  const count = k.text(`{dim:${kept}${n ? ` of ${k.fmt(n)}` : ''} ${(n || kept) === 1 ? 'line' : 'lines'}}`, { wrap: false })
  const dimLine = k.beside([count].concat(dimParts), { gap: 3 })
  const out = (v.out || []).filter(o => o && o.what)
  const outLine = out.length && k.region('left-out', { label: 'left out', note: out.map(o => o.what).join('; '), from: out.map(o => ids(o.from)) },
    k.text(`{dim:left out: ${out.map(o => k.escape(o.what)).join(' · ')}}`))
  const version = k.stack(k.stack(lines), dimLine, outLine || false)

  const wide = k.w >= 110
  if (data.show !== 'original' && !wide) return version

  // the original, its used spans linked to the line they feed (a link's words are cut into pieces the toolkit reads
  // as one link each, under 200 characters)
  const link = (t, id) => {
    const pieces = []
    let cur = ''
    t.split(' ').forEach(w => { if (cur && cur.length + w.length + 1 > 200) { pieces.push(cur); cur = w } else cur = cur ? cur + ' ' + w : w })
    if (cur) pieces.push(cur)
    return pieces.map(p => `[${p}](#${id})`).join(' ')
  }
  const blocks = data.blocks || []
  const orig = k.stack(blocks.map(b => {
    const parts = (b.spans || []).filter(id => byId[id]).map(id => {
      const t = span(id)
      return used[id] ? `{ink:${link(t, used[id])}}` : `{dim:${k.escape(t)}}`
    })
    const lead = b.kind === 'li' ? '• ' : b.kind === 'quote' ? '│ ' : ''
    return k.text(lead + parts.join(' '), { tone: b.kind === 'h' ? 'dim' : 'ink' })
  }), { gap: 0 })
  const origFrame = k.frame(orig, { title: 'the original', right: n ? `${k.fmt(n)} lines` : '', bottom: 'underlined: in this version · dim: left out' })
  if (wide) return k.beside(k.size(version, { w: Math.max(40, Math.floor(k.w * 0.42)) }), k.size(origFrame, { grow: 1 }), { gap: 3 })
  return k.stack(version, origFrame, { gap: 1 })
}

export const PROGRAM = `return (${squeezeProgram.toString()})(k, data)`
