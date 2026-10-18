// claimsview.ts: the Claims pane as Claude Code elements: a graph of the session's claims in terminal cells. No `$`:
// the shell resolves the elements and hands in the store's view (verbs/claims/claims.js viewOf), the layout
// (claimgraph.js) and what a press does.
//
//   claimsPaneEl(els, o)   at rest, one island of dots per cluster with its name dim at its centre, and no lines; the
//                          claim the pointer or the ring is on shows a card of what it means beside it (the claim as
//                          said, Precisely, Based on, Judgment, Not stated), keeps its links bright and draws them as
//                          thin lines, and fades the rest. A replay (r) grows the graph again in the order the claims
//                          were made. The keys are in the hint line under the prompt (claimsHint), never in the pane.
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

/** A replay: how many claims of the order made are grown so far. */
export type Replay = { gen: number; k: number; order: string[] }

export type ClaimsPaneOpts = {
  w: number
  h: number
  theme: Theme
  view: Any
  lay: Any
  focus: string | null
  replay: Replay | null
  onHover: (id: string) => unknown
}

/** The head's rows (its line and a blank row). */
export const HEAD_ROWS = 2

/** The claims a replay shows (null: all of them), and the ones it just added. */
export function replayShows(r: Replay | null, step = 1): { visible: Set<string> | null; newest: Set<string> } {
  if (!r) return { visible: null, newest: new Set() }
  return { visible: new Set(r.order.slice(0, r.k)), newest: new Set(r.order.slice(Math.max(0, r.k - step), r.k)) }
}

/** The hint line under the prompt while the pane has the keys. (Its argument is not read: every state has these keys.) */
export function claimsHint(_o?: unknown): string {
  return 'r replay · esc close'
}

export function claimsPaneEl(els: Any, o: ClaimsPaneOpts): Any {
  const { Box, Button, Text } = els
  const tone = verbColor('c', o.theme)
  const amber = amberOf(o.theme)
  const cite = markColors(o.theme).cite
  const v = o.view
  const w = Math.max(30, o.w)
  const groups = (v.groups as Any[]).filter(g => g.id != null)
  const colorOfCluster = new Map<string, string>(groups.map((g, i) => [String(g.id), clusterColor(i, o.theme)]))
  const colorOf = (c: Any) => colorOfCluster.get(String(c.cluster)) || (o.theme === 'light' ? '#85837c' : '#9c978d')
  const { visible, newest } = replayShows(o.replay)
  const where = o.replay ? `replay · ${o.replay.k} of ${o.replay.order.length}` : `${v.total} · ${v.clusters} cluster${v.clusters === 1 ? '' : 's'}`
  const head = Box({ key: 'head', flexDirection: 'row', width: w, children: [Text({ color: tone, bold: true, children: 'Claims   ' }), Text({ dimColor: true, children: where })] })
  if (!v.total) {
    return Box({ flexDirection: 'column', width: w, children: [head, Text({ children: ' ' }), Text({ dimColor: true, children: 'No claims yet.' })] })
  }
  // a layout that is missing (a drawing older than its module, after a reload) says so; it never throws
  if (!o.lay || !o.lay.pos) return Box({ flexDirection: 'column', width: w, children: [head, Text({ children: ' ' }), Text({ color: 'error', children: 'The graph could not be laid out. Press esc, then c to open it again.' })] })
  // the graph, a cell per character; a claim's cell a press, so the ring (or a click) lands on it and its card shows
  const rows = compose({ claims: v.flat, clusters: groups, lay: o.lay, visible, newest, focus: o.replay ? null : o.focus, colorOf, amber, cite })
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
    return p
  }
  const graph = rows.map((runs: Any[], y: number) => Box({ key: `g${y}`, flexDirection: 'row', width: w, height: 1, children: runs.map((r, i) => (r.node
    ? Button({ key: claimKey(r.node), plain: true, label: `claim: ${(v.flat as Any[]).find(c => c.id === r.node)?.text ?? ''}`, children: [Text({ ...style(r.style), children: r.s })], onPress: () => o.onHover(r.node) })
    : Text({ key: `t${y}-${i}`, ...style(r.style), children: r.s }))) }))
  return Box({ flexDirection: 'column', width: w, children: [head, Text({ key: 'sp', children: ' ' }), ...graph] })
}
