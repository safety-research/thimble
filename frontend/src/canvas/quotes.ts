// What an example card shows of a record it quotes, read from the resolved ref (GET /corpora/{c}/ref) rather than its
// one-string excerpt: the record's text, its tool call and output, or for a JSON record of unknown shape its short
// fields on one line and long text fields under them, never a JSON dump. A span is the passage with the words around
// it. Prose written in markdown is marked `md`; a text that is JSON reads as its fields, and a passage of JSON as the
// decoded string values it covers (jsonSpanParts). Pure.
import type { ResolvedRef } from '../lib/types'

export type QuotePart =
  /** prose: a message, a post, a line someone said; `md` when its source is markdown; `mark`, the claim's words in it
   * (canvas/facts markValue) */
  | { kind: 'text'; text: string; md?: boolean; dim?: boolean; mark?: [number, number] }
  /** code or a log: mono, its lines kept */
  | { kind: 'code'; text: string; mark?: [number, number] }
  /** a tool call: the tool's name, then what it was asked to do (a command, else its input's fields) */
  | { kind: 'tool'; name: string; text: string }
  /** a record's short fields, on one line */
  | { kind: 'fields'; pairs: [string, string][] }
  /** one long text field of a record, under its name; `mono` for output such as a tool's result, `md` when its text is
   * written in markdown */
  | { kind: 'field'; key: string; text: string; mono?: boolean; md?: boolean; mark?: [number, number] }
  /** a passage inside a longer text, with the words before and after it; `key` names the record's field it sits in (a
   * passage of a JSON record), `md` when its source is markdown */
  | { kind: 'span'; before: string; text: string; after: string; mono?: boolean; md?: boolean; key?: string }

const CODE_EXT = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|sh|bash|zsh|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|swift|php|pl|lua|r|sql|yaml|yml|toml|ini|cfg|conf|json|xml|html|css|scss|mk|makefile|dockerfile|diff|patch|log|csv|tsv)$/i
const MD_EXT = /\.(md|markdown|mdx)$/i

/** How a file's lines read: markdown, code (a source file, a config, a log, or a script with no extension), or prose. */
export function fileKind(path: string | undefined): 'md' | 'code' | 'prose' {
  const p = path ?? ''
  if (MD_EXT.test(p)) return 'md'
  if (CODE_EXT.test(p)) return 'code'
  const base = p.split('/').pop() ?? ''
  // a script with no extension (a CLI such as tools/bin/deploy) reads as code; a .txt or a .jsonl's text as prose
  return base && !base.includes('.') ? 'code' : 'prose'
}

// a field of a record that holds its text, and among them those that hold a program's output
const TEXT_KEYS = new Set(['text', 'content', 'body', 'message', 'msg', 'output', 'stdout', 'stderr', 'result', 'tool_result', 'response', 'answer', 'prompt', 'summary', 'description', 'error', 'comment', 'note', 'reason', 'thinking', 'value'])
const OUTPUT_KEYS = /^(output|stdout|stderr|result|tool_result|error|traceback|log)$/i
/** a string field longer than this is text of its own, under its name; a shorter one sits on the fields line */
const LONG_FIELD = 60
/** how much of a nested value or a list the fields line keeps */
const INLINE_MAX = 80

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/** Text as it reads: a terminal's colour codes and control characters (a backspace, a bell) gone, carriage returns
 * read as line ends, and no more than one blank line in a row. */
export function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\n{3,}/g, '\n\n')
}

/** Code with the indentation all its lines share taken off (a function quoted from inside a class). */
export function dedent(text: string): string {
  const lines = text.split('\n')
  const widths = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const n = widths.length ? Math.min(...widths) : 0
  return n ? lines.map((l) => l.slice(Math.min(n, /^[ \t]*/.exec(l)![0].length))).join('\n') : text
}

function inline(v: unknown): string {
  if (v == null) return String(v)
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return cut(v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', '), INLINE_MAX)
  const pairs = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${typeof x === 'string' ? x : JSON.stringify(x)}`)
  return cut(pairs.join(', '), INLINE_MAX)
}

/** A JSON record as fields: its short values on one line (nested ones and lists cut short), its long strings each
 * under its name, output fields (a tool's result, stdout) in mono. */
export function recordParts(record: unknown): QuotePart[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return [{ kind: 'code', text: JSON.stringify(record, null, 2) }]
  const pairs: [string, string][] = []
  const long: QuotePart[] = []
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (typeof v === 'string' && (v.length > LONG_FIELD || v.includes('\n') || (TEXT_KEYS.has(k) && v.trim().length > 0 && v.length > 24))) {
      const text = v.replace(/^\s*\n/, '').replace(/\s+$/, '')
      if (text) long.push({ kind: 'field', key: k, text, ...(OUTPUT_KEYS.test(k) ? { mono: true } : looksMarkdown(text) ? { md: true } : {}) })
    } else if (v != null && v !== '') pairs.push([k, inline(v)])
  }
  return [...(pairs.length ? [{ kind: 'fields', pairs } as QuotePart] : []), ...long]
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One string value of a JSON text: the key it is the value of (an array's items take the array's key), where its
 * literal sits in the text (`start` at the opening quote, `end` past the closing one), its decoded value, and for each
 * decoded character the text offset its source begins at. */
export interface JsonString {
  key: string
  start: number
  end: number
  value: string
  at: number[]
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }

/**
 * The string values of the JSON object or array that starts at `from` in `text`, with where each sits, or null when the
 * text there is not JSON. A text cut short gives the values up to the cut. Offsets are UTF-16 units, as span refs
 * count them (backend refs.utf16_slice).
 */
export function jsonStrings(text: string, from = 0): JsonString[] | null {
  let i = from
  const n = text.length
  const out: JsonString[] = []
  const skip = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++
  }
  const bad = new Error('not json')
  const str = (): { value: string; at: number[]; start: number; closed: boolean } => {
    const start = i++
    let value = ''
    const at: number[] = []
    while (i < n) {
      const ch = text[i]
      if (ch === '"') {
        i++
        return { value, at, start, closed: true }
      }
      if (ch === '\\') {
        const e = text[i + 1]
        if (e === undefined) break
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
          value += String.fromCharCode(parseInt(hex, 16))
          at.push(i)
          i += 6
          continue
        }
        if (!(e in ESCAPES)) throw bad
        value += ESCAPES[e]
        at.push(i)
        i += 2
        continue
      }
      value += ch
      at.push(i)
      i++
    }
    i = n
    return { value, at, start, closed: false }
  }
  const walk = (key: string): void => {
    skip()
    if (i >= n) return
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']'
      i++
      for (;;) {
        skip()
        if (i >= n) return
        if (text[i] === close) {
          i++
          return
        }
        if (text[i] === ',') {
          i++
          continue
        }
        if (close === ']') {
          walk(key)
          continue
        }
        if (text[i] !== '"') throw bad
        const k = str()
        if (!k.closed) return
        skip()
        if (i >= n) return
        if (text[i] !== ':') throw bad
        i++
        walk(k.value)
      }
    }
    if (ch === '"') {
      const s = str()
      out.push({ key, start: s.start, end: i, value: s.value, at: s.at })
      return
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 40))
    if (!m) throw bad
    i += m[0].length
  }
  skip()
  if (text[i] !== '{' && text[i] !== '[') return null
  try {
    walk('')
  } catch {
    return null
  }
  return out
}

/** The decoded index of a JSON string's character whose source begins at or after text offset `pos`. */
function decodedAt(s: JsonString, pos: number): number {
  let lo = 0
  let hi = s.at.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s.at[mid] < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A JSON record's text as its fields (recordParts), whole or cut short (jsonStrings keeps the string fields up to the
 * cut); null when the text is not a JSON object. */
export function jsonRecordParts(text: string): QuotePart[] | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  const whole = parseJson(t)
  if (whole !== undefined) return whole && typeof whole === 'object' && !Array.isArray(whole) ? recordParts(whole) : null
  const found = jsonStrings(t)
  if (!found || !found.length) return null
  const record: Record<string, string> = {}
  for (const s of found) if (s.key && !(s.key in record)) record[s.key] = s.value
  return recordParts(record)
}

/** the input fields of a tool call that hold what it was asked to do (toolPart's `main`) */
const TOOL_MAIN = ['command', 'cmd', 'code', 'query', 'pattern', 'url', 'file_path', 'path', 'prompt']

/**
 * A passage of a JSON text as the string values it covers: each value decoded, with the passage's part of it and the
 * words around it, under its key. `base` is where the JSON starts in `whole`; `tool` names the tool whose input it is.
 * Null when the text is not JSON or the passage covers no string value.
 */
export function jsonSpanParts(whole: string, base: number, start: number, end: number, tool?: string): QuotePart[] | null {
  const strings = jsonStrings(whole, base)
  if (!strings) return null
  const out: QuotePart[] = []
  for (const s of strings) {
    if (s.end <= start || s.start >= end) continue
    const a = decodedAt(s, start)
    const b = decodedAt(s, end)
    if (b <= a) continue
    const mono = !!tool || OUTPUT_KEYS.test(s.key)
    const key = tool ? (TOOL_MAIN.includes(s.key) ? tool : `${tool} ${s.key}`) : s.key
    out.push({
      kind: 'span',
      before: lead(s.value.slice(0, a)),
      text: s.value.slice(a, b),
      after: trail(s.value.slice(b)),
      ...(key ? { key } : {}),
      ...(mono ? { mono: true } : looksMarkdown(s.value) ? { md: true } : {}),
    })
  }
  return out.length ? out : null
}

/** A tool_use block ("Bash\n{json input}") as the tool's name and what it was asked to do: its command, else the
 * input's fields on lines of their own. */
export function toolPart(text: string): QuotePart {
  const nl = text.indexOf('\n')
  const name = (nl < 0 ? text : text.slice(0, nl)).trim()
  const input = nl < 0 ? undefined : parseJson(text.slice(nl + 1))
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>
    const main = ['command', 'cmd', 'code', 'query', 'pattern', 'url', 'file_path', 'path', 'prompt'].find((k) => typeof o[k] === 'string')
    const rest = Object.entries(o).filter(([k]) => k !== main && k !== 'description')
    const lines = [main ? String(o[main]) : '', ...rest.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)].filter(Boolean)
    return { kind: 'tool', name, text: lines.join('\n') }
  }
  return { kind: 'tool', name, text: nl < 0 ? '' : text.slice(nl + 1).trim() }
}

type Block = { kind: string; text: string }

/** Whether prose is written in markdown: a code span or fence, bold, a heading, or list items, as an agent's message
 * or a board post usually is. Plain prose with none of these stays text, so a stray asterisk is never read as markup. */
export function looksMarkdown(text: string): boolean {
  return /```|`[^`\n]+`|\*\*[^*\n]+\*\*|^#{1,6} \S|^\s{0,3}(?:[-*] |\d+\. )\S[^\n]*\n\s{0,3}(?:[-*] |\d+\. )\S/m.test(text)
}

/** One block of a record as it reads: prose, markdown or code by the file's kind, a tool call, a tool's output, a
 * thought, an event's or a raw record's fields. */
function blockParts(b: Block, kind: 'md' | 'code' | 'prose'): QuotePart[] {
  const text = b.text ?? ''
  switch (b.kind) {
    case 'text':
      if (!text.trim()) return []
      // a message whose text is itself a JSON record reads as that record's fields
      return jsonRecordParts(text) ?? (kind === 'code' ? [{ kind: 'code', text }] : [{ kind: 'text', text, ...(kind === 'md' || looksMarkdown(text) ? { md: true } : {}) }])
    case 'tool_use':
      return [toolPart(text)]
    case 'tool_result':
      return text.trim() ? (jsonRecordParts(text) ?? [{ kind: 'code', text: text.replace(/^\s*\n/, '').replace(/\s+$/, '') }]) : []
    case 'thinking':
      return text.trim() ? [{ kind: 'text', text, dim: true }] : []
    case 'event':
    case 'raw': {
      const v = parseJson(text)
      return v !== undefined ? recordParts(v) : (jsonRecordParts(text) ?? [{ kind: 'code', text }])
    }
    default:
      return text.trim() ? [{ kind: 'text', text }] : []
  }
}

/** the characters of context a span shows on each side of its passage */
const SPAN_CONTEXT = 140

/** The words before a passage: from the start of the sentence or line it falls in, else the last SPAN_CONTEXT
 * characters from a word's start after an ellipsis, else nothing. */
function lead(text: string): string {
  const s = text.slice(-SPAN_CONTEXT)
  const t = s.replace(/\s+$/, '')
  let at = -1
  for (const m of t.matchAll(/\n|[.!?]\s+/g)) if ((m.index ?? 0) + m[0].length < t.length) at = (m.index ?? 0) + m[0].length
  // the space or the line break between the words and the passage, so a command's lines stay lines
  const gap = t.length < s.length ? (s.slice(t.length).includes('\n') ? '\n' : ' ') : ''
  if (at > 0) return t.slice(at).replace(/^\s+/, '') + gap
  if (s.length === text.length) return t.replace(/^\s+/, '') + gap
  // no sentence starts in reach: the words from the first space on, or none when the run is one token (a URL)
  const sp = t.search(/\s/)
  return sp < 0 ? '' : '…' + t.slice(sp).replace(/^\s+/, '') + gap
}

/** The words after a passage, to the end of its sentence or line where that falls in reach. */
function trail(text: string): string {
  const s = text.slice(0, SPAN_CONTEXT)
  const end = s.search(/[.!?](\s|$)|\n/)
  if (end >= 0) return s.slice(0, end + 1).replace(/\s+$/, '')
  return s.length < text.length ? s.replace(/\s+$/, '') + '…' : s
}

/** What an example card shows of one resolved ref, as parts (module note), its text cleaned and its code dedented. */
export function quoteParts(r: ResolvedRef): QuotePart[] {
  return rawParts(r).map(tidyPart)
}

function tidyPart(p: QuotePart): QuotePart {
  switch (p.kind) {
    case 'code':
      return { ...p, text: dedent(clean(p.text)) }
    case 'tool':
      return { ...p, text: dedent(clean(p.text)) }
    case 'text':
    case 'field':
      return { ...p, text: clean(p.text) }
    case 'span':
      return { ...p, before: clean(p.before), text: clean(p.text), after: clean(p.after) }
    default:
      return p
  }
}

function rawParts(r: ResolvedRef): QuotePart[] {
  const kind = fileKind(r.path)
  // a view's reader wrote the excerpt (a post of a message board): its words are the record's
  if (r.view) return r.excerpt ? [{ kind: 'text', text: r.excerpt, ...(kind === 'md' || looksMarkdown(r.excerpt) ? { md: true } : {}) }] : []
  const blocks = (r.blocks ?? []) as Block[]
  if (r.kind === 'span') {
    const k = typeof (r as { block?: unknown }).block === 'number' ? ((r as { block?: number }).block as number) : 0
    const whole = blocks[k]?.text ?? ''
    const start = (r as { start?: number }).start
    const end = (r as { end?: number }).end
    if (whole && typeof start === 'number' && typeof end === 'number' && end > start) {
      const bk = blocks[k]?.kind
      // a passage of a record kept as its JSON, of a tool call's input, or of a text or output that is JSON: the string
      // values it covers, decoded (jsonSpanParts)
      const nl = whole.indexOf('\n')
      const json =
        bk === 'tool_use' ? (nl >= 0 ? jsonSpanParts(whole, nl + 1, start, end, whole.slice(0, nl).trim()) : null) : jsonSpanParts(whole, 0, start, end)
      if (json) return json
      const mono = kind === 'code' || bk === 'tool_result' || bk === 'raw' || bk === 'event' || bk === 'tool_use'
      const md = !mono && (kind === 'md' || looksMarkdown(whole))
      return [{ kind: 'span', before: lead(whole.slice(0, start)), text: whole.slice(start, end), after: trail(whole.slice(end)), ...(mono ? { mono: true } : md ? { md: true } : {}) }]
    }
    return r.excerpt ? [{ kind: 'text', text: r.excerpt }] : []
  }
  if (r.kind === 'block') {
    const k = (r as { block?: number }).block ?? 0
    return blocks[k] ? blockParts(blocks[k], kind) : []
  }
  const records = (r as { records?: { blocks?: Block[] }[] }).records
  if (r.kind === 'range' && Array.isArray(records) && records.length) {
    // the lines of a text file are one text, a line to a line; the records of a JSONL file each read as a record
    const lines = records.map((x) => x.blocks ?? [])
    if (lines.every((bs) => bs.length <= 1 && (bs[0]?.kind ?? 'text') === 'text')) {
      const text = lines.map((bs) => bs[0]?.text ?? '').join('\n').replace(/^\n+|\s+$/g, '')
      if (!text) return []
      return kind === 'code' ? [{ kind: 'code', text }] : [{ kind: 'text', text, ...(kind === 'md' ? { md: true } : {}) }]
    }
    return lines.flatMap((bs) => bs.flatMap((b) => blockParts(b, kind)))
  }
  if (blocks.length) return blocks.flatMap((b) => blockParts(b, kind))
  // a database row reads as a record's fields, never as the JSON its excerpt is
  if (r.kind === 'row' && r.record && typeof r.record === 'object' && !Array.isArray(r.record)) return recordParts(r.record)
  // a whole file, a media file's note: the excerpt as the backend wrote it
  if (!r.excerpt) return []
  if (kind === 'code') return [{ kind: 'code', text: r.excerpt }]
  return [{ kind: 'text', text: r.excerpt, ...(kind === 'md' ? { md: true } : {}) }]
}

/** Markdown's marks taken off a line of it (bold, italics, code ticks, a code fence's lines, a heading's hashes, a
 * quote's bar), for a place that shows the words as plain text. */
export function plainMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}(```|~~~)[^\n]*$/gm, '')
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_\n]*?\S)\2(?=[\s).,;:!?]|$)/g, '$1$3')
    .replace(/`([^`\n]+)`/g, '$1')
}

/** The parts as one line of plain text, for a place with room for a phrase (a label card's example of a value): the
 * record's own words first, its fields only when it has no words. */
export function quoteLine(parts: readonly QuotePart[]): string {
  const words = parts.filter((p) => p.kind !== 'fields')
  const pick = words.length ? words : parts
  const one = (p: QuotePart): string => {
    switch (p.kind) {
      case 'fields':
        return p.pairs.map(([k, v]) => `${k} ${v}`).join(' · ')
      case 'tool':
        return `${p.name} ${p.text}`
      case 'span':
      case 'text':
      case 'field':
        return p.md ? plainMarkdown(p.text) : p.text
      default:
        return p.text
    }
  }
  return pick.map(one).join(' · ').replace(/\s+/g, ' ').trim()
}
