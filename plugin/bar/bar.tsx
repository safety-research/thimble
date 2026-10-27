// bar.tsx: the bar, thimble's line above the prompt, as one drawing. Its rows, top down:
//
//   the failure line  only while there is one (bar/notice.ts failLineNow): a failure in red, or a notice. It wraps, so
//                  the whole failure shows. A hint stands here only when the bar has no room for it whole (`Hint: …`)
//   the fix line   only while there is one (fix/line.ts): a fix that is ready (y use it now · d what changed · n
//                  later), on (u undo), off, failed, or a request with no code
//   the bar        `thimble` (a click opens the settings), the step thimble works on now (busy.ts), the keys of the
//                  card that takes them now (cards/draw.ts cardKeyWords: `j down · k up`), `v card` while
//                  Cards is on, an answer exists and no design runs, then the items of the features that act on answers
//                  (core/answerview.ts barLeft: a label run's ask, the tray's steps, `s squeeze`, `c cite`); at its
//                  right their items (barRight: `w 11 claims`, `t 2 threads`), then `r coverage 43% (3/7 files)` and `l 2 labels` while
//                  Coverage and Labels are on, each by its own setting (a click or the key opens the pane; register.ts says how each closes).
//                  While a hint shows (bar/notice.ts hintNow, or the first session's, bar/intro.ts), `Hint: …` stands
//                  in place of the left's keys, after the busy step, while it fits there whole; the right stays, so a
//                  hint can point at it
//
// A bar too narrow for its items gives way in this order: the busy step's other steps, then its words (whole words,
// down to its glyph and seconds), then the labels' count, coverage's file counts and coverage. The keys stay: what
// still does not fit goes on more rows, each item whole, the right's items on a row of their own when beside the first
// row they would take no fewer rows. The settings pane draws the same bar as its switches would leave it
// (`preview`), on as many rows as its items take: nothing in it is a press, no work shows and nothing gives way.
import type { EngineInterface } from 'claude-code'

import { barLeft, barRight } from '../core/answerview'
import { quiet } from '../core/askcell.js'
import { cutWords, textWidth } from '../core/text.js'
import { accent } from '../core/theme'
import { cardKeyWords } from '../cards/draw'
import { vReady } from '../designer/v'
import { fixLineRows } from '../fix/line'
import { pressKey } from '../hooks/keys'
import { featureOn } from '../settings/features.mjs'
import { busyNow } from './busy'
import { countsNow, keptCounts } from './counts'
import { failLineNow, hintNow } from './notice'

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
const itemLen = (x: Item) => (x.glyph ? len(x.glyph) + 1 : 0) + (x.key ? len(x.key) + 1 : 0) + len(x.words)

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

/** The busy step as an item, its words in at most `room` cells: every step that runs, else the newest, else the
 *  newest's first whole words; at least its glyph and seconds. */
function busyItem(b: { glyph: string; word: string; secs: number | null; more: string[] }, room = Infinity): Item {
  const secs = b.secs != null ? `${b.secs}s` : ''
  const newest = [b.word, secs].filter(Boolean).join(' ')
  const all = [newest, ...b.more].join(' · ')
  if (len(all) <= room) return { id: 'busy', glyph: b.glyph, words: all }
  if (len(newest) <= room) return { id: 'busy', glyph: b.glyph, words: newest }
  let kept = ''
  for (const w of b.word.split(' ')) {
    const more = kept ? `${kept} ${w}` : w
    if (len(`${more}…`) + (secs ? len(secs) + 1 : 0) > room) break
    kept = more
  }
  return { id: 'busy', glyph: b.glyph, words: [kept ? `${kept}…` : '', secs].filter(Boolean).join(' ') }
}

/** Items in rows of whole items, ` · ` between them: the first row `first` cells wide, the others `rest`. An item wider
 *  than its row keeps the first of its words that fit. */
function fill(xs: Item[], first: number, rest: number): Item[][] {
  const rows: Item[][] = [[]]
  let used = 0
  for (const x of xs) {
    if (used && used + 3 + itemLen(x) > (rows.length === 1 ? first : rest)) { rows.push([]); used = 0 }
    const room = rows.length === 1 ? first : rest
    const fit = itemLen(x) > room ? { ...x, words: cutWords(x.words, len(x.words) - itemLen(x) + room) } : x
    used += (used ? 3 : 0) + itemLen(fit)
    rows[rows.length - 1]!.push(fit)
  }
  return rows
}

/** The bar's items at its left, after `thimble` and the busy step: v, then the features' items. */
async function leftItems($: Engine, on: (key: string) => boolean, preview: boolean): Promise<Item[]> {
  const out: Item[] = []
  const features = await barLeft($, on, preview)
  if (features.some(x => x.focus)) return features.filter(x => x.focus)
  // the keys of the card on screen that takes them, each a click that presses it
  if (!preview && on('cards')) {
    for (const k of await cardKeyWords($).catch(() => [])) out.push({ id: `card-key-${k.key}`, key: k.key, words: k.words, ...(k.key.length === 1 ? { press: () => pressKey($, k.key) } : {}) })
  }
  // a click on `v card` starts the designer fork as v does, in the ui.press hook that answers it (designer/v.ts)
  if (on('cards') && (preview || (await vReady($)))) out.push({ id: 'v', key: 'v', words: 'visualize', ...(preview ? {} : { press: () => undefined }) })
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

/** The bar's rows: the failure line (or a hint the bar has no room for) when there is one, and the bar, `width` cells
 *  wide, on as many rows as its items need. */
export async function barRows($: Engine, els: Any, width: number, o: { on?: (key: string) => boolean; presses?: BarPresses; preview?: boolean; intro?: string } = {}): Promise<Any[]> {
  const { Box, Button, Text } = els
  const on = o.on ?? featureOn
  const preview = !!o.preview
  const presses = preview ? null : o.presses ?? null
  const b = preview ? null : await busyNow($)
  const keys = await leftItems($, on, preview)
  let right = [...(await barRight($, on, preview)), ...(await countItems($, on, presses, preview))]
  // the presses of the bar's items by their words (`r coverage`), before any is cut: an item the failure line names
  // is a click there too
  const pressOf = new Map([...keys, ...right].filter(x => x.press && x.key).map(x => [`${x.key} ${x.words}`, x.press!] as const))
  // the cells the bar's first row has left as drawn: `thimble` and two cells, ` · ` between items, two cells between the
  // left and the right
  const lenOf = (xs: Item[]) => xs.reduce((n, x, i) => n + itemLen(x) + (i ? 3 : 0), 0)
  const spare = (l: Item[], r: Item[]) => width - 9 - lenOf(l) - (r.length ? lenOf(r) + 2 : 0)
  // a hint: in place of the left's keys, after the busy step, while it fits there whole beside what the bar keeps (the
  // busy step's glyph and seconds, the right's keys); an item it names (“a ask”) stays after it, on the right too.
  // Longer, it stands above the bar, and the bar keeps its keys
  const hint = preview ? null : ((await hintNow($).catch(() => null)) ?? o.intro ?? null)
  const named = (x: Item) => !!hint && !!x.key && hint.includes(`“${x.key} ${x.words}”`)
  const counted = (x: Item) => (x.id === 'coverage' || x.id === 'labels') && !named(x)
  const hinted: Item[] = hint ? [{ id: 'hint', glyph: 'Hint:', words: hint }, ...keys.filter(named)] : []
  const hintIn = !!hint && spare([...(b ? [busyItem(b, 0)] : []), ...hinted], right.filter(x => !counted(x))) >= 0
  const left = [...(b ? [busyItem(b)] : []), ...(hintIn ? hinted : keys)]
  if (!preview) {
    // a narrow bar: the busy step gives way first, down to its glyph and seconds, then the labels' count, coverage's file
    // counts and coverage; the busy step takes back the room left
    const least = b ? [busyItem(b, 0), ...left.slice(1)] : left
    if (spare(least, right) < 0) right = right.filter(x => x.id !== 'labels' || !counted(x))
    if (spare(least, right) < 0) right = right.map(x => (x.id === 'coverage' && counted(x) ? { ...x, words: x.words.replace(/ \(.*\)$/, '') } : x))
    if (spare(least, right) < 0) right = right.filter(x => x.id !== 'coverage' || !counted(x))
    if (b) left[0] = busyItem(b, len(least[0]!.words) + spare(least, right))
  }
  // what still does not fit takes more rows, each item whole: the left's in rows under its first item, beside the right's
  // on the first row, or, when that takes no fewer rows, with the right's on a row of their own under them
  const alone = fill(left, width - 9, width - 9)
  const room = width - 9 - lenOf(right) - 2
  const beside = !right.length ? alone : room >= Math.max(0, ...left.map(itemLen)) ? fill(left, room, width - 9) : null
  const under = right.length ? fill(right, width, width) : []
  const besideWins = !!beside && beside.length < alone.length + under.length
  const lines = besideWins ? beside! : alone
  const rightLines = besideWins ? [] : under

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
  let at = 0
  const bar = lines.map((xs, k) => {
    const row = Box({ key: k ? `bar-${k}` : 'bar', flexDirection: 'row', justifyContent: 'space-between', width, children: [
      Box({ key: 'bar-left', flexDirection: 'row', flexShrink: 1, children: [k ? Text({ key: 'indent', children: ' '.repeat(9) }) : label, ...(xs.length && !k ? [Text({ key: 'gap', children: '  ' })] : []), ...joined(xs, at)] }),
      ...(!k && besideWins ? [Box({ key: 'bar-right', flexDirection: 'row', flexShrink: 0, children: joined(right, left.length) })] : []),
    ] })
    at += xs.length
    return row
  })
  const below = rightLines.map((xs, k) => Box({ key: `bar-right-${k}`, flexDirection: 'row', justifyContent: 'flex-end', width, children: joined(xs, left.length) }))
  // a hint the bar has no room for: above it, whole, where the failure line stands (a hint and a failure never show
  // together)
  const hintRow = Box({ key: 'hint-line', flexDirection: 'row', width, children: [Text({ key: 'hint-text', wrap: 'wrap', children: [
    Text({ key: 'g', color: accent(), children: 'Hint: ' }), Text({ key: 'w', dimColor: true, children: hint }),
  ] })] })
  const top = preview ? [] : hint && !hintIn ? [hintRow] : await lineRows($, els, width, pressOf)
  // a fix's line keeps one blank row between it and the bar, so its keys do not read as the bar's
  const fixRows = preview ? [] : await fixLineRows($, els, width).catch(() => [])
  return [...top, ...fixRows, ...(fixRows.length ? [Text({ key: 'fix-gap', children: ' ' })] : []), ...bar, ...below]
}

/** The failure line: what failed, whole, in red, or a notice. A key it names (`Press x to try again`) is a click
 *  too, which presses that key as the prompt would take it (hooks/keys.ts pressKey); esc and the keys of a pane are
 *  not, as no click at the prompt can press them. An item of the bar it quotes (`click “r coverage”`) is a click that
 *  does what a click on that item does (`named`: the bar's presses by their words). */
async function lineRows($: Engine, els: Any, width: number, named: Map<string, () => unknown> = new Map()): Promise<Any[]> {
  const { Box, Button, Text } = els
  const fail = await failLineNow($)
  if (!fail || fail.hint !== undefined) return []
  const look = fail.kind === 'failed' ? { color: 'error' } : { color: 'warning' }
  const words = fail.kind === 'failed' ? `× ${fail.text.replace(/^[×!]\s*/, '')}` : fail.text
  const parts = pressedWords(words, named)
  if (!parts.some(p => p.key || p.press)) return [Box({ key: 'fail-line', flexDirection: 'row', flexWrap: 'wrap', width, children: [Text({ key: 'fail-text', ...look, wrap: 'wrap', children: words })] })]
  // with a key to press: wrapped here, word by word, so its press stands among the words (a Text holds no Button)
  const lines: Any[][] = [[]]
  let used = 0
  parts.forEach((p, i) => {
    const pieces = p.key || p.press ? [p.s] : p.s.split(/(?<= )/)
    pieces.forEach((w, j) => {
      if (used && used + len(w.trimEnd()) > width) { lines.push([]); used = 0 }
      if (!used && !p.key && !p.press) w = w.trimStart()
      if (!w) return
      used += len(w)
      lines[lines.length - 1]!.push(p.press
        ? Button({ key: `fail-item-${i}`, plain: true, label: p.s.replace(/[“”]/g, ''), hover: quiet(`fail-item-${i}`), onPress: p.press, children: [Text({ ...look, bold: true, underline: true, children: w })] })
        : p.key
        ? Button({ key: `fail-key-${i}`, plain: true, label: `press ${p.key}`, hover: quiet(`fail-key-${i}`), onPress: () => pressKey($, p.key!), children: [Text({ ...look, bold: true, underline: true, children: w })] })
        : Text({ key: `fail-w-${i}-${j}`, ...look, children: w }))
    })
  })
  const text = Box({ key: 'fail-text', flexDirection: 'column', children: lines.map((l, k) => Box({ key: `fail-row-${k}`, flexDirection: 'row', children: l })) })
  return [Box({ key: 'fail-line', flexDirection: 'row', width, children: [text] })]
}

/** A line's words cut at each item of the bar it quotes (“r coverage”, a press in `named`, or an item whose words
 *  begin with the quote) and at each key it tells the person to press (keyedWords). */
export function pressedWords(s: string, named: Map<string, () => unknown>): { s: string; key?: string; press?: () => unknown }[] {
  const out: { s: string; key?: string; press?: () => unknown }[] = []
  let at = 0
  for (const m of s.matchAll(/“([^”]+)”/g)) {
    const q = m[1]!
    const press = named.get(q) ?? [...named].find(([w]) => w.startsWith(`${q} `))?.[1]
    if (!press) continue
    if (m.index! > at) out.push(...keyedWords(s.slice(at, m.index)))
    out.push({ s: m[0], press })
    at = m.index! + m[0].length
  }
  if (at < s.length) out.push(...keyedWords(s.slice(at)))
  return out
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
