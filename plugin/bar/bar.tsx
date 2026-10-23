// bar.tsx: the bar, thimble's line above the prompt, as one drawing. Its rows, top down:
//
//   the failure line  only while there is one (bar/notice.ts failLineNow): a failure in red, or a notice. It wraps, so
//                  the whole failure shows
//   the fix line   only while there is one (fix/line.ts): a fix that is ready (y apply · d diff · n not now), on (u
//                  undo), off, failed, or a request with no code
//   the bar        `thimble` (a click opens the settings), the step thimble works on now (busy.ts), `v card` while
//                  Cards is on, an answer exists and no design runs, then the items of the features that act on answers
//                  (core/answerview.ts barLeft: a label run's ask, the tray's steps, `s squeeze`, `c 11 claims`); at its
//                  right their items (barRight: `t 2 threads`), then `r coverage 43% (3/7 files)` and `l 2 labels` while
//                  Labels and coverage is on (a click or the key opens the pane; register.ts says how each closes)
//
// The settings pane draws the same bar as its switches would leave it (`preview`): nothing in it is a press and no
// work shows. Card keys are never named here: a focused card names its own keys under its frame.
import type { EngineInterface } from 'claude-code'

import { barLeft, barRight } from '../core/answerview'
import { textWidth } from '../core/text.js'
import { vReady } from '../designer/v'
import { fixLineRows } from '../fix/line'
import { featureOn } from '../settings/features.mjs'
import { busyNow } from './busy'
import { countsNow } from './counts'
import { failLineNow } from './notice'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The colors of the bar: thimble's name, and a key the person can press. Theme keys, so light and dark both read. */
const NAME_COLOR = 'permission'
const KEY_COLOR = 'suggestion'


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

/** The bar's items at its right: coverage, then the labels, as the counts last stood. */
async function countItems($: Engine, on: (key: string) => boolean, presses: BarPresses | null, preview = false): Promise<Item[]> {
  if (!on('counts')) return []
  const c = await countsNow($)
  const out: Item[] = []
  if (c?.coverage) out.push({ id: 'coverage', key: 'r', words: `coverage ${c.coverage}`, ...(presses ? { press: () => presses.pane('coverage') } : {}) })
  else if (preview) out.push({ id: 'coverage', key: 'r', words: 'coverage' })
  if (c?.labels) out.push({ id: 'labels', key: 'l', words: `${c.labels.toLocaleString('en-US')} label${c.labels === 1 ? '' : 's'}`, ...(presses ? { press: () => presses.pane('labels') } : {}) })
  return out
}

/** The bar's items at its left, after `thimble`: the busy step, v, then the features' items. */
async function leftItems($: Engine, on: (key: string) => boolean, preview: boolean): Promise<Item[]> {
  const out: Item[] = []
  const b = preview ? null : await busyNow($)
  if (b) out.push({ id: 'busy', glyph: b.glyph, words: [`${b.word}${b.secs != null ? ` ${b.secs}s` : ''}`, ...b.more].join(' · ') })
  const features = await barLeft($, on, preview)
  if (features.some(x => x.focus)) return [...out, ...features.filter(x => x.focus)]
  if (on('cards') && (preview || (await vReady($)))) out.push({ id: 'v', key: 'v', words: 'card' })
  out.push(...features)
  return out
}

/** The keys the bar names now (r and l act only while they show). */
export async function barKeys($: Engine): Promise<Set<string>> {
  return new Set((await countItems($, featureOn, null)).map(x => x.key!).filter(Boolean))
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

  const words = (x: Item, i: number): Any[] => [
    ...(x.glyph ? [Text({ key: `g${i}`, color: NAME_COLOR, children: `${x.glyph} ` })] : []),
    ...(x.key ? [Text({ key: `k${i}`, color: KEY_COLOR, bold: true, children: x.key }), Text({ key: `w${i}`, ...wordLook(x), children: ` ${x.words}` })] : [Text({ key: `w${i}`, ...wordLook(x), children: x.words })]),
  ]
  const drawn = (x: Item, i: number): Any => (x.press
    ? Button({ key: `bar-${x.id}`, plain: true, label: `${x.key ? `${x.key} ` : ''}${x.words}`, onPress: x.press, children: words(x, i) })
    : Text({ key: `bar-${x.id}`, children: words(x, i) }))
  const joined = (xs: Item[], at: number): Any[] => xs.flatMap((x, i) => [...(i ? [Text({ key: `s${at + i}`, dimColor: true, children: ' · ' })] : []), drawn(x, at + i)])

  const name = Text({ key: 'name', color: NAME_COLOR, bold: true, children: 'thimble' })
  const label = presses ? Button({ key: 'bar-thimble', plain: true, label: 'thimble settings', onPress: presses.settings, children: [name] }) : name
  const bar = Box({ key: 'bar', flexDirection: 'row', justifyContent: 'space-between', width, ...(preview ? { flexWrap: 'wrap' } : {}), children: [
    Box({ key: 'bar-left', flexDirection: 'row', flexShrink: 1, children: [label, ...(left.length ? [Text({ key: 'gap', children: '  ' }), ...joined(left, 0)] : [])] }),
    ...(right.length ? [Box({ key: 'bar-right', flexDirection: 'row', flexShrink: 0, children: joined(right, left.length) })] : []),
  ] })
  return [...(preview ? [] : await lineRows($, els, width)), ...(preview ? [] : await fixLineRows($, els, width).catch(() => [])), bar]
}

/** The failure line: what failed, whole, in red, or a notice. */
async function lineRows($: Engine, els: Any, width: number): Promise<Any[]> {
  const { Box, Text } = els
  const fail = await failLineNow($)
  if (!fail) return []
  const text = fail.kind === 'failed'
    ? Text({ key: 'fail-text', color: 'error', wrap: 'wrap', children: `× ${fail.text.replace(/^[×!]\s*/, '')}` })
    : Text({ key: 'fail-text', color: 'warning', wrap: 'wrap', children: fail.text })
  return [Box({ key: 'fail-line', flexDirection: 'row', flexWrap: 'wrap', width, children: [text] })]
}
