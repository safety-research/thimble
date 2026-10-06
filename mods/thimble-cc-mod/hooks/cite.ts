// Citations as the analyst sees them (no `$`), shared by the hooks module, para.tsx and the tests.
//
// - Display: every citation is a link, blue and underlined; red when the value is not at the cited place or the place
//   does not exist. A spinner follows a citation while a fix round or its verification works on it; then ✓ when its
//   verification recomputed the value, or × (and red) when the verification failed (another value, a crash, no script
//   written) or the fix round could not correct it. The model's Markdown is drawn as Claude Code draws it: bold bold,
//   italic italic, inline code in the code colour, a heading bold.
// - Layout: a reply's paragraph or table wrapped to its width, a citation's shown value whole and wrapping like the
//   words around it, with where each citation, word and table row lands, so a pointer finds what it is over.
// - Fix rounds: the sentences a forked subagent is asked to rewrite, its answer read, and each corrected sentence put
//   in place of the old one, unmarked.
// - Marks: each answer's footer rows and each citation's fix and verification, as the file that keeps them across a
//   resume.
// - Streaming: a reply's text as the engine shows it while it streams, citations as links and card lines as
//   placeholders, before the mod draws the finished block.
import type { ChatCorrection, ChatEnd, ChatFix, ChatFixItem, ChatVerify } from '../types'
import { cut, lineWidth, width } from './draw'
import type { Line, Seg } from './draw'
import { EMBED_RE, chipLabel, cid, citations, citeEnd, citeSpans, parseReply, shownMatches, valueIn } from './lib'
import type { Citation, Run, TableRuns } from './lib'
import { COLORS } from './paint'

/** `link` for every citation without a problem (checked, unchecked or not checked yet); `problem` when the value is
 *  not at the place or the place does not exist; `fixing` while a fix round runs on it; `failed` when the fix round
 *  could not correct it or its verification failed (another value, a crash, no script). */
export type ChipState = 'link' | 'problem' | 'fixing' | 'failed'
/** `mark` is ✓ (a script recomputed the value), × (failed) or nothing; `spin` while a fix round or a verification works
 *  on the citation, drawn as ◌. */
export type ChipView = { label: string; state: ChipState; mark: string; spin: boolean; tip: string }

/** What a citation's link says: its shown value whole, or a short name of the place for one without a value. */
export function citeLabel(c: Citation): string {
  return c.display ?? chipLabel(c)
}

/** The glyph of a citation being worked on: running (views/SPEC.md, "The visual system", section 5). */
export const SPIN = '◌'

/** A verification that failed: its script recomputed another value, crashed, printed no result, or was never written. */
export function verifyFailed(verify: string | undefined): boolean {
  return verify === 'refuted' || verify === 'error' || verify === 'missing'
}

/** How a citation is drawn, from the resolver's status, its fix round's state and its verification's state. */
export function chipState(status: string | undefined, fix: string | undefined, verify?: string): ChipState {
  if (fix === 'fixing') return 'fixing'
  if (verifyFailed(verify)) return 'failed'
  if (status !== 'missing' && status !== 'differs') return 'link'
  return fix === 'failed' ? 'failed' : 'problem'
}

/** A verification is working while its subagent writes the script or the mod runs it. */
export function verifying(verify: string | undefined): boolean {
  return verify === 'asked' || verify === 'running'
}

/** The state, mark and spinner of a citation. */
export function chipLook(status: string | undefined, fix: string | undefined, verify: string | undefined): Pick<ChipView, 'state' | 'mark' | 'spin'> {
  const state = chipState(status, fix, verify)
  const spin = state === 'fixing' || verifying(verify)
  const mark = spin ? '' : state === 'failed' ? '×' : state === 'link' && verify === 'verified' ? '✓' : ''
  return { state, mark, spin }
}

/** A citation as styled segments: its label blue and underlined (red with a problem), in inverse under the pointer, so
 *  its blue becomes the background; then ◌ while it is worked on or its mark: ✓ in the text colour, × in red. */
export function chipSegs(c: ChipView, hover: boolean, _frame = 0): Seg[] {
  const segs: Seg[] = [{ s: c.label, fg: c.state === 'link' ? COLORS.link : COLORS.problem, u: true, ...(hover ? { inv: true } : {}) }]
  if (c.spin) segs.push({ s: ` ${SPIN}`, ...(c.state === 'link' ? {} : { fg: COLORS.problem }) })
  else if (c.mark) segs.push({ s: c.mark, ...(c.mark === '✓' ? {} : { fg: COLORS.problem }) })
  return segs
}

// ---------------------------------------------------------------------------------------- what a verification compares

const NUMBER_RE = /^[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/

/** Whether a citation's words are a value its place can show, a number or a quote, as the resolver (refs.py) reads
 *  them. Other words, as in [[its revisions|revisions.jsonl#L5603-L5625]], name the place and show no value. */
export function showsValue(display: string | null): boolean {
  return display !== null && (NUMBER_RE.test(display.trim()) || quotedWords(display) !== '')
}

/** The place a file citation names after its "#" (L5603-L5625, row=12, a JSON pointer, table/key), or '' for a whole
 *  file, a card or a call: what a verification of words that show no value recomputes. */
export function citedPlace(ref: string | undefined): string {
  if (!ref || /^(?:card|call):/.test(ref)) return ''
  const hash = ref.indexOf('#')
  return hash < 0 ? '' : ref.slice(hash + 1).trim()
}

const PLACE_LINES = /^L(\d+)(?:-L?(\d+))?$/

/** Whether a script's RESULT names the place `ref` cites: the same lines (L5603-L5625, lines 5603-5625), the same
 *  row, or the place as the citation writes it. */
export function placeIn(ref: string | undefined, result: string): boolean {
  const place = citedPlace(ref)
  if (!place) return false
  const lines = PLACE_LINES.exec(place)
  if (lines) {
    const [a, b] = [Number(lines[1]), Number(lines[2] ?? lines[1])]
    return [...result.matchAll(/(?:\bL|\blines?\s+)(\d+)(?:\s*(?:-|–|to)\s*L?(\d+))?/gi)].some(m => Number(m[1]) === a && Number(m[2] ?? m[1]) === b)
  }
  const row = /^row=(\d+)$/.exec(place)
  if (row) return [...result.matchAll(/\brow\s*=?\s*(\d+)/gi)].some(m => m[1] === row[1])
  return result.includes(place)
}

/** Whether a verification's RESULT agrees with its citation: the value the words show, or for words that show no
 *  value, those words or the place the citation names. */
export function verifyMatches(expected: string | null, ref: string | undefined, result: string): boolean {
  if (expected === null) return true
  if (shownMatches(expected, result) || valueIn(expected, result)) return true
  return !showsValue(expected) && placeIn(ref, result)
}

/** What a verification compared its RESULT with, in words: the value the citation shows, or the place its words name. */
export function citedAs(expected: string | null, ref: string | undefined): string {
  if (expected === null) return ''
  return showsValue(expected) || !citedPlace(ref) ? expected : citedPlace(ref)
}

/** What a verification script is asked to do for a citation: recompute the value its words show, or, for words that
 *  name a place, find the records that show the sentence's claim and print their place, which the mod compares. */
export function scriptAim(display: string, ref: string): string {
  const place = citedPlace(ref)
  if (showsValue(display) || !place) return `recomputes ${display} from the raw files`
  const form = PLACE_LINES.test(place) ? 'L<first>-L<last>' : /^row=\d+$/.test(place) ? 'row=<n>' : 'a citation writes it after "#"'
  return `finds in the raw files the records that show what the sentence claims and ends with \`RESULT: <their place>\`, written as ${form}`
}

// ---------------------------------------------------------------------------------------- layout

export type ChipSpan = { line: number; x0: number; x1: number; chip: number }
/** A word as laid out, and where it starts in the block's source (its text with each citation as written). */
export type WordSpan = { line: number; x0: number; x1: number; at: number }
/** `rows`: for a table, each line's row as source text ('' for the rule). */
export type ParaLayout = { lines: Line[]; spans: ChipSpan[]; words: WordSpan[]; source: string; rows?: string[] }

const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s.s), 0)

/** A word or a space of a flowing text. `chip` is the citation it belongs to (-1 for none); a citation's words wrap like
 *  any others, its mark or spinner stays with its last word. `at` is where a plain word starts in the source. */
type Tok = { segs: Seg[]; space: boolean; chip: number; at: number }

/** Runs as words and spaces, their citations numbered from `k0`; `bold` for a table's column names and a heading's
 *  words. The model's Markdown as Claude Code draws it: its bold bold, its italic italic, its inline code in the code
 *  colour, a link's words blue and underlined. */
function tokens(runs: Run[], chips: ChipView[], k0: number, hover: number, frame: number, bold: boolean): { toks: Tok[]; source: string; next: number } {
  const toks: Tok[] = []
  let source = ''
  let k = k0
  for (const r of runs) {
    if (r.cite) {
      const c: ChipView = chips[k] ?? { label: citeLabel(r.cite), state: 'link', mark: '', spin: false, tip: '' }
      const [label, ...after] = chipSegs(c, k === hover, frame)
      const parts = label!.s.split(/(\s+)/).filter(Boolean)
      parts.forEach((part, i) => {
        const space = /^\s+$/.test(part)
        const segs: Seg[] = [{ ...label!, s: space ? ' ' : part }]
        if (i === parts.length - 1) segs.push(...after)
        toks.push({ segs, space, chip: k, at: source.length })
      })
      source += r.cite.raw
      k++
      continue
    }
    let at = source.length
    for (const part of r.text.split(/(\s+)/)) {
      if (!part) continue
      const space = /^\s+$/.test(part)
      const style: Seg = { s: space ? ' ' : part }
      if (bold || r.b) style.b = true
      if (r.i) style.i = true
      if (r.code) style.fg = COLORS.code
      if (r.u) {
        style.fg = COLORS.link
        style.u = true
      }
      toks.push({ segs: [style], space, chip: -1, at })
      at += part.length
    }
    source += r.text
  }
  return { toks, source, next: k }
}

/** Words and spaces wrapped to `room` columns, x from 0: each citation's cells as spans, each plain word's place. A word
 *  longer than the line is cut into pieces. */
function flow(toks: Tok[], room: number): { lines: Line[]; spans: ChipSpan[]; words: WordSpan[] } {
  const lines: Line[] = []
  const spans: ChipSpan[] = []
  const words: WordSpan[] = []
  let cur: Line = []
  let used = 0
  const span = (x0: number, x1: number, chip: number) => {
    const last = spans.at(-1)
    if (last && last.chip === chip && last.line === lines.length && last.x1 === x0) last.x1 = x1
    else spans.push({ line: lines.length, x0, x1, chip })
  }
  const newLine = () => {
    while (cur.length && cur.at(-1)!.s === ' ') cur.pop()
    const last = spans.at(-1)
    if (last && last.line === lines.length) last.x1 = Math.min(last.x1, lineWidth(cur))
    lines.push(cur)
    cur = []
    used = 0
  }
  let glued = false // the token before was a word: no break before this one, unless its group is wider than a line
  let groupAt = 0
  toks.forEach((t, n) => {
    const w = segsWidth(t.segs)
    if (t.space) {
      glued = false
      if (used > 0 && used + 1 <= room) {
        cur.push(t.segs[0]!)
        if (t.chip >= 0) span(used, used + 1, t.chip)
        used += 1
      }
      return
    }
    if (!glued) {
      // a group of words with no space between ("[[value|ref]]," or "(value)") wraps whole
      let gw = 0
      for (let j = n; j < toks.length && !toks[j]!.space; j++) gw += segsWidth(toks[j]!.segs)
      if (used > 0 && used + gw > room) newLine()
      groupAt = used
    } else if (groupAt === 0 && used > 0 && used + w > room) newLine()
    glued = true
    const [seg, ...after] = t.segs
    let s = seg!.s
    let at = t.at
    while (width(s) > room) {
      const head = cut(s, room + 1).slice(0, -1) || [...s][0]!
      if (t.chip >= 0) span(used, used + width(head), t.chip)
      else words.push({ line: lines.length, x0: used, x1: used + width(head), at })
      cur.push({ ...seg!, s: head })
      newLine()
      s = s.slice(head.length)
      at += head.length
    }
    const piece: Seg[] = [{ ...seg!, s }, ...after]
    const pw = segsWidth(piece)
    if (t.chip >= 0) span(used, used + pw, t.chip)
    else words.push({ line: lines.length, x0: used, x1: used + width(s), at })
    cur.push(...piece)
    used += pw
  })
  if (cur.length || lines.length === 0) newLine()
  return { lines, spans, words }
}

/** A rich block wrapped to `cols`: words flow, a citation's words with them, each citation one link. */
export function paraLayout(
  block: { prefix: string; heading: number; quote: boolean; runs: Run[] },
  chips: ChipView[],
  cols: number,
  hover: number,
  frame = 0,
): ParaLayout {
  // a heading bold, as Claude Code draws every Markdown level; a quote 2 cells in, in italic
  const lead = block.quote ? '  ' : block.prefix
  const indent = block.quote ? '  ' : ' '.repeat(width(block.prefix))
  const room = Math.max(10, cols - width(lead))
  const { toks, source } = tokens(block.runs, chips, 0, hover, frame, block.heading > 0)
  if (block.quote) for (const t of toks) if (t.chip < 0) t.segs = t.segs.map(g => ({ ...g, i: true }))
  const f = flow(toks, room)
  const x0 = width(lead)
  return {
    lines: f.lines.map((l, i) => [{ s: i === 0 ? lead : indent }, ...l]),
    spans: f.spans.map(s => ({ ...s, x0: s.x0 + x0, x1: s.x1 + x0 })),
    words: f.words.map(w => ({ ...w, x0: w.x0 + x0, x1: w.x1 + x0 })),
    source,
  }
}

/** A table block in aligned columns, each citation one link: the column names bold, a rule in the rule grey under each as
 *  wide as its column, the rows right under it, as a card's table draws its header. Columns wider than `cols` allows are
 *  narrowed from the widest, and a cell's words (a citation's too) wrap within its column. */
export function mdTableLayout(table: TableRuns, chips: ChipView[], cols: number, hover: number, frame = 0): ParaLayout {
  const GAP = 2
  let k = 0
  const grid = table.rows.map((row, r) =>
    row.map(cell => {
      const t = tokens(cell, chips, k, hover, frame, r === 0)
      k = t.next
      return t.toks
    }),
  )
  const rowSource = table.rows.map(row => row.map(cell => cell.map(run => (run.cite ? run.cite.raw : run.text)).join('')).join(' | '))
  const ncol = Math.max(...grid.map(r => r.length))
  const natural = (toks: Tok[] | undefined) => lineWidth(flow(toks ?? [], 1e9).lines[0] ?? [])
  const w = Array.from({ length: ncol }, (_, c) => Math.max(1, ...grid.map(r => natural(r[c]))))
  const room = Math.max(ncol, cols - GAP * (ncol - 1))
  while (w.reduce((a, b) => a + b, 0) > room) {
    const widest = w.indexOf(Math.max(...w))
    if (w[widest]! <= 4) break
    w[widest]!--
  }
  const lines: Line[] = []
  const spans: ChipSpan[] = []
  const rows: string[] = []
  grid.forEach((row, r) => {
    const cells = Array.from({ length: ncol }, (_, c) => flow(row[c] ?? [], w[c]!))
    const height = Math.max(...cells.map(f => f.lines.length))
    for (let i = 0; i < height; i++) {
      const line: Line = []
      let x = 0
      for (let c = 0; c < ncol; c++) {
        const f = cells[c]!
        const part = f.lines[i] ?? []
        const fill = Math.max(0, w[c]! - lineWidth(part))
        const align = table.align[c] ?? 'left'
        const before = align === 'right' ? fill : align === 'center' ? Math.floor(fill / 2) : 0
        if (c > 0) {
          line.push({ s: ' '.repeat(GAP) })
          x += GAP
        }
        if (before) line.push({ s: ' '.repeat(before) })
        for (const s of f.spans) if (s.line === i) spans.push({ line: lines.length, x0: x + before + s.x0, x1: x + before + s.x1, chip: s.chip })
        line.push(...part)
        if (fill - before) line.push({ s: ' '.repeat(fill - before) })
        x += w[c]!
      }
      lines.push(line)
      rows.push(rowSource[r] ?? '')
    }
    // under the column names, a rule under each as wide as its column
    if (r === 0) {
      lines.push(w.flatMap((cw, c): Seg[] => [...(c > 0 ? [{ s: ' '.repeat(GAP) }] : []), { s: '─'.repeat(cw), fg: COLORS.rule }]))
      rows.push('')
    }
  })
  return { lines, spans, words: [], source: rowSource.join('\n'), rows }
}

/** A rich block's layout: a table's columns, or a paragraph's flowing words. */
export function blockLayout(
  block: { prefix: string; heading: number; quote: boolean; runs: Run[]; table?: TableRuns },
  chips: ChipView[],
  cols: number,
  hover: number,
  frame = 0,
): ParaLayout {
  return block.table ? mdTableLayout(block.table, chips, cols, hover, frame) : paraLayout(block, chips, cols, hover, frame)
}

/** The sentence of a source text around an offset, its citations as written. */
export function sentenceAt(source: string, at: number): string {
  const ends = /[.!?](?=\s|$)/g
  const spans = citeSpans(source)
  let start = 0
  let end = source.length
  for (const m of source.matchAll(ends)) {
    const i = (m.index ?? 0) + 1
    // a full stop inside a citation ([[3.5|x]]) is no sentence end
    if (spans.some(sp => sp.at < i && i < sp.end)) continue
    if (i <= at) start = i
    else {
      end = i
      break
    }
  }
  return source.slice(start, end).trim()
}

// ---------------------------------------------------------------------------------------- claims

/** A citation where it stands: its sentence (a table's row) in one answer. `key` names the state of what is checked
 *  about it (its fix, its verification), so the same citation in another sentence or answer is checked on its own. */
export type Claim = { key: string; c: Citation; sentence: string }

export function claimKey(answer: string, sentence: string, raw: string): string {
  return cid(`${answer}\n${sentence}\n${raw}`)
}

/** A rich block's claims, one per citation in the order its chips are numbered. */
export function blockClaims(block: { runs: Run[]; table?: TableRuns }, answer: string): Claim[] {
  const out: Claim[] = []
  const add = (c: Citation, sentence: string) => out.push({ key: claimKey(answer, sentence, c.raw), c, sentence })
  if (block.table) {
    for (const row of block.table.rows) {
      const source = row.map(cell => cell.map(r => (r.cite ? r.cite.raw : r.text)).join('')).join(' | ')
      for (const cell of row) for (const r of cell) if (r.cite) add(r.cite, source)
    }
    return out
  }
  let source = ''
  const at: { c: Citation; at: number }[] = []
  for (const r of block.runs) {
    if (r.cite) at.push({ c: r.cite, at: source.length })
    source += r.cite ? r.cite.raw : r.text
  }
  for (const x of at) add(x.c, sentenceAt(source, x.at))
  return out
}

/** A reply text's claims in reading order, each once. */
export function claimsIn(text: string, answer: string): Claim[] {
  const seen = new Set<string>()
  const out: Claim[] = []
  for (const b of parseReply(text)) {
    if (b.type !== 'rich') continue
    for (const cl of blockClaims(b, answer)) if (!seen.has(cl.key) && seen.add(cl.key)) out.push(cl)
  }
  return out
}

/** A text with each citation as its shown words, for a line the analyst reads where no link is drawn. */
export function plainCites(text: string): string {
  return citations(text).reduce((t, c) => t.replaceAll(c.raw, citeLabel(c)), text)
}

// ---------------------------------------------------------------------------------------- a cited record

const QUOTE_MARKS = '"\'“”‘’'

/** The words of a citation that quotes ([["a phrase"|ref]]), without their quote marks; '' for any other. */
export function quotedWords(display: string | null): string {
  const d = (display ?? '').trim()
  return d.length > 2 && QUOTE_MARKS.includes(d[0]!) && QUOTE_MARKS.includes(d.at(-1)!) ? d.slice(1, -1) : ''
}

/** A line of a cited place cut to `cap` characters for keeping, around its first span (the shown value or the quoted
 *  passage), the spans moved with it. */
export function capLine<T extends { text: string; spans?: number[][] }>(w: T, cap = 1200): T {
  if (w.text.length <= cap) return w
  const first = w.spans?.[0]
  const lo = first ? Math.max(0, Math.min(first[0]! - Math.floor(cap / 3), w.text.length - cap)) : 0
  const text = `${lo ? '…' : ''}${w.text.slice(lo, lo + cap)}${lo + cap < w.text.length ? '…' : ''}`
  const shift = lo - (lo ? 1 : 0)
  if (!w.spans) return { ...w, text }
  return { ...w, text, spans: w.spans.map(([a, b]) => [a! - shift, b! - shift]).filter(([a, b]) => a! >= 0 && b! <= text.length) }
}

/** Where a quoted passage stands in a record's line as written: as is, JSON-escaped, or its words apart by any
 *  whitespace or escaped line break; a quote whose inner quote marks are escaped also as unescaped. */
export function quoteSpan(line: string, quote: string): [number, number] | null {
  const escaped = (s: string) => JSON.stringify(s).slice(1, -1)
  const ascii = (s: string) => escaped(s).replace(/[\u0080-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const lit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const q = quote.trim()
  for (const quoted of new Set([q, q.replace(/\\(["'\\])/g, '$1')])) {
    if (!quoted) return null
    for (const form of [quoted, escaped(quoted), ascii(quoted)]) {
      const at = line.indexOf(form)
      if (at >= 0) return [at, at + form.length]
    }
    const words = quoted.split(/\s+/).map(w => `(?:${[...new Set([w, escaped(w), ascii(w)])].map(lit).join('|')})`)
    const m = new RegExp(words.join('(?:\\s|\\\\[nrt])+')).exec(line)
    if (m) return [m.index, m.index + m[0].length]
  }
  return null
}

/** A long line wrapped to `room` columns in at most `rows` rows, the rows around `span` when it does not fit; each row
 *  with the part of `span` it holds. */
export function wrapAround(text: string, span: [number, number] | null, room: number, rows: number): { text: string; hi: [number, number] | null }[] {
  const n = Math.max(1, room)
  const all: { at: number; text: string }[] = []
  for (let at = 0; at < text.length || all.length === 0; at += n) all.push({ at, text: text.slice(at, at + n) })
  let first = 0
  if (all.length > rows && span) first = Math.max(0, Math.min(all.length - rows, Math.floor(span[0] / n) - 1))
  return all.slice(first, first + rows).map((r, i, shown) => {
    const lo = span ? Math.max(span[0], r.at) - r.at : 0
    const hi = span ? Math.min(span[1], r.at + r.text.length) - r.at : 0
    const more = (i === 0 && first > 0 ? '…' : '') + r.text + (i === shown.length - 1 && first + rows < all.length ? '…' : '')
    const shift = i === 0 && first > 0 ? 1 : 0
    return { text: more, hi: span && hi > lo ? [lo + shift, hi + shift] : null }
  })
}

/** What a pointer at (x, y) of a layout is over, other than a citation: a table's row, or the sentence of the word
 *  there (the nearest word of the line, between words). */
export function passageAt(lay: ParaLayout, x: number, y: number): { kind: 'row' | 'sentence'; text: string } | null {
  if (lay.rows) {
    const text = lay.rows[y] ?? ''
    return text ? { kind: 'row', text } : null
  }
  const line = lay.words.filter(w => w.line === y)
  if (!line.length) return null
  const word = line.find(w => x >= w.x0 && x < w.x1) ?? line.reduce((a, b) => (Math.abs(b.x0 - x) < Math.abs(a.x0 - x) ? b : a))
  const text = sentenceAt(lay.source, word.at)
  return text ? { kind: 'sentence', text } : null
}

// ---------------------------------------------------------------------------------------- fix rounds

export type Problem = { cite: Citation; why: string } | { card: string; why: string }

/** The sentence of a text that holds a citation: within its line, without the line's Markdown lead (a list marker, a
 *  heading's #, a quote's >), so the sentence put in its place keeps the lead; a table's row whole. */
export function sentenceIn(text: string, raw: string): string {
  const at = text.indexOf(raw)
  if (at < 0) return ''
  const start = text.lastIndexOf('\n', at - 1) + 1
  const nl = text.indexOf('\n', at)
  const line = text.slice(start, nl < 0 ? undefined : nl)
  if (/^\s*\|/.test(line)) return line.trim()
  const lead = /^\s*(?:(?:[-*+]|\d+[.)]|#{1,6})\s+|>\s*)*/.exec(line)?.[0].length ?? 0
  return sentenceAt(line.slice(lead), at - start - lead)
}

/** The passages of a reply to correct: each problem citation's sentence (one item per sentence, however many of its
 *  citations fail), and each card that cannot be drawn by its embed line. */
export function fixItems(text: string, problems: Problem[]): ChatFixItem[] {
  const items: ChatFixItem[] = []
  for (const p of problems) {
    const old = 'card' in p ? `[[card:${p.card}]]` : sentenceIn(text, p.cite.raw) || p.cite.raw
    let it = items.find(x => x.old === old)
    if (!it) {
      it = { old, problems: [], cites: [] }
      items.push(it)
    }
    if ('card' in p) {
      it.card = p.card
      it.problems.push({ raw: old, why: p.why })
    } else {
      it.cites.push(p.cite.raw)
      it.problems.push({ raw: p.cite.raw, why: p.why })
    }
  }
  return items
}

/** What the fix round's forked subagent is asked: each passage and its problems, answered with each sentence
 *  rewritten whole, one line per passage. `thread`: the side thread's answer the passages are in, which the fork's
 *  conversation does not hold; absent for main's last reply. */
export function fixPrompt(items: ChatFixItem[], thread?: string): string {
  const whose = thread === undefined ? 'your last reply has' : "a side thread's answer, which the analyst reads in the panel, has"
  return [
    `thimble-cc-mod: ${whose} problems the analyst sees in red. Fix them here: rerun or fix a card's script, or cite the value the place shows. Do not change the corpus; write only under .thimble-cc-mod/.`,
    ...(thread === undefined ? [] : ['The answer:', thread, '', 'Its problems:']),
    ...items.map((it, i) => `${i + 1}. ${it.old}\n   ${it.problems.map(p => (p.raw === it.old ? p.why : `${p.raw}: ${p.why}`)).join('; ')}`),
    'Then answer with one line per item and nothing else: `<n>: <the corrected item>`, or `<n>: CANNOT <why>`.',
    'thimble-cc-mod puts each corrected item in place of the old one. Give a sentence whole, rewritten so that every word of it agrees with the corrected values (a comparison, a ranking, a share such as "about a third"), its citations included; a table row whole, its cells between | as before; a card by its embed line.',
  ].join('\n')
}

export type FixAnswer = { ok: true; text: string } | { ok: false; why: string }

/** The fix round's answer for each of `n` items: its corrected text, or why it could not be corrected. */
export function parseFix(answer: string, n: number): FixAnswer[] {
  const got = new Map<number, string>()
  for (const line of answer.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?(`?)(\d+)[:.)]\s*(.*)$/.exec(line)
    if (!m) continue
    let text = m[3]!.trim()
    if (m[1] && text.endsWith('`')) text = text.slice(0, -1).trim()
    const k = Number(m[2])
    if (!got.has(k)) got.set(k, text)
  }
  return Array.from({ length: n }, (_, i): FixAnswer => {
    const t = got.get(i + 1)
    if (!t) return { ok: false, why: 'the fix gave no corrected text' }
    const no = /^CANNOT\b[\s:,-]*(.*)$/i.exec(t)
    if (no) return { ok: false, why: no[1]?.trim() || 'the fix could not correct it' }
    return { ok: true, text: t.length > 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t }
  })
}

/** A reply row's text with each passage corrected for that row (`row`, its uuid) in place of the old one, unmarked; a
 *  correction made for another answer never applies, though the same sentence stands there. */
export function applyCorrections(text: string, corrections: readonly ChatCorrection[], row: string): string {
  let out = text
  for (const c of corrections) {
    if (c.row !== row || !c.old || !out.includes(c.old)) continue
    out = out.replace(c.old, () => c.new)
  }
  return out
}

/** An answer's file: its heading and its rows, each with the corrections made for it. */
export function answerFile(end: { rows: { id: string; text: string }[]; head: string }, corrections: readonly ChatCorrection[]): string {
  return `# ${end.head}\n\n${end.rows.map(r => applyCorrections(r.text, corrections, r.id)).join('\n\n')}\n`
}

/** A side thread's answer with each corrected passage in place of the old one. */
export function correctText(text: string, corrections: readonly { old: string; new: string }[]): string {
  return corrections.reduce((out, c) => (c.old && out.includes(c.old) ? out.replace(c.old, () => c.new) : out), text)
}

// ---------------------------------------------------------------------------------------- marks kept across sessions

/** What the chat draws on answers beyond their text, kept in a file so a resumed session draws the same: each answer's
 *  end (its footer and rows) by its last row, each claim's verification and fix by its key, and the last answer's row. */
export type Marks = { ends: Record<string, ChatEnd>; verify: Record<string, ChatVerify>; fixes: Record<string, ChatFix>; last: string }

export const MARKS_CAP = 300

export function emptyMarks(): Marks {
  return { ends: {}, verify: {}, fixes: {}, last: '' }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Marks read back from their file; a verification or fix its session left running is marked ended. */
export function parseMarks(raw: string): Marks {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return emptyMarks()
  }
  const out = emptyMarks()
  if (!isObj(v)) return out
  const ended = 'the session ended before it finished'
  if (isObj(v.ends)) {
    for (const [id, e] of Object.entries(v.ends)) {
      if (isObj(e) && Array.isArray(e.rows) && e.rows.every(r => isObj(r) && typeof r.id === 'string' && typeof r.text === 'string') && typeof e.file === 'string') {
        out.ends[id] = { rows: e.rows as ChatEnd['rows'], cards: Array.isArray(e.cards) ? e.cards.filter((c): c is string => typeof c === 'string') : [], file: e.file, head: typeof e.head === 'string' ? e.head : '', ...(typeof e.check === 'string' && e.check ? { check: e.check } : {}) }
      }
    }
  }
  if (isObj(v.verify)) {
    for (const [id, r] of Object.entries(v.verify)) {
      if (!isObj(r) || typeof r.state !== 'string' || typeof r.script !== 'string') continue
      const run = { ...r, id } as ChatVerify
      out.verify[id] = verifying(run.state) ? { ...run, state: 'error', stderr: run.stderr || ended } : run
    }
  }
  if (isObj(v.fixes)) {
    for (const [id, f] of Object.entries(v.fixes)) {
      if (!isObj(f) || typeof f.state !== 'string') continue
      out.fixes[id] = f.state === 'fixing' ? { state: 'failed', why: ended } : { state: f.state, ...(typeof f.why === 'string' ? { why: f.why } : {}) }
    }
  }
  if (typeof v.last === 'string') out.last = v.last
  return out
}

/** Marks as their file holds them: the newest `cap` of each kind. */
export function marksJson(m: Marks, cap = MARKS_CAP): string {
  const newest = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).slice(-cap))
  return JSON.stringify({ ends: newest(m.ends), verify: newest(m.verify), fixes: newest(m.fixes), last: m.last })
}

/** One mark set, made the newest of its kind (so a cap drops the oldest). */
export function setMark<K extends 'ends' | 'verify' | 'fixes'>(m: Marks, kind: K, id: string, value: Marks[K][string]): void {
  const r = m[kind] as Record<string, unknown>
  delete r[id]
  r[id] = value
}

/** A text's words and numbers outside its citations. */
function prose(s: string): string {
  return citations(s)
    .reduce((t, c) => t.replace(c.raw, ' '), s)
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** The card a card item names after its fix: the one its corrected embed line names, else its own. */
export function fixedCard(it: ChatFixItem, g: FixAnswer): string {
  return (g.ok ? EMBED_RE.exec(g.text.trim())?.slice(1).find(Boolean) : undefined) ?? it.card ?? ''
}

export type FixOutcome = { corrections: { old: string; new: string }[]; states: { state: 'fixed' | 'failed'; why?: string }[]; notes: string[] }

/** What a fix round's answer comes to, item by item: a correction put in place when it is a whole sentence (not a bare
 *  value) and everything it cites checks (or, for a card, when the card now draws), else the item stays red with why.
 *  `verdict` is the check of a citation of a corrected text, `cardError` why a card cannot be drawn ('' when it can);
 *  a passage not in `reply` cannot be corrected in place. */
export function settleFix(
  items: ChatFixItem[],
  got: FixAnswer[],
  verdict: (raw: string) => { status: string; why: string } | undefined,
  cardError: (id: string) => string,
  reply?: string,
): FixOutcome {
  const out: FixOutcome = { corrections: [], states: [], notes: [] }
  items.forEach((it, i) => {
    const g = got[i] ?? { ok: false, why: 'the fix gave no corrected text' }
    const fail = (why: string, note: string) => {
      out.states.push({ state: 'failed', why })
      out.notes.push(`could not fix ${note}`)
    }
    if (it.card) {
      const id = fixedCard(it, g)
      const err = cardError(id)
      if (err) return fail(g.ok ? `still: ${err}` : g.why, `${it.old}: ${g.ok ? err : g.why}`)
      if (id !== it.card) out.corrections.push({ old: it.old, new: `[[card:${id}]]` })
      out.states.push({ state: 'fixed' })
      out.notes.push(id !== it.card ? `${it.old} is now [[card:${id}]]` : `${it.old} now draws`)
      return
    }
    if (!g.ok) return fail(g.why, `"${it.old}": ${g.why}`)
    if (reply !== undefined && !reply.includes(it.old)) return fail('the cited passage is not in the reply as written', `"${it.old}": it is not in the reply as written`)
    if (prose(it.old) && !prose(g.text)) return fail('the fix gave a value, not the whole sentence', `"${it.old}": the fix gave a value, not the whole sentence`)
    for (const c of citations(g.text)) {
      const v = verdict(c.raw)
      if (v?.status === 'missing' || v?.status === 'differs') return fail(`the correction still does not check (${c.raw}: ${v.why})`, `"${it.old}": the correction still does not check`)
    }
    out.corrections.push({ old: it.old, new: g.text })
    out.states.push({ state: 'fixed' })
    out.notes.push(`"${it.old}" now reads "${g.text}"`)
  })
  return out
}

// ---------------------------------------------------------------------------------------- while a reply streams

/** One text block of a reply as it streams: what the model wrote (`raw`), what the engine was handed to show
 *  (`shown`), and how far the finished lines go (`done`: their length in `raw`, `doneShown` as shown). */
export type Streaming = { raw: string; shown: string; done: number; doneShown: string; fence: boolean }

export function streaming(): Streaming {
  return { raw: '', shown: '', done: 0, doneShown: '', fence: false }
}

/** How a streaming reply shows a citation and a card's embed line: `link` gives a citation's Markdown, `card` the
 *  placeholder line of a card by its id. */
export type StreamLook = { link: (c: Citation) => string; card: (id: string) => string }

// the start of a line that may still turn out to be a card's embed line
const EMBED_PREFIX = /^\s*(?:\[(?:\[(?:c(?:a(?:r(?:d(?::[A-Za-z0-9_-]*(?:\](?:\]\s*)?)?)?)?)?)?)?)?|!(?:\[.*)?)$/

/** A citation as a Markdown link the engine underlines: its label escaped, to the file of its place. */
export function streamLink(c: Citation, url: string): string {
  return `[${citeLabel(c).replace(/[\\[\]*_`<>]/g, m => `\\${m}`)}](${url})`
}

/** A line outside a fence, each whole citation outside code drawn by `link`. On an unfinished line (`partial`), the text
 *  from a citation or a code span that has not closed yet (it may still) is held back: `text` is what shows now. */
function streamLine(line: string, partial: boolean, look: StreamLook): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === '`') {
      const j = line.indexOf('`', i + 1)
      if (j >= 0) {
        out += line.slice(i, j + 1)
        i = j + 1
        continue
      }
      if (partial) return out
    } else if (ch === '[' && line[i + 1] === '[') {
      const end = citeEnd(line, i)
      const c = end >= 0 ? citations(line.slice(i, end))[0] : undefined
      if (c) {
        out += look.link(c)
        i = end
        continue
      }
      // a citation still being written, whose value may hold brackets
      if (partial && end < 0) return out
    } else if (ch === '[' && partial && i === line.length - 1) return out
    out += ch
    i++
  }
  return out
}

/** A finished line as it shows: a fence's lines as written, a card's embed line as its placeholder, else its citations
 *  as links. */
function streamDone(st: Streaming, line: string, look: StreamLook): string {
  if (/^\s*```/.test(line)) {
    st.fence = !st.fence
    return line
  }
  if (st.fence) return line
  const embed = EMBED_RE.exec(line)
  if (embed) return look.card((embed[1] ?? embed[2])!)
  return streamLine(line, false, look)
}

/** More of a block's text arrived (or, with `end`, the block is whole): the text to hand the engine now, so that what
 *  it shows never holds a citation's raw spelling. Finished lines are final; of the line still being written, a
 *  citation, code span or embed line not yet closed waits. */
export function streamStep(st: Streaming, more: string, end: boolean, look: StreamLook): string {
  st.raw += more
  let nl = st.raw.indexOf('\n', st.done)
  while (nl >= 0) {
    st.doneShown += `${streamDone(st, st.raw.slice(st.done, nl), look)}\n`
    st.done = nl + 1
    nl = st.raw.indexOf('\n', st.done)
  }
  const rest = st.raw.slice(st.done)
  let now = st.doneShown
  if (end) now += rest ? streamDone(st, rest, look) : ''
  else if (st.fence) now += rest
  else if (!EMBED_PREFIX.test(rest)) now += streamLine(rest, true, look)
  // what was handed over stands (the record is put back as written at its append)
  if (!now.startsWith(st.shown)) return ''
  const out = now.slice(st.shown.length)
  st.shown = now
  return out
}

// ---------------------------------------------------------------------------------------- a rich block as Markdown

/** A run as Markdown: code, bold and italic kept; a citation drawn by `link` with its `n` (its place among the
 *  block's citations). */
function runMarkdown(r: Run, n: number, link: (c: Citation, n: number) => string, cell: boolean): string {
  if (r.cite) return link(r.cite, n)
  let s = r.code ? `\`${r.text}\`` : cell ? r.text.replace(/\|/g, '\\|') : r.text
  if (r.i) s = `*${s}*`
  if (r.b) s = `**${s}**`
  return s
}

/** A block thimble-cc-mod used to draw itself (a paragraph, heading, list item, quote or table holding citations) as
 *  Markdown the engine draws, each citation a link, so its text selects like any reply's and a plain click on a
 *  citation is a press. */
export function richMarkdown(block: { prefix: string; heading: number; quote: boolean; runs: Run[]; table?: TableRuns }, link: (c: Citation, n: number) => string): string {
  let n = 0
  const md = (runs: Run[], cell = false) => runs.map(r => runMarkdown(r, r.cite ? n++ : -1, link, cell)).join('')
  if (block.table) {
    const [head = [], ...body] = block.table.rows
    const cols = Math.max(1, ...block.table.rows.map(r => r.length))
    const row = (cells: Run[][]) => `| ${Array.from({ length: cols }, (_, i) => md(cells[i] ?? [], true).trim() || ' ').join(' | ')} |`
    const rule = `| ${Array.from({ length: cols }, (_, i) => ({ left: '---', right: '--:', center: ':-:' })[block.table!.align[i] ?? 'left']).join(' | ')} |`
    return [row(head), rule, ...body.map(row)].join('\n')
  }
  const text = md(block.runs)
  const lead = block.heading ? `${'#'.repeat(block.heading)} ` : block.prefix
  return block.quote ? text.split('\n').map(l => `> ${l}`).join('\n') : `${lead}${text}`
}
