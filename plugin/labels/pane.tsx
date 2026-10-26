// pane.tsx: the labels pane (core/pane.ts kind `labels`), drawn with Claude Code's own elements from what ledger.mjs
// lays out. At rest each label is a short table of its values: a bar, the count and the share of the records (labels
// whose tables do not fit fold to one line each). A label open stands alone under `Labels › name` and its plain
// sentence: its values with their bars and the open value's examples, one line each, the words the label matched bold
// in the value's color; the picked example opens in place with where it is (`path:line`, relative to the session's
// folder, or with … in its middle outside it) and the check keys. d turns the detail to the label's definition: every
// field it was made with in aligned rows. A press on the rule, a prompt label's model or the records it went over (or
// e, for the rule) puts that field in the pane's input bar to change (labelEdit, which threads/pane.tsx draws there):
// ↵ applies the label again with it, by the command Claude runs (edit.ts), esc cancels. The keys stay in one row above
// the input in every state. A click moves too: a label's name or a value opens it (the open one again: back to all the
// labels), an example picks it (again: closes it), `↑ N earlier` and `↓ N more` page the examples. The person's check
// of the picked example (a number key, or a press on a value) counts in place of the label's value (labels.ts
// checkRecord); the next example is picked after it. esc goes back to all the labels from a label, however it opened.
//
//   openLabels($, args)   opens the pane and gives it the keyboard (the bar's l, a click on its label count): all
//                         the labels, or one label
//   showLabels($, args)   what the pane shows next, as the person moves in it
//   colorOf(values, v)    a value's color in the theme drawn now (labels/use.ts colors the label rows with it)
//   labelEdit($, args)    the field the pane's arguments edit in the input bar, or null (threads/pane.tsx)
//
//   args: {label: the label open, value: the value whose examples show ('-': no value yet), at: the first example of
//          the page, sel: the ref of the example picked, def: the definition in place of the examples, edit: the
//          field of the definition in the input bar}
//   keys while the pane holds the keyboard: p n the previous or next value, in reading order over all the labels
//          (nothing open: n the first, p the last; the definition: the previous or next label) · k j the previous or
//          next example (none picked: the last or the first shown), past the page's edge onto the next page · d the
//          definition, or the examples again · e edit the rule · b back to all the labels · 1-9 check the picked
//          example as that value · 0 takes a check back
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { quiet } from '../core/askcell.js'
import { rootHere, startDir } from '../core/env'
import { busy } from '../bar/busy'
import { openPane, paneBack } from '../core/pane'
import { textWidth } from '../core/text.js'
import { accent, themeLast, themeNow } from '../core/theme'
import { rowsUnder, type PaneEdit } from '../threads/seam'
import { rerunLabel } from './edit'
import { SETTINGS } from './labelreads.mjs'
import { checkRecord, labelsData } from './labels'
import { chosenOf, definition, examples, isNegative, ledgerTop, NONE, partOf, partsOf, ruleWord, valueOrder } from './ledger.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; tone?: string; bold?: boolean; italic?: boolean; part?: string; hotkey?: string }
type Row = Run[] | { code: string }

export type LabelsArgs = { label?: string; value?: string; at?: number; sel?: string | null; def?: boolean; edit?: string }

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

/** All the labels, as esc goes back to them from a label. */
const ALL = { kind: 'labels', args: {}, title: 'Labels' }

export async function openLabels($: Engine, args: LabelsArgs = {}): Promise<boolean> {
  return openPane($, 'labels', args, titleOf(args), { focus: true, rows: 28, ...(args.label ? { under: ALL } : {}) })
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
      // a field of the definition: no underline, so it does not read as a citation; under the pointer it lights up
      ...(part.startsWith('f[') ? { hover: quiet(`labels-${key}:${part}`, { underline: false, inverse: true }) } : {}),
      onPress: () => press(part), children: runs.map((r, k) => span(r, i + k)),
    }))
    i = j
  }
  return Box({ key, flexDirection: 'row', children: kids })
}

/** Where a code label's code stands: under the definition's values, past their names (ledger.mjs definition). */
const CODE_X = 9

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
  const topOf = (c: Any) => ledgerTop(list, c, { w: W, rows: room - 4, def: !!a.def || !!a.edit })
  const chosen = chosenOf(list, a) as { lab: Any; value: string } | null
  const label = chosen ? String(chosen.lab.name) : null
  const value = chosen?.value ?? null
  const go = (b: LabelsArgs) => showLabels($, b)
  const here = (b: LabelsArgs = {}) => go({ label: label!, value: value!, ...b })
  const editable = !!chosen && chosen.lab.kind !== 'code' && !!String(chosen.lab.rule || '').trim()

  // ---- the keys, in the one row above the input: each pushed with its words, in the order they stand
  const keys: { k: string; label: string; onPress: () => unknown }[] = []
  const key = (k: string, words: string, onPress: () => unknown) => keys.push({ k, label: words, onPress })
  const order = valueOrder(list) as [string, string][]
  const at = chosen ? order.findIndex(([l, v]) => l === label && v === value) : -1
  const hop = (d: number) => {
    if (!order.length) return undefined
    const [l, v] = order[at < 0 ? (d > 0 ? 0 : order.length - 1) : (at + d + order.length) % order.length]!
    return go({ label: l, value: v })
  }
  /** The definition's p n: the previous or next label, its definition too. */
  const hopLabel = (d: number) => {
    const i = list.findIndex((l: Any) => l.name === label)
    return go({ label: String(list[(i + d + list.length) % list.length].name), def: true })
  }
  const flip = () => here({ at: a.at, sel: a.sel ?? null, def: !a.def })
  const editRule = () => here({ def: true, edit: 'rule' })
  // the rows the keys take, for the examples' page: their rule and the words, wrapped (` · ` between keys)
  const keyRows = (n: number, words: number) => (n ? 1 + Math.ceil((words + 3 * (n - 1)) / W) : 0)
  const plan: [string, string][] = !chosen
    ? (order.length ? [['p', 'previous'], ['n', 'next value'], ['k', 'previous'], ['j', 'next example']] : [])
    : a.edit ? [] : a.def ? [...(editable ? [['e', `edit ${ruleWord(chosen.lab)}`]] as [string, string][] : []), ['d', 'examples'], ['p', 'previous'], ['n', 'next label'], ['b', 'all labels']]
      : [['d', 'definition'], ['p', 'previous'], ['n', 'next value'], ['k', 'previous'], ['j', 'next example'], ...(editable ? [['e', `edit ${ruleWord(chosen.lab)}`]] as [string, string][] : []), ['b', 'all labels']]
  const planRows = a.edit ? 2 : keyRows(plan.length, plan.reduce((t, [k, w]) => t + textWidth(k) + 2 + textWidth(w), 0))
  /** The examples a value's page holds: the rows under the label with that value open, less the pane's head and its
   *  gap, the examples' head and the keys. */
  const perOf = (c: Any) => Math.max(1, room - 3 - topOf(c).rows.length - 1 - planRows)
  const top = topOf(chosen)

  // ---- under the label: its definition, or the value's examples
  let section: Row[] = []
  let ex: Any = null
  let page: Any = null
  const per = chosen ? perOf(chosen) : 0
  if (chosen) {
    if (a.def || a.edit) section = definition(chosen.lab, W, show, { model: SETTINGS.model, editing: a.edit ?? null }) as Row[]
    else {
      const count = partsOf(chosen.lab).find((p: Any) => p.v === value)?.n ?? 0
      const first = Math.max(0, Math.min(Number(a.at) || 0, Math.max(0, count - 1)))
      page = count ? await labelsData($, { root, label: label!, value: value!, at: first, n: per }) : { at: 0, total: 0, records: [] }
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

  const step = async (d: number) => {
    // no examples shown: the first example of the value open (nothing open: the first value's), or the last one's last
    if (!chosen || !ex) {
      const [l, v] = chosen ? [label!, value!] : ((d > 0 ? order[0] : order[order.length - 1]) ?? [])
      if (!l || v == null) return undefined
      const n = countOf(l, v)
      const i = d > 0 ? 0 : n - 1
      return go({ label: l, value: v, at: d > 0 ? 0 : Math.max(0, i - perOf(chosenOf(list, { label: l, value: v })) + 1), sel: n ? await refAt(l, v, i) : null })
    }
    if (!recs.length || !total) return undefined
    const p = ex.p as number
    if (p < 0) return here({ at: pageAt, sel: d > 0 ? ex.shown[0] : ex.shown[ex.shown.length - 1] })
    const j = p + d
    if (j >= 0 && j < recs.length) return here({ at: pageAt, sel: String(recs[j].ref) })
    // past the page's edge: onto the page after or before it, or round to the other end
    const i = (pageAt + j + total) % total
    return here({ at: d > 0 ? i : Math.max(0, i - per + 1), sel: await refAt(label!, value!, i) })
  }
  const does: Record<string, () => unknown> = {
    p: () => (chosen && a.def ? hopLabel(-1) : hop(-1)), n: () => (chosen && a.def ? hopLabel(1) : hop(1)),
    k: () => step(-1), j: () => step(1), d: flip, e: editRule, b: () => go({}),
  }
  for (const [k, w] of plan) key(k, w, does[k]!)

  // ---- a press on a part of a row
  const press = (part: string) => {
    const [kind, x, y] = partOf(part) as [string, Any, Any]
    if (kind === 'l') return chosen && label === x && list.length > 1 ? go({}) : go({ label: String(x) })
    if (kind === 'v') return chosen && label === x && value === y && list.length > 1 ? go({}) : go({ label: String(x), value: String(y) })
    if (kind === 'r') return here({ at: pageAt, sel: a.sel === x ? null : String(x) })
    if (kind === 'c') return check(x == null ? null : String(x))
    // a field of the definition: into the input bar to change (the one being changed already is)
    if (kind === 'f') return a.edit === x ? undefined : here({ def: true, edit: String(x) })
    if (part === 'pg-up' && ex) return here({ at: Math.max(0, ex.from - per) })
    if (part === 'pg-down' && ex) return here({ at: ex.last + 1 })
    return undefined
  }

  // ---- the pane: the head, the label (or the labels) and the detail, the keys at the bottom
  const headRow = Box({ key: 'head', flexDirection: 'row', children: [rowEl(els, top.head as Run[], 'head-words', press)] })
  const body = [...(top.rows as Row[]), ...section]
  const keyLook = { color: accent(), bold: true }
  const keysRow = a.edit && chosen
    // editing: ↵ (the input's own) applies the change over the same records, esc (or a click here) cancels
    ? Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: [
      Text({ key: 'k-enter', ...keyLook, children: '↵' }), Text({ key: 'w-enter', dimColor: true, children: ` rerun over the same ${Number(chosen.lab.records || 0).toLocaleString('en-US')} records` }),
      Text({ key: 'sep', dimColor: true, children: ' · ' }),
      Button({ key: 'key-esc', plain: true, label: 'cancel the edit', hover: quiet('labels-key-esc'), onPress: () => paneBack($), children: [Text({ key: 'k', ...keyLook, children: 'esc' }), Text({ key: 'w', dimColor: true, children: ' cancel' })] }),
    ] })
    : Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: keys.flatMap((x, i) => [
      ...(i ? [Text({ key: `key-gap-${i}`, dimColor: true, children: ' · ' })] : []),
      // under the pointer a key's words brighten and underline, never Claude Code's inverse (askcell.js quiet)
      Button({ key: `key-${x.k}`, plain: true, hotkey: x.k, label: x.label, hover: quiet(`labels-key-${x.k}`), onPress: x.onPress, children: [Text({ key: 'w', dimColor: true, children: x.label })] }),
    ]) })
  const hasKeys = !!(a.edit && chosen) || keys.length > 0
  // a code label's code stands under the field's value, CODE_X in, and wraps there
  const used = 2 + body.reduce((t: number, r) => t + (Array.isArray(r) ? 1 : codeRows(r.code, W - CODE_X - 2)), 0) + (hasKeys ? planRows : 0)
  const rowOf = (r: Row, i: number) => (Array.isArray(r)
    ? rowEl(els, r, `r${i}`, press)
    : Box({ key: `r${i}`, paddingLeft: CODE_X, children: [Code({ key: 'code', source: r.code, language: 'python' })] }))
  return Box({ flexDirection: 'column', children: [
    headRow,
    Text({ key: 'gap', children: ' ' }),
    ...body.map(rowOf),
    ...Array.from({ length: Math.max(0, room - used) }, (_, i) => Text({ key: `fill${i}`, children: ' ' })),
    ...(hasKeys ? [Text({ key: 'rule', dimColor: true, children: '─'.repeat(W) }), keysRow] : []),
  ] })
}

// ------------------------------------------------------------------------------------------------ editing a field

/** A field's name in the input bar, by the field the definition's press names. */
const fieldWord = (lab: Any, f: string) => (f === 'rule' ? ruleWord(lab) : f === 'in' ? 'over' : f)

/** What the pane's arguments edit: the field of the open label in the input bar (threads/pane.tsx draws it in place of
 *  the question), its value as the label holds it; ↵ goes back to the label and applies it again with the new value,
 *  unless it is the same. */
export async function labelEdit($: Engine, args: unknown): Promise<PaneEdit | null> {
  const a = (args && typeof args === 'object' ? args : {}) as LabelsArgs
  if (!a.label || !a.edit) return null
  const root = (await rootHere($)) ?? (await startDir($))
  const list = await labelsData($, { root })
  const lab = Array.isArray(list) ? list.find((l: Any) => l.name === a.label) : null
  if (!lab) return null
  const f = a.edit
  const now = f === 'within' ? (lab.within ? lab.within.join('=') : '') : f === 'model' ? String(lab.model || SETTINGS.model) : String(lab[f] ?? '')
  return {
    name: fieldWord(lab, f), value: now, key: `${lab.name}-${f}-${lab.rev ?? 0}`,
    submit: async (text: string) => {
      const v = String(text ?? '').trim()
      await paneBack($)
      if (v === now.trim() || (!v && (f === 'rule' || f === 'in'))) return
      const bad = await busy($, `applying ${lab.name} again`, () => rerunLabel($, root, lab, { [f]: v || null }))
      if (bad) failNotice($, bad)
    },
  }
}
