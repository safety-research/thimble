// The ref grammar (backend refs.py keeps it in step):
//   <path>#L<n> | <path>#L<n>-L<m> | <path>#L<n>.b<k> | <path>#L<n>.b<k>:c<a>-<b> | <path>
//   <path>.db|.sqlite|.sqlite3#<table>[/<pk>]
//   <path>.pdf#p<n> (`#page=<n>` reads the same) | <path>.json#/<json pointer> | <path>.csv|.tsv#row=<n>
//                      a page, a JSON document's value, a CSV's row after its header: a record of the file (records.py)
//   card:<id> | card:<id>@<exec> | card:<id>#<col>/<row> | card:<id>@out<i>#L<n>[-L<m>]   (`cell:` is an alias)
//   card:<id>#<path>#L<n>…   a file's line cited through the card that shows it: read as the file's line (<path>#L<n>…)
//   group:<id> | report:<slug>#<sid> | report:<slug>#p<pid> | concept:<id> | chat:<id>[#<index>] | ui:<name>
//   concept:<id>/<value>   one value of a label (the value raw or encoded)
//   call:<chat>/<n> | call:<chat>/<n>#L<a>[-L<b>]   the orientation's call number n, or lines of its whole output
//   view:<slug> | view:<slug>/<key>   a view, or a unit only that view defines
//   <path>#<locator>   any other part of a file, in the notation of the file's type (budget.xlsx#Q3!B2:B40,
//                      paper.pdf#p4): the file itself, with the locator kept as text; a view that claims the file and
//                      accepts the locator opens it
// A `card:` (or `cell:`) prefix is always a card; an unknown suffix reads as the card itself. A locator shaped like the
// line grammar (`L` alone or `L<digit>…`) that the line forms refused is no ref, as in refs.py.

export type ParsedRef =
  | { kind: 'cell'; cellId: string; exec?: number; col?: string; row?: string; out?: number; line?: number; endLine?: number }
  | { kind: 'group'; groupId: string }
  | { kind: 'report'; slug: string; unit?: string }
  | { kind: 'view'; slug: string; key?: string }
  | { kind: 'concept'; conceptId: string; value?: string }
  | { kind: 'chat'; chatId: string; eventIndex?: number }
  | { kind: 'call'; chat: string; n: number; line?: number; endLine?: number }
  | { kind: 'ui'; name: string }
  | { kind: 'table'; path: string; table: string }
  | { kind: 'row'; path: string; table: string; pk: string }
  | { kind: 'page'; path: string; page: number }
  | { kind: 'pointer'; path: string; pointer: string }
  | { kind: 'csvrow'; path: string; row: number }
  | { kind: 'record'; path: string; line: number }
  | { kind: 'range'; path: string; line: number; endLine: number }
  | { kind: 'block'; path: string; line: number; block: number }
  | { kind: 'span'; path: string; line: number; block: number; start: number; end: number }
  | { kind: 'path'; path: string; locator?: string }

// The fragment may hold spaces: a td span's column or row label is written raw by the model as often as encoded
// (`card:ccbf8cc0#endpoint forms requested/total files`), and refs.py's _CELL_TD resolves it, so the chip must parse it
// too. The column stops at the first `/`, as refs.py's does; labels stay as written and RefChip decodes them.
/** The prefix every card ref is written with; `cell:` is read as the same (backend cite.CARD_PREFIXES). */
export const CARD = 'card:'
/** Whether a string is a card's ref, by either prefix. */
export const isCardRef = (ref: string): boolean => ref.startsWith('card:') || ref.startsWith('cell:')
/** `card:<id>` for a card id. */
export const cardRef = (id: string): string => `${CARD}${id}`
const CELL_RE = /^(?:card|cell):([A-Za-z0-9_-]+)(?:@(out)?(\d+))?(?:#(.*))?$/
const CELL_LINES_RE = /^L(\d+)(?:-L?(\d+))?$/
const CELL_TD_RE = /^([^/]+)\/(.+)$/

function parseCellRef(ref: string): ParsedRef | null {
  const m = CELL_RE.exec(ref)
  if (!m) {
    const id = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(ref)
    return id ? { kind: 'cell', cellId: id[1] } : null
  }
  const [, cellId, isOut, num, frag] = m
  const whole: ParsedRef = num != null && !isOut ? { kind: 'cell', cellId, exec: Number(num) } : { kind: 'cell', cellId }
  if (!frag) return whole
  // a file's line cited through the card that shows it (`card:<id>#runs/a.jsonl#L103.b0:c12-109`, a model's citation of
  // an example card's excerpt) is the file's line, where it opens, as refs.py reads it
  const line = isOut ? null : fileLine(frag)
  if (line) return line
  const lines = CELL_LINES_RE.exec(frag)
  if (lines) {
    if (!isOut) return whole
    const line = +lines[1]
    const end = lines[2] != null ? +lines[2] : undefined
    return end != null && end > line ? { kind: 'cell', cellId, out: +num, line, endLine: end } : { kind: 'cell', cellId, out: +num, line }
  }
  const td = CELL_TD_RE.exec(frag)
  if (td) return { kind: 'cell', cellId, col: td[1], row: td[2] }
  return whole
}

/** A call ref's parts: the whole call, or its output's lines. A fragment that is not a line form is no ref, as a
 * mistyped line of a card's output is not: the citation check reports it rather than the chip opening the whole call. */
function parseCallRef(chat: string, n: number, frag: string | undefined): ParsedRef | null {
  if (frag == null) return { kind: 'call', chat, n }
  const lines = CELL_LINES_RE.exec(frag)
  if (!lines) return null
  const line = +lines[1]
  const end = lines[2] != null ? +lines[2] : undefined
  return end != null && end > line ? { kind: 'call', chat, n, line, endLine: end } : { kind: 'call', chat, n, line }
}

/** `call:<chat>/<n>`, with `#L<a>` or `#L<a>-L<b>` for lines of its output. */
export function callRef(chat: string, n: number, line?: number, endLine?: number): string {
  const base = `call:${chat}/${n}`
  if (line == null) return base
  return endLine != null && endLine > line ? `${base}#L${line}-L${endLine}` : `${base}#L${line}`
}

// A file's path may hold spaces (`run 1/agent one.jsonl`), never at its ends and never a newline or `#`, as refs.py
// reads it. A path with a space and no line fragment counts only when it looks like a file, so bracketed prose is not
// read as a path.
const FP = String.raw`[^#\s](?:[^#\n]*[^#\s])?`
const DATABASE_RE = new RegExp(String.raw`^(${FP}\.(?:db|sqlite|sqlite3))#([A-Za-z_][A-Za-z0-9_]*)(?:\/(.+))?$`)
const PAGE_RE = new RegExp(String.raw`^(${FP}\.[Pp][Dd][Ff])#(?:page=|p)(\d+)$`)
const POINTER_RE = new RegExp(String.raw`^(${FP}\.[Jj][Ss][Oo][Nn])#(\/[^\n]*)$`)
const CSV_ROW_RE = new RegExp(String.raw`^(${FP}\.(?:[Cc][Ss][Vv]|[Tt][Ss][Vv]))#row=(\d+)$`)
const SPAN_RE = new RegExp(String.raw`^(${FP})#L(\d+)\.b(\d+):c(\d+)-(\d+)$`)
const BLOCK_RE = new RegExp(String.raw`^(${FP})#L(\d+)\.b(\d+)$`)
const RANGE_RE = new RegExp(String.raw`^(${FP})#L(\d+)-L(\d+)$`)
const RECORD_RE = new RegExp(String.raw`^(${FP})#L(\d+)$`)
const PATH_RE = new RegExp(String.raw`^(${FP})$`)
const LOCATOR_RE = /^([^#\s:@](?:[^#\n:]*[^#\s:])?)#(\S+)$/
const fileLike = (path: string): boolean => !path.includes(' ') || /\/|\.[A-Za-z0-9]{1,8}$/.test(path)

/** `ref` itself, or the file's line when it is one cited through a card (parseCellRef): the ref the surface opens. */
export function plainRef(ref: string): string {
  const m = isCardRef(ref) ? CELL_RE.exec(ref.trim()) : null
  return m && m[4] && !m[2] && fileLine(m[4]) ? m[4] : ref
}

/** A file's line, block, span or range of lines (the line forms of parseRef), or null for any other ref. */
function fileLine(ref: string): ParsedRef | null {
  let m: RegExpMatchArray | null
  if ((m = ref.match(SPAN_RE))) return { kind: 'span', path: m[1], line: +m[2], block: +m[3], start: +m[4], end: +m[5] }
  if ((m = ref.match(BLOCK_RE))) return { kind: 'block', path: m[1], line: +m[2], block: +m[3] }
  if ((m = ref.match(RANGE_RE))) return { kind: 'range', path: m[1], line: +m[2], endLine: +m[3] }
  if ((m = ref.match(RECORD_RE))) return { kind: 'record', path: m[1], line: +m[2] }
  return null
}

export function parseRef(ref: string): ParsedRef | null {
  ref = ref.trim()
  let m: RegExpMatchArray | null
  if (isCardRef(ref)) return parseCellRef(ref)
  if ((m = ref.match(/^group:([A-Za-z0-9_-]+)$/))) return { kind: 'group', groupId: m[1] }
  if ((m = ref.match(/^report:([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?$/))) return m[2] ? { kind: 'report', slug: m[1], unit: m[2] } : { kind: 'report', slug: m[1] }
  // the backend's slug (views.SLUG_RE), then any key the view defines
  if ((m = ref.match(/^view:([a-z0-9][a-z0-9-]{0,39})(?:\/(\S+))?$/))) return m[2] ? { kind: 'view', slug: m[1], key: m[2] } : { kind: 'view', slug: m[1] }
  if ((m = ref.match(/^concept:([A-Za-z0-9_-]+)(?:\/(.+))?$/))) return m[2]?.trim() ? { kind: 'concept', conceptId: m[1], value: decodeLabel(m[2].trim()) } : { kind: 'concept', conceptId: m[1] }
  if ((m = ref.match(/^chat:([A-Za-z0-9_-]+)(?:#(\d+))?$/))) return { kind: 'chat', chatId: m[1], eventIndex: m[2] ? Number(m[2]) : undefined }
  if ((m = ref.match(/^call:([A-Za-z0-9_-]+)\/(\d+)(?:#(.*))?$/))) return parseCallRef(m[1], Number(m[2]), m[3])
  if ((m = ref.match(/^ui:([A-Za-z0-9_.-]+)$/))) return { kind: 'ui', name: m[1] }
  if ((m = ref.match(DATABASE_RE))) {
    return m[3] ? { kind: 'row', path: m[1], table: m[2], pk: m[3] } : { kind: 'table', path: m[1], table: m[2] }
  }
  if ((m = ref.match(PAGE_RE)) && +m[2] >= 1) return { kind: 'page', path: m[1], page: +m[2] }
  if ((m = ref.match(POINTER_RE))) return { kind: 'pointer', path: m[1], pointer: m[2] }
  if ((m = ref.match(CSV_ROW_RE)) && +m[2] >= 1) return { kind: 'csvrow', path: m[1], row: +m[2] }
  const line = fileLine(ref)
  if (line) return line
  if ((m = ref.match(PATH_RE)) && !ref.includes(':') && fileLike(m[1])) return { kind: 'path', path: m[1] }
  if ((m = ref.match(LOCATOR_RE)) && fileLike(m[1])) return /^L(?:\d|$)/.test(m[2]) ? null : { kind: 'path', path: m[1], locator: m[2] }
  return null
}

const LOCATOR_LABEL_MAX = 18

/** A record of another reader than lines as a chip names it after its file: `p. 4`, `row 12`, `/runs/3`. */
function recordPart(p: Extract<ParsedRef, { kind: 'page' | 'pointer' | 'csvrow' }>): string {
  return p.kind === 'page' ? `p. ${p.page}` : p.kind === 'csvrow' ? `row ${p.row}` : locatorLabel(p.pointer)
}

/** A locator as a chip shows it, cut to LOCATOR_LABEL_MAX characters (chips stay short; the hover has the whole ref). */
function locatorLabel(locator: string): string {
  return locator.length > LOCATOR_LABEL_MAX ? `${locator.slice(0, LOCATOR_LABEL_MAX - 1)}…` : locator
}

/** The kinds that name one record of a file (backend refs.RECORD_KINDS). */
const RECORD_KINDS = new Set(['record', 'row', 'page', 'pointer', 'csvrow'])

/** A record's ref as label rows key it (backend records.canon): a PDF's `#page=<n>` as `#p<n>`; any other ref as it is. */
export function recordKey(ref: string): string {
  const m = /^(.+\.pdf)#(?:p|page=?)(\d+)$/i.exec(ref.trim())
  return m ? `${m[1]}#p${+m[2]}` : ref.trim()
}

/** The file of a ref that names one record of it (a line, a database row, a page, a JSON value, a CSV row, or a
 * `<path>#<locator>` a view's reader names, whose file name has an extension), with the line for a line; null for any
 * other ref (backend records.split). */
export function recordOf(ref: string): { path: string; line?: number } | null {
  const p = parseRef(ref)
  if (!p || !('path' in p)) return null
  if (p.kind === 'record') return { path: p.path, line: p.line }
  return RECORD_KINDS.has(p.kind) || (p.kind === 'path' && p.locator && /\.[A-Za-z0-9]{1,8}$/.test(p.path)) ? { path: p.path } : null
}

/** The fragment of a ref into `path` (the text after `#`), or null when the ref names another file or no fragment. */
export function fragmentIn(ref: string | undefined, path: string): string | null {
  if (!ref) return null
  ref = plainRef(ref)
  const p = parseRef(ref)
  if (!p || !('path' in p) || p.path !== path) return null
  const i = ref.indexOf('#')
  return i < 0 ? null : ref.slice(i + 1)
}

/** The line a fragment starts at, when it names one (`L12`, `L12-L20`, `L12.b3`): where a file opens when nothing
 * understands the rest of the fragment. */
export function nearestLine(fragment: string | null): number | null {
  const m = fragment ? /^L(\d+)/.exec(fragment) : null
  return m ? Number(m[1]) : null
}

/** The corpus path a ref points into, or null for a ref that names no file. */
export function refPath(ref: string): string | null {
  const p = parseRef(ref)
  return p && 'path' in p ? p.path : null
}

/** `batch2-x/agents/a.jsonl` -> { run: 'batch2-x', rest: 'agents/a.jsonl' }; flat paths have run ''. */
export function splitRun(path: string): { run: string; rest: string } {
  const parts = path.split('/')
  const parent = parts.length > 1 ? parts[parts.length - 2] : ''
  const depth = parent === 'agents' || parent === 'prompts' ? 2 : 1
  if (parts.length <= depth) return { run: '', rest: path }
  return { run: parts.slice(0, parts.length - depth).join('/'), rest: parts.slice(parts.length - depth).join('/') }
}

const RUN_SEP = ' › '

/**
 * The folder a chip names a nested file by (splitRun's run): the first folder of the run holding a digit (`team-6`,
 * `trial-03`), since same-named files sit under many such folders; else the run's last folder. `elided` when folders
 * lie between it and the file's name. Null for a flat path.
 */
export function runFolder(path: string): { name: string; elided: boolean } | null {
  const { run } = splitRun(path)
  const folders = run.split('/').filter(Boolean)
  if (!folders.length) return null
  const at = folders.findIndex((f) => /\d/.test(f))
  const i = at < 0 ? folders.length - 1 : at
  return { name: folders[i], elided: i < folders.length - 1 }
}

/** A nested file's prefix on a chip: its run's folder (runFolder), with `… ›` where folders are left out. */
function runPrefix(path: string): string {
  const f = runFolder(path)
  return f ? `${f.name}${RUN_SEP}${f.elided ? `…${RUN_SEP}` : ''}` : ''
}

/** A file ref's path when its chip leaves folders out of it (a chip names one folder at most), for the hover to show
 * whole; null otherwise. */
export function hiddenPath(ref: string): string | null {
  const p = parseRef(ref)
  return p && 'path' in p && p.path.split('/').filter(Boolean).length > 2 ? p.path : null
}

export function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  const last = n % 10
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`
}

/** `line 2 of the output`, `lines 2–3 of the 2nd output`; '' for a ref that is not an output span. */
export function cellSpanLabel(p: { out?: number; line?: number; endLine?: number }): string {
  if (p.out == null || p.line == null) return ''
  const lines = p.endLine != null ? `lines ${p.line}–${p.endLine}` : `line ${p.line}`
  return `${lines} of the ${p.out === 0 ? 'output' : `${ordinal(p.out + 1)} output`}`
}

/** the characters a column's or a row's label keeps on a chip */
const PART_LABEL_MAX = 20

/**
 * The name a chip gives a ref into part of a card when no value is written with it: the table's cell as
 * `column · row`, printed lines as `line 8` or `lines 8–9`, after the card's name when the chip sits outside that card
 * (`own` false). Null for a ref to a whole card.
 */
export function cardPartLabel(p: { col?: string; row?: string; out?: number; line?: number; endLine?: number }, name: string, own: boolean): string | null {
  let part: string | null = null
  // each label cut so the chip stays short; the hover shows the cell in its table
  const short = (s: string) => (s.length > PART_LABEL_MAX ? `${s.slice(0, PART_LABEL_MAX - 1).trimEnd()}…` : s)
  if (p.col != null && p.row != null) part = `${short(decodeLabel(p.col))} · ${short(decodeLabel(p.row))}`
  else if (p.out != null && p.line != null) part = p.endLine != null ? `lines ${p.line}–${p.endLine}` : `line ${p.line}`
  if (part == null) return null
  return own ? part : `${name} · ${part}`
}

/** A short label for a chip. Nested paths carry one folder as a prefix (runFolder): `batch2 › agent-03.jsonl L412`,
 * `team-6 › … › notes.json L2`. A file keeps its extension wherever its name shows (`events.jsonl`, never
 * `events`). */
export function refLabel(ref: string): string {
  const p = parseRef(ref)
  if (!p) return ref
  // one folder, not every folder a file sits in, so a chip stays short where a paragraph cites several records of one
  // run, and the one that tells same-named files apart
  const base = (path: string) => {
    const { rest } = splitRun(path)
    return `${runPrefix(path)}${rest.split('/').pop() ?? rest}`
  }
  const runOf = runPrefix
  switch (p.kind) {
    case 'cell':
      return `card${p.col != null ? ` · ${p.col}/${p.row}` : p.out != null ? ` · ${cellSpanLabel(p)}` : ''}`
    case 'group':
      return 'group'
    case 'report':
      return p.unit ? `${p.slug} · ${p.unit.startsWith('p') ? 'paragraph' : 'sentence'}` : p.slug
    case 'view':
      return p.key ? `${p.slug} · ${locatorLabel(p.key)}` : `view ${p.slug}`
    case 'concept':
      return p.value ? `label · ${locatorLabel(p.value)}` : 'label'
    case 'chat':
      return `chat${p.eventIndex != null ? ` #${p.eventIndex}` : ''}`
    case 'call':
      return `call ${p.n}${p.line != null ? ` · ${p.endLine != null ? `lines ${p.line}–${p.endLine}` : `line ${p.line}`}` : ''}`
    case 'ui':
      return p.name
    case 'table':
      return `${runOf(p.path)}${p.table}`
    case 'row':
      return `${runOf(p.path)}${p.table}/${p.pk}`
    case 'page':
    case 'pointer':
    case 'csvrow':
      return `${base(p.path)} ${recordPart(p)}`
    case 'record':
      return `${base(p.path)} L${p.line}`
    case 'range':
      return `${base(p.path)} L${p.line}-${p.endLine}`
    case 'block':
      return `${base(p.path)} L${p.line}.b${p.block}`
    case 'span':
      return `${base(p.path)} L${p.line}.b${p.block}`
    case 'path':
      return p.locator ? `${base(p.path)} · ${locatorLabel(p.locator)}` : base(p.path)
  }
}

/**
 * The address an example card shows over each record it quotes (canvas/bodies ExampleBody): the file and the record's
 * line, as in `notes.jsonl L5371`, after its run's folder for a nested path (runFolder). A passage's block and
 * characters are left out. A ref that is not a file's reads as refLabel.
 */
export function addressLabel(ref: string): string {
  const p = parseRef(ref)
  if (!p || !(p.kind === 'record' || p.kind === 'range' || p.kind === 'block' || p.kind === 'span' || p.kind === 'path' || p.kind === 'page' || p.kind === 'pointer' || p.kind === 'csvrow'))
    return refLabel(ref)
  const { rest } = splitRun(p.path)
  const file = `${runPrefix(p.path)}${rest.split('/').pop() ?? rest}`
  if (p.kind === 'path') return p.locator ? `${file} · ${locatorLabel(p.locator)}` : file
  if (p.kind === 'page' || p.kind === 'pointer' || p.kind === 'csvrow') return `${file} ${recordPart(p)}`
  return p.kind === 'range' ? `${file} L${p.line}-${p.endLine}` : `${file} L${p.line}`
}

/** A td span's percent-encoded column or row label as the table shows it (backend cite.decode_label). */
export function decodeLabel(s: string): string {
  if (!s.includes('%')) return s
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** The characters a td span's label escapes besides white space and controls (backend cite._LABEL_ESCAPE). */
const LABEL_ESCAPE = new Set('%/|#[]*_~`\\<>&')

/** A column or row label as a td span writes it (backend cite.encode_label): LABEL_ESCAPE, white space and controls as
 * %XX per UTF-8 byte, the rest as it is. */
export function encodeLabel(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    const escape = LABEL_ESCAPE.has(ch) || /\s/u.test(ch) || code < 0x20 || code === 0x7f
    out += escape ? Array.from(new TextEncoder().encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('') : ch
  }
  return out
}

/** `card:<id>#<col>/<row>` for a table's cell, its labels encoded; null for a blank label, which no ref can name
 * (backend cite.td_ref). */
export function tdRef(cellId: string, col: string, row: string): string | null {
  if (!col.trim() || !row.trim()) return null
  return `${CARD}${cellId}#${encodeLabel(col)}/${encodeLabel(row)}`
}

/** A value-ref token `<display>|<ref>` split at its first `|`; a bare token has no display. */
export function splitValueRef(token: string): { value?: string; ref: string } {
  const i = token.indexOf('|')
  if (i < 0) return { ref: token.trim() }
  const value = token.slice(0, i).trim().replace(/\\$/, '').trim()
  return { value, ref: token.slice(i + 1).trim() }
}

/** A citation's text as the analyst reads it: a whole number of five digits or more, or of four outside the years 1800
 * to 2199, takes thousands separators (`6355` reads `6,355`), sign and decimals kept; numbers with a leading zero, ids
 * and other text are left as written. */
export function shownValue(value: string): string {
  const m = /^([-+−]?)(\d{4,})(\.\d+)?$/.exec(value.trim())
  if (!m) return value
  const [, sign, whole, frac = ''] = m
  if (whole.startsWith('0') || (whole.length === 4 && !frac && Number(whole) >= 1800 && Number(whole) <= 2199)) return value
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac}`
}

/** The surface a ref belongs to, which a click on its chip switches to. */
export type Surface = 'canvas' | 'report' | 'files'

export function surfaceOf(ref: string): Surface | null {
  const p = parseRef(ref)
  if (!p) return null
  switch (p.kind) {
    case 'cell':
    case 'group':
    case 'concept':
      return 'canvas'
    case 'report':
      return 'report'
    case 'view':
    case 'table':
    case 'row':
    case 'page':
    case 'pointer':
    case 'csvrow':
    case 'record':
    case 'range':
    case 'block':
    case 'span':
    case 'path':
      return 'files'
    default:
      return null
  }
}
