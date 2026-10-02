// Citations as the analyst sees them (no `$`), shared by the hooks module, para.tsx and the tests.
//
// - Display: every citation is a plain underlined link. Only a problem has colour: red when the value is not at the
//   cited place or the place does not exist. A spinner follows a citation while a fix round or its verification works
//   on it; then ✓ when its verification recomputed the value, or ✗ (and red) when the verification recomputed another
//   value or the fix round could not correct it.
// - Layout: a reply's paragraph or table wrapped to its width, with where each citation, word and table row lands, so
//   a pointer finds what it is over.
// - Fix rounds: the sentences a forked subagent is asked to rewrite, its answer read, and each corrected sentence put
//   in place of the old one, unmarked.
import type { ChatCorrection, ChatFixItem } from '../types'
import { cut, lineWidth, width } from './draw'
import type { Line, Seg } from './draw'
import { EMBED_RE, citations } from './lib'
import type { Citation, Run, TableRuns } from './lib'
import { COLORS } from './paint'

/** `link` for every citation without a problem (checked, unchecked or not checked yet); `problem` when the value is
 *  not at the place or the place does not exist; `fixing` while a fix round runs on it; `failed` when the fix round
 *  could not correct it or its verification recomputed another value. */
export type ChipState = 'link' | 'problem' | 'fixing' | 'failed'
/** `mark` is ✓, ✗ or nothing; `spin` while a fix round or a verification works on the citation. */
export type ChipView = { label: string; state: ChipState; mark: string; spin: boolean; tip: string }

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** How a citation is drawn, from the resolver's status, its fix round's state and its verification's state. */
export function chipState(status: string | undefined, fix: string | undefined, verify?: string): ChipState {
  if (fix === 'fixing') return 'fixing'
  if (verify === 'refuted') return 'failed'
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
  const mark = spin ? '' : state === 'failed' ? '✗' : state === 'link' && verify === 'verified' ? '✓' : ''
  return { state, mark, spin }
}

/** A citation as styled segments: the underlined label, then its spinner or its mark. */
export function chipSegs(c: ChipView, hover: boolean, frame = 0): Seg[] {
  const segs: Seg[] = [{ s: c.label, fg: c.state === 'link' ? COLORS.link : COLORS.problem, u: true, inv: hover }]
  if (c.spin) segs.push({ s: ` ${SPIN[frame % SPIN.length]}`, fg: c.state === 'link' ? COLORS.dim : COLORS.problem })
  else if (c.mark) segs.push({ s: c.mark, fg: c.mark === '✓' ? COLORS.ok : COLORS.problem })
  return segs
}

// ---------------------------------------------------------------------------------------- layout

export type ChipSpan = { line: number; x0: number; x1: number; chip: number }
/** A word as laid out, and where it starts in the block's source (its text with each citation as written). */
export type WordSpan = { line: number; x0: number; x1: number; at: number }
/** `rows`: for a table, each line's row as source text ('' for the rule). */
export type ParaLayout = { lines: Line[]; spans: ChipSpan[]; words: WordSpan[]; source: string; rows?: string[] }

const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s.s), 0)

/** A rich block wrapped to `cols`: words flow, each citation is one link that never breaks. */
export function paraLayout(
  block: { prefix: string; heading: number; quote: boolean; runs: Run[] },
  chips: ChipView[],
  cols: number,
  hover: number,
  frame = 0,
): ParaLayout {
  const lead = block.quote ? '│ ' : block.prefix
  const indent = block.quote ? '│ ' : ' '.repeat(width(block.prefix))
  const room = Math.max(10, cols - width(lead))
  type Tok = { segs: Seg[]; space: boolean; chip: number; at: number }
  const toks: Tok[] = []
  let source = ''
  let k = 0
  for (const r of block.runs) {
    if (r.cite) {
      const c: ChipView = chips[k] ?? { label: r.text, state: 'link', mark: '', spin: false, tip: '' }
      toks.push({ segs: chipSegs(c, k === hover, frame), space: false, chip: k, at: source.length })
      source += r.cite.raw
      k++
      continue
    }
    let at = source.length
    for (const part of r.text.split(/(\s+)/)) {
      if (!part) continue
      const space = /^\s+$/.test(part)
      const style: Seg = { s: space ? ' ' : part }
      if (r.b || block.heading) style.b = true
      if (r.i) style.i = true
      if (r.u) style.u = true
      if (r.code) style.fg = COLORS.code
      toks.push({ segs: [style], space, chip: -1, at })
      at += part.length
    }
    source += r.text
  }
  const x0 = width(lead)
  const lines: Line[] = []
  const spans: ChipSpan[] = []
  const words: WordSpan[] = []
  let cur: Line = []
  let used = 0
  const newLine = () => {
    while (cur.length && cur.at(-1)!.s === ' ') cur.pop()
    lines.push(cur)
    cur = []
    used = 0
  }
  for (const t of toks) {
    const w = segsWidth(t.segs)
    if (t.space) {
      if (used > 0 && used + 1 <= room) {
        cur.push(t.segs[0]!)
        used += 1
      }
      continue
    }
    if (used > 0 && used + w > room) newLine()
    if (t.chip >= 0) {
      spans.push({ line: lines.length, x0: x0 + used, x1: x0 + used + w, chip: t.chip })
      cur.push(...t.segs)
      used += w
      continue
    }
    // a word longer than the line is cut into pieces
    const seg = t.segs[0]!
    let s = seg.s
    let at = t.at
    while (width(s) > room) {
      const head = cut(s, room + 1).slice(0, -1)
      words.push({ line: lines.length, x0: x0 + used, x1: x0 + used + width(head), at })
      cur.push({ ...seg, s: head })
      newLine()
      s = s.slice(head.length)
      at += head.length
    }
    words.push({ line: lines.length, x0: x0 + used, x1: x0 + used + width(s), at })
    cur.push({ ...seg, s })
    used += width(s)
  }
  if (cur.length || lines.length === 0) newLine()
  const dimLead: Seg = { s: lead, fg: block.quote ? COLORS.dim : undefined, b: !block.quote && block.heading > 0 }
  return {
    lines: lines.map((l, i) => [i === 0 ? dimLead : { s: indent, fg: block.quote ? COLORS.dim : undefined }, ...l]),
    spans,
    words,
    source,
  }
}

/** A table block in aligned columns, the header bold over a rule, each citation one link. Columns wider than `cols`
 *  allows are narrowed from the widest, their text cut; a citation is never cut (one that does not fit is left out). */
export function mdTableLayout(table: TableRuns, chips: ChipView[], cols: number, hover: number, frame = 0): ParaLayout {
  const GAP = 2
  let k = 0
  const grid: { segs: Seg[]; chip: number }[][][] = table.rows.map((row, r) =>
    row.map(cell =>
      cell.map(run => {
        if (run.cite) {
          const c: ChipView = chips[k] ?? { label: run.text, state: 'link', mark: '', spin: false, tip: '' }
          const on = k === hover
          return { segs: chipSegs(c, on, frame), chip: k++ }
        }
        const seg: Seg = { s: run.text.replace(/\s+/g, ' ') }
        if (run.b || r === 0) seg.b = true
        if (run.i) seg.i = true
        if (run.u) seg.u = true
        if (run.code) seg.fg = COLORS.code
        return { segs: [seg], chip: -1 }
      }),
    ),
  )
  const rowSource = table.rows.map(row => row.map(cell => cell.map(run => (run.cite ? run.cite.raw : run.text)).join('')).join(' | '))
  const ncol = Math.max(...grid.map(r => r.length))
  const cellW = (cell: { segs: Seg[] }[] | undefined) => (cell ?? []).reduce((n, p) => n + lineWidth(p.segs), 0)
  const w = Array.from({ length: ncol }, (_, c) => Math.max(1, ...grid.map(r => cellW(r[c]))))
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
    const line: Line = []
    let x = 0
    for (let c = 0; c < ncol; c++) {
      const parts = row[c] ?? []
      const fill = Math.max(0, w[c]! - cellW(parts))
      const align = table.align[c] ?? 'left'
      const before = align === 'right' ? fill : align === 'center' ? Math.floor(fill / 2) : 0
      if (c > 0) {
        line.push({ s: ' '.repeat(GAP) })
        x += GAP
      }
      if (before) line.push({ s: ' '.repeat(before) })
      let used = before
      for (const p of parts) {
        const pw = lineWidth(p.segs)
        if (used + pw > w[c]!) {
          if (p.chip >= 0 || w[c]! - used < 2) break
          line.push({ ...p.segs[0]!, s: cut(p.segs[0]!.s, w[c]! - used) })
          used = w[c]!
          break
        }
        if (p.chip >= 0) spans.push({ line: lines.length, x0: x + used, x1: x + used + pw, chip: p.chip })
        line.push(...p.segs)
        used += pw
      }
      if (w[c]! > used) line.push({ s: ' '.repeat(w[c]! - used) })
      x += w[c]!
    }
    lines.push(line)
    rows.push(rowSource[r] ?? '')
    if (r === 0 && grid.length > 1) {
      lines.push([{ s: w.map(n => '─'.repeat(n)).join(' '.repeat(GAP)), fg: COLORS.rule }])
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
  let start = 0
  let end = source.length
  for (const m of source.matchAll(ends)) {
    const i = (m.index ?? 0) + 1
    // a full stop inside a citation ([[3.5|x]]) is no sentence end
    const before = source.slice(0, i)
    if (before.lastIndexOf('[[') > before.lastIndexOf(']]')) continue
    if (i <= at) start = i
    else {
      end = i
      break
    }
  }
  return source.slice(start, end).trim()
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
 *  rewritten whole, one line per passage. */
export function fixPrompt(items: ChatFixItem[]): string {
  return [
    "thimble-chat: your last reply has problems the analyst sees in red. Fix them here: rerun or fix a card's script, or cite the value the place shows. Do not change the corpus; write only under .thimble-chat/.",
    ...items.map((it, i) => `${i + 1}. ${it.old}\n   ${it.problems.map(p => (p.raw === it.old ? p.why : `${p.raw}: ${p.why}`)).join('; ')}`),
    'Then answer with one line per item and nothing else: `<n>: <the corrected item>`, or `<n>: CANNOT <why>`.',
    'thimble-chat puts each corrected item in place of the old one. Give a sentence whole, rewritten so that every word of it agrees with the corrected values (a comparison, a ranking, a share such as "about a third"), its citations included; a table row whole, its cells between | as before; a card by its embed line.',
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

/** A reply's text with each corrected passage in place of the old one, unmarked. */
export function applyCorrections(text: string, corrections: readonly ChatCorrection[]): string {
  let out = text
  for (const c of corrections) {
    if (!c.old || !out.includes(c.old)) continue
    out = out.replace(c.old, () => c.new)
  }
  return out
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
