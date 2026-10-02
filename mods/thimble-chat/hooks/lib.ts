// Pure helpers of thimble-chat (no `$`), shared by the hooks module, the surface modules and the tests.
//
// - citations(text): the [[display|ref]] and [[ref]] citations of a reply, and the link form [display](ref).
// - parseReply(text): a reply block cut into Markdown chunks, card embeds (a line holding only [[card:<id>]]) and rich
//   blocks (a paragraph, list item, heading, quote or table that holds a citation), each rich block as inline runs.
// - shownMatches / valueIn: thimble's number comparison (backend/app/cite.py), for the verification script's result.

export type Citation = { raw: string; ref: string; display: string | null }

export type Run = { text: string; b?: boolean; i?: boolean; code?: boolean; u?: boolean; cite?: Citation }

/** `gap`: a blank line stood before the block in the reply, so it is drawn one row below the one before it. */
export type Block =
  | { type: 'md'; text: string; gap: boolean }
  | { type: 'card'; id: string; gap: boolean }
  | { type: 'rich'; prefix: string; heading: number; quote: boolean; runs: Run[]; gap: boolean; table?: TableRuns }

/** A Markdown table that holds citations, drawn by thimble-chat (the `|` inside `[[value|ref]]` breaks a GFM table):
 *  its rows of cells of runs, the first row the header, and each column's alignment. A table block's `runs` are its
 *  cells' runs in reading order, so its chips are numbered as a paragraph's are. */
export type TableRuns = { rows: Run[][][]; align: ('left' | 'right' | 'center')[] }

const SPAN_RE = /\[\[([^\[\]]+?)\]\]/g
const FENCE_RE = /```[\s\S]*?```|`[^`\n]*`/g
const LINK_RE = /(?<![\[!])\[([^\[\]\n]*)\]\(\s*(?:<([^<>\n]+)>|((?:[^()\s<>]|\([^()\s]*\))+))\s*\)/g
const WEB_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:)/i
const REF_SHAPE = /^(?:call:[A-Za-z0-9_-]+(?:#L\d+(?:-L?\d+)?)?|card:[A-Za-z0-9_-]+(?:#.*)?|[^\s:#]+#\S+|[^\s:#()]+\.[A-Za-z][A-Za-z0-9]{0,7})$/
export const EMBED_RE = /^\s*(?:\[\[card:([A-Za-z0-9_-]+)\]\]|!\[[^\]\n]*\]\(card:([A-Za-z0-9_-]+)\))\s*$/

function make(display: string | null, ref: string): Citation {
  return { raw: display === null ? `[[${ref}]]` : `[[${display}|${ref}]]`, ref, display }
}

function spanCitation(inner: string): Citation | null {
  const t = inner.trim()
  const bar = t.indexOf('|')
  const display = bar >= 0 ? t.slice(0, bar).trim() : null
  const ref = (bar >= 0 ? t.slice(bar + 1) : t).trim()
  return ref ? make(display, ref) : null
}

function linkCitation(shown: string, target: string): Citation | null {
  const ref = target.trim().replaceAll('%20', ' ')
  if (!ref || WEB_RE.test(ref) || shown.includes('|') || !REF_SHAPE.test(ref)) return null
  const s = shown.trim()
  return make(s === '' || s === '↗' ? null : s, ref)
}

/** Every citation of a text in order, deduplicated by its `[[...]]` spelling; code spans and fences left out. */
export function citations(text: string): Citation[] {
  const found: { at: number; c: Citation }[] = []
  const clean = text.replace(FENCE_RE, m => ' '.repeat(m.length))
  for (const m of clean.matchAll(SPAN_RE)) {
    const c = spanCitation(m[1]!)
    if (c) found.push({ at: m.index ?? 0, c })
  }
  for (const m of clean.matchAll(LINK_RE)) {
    const c = linkCitation(m[1]!, m[2] ?? m[3] ?? '')
    if (c) found.push({ at: m.index ?? 0, c })
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.at - b.at)
    .map(f => f.c)
    .filter(c => !seen.has(c.raw) && Boolean(seen.add(c.raw)))
}

/** A short stable id for a citation (FNV-1a of its raw spelling), the key of its state. */
export function cid(raw: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** What a chip says: the shown value, or a short name of the place for a citation without one. */
export function chipLabel(c: Citation): string {
  if (c.display !== null) return c.display.length > 40 ? `${c.display.slice(0, 39)}…` : c.display
  const [base = '', frag = ''] = c.ref.split('#', 2)
  if (base.startsWith('card:')) return frag ? `card ${frag.split('/').at(-1)}` : 'card'
  if (base.startsWith('call:')) return frag ? `output ${frag}` : 'output'
  const name = base.split('/').at(-1) ?? base
  const short = name.replace(/\.(jsonl|json|csv|tsv|txt|md|log)$/, '')
  const where = frag.startsWith('L') ? `:${frag.slice(1).replace('-L', '-')}` : frag ? `#${frag}` : ''
  const label = `${short}${where}`
  return label.length > 24 ? `${label.slice(0, 23)}…` : label
}

// ---------------------------------------------------------------------------------------- inline runs

/** A line of Markdown as styled runs: bold, italic, code, links (their text), citations (one run each). */
export function inlineRuns(text: string): Run[] {
  const out: Run[] = []
  // tokens: code span, citation, link (citation form or web), bold, italic
  const TOKEN = /(`[^`\n]+`)|(\[\[[^\[\]]+?\]\])|((?<![\[!])\[[^\[\]\n]*\]\([^()\s]*(?:\([^()\s]*\)[^()\s]*)*\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|((?<![\w*])\*[^*\n]+\*(?!\w)|(?<![\w_])_[^_\n]+_(?![\w]))/g
  let last = 0
  const push = (r: Run) => {
    if (r.text) out.push(r)
  }
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    push({ text: text.slice(last, at) })
    const tok = m[0]
    if (m[1]) push({ text: tok.slice(1, -1), code: true })
    else if (m[2]) {
      const c = spanCitation(tok.slice(2, -2))
      if (c) out.push({ text: chipLabel(c), cite: c })
      else push({ text: tok })
    } else if (m[3]) {
      const lm = /^\[([^\[\]\n]*)\]\((.*)\)$/.exec(tok)
      const c = lm ? linkCitation(lm[1]!, lm[2]!) : null
      if (c) out.push({ text: chipLabel(c), cite: c })
      else push({ text: lm ? lm[1]! : tok, u: true })
    } else if (m[4]) {
      for (const r of inlineRuns(tok.slice(2, -2))) push({ ...r, b: true })
    } else if (m[5]) {
      for (const r of inlineRuns(tok.slice(1, -1))) push({ ...r, i: true })
    }
    last = at + tok.length
  }
  push({ text: text.slice(last) })
  return out
}

// ---------------------------------------------------------------------------------------- blocks

/** A table row's cells: split at each bar outside citations and code spans; an escaped bar stays in its cell. */
export function tableCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let depth = 0
  let code = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (!code && t.startsWith('[[', i)) depth++
    else if (!code && depth > 0 && t.startsWith(']]', i)) depth--
    if (ch === '`') code = !code
    if (ch === '|' && depth === 0 && !code) {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

const ALIGN_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** A Markdown table's lines as rows of runs, the alignment row read and left out. */
export function tableRuns(lines: string[]): TableRuns {
  const rows: Run[][][] = []
  let align: TableRuns['align'] = []
  for (const line of lines) {
    if (ALIGN_ROW.test(line) && line.includes('-')) {
      align = tableCells(line).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
      continue
    }
    rows.push(tableCells(line).map(c => inlineRuns(c)))
  }
  return { rows, align }
}

/** A reply block cut into what the engine draws as Markdown (no citation in it), the cards it embeds, and the rich
 *  blocks thimble-chat draws itself so their citations can be chips. Fences and tables stay Markdown whole. */
export function parseReply(text: string): Block[] {
  const lines = text.split('\n')
  const out: Block[] = []
  let md: string[] = []
  let blank = false // the line before the next block was blank
  const flush = () => {
    const first = md.findIndex(l => l.trim() !== '')
    if (first >= 0) {
      let last = md.length - 1
      while (!md[last]!.trim()) last--
      out.push({ type: 'md', text: md.slice(first, last + 1).join('\n'), gap: blank || first > 0 })
      blank = last < md.length - 1
    } else if (md.length) blank = true
    md = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const embed = EMBED_RE.exec(line)
    if (embed) {
      flush()
      out.push({ type: 'card', id: (embed[1] ?? embed[2])!, gap: blank })
      blank = false
      i++
      continue
    }
    if (/^\s*```/.test(line)) {
      const start = i
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) i++
      md.push(...lines.slice(start, Math.min(i + 1, lines.length)))
      i++
      continue
    }
    if (/^\s*\|/.test(line)) {
      const start = i
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) i++
      const rows = lines.slice(start, i)
      if (citations(rows.join('\n')).length === 0) {
        md.push(...rows)
        continue
      }
      flush()
      const table = tableRuns(rows)
      out.push({ type: 'rich', prefix: '', heading: 0, quote: false, runs: table.rows.flat(2), gap: blank, table })
      blank = false
      continue
    }
    if (!line.trim()) {
      md.push(line)
      i++
      continue
    }
    // one block: a heading, a list item (with its continuation lines), a quote, or a paragraph
    const head = /^(#{1,6})\s+(.*)$/.exec(line)
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    const start = i
    let body: string[]
    let prefix = ''
    let heading = 0
    let isQuote = false
    if (head) {
      heading = head[1]!.length
      body = [head[2]!]
      i++
    } else if (item) {
      prefix = `${item[1]!.replace(/\t/g, '  ')}${item[2]!} `
      body = [item[3]!]
      i++
      while (i < lines.length && lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i]!)) body.push(lines[i++]!.trim())
    } else if (quote) {
      isQuote = true
      body = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
    } else {
      body = []
      while (
        i < lines.length && lines[i]!.trim() && !EMBED_RE.test(lines[i]!) && !/^\s*(```|\||#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]!)
      ) body.push(lines[i++]!)
    }
    const joined = body.join(' ')
    if (citations(joined).length === 0) {
      md.push(...lines.slice(start, i))
      continue
    }
    flush()
    out.push({ type: 'rich', prefix, heading, quote: isQuote, runs: inlineRuns(joined), gap: blank })
    blank = false
  }
  flush()
  if (out[0]) out[0].gap = false
  return out
}

/** Whether a reply block needs thimble-chat's drawing: it embeds a card or holds a citation. */
export function needsDrawing(text: string): boolean {
  return text.split('\n').some(l => EMBED_RE.test(l)) || citations(text).length > 0
}

// ---------------------------------------------------------------------------------------- numbers (cite.py port)

const NUM_RE = /(?<![\w:./#\-−])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w%:])/g
const PLAIN_RE = /^[-−]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)$/
const QUOTES = '"\'“”‘’'

type Num = { v: bigint; scale: number }

function parts(s: string): Num | null {
  const t = s.trim().replaceAll(',', '').replaceAll('−', '-').replace(/%+$/, '').trim()
  if (!PLAIN_RE.test(t)) return null
  const neg = t.startsWith('-')
  const body = neg ? t.slice(1) : t
  const [int = '', frac = ''] = body.split('.')
  const v = BigInt((int || '0') + frac)
  return { v: neg ? -v : v, scale: frac.length }
}

function scaled(n: Num, scale: number): bigint {
  return n.v * 10n ** BigInt(scale - n.scale)
}

function eq(a: Num, b: Num): boolean {
  const s = Math.max(a.scale, b.scale)
  return scaled(a, s) === scaled(b, s)
}

function rounded(b: Num, d: number): Num[] {
  if (d >= b.scale) return [b]
  const div = 10n ** BigInt(b.scale - d)
  const neg = b.v < 0n
  const mag = neg ? -b.v : b.v
  const q = mag / div
  const r = mag % div
  const up = r * 2n >= div ? q + 1n : q
  const even = r * 2n > div || (r * 2n === div && q % 2n === 1n) ? q + 1n : q
  const sign = (x: bigint) => (neg ? -x : x)
  return [{ v: sign(up), scale: d }, { v: sign(even), scale: d }]
}

function norm(tok: string): string {
  const s = tok.replaceAll(',', '').replaceAll('−', '-').replace(/%+$/, '').trim()
  const n = parts(s)
  if (!n) return s
  let { v, scale } = n
  while (scale > 0 && v % 10n === 0n) {
    v /= 10n
    scale -= 1
  }
  if (v === 0n) return '0'
  const neg = v < 0n
  const digits = (neg ? -v : v).toString().padStart(scale + 1, '0')
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  return neg ? `-${text}` : text
}

/** The same value, or `shown` with only decimals dropped by rounding: "91%" cites 91.2, "6,500" does not cite 6,543. */
export function shownMatches(token: string, shown: string): boolean {
  const a = parts(token)
  const b = parts(shown)
  if (!a || !b) return norm(token) !== '' && norm(token) === norm(shown)
  if (eq(a, b)) return true
  return a.scale < b.scale && rounded(b, a.scale).some(r => eq(a, r))
}

/** Whether a shown value is in a text: a number must match a whole number of it, anything else is a substring. */
export function valueIn(display: string, text: string): boolean {
  for (const m of text.matchAll(NUM_RE)) if (shownMatches(display, m[0])) return true
  const d = display.trim()
  if (new RegExp(`^(?:${NUM_RE.source})$`).test(d)) return false
  let words = d
  if (words.length > 2 && QUOTES.includes(words[0]!) && QUOTES.includes(words.at(-1)!)) words = words.slice(1, -1)
  return text.replaceAll(',', '').includes(norm(words))
}

/** The value a verification script printed: its last line of the form `RESULT: <value>`, or null. */
export function scriptResult(stdout: string): string | null {
  const hits = [...stdout.matchAll(/^RESULT:\s*(.+?)\s*$/gm)]
  return hits.length ? hits.at(-1)![1]! : null
}

/** A value as a card shows it: an integer whole, a float to at most 3 decimals. */
export function fmt(v: unknown): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v)
    if (Number.isInteger(v)) return String(v)
    const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
    return s === '-0' ? '0' : s
  }
  return v === null || v === undefined ? '' : String(v)
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, Math.max(0, n - 1))}…` : one
}

/** The sentence of a reply that holds a citation, for the prompt that asks for its verification script. */
export function sentenceOf(text: string, raw: string): string {
  const at = text.indexOf(raw)
  if (at < 0) return ''
  const before = text.slice(0, at)
  const start = Math.max(before.lastIndexOf('. ') + 1, before.lastIndexOf('\n') + 1, 0)
  const rest = text.slice(at)
  const m = /[.!?](\s|$)|\n/.exec(rest)
  return text.slice(start, at + (m ? m.index + 1 : rest.length)).trim()
}

// ---------------------------------------------------------------------------------------- card files

export const CARD_KINDS = ['bar', 'line', 'timeline', 'table', 'example'] as const

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isCell = (v: unknown) => v === null || isStr(v) || isNum(v) || typeof v === 'boolean'

/** Why a card file cannot be drawn, or null when it fits its kind's spec. The mod draws only these five typed specs;
 *  a card that fails is drawn as this error, and main is asked to fix it. */
export function validateCard(c: unknown, id?: string): string | null {
  if (!isObj(c)) return 'the file is not a JSON object'
  if (!isStr(c.id) || !/^[A-Za-z0-9_-]+$/.test(c.id)) return 'no valid id'
  if (id !== undefined && c.id !== id) return `its id is ${c.id}, not ${id}`
  if (!isStr(c.kind) || !(CARD_KINDS as readonly string[]).includes(c.kind)) return `kind must be one of ${CARD_KINDS.join(', ')}`
  if (!isStr(c.question) || !c.question.trim()) return 'no question'
  const list = (k: string) => (Array.isArray(c[k]) ? (c[k] as unknown[]) : null)
  switch (c.kind) {
    case 'bar': {
      const rows = list('rows')
      if (!rows?.length) return 'a bar card needs rows'
      const bad = rows.findIndex(r => !isObj(r) || !isStr(r.label) || !isNum(r.value))
      if (bad >= 0) return `bar row ${bad + 1} needs a label and a finite number value`
      break
    }
    case 'line': {
      const series = list('series')
      if (!series?.length) return 'a line card needs series'
      for (const s of series) {
        if (!isObj(s) || !isStr(s.name) || !Array.isArray(s.points) || s.points.length === 0) return 'each series needs a name and points'
        const bad = (s.points as unknown[]).findIndex(p => !Array.isArray(p) || p.length !== 2 || !(isStr(p[0]) || isNum(p[0])) || !isNum(p[1]))
        if (bad >= 0) return `series ${s.name}: point ${bad + 1} must be [x, number]`
      }
      break
    }
    case 'timeline': {
      const evs = list('events')
      if (!evs?.length) return 'a timeline card needs events'
      const bad = evs.findIndex(e => !isObj(e) || !isStr(e.time) || !isStr(e.label) || !isStr(e.ref))
      if (bad >= 0) return `event ${bad + 1} needs time, label and ref`
      break
    }
    case 'table': {
      const cols = list('columns')
      const rows = list('rows')
      if (!cols?.length || !cols.every(isStr)) return 'a table card needs columns, as strings'
      if (!rows) return 'a table card needs rows'
      const bad = rows.findIndex(r => !Array.isArray(r) || r.length !== cols.length || !r.every(isCell))
      if (bad >= 0) return `table row ${bad + 1} must have ${cols.length} plain values`
      break
    }
    case 'example': {
      const exs = list('examples')
      if (!exs?.length) return 'an example card needs examples'
      const bad = exs.findIndex(e => !isObj(e) || !isStr(e.ref) || !/#L\d+/.test(e.ref) || !isStr(e.quote))
      if (bad >= 0) return `example ${bad + 1} needs a ref to lines (file#L12) and a quote`
      break
    }
  }
  if (c.params !== undefined) {
    if (!Array.isArray(c.params)) return 'params must be a list'
    for (const p of c.params as unknown[]) {
      if (!isObj(p) || !isStr(p.name) || !Array.isArray(p.choices) || !p.choices.some(x => String(x) === String(p.value))) {
        return 'each param needs a name, choices and a value among them'
      }
    }
  }
  return null
}

/** The ids of the cards a reply embeds (lines holding only [[card:<id>]]), in order. */
export function embeddedCards(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = EMBED_RE.exec(line)
    if (m) out.push((m[1] ?? m[2])!)
  }
  return out
}

/** The paragraph after a card's embed line: the card's takeaway, as the reply wrote it. */
export function takeawayAfter(text: string, id: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex(l => {
    const m = EMBED_RE.exec(l)
    return m !== null && (m[1] ?? m[2]) === id
  })
  if (at < 0) return ''
  let i = at + 1
  while (i < lines.length && !lines[i]!.trim()) i++
  const out: string[] = []
  while (i < lines.length && lines[i]!.trim() && !EMBED_RE.test(lines[i]!) && !/^\s*(#{1,6}\s|```|\|)/.test(lines[i]!)) out.push(lines[i++]!)
  return out.join('\n')
}

/** A one-line version of a side thread's answer to offer main: its `FOR MAIN:` line, else its first sentence. */
export function forMain(answer: string): string {
  const m = /^\s*FOR MAIN:\s*(.+)$/m.exec(answer)
  if (m) return m[1]!.trim()
  const first = answer.replace(/\s+/g, ' ').trim()
  const end = /[.!?](\s|$)/.exec(first)
  return end ? first.slice(0, end.index + 1) : first.slice(0, 200)
}

/** A prompt as thimble-chat sent it, without the engine's framing around a plugin's prompt ("The thimble-chat plugin
 *  sent a message:" before it, a line on how plugin prompts are surfaced after it); other prompts unchanged. */
export function unframed(text: string): string {
  return text
    .replace(/^\s*The thimble-chat plugin sent a message:\s*/, '')
    .replace(/\n+This is how Claude Code surfaces a prompt a plugin submits[\s\S]*$/, '')
    .trim()
}

/** Whether a prompt is one thimble-chat sent main (a fix request, a verification request, a note). */
export function fromMod(text: string): boolean {
  return unframed(text).startsWith('thimble-chat')
}

/** A side thread's answer as the pane draws it: its `FOR MAIN:` line left out (the pane offers it as a button). */
export function threadBody(answer: string): string {
  return answer.replace(/^\s*FOR MAIN:.*$/m, '').trim()
}
