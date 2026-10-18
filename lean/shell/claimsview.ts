// claimsview.ts: the Claims pane as Claude Code elements. No `$`: the shell resolves the elements and hands in the
// store's view (verbs/claims/claims.js viewOf and timeline) and what a press does.
//
//   claimsPaneEl(els, o)   c opens it, focused: a head line (how many claims, from where, deduped, how many clusters,
//                          and the keys), the clusters with their claims in one or two columns (a fact or interp tag,
//                          ×N when said again; a revised claim struck through with "revised", the claim that replaced
//                          it under it after └→), the time strip (one dot per message that said claims; ] [ replay
//                          them in the order made), and the details of the claim the ring is on: where it was said,
//                          its sources as cite marks, ×N, and what revised it.
import { width } from './message.js'
import { markColors, verbColor } from './view'
import type { Theme } from './view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Seg = { s: string; p?: Record<string, unknown> }

/** The clusters' colors (the dot before a cluster's name), per theme, in the order the clusters began. */
export function clusterColor(i: number, theme: Theme): string {
  const light = ['#2f6fb5', '#b9466e', '#c27a1c', '#2f8a5b', '#7652a8', '#2a8a85', '#8a6a3a', '#4f55a8']
  const dark = ['#6aa8ea', '#e57fa5', '#e6a64e', '#6cc493', '#b394e6', '#5fc9c1', '#cfae7e', '#9da3f0']
  return (theme === 'light' ? light : dark)[i % light.length]!
}

const cutTo = (s: string, n: number) => {
  if (n <= 0) return ''
  if (width(s) <= n) return s
  let out = ''
  for (const ch of s) {
    if (width(out + ch) > n - 1) break
    out += ch
  }
  return out + '…'
}
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))

function clip(segs: Seg[], n: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const g of segs) {
    const w = width(g.s)
    if (used + w <= n) { out.push(g); used += w; continue }
    const room = n - used
    if (room > 1) out.push({ ...g, s: cutTo(g.s, room) })
    break
  }
  return out
}
const segWidth = (segs: Seg[]) => segs.reduce((n, g) => n + width(g.s), 0)
const texts = (els: Any, segs: Seg[]) => segs.map(g => els.Text({ ...(g.p || {}), children: g.s }))
/** One line of `w` cells: the left part, then the right part at the right edge. */
function line(els: Any, key: string, w: number, left: Seg[], right: Seg[] = []): Any {
  const r = clip(right, Math.floor(w / 2))
  const l = clip(left, w - segWidth(r) - (r.length ? 1 : 0))
  return els.Box({ key, flexDirection: 'row', width: w, children: [...texts(els, l), els.Text({ children: ' '.repeat(Math.max(0, w - segWidth(l) - segWidth(r))) }), ...texts(els, r)] })
}

export type ClaimsPaneOpts = {
  w: number
  h: number
  theme: Theme
  view: Any
  moments: Any[]
  cursor: number
  focus: string | null
  asking: boolean
  offer: { what: string; minutes: number | null; tokens: number | null } | null
  oriented: { claims: number; clusters: number } | null
  onFocus: (id: string) => unknown
  onSource: (i: number) => unknown
  onTime: (k: number) => unknown
  onOrient: () => unknown
  onClose: () => unknown
  onAsk: () => unknown
}

/** The key of a claim's row, which the focus ring lands on. */
export const claimKey = (id: string) => `cl-${id}`
export const claimOfKey = (key: string) => (/^cl-(.+)$/.exec(String(key || '')) || [])[1] ?? null

const TAGW = 8
const XNW = 4

/** A cluster's rows: its head, then its claims in the order said, a revised claim's replacement right under it. */
function clusterRows(els: Any, o: ClaimsPaneOpts, g: Any, ci: number, cw: number, seen: { upto: Set<string>; at: Set<string>; n: (c: Any) => number }, replaying: boolean): { el: Any; claim?: string }[] {
  const tone = verbColor('c', o.theme)
  const warn = o.theme === 'light' ? '#b7791f' : '#e0a43a'
  const hl = o.theme === 'light' ? '#f6e8c3' : '#3b321f'
  const shown = g.claims.filter((c: Any) => seen.upto.has(c.id)).length
  const out: { el: Any; claim?: string }[] = []
  out.push({ el: line(els, `ch-${g.id}`, cw, [
    { s: '● ', p: { color: g.id == null ? undefined : clusterColor(ci, o.theme), dimColor: g.id == null } },
    { s: g.name, p: { bold: true } },
    { s: ` · ${replaying ? shown : g.claims.length}`, p: { dimColor: true } },
    ...(g.from === 'orientation' ? [{ s: ' · from the corpus', p: { dimColor: true } }] : []),
  ]) })
  const ids = new Set(g.claims.map((c: Any) => c.id))
  const placed = new Set<string>()
  const textW = Math.max(10, cw - 2 - TAGW - XNW)
  const row = (c: Any, lead: string) => {
    const visible = seen.upto.has(c.id)
    if (!visible) return { el: line(els, `cb-${c.id}`, cw, []), claim: undefined }
    const revised = !!c.revised_by && seen.upto.has(c.revised_by)
    const fresh = replaying && seen.at.has(c.id)
    const bg = fresh ? { backgroundColor: hl } : {}
    const tag = revised ? 'revised' : c.tag
    const text = cutTo(c.text, textW - width(lead))
    const segs: Seg[] = [
      { s: lead, p: { color: tone, ...bg } },
      { s: text, p: { ...bg, ...(revised ? { strikethrough: true, dimColor: true } : {}), ...(c.by === 'person' ? { italic: true } : {}) } },
      { s: ' '.repeat(Math.max(0, textW - width(lead) - width(text))), p: bg },
      { s: pad(tag, TAGW), p: { ...bg, ...(revised ? { color: warn } : { dimColor: true }) } },
      { s: pad(seen.n(c) > 1 ? `×${seen.n(c)}` : '', XNW), p: { ...bg, color: tone } },
    ]
    const kids = texts(els, segs)
    // a Button holds Text only: the row is one line of Texts, as wide as the column
    return { claim: c.id as string, el: els.Box({ key: `cr-${c.id}`, flexDirection: 'row', width: cw, children: [els.Button({ key: claimKey(c.id), plain: true, label: `claim: ${c.text}`, children: [els.Text({ children: '  ' }), ...kids], onPress: () => o.onFocus(c.id) })] }) }
  }
  for (const c of g.claims as Any[]) {
    if (placed.has(c.id)) continue
    placed.add(c.id)
    out.push(row(c, ''))
    // the claim that replaced it, right under it: in this cluster, the claim itself; elsewhere, a pointer to it
    let cur = c
    while (cur.revised_by && seen.upto.has(cur.revised_by)) {
      const rep = (o.view.flat as Any[]).find(x => x.id === cur.revised_by)
      if (!rep) break
      if (ids.has(rep.id) && !placed.has(rep.id)) {
        placed.add(rep.id)
        out.push(row(rep, '└→ '))
        cur = rep
      } else {
        out.push({ el: line(els, `cp-${c.id}`, cw, [{ s: '  └→ ', p: { color: tone } }, { s: cutTo(rep.text, cw - 30), p: { dimColor: true } }, { s: ` · in ${rep.cluster ? (o.view.groups as Any[]).find(x => x.id === rep.cluster)?.name ?? '' : 'between clusters'}`, p: { dimColor: true } }]) })
        break
      }
    }
  }
  return out
}

/** The rows of a column that fit `room`: all, else those around the claim the ring is on. */
function windowed(rows: { el: Any; claim?: string }[], room: number, focus: string | null, els: Any, cw: number, key: string): Any[] {
  if (rows.length <= room) return rows.map(r => r.el)
  const at = focus ? rows.findIndex(r => r.claim === focus) : -1
  const from = at < 0 ? 0 : Math.max(0, Math.min(rows.length - room, at - Math.floor(room / 3)))
  const body = rows.slice(from + (from > 0 ? 1 : 0), from + room - (from + room < rows.length ? 1 : 0))
  return [
    ...(from > 0 ? [line(els, `${key}-up`, cw, [{ s: `  ↑ ${from + 1} more rows`, p: { dimColor: true } }])] : []),
    ...body.map(r => r.el),
    ...(from + room < rows.length ? [line(els, `${key}-dn`, cw, [{ s: `  ↓ ${rows.length - from - room + 1} more rows`, p: { dimColor: true } }])] : []),
  ]
}

/** The time strip: one dot per moment, the turns named above their first moment, the cursor's moment named below. */
function timeStrip(els: Any, o: ClaimsPaneOpts, w: number): Any[] {
  const tone = verbColor('c', o.theme)
  const ms = o.moments
  const lead = 'time   '
  const room = Math.max(10, w - width(lead) - 2)
  if (!ms.length) return [line(els, 'ts-0', w, [{ s: lead, p: { dimColor: true } }, { s: 'no claims yet', p: { dimColor: true } }])]
  const step = ms.length > 1 ? Math.max(1, Math.min(10, Math.floor((room - 1) / (ms.length - 1)))) : 0
  const xs = ms.map((_: Any, i: number) => i * step)
  const span = xs[xs.length - 1] + 1
  // the turns' names above
  let top = ''
  ms.forEach((m: Any, i: number) => {
    const first = i === 0 || ms[i - 1].turn !== m.turn || (m.by === 'orientation') !== (ms[i - 1].by === 'orientation')
    if (!first) return
    const name = m.by === 'orientation' ? 'corpus' : `turn ${m.turn ?? '?'}`
    if (xs[i] >= top.length) top = pad(top, xs[i]) + name + ' '
  })
  // the strip: ● a moment shown, ○ one to come, ◉ the cursor
  const cells: Seg[] = []
  for (let x = 0; x < span; x++) {
    const i = xs.indexOf(x)
    if (i >= 0) cells.push({ s: i === o.cursor ? '◉' : i <= o.cursor ? '●' : '○', p: { color: i <= o.cursor ? tone : undefined, dimColor: i > o.cursor, bold: i === o.cursor } })
    else {
      const k = xs.findIndex(v => v > x) - 1
      cells.push({ s: '─', p: { color: k < o.cursor ? tone : undefined, dimColor: k >= o.cursor } })
    }
  }
  const m = ms[Math.min(o.cursor, ms.length - 1)]
  const shown = ms.slice(0, o.cursor + 1).reduce((n: number, x: Any) => n + x.claims.length, 0)
  const total = ms.reduce((n: number, x: Any) => n + x.claims.length, 0)
  const name = m.by === 'orientation' ? 'the corpus orientation' : `turn ${m.turn ?? '?'} · ${m.what}`
  const label = `▲ ${name} · ${shown} of ${total} claims`
  const at = Math.max(0, Math.min(room - width(label), xs[Math.min(o.cursor, xs.length - 1)] - 1))
  return [
    line(els, 'ts-top', w, [{ s: ' '.repeat(width(lead)) }, { s: top, p: { bold: true } }]),
    line(els, 'ts-mid', w, [{ s: lead, p: { dimColor: true } }, ...cells]),
    line(els, 'ts-bot', w, [{ s: ' '.repeat(width(lead) + at) }, { s: label, p: { dimColor: true } }]),
  ]
}

/** The details of the claim the ring is on, in a few lines: what it says (and what revised it), where it was said,
 *  its sources as cite marks, ×N. */
function details(els: Any, o: ClaimsPaneOpts, w: number, rows: number, seen: { upto: Set<string>; n: (c: Any) => number }): Any[] {
  const { Box, Button, Text } = els
  const tone = verbColor('c', o.theme)
  const warn = o.theme === 'light' ? '#b7791f' : '#e0a43a'
  const cite = markColors(o.theme).cite
  const out: Any[] = [line(els, 'dt-rule', w, [{ s: '── details ' + '─'.repeat(Math.max(0, w - 11)), p: { dimColor: true } }])]
  const found = o.focus ? (o.view.flat as Any[]).find(x => x.id === o.focus) : null
  const c = found && seen.upto.has(found.id) ? found : null
  if (!c) {
    out.push(line(els, 'dt-none', w, [{ s: found ? `the claim the ring was on is said later, in turn ${found.turn ?? '?'} · ] moves on` : 'select a claim (↑ ↓) to see where it was said, its sources, and how often', p: { dimColor: true } }]))
  } else {
    const rep = c.replacement && seen.upto.has(c.replacement.id) ? c.replacement : null
    const right: Seg[] = rep ? [{ s: `revised in turn ${rep.turn ?? '?'} → `, p: { color: warn } }, { s: rep.text }] : c.original ? [{ s: 'revises ', p: { dimColor: true } }, { s: c.original.text, p: { strikethrough: true, dimColor: true } }] : []
    out.push(line(els, 'dt-claim', w, [{ s: c.text, p: { bold: true, ...(c.revised_by ? { strikethrough: true } : {}) } }], right))
    const first = c.said[0] || {}
    const who = (by: string) => (by === 'person' ? 'you' : by === 'orientation' ? 'the corpus' : 'Claude')
    const meta: Seg[] = [
      { s: first.by === 'orientation' ? 'from the corpus orientation' : `said in turn ${first.turn ?? '?'} by ${who(first.by)}`, p: { dimColor: true } },
      ...(seen.n(c) > 1 ? [{ s: ' · ', p: { dimColor: true } }, { s: `×${seen.n(c)}`, p: { color: tone, bold: true } }, { s: ' restated, merged', p: { dimColor: true } }] : []),
      { s: ` · ${c.tag}`, p: { dimColor: true } },
      { s: ` · ${c.cluster ? (o.view.groups as Any[]).find(x => x.id === c.cluster)?.name ?? '' : 'between clusters'}`, p: { dimColor: true } },
    ]
    out.push(line(els, 'dt-meta', w, meta))
    // its sources as cite marks, each on a digit
    const src = (c.sources || []).slice(0, 7)
    const kids: Any[] = [Text({ dimColor: true, children: 'sources ' })]
    let used = 8
    if (!src.length) kids.push(Text({ dimColor: true, children: 'no citation in or near its sentence' }))
    src.forEach((s: Any, i: number) => {
      const label = cutTo(String(s.label || s.ref), 26)
      // the engine draws a Button with a hotkey as "2: label"
      const need = width(`${i + 2}: `) + width(label) + 2
      if (used + need > w) return
      used += need
      kids.push(Button({ key: `src-${i}`, plain: true, hotkey: String(i + 2), label: `cite ${label}`, children: [Text({ color: cite, underline: true, children: label })], onPress: () => o.onSource(i) }))
      kids.push(Text({ children: '  ' }))
    })
    out.push(Box({ key: 'dt-src', flexDirection: 'row', width: w, children: kids }))
    // where it was said: each place, its words
    const room = Math.max(0, rows - 5)
    const said = c.said.slice(0, Math.max(1, seen.n(c)))
    const places = said.slice(0, room)
    places.forEach((p: Any, i: number) => out.push(line(els, `dt-p${i}`, w, [
      { s: p.by === 'orientation' ? 'corpus  ' : `turn ${p.turn ?? '?'} `.padEnd(8), p: { dimColor: true } },
      { s: who(p.by).padEnd(7), p: { dimColor: true } },
      { s: p.quote ? `"${p.quote}"` : p.ref ? String(p.ref) : '' },
    ])))
    if (said.length > places.length) out.push(line(els, 'dt-pm', w, [{ s: `+ ${said.length - places.length} more places`, p: { dimColor: true } }]))
    out.push(o.asking
      ? line(els, 'dt-keys', w, [{ s: 'type your question below · ↵ sends it with this claim', p: { color: tone } }])
      : Box({ key: 'dt-keys', flexDirection: 'row', width: w, children: [
        Button({ key: 'k-ask', plain: true, hotkey: '1', label: 'ask about this claim', onPress: o.onAsk, children: [Text({ dimColor: true, children: 'ask' })] }),
        Text({ dimColor: true, children: `${src.length ? ` · ${src.length > 1 ? `2–${src.length + 1}` : '2'} open a source` : ''} · 0 close` }),
      ] }))
  }
  while (out.length < rows) out.push(line(els, `dt-pad${out.length}`, w, []))
  return out.slice(0, Math.max(rows, out.length))
}

export function claimsPaneEl(els: Any, o: ClaimsPaneOpts): Any {
  const { Box, Button, Text } = els
  const tone = verbColor('c', o.theme)
  const v = o.view
  const w = Math.max(40, o.w)
  const last = Math.max(0, o.moments.length - 1)
  const cursor = Math.max(0, Math.min(o.cursor, last))
  const replaying = cursor < last
  // the claims said by the cursor's moment
  const upto = new Set<string>()
  const at = new Set<string>()
  o.moments.forEach((m: Any, i: number) => { if (i <= cursor) for (const id of m.claims) { upto.add(id); if (i === cursor) at.add(id) } })
  if (!o.moments.length) for (const c of v.flat as Any[]) upto.add(c.id)
  // ×N by the cursor: the places said in a moment up to it (a place at a message that first said nothing counts by
  // its turn)
  const momentOf = new Map<string, number>()
  o.moments.forEach((m: Any, i: number) => { if (m.row) momentOf.set(m.row, i) })
  const cm = o.moments[cursor]
  const nAt = (c: Any) => (!replaying ? c.n : (c.said as Any[]).filter(p => {
    if (p.row && momentOf.has(p.row)) return momentOf.get(p.row)! <= cursor
    if (p.by === 'orientation') return o.moments.some((m: Any, i: number) => i <= cursor && m.by === 'orientation')
    return cm && p.turn != null && cm.turn != null && p.turn < cm.turn
  }).length)
  const shownN = upto.size
  const orientN = (v.flat as Any[]).filter(c => c.by === 'orientation').length
  const left: Seg[] = clip([
    { s: 'Claims', p: { color: tone, bold: true } },
    { s: ' · ', p: { dimColor: true } }, { s: String(replaying ? shownN : v.total), p: { bold: true } },
    { s: ` from Claude's work and our chat${orientN ? ' and the corpus' : ''} · deduped · ${v.clusters} cluster${v.clusters === 1 ? '' : 's'}`, p: { dimColor: true } },
  ], w - 36)
  const keysR: Seg[] = [{ s: '↑ ↓', p: { color: tone } }, { s: ' claim · ', p: { dimColor: true } }, { s: '] [', p: { color: tone } }, { s: ' time · ', p: { dimColor: true } }]
  // the engine draws the close Button as "0: close"
  const head = Box({ key: 'head', flexDirection: 'row', width: w, children: [
    ...texts(els, left), Text({ children: ' '.repeat(Math.max(1, w - segWidth(left) - segWidth(keysR) - 8)) }), ...texts(els, keysR),
    Button({ key: 'k-close', plain: true, hotkey: '0', label: 'close', onPress: o.onClose, children: [Text({ dimColor: true, children: 'close' })] }),
  ] })
  // the clusters, in one column or two, each column as tall as the room
  // two columns once each can show a claim whole (about 70 cells), else one
  const two = w >= 150
  const gap = 4
  const cw = two ? Math.floor((w - gap) / 2) : w
  const fixed = 2 + 1 + 3 + 1 + 7 + (o.offer || o.oriented ? 1 : 0)
  const room = Math.max(6, o.h - fixed)
  const cols: { el: Any; claim?: string }[][] = two ? [[], []] : [[]]
  const groups = v.groups as Any[]
  groups.forEach((g, i) => {
    const rows = clusterRows(els, o, g, i, cw, { upto, at, n: nAt }, replaying)
    const k = two && cols[1]!.length < cols[0]!.length ? 1 : 0
    if (cols[k]!.length) cols[k]!.push({ el: line(els, `gap-${g.id}`, cw, []) })
    cols[k]!.push(...rows)
  })
  const colEls = cols.map((rows, k) => Box({ key: `col${k}`, flexDirection: 'column', width: cw, children: windowed(rows, room, o.focus, els, cw, `col${k}`) }))
  const body = Box({ key: 'cols', flexDirection: 'row', children: two ? [colEls[0], Box({ width: gap }), colEls[1]] : colEls, height: Math.min(room, Math.max(...cols.map(c => c.length))) })
  const empty = !v.total ? [line(els, 'none', w, [{ s: 'No claims yet. They are read after each turn of work, from what Claude and you said.', p: { dimColor: true } }])] : []
  const offer = o.oriented
    ? [line(els, 'oriented', w, [{ s: `the corpus orientation added ${o.oriented.claims} claims in ${o.oriented.clusters} clusters`, p: { dimColor: true } }])]
    : o.offer
      ? [Box({ key: 'orient-row', flexDirection: 'row', width: w, children: [Button({ key: 'orient', plain: true, hotkey: 'm', label: 'orient on the whole corpus', onPress: o.onOrient, children: [
          Text({ children: 'orient on the whole corpus' }),
          Text({ dimColor: true, children: ` · ${o.offer.what}${o.offer.minutes ? ` · ~${o.offer.minutes} min` : ''}${o.offer.tokens ? ` · ~${Math.round(o.offer.tokens / 1000)}k tokens` : ''}` }),
        ] })] })]
      : []
  const gaps = (v.gaps || []).slice(-1).map((g: Any) => line(els, `gap-t${g.turn}`, w, [{ s: `turn ${g.turn} was not read: ${g.why}`, p: { dimColor: true, italic: true } }]))
  return Box({ flexDirection: 'column', width: w, children: [
    head, line(els, 'sp1', w, []), ...empty, body, ...gaps, ...offer, line(els, 'sp2', w, []),
    ...timeStrip(els, { ...o, cursor }, w), ...details(els, o, w, 7, { upto, n: nAt }),
  ] })
}
