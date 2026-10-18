// The explore view in cells: the drawing, the selected part tinted, the rows it opened below it, and one hint row.
// Plain JavaScript (no `$`, no Node), so a mod and a terminal command draw the same lines.
//
//   viewLines(view, { w }) -> [[{ s, tone, b?, u?, bg?, sel? }]]   tone and bg are palette.js tones
import { knobOf } from '../../draw/handoff.js'
import { len, renderTerm } from '../../draw/term.js'
import { keys } from './run.mjs'

export function viewLines(view, o = {}) {
  const w = o.w || 100
  const grid = renderTerm(view.drawing, { w })
  const sel = new Set()
  const r = view.region ? grid.regions.find(x => x.id === view.region) : null
  if (r) for (const q of r.rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) sel.add(y * grid.w + x)
  const out = grid.rows.map((row, y) => {
    const segs = []
    row.forEach((c, x) => {
      if (c.cont) return
      const s = sel.has(y * grid.w + x)
      const seg = { s: c.ch, tone: c.tone || 'ink' }
      if (c.b) seg.b = true
      if (c.ref) seg.u = true
      if (c.bg) seg.bg = c.bg
      if (s) seg.sel = true
      const last = segs[segs.length - 1]
      if (last && last.tone === seg.tone && !!last.b === !!seg.b && !!last.u === !!seg.u && last.bg === seg.bg && !!last.sel === !!seg.sel) last.s += seg.s
      else segs.push(seg)
    })
    return segs
  })
  if (view.rows) out.push(...rowsLines(view.rows, w))
  out.push(hintLine(view, w, o.hintRight))
  return out
}

/** The rows a part opened, as a fold under the view: what they are, a few of them with their refs, how many more. */
export function rowsLines(rows, w) {
  const lines = []
  const head = `${rows.count ? rows.count.toLocaleString('en-US') + ' row' + (rows.count === 1 ? '' : 's') : 'rows'} · ${rows.label}`
  const files = [...new Set(rows.refs.map(x => x.split('#')[0]).filter(x => !/^q\d+$|^obj:/.test(x)).map(x => x.replace(/^.*\//, '')))]
  lines.push([{ s: '┌ ', tone: 'rule' }, { s: cut(head, w - 4 - (files.length ? len(files[0]) + 3 : 0)), tone: 'ink', b: true },
    ...(files.length ? [{ s: ' · ' + cut(files.join(', '), Math.max(8, w - 6 - len(head))), tone: 'dim' }] : [])])
  if (!rows.records.length) lines.push([{ s: '│ ', tone: 'rule' }, { s: cut(rows.note || 'no rows', w - 2), tone: 'dim' }])
  for (const x of rows.records) {
    const ref = x.ref ? x.ref.replace(/^.*\//, '') : ''
    const rw = Math.min(len(ref), Math.floor(w * 0.36))
    lines.push([{ s: '│ ', tone: 'rule' }, ...(ref ? [{ s: cut(ref, rw), tone: 'accent', u: true }, { s: '  ' }] : []), { s: cut(x.text, w - 4 - rw), tone: 'ink' }])
  }
  const more = Math.max(0, rows.count - rows.records.length)
  lines.push([{ s: '└ ', tone: 'rule' }, { s: more ? `+ ${more.toLocaleString('en-US')} more` : 'all of them', tone: 'dim' },
    ...(rows.note && rows.records.length ? [{ s: ' · ' + cut(rows.note, w - 30), tone: 'dim' }] : [])])
  return lines
}

function hintLine(view, w, right) {
  const segs = []
  keys(view).forEach(([k, what], i) => {
    if (i) segs.push({ s: ' · ', tone: 'dim' })
    segs.push({ s: k, tone: 'ink', b: true }, { s: ' ' + what, tone: 'dim' })
  })
  const sel = view.region ? (knobOf(view.drawing, view.region) ? null : (view.drawing.regions || []).find(r => r.id === view.region)) : null
  if (sel && sel.meta && sel.meta.label) segs.unshift({ s: '▸ ' + cut(sel.meta.label, Math.floor(w * 0.4)) + '  ', tone: 'accent' })
  if (right) {
    const used = segs.reduce((n, x) => n + len(x.s), 0)
    if (used + len(right) + 2 <= w) segs.push({ s: ' '.repeat(w - used - len(right)) + right, tone: 'dim' })
  }
  return segs
}

function cut(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ')
  if (n <= 1) return ''
  return len(s) <= n ? s : Array.from(s).slice(0, n - 1).join('') + '…'
}
