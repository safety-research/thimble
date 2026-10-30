// bar.tsx: the bar, thimble's line above the prompt, as one drawing. Its rows, top down:
//
//   the failure line  only while there is one (bar/notice.ts failLineNow): a failure in red, or a notice. It wraps, so
//                  the whole failure shows. A hint stands here only when the bar has no room for it whole (`Hint: …`)
//   the fix line   only while there is one (fix/line.ts): a fix that is ready (y use it now · d what changed · n
//                  later), on (u undo), off, failed, or a request with no code
//   the bar        `thimble` (a click opens the settings), the step thimble works on now (busy.ts), the keys of the
//                  card that takes them now (cards/draw.ts cardKeyWords: `j down · k up`), `v card` while
//                  Cards is on, an answer exists and no design runs, then the items of the features that act on answers
//                  (core/answerview.ts barLeft: a label run's ask, the tray's steps, or at rest `] show explainer` while
//                  the answer shows marks, the mark's name in its own look, `s squeeze`, `c cite`); at its
//                  right their items (barRight: `w 11 claims`, `t 2 threads`), then `r coverage 43% (3/7 files)` and `l 2 labels` while
//                  Coverage and Labels are on, each by its own setting (a click or the key opens the pane; register.ts says how each closes).
//                  While a hint shows (bar/notice.ts hintNow, or the first session's, bar/intro.ts), `Hint: …` stands
//                  in place of the left's keys, after the busy step, while it fits there whole; the right stays, so a
//                  hint can point at it
//
// A bar too narrow for its items gives way in this order: the busy step's other steps, then coverage's file counts,
// then the words of an item that has shorter ones down to the longest of those (`] show explainer` to `] explainer`),
// then the busy step's words (whole words, down to its glyph and seconds), then the item's shorter words (`]` alone),
// and only then a whole count: the labels', then coverage. So the words that say what a sign means stay longest: the
// name of the mark ] opens, in that mark's look, and the busy step's words beside its glyph, which also turns after a
// citation being checked. What gave way takes back the room left in the reverse order. The keys stay:
// what still does not fit goes on more rows, each item whole, the right's items on a row of their own when beside the
// first row they would take no fewer rows. The settings pane draws the same bar as
// its switches would leave it (`preview`), on as many rows as its items take: nothing in it is a press, no work shows
// and nothing gives way.
import type { EngineInterface } from 'claude-code'

import { barLeft, barRight, heldKeys, keyFree, unlettered } from '../core/answerview'
import { quiet } from '../core/askcell.js'
import { controlWords } from '../core/selection'
import { cutWords, partsAround, textWidth } from '../core/text.js'
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
 *  what holds the keys now (a card ] reached), or what the prompt box asks for (`rewrite for…`); while any shows, the
 *  bar's left names only those, after the busy step. (The open tray's keys are in its header and the open chips' in the
 *  chips, so the bar leaves those keys out: core/answerview.ts heldKeys.) `color` and `bold`: words drawn lit (`s ●
 *  short`) or as a failure, not dim. `shorter`: the words in fewer cells, longest first, which a narrow bar draws after
 *  coverage's file counts gave way: the first of them it keeps longer than the busy step's words, and before any count
 *  gives way (the order at the top of this file); '' is the key alone, drawn as the bar's other keys are (in the item's
 *  color when it has one), never dim, as a dim key reads as one that does nothing. `marked`: words of it drawn in a look
 *  of their own wherever they stand in the words shown (the kind of mark ] opens, in that mark's look: `] show
 *  explainer`, explainer on the explainers' teal). */
type Item = { id: string; key?: string; words: string; shorter?: string[]; glyph?: string; press?: () => unknown; focus?: boolean; color?: string; bold?: boolean; marked?: { words: string; look: Record<string, unknown> } }
/** An item a feature puts on the bar (core/answerview.ts barLeft, barRight). */
export type BarItem = Item

const len = textWidth
/** How an item's words are drawn: dim, or in the item's own color. */
const wordLook = (x: Item) => (x.color ? { color: x.color, ...(x.bold ? { bold: true } : {}) } : { dimColor: true, ...(x.bold ? { bold: true } : {}) })
/** How an item's key is drawn: in thimble's color, bold; a key alone in the item's color when it has one. */
function keyLook(x: Item) {
  return { color: !x.words && x.color ? x.color : accent(), bold: true }
}
const itemLen = (x: Item) => (x.glyph ? len(x.glyph) + 1 : 0) + (x.key ? len(x.key) + (x.words ? 1 : 0) : 0) + len(x.words)
/** The item in its shortest words. */
const shortest = (x: Item): Item => (x.shorter?.length ? { ...x, words: x.shorter[x.shorter.length - 1]! } : x)

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

/** The bar's items at its left, after `thimble` and the busy step: v, then the features' items; each while what holds
 *  the keys (`held`: core/answerview.ts heldKeys) does not take its key. */
async function leftItems($: Engine, on: (key: string) => boolean, preview: boolean, held: Set<string>): Promise<Item[]> {
  const out: Item[] = []
  const features = await barLeft($, on, preview, held)
  if (features.some(x => x.focus)) return features.filter(x => x.focus)
  const free = keyFree(held)
  // the keys of the card on screen that takes them, each a click that presses it: those that reach it, as what holds
  // the keys takes the others (a fix's line its y d n)
  if (!preview && on('cards')) {
    for (const k of await cardKeyWords($).catch(() => [])) {
      const keys = k.key.split(' ').filter(x => free({ key: x })).join(' ')
      if (keys) out.push({ id: `card-key-${k.key}`, key: keys, words: k.words, ...(keys.length === 1 ? { press: () => pressKey($, keys) } : {}) })
    }
  }
  // a click on `v card` starts the designer fork as v does, in the ui.press hook that answers it (designer/v.ts)
  if (on('cards') && (preview || (await vReady($))) && free({ key: 'v' })) out.push({ id: 'v', key: 'v', words: 'visualize', ...(preview ? {} : { press: () => undefined }) })
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
  // the keys what holds them takes now, which the bar leaves to it: each key shows once, where it acts
  const held = preview ? new Set<string>() : await heldKeys($)
  const keys = await leftItems($, on, preview, held)
  // at the right what holds for the whole session: an item whose key what holds the keys takes stays, without its letter
  let right = [...(await barRight($, on, preview, held)), ...(await countItems($, on, presses, preview)).map(unlettered(held))]
  // the presses of the bar's items by their words (`r coverage`), before any is cut: an item the failure line names
  // is a click there too
  const pressOf = new Map([...keys, ...right].filter(x => x.press && x.key).map(x => [`${x.key} ${x.words}`, x.press!] as const))
  // its items' words, which a double click on one selects: no answer's words (core/selection.ts)
  if (!preview) controlWords('bar', ['thimble', ...[...keys, ...right].flatMap(x => [x.words, ...(x.key ? [`${x.key} ${x.words}`] : [])])])
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
  const whole = [...(b ? [busyItem(b)] : []), ...(hintIn ? hinted : keys)]
  let left = whole
  if (!preview) {
    // a narrow bar, in the order at the top of this file: from the least it can draw (the busy step's glyph and seconds,
    // each item's shortest words, coverage without its file counts), a whole count gives way while it is still too
    // wide: the labels', then coverage. A count that went comes back when it fits on its own, except beside a hint, which
    // the counts give way to: the labels' count is shorter, so it can fit where coverage does not. Then what gave way
    // takes back the room left, the words that say what a sign means first: the mark ] opens (`] explainer`: the bar's
    // one sign of what the marks' looks are), the busy step's words (`checking 3 citations`: what the glyph that turns
    // after a citation means), the rest of the item's words (`] show explainer`), coverage's file counts (beside
    // coverage alone), then the busy step's other steps
    const least = whole.map((x, i) => (b && !i ? busyItem(b, 0) : shortest(x)))
    const all = right
    const bare = (x: Item) => (x.id === 'coverage' && counted(x) ? { ...x, words: x.words.replace(/ \(.*\)$/, '') } : x)
    right = right.map(bare)
    if (spare(least, right) < 0) right = right.filter(x => x.id !== 'labels' || !counted(x))
    if (spare(least, right) < 0) right = right.filter(x => x.id !== 'coverage' || !counted(x))
    for (const id of hintIn ? [] : ['coverage', 'labels']) {
      if (right.some(x => x.id === id) || !all.some(x => x.id === id && counted(x))) continue
      const tried = all.filter(x => x.id === id || right.some(y => y.id === x.id)).map(x => (x.id === id ? bare(x) : right.find(y => y.id === x.id)!))
      if (spare(least, tried) >= 0) right = tried
    }
    left = [...least]
    // each item that has shorter words: the longest of `tried` that fits in the room left
    const takeWords = (tried: (x: Item) => string[]) => whole.forEach((x, i) => {
      if (!x.shorter?.length) return
      const room = itemLen(left[i]!) + spare(left, right)
      const fits = tried(x).find(w => itemLen({ ...x, words: w }) <= room)
      if (fits !== undefined) left[i] = { ...x, words: fits }
    })
    // the busy step's words in the room left: its newest step's alone (`alone`), or with its other steps
    const takeBusy = (alone: boolean) => { if (b) left[0] = busyItem(alone ? { ...b, more: [] } : b, len(left[0]!.words) + spare(left, right)) }
    takeWords(x => x.shorter!)
    takeBusy(true)
    takeWords(x => [x.words])
    const back = right.map(x => all.find(y => y.id === x.id) ?? x)
    if (spare(left, back) >= 0) right = back
    takeBusy(false)
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

  // an item's words in its words' look, its marked words in their own
  const said = (x: Item, i: number, s: string): Any[] => partsAround(s, x.marked?.words).map((p: { s: string; marked: boolean }, j: number) =>
    Text({ key: j ? `w${i}-${j}` : `w${i}`, ...(p.marked ? x.marked!.look : wordLook(x)), children: p.s }))
  const words = (x: Item, i: number): Any[] => [
    ...(x.glyph ? [Text({ key: `g${i}`, color: accent(), children: `${x.glyph} ` })] : []),
    ...(x.key
      ? [Text({ key: `k${i}`, ...keyLook(x), children: x.key }), ...(x.words ? said(x, i, ` ${x.words}`) : [])]
      : said(x, i, x.words)),
  ]
  const drawn = (x: Item, i: number): Any => (x.press
    ? Button({ key: `bar-${x.id}`, plain: true, label: [x.key, x.words].filter(Boolean).join(' '), onPress: x.press, children: words(x, i) })
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
  const top = preview ? [] : hint && !hintIn ? [hintRow] : await lineRows($, els, width, pressOf, held)
  // a fix's line keeps one blank row between it and the bar, so its keys do not read as the bar's
  const fixRows = preview ? [] : await fixLineRows($, els, width).catch(() => [])
  return [...top, ...fixRows, ...(fixRows.length ? [Text({ key: 'fix-gap', children: ' ' })] : []), ...bar, ...below]
}

/** The failure line: what failed, whole, in red, or a notice. A key it names (`Press x to try again`) is a click
 *  too, which presses that key as the prompt would take it (hooks/keys.ts pressKey); esc and the keys of a pane are
 *  not, as no click at the prompt can press them. While what holds the keys names that key where it acts (`held`,
 *  core/answerview.ts heldKeys: the open tray's `x repair`), the sentence that says to press it is left out, so each
 *  key shows once (untold). An item of the bar it quotes (`click “r coverage”`) is a click that does what a click on
 *  that item does (`named`: the bar's presses by their words). */
async function lineRows($: Engine, els: Any, width: number, named: Map<string, () => unknown> = new Map(), held: Set<string> = new Set()): Promise<Any[]> {
  const { Box, Button, Text } = els
  const fail = await failLineNow($)
  if (!fail || fail.hint !== undefined) return []
  const look = fail.kind === 'failed' ? { color: 'error' } : { color: 'warning' }
  const said = untold(fail.text, held)
  const words = fail.kind === 'failed' ? `× ${said.replace(/^[×!]\s*/, '')}` : said
  const parts = pressedWords(words, named)
  if (!parts.some(p => p.key || p.press)) return [Box({ key: 'fail-line', flexDirection: 'row', flexWrap: 'wrap', width, children: [Text({ key: 'fail-text', ...look, wrap: 'wrap', children: words })] })]
  // with a key to press: wrapped here, word by word, so its press stands among the words (a Text holds no Button)
  const rows = wordRows(parts, width)
  const text = Box({ key: 'fail-text', flexDirection: 'column', children: rows.map((l, k) => Box({ key: `fail-row-${k}`, flexDirection: 'row', children: l.map(({ w, p, i, j }) => (p.press
    ? Button({ key: `fail-item-${i}`, plain: true, label: p.s.replace(/[“”]/g, ''), hover: quiet(`fail-item-${i}`), onPress: p.press, children: [Text({ ...look, bold: true, underline: true, children: w })] })
    : p.key
    ? Button({ key: `fail-key-${i}`, plain: true, label: `press ${p.key}`, hover: quiet(`fail-key-${i}`), onPress: () => pressKey($, p.key!), children: [Text({ ...look, bold: true, underline: true, children: w })] })
    : Text({ key: `fail-w-${i}-${j}`, ...look, children: w }))) })) })
  return [Box({ key: 'fail-line', flexDirection: 'row', width, children: [text] })]
}

/** A failure line's words less each sentence that tells the person to press a key what holds the keys names where it
 *  acts now (`held`, a key of its own, not '*'): that place says it already. A line that is all such sentences stays
 *  whole. */
export function untold(text: string, held: Set<string>): string {
  const sentences = text.split(/(?<=[.!?])\s+(?=\S)/)
  const kept = sentences.filter(s => !keyedWords(s).some(p => p.key && held.has(p.key)))
  return kept.length && kept.length < sentences.length ? kept.join(' ') : text
}

/** A line's parts (pressedWords) on rows of at most `width` cells, each row its words in order (`w`, the words of part
 *  `i`, piece `j`). A row breaks between words, and the space before the break is not drawn, so no row is wider than
 *  `width`: a row a cell too wide would shrink one of its words, which then wraps onto a blank row of its own and
 *  leaves no space before the next. A word wider than a row is cut where each row ends; a press stays whole. */
export function wordRows<P extends { s: string; key?: string; press?: unknown }>(parts: P[], width: number): { w: string; p: P; i: number; j: number }[][] {
  const rows: { w: string; p: P; i: number; j: number }[][] = [[]]
  let used = 0
  parts.forEach((p, i) => {
    const whole = !!(p.key || p.press)
    // the words of a line: one paragraph, its spaces and breaks one space each
    const pieces = whole ? [p.s] : p.s.replace(/\s+/g, ' ').split(/(?<= )/).flatMap(w => cutWide(w, width))
    pieces.forEach((piece, j) => {
      let w = piece
      if (used && used + len(w.trimEnd()) > width) { rows.push([]); used = 0 }
      if (!used && !whole) w = w.trimStart()
      if (!w) return
      used += len(w)
      rows[rows.length - 1]!.push({ w, p, i, j })
    })
  })
  for (const row of rows) {
    const last = row[row.length - 1]
    if (last && !(last.p.key || last.p.press)) last.w = last.w.trimEnd()
  }
  return rows.map(row => row.filter(x => x.w)).filter(row => row.length)
}

/** A word (and the space after it) in pieces of at most `width` cells: the word whole when it fits a row. */
function cutWide(w: string, width: number): string[] {
  if (len(w.trimEnd()) <= width) return [w]
  const out: string[] = []
  let cur = ''
  for (const ch of w) {
    if (cur && len(cur + ch) > width) { out.push(cur); cur = '' }
    cur += ch
  }
  return cur ? [...out, cur] : out
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
