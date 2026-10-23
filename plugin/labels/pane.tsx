// pane.tsx: the labels pane (core/pane.ts kind `labels`), drawn with Claude Code's own elements. It opens on the
// folder's labels: each one's name, kind, records, and its values as a bar in the values' colors. A label opens on its
// definition, whole (the pattern, the code, or the prompt), its counts per value, then the records of one value, a page
// at a time, the ones the person has not checked first: each record's `path:line` and its words, cut to two lines
// around the part its regex or code matched, marked (or why none is). Paths show relative to the session's folder, or
// with … in their middle outside it. The person checks the record the ▸ points at with a number key, or a press on a value:
// their value counts in place of the label's (labels.ts checkRecord).
//
//   openLabels($, args)   opens the pane and gives it the keyboard (the bar's l, a click on its label count): the
//                         list, or one label
//   showLabels($, args)   what the pane shows next, as the person moves in it
//
//   args: {label: the label open, value: the value whose records show ('-': no value yet), at: the page's first record,
//          sel: the ref of the record the ▸ points at}
//   keys while the pane holds the keyboard: 1-9 a list's label, or a check of the record · 0 takes a check back ·
//          j k the next or previous record · n p the next or previous page · v the next value · b back to the labels
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { rootHere, startDir } from '../core/env'
import { quiet } from '../core/askcell.js'
import { openPane, PANE_ID } from '../core/pane'
import { cut, cutWords, textWidth } from '../core/text.js'
import { checkRecord, labelsData } from './labels'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type LabelsArgs = { label?: string; value?: string; at?: number; sel?: string | null }

/** The values' colors, the first value's first; a record with no value yet is drawn in the theme's inactive gray. */
const COLORS = ['#5aa2e6', '#cfae7e', '#8fa1bd', '#e384b2', '#b2c24f', '#a98be0', '#3cc2b9']
const NONE = '-'
export const colorOf = (values: string[], v: string) => (v === NONE ? 'inactive' : COLORS[Math.max(0, values.indexOf(v)) % COLORS.length]!)

const n = (x: unknown) => Number(x || 0).toLocaleString('en-US')
const width = textWidth
const pad = (s: string, k: number) => cut(s, k) + ' '.repeat(Math.max(0, k - width(cut(s, k))))
/** Text on one line: a line break as ⏎, each run of spaces as one; `trim` false keeps a space at either end. */
const oneLine = (s: unknown, trim = true) => { const t = String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ').replace(/\s+/g, ' '); return trim ? t.trim() : t }

/** Where a record is, as a terminal opens it: `path:line` for a line, else its ref; `show` gives the path as shown. */
export function placeOf(ref: string, show: (path: string) => string = p => p): string {
  const m = /^(.*)#L(\d+)(?:-\d+)?$/.exec(ref)
  if (m) return `${show(m[1]!)}:${m[2]}`
  const [path, ...rest] = ref.split('#')
  return [show(path!), ...rest].join('#')
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

const titleOf = (args: LabelsArgs) => (args.label ? `Label ${args.label}` : 'Labels')

export async function openLabels($: Engine, args: LabelsArgs = {}): Promise<boolean> {
  return openPane($, 'labels', args, titleOf(args), { focus: true, rows: 28 })
}

export async function showLabels($: Engine, args: LabelsArgs): Promise<void> {
  await openPane($, 'labels', args, titleOf(args))
}

/** `cells` shared by `weights` (largest remainders), each part that is not zero at least one cell while there are
 *  enough. */
function share(weights: number[], cells: number): number[] {
  const total = weights.reduce((s, x) => s + x, 0)
  if (!total || cells <= 0) return weights.map(() => 0)
  const exact = weights.map(x => (x * cells) / total)
  const out = exact.map(Math.floor)
  const order = exact.map((c, i) => ({ i, r: c - Math.floor(c) })).sort((a, b) => b.r - a.r)
  for (let k = 0, left = cells - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k % order.length]!.i]!++
  weights.forEach((x, i) => {
    if (x > 0 && !out[i]) {
      const big = out.reduce((b, c, j) => (c > out[b]! ? j : b), 0)
      if (out[big]! > 1) { out[big]!--; out[i] = 1 }
    }
  })
  return out
}

/** A part's share in whole percents, never 0% or 100% for a part that is neither none nor all. */
function share100(part: number, all: number): string {
  const p = (100 * part) / all
  if (part === 0 || part === all) return `${Math.round(p)}%`
  return p < 1 ? '<1%' : p > 99 ? '>99%' : `${Math.round(p)}%`
}

/** A label's parts: each value with its records, then those that wait for the model or got no value. */
function partsOf(l: Any): { v: string; name: string; n: number }[] {
  const counts = l.counts || {}
  const values: string[] = [...(l.values || []), ...Object.keys(counts).filter(v => !(l.values || []).includes(v))]
  const out = values.map(v => ({ v, name: v, n: Number(counts[v]) || 0 }))
  const none = (Number(l.waiting) || 0) + (Number(l.failed) || 0)
  if (none) out.push({ v: NONE, name: l.waiting ? 'not labeled yet' : 'no value', n: none })
  return out
}

/** How a label was made, in a few words. */
function kindWords(kind: string): string {
  if (kind === 'regex') return 'regex'
  if (kind === 'code') return 'code'
  if (kind === 'prompt') return 'prompt: the model read each record'
  if (kind === 'set') return 'values Claude gave'
  return String(kind || '')
}

export async function drawLabels($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as LabelsArgs
  const start = await startDir($)
  const root = (await rootHere($)) ?? start
  const show = (p: string) => shownPath(p, root, start)
  const W = Math.max(40, Number(e?.props?.bodyColumns) || 80)
  const H = Math.max(12, Number(e?.props?.scroll?.bodyRows) || 28)
  const list = await labelsData($, { root })
  const { Text } = els
  if (!Array.isArray(list)) return Text({ color: 'error', wrap: 'wrap', children: `× The labels could not be read: ${String(list?.error || 'no answer')}` })
  const lab = a.label ? list.find((l: Any) => l.name === a.label) : list.length === 1 ? list[0] : null
  if (!lab) return listView($, els, list, W)
  return labelView($, els, root, show, a, lab, list.length, W, H)
}

// ------------------------------------------------------------------------------------------------ the labels

function listView($: Engine, els: Any, list: Any[], W: number): unknown {
  const { Box, Button, Text } = els
  if (!list.length) {
    return Text({ dimColor: true, wrap: 'wrap', children: 'No labels yet.' })
  }
  const nameW = Math.min(24, Math.max(...list.map(l => width(String(l.name)))))
  const recW = Math.max(...list.map(l => n(l.records).length))
  const barW = Math.max(8, Math.min(30, W - 4 - nameW - recW - 12))
  const rows = list.map((l, i) => {
    const parts = partsOf(l)
    const cells = share(parts.map(p => p.n), barW)
    const bar = parts.map((p, k) => (cells[k] ? Text({ key: `b${k}`, color: colorOf(l.values, p.v), children: (p.v === NONE ? '░' : '█').repeat(cells[k]!) }) : null)).filter(Boolean)
    const legend = parts.filter(p => p.n).map((p, k) => Text({ key: `g${k}`, children: [Text({ key: 'm', color: colorOf(l.values, p.v), children: '● ' }), `${p.name} `, Text({ key: 'c', dimColor: true, children: `${n(p.n)}   ` })] }))
    return Box({ key: `l-${l.name}`, flexDirection: 'column', children: [
      Button({
        key: `open-${l.name}`, plain: true, ...(i < 9 ? { hotkey: String(i + 1) } : {}),
        onPress: () => showLabels($, { label: String(l.name) }),
        children: [Text({ key: 'n', bold: true, children: `${pad(String(l.name), nameW)}  ` }), ...(bar.length ? bar : [Text({ key: 'b', dimColor: true, children: pad('not run yet', barW) })]), Text({ key: 'r', dimColor: true, children: `  ${n(l.records).padStart(recW)} records · ${l.kind}` })],
      }),
      Text({ key: 'legend', wrap: 'truncate-end', children: [i < 9 ? '   ' : '', ...legend, ...(l.checked ? [Text({ key: 'ck', dimColor: true, children: `you checked ${n(l.checked)}` })] : [])] }),
    ] })
  })
  return Box({ flexDirection: 'column', children: [
    Text({ key: 'head', dimColor: true, children: `${list.length} label${list.length === 1 ? '' : 's'}` }),
    Text({ key: 'gap', children: ' ' }),
    ...rows,
  ] })
}

// ------------------------------------------------------------------------------------------------ one label

/** The definition, whole: the pattern on its line, the code as code, the prompt wrapped. */
function definition(els: Any, lab: Any): unknown[] {
  const { Code, Text } = els
  const rule = String(lab.rule || '').trim()
  if (!rule) return [Text({ key: 'def', dimColor: true, children: 'no rule: Claude read each record' })]
  if (lab.kind === 'code') return [Code({ key: 'def', source: rule, language: 'python' })]
  return [Text({ key: 'def', wrap: 'wrap', children: rule })]
}

/** The scope a label went over, in words. */
function scopeWords(lab: Any, show: (p: string) => string): string {
  const parts = [`${n(lab.records)} record${lab.records === 1 ? '' : 's'} in ${lab.in ? show(String(lab.in)) : 'the records Claude named'}`]
  // a long condition (a list of 22 values) at most two lines: the scope stays readable above the counts
  if (lab.where) parts.push(`where ${cut(oneLine(String(lab.where), false), 160)}`)
  if (lab.within) parts.push(`within ${lab.within[0]} = ${lab.within[1]}`)
  if (lab.trial) parts.push(`a trial: ${n(lab.records)} of ${n(lab.matched)} at random`)
  if (lab.checked) parts.push(`you checked ${n(lab.checked)}: ${n(lab.agree)} agree, ${n(lab.disagree)} changed`)
  return parts.join(' · ')
}

/** A record's words as parts of a Text, in `room` characters: around the part its label matched (a regex's match, or
 *  the match a code label's code made), that part bold in the value's color, each side cut at a word's edge, the side
 *  with less to say giving its room to the other; else the record's words, then the fields a code label read, dim. */
function wordsOf(els: Any, r: Any, color: string, room: number): unknown[] {
  const { Text } = els
  if (r.missing) return [Text({ key: 'w', dimColor: true, children: String(r.missing) })]
  if (r.hit) {
    const match = cut(oneLine(r.hit.match, false), room)
    const left = Math.max(0, room - width(match))
    const before = oneLine(r.hit.before, false).trimStart()
    const after = oneLine(r.hit.after, false).trimEnd()
    const shown = cutWords(before, Math.min(width(before), Math.max(Math.floor(left / 2), left - width(after))), 'end')
    return [shown, Text({ key: 'm', bold: true, color, children: match }), cutWords(after, left - width(shown), 'start')]
  }
  const said = oneLine(r.words || r.text)
  // the fields the code read, unless the words already start with them
  const fields = Array.isArray(r.fields) ? r.fields.filter((f: string[]) => !said.startsWith(oneLine(f[1]).slice(0, 40))).map((f: string[]) => `${f[0]} ${oneLine(f[1])}`).join(' · ') : ''
  if (!fields) return [cutWords(said, room)]
  return [cutWords(said, Math.max(10, room - width(fields) - 2)), Text({ key: 'f', dimColor: true, children: `  ${cut(fields, room)}` })]
}

async function labelView($: Engine, els: Any, root: string, show: (p: string) => string, a: LabelsArgs, lab: Any, labels: number, W: number, H: number): Promise<unknown> {
  const { Box, Button, Text } = els
  const values: string[] = lab.values || []
  const parts = partsOf(lab)
  const go = (b: LabelsArgs) => showLabels($, { label: String(lab.name), value: a.value, at: a.at, sel: a.sel, ...b })
  const picks = parts.filter(p => p.v !== NONE || p.n)
  const value = picks.some(p => p.v === a.value) ? a.value! : (picks.find(p => p.n)?.v ?? picks[0]?.v ?? NONE)
  const total = parts.find(p => p.v === value)?.n ?? 0

  // ---- the head: the label, its kind, its definition whole, what it went over
  const head: unknown[] = [
    Text({ key: 'name', children: [Text({ key: 'm', color: colorOf(values, values[0] ?? ''), children: '● ' }), Text({ key: 'n', bold: true, children: String(lab.name) }), Text({ key: 'k', dimColor: true, children: `  ${kindWords(lab.kind)}` })] }),
    Box({ key: 'def', paddingLeft: 2, flexDirection: 'column', children: definition(els, lab) }),
    Text({ key: 'scope', dimColor: true, wrap: 'wrap', children: scopeWords(lab, show) }),
    Text({ key: 'gap1', children: ' ' }),
  ]

  // ---- the values: each its color, a bar, its count and share; a press (or v) shows its records
  const nameW = Math.min(20, Math.max(4, ...parts.map(p => width(p.name))))
  const barW = Math.max(6, Math.min(30, W - nameW - 22))
  const most = Math.max(1, ...parts.map(p => p.n))
  const valueRows = picks.map(p => {
    const on = p.v === value
    const cells = p.n ? Math.max(1, Math.round((p.n / most) * barW)) : 0
    const pct = lab.records ? share100(p.n, lab.records) : ''
    return Button({
      key: `value-${p.v}`, plain: true, onPress: () => go({ value: p.v, at: 0, sel: null }),
      children: [
        Text({ key: 'p', children: on ? '▸ ' : '  ' }),
        Text({ key: 'm', color: colorOf(values, p.v), children: '● ' }),
        Text({ key: 'n', bold: on, children: `${pad(p.name, nameW)}  ` }),
        Text({ key: 'b', color: colorOf(values, p.v), children: (p.v === NONE ? '░' : '█').repeat(cells) + ' '.repeat(barW - cells) }),
        Text({ key: 'c', children: `  ${n(p.n).padStart(6)} ` }),
        Text({ key: 's', dimColor: true, children: pct.padStart(4) }),
      ],
    })
  })

  // ---- the records of the value: a page that fits under the head, the unchecked first
  const defRows = String(lab.rule || '').split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(width(l) / Math.max(20, W - 2))), 0)
  const per = Math.max(3, Math.min(12, Math.floor((H - (9 + defRows + picks.length)) / 3)))
  const pageAt = Math.floor(Math.max(0, Math.min(Number(a.at) || 0, total - 1)) / per) * per
  const page = total ? await labelsData($, { root, label: String(lab.name), value, at: pageAt, n: per }) : null
  const recs: Any[] = Array.isArray(page?.records) ? page.records : []
  const count = Number(page?.total) || total
  const cur = Math.max(0, recs.findIndex(r => r.ref === a.sel))

  /** The person's check of the record the ▸ points at; then the ▸ points at `next`, which takes its place. */
  const check = async (v: string | null, next: string | null) => {
    const r = recs[cur]
    if (!r) return
    const bad = await checkRecord($, root, String(lab.name), String(r.ref), v)
    if (bad) failNotice($, bad)
    await go({ at: pageAt, sel: next })
  }
  const step = (d: number) => {
    const j = cur + d
    if (j >= 0 && j < recs.length) return go({ at: pageAt, sel: recs[j].ref })
    const next = pageAt + d * per
    return next >= 0 && next < count ? go({ at: next, sel: null }) : undefined
  }

  const body: unknown[] = []
  if (!total) body.push(Text({ key: 'none', dimColor: true, children: 'No record has this value.' }))
  else if (!Array.isArray(page?.records)) body.push(Text({ key: 'err', color: 'error', wrap: 'wrap', children: `× The records could not be read: ${String(page?.error || 'no answer')}` }))
  else {
    const vname = parts.find(p => p.v === value)?.name ?? value
    // why no words are marked: once above the records when it is the same for all of them, else at each
    const notes = recs.map(r => (r.hit ? null : (r.unmarked ?? null)))
    const one = notes.length && notes.every(x => x && x === notes[0]) ? notes[0] : null
    body.push(Text({ key: 'rhead', dimColor: true, wrap: 'wrap', children: `${vname} · ${n(pageAt + 1)}–${n(pageAt + recs.length)} of ${n(count)}${one ? ` · ${one}` : ''}` }))
    recs.forEach((r, i) => {
      const on = i === cur
      const status = r.checked ? `✓ you: ${r.value}` : r.waiting ? 'waits for the model' : r.error ? `× ${r.error}` : r.by === 'model' && r.confidence != null ? `confidence ${Math.round(100 * r.confidence)}%` : !one && !r.hit && r.unmarked ? String(r.unmarked) : ''
      // one line: the status whole, the place cut in its middle (its folder's end, its file and line stay), the meta
      // (who wrote it) in what is left
      const said = status ? `  ${cut(status, 60)}` : ''
      const room = Math.max(12, W - 2 - width(said))
      const place = placeOf(String(r.ref), show)
      const meta = r.meta ? `  ${cut(String(r.meta), 40)}` : ''
      const placeShown = cut(place, Math.max(10, room - Math.min(width(meta), 12)), true)
      const metaShown = cut(meta, Math.max(0, room - width(placeShown)))
      body.push(Box({ key: `rec-${r.ref}`, flexDirection: 'column', children: [
        Button({ key: `sel-${r.ref}`, plain: true, onPress: () => go({ at: pageAt, sel: r.ref }), children: [
          Text({ key: 'p', children: on ? '▸ ' : '  ' }),
          Text({ key: 'at', bold: on, children: placeShown }),
          Text({ key: 'meta', dimColor: true, children: metaShown }),
          Text({ key: 's', dimColor: !r.error, ...(r.error ? { color: 'error' } : {}), children: said }),
        ] }),
        // two lines of words: what a wrap at words leaves at a line's end is kept free, so the words take no third
        Box({ key: 'words', paddingLeft: 4, children: [Text({ key: 'w', wrap: 'wrap', children: wordsOf(els, r, colorOf(values, String(r.value ?? NONE)), 2 * (W - 4) - 12) })] }),
        ...(on && r.reason ? [Box({ key: 'why', paddingLeft: 4, children: [Text({ key: 'r', dimColor: true, italic: true, wrap: 'truncate-end', children: `the model: ${oneLine(r.reason)}` })] })] : []),
        ...(on && !r.missing ? [Box({ key: 'check', paddingLeft: 4, flexDirection: 'row', columnGap: 2, children: [
          ...values.map((v, k) => Button({ key: `check-${k}`, plain: true, ...(k < 9 ? { hotkey: String(k + 1) } : {}), label: v, onPress: () => check(v, recs[i + 1]?.ref ?? null) })),
          ...(r.checked ? [Button({ key: 'check-off', plain: true, hotkey: '0', label: 'take back', onPress: () => check(null, r.ref) })] : []),
        ] })] : []),
      ] }))
    })
  }

  // ---- the keys, each also a press
  const keys: unknown[] = []
  const key = (k: string, label: string, onPress: () => unknown) => keys.push(Button({ key: `key-${k}`, plain: true, hotkey: k, label, hover: quiet(`labels-key-${k}`), onPress }))
  if (recs.length) {
    key('j', 'next record', () => step(1))
    key('k', 'previous', () => step(-1))
  }
  if (pageAt + per < count) key('n', 'next page', () => go({ at: pageAt + per, sel: null }))
  if (pageAt > 0) key('p', 'previous page', () => go({ at: Math.max(0, pageAt - per), sel: null }))
  if (picks.length > 1) key('v', 'next value', () => go({ value: picks[(picks.findIndex(p => p.v === value) + 1) % picks.length]!.v, at: 0, sel: null }))
  if (labels > 1) key('b', 'labels', () => showLabels($, {}))
  return Box({ flexDirection: 'column', children: [
    ...head,
    ...valueRows,
    Text({ key: 'gap2', children: ' ' }),
    ...body,
    Text({ key: 'gap3', children: ' ' }),
    Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: keys }),
  ] })
}
