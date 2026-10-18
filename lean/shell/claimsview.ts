// claimsview.ts: the Claims drawings as Claude Code elements. No `$`: the shell resolves the elements and hands in the
// store's view (verbs/claims/claims.js viewOf) and what a press does.
//
//   claimsListEl(els, o)   under a message, when c is pressed: the session's clusters with their claims, in a frame.
//                          A claim the message added is marked +; a revised claim is struck through, with → and the
//                          claim that replaced it; ×N when it was said again. 1–9 open a cluster, ] [ step through the
//                          claims, and the corpus orientation is offered on the next digit with its time and tokens.
//   claimCardEl(els, o)    the selected claim in the tray: where it was said (turn, who, the words), its sources as cite
//                          marks (2–9 open one), and what revised it or what it revises.
import { width } from './message.js'
import { markColors, verbColor } from './view'
import type { Theme } from './view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Seg = { s: string; p?: Record<string, unknown> }

/** The kinds' colors (secondary: a dot before each claim), per theme. */
export function kindColor(kind: string, theme: Theme): string {
  const c: Record<string, [string, string]> = { fact: ['#5b6b82', '#8fa1bd'], finding: ['#1f8a84', '#3cc2b9'], judgment: ['#c25c8a', '#e384b2'], event: ['#a8875a', '#cfae7e'], claim: ['#7b5bb6', '#a98be0'] }
  const pair = c[kind] || c.claim!
  return theme === 'light' ? pair[0] : pair[1]
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

/** Segments clipped to `n` cells: the last that does not fit is cut with …, the rest dropped. */
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

/** A frame's top or bottom border with words on it: ╭─ title ──── right ─╮ */
function border(els: Any, w: number, tone: string, left: Seg[], right: Seg[], bottom: boolean): Any {
  const a = bottom ? '╰─ ' : '╭─ '
  const room = w - 6
  const r = clip(right, Math.max(0, Math.floor(room / 2)))
  const l = clip(left, Math.max(4, room - segWidth(r) - 2))
  // ╭─ left ─── right ─╮ (or ╭─ left ─────╮ with nothing on the right)
  const fill = Math.max(1, w - 3 - segWidth(l) - 1 - (r.length ? segWidth(r) + 1 + 3 : 2))
  return els.Text({ wrap: 'truncate-end', children: [
    els.Text({ color: tone, children: a }), ...texts(els, l),
    els.Text({ color: tone, children: ' ' + '─'.repeat(fill) + (r.length ? ' ' : '') }), ...texts(els, r),
    els.Text({ color: tone, children: r.length ? (bottom ? ' ─╯' : ' ─╮') : (bottom ? '─╯' : '─╮') }),
  ] })
}

/** One row inside a frame: │ content (padded) │, the content a press when `onPress` is given. */
function frameRow(els: Any, key: string, w: number, tone: string, segs: Seg[], o: { onPress?: () => unknown; label?: string; right?: Seg[] } = {}): Any {
  const inner = w - 4
  const right = o.right ? clip(o.right, Math.floor(inner / 3)) : []
  const left = clip(segs, inner - segWidth(right) - (right.length ? 1 : 0))
  const gap = Math.max(0, inner - segWidth(left) - segWidth(right))
  const body = [...texts(els, left), els.Text({ children: ' '.repeat(gap) }), ...texts(els, right)]
  const content = o.onPress ? els.Button({ key: `${key}-b`, plain: true, label: o.label || '', children: body, onPress: o.onPress }) : els.Box({ flexDirection: 'row', children: body })
  return els.Box({ key, flexDirection: 'row', children: [els.Text({ color: tone, children: '│ ' }), els.Box({ width: inner, flexShrink: 0, children: [content] }), els.Text({ color: tone, children: ' │' })] })
}

// ------------------------------------------------------------------------------------------------ the list

export type ClaimsListOpts = {
  key: string
  w: number
  theme: Theme
  view: Any
  selected: string | null
  open: string | null
  offer: { what: string; minutes: number | null; tokens: number | null } | null
  oriented: { claims: number; clusters: number } | null
  cardOpen: boolean
  onClaim: (id: string) => unknown
  onCluster: (id: string | null) => unknown
  onOffer: () => unknown
  onClose: () => unknown
}

/** The digits of the list: clusters 1–8 in order, then the offer (when there is one), at most 9. */
export function listDigits(view: Any, offer: unknown): { clusters: Map<string, number>; offer: number | null } {
  const clusters = new Map<string, number>()
  let n = 0
  for (const g of view.groups as Any[]) {
    if (n >= (offer ? 8 : 9)) break
    clusters.set(String(g.id), ++n)
  }
  return { clusters, offer: offer && n < 9 ? n + 1 : null }
}

/** The claims a closed cluster shows: the message's new ones, the revised ones and what replaced them, the most said,
 *  then the latest, at most `n`, in the order said. */
function shownClaims(g: Any, n: number): Any[] {
  const score = (c: Any) => (c.fresh ? 1000 : 0) + (c.revised_by || c.revises ? 100 : 0) + c.n * 10 + (c.turn ?? 0)
  const keep = new Set([...g.claims].sort((a: Any, b: Any) => score(b) - score(a)).slice(0, n).map((c: Any) => c.id))
  return g.claims.filter((c: Any) => keep.has(c.id))
}

export function claimsListEl(els: Any, o: ClaimsListOpts): Any {
  const { Box } = els
  const tone = verbColor('c', o.theme)
  const paper = markColors(o.theme).paper
  const v = o.view
  const digits = listDigits(v, o.offer)
  const rows: Any[] = []
  const inner = o.w - 4
  const turns = v.turns ? (v.turns[0] === v.turns[1] ? `turn ${v.turns[0]}` : `turns ${v.turns[0]}–${v.turns[1]}`) : ''
  const title: Seg[] = [{ s: 'claims', p: { color: tone, bold: true } }, { s: ` · ${v.total} in ${v.clusters} cluster${v.clusters === 1 ? '' : 's'}`, p: { dimColor: true } }, ...(v.fresh ? [{ s: ` · ${v.fresh} new`, p: { color: tone } }] : [])]
  const top = border(els, o.w, tone, title, turns ? [{ s: turns, p: { dimColor: true } }] : [], false)
  if (!v.total) rows.push(frameRow(els, `${o.key}-none`, o.w, tone, [{ s: 'No claims yet. They are read after each turn of work, from what Claude and you said.', p: { dimColor: true } }]))
  for (const g of v.groups as Any[]) {
    const d = digits.clusters.get(String(g.id))
    const isOpen = o.open != null && String(o.open) === String(g.id)
    const head: Seg[] = [
      { s: d ? `${d} ` : '  ', p: { color: tone, bold: true } },
      { s: g.name, p: { bold: !!g.id, dimColor: !g.id } },
      { s: `  ${g.claims.length}`, p: { dimColor: true } },
      ...(g.fresh ? [{ s: ` · ${g.fresh} new`, p: { color: tone } }] : []),
      ...(g.from === 'orientation' ? [{ s: ' · from the corpus', p: { dimColor: true } }] : []),
    ]
    rows.push(frameRow(els, `${o.key}-g-${g.id}`, o.w, tone, head, { onPress: () => o.onCluster(g.id ?? null), label: `open ${g.name}` }))
    const list = isOpen ? g.claims : shownClaims(g, g.from === 'orientation' ? 2 : 3)
    for (const c of list) {
      const sel = o.selected === c.id
      const base = sel ? { backgroundColor: tone, color: paper } : {}
      const struck = !!c.revised_by
      const textW = Math.max(12, inner - 14)
      const segs: Seg[] = [
        { s: c.fresh ? ' + ' : '   ', p: { color: tone, bold: true } },
        { s: '● ', p: { color: kindColor(c.kind, o.theme) } },
      ]
      if (struck) {
        const rep = c.replacement
        const half = Math.max(10, Math.floor(textW * 0.48))
        segs.push({ s: cutTo(c.text, half), p: { ...base, strikethrough: true, dimColor: !sel } })
        segs.push({ s: ' → ', p: { color: tone, bold: true } })
        if (rep) segs.push({ s: cutTo(rep.text, Math.max(8, textW - half - 3)), p: base })
      } else {
        segs.push({ s: cutTo(c.text, textW), p: { ...base, ...(c.by === 'person' ? { italic: true } : {}) } })
      }
      const right: Seg[] = [...(c.n > 1 ? [{ s: `×${c.n} `, p: { color: tone } }] : []), { s: c.by === 'orientation' ? 'corpus' : c.turn != null ? `t${c.turn}` : '', p: { dimColor: true } }]
      rows.push(frameRow(els, `${o.key}-c-${c.id}`, o.w, tone, segs, { right, onPress: () => o.onClaim(c.id), label: `claim ${c.text}` }))
    }
    if (list.length < g.claims.length) rows.push(frameRow(els, `${o.key}-more-${g.id}`, o.w, tone, [{ s: `     + ${g.claims.length - list.length} more`, p: { dimColor: true } }], { onPress: () => o.onCluster(g.id ?? null), label: `all of ${g.name}` }))
  }
  for (const gap of (v.gaps || []).slice(-2)) rows.push(frameRow(els, `${o.key}-gap-${gap.turn}`, o.w, tone, [{ s: `turn ${gap.turn} was not read: ${gap.why}`, p: { dimColor: true, italic: true } }]))
  if (o.oriented) rows.push(frameRow(els, `${o.key}-oriented`, o.w, tone, [{ s: `the corpus orientation added ${o.oriented.claims} claims in ${o.oriented.clusters} clusters`, p: { dimColor: true } }]))
  else if (o.offer && digits.offer) {
    const cost = [o.offer.minutes ? `~${o.offer.minutes} min` : '', o.offer.tokens ? `~${Math.round(o.offer.tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ')
    rows.push(frameRow(els, `${o.key}-offer`, o.w, tone, [{ s: `${digits.offer} `, p: { color: tone, bold: true } }, { s: 'orient on the whole corpus' }, { s: ` · ${o.offer.what}${cost ? ' · ' + cost : ''}`, p: { dimColor: true } }], { onPress: o.onOffer, label: 'orient on the corpus' }))
  }
  const n = digits.clusters.size
  const keys = o.cardOpen
    ? '] [ step through claims · 0 back to the list'
    : [n ? `${n > 1 ? `1–${n}` : '1'} open a cluster` : '', v.total ? '] [ step through claims' : '', digits.offer && !o.oriented ? `${digits.offer} orient` : '', '0 close'].filter(Boolean).join(' · ')
  const bottom = border(els, o.w, tone, [{ s: keys, p: { dimColor: true } }], [], true)
  return Box({ key: o.key, flexDirection: 'column', marginLeft: 2, width: o.w, children: [top, ...rows, bottom] })
}

// ------------------------------------------------------------------------------------------------ the card

export type ClaimCardOpts = {
  key: string
  w: number
  body: number
  theme: Theme
  claim: Any
  cluster: string
  keys: string
  onSource: (i: number) => unknown
  onClaim: (id: string) => unknown
  onPlace: (row: string) => unknown
}

const who = (by: string) => (by === 'person' ? 'you' : by === 'orientation' ? 'corpus' : 'Claude')

export function claimCardEl(els: Any, o: ClaimCardOpts): Any {
  const { Box, Button, Text } = els
  const tone = verbColor('c', o.theme)
  const cite = markColors(o.theme).cite
  const c = o.claim
  const inner = o.w - 4
  const meta = [c.kind === 'judgment' ? 'judgment call' : c.kind, c.n > 1 ? `×${c.n}` : '', c.by === 'orientation' ? 'from the corpus' : c.turn != null ? `turn ${c.turn}` : ''].filter(Boolean).join(' · ')
  const title: Seg[] = [{ s: '● ', p: { color: kindColor(c.kind, o.theme) } }, { s: c.text, p: { bold: true, ...(c.revised_by ? { strikethrough: true } : {}) } }]
  const rows: Any[] = []
  rows.push(frameRow(els, `${o.key}-cl`, o.w, tone, [{ s: o.cluster, p: { color: tone } }, ...(c.by === 'person' ? [{ s: ' · said by you', p: { dimColor: true } }] : [])]))
  const places = (c.said || []) as Any[]
  const show = places.slice(0, places.length > 3 ? 2 : 3)
  show.forEach((p, i) => {
    const lead = i === 0 ? 'said   ' : '       '
    const where = p.by === 'orientation' ? 'corpus ' : `turn ${p.turn ?? '?'} `.padEnd(8)
    const segs: Seg[] = [{ s: lead, p: { dimColor: true } }, { s: where, p: { dimColor: true } }, { s: `${who(p.by).padEnd(7)}`, p: { dimColor: true } }, { s: p.quote ? `"${p.quote}"` : p.ref ? String(p.ref) : '' }]
    rows.push(frameRow(els, `${o.key}-p${i}`, o.w, tone, segs, p.row ? { onPress: () => o.onPlace(p.row), label: `where it was said, turn ${p.turn}` } : {}))
  })
  if (places.length > show.length) rows.push(frameRow(els, `${o.key}-pmore`, o.w, tone, [{ s: `       + ${places.length - show.length} more places · ×${places.length} in all`, p: { dimColor: true } }]))
  const sources = ((c.sources || []) as Any[]).slice(0, 8)
  if (sources.length) {
    const kids: Any[] = [Text({ dimColor: true, children: 'from   ' })]
    let used = 7
    sources.forEach((s, i) => {
      const label = cutTo(String(s.label || s.ref), 28)
      const need = 2 + width(label) + 2
      if (used + need > inner) return
      used += need
      kids.push(Text({ dimColor: true, children: `${i + 2} ` }))
      kids.push(Button({ key: `${o.key}-s${i}`, plain: true, label: `cite ${label}`, children: [Text({ color: cite, underline: true, children: label })], onPress: () => o.onSource(i) }))
      kids.push(Text({ children: '  ' }))
    })
    rows.push(Box({ key: `${o.key}-src`, flexDirection: 'row', children: [Text({ color: tone, children: '│ ' }), Box({ width: inner, flexShrink: 0, flexDirection: 'row', children: kids }), Text({ color: tone, children: ' │' })] }))
  } else rows.push(frameRow(els, `${o.key}-src`, o.w, tone, [{ s: 'from   ', p: { dimColor: true } }, { s: 'no citation in or near its sentence', p: { dimColor: true } }]))
  if (c.replacement) rows.push(frameRow(els, `${o.key}-rev`, o.w, tone, [{ s: 'revised → ', p: { color: tone, bold: true } }, { s: c.replacement.text }, { s: c.replacement.turn != null ? `  turn ${c.replacement.turn}` : '', p: { dimColor: true } }], { onPress: () => o.onClaim(c.replacement.id), label: 'the claim that revised it' }))
  if (c.original) rows.push(frameRow(els, `${o.key}-org`, o.w, tone, [{ s: 'revises ← ', p: { color: tone, bold: true } }, { s: c.original.text, p: { strikethrough: true, dimColor: true } }], { onPress: () => o.onClaim(c.original.id), label: 'the claim it revises' }))
  while (rows.length < o.body) rows.push(frameRow(els, `${o.key}-pad${rows.length}`, o.w, tone, []))
  return Box({ key: o.key, flexDirection: 'column', marginLeft: 2, width: o.w, children: [
    border(els, o.w, tone, title, [{ s: meta, p: { color: tone } }], false),
    ...rows.slice(0, Math.max(o.body, rows.length)),
    border(els, o.w, tone, [{ s: o.keys, p: { dimColor: true } }], [], true),
  ] })
}
