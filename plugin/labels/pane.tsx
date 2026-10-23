// pane.tsx: the labels pane (core/pane.ts kind `labels`), drawn with Claude Code's own elements from what ledger.mjs
// lays out. At rest each label is a short table of its values: a bar, the count and the share of the records (labels
// whose tables do not fit fold to one line each). Opening a value folds the other labels to one line each and lists its
// examples under them, one line each, the words the label matched bold in the value's color; the picked example opens
// in place with where it is (`path:line`, relative to the session's folder, or with … in its middle outside it) and the
// check keys. d shows the label's definition whole in place of the examples. The keys stay at the pane's bottom in
// every state. A click moves too: a label's name or a value opens it (the open one again: back to all the labels), an
// example picks it (again: closes it), `↑ N earlier` and `↓ N more` page the examples. The person's check of the
// picked example (a number key, or a press on a value) counts in place of the label's value (labels.ts checkRecord);
// the next example is picked after it.
//
//   openLabels($, args)   opens the pane and gives it the keyboard (the bar's l, a click on its label count): all
//                         the labels, or one label
//   showLabels($, args)   what the pane shows next, as the person moves in it
//   colorOf(values, v)    a value's color in the theme drawn now (labels/use.ts colors the label rows with it)
//
//   args: {label: the label open, value: the value whose examples show ('-': no value yet), at: the first example of
//          the page, sel: the ref of the example picked, def: the definition in place of the examples}
//   keys while the pane holds the keyboard: p n the previous or next value, in reading order over all the labels
//          (nothing open: n the first, p the last) · k j the previous or next example (none picked: the last or the
//          first shown), past the page's edge onto the next page · d the definition, or the examples again · b back to
//          all the labels · 1-9 check the picked example as that value · 0 takes a check back
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { quiet } from '../core/askcell.js'
import { rootHere, startDir } from '../core/env'
import { openPane } from '../core/pane'
import { textWidth } from '../core/text.js'
import { accent, themeLast, themeNow } from '../core/theme'
import { rowsUnder } from '../threads/seam'
import { checkRecord, labelsData } from './labels'
import { chosenOf, definition, examples, isNegative, ledgerTop, NONE, partOf, partsOf, valueOrder } from './ledger.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; tone?: string; bold?: boolean; italic?: boolean; part?: string; hotkey?: string }
type Row = Run[] | { code: string }

export type LabelsArgs = { label?: string; value?: string; at?: number; sel?: string | null; def?: boolean }

/** The values' colors, the first value's first: for a dark background, and darker ones that read on a light one. */
const DARK = ['#5aa2e6', '#cfae7e', '#3cc2b9', '#e384b2', '#b2c24f', '#8fa1bd', '#e0906a', '#7cc48a', '#d6bf5a', '#a0a0a0']
const LIGHT = ['#2f6fbf', '#a0721f', '#0f7f78', '#b03a74', '#677510', '#55698c', '#9c4f2a', '#3d7f4f', '#806a00', '#6a6a6a']
/** The no of a yes/no label: its words gray, its bar a track. */
const NEG = '#8a8a8a'
const TRACK = { dark: '#4a4a4a', light: '#d4d4d4' }

const palette = () => (themeLast() === 'light' ? LIGHT : DARK)

/** A value's color: the theme's inactive gray for the records with no value yet, gray for a negative, else its own. */
export function colorOf(values: string[], v: string): string {
  if (v === NONE) return 'inactive'
  if (isNegative(values, v)) return NEG
  const set = palette()
  return set[Math.max(0, values.indexOf(v)) % set.length]!
}

/** A run's look: its tone as a color, bold, italic. */
function lookOf(r: Run): Record<string, unknown> {
  const t = r.tone
  const out: Record<string, unknown> = {}
  if (t === 'dim') out.dimColor = true
  else if (t === 'accent') out.color = accent() // the lit marks (the ▸), as thimble's other panes draw them
  else if (t === 'err') out.color = 'error'
  else if (t === 'none') out.color = 'inactive'
  else if (t === 'neg') out.color = NEG
  else if (t === 'track') out.color = TRACK[themeLast()]
  else if (t && /^v\d+$/.test(t)) out.color = palette()[Number(t.slice(1)) % palette().length]
  if (r.bold) out.bold = true
  if (r.italic) out.italic = true
  return out
}

/** A path as the pane shows it: relative to the session's folder (`start`) when inside it, else with … in its middle,
 *  its first folder and its last two parts (`/mnt/…/thimble/prs.jsonl`), never a whole temp path. A relative path is
 *  the label root's. */
export function shownPath(p: string, root: string, start: string): string {
  const s = String(p || '')
  if (!s) return s
  const abs = s.startsWith('/') ? s : `${root.replace(/\/+$/, '')}/${s}`
  const base = start.replace(/\/+$/, '')
  if (base && abs.startsWith(`${base}/`)) return abs.slice(base.length + 1)
  const parts = abs.split('/').filter(Boolean)
  return parts.length > 4 ? `/${parts[0]}/…/${parts.slice(-2).join('/')}` : abs
}

/** Where a record is, as a terminal opens it: `path:line` for a line, else its ref; `show` gives the path as shown. */
export function placeOf(ref: string, show: (path: string) => string = p => p): string {
  const m = /^(.*)#L(\d+)(?:-\d+)?$/.exec(ref)
  if (m) return `${show(m[1]!)}:${m[2]}`
  const [path, ...rest] = ref.split('#')
  return [show(path!), ...rest].join('#')
}

const titleOf = (args: LabelsArgs) => (args.label ? `Label ${args.label}` : 'Labels')

export async function openLabels($: Engine, args: LabelsArgs = {}): Promise<boolean> {
  return openPane($, 'labels', args, titleOf(args), { focus: true, rows: 28 })
}

export async function showLabels($: Engine, args: LabelsArgs): Promise<void> {
  // only what names the view, no empty fields
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v != null && v !== false)) as LabelsArgs
  await openPane($, 'labels', clean, titleOf(clean))
}

// ------------------------------------------------------------------------------------------------ drawing

/** One row of runs: plain Text, with one Button for each stretch of runs that share a part; a run with a hotkey is a
 *  Button of its own, which Claude Code draws with its key (`1: yes`). */
function rowEl(els: Any, row: Run[], key: string, press: (part: string) => unknown): unknown {
  const { Box, Button, Text } = els
  const span = (r: Run, i: number) => Text({ key: `t${i}`, ...lookOf(r), children: r.s })
  if (!row.length) return Text({ key, children: ' ' })
  if (!row.some(r => r.part)) return Text({ key, wrap: 'truncate-end', children: row.map(span) })
  const kids: unknown[] = []
  for (let i = 0; i < row.length;) {
    const part = row[i]!.part
    if (!part) { kids.push(span(row[i]!, i)); i++; continue }
    let j = i + 1
    if (!row[i]!.hotkey) while (j < row.length && row[j]!.part === part && !row[j]!.hotkey) j++
    const runs = row.slice(i, j)
    const hotkey = runs[0]!.hotkey
    kids.push(Button({
      key: `${key}:${part}`, plain: true, ...(hotkey ? { hotkey, label: runs.map(r => r.s).join('') } : {}),
      onPress: () => press(part), children: runs.map((r, k) => span(r, i + k)),
    }))
    i = j
  }
  return Box({ key, flexDirection: 'row', children: kids })
}

/** The rows a definition's code takes when Claude Code wraps it in `w` cells. */
const codeRows = (code: string, w: number) => code.split('\n').reduce((s, l) => s + Math.max(1, Math.ceil(textWidth(l) / Math.max(10, w))), 0)

export async function drawLabels($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as LabelsArgs
  const start = await startDir($)
  const root = (await rootHere($)) ?? start
  const show = (p: string) => shownPath(p, root, start)
  const W = Math.max(40, Number(e?.props?.bodyColumns) || 80)
  const H = Math.max(12, Number(e?.props?.scroll?.bodyRows) || 28)
  await themeNow($)
  const list = await labelsData($, { root })
  const { Box, Button, Code, Text } = els
  if (!Array.isArray(list)) return Text({ color: 'error', wrap: 'wrap', children: `× The labels could not be read: ${String(list?.error || 'no answer')}` })
  if (!list.length) return Box({ flexDirection: 'column', children: [Text({ key: 'head', bold: true, children: 'Labels' }), Text({ key: 'gap', children: ' ' }), Text({ key: 'none', dimColor: true, wrap: 'wrap', children: 'No labels yet.' })] })

  // the rows this drawing has: the pane's, less the side thread's under it (threads/pane.tsx)
  const room = Math.max(12, H - (await rowsUnder($, e, 'labels', a).catch(() => 5)))
  const topOf = (c: Any) => ledgerTop(list, c, { w: W, rows: room - 4 })
  /** The examples a value's page holds: the rows under the labels with that value open, less the examples' head. */
  const perOf = (c: Any) => Math.max(3, room - 4 - topOf(c).rows.length - 1)
  const chosen = chosenOf(list, a) as { lab: Any; value: string } | null
  const top = topOf(chosen)
  const label = chosen ? String(chosen.lab.name) : null
  const value = chosen?.value ?? null
  const go = (b: LabelsArgs) => showLabels($, b)
  const here = (b: LabelsArgs = {}) => go({ label: label!, value: value!, ...b })

  // ---- under the labels: the definition, or the value's examples
  let section: Row[] = []
  let ex: Any = null
  let page: Any = null
  const per = chosen ? perOf(chosen) : 0
  if (chosen) {
    if (a.def) section = definition(chosen.lab, W, show) as Row[]
    else {
      const count = partsOf(chosen.lab).find((p: Any) => p.v === value)?.n ?? 0
      const at = Math.max(0, Math.min(Number(a.at) || 0, Math.max(0, count - 1)))
      page = count ? await labelsData($, { root, label: label!, value: value!, at, n: per }) : { at: 0, total: 0, records: [] }
      if (!Array.isArray(page?.records)) section = [[{ s: `× The examples could not be read: ${String(page?.error || 'no answer')}`, tone: 'err' }]]
      else {
        ex = examples(chosen.lab, value, page, { w: W, rows: per + 1, sel: a.sel ?? null, place: (r: Any) => placeOf(String(r.ref), show) })
        section = ex.rows as Row[]
      }
    }
  }
  const recs: Any[] = Array.isArray(page?.records) ? page.records : []
  const total = Number(page?.total) || 0
  const pageAt = Number(page?.at) || 0

  /** The ref of a value's example at `i`, as the kernel orders them (the unchecked first). */
  const refAt = async (lab: string, v: string, i: number): Promise<string | null> => {
    const pg = await labelsData($, { root, label: lab, value: v, at: Math.max(0, i), n: 1 })
    return Array.isArray(pg?.records) && pg.records[0] ? String(pg.records[0].ref) : null
  }
  const countOf = (lab: string, v: string) => partsOf(list.find((l: Any) => l.name === lab)).find((p: Any) => p.v === v)?.n ?? 0

  /** The person's check of the picked example; then the next is picked, or (a check taken back) the same again. */
  const check = async (v: string | null) => {
    const r = ex && ex.p >= 0 ? recs[ex.p] : null
    if (!r) return
    const bad = await checkRecord($, root, label!, String(r.ref), v)
    if (bad) failNotice($, bad)
    await here({ at: pageAt, sel: v === null ? String(r.ref) : (recs[ex.p + 1]?.ref ?? null) })
  }

  // ---- the keys: p n over the values, k j over the examples, d the definition
  const order = valueOrder(list) as [string, string][]
  const at = chosen ? order.findIndex(([l, v]) => l === label && v === value) : -1
  const hop = (d: number) => {
    if (!order.length) return undefined
    const [l, v] = order[at < 0 ? (d > 0 ? 0 : order.length - 1) : (at + d + order.length) % order.length]!
    return go({ label: l, value: v })
  }
  const step = async (d: number) => {
    // no examples shown: the first example of the value open (nothing open: the first value's), or the last one's last
    if (!chosen || (!ex && !a.def)) {
      const [l, v] = chosen ? [label!, value!] : ((d > 0 ? order[0] : order[order.length - 1]) ?? [])
      if (!l || v == null) return undefined
      const n = countOf(l, v)
      const i = d > 0 ? 0 : n - 1
      return go({ label: l, value: v, at: d > 0 ? 0 : Math.max(0, i - perOf(chosenOf(list, { label: l, value: v })) + 1), sel: n ? await refAt(l, v, i) : null })
    }
    if (a.def) return here({ at: a.at, sel: a.sel ?? (await refAt(label!, value!, d > 0 ? 0 : countOf(label!, value!) - 1)) })
    if (!recs.length || !total) return undefined
    const p = ex.p as number
    if (p < 0) return here({ at: pageAt, sel: d > 0 ? ex.shown[0] : ex.shown[ex.shown.length - 1] })
    const j = p + d
    if (j >= 0 && j < recs.length) return here({ at: pageAt, sel: String(recs[j].ref) })
    // past the page's edge: onto the page after or before it, or round to the other end
    const i = (pageAt + j + total) % total
    return here({ at: d > 0 ? i : Math.max(0, i - per + 1), sel: await refAt(label!, value!, i) })
  }
  const keys: { k: string; label: string; onPress: () => unknown; gap: number }[] = []
  const key = (k: string, words: string, onPress: () => unknown, gap = 3) => keys.push({ k, label: words, onPress, gap })
  if (order.length) {
    // in pairs, as one key row in every state: p n value · k j example · d definition
    key('p', 'previous', () => hop(-1))
    key('n', 'next value', () => hop(1), 2)
    key('k', 'previous', () => step(-1))
    key('j', 'next example', () => step(1), 2)
    key('d', a.def && chosen ? 'examples' : 'definition', () => (chosen
      ? here({ at: a.at, sel: a.sel ?? null, def: !a.def })
      : go({ label: order[0]![0], value: order[0]![1], def: true })))
  }

  // ---- a press on a part of a row
  const press = (part: string) => {
    const [kind, x, y] = partOf(part) as [string, Any, Any]
    if (kind === 'l') return chosen && label === x && list.length > 1 ? go({}) : go({ label: String(x) })
    if (kind === 'v') return chosen && label === x && value === y && list.length > 1 ? go({}) : go({ label: String(x), value: String(y) })
    if (kind === 'r') return here({ at: pageAt, sel: a.sel === x ? null : String(x) })
    if (kind === 'c') return check(x == null ? null : String(x))
    if (part === 'pg-up' && ex) return here({ at: Math.max(0, ex.from - per) })
    if (part === 'pg-down' && ex) return here({ at: ex.last + 1 })
    return undefined
  }

  // ---- the pane: the head (b at its right once a label is open), the labels, the section, the keys at the bottom
  const back = chosen && list.length > 1
  const headRow = Box({ key: 'head', flexDirection: 'row', children: [
    rowEl(els, top.head as Run[], 'head-words', press),
    ...(back ? [
      Box({ key: 'head-gap', flexGrow: 1, children: [Text({ children: ' ' })] }),
      Button({ key: 'key-b', plain: true, hotkey: 'b', label: 'all labels', hover: quiet('labels-key-b'), onPress: () => go({}), children: [Text({ key: 'w', dimColor: true, children: 'all labels' })] }),
    ] : []),
  ] })
  const body = [...(top.rows as Row[]), ...section]
  const keysWidth = keys.reduce((s, x, i) => s + (i ? x.gap : 0) + textWidth(x.k) + 2 + textWidth(x.label), 0)
  const used = 2 + body.reduce((s: number, r) => s + (Array.isArray(r) ? 1 : codeRows(r.code, W - 2)), 0) + (keys.length ? 1 + Math.ceil(keysWidth / W) : 0)
  const drawn = body.map((r, i) => (Array.isArray(r)
    ? rowEl(els, r, `r${i}`, press)
    : Box({ key: `r${i}`, paddingLeft: 2, children: [Code({ key: 'code', source: r.code, language: 'python' })] })))
  const keysRow = Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: keys.flatMap((x, i) => [
    ...(i ? [Text({ key: `key-gap-${i}`, children: ' '.repeat(x.gap) })] : []),
    // under the pointer a key's words brighten and underline, never Claude Code's inverse (askcell.js quiet)
    Button({ key: `key-${x.k}`, plain: true, hotkey: x.k, label: x.label, hover: quiet(`labels-key-${x.k}`), onPress: x.onPress, children: [Text({ key: 'w', dimColor: true, children: x.label })] }),
  ]) })
  return Box({ flexDirection: 'column', children: [
    headRow,
    Text({ key: 'gap', children: ' ' }),
    ...drawn,
    ...Array.from({ length: Math.max(0, room - used) }, (_, i) => Text({ key: `fill${i}`, children: ' ' })),
    ...(keys.length ? [Text({ key: 'rule', dimColor: true, children: '─'.repeat(W) }), keysRow] : []),
  ] })
}
