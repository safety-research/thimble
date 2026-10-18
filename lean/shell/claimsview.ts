// claimsview.ts: the Claims pane as Claude Code elements: a graph of the session's claims in terminal cells. No `$`:
// the shell resolves the elements and hands in the store's view (verbs/claims/claims.js viewOf, timeline), the
// layout (claimgraph.js) and what a press does.
//
//   claimsPaneEl(els, o)   at rest, one island of dots per cluster with its name dim at its centre, and no lines; the
//                          ring on a claim shows its whole text beside it, keeps its links bright and draws them as thin
//                          lines, and fades the rest; ↵ fills the bar under the graph (the claim, said in turn N, ×N,
//                          its sources as cite marks, what it revised or what revised it). The keys are in the hint line
//                          under the prompt (claimsHint), never in the pane.
import { compose } from './claimgraph.js'
import { markColors, verbColor } from './view'
import type { Theme } from './view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The clusters' colors, per theme, in the order the clusters began. */
export function clusterColor(i: number, theme: Theme): string {
  const light = ['#2f6fb5', '#c27a1c', '#2f8a5b', '#b9466e', '#7652a8', '#2a8a85', '#8a6a3a', '#4f55a8']
  const dark = ['#6aa8ea', '#e6a64e', '#6cc493', '#e57fa5', '#b394e6', '#5fc9c1', '#cfae7e', '#9da3f0']
  return (theme === 'light' ? light : dark)[i % light.length]!
}
export const amberOf = (theme: Theme) => (theme === 'light' ? '#b7791f' : '#e0a43a')

/** The key of a claim's dot, which the focus ring lands on. */
export const claimKey = (id: string) => `cl-${id}`
export const claimOfKey = (key: string) => (/^cl-(.+)$/.exec(String(key || '')) || [])[1] ?? null

export type ClaimsPaneOpts = {
  w: number
  h: number
  theme: Theme
  view: Any
  lay: Any
  moments: Any[]
  cursor: number | null
  focus: string | null
  selected: string | null
  search: string | null
  searching: boolean
  onSelect: (id: string) => unknown
  onSource: (i: number) => unknown
  onSearch: (value: string) => unknown
  onSearchDone: (value: string) => unknown
}

/** The rows the bar under the graph takes (a rule and three lines), kept whether or not a claim is selected, so the
 *  graph does not move; and the head's. */
export const BAR_ROWS = 4
export const HEAD_ROWS = 2

/** The claims the time cursor shows (null: all of them). */
export function shownAt(moments: Any[], cursor: number | null): Set<string> | null {
  if (cursor == null) return null
  const out = new Set<string>()
  moments.forEach((m: Any, i: number) => { if (i <= cursor) for (const id of m.claims) out.add(id) })
  return out
}
/** The claims a search lights: its words in the claim or in a place it was said (null: no search). */
export function matchesOf(flat: Any[], q: string | null): Set<string> | null {
  const s = String(q || '').trim().toLowerCase()
  if (!s) return null
  return new Set(flat.filter(c => c.text.toLowerCase().includes(s) || (c.said || []).some((p: Any) => String(p.quote || '').toLowerCase().includes(s))).map(c => c.id))
}

const cutTo = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')

/** The hint line under the prompt while the pane has the keys: only the keys of what has focus. */
export function claimsHint(o: { search: string | null; searching: boolean; time: boolean; selected: Any | null; offer: Any | null }): string {
  if (o.searching) return 'type to search · ↵ done · esc clear'
  if (o.time) return '] [ turn · t now · esc close'
  const n = o.selected ? Math.min(7, (o.selected.sources || []).length) : 0
  const offer = o.offer ? ` · m map the corpus ~${o.offer.minutes} min ~${Math.round((o.offer.tokens || 0) / 1000)}k tokens` : ''
  return `↑ ↓ move · ↵ select${n ? ` · ${n > 1 ? `1–${n}` : '1'} source` : ''} · n cluster · / search${o.search ? ' · esc clear' : ''} · t time · esc close${offer}`
}

export function claimsPaneEl(els: Any, o: ClaimsPaneOpts): Any {
  const { Box, Button, Text, Input } = els
  const tone = verbColor('c', o.theme)
  const amber = amberOf(o.theme)
  const cite = markColors(o.theme).cite
  const v = o.view
  const w = Math.max(30, o.w)
  const groups = (v.groups as Any[]).filter(g => g.id != null)
  const colorOfCluster = new Map<string, string>(groups.map((g, i) => [String(g.id), clusterColor(i, o.theme)]))
  const colorOf = (c: Any) => colorOfCluster.get(String(c.cluster)) || (o.theme === 'light' ? '#85837c' : '#9c978d')
  const visible = shownAt(o.moments, o.cursor)
  const matches = matchesOf(v.flat, o.search)
  // the head: how many, or the search, or the time
  // the head: how many, or where time is, and the search (a field while it is typed, then its words)
  const n = matches ? [...matches].filter(id => !visible || visible.has(id)).length : 0
  const m = visible ? o.moments[o.cursor ?? 0] : null
  const where = visible ? `${m ? (m.by === 'orientation' ? 'the corpus' : `turn ${m.turn ?? '?'} · ${m.what}`) : ''} · ${visible.size} of ${v.total}` : `${v.total} · ${v.clusters} cluster${v.clusters === 1 ? '' : 's'}`
  const head = Box({ key: 'head', flexDirection: 'row', width: w, children: [
    Text({ color: tone, bold: true, children: 'Claims   ' }),
    ...(o.searching
      ? [Text({ children: '/ ' }), Input({ key: 'search', value: o.search ?? '', autoFocus: true, submitLabel: 'done', onInput: (x: string) => o.onSearch(x), onSubmit: (x: string) => o.onSearchDone(x) }), Text({ dimColor: true, children: `   ${n} match${n === 1 ? '' : 'es'}` })]
      : o.search
        ? [Text({ children: `/ ${o.search}` }), Text({ dimColor: true, children: `   ${n} match${n === 1 ? '' : 'es'}${visible ? '   ' + where : ''}` })]
        : [Text({ dimColor: true, children: where })]),
  ] })
  if (!v.total) {
    return Box({ flexDirection: 'column', width: w, children: [head, Text({ children: ' ' }), Text({ dimColor: true, children: 'No claims yet.' })] })
  }
  // the graph, a cell per character; a claim's cell a press, so the ring lands on it and ↵ selects it
  const rows = compose({ claims: v.flat, clusters: groups, lay: o.lay, visible, focus: o.focus, selected: o.selected, matches, query: o.search, colorOf, amber })
  // a faded claim keeps a pale tint of its color (the dim attribute would turn it gray)
  const paper = o.theme === 'light' ? [255, 255, 255] : [30, 30, 30]
  const fade = (hex: string) => {
    const v = parseInt(hex.slice(1), 16)
    const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x, i) => Math.round(x * 0.32 + paper[i]! * 0.68))
    return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('')
  }
  const style = (st: Any) => {
    if (!st) return {}
    const p: Any = {}
    if (st.color) p.color = st.faint && /^#[0-9a-f]{6}$/i.test(st.color) ? fade(st.color) : st.color
    if (st.dim || (st.faint && !st.color)) p.dimColor = true
    if (st.bold) p.bold = true
    if (st.strike) p.strikethrough = true
    if (st.sel) p.backgroundColor = o.theme === 'light' ? '#e4ddfb' : '#322b52'
    if (st.mark) { p.backgroundColor = o.theme === 'light' ? '#f6e3a8' : '#5a4a1f'; p.color = o.theme === 'light' ? '#1f1e1c' : '#ffffff' }
    return p
  }
  const graph = rows.map((runs: Any[], y: number) => Box({ key: `g${y}`, flexDirection: 'row', width: w, height: 1, children: runs.map((r, i) => (r.node
    ? Button({ key: claimKey(r.node), plain: true, label: `claim: ${(v.flat as Any[]).find(c => c.id === r.node)?.text ?? ''}`, children: [Text({ ...style(r.style), children: r.s })], onPress: () => o.onSelect(r.node) })
    : Text({ key: `t${y}-${i}`, ...style(r.style), children: r.s }))) }))
  // the bar: the selected claim, said in turn N, ×N, its sources as cite marks, what it revised or what revised it
  const bar: Any[] = []
  const c = o.selected ? (v.flat as Any[]).find(x => x.id === o.selected) : null
  if (c) {
    const first = c.said[0] || {}
    const said = first.by === 'orientation' ? 'from the corpus orientation' : `said in turn ${first.turn ?? '?'}${first.by === 'person' ? ' by you' : ''}`
    const revised = !!c.revised_by && (!visible || visible.has(c.revised_by))
    bar.push(Text({ key: 'b-rule', dimColor: true, children: '─'.repeat(w) }))
    bar.push(Box({ key: 'b1', flexDirection: 'row', width: w, children: [
      Text({ color: colorOf(c), children: '● ' }),
      Text({ bold: true, ...(revised ? { strikethrough: true } : {}), children: cutTo(c.text, w - 12) }),
      ...(revised ? [Text({ dimColor: true, children: '  revised' })] : []),
    ] }))
    const kids: Any[] = [Text({ dimColor: true, children: `  ${said}` })]
    if (c.n >= 2) kids.push(Text({ dimColor: true, children: ' · ' }), Text({ color: tone, bold: true, children: `×${c.n}` }))
    ;(c.sources || []).slice(0, 7).forEach((s: Any, i: number) => {
      kids.push(Text({ dimColor: true, children: ' · ' }))
      kids.push(Button({ key: `src-${i}`, plain: true, label: `cite ${s.label || s.ref}`, children: [Text({ color: cite, underline: true, children: cutTo(String(s.label || s.ref), 28) })], onPress: () => o.onSource(i) }))
    })
    bar.push(Box({ key: 'b2', flexDirection: 'row', width: w, children: kids }))
    const rep = revised ? c.replacement : null
    const org = c.original && (!visible || visible.has(c.original.id)) ? c.original : null
    if (rep) bar.push(Box({ key: 'b3', flexDirection: 'row', width: w, children: [Text({ dimColor: true, children: `  revised in turn ${rep.turn ?? '?'} to ` }), Text({ children: cutTo(rep.text, w - 26) })] }))
    else if (org) bar.push(Box({ key: 'b3', flexDirection: 'row', width: w, children: [Text({ dimColor: true, children: '  revised from ' }), Text({ dimColor: true, strikethrough: true, children: cutTo(org.text, w - 36) }), Text({ dimColor: true, children: ` · said in turn ${org.turn ?? '?'}` })] }))
    else if (first.quote) bar.push(Text({ key: 'b3', dimColor: true, children: cutTo(`  "${first.quote}"`, w) }))
  }
  while (bar.length < BAR_ROWS) bar.push(Text({ key: `b-pad${bar.length}`, children: ' ' }))
  return Box({ flexDirection: 'column', width: w, children: [head, Text({ key: 'sp', children: ' ' }), ...graph, ...bar] })
}
