// trail.mjs: the side pane's way back (core/pane.ts), as pure functions. No `$`, no Node: the hooks module and the
// tests import it.
//
// The side pane keeps a trail: the panes it showed before the one it shows now, as a browser keeps the pages before
// this one. A pane opened from inside the pane goes on top of the trail; `‹ back`, esc or a crumb goes back down it.
//
//   crumbOf(kind, args)            -> the pane's crumb: its words in the trail (`claims`, `cluster`, `citation 3`) and
//                                     how deep it stands among the panes of its kind (the claims overview 0, a cluster
//                                     1, a claim 2, its evidence 3)
//   nextTrail(was, open, kind, args) -> the trail under a pane about to show: another kind, a deeper pane of the
//                                     same kind, or another side thread, goes on top of the one shown now; the same
//                                     depth takes its place (j and k in a cluster); a shallower one goes back down
//                                     to it (e closes the evidence: the claim again); a pane that was not open starts
//                                     a new trail
//   crumbsLine(trail, now, width)  -> the crumbs as drawn: the earlier ones (each its index in the trail), the one
//                                     shown now, the ones left out at the start for want of room
//   treeRows(el, width)            -> about how many rows a drawing takes at `width` cells: what the pane under its
//                                     input bar has room for, and how far it scrolls

import { textWidth } from './text.js'

/** The most panes the trail keeps; older ones fall off its start. */
export const TRAIL_MAX = 12

const obj = a => (a && typeof a === 'object' ? a : {})

export function crumbOf(kind, args) {
  const a = obj(args)
  switch (kind) {
    case 'claims':
      if (a.source) return { words: 'where it was said', depth: 3 }
      if (a.open) return { words: 'evidence', depth: 3 }
      if (a.claim) return { words: 'claim', depth: 2 }
      if (a.group != null && a.group !== '') return { words: 'cluster', depth: 1 }
      return { words: 'claims', depth: 0 }
    case 'labels':
      if (a.label && a.value && a.value !== '-') return { words: String(a.value), depth: 2 }
      if (a.label) return { words: String(a.label), depth: 1 }
      return { words: 'labels', depth: 0 }
    case 'evidence': return { words: `citation ${a.n ?? ''}`.trim(), depth: 0 }
    case 'thread': return { words: 'thread', depth: 0 }
    case 'threads': return { words: 'threads', depth: 0 }
    case 'coverage': return { words: 'coverage', depth: 0 }
    case 'settings': return { words: 'settings', depth: 0 }
    default: return { words: String(kind), depth: 0 }
  }
}

/** The kinds whose panes at one depth each go on the trail, and what tells them apart. */
const OWN = { thread: a => String(a.key ?? '') }

/** A pane as the trail keeps it. */
export const entryOf = now => ({ kind: now.kind, args: now.args, title: now.title ?? now.kind, ...(now.rows ? { rows: now.rows } : {}) })

export function nextTrail(was, open, kind, args) {
  if (!was || !open) return []
  const trail = Array.isArray(was.trail) ? was.trail : []
  const push = () => [...trail, entryOf(was)].slice(-TRAIL_MAX)
  if (was.kind !== kind) return push()
  const d0 = crumbOf(was.kind, was.args).depth
  const d1 = crumbOf(kind, args).depth
  // the same depth takes its place (the next claim, value or citation), but another side thread goes on top: its
  // conversation is the person's own, kept to go back to (a heads-up's offer asked from the tray while a thread shows)
  if (d1 === d0) return OWN[kind] && OWN[kind](obj(was.args)) !== OWN[kind](obj(args)) ? push() : trail
  if (d1 > d0) return push()
  // shallower: the trail's panes of this kind as deep or deeper go
  let i = trail.length
  while (i > 0 && trail[i - 1].kind === kind && crumbOf(kind, trail[i - 1].args).depth >= d1) i--
  return trail.slice(0, i)
}

/** The crumbs that fit in `width` cells after `‹ back · `: the trail's last ones and the one shown now, each with ` › `
 *  between; `cut` when earlier ones were left out (drawn `… › ` at the start). */
export function crumbsLine(trail, now, width) {
  const all = [...trail.map((t, i) => ({ words: crumbOf(t.kind, t.args).words, at: i })), { words: crumbOf(now.kind, now.args).words, at: -1 }]
  const len = xs => xs.reduce((n, x, i) => n + textWidth(x.words) + (i ? 3 : 0), 0)
  let from = 0
  while (from < all.length - 1 && len(all.slice(from)) + (from ? 4 : 0) > width) from++
  return { cut: from > 0, crumbs: all.slice(from) }
}

/** The text of an element, as it reads: its strings and its children's, in order. */
function textIn(n) {
  if (n == null || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textIn).join('')
  const p = n.props ?? {}
  if (n.type === 'Button') return kids(n).length ? textIn(kids(n)) : String(p.label ?? '')
  if (n.type === 'Markdown') return String(p.text ?? '')
  if (n.type === 'Code') return String(p.source ?? '')
  if (n.type === 'Input') return String(p.value || p.placeholder || '')
  return textIn(kids(n))
}

/** An element's children: Claude Code's elements hold them beside their props, plain ones (fix/screen.ts, the tests)
 *  in their props. */
function kids(n) {
  const c = n.children ?? n.props?.children
  return Array.isArray(c) ? c : c == null ? [] : [c]
}

/** Rows a text takes at `w` cells: each of its lines wraps at spaces (a word wider than a row is cut across rows), or
 *  keeps to one row when it is cut. */
function textRows(s, w, wraps) {
  const lines = String(s).split('\n')
  if (!wraps) return lines.length
  const W = Math.max(1, w)
  let rows = 0
  for (const line of lines) {
    let n = 1
    let used = 0
    for (const word of line.split(/(?<= )/)) {
      const ww = textWidth(word)
      const bare = textWidth(word.trimEnd())
      if (used && used + bare > W) { n += 1; used = 0 }
      if (ww > W) { n += Math.ceil(ww / W) - 1; used = ww % W; continue }
      used += ww
    }
    rows += n
  }
  return rows
}

export function treeRows(el, width) {
  const w = Math.max(1, Math.floor(width))
  if (el == null || el === false || el === true) return 0
  if (typeof el === 'string' || typeof el === 'number') return textRows(el, w, true)
  if (Array.isArray(el)) return el.reduce((n, x) => n + treeRows(x, w), 0)
  const p = el.props ?? {}
  if (p.display === 'none') return 0
  if (typeof p.height === 'number') return p.height
  const pad = n => (typeof n === 'number' ? n : 0)
  const my = pad(p.marginTop ?? p.marginY ?? p.margin) + pad(p.marginBottom ?? p.marginY ?? p.margin) + pad(p.paddingTop ?? p.paddingY ?? p.padding) + pad(p.paddingBottom ?? p.paddingY ?? p.padding) + (p.borderStyle ? 2 : 0)
  const inner = typeof p.width === 'number' ? Math.min(w, p.width) : w
  const iw = Math.max(1, inner - (p.borderStyle ? 2 : 0) - pad(p.paddingLeft ?? p.paddingX ?? p.padding) - pad(p.paddingRight ?? p.paddingX ?? p.padding))
  switch (el.type) {
    case 'Box': {
      const cs = kids(el)
      if (p.flexDirection === 'column' || p.flexDirection === 'column-reverse') return my + cs.reduce((n, c) => n + treeRows(c, iw), 0)
      // a row: its children side by side, or wrapped as one text when the row wraps
      if (p.flexWrap === 'wrap') return my + textRows(textIn(cs), iw, true)
      // the children with a width of their own take it; the others share what is left
      const fixed = cs.reduce((n, c) => n + (typeof c?.props?.width === 'number' ? c.props.width : 0), 0)
      const rest = Math.max(1, iw - fixed)
      return my + cs.reduce((n, c) => Math.max(n, treeRows(c, typeof c?.props?.width === 'number' ? c.props.width : rest)), cs.length ? 1 : 0)
    }
    case 'Text': {
      const wraps = !String(p.wrap ?? 'wrap').startsWith('truncate')
      return my + textRows(textIn(kids(el)), iw, wraps)
    }
    case 'Button': return my + Math.max(1, textRows(textIn(el), iw, true))
    case 'Input': return my + Math.max(1, Number(p.rows) || 1)
    case 'Code': return my + textRows(String(p.source ?? ''), iw, false)
    case 'Markdown': return my + textRows(String(p.text ?? ''), iw, true)
    case 'Client': return my + Math.max(1, Number(p.rows) || 10)
    default: return my + Math.max(1, Number(p.rows) || textRows(textIn(kids(el)), iw, true))
  }
}
