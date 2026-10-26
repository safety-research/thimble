// bar.tsx: the bar, thimble's line above the prompt, as one drawing. Its rows, top down:
//
//   the failure line  only while there is one (bar/notice.ts failLineNow): a failure in red, or a notice. It wraps, so
//                  the whole failure shows
//   the fix line   only while there is one (fix/line.ts): a fix that is ready (y use it now · d what changed · n
//                  later), on (u undo), off, failed, or a request with no code
//   the bar        `thimble` (a click opens the settings), the step thimble works on now (busy.ts), the keys of the
//                  card that takes them now (cards/draw.ts cardKeyWords: `j down · k up`), `v card` while
//                  Cards is on, an answer exists and no design runs, then the items of the features that act on answers
//                  (core/answerview.ts barLeft: a label run's ask, the tray's steps, `s squeeze`, `c 11 claims`); at its
//                  right their items (barRight: `t 2 threads`), then `r coverage 43% (3/7 files)` and `l 2 labels` while
//                  Coverage and Labels are on, each by its own setting (a click or the key opens the pane; register.ts says how each closes)
//
// The settings pane draws the same bar as its switches would leave it (`preview`): nothing in it is a press and no
// work shows.
import type { EngineInterface } from 'claude-code'

import { barLeft, barRight } from '../core/answerview'
import { quiet } from '../core/askcell.js'
import { cut, textWidth } from '../core/text.js'
import { accent } from '../core/theme'
import { cardKeyWords } from '../cards/draw'
import { vReady } from '../designer/v'
import { fixLineRows } from '../fix/line'
import { pressKey } from '../hooks/keys'
import { featureOn } from '../settings/features.mjs'
import { busyNow } from './busy'
import { countsNow, keptCounts } from './counts'
import { failLineNow } from './notice'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any



/** What a press on a part of the bar does; register.ts gives them, so this module draws and decides nothing else. */
export type BarPresses = { settings: () => unknown; pane: (kind: 'coverage' | 'labels') => unknown }

/** One item of the bar: an optional key and its words, and the press that does what the key does. `focus`: a key of
 *  what holds the keys now (the open tray, the open chips); while any shows, the bar's left names only those, after
 *  the busy step. `color` and `bold`: words drawn lit (`s ● short`) or as a failure, not dim. */
type Item = { id: string; key?: string; words: string; glyph?: string; press?: () => unknown; focus?: boolean; color?: string; bold?: boolean }
/** An item a feature puts on the bar (core/answerview.ts barLeft, barRight). */
export type BarItem = Item

const len = textWidth
/** How an item's words are drawn: dim, or in the item's own color. */
const wordLook = (x: Item) => (x.color ? { color: x.color, ...(x.bold ? { bold: true } : {}) } : { dimColor: true, ...(x.bold ? { bold: true } : {}) })
const itemLen = (x: Item) => (x.key ? len(x.key) + 1 : 0) + len(x.words)

/** The bar's items at its right: coverage, then the labels, as the counts last stood, each while its setting is on. */
async function countItems($: Engine, on: (key: string) => boolean, presses: BarPresses | null, preview = false): Promise<Item[]> {
  if (!on('coverage') && !on('labels')) return []
  const c = await countsNow($)
  const out: Item[] = []
  if (on('coverage')) {
    if (c?.coverage) out.push({ id: 'coverage', key: 'r', words: `coverage ${c.coverage}`, ...(presses ? { press: () => presses.pane('coverage') } : {}) })
    else if (preview) out.push({ id: 'coverage', key: 'r', words: 'coverage' })
  }
  if (on('labels')) {
    if (c?.labels) out.push({ id: 'labels', key: 'l', words: `${c.labels.toLocaleString('en-US')} label${c.labels === 1 ? '' : 's'}`, ...(presses ? { press: () => presses.pane('labels') } : {}) })
    else if (preview) out.push({ id: 'labels', key: 'l', words: 'labels' })
  }
  return out
}

/** The bar's items at its left, after `thimble`: the busy step, v, then the features' items. */
async function leftItems($: Engine, on: (key: string) => boolean, preview: boolean): Promise<Item[]> {
  const out: Item[] = []
  const b = preview ? null : await busyNow($)
  if (b) out.push({ id: 'busy', glyph: b.glyph, words: [`${b.word}${b.secs != null ? ` ${b.secs}s` : ''}`, ...b.more].join(' · ') })
  const features = await barLeft($, on, preview)
  if (features.some(x => x.focus)) return [...out, ...features.filter(x => x.focus)]
  // the keys of the card on screen that takes them, each a click that presses it
  if (!preview && on('cards')) {
    for (const k of await cardKeyWords($).catch(() => [])) out.push({ id: `card-key-${k.key}`, key: k.key, words: k.words, ...(k.key.length === 1 ? { press: () => pressKey($, k.key) } : {}) })
  }
  // a click on `v card` starts the designer fork as v does, in the ui.press hook that answers it (designer/v.ts)
  if (on('cards') && (preview || (await vReady($)))) out.push({ id: 'v', key: 'v', words: 'card', ...(preview ? {} : { press: () => undefined }) })
  out.push(...features)
  return out
}

/** The keys the bar names now (r and l act only while they show), from the counts as last kept (counts.ts keptCounts):
 *  a key press reads no state. */
export async function barKeys($: Engine): Promise<Set<string>> {
  if (!featureOn('coverage') && !featureOn('labels')) return new Set()
  const c = await keptCounts($)
  return new Set([...(featureOn('coverage') && c?.coverage ? ['r'] : []), ...(featureOn('labels') && c?.labels ? ['l'] : [])])
}

/** The bar's rows: the failure line (when there is one) and the bar, `width` cells wide. */
export async function barRows($: Engine, els: Any, width: number, o: { on?: (key: string) => boolean; presses?: BarPresses; preview?: boolean } = {}): Promise<Any[]> {
  const { Box, Button, Text } = els
  const on = o.on ?? featureOn
  const preview = !!o.preview
  const presses = preview ? null : o.presses ?? null
  const left = await leftItems($, on, preview)
  let right = [...(await barRight($, on, preview)), ...(await countItems($, on, presses, preview))]
  // a narrow bar: the labels' count goes first, then coverage's file counts, then coverage. The preview shows every
  // item the switches leave on, its right part on a line of its own when it does not fit
  const room = () => width - 9 - left.reduce((n, x) => n + itemLen(x) + 3, 0) - right.reduce((n, x) => n + itemLen(x) + 3, 0)
  if (!preview && room() < 0) right = right.filter(x => x.id !== 'labels')
  if (!preview && room() < 0) right = right.map(x => (x.id === 'coverage' ? { ...x, words: x.words.replace(/ \(.*\)$/, '') } : x))
  if (!preview && room() < 0) right = []
  // then the busy item's other steps go, and its words are cut, so the bar keeps to one row
  const b = left.findIndex(x => x.id === 'busy')
  if (!preview && b >= 0 && room() < 0) left[b] = { ...left[b]!, words: left[b]!.words.split(' · ')[0]! }
  if (!preview && b >= 0 && room() < 0) left[b] = { ...left[b]!, words: cut(left[b]!.words, Math.max(8, len(left[b]!.words) + room())) }

  const words = (x: Item, i: number): Any[] => [
    ...(x.glyph ? [Text({ key: `g${i}`, color: accent(), children: `${x.glyph} ` })] : []),
    ...(x.key ? [Text({ key: `k${i}`, color: accent(), bold: true, children: x.key }), Text({ key: `w${i}`, ...wordLook(x), children: ` ${x.words}` })] : [Text({ key: `w${i}`, ...wordLook(x), children: x.words })]),
  ]
  const drawn = (x: Item, i: number): Any => (x.press
    ? Button({ key: `bar-${x.id}`, plain: true, label: `${x.key ? `${x.key} ` : ''}${x.words}`, onPress: x.press, children: words(x, i) })
    : Text({ key: `bar-${x.id}`, children: words(x, i) }))
  const joined = (xs: Item[], at: number): Any[] => xs.flatMap((x, i) => [...(i ? [Text({ key: `s${at + i}`, dimColor: true, children: ' · ' })] : []), drawn(x, at + i)])

  const name = Text({ key: 'name', color: accent(), bold: true, children: 'thimble' })
  const label = presses ? Button({ key: 'bar-thimble', plain: true, label: 'thimble settings', onPress: presses.settings, children: [name] }) : name
  const bar = Box({ key: 'bar', flexDirection: 'row', justifyContent: 'space-between', width, ...(preview ? { flexWrap: 'wrap' } : {}), children: [
    // the preview wraps its items whole, as many as the switches leave on
    Box({ key: 'bar-left', flexDirection: 'row', flexShrink: 1, ...(preview ? { flexWrap: 'wrap' } : {}), children: [label, ...(left.length ? [Text({ key: 'gap', children: '  ' }), ...joined(left, 0)] : [])] }),
    ...(right.length ? [Box({ key: 'bar-right', flexDirection: 'row', flexShrink: 0, children: joined(right, left.length) })] : []),
  ] })
  // a fix's line keeps one blank row between it and the bar, so its keys do not read as the bar's
  const fixRows = preview ? [] : await fixLineRows($, els, width).catch(() => [])
  return [...(preview ? [] : await lineRows($, els, width)), ...fixRows, ...(fixRows.length ? [Text({ key: 'fix-gap', children: ' ' })] : []), bar]
}

/** The failure line: what failed, whole, in red, or a notice. A key it names (`Press x to try again`) is a click
 *  too, which presses that key as the prompt would take it (hooks/keys.ts pressKey); esc and the keys of a pane are
 *  not, as no click at the prompt can press them. */
async function lineRows($: Engine, els: Any, width: number): Promise<Any[]> {
  const { Box, Button, Text } = els
  const fail = await failLineNow($)
  if (!fail) return []
  const look = fail.kind === 'failed' ? { color: 'error' } : { color: 'warning' }
  const words = fail.kind === 'failed' ? `× ${fail.text.replace(/^[×!]\s*/, '')}` : fail.text
  const parts = keyedWords(words)
  if (!parts.some(p => p.key)) return [Box({ key: 'fail-line', flexDirection: 'row', flexWrap: 'wrap', width, children: [Text({ key: 'fail-text', ...look, wrap: 'wrap', children: words })] })]
  // with a key to press: wrapped here, word by word, so its press stands among the words (a Text holds no Button)
  const lines: Any[][] = [[]]
  let used = 0
  parts.forEach((p, i) => {
    const pieces = p.key ? [p.s] : p.s.split(/(?<= )/)
    pieces.forEach((w, j) => {
      if (used && used + len(w.trimEnd()) > width) { lines.push([]); used = 0 }
      if (!used && !p.key) w = w.trimStart()
      if (!w) return
      used += len(w)
      lines[lines.length - 1]!.push(p.key
        ? Button({ key: `fail-key-${i}`, plain: true, label: `press ${p.key}`, hover: quiet(`fail-key-${i}`), onPress: () => pressKey($, p.key!), children: [Text({ ...look, bold: true, underline: true, children: w })] })
        : Text({ key: `fail-w-${i}-${j}`, ...look, children: w }))
    })
  })
  const text = Box({ key: 'fail-text', flexDirection: 'column', children: lines.map((l, k) => Box({ key: `fail-row-${k}`, flexDirection: 'row', children: l })) })
  return [Box({ key: 'fail-line', flexDirection: 'row', width, children: [text] })]
}

/** A line's words cut at each key it tells the person to press (`Press x`, `press 0`): the key alone is its own part. */
export function keyedWords(s: string): { s: string; key?: string }[] {
  const out: { s: string; key?: string }[] = []
  let at = 0
  for (const m of s.matchAll(/\b[Pp]ress ([a-z0-9])\b(?! ?\+)/g)) {
    const k = m.index! + m[0].length - 1
    if (k > at) out.push({ s: s.slice(at, k) })
    out.push({ s: m[1]!, key: m[1]! })
    at = k + 1
  }
  if (at < s.length) out.push({ s: s.slice(at) })
  return out
}
