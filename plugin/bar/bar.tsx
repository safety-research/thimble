// bar.tsx: the bar, thimble's line above the prompt, as one drawing. Its rows, top down:
//
//   the failure line  only while there is one (bar/fix.ts failLineNow): a failure in red with `f fix this · F report
//                  only`, or a notice. It wraps, so the whole failure shows
//   the fix line   only while the person's thimble has a fix (bar/fix.ts fixLineNow), with `p submit · u undo`
//   the bar        `thimble` (a click opens the settings), the step thimble works on now (busy.ts), `v card` while
//                  Cards is on, an answer exists and no design runs; at its right `r coverage 43% (3/7 files)` and
//                  `l 2 labels` while Labels and coverage is on (a click or the key opens the pane; register.ts says how
//                  each closes)
//
// The settings pane draws the same bar as its switches would leave it (`preview`): nothing in it is a press and no
// work shows. Card keys are never named here: a focused card names its own keys under its frame.
import type { EngineInterface } from 'claude-code'

import { textWidth } from '../core/text.js'
import { vReady } from '../designer/v'
import { featureOn } from '../settings/features.mjs'
import { busyNow } from './busy'
import { countsNow, needCounts } from './counts'
import { fixLineNow, pressFix } from './fix'
import { failLineNow } from './notice'
import { FAIL_KEYS, USE_KEYS } from './fixask.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The colors of the bar: thimble's name, and a key the person can press. Theme keys, so light and dark both read. */
const NAME_COLOR = 'permission'
const KEY_COLOR = 'suggestion'


/** What a press on a part of the bar does; register.ts gives them, so this module draws and decides nothing else. */
export type BarPresses = { settings: () => unknown; pane: (kind: 'coverage' | 'labels') => unknown }

/** One item of the bar: an optional key and its words, and the press that does what the key does. */
type Item = { id: string; key?: string; words: string; glyph?: string; press?: () => unknown }

const len = textWidth
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

/** The bar's items at its left, after `thimble`: the busy step, then v. */
async function leftItems($: Engine, on: (key: string) => boolean, preview: boolean): Promise<Item[]> {
  const out: Item[] = []
  const b = preview ? null : await busyNow($)
  if (b) out.push({ id: 'busy', glyph: b.glyph, words: [`${b.word}${b.secs != null ? ` ${b.secs}s` : ''}`, ...b.more].join(' · ') })
  if (on('cards') && (preview || (await vReady($)))) out.push({ id: 'v', key: 'v', words: 'card' })
  return out
}

/** The keys the bar names now (r and l act only while they show). */
export async function barKeys($: Engine): Promise<Set<string>> {
  return new Set((await countItems($, featureOn, null)).map(x => x.key!).filter(Boolean))
}

/** The bar's rows: the fix line (when there is one) and the bar, `width` cells wide. */
export async function barRows($: Engine, els: Any, width: number, o: { on?: (key: string) => boolean; presses?: BarPresses; preview?: boolean } = {}): Promise<Any[]> {
  const { Box, Button, Text } = els
  const on = o.on ?? featureOn
  const preview = !!o.preview
  const presses = preview ? null : o.presses ?? null
  if (!preview) needCounts($)
  const left = await leftItems($, on, preview)
  let right = await countItems($, on, presses, preview)
  // a narrow bar: the labels' count goes first, then coverage's file counts, then coverage. The preview shows every
  // item the switches leave on, its right part on a line of its own when it does not fit
  const room = () => width - 9 - left.reduce((n, x) => n + itemLen(x) + 3, 0) - right.reduce((n, x) => n + itemLen(x) + 3, 0)
  if (!preview && room() < 0) right = right.filter(x => x.id !== 'labels')
  if (!preview && room() < 0) right = right.map(x => (x.id === 'coverage' ? { ...x, words: x.words.replace(/ \(.*\)$/, '') } : x))
  if (!preview && room() < 0) right = []

  const words = (x: Item, i: number): Any[] => [
    ...(x.glyph ? [Text({ key: `g${i}`, color: NAME_COLOR, children: `${x.glyph} ` })] : []),
    ...(x.key ? [Text({ key: `k${i}`, color: KEY_COLOR, bold: true, children: x.key }), Text({ key: `w${i}`, dimColor: true, children: ` ${x.words}` })] : [Text({ key: `w${i}`, dimColor: true, children: x.words })]),
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
  return [...(preview ? [] : await lineRows($, els, width)), bar]
}

/** The failure line and the fix line: what failed or what changed, whole, then its keys, each a press that does what
 *  the key does. */
async function lineRows($: Engine, els: Any, width: number): Promise<Any[]> {
  const { Box, Button, Text } = els
  const fail = await failLineNow($)
  const fix = await fixLineNow($)
  const keys = (spec: string) => spec.split(' · ').flatMap((seg, i) => {
    const [k, ...rest] = seg.split(' ')
    const what = { f: 'fix', F: 'report', p: 'share', u: 'undo' }[k!] as 'fix' | 'report' | 'share' | 'undo'
    return [
      ...(i ? [Text({ key: `fs${i}`, dimColor: true, children: ' · ' })] : []),
      Button({ key: `fix-${what}`, plain: true, label: seg, onPress: () => pressFix($, what), children: [Text({ key: `fk${i}`, color: KEY_COLOR, bold: true, children: k }), Text({ key: `fw${i}`, dimColor: true, children: ` ${rest.join(' ')}` })] }),
    ]
  })
  const row = (key: string, text: Any, spec: string | null) => Box({ key, flexDirection: 'row', flexWrap: 'wrap', width, children: [text, ...(spec ? [Text({ key: `${key}-gap`, children: '   ' }), ...keys(spec)] : [])] })
  const out: Any[] = []
  if (fail?.kind === 'failed') out.push(row('fail-line', Text({ key: 'fail-text', color: 'error', wrap: 'wrap', children: `× ${fail.text.replace(/^[×!]\s*/, '')}` }), FAIL_KEYS))
  else if (fail) out.push(row('fail-line', Text({ key: 'fail-text', color: 'warning', wrap: 'wrap', children: fail.text }), null))
  if (fix) out.push(row('fix-line', Text({ key: 'fix-text', color: 'success', wrap: 'wrap', children: `✓ Your thimble has the fix: ${fix.title}` }), USE_KEYS))
  return out
}
