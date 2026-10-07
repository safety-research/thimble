// Pure helpers of thimble-term (no `$`), shared by the hooks module, the surface modules and the tests.
//
// - citations(text): the [[display|ref]] and [[ref]] citations of a reply, and the link form [display](ref).
// - parseReply(text): a reply block cut into Markdown chunks, card embeds (a line holding only [[card:<id>]]) and rich
//   blocks (a paragraph, list item, heading, quote or table that holds a citation), each rich block as inline runs.
// - shownMatches / valueIn: thimble's number comparison (backend/app/cite.py), for the verification script's result.
// - cut / clip / windowAt: the one cut of thimble-term, at a word; quoted: words in quotation marks of a kind they do
//   not hold; formatted: a table column's number format, as the browser's table writes it.

export type Citation = { raw: string; ref: string; display: string | null }

export type Run = { text: string; b?: boolean; i?: boolean; code?: boolean; u?: boolean; cite?: Citation }

/** `gap`: a blank line stood before the block in the reply, so it is drawn one row below the one before it. */
export type Block =
  | { type: 'md'; text: string; gap: boolean }
  | { type: 'card'; id: string; gap: boolean; caption?: string }
  | { type: 'rich'; prefix: string; heading: number; quote: boolean; runs: Run[]; gap: boolean; table?: TableRuns }

/** A Markdown table that holds citations, drawn by thimble-term (the `|` inside `[[value|ref]]` breaks a GFM table):
 *  its rows of cells of runs, the first row the header, and each column's alignment. A table block's `runs` are its
 *  cells' runs in reading order, so its chips are numbered as a paragraph's are. */
export type TableRuns = { rows: Run[][][]; align: ('left' | 'right' | 'center')[] }

const FENCE_RE = /```[\s\S]*?```|`[^`\n]*`/g
const LINK_RE = /(?<![\[!])\[([^\[\]\n]*)\]\(\s*(?:<([^<>\n]+)>|((?:[^()\s<>]|\([^()\s]*\))+))\s*\)/g
const WEB_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:)/i
const REF_SHAPE = /^(?:call:[A-Za-z0-9_-]+(?:#L\d+(?:-L?\d+)?)?|card:[A-Za-z0-9_-]+(?:@[A-Za-z0-9_]+)?(?:#.*)?|concept:[A-Za-z0-9_-]+(?:\/[^\s()]+)?|report:[A-Za-z0-9_-]+(?:#p?[A-Za-z0-9_-]+)?|[^\s:#]+#\S+|[^\s:#()]+\.[A-Za-z][A-Za-z0-9]{0,7})$/
const LABEL_REF = /^concept:([A-Za-z0-9_-]+)(?:\/(.+))?$/
const REPORT_REF = /^report:([A-Za-z0-9_-]+)(?:#(p?[A-Za-z0-9_-]+))?$/

/** A link to a document, or to one of its paragraphs (`p<id>`), sentences or headings (`report:<slug>#<unit>`): the
 *  document's slug and the unit; null for any other ref. */
export function reportRef(ref: string): { slug: string; unit: string } | null {
  const m = REPORT_REF.exec(ref.trim())
  return m ? { slug: m[1]!, unit: m[2] ?? '' } : null
}

// what names a label and a document's passage a reply links to without words, as their resolution (term.ts
// resolveCitations) and the lists read named them: a label's name by its id; a document's title by its slug and a
// passage's words by its ref
const labelNames = new Map<string, string>()
const docTitles = new Map<string, string>()
const passages = new Map<string, string>()

/** Whether thimble's agents list a running chat that follows a run of the label named `name` (a `labels` agent titled
 *  `label <name>`): a run the session's own process holds, which `thimble state` does not show as the label's run. */
export function labelRunning(agents: readonly { label: string; state: string; role: string }[], name: string): boolean {
  return Boolean(name) && agents.some(a => a.role === 'labels' && a.state === 'running' && a.label === `label ${name}`)
}

/** How a label's runs stand, as every place that names it says it (home, the labels list, its panel, its card; live
 *  check term-fix9, quirk 4: the list and the panel said `not run yet` while home said `◌ labeling`): `running` while a
 *  run goes on (thimble's, or main's that a chat follows: labelRunning), `ran` once a run ended, `stopped` for records
 *  labeled with no run that ended (a quit stopped its first run part way), `labeled` the records labeled so far, and
 *  `total` its run's size (the run's own, else the scope's size `thimble state` counted). */
export type LabelState = { running: boolean; ran: boolean; stopped: boolean; labeled: number; total: number | null }

type LabelRunLike = { status?: string; total?: number; matched_total?: number | null; stopped?: boolean; labeled?: number } | null | undefined

export function labelState(
  l: { name?: string; last_run?: LabelRunLike; applications?: LabelRunLike[]; label_stats?: { counts?: Record<string, number>; n_labeled?: number } | null; scope_total?: number },
  agents: readonly { label: string; state: string; role: string }[],
): LabelState {
  const last = l.last_run ?? l.applications?.at(-1) ?? null
  const running = (l.last_run?.status ?? '') === 'running' || labelRunning(agents, l.name ?? '')
  const labeled = l.label_stats?.n_labeled ?? Object.values(l.label_stats?.counts ?? {}).reduce((a, b) => a + b, 0)
  const total = typeof last?.matched_total === 'number' ? last.matched_total : typeof last?.total === 'number' ? last.total : typeof l.scope_total === 'number' ? l.scope_total : null
  return { running, ran: Boolean(last) && last?.status !== 'running', stopped: !running && !last && labeled > 0, labeled, total }
}

/** A label's state in words while it has no run that ended: `◌ labeling`, with the records labeled so far and of how
 *  many when known (`◌ labeling 3,000 of 4,579`); `stopped at 3,150 of 4,579`; `not run yet`. '' once a run ended. */
export function labelStateWords(st: LabelState): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const of = st.total !== null && st.total >= st.labeled ? ` of ${n(st.total)}` : ''
  if (st.running) return st.labeled ? `◌ labeling ${n(st.labeled)}${of}` : '◌ labeling'
  if (st.ran) return ''
  return st.stopped ? `stopped at ${n(st.labeled)}${of}` : 'not run yet'
}

/** A label's name, noted when the labels are read or a link to it resolves, so a link to it names it in words. */
export function noteLabelName(id: string, name: string | undefined): void {
  if (id && name) labelNames.set(id, name)
}

/** A document's title (by its slug) and a passage's words (by its ref), noted when a link to it resolves or the documents
 *  are read, so a link to it names it in words. */
export function noteDocPlace(ref: string, title: string | undefined, words = ''): void {
  const r = reportRef(ref)
  if (!r) return
  if (title) docTitles.set(r.slug, title)
  if (r.unit && words.trim()) passages.set(`report:${r.slug}#${r.unit}`, words.replace(/\s+/g, ' ').trim())
}

/** The kinds of a thread's `error` record that end its run as a stop, not a failure: the analyst's stop, and the Claude
 *  Code session that ended under it (backend threads.SESSION_ENDED, as when the analyst quits). */
export const STOP_KINDS: readonly string[] = ['stopped', 'session-ended']

/** Whether a thread's turn ended as a stop, not a failure: its record said so (`stopped`), or its words do (live check
 *  term-fix6, new quirk 2: a thread stopped by quitting showed a red failure). */
export function stoppedTurn(t: { state: string; a: string; stopped?: boolean }): boolean {
  return t.state === 'error' && (Boolean(t.stopped) || /^\s*stopped\b/i.test(t.a))
}

/** A citation of a label, or of one of its values (`[[33|concept:<id>/yes]]`, or `[33](concept:<id>/yes)` as main writes
 *  it for the terminal): the label's id and the value; null for any other ref. It is a link that opens the label at the
 *  value, never a place a check reads. */
export function labelRef(ref: string): { id: string; value: string } | null {
  const m = LABEL_REF.exec(ref.trim())
  return m ? { id: m[1]!, value: m[2] ? decodeURIComponent(m[2]) : '' } : null
}
export const EMBED_RE = /^\s*(?:\[\[card:([A-Za-z0-9_-]+)\]\]|!\[[^\]\n]*\]\(card:([A-Za-z0-9_-]+)\))\s*$/

function make(display: string | null, ref: string): Citation {
  return { raw: display === null ? `[[${ref}]]` : `[[${display}|${ref}]]`, ref, display }
}

function spanCitation(inner: string): Citation | null {
  const t = inner.trim()
  const bar = t.lastIndexOf('|')
  const display = bar >= 0 ? t.slice(0, bar).trim() : null
  const ref = (bar >= 0 ? t.slice(bar + 1) : t).trim()
  return ref ? make(display, ref) : null
}

const CITE_MAX = 2000 // characters a citation may span, so a stray [[ costs little

/** Where the citation that opens with the `[[` at `at` ends (just past its `]]`), or -1 when none opens there. A shown
 *  value may hold brackets, as a quoted line of code or JSON does (`[["counts[\"dse\"] += 1"|call:x#L2]]`); the place
 *  after its last bar holds no bracket. The citation ends at the first `]]` that closes such a place, provided the value
 *  before the bar holds `[[` only inside balanced brackets (a quoted JSON list). One that holds a bracket lies on one
 *  line, and none runs past a blank line, so code in prose is not taken for a citation. */
export function citeEnd(text: string, at: number): number {
  if (!text.startsWith('[[', at)) return -1
  const stop = Math.min(text.length, at + CITE_MAX)
  // the place since the last bar (all of it, with no bar): whether it holds a bracket, and whether any words
  let placeBracket = false
  let placeWords = false
  // the value so far, and as it stood at the last bar
  let depth = 0
  let unbalanced = false
  let double = false
  let valueOk = true
  let bracket = false
  let lined = false
  for (let k = at + 2; k < stop; k++) {
    const ch = text[k]!
    if (ch === ']' && text[k + 1] === ']' && !placeBracket && placeWords && valueOk) return k + 2
    if (ch === '|') {
      valueOk = !double || (depth === 0 && !unbalanced)
      placeBracket = false
      placeWords = false
    } else if (ch === '[' || ch === ']') {
      if (lined) return -1
      bracket = placeBracket = true
      if (ch === '[' && k > at + 2 && text[k - 1] === '[') double = true
      depth += ch === '[' ? 1 : -1
      if (depth < 0) unbalanced = true
    } else if (ch === '\n') {
      if (bracket) return -1
      lined = true
      let j = k + 1
      while (text[j] === ' ' || text[j] === '\t') j++
      if (text[j] === '\n') return -1
    } else if (ch !== ' ' && ch !== '\t') placeWords = true
  }
  return -1
}

/** Each `[[...]]` citation of a text as written, where it starts and where it ends, in order. */
export function citeSpans(text: string): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = []
  for (let i = text.indexOf('[['); i >= 0; ) {
    const end = citeEnd(text, i)
    if (end >= 0) out.push({ at: i, end })
    i = text.indexOf('[[', end >= 0 ? end : i + 1)
  }
  return out
}

function linkCitation(shown: string, target: string): Citation | null {
  // a file's place with its spaces encoded (`my%20file.md#L3`) as the file names it; a label's value keeps its encoding,
  // which labelRef decodes (`concept:<id>/mentions%20June`: live check term-fix9, it drew as its raw words)
  const raw = target.trim()
  const ref = raw.startsWith('concept:') ? raw : raw.replaceAll('%20', ' ')
  if (!ref || WEB_RE.test(ref) || shown.includes('|') || !REF_SHAPE.test(ref)) return null
  const s = shown.trim()
  return make(s === '' || s === '↗' ? null : s, ref)
}

/** Every citation of a text in order, deduplicated by its `[[...]]` spelling; code spans and fences left out. */
export function citations(text: string): Citation[] {
  const found: { at: number; c: Citation }[] = []
  const clean = text.replace(FENCE_RE, m => ' '.repeat(m.length))
  for (const sp of citeSpans(clean)) {
    const c = spanCitation(text.slice(sp.at + 2, sp.end - 2))
    if (c) found.push({ at: sp.at, c })
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

/** A text with each Markdown link that is a citation (`[4,579](README.md#L3)`, the form main writes for the terminal)
 *  in its `[[…]]` spelling (`[[4,579|README.md#L3]]`); a web link stays as written. */
export function linksAsSpans(text: string): string {
  return text.replace(LINK_RE, (m: string, shown: string, a?: string, b?: string) => linkCitation(shown, a ?? b ?? '')?.raw ?? m)
}

/** A citation that names only its place, with no value or words of its own (`[↗](ref)`, `[[ref]]`): a card cited whole,
 *  a card's printed line, a file's line; a label's link is none. */
export function placeOnly(c: Citation): boolean {
  return c.display === null && !labelRef(c.ref)
}

/** Whether a citation that names only its place reads as a reference in parentheses, given the words after it: a card
 *  cited whole always; another place where it ends a clause (`…on 18 June [↗](card:…@out0#L1). That is…`), never as
 *  words of the sentence (live check term-fix6, new quirk 5); one the sentence goes on after (`See [[README.md#L5]] for
 *  the format.`) reads as its words. */
export function asReference(c: Citation, after: string): boolean {
  return placeOnly(c) && (Boolean(bareCard(c)) || /^\s*(?:[.,;:!?)]|$)/.test(after))
}

/** A text with each Markdown link that is a citation (`[4,579](README.md#L3)`, the form main writes for the terminal)
 *  as its shown words; a web link stays as written. */
export function plainLinks(text: string): string {
  return text.replace(LINK_RE, (m: string, shown: string, a?: string, b?: string) => {
    const c = linkCitation(shown, a ?? b ?? '')
    return c ? (c.display ?? chipLabel(c)) : m
  })
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

// the cards' questions read so far, by id (term.ts loadCards notes each): what names a card a reply cites without words
const questions = new Map<string, string>()

/** A card's question, noted when the card is read, so a citation of the card without words names it by its question. */
export function noteQuestion(id: string, question: string | undefined): void {
  if (!question) return
  questions.delete(id)
  questions.set(id, question)
  if (questions.size > 2000) questions.delete(questions.keys().next().value!)
}

/** A card's question as noted (noteQuestion); '' for a card not read yet. */
export function questionOf(id: string): string {
  return questions.get(id) ?? ''
}

/** The card a citation names whole, with no words and no place on it (`[[card:<id>]]`, as a sentence ends with it), or
 *  ''. */
export function bareCard(c: Citation): string {
  return c.display === null ? (/^(?:card|cell):([A-Za-z0-9_-]+)$/.exec(c.ref)?.[1] ?? '') : ''
}

/** A card named by its question in words: `card “<question>”`, the question cut at a word; `a card` while it is not
 *  read. */
export function cardWords(question: string, n = 40): string {
  return question.trim() ? `card ${quoted(clip(question, n))}` : 'a card'
}

/** A citation of lines a card printed (`card:<id>@out0#L1`): the card, the lines, and the place in words, `card "…"
 *  output line 1` (`a card's output line 1` while the card is not read); null for any other ref. */
export function outputLine(ref: string): { card: string; first: number; last: number; words: string } | null {
  const m = /^(?:card|cell):([A-Za-z0-9_-]+)@out\d+#L(\d+)(?:-L?(\d+))?$/.exec(ref.trim())
  if (!m) return null
  const [first, last] = [Number(m[2]), Number(m[3] ?? m[2])]
  const lines = last !== first ? `lines ${first}-${last}` : `line ${first}`
  const q = questionOf(m[1]!)
  return { card: m[1]!, first, last, words: q ? `${cardWords(q)} output ${lines}` : `a card's output ${lines}` }
}

/** What a chip says: the shown value, or a short name of the place for a citation without one; a card cited whole by
 *  its question. */
export function chipLabel(c: Citation): string {
  if (c.display !== null) return clip(c.display, 40)
  // a label's link and a document's by their names, never their ids (live check term-fix8, quirk 3: `concept:eb534ca4`
  // and `↗ (report:report#4255ef27)` showed in a reply)
  const lr = labelRef(c.ref)
  if (lr) {
    const name = labelNames.get(lr.id)
    return name ? `label ${quoted(clip(name, 32))}${lr.value ? ` ${lr.value}` : ''}` : `a label${lr.value ? `'s ${lr.value}` : ''}`
  }
  const rr = reportRef(c.ref)
  if (rr) {
    const words = rr.unit ? passages.get(`report:${rr.slug}#${rr.unit}`) : ''
    if (words) return quoted(clip(words, 40))
    const title = docTitles.get(rr.slug)
    return title ? `${rr.slug === 'slides' ? 'slides' : rr.slug === 'story' ? 'story' : 'report'} ${quoted(clip(title, 32))}` : `the ${rr.slug}`
  }
  const [base = '', frag = ''] = c.ref.split('#', 2)
  const card = bareCard(c)
  if (card) return cardWords(questionOf(card))
  const out = outputLine(c.ref)
  if (out) return out.words
  if (base.startsWith('card:')) return frag ? `card ${frag.split('/').at(-1)}` : 'card'
  if (base.startsWith('call:')) return frag ? `output ${frag}` : 'output'
  // a file's place in words, its name without its extension (`events line 1063`, `agent-chat lines 1-2`), never
  // `events:1063`, which reads as an id (live check term-fix9, low quirk); a long name cut, its line kept
  const name = base.split('/').at(-1) ?? base
  const short = name.replace(/\.(jsonl|json|csv|tsv|txt|md|log)$/, '')
  const lines = /^L(\d+)(?:-L?(\d+)|\.b\d+(?::c\d+-\d+)?)?$/.exec(frag)
  const row = /^row=(\d+)$/.exec(frag)
  const where = lines ? (lines[2] && lines[2] !== lines[1] ? ` lines ${lines[1]}-${lines[2]}` : ` line ${lines[1]}`) : row ? ` row ${row[1]}` : frag ? `#${frag}` : ''
  return width(`${short}${where}`) <= 28 || !where ? cut(`${short}${where}`, 28) : `${cut(short, Math.max(4, 28 - width(where)))}${where}`
}

// ---------------------------------------------------------------------------------------- text width and cuts

/** The cells a character takes on the grid: 2 for a wide one (CJK, emoji), 1 else. */
export function cw(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0) return 0
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
  ) return 2
  return 1
}

export function width(s: string): number {
  let n = 0
  for (const ch of s) n += cw(ch)
  return n
}

/** The longest start of `s` that fits in `n` cells, with no `…`: a word wider than its row, broken where the row ends. */
export function prefix(s: string, n: number): string {
  let out = ''
  let w = 0
  for (const ch of s) {
    if (w + cw(ch) > n) break
    out += ch
    w += cw(ch)
  }
  return out
}

// what a cut leaves out before its `…`: the space and the punctuation that ended the last word kept, and the `·` of a
// list of facts whose next item it leaves out
const CUT_TAIL = /[\s,;:.!?\-–—·]+$/

/** Where the words in quotation marks that end `s` open (`"…"`, or `“…”`), when they open after its first cell; -1
 *  when `s` does not end in quoted words. */
function quoteOpens(s: string): number {
  const close = s.at(-1)
  if (close !== '"' && close !== '”') return -1
  const at = close === '”' ? s.lastIndexOf('“') : s.lastIndexOf('"', s.length - 2)
  return at >= 0 && at < s.length - 2 ? at : -1
}

/** `s` in at most `n` cells: whole when it fits, else cut at the last word that fits, mid-word only when that keeps
 *  less than half of the room, with no space or punctuation before the `…` (SPEC.md, section 5, "Words that recur").
 *  Words in quotation marks that end `s` are cut inside the marks, which stay: `thread "Which line of…"`.
 *  The one cut of thimble-term: every row, title, preview and path step that shortens prose shortens it here. */
export function cut(s: string, n: number): string {
  if (width(s) <= n) return s
  if (n <= 1) return n === 1 ? '…' : ''
  // quoted words with a short tail after them (`card "How many…" · code`): the words inside the marks cut, the marks and
  // the tail kept (live check term-fix9, low quirk: the code view's step read `card "How many deletes does…"…`)
  const tailed = /^(.*?["“])([^"“”]+)(["”] · [^"“”]{1,16})$/.exec(s)
  if (tailed && n - width(tailed[1]!) - width(tailed[3]!) >= 5) return `${tailed[1]}${cut(tailed[2]!, n - width(tailed[1]!) - width(tailed[3]!))}${tailed[3]}`
  const open = quoteOpens(s)
  if (open >= 0) {
    // the words before the quotation and its opening mark whole, the quoted words cut, then the closing mark; when the
    // room keeps fewer than 4 cells of the quoted words, the whole is cut as any words are
    const head = s.slice(0, open + 1)
    const room = n - width(head) - 1
    if (room >= 4) return `${head}${cut(s.slice(open + 1, -1), room)}${s.at(-1)}`
  }
  // words in quotation marks that open inside the words kept and close after the cut (`citation card "How many…" output
  // line 1`) keep their closing mark too: `citation card "How…"`
  const plain = cutWords(s, n)
  const close = unclosed(plain)
  if (!close || n < 3) return plain
  const shorter = cutWords(s, n - 1)
  return unclosed(shorter) ? `${shorter}${unclosed(shorter)}` : shorter
}

/** `s` cut at a word in `n` cells (cut's last step). */
function cutWords(s: string, n: number): string {
  let head = ''
  let w = 0
  for (const ch of s) {
    if (w + cw(ch) > n - 1) break
    head += ch
    w += cw(ch)
  }
  // a word that ends right where the room does is whole
  const at = /\s/.test(s[head.length] ?? '') ? head.length : head.search(/\s\S*$/)
  const keep = at > 0 && width(head.slice(0, at)) * 2 > n ? head.slice(0, at) : head
  return `${keep.replace(CUT_TAIL, '') || keep.trimEnd()}…`
}

/** The closing quotation mark words in quotation marks that open in `s` and do not close there want, else ''. */
function unclosed(s: string): string {
  if (s.lastIndexOf('“') > s.lastIndexOf('”')) return '”'
  return (s.match(/"/g)?.length ?? 0) % 2 === 1 ? '"' : ''
}

// a terminal's escape sequence (CSI, OSC, or one character after ESC), then any other control character
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])?/g
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Text as a drawing may hold it: a terminal's escape sequences (a tool's colored output kept in a transcript) and
 *  other control characters left out, a tab or a newline as a space, since a drawing whose text holds one does not
 *  validate. Pure. */
export function noControls(s: string): string {
  return /[\u0000-\u001f\u007f-\u009f]/.test(s) ? s.replace(ESCAPES, '').replace(/[\t\n]/g, ' ').replace(CONTROLS, '') : s
}

/** A file's line in at most `n` cells: a line of code or data (JSON, a tag) cut at the cell edge, so the rows of a file
 *  end together; prose cut at a word, as `cut` cuts. */
export function cutLine(s: string, n: number): string {
  if (width(s) <= n || !/^\s*[{[<]/.test(s)) return cut(s, n)
  if (n <= 1) return n === 1 ? '…' : ''
  // no space or sentence punctuation right before the `…` (live check term-fix9, low quirk: `Some …`, `alone.…`); a
  // JSON key's colon stays, so a cut value reads as one (`"page_key":…`)
  const head = prefix(s, n - 1)
  return `${head.replace(/[\s.,;!?]+$/, '') || head}…`
}

/** Items of an inline list of facts parted by ` · ` in at most `n` cells: as many whole items as fit, then ` · +N` for
 *  the N left out (never a `…` against a whole item, which would read as a cut value: `wiki dse…`); the first item cut
 *  as `cut` cuts when not even it fits whole. */
export function itemsRow(items: readonly string[], n: number): string {
  let k = items.length
  const more = (m: number) => (m < items.length ? ` · +${items.length - m}` : '')
  const row = (m: number) => `${items.slice(0, m).join(' · ')}${more(m)}`
  while (k > 0 && width(row(k)) > n) k--
  if (k > 0) return row(k)
  const tail = more(1)
  return n - width(tail) >= 8 ? `${cut(items[0] ?? '', n - width(tail))}${tail}` : cut(items[0] ?? '', n)
}

/** `s` in at most `n` cells, cut in its middle at words so its end shows: `How many deletes… of 27 June?`, for rows
 *  that share their first words and differ at their ends (live check term-fix9, quirk 8: fifteen card rows read `How
 *  many deletes does…`). As `cut` when the room keeps fewer than 6 cells of the end. */
export function cutMiddle(s: string, n: number): string {
  if (width(s) <= n) return s
  const tailRoom = Math.floor((n - 2) / 2)
  if (tailRoom < 6) return cut(s, n)
  // the end: the last words that fit its half, whole
  const words = s.split(' ')
  let tail = ''
  for (let i = words.length - 1; i > 0; i--) {
    const next = tail ? `${words[i]} ${tail}` : words[i]!
    if (width(next) > tailRoom) break
    tail = next
  }
  if (!tail) return cut(s, n)
  const head = cut(s.slice(0, s.length - tail.length).trimEnd(), n - width(tail) - 1)
  return `${head.endsWith('…') ? head : `${head}…`} ${tail}`
}

/** `s` on one line in `n` cells, cut as `cut` cuts. */
export function clip(s: string, n: number): string {
  return cut(s.replace(/\s+/g, ' ').trim(), n)
}

/** About `room` characters of a long line around position `at` (a third of the room before it), each end cut at a word
 *  with `…` right against the words; `shift` is how far a position of `text` moved to the left. A line of data (JSON, a
 *  tag) is cut at the cell edge instead, `room` characters exactly, so the lines of a file end together (live check
 *  term-fix9, low quirk: a citation's context lines were cut to uneven widths). */
export function windowAt(text: string, at: number, room: number): { text: string; shift: number } {
  if (text.length <= room) return { text, shift: 0 }
  if (/^\s*[{[<]/.test(text) && room >= 4) {
    const lo = Math.max(0, Math.min(at - Math.floor(room / 3), text.length - room + 1))
    const late = lo > 0
    const hi = Math.min(text.length, lo + room - (late ? 1 : 0) - 1)
    const body = text.slice(lo, hi)
    return { text: `${late ? '…' : ''}${body}${hi < text.length ? '…' : ''}`, shift: lo - (late ? 1 : 0) }
  }
  let lo = Math.max(0, Math.min(at - Math.floor(room / 3), text.length - room))
  const late = lo > 0
  let hi = Math.min(text.length, lo + room - (late ? 2 : 1))
  if (late) {
    // the first word whole: start after the space that ends the cut one, while that loses less than a third of the
    // room; no space after the `…`
    if (!/\s/.test(text[lo - 1]!)) {
      const sp = text.slice(lo, Math.min(at, lo + Math.floor(room / 3))).search(/\s/)
      if (sp >= 0) lo += sp + 1
    }
    while (lo < hi && /\s/.test(text[lo]!)) lo++
  }
  if (hi < text.length && !/\s/.test(text[hi]!)) {
    const sp = text.slice(lo, hi).search(/\s\S*$/)
    if (sp > (hi - lo) / 2) hi = lo + sp
  }
  const body = text.slice(lo, hi)
  const end = hi < text.length ? `${body.replace(CUT_TAIL, '') || body.trimEnd()}…` : body
  return { text: `${late ? '…' : ''}${end}`, shift: lo - (late ? 1 : 0) }
}

/** Words in quotation marks for a row: straight ones, curly when the words hold straight ones of their own, and none
 *  when they hold both kinds, so no quotation marks stand inside the same kind. */
export function quoted(s: string): string {
  const straight = s.includes('"')
  const curly = /[“”]/.test(s)
  if (straight && curly) return s
  return straight ? `“${s}”` : `"${s}"`
}

/** Straight double quotation marks as curly ones, opening after a space or a bracket and closing elsewhere: words in a
 *  tool's row, where Claude Code escapes straight ones (`\"`). */
export function curlyQuotes(s: string): string {
  return s.replace(/"/g, (_m, at: number) => (at === 0 || /[\s([{—–-]/.test(s[at - 1]!) ? '“' : '”'))
}

// ---------------------------------------------------------------------------------------- inline runs

/** A line of Markdown as styled runs: bold, italic, code, links (their text), citations (one run each). */
export function inlineRuns(text: string): Run[] {
  const out: Run[] = []
  // each citation outside code is masked to one token of its length, so the brackets, stars and underscores of a
  // quoted value neither end it nor start emphasis
  let masked = ''
  let from = 0
  for (const sp of citeSpans(text.replace(FENCE_RE, m => ' '.repeat(m.length)))) {
    masked += `${text.slice(from, sp.at)}\uE000${'\uE001'.repeat(sp.end - sp.at - 1)}`
    from = sp.end
  }
  masked += text.slice(from)
  // tokens: code span, citation, link (citation form or web), bold, italic
  const TOKEN = /(`[^`\n]+`)|(\uE000\uE001*)|((?<![\[!])\[[^\[\]\n]*\]\([^()\s]*(?:\([^()\s]*\)[^()\s]*)*\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|((?<![\w*])\*[^*\n]+\*(?!\w)|(?<![\w_])_[^_\n]+_(?![\w]))/g
  let last = 0
  const push = (r: Run) => {
    if (r.text) out.push(r)
  }
  for (const m of masked.matchAll(TOKEN)) {
    const at = m.index ?? 0
    push({ text: text.slice(last, at) })
    const tok = text.slice(at, at + m[0].length)
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
  let code = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    // a citation's bars, escaped or not, stay in its cell
    const end = code ? -1 : citeEnd(t, i)
    if (end >= 0) {
      cur += t.slice(i, end).replaceAll('\\|', '|')
      i = end - 1
      continue
    }
    if (ch === '`') code = !code
    if (ch === '|' && !code) {
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
 *  blocks thimble-term draws itself so their citations can be chips. Fences and tables stay Markdown whole. */
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
      // a figure's caption (report.ts normalizeDoc) is the italic line right under its embed
      const cap = /^\s*\*([^*\n].*?)\*\s*$/.exec(lines[i + 1] ?? '')
      out.push({ type: 'card', id: (embed[1] ?? embed[2])!, gap: blank, ...(cap ? { caption: cap[1]!.trim() } : {}) })
      blank = false
      i += cap ? 2 : 1
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
      // its first line whatever it starts with (an indented "# " is no heading), then up to the next block
      body = [lines[i++]!]
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

/** A chunk of Markdown cut into its paragraphs (at blank lines outside a fence), each whole: what one "ask ›" asks
 *  about. A fence, a table or a list stays one piece. */
export function mdPieces(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && !line.trim()) {
      if (cur.length) out.push(cur.join('\n'))
      cur = []
    } else cur.push(line)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

const ITEM_LINE = /^([-*+]|\d+[.)])\s/

/** mdPieces with each top-level item of a list a piece of its own, so a report's "?" asks about one item; an item's
 *  indented lines stay with it. `join`: the piece follows the one before without a blank line. */
export function askPieces(text: string): { text: string; join: boolean }[] {
  const out: { text: string; join: boolean }[] = []
  for (const piece of mdPieces(text)) {
    const lines = piece.split('\n')
    if (/^\s*```/.test(lines[0]!) || !lines.some(l => ITEM_LINE.test(l))) {
      out.push({ text: piece, join: false })
      continue
    }
    let cur: string[] = []
    let join = false
    for (const l of lines) {
      if (ITEM_LINE.test(l) && cur.length) {
        out.push({ text: cur.join('\n'), join })
        cur = []
        join = true
      }
      cur.push(l)
    }
    out.push({ text: cur.join('\n'), join })
  }
  return out
}

/** Each heading of a reply text and its section: the heading, and every line up to the next heading of its level or
 *  higher (its paragraphs, lists, tables and cards), keyed by the heading line as written. What "ask ›" beside a
 *  heading asks about. Headings inside a fence are not headings. */
export function sectionsOf(text: string): Map<string, string> {
  const lines = text.split('\n')
  const heads: { at: number; level: number }[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    const m = fence ? null : /^(#{1,6})\s+\S/.exec(l)
    if (m) heads.push({ at: i, level: m[1]!.length })
  })
  const out = new Map<string, string>()
  heads.forEach((h, k) => {
    const end = heads.slice(k + 1).find(x => x.level <= h.level)?.at ?? lines.length
    out.set(lines[h.at]!.trim(), lines.slice(h.at, end).join('\n').trim())
  })
  return out
}

/** Whether a reply block needs thimble-term's drawing: it embeds a card or holds a citation. */
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

const MONTHS: Record<string, number> = Object.fromEntries(
  [['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], ['may'], ['jun', 'june'], ['jul', 'july'], ['aug', 'august'], ['sep', 'sept', 'september'], ['oct', 'october'], ['nov', 'november'], ['dec', 'december']].flatMap((names, i) => names.map(n => [n, i + 1])),
)
// a day and a month in words, as prose writes a date (`23 June`, `June 23`, `23rd June`, `Jun. 23`), with or without a
// year and a time after it (`4 June 2026 at 10:53:40 UTC`); a date as an output writes it, ISO (`2026-06-23`, also at a
// time stamp's head) or month and day (`06-23`), and the time a stamp writes right after its date
const DAY_MONTH_RE = /^(?:(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?|([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?)(?:,?\s+(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(?:UTC|GMT|Z))?)?$/i
const ISO_DATE_RE = /(?<![\d-])(?:(\d{4})-)?(\d{2})-(\d{2})(?![\d-])/g
const STAMP_CLOCK_RE = /^[T ](\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/
const CLOCK_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?![\d:])/g

/** The month, day, year and time of a shown value that is a day and a month in words (`23 June`, `4 June 2026 at
 *  10:53:40 UTC`), or null for any other words (backend cite._date_words). */
export function dayMonth(display: string): { month: number; day: number; year: number | null; clock: string | null } | null {
  const m = DAY_MONTH_RE.exec(display.trim())
  if (!m) return null
  const [day, word] = m[1] ? [m[1], m[2]!] : [m[4]!, m[3]!]
  const month = MONTHS[word.toLowerCase()]
  if (!month || Number(day) < 1 || Number(day) > 31) return null
  return { month, day: Number(day), year: m[5] ? Number(m[5]) : null, clock: m[6] ?? null }
}

/** Whether every clock time the shown value writes is one the text writes: the same hour and minute, the same second
 *  when the value gives one (backend cite.clocks_in). */
export function clocksIn(display: string, text: string): boolean {
  const have = [...text.matchAll(CLOCK_RE)].map(c => [Number(c[1]), c[2], c[3] ?? ''] as const)
  return [...display.matchAll(CLOCK_RE)].every(c => have.some(([h, mi, se]) => h === Number(c[1]) && mi === c[2] && (!c[3] || c[3] === se)))
}

/** Whether a shown value that is a day and a month in words (`23 June`) names a date the text writes as ISO
 *  (`2026-06-23`) or as month and day (`06-23`): the same month and day, the year too when both give one (backend
 *  cite.date_in; live check term-fix6, new quirk 7: `23 June` citing a cell `06-23` was red). A time after the date is
 *  the time the stamp writes after that date, or with none there, a clock time of the text (live check term-fix7, new
 *  quirk 1: `4 June 2026 at 10:53:40 UTC` against 2026-06-04T10:53:40Z was not found). */
export function dateIn(display: string, text: string): boolean {
  const want = dayMonth(display)
  if (!want) return false
  for (const d of text.matchAll(ISO_DATE_RE)) {
    if (Number(d[2]) !== want.month || Number(d[3]) !== want.day || (want.year !== null && d[1] && Number(d[1]) !== want.year)) continue
    if (want.clock === null) return true
    const stamp = STAMP_CLOCK_RE.exec(text.slice(d.index! + d[0].length))
    if (clocksIn(want.clock, stamp ? stamp[1]! : text)) return true
  }
  // a date the text writes in words (`23 June`, a row named `last delete on 30 June`; backend cite.date_in, live check
  // term-fix9, quirk 11)
  return datesInWords(text).some(d => sameDate(want, d.date, text))
}

/** Whether a date in words (`got`, at its place in `text`) is the day and month `want` names, the year too when both
 *  give one, and its clock time among the text's when `want` gives one. */
function sameDate(want: NonNullable<ReturnType<typeof dayMonth>>, got: NonNullable<ReturnType<typeof dayMonth>>, text: string): boolean {
  if (got.month !== want.month || got.day !== want.day || (want.year !== null && got.year !== null && got.year !== want.year)) return false
  return want.clock === null || clocksIn(want.clock, got.clock ?? text)
}

const MONTH_WORD = `(?:${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})`
// a day and a month in words inside a text, with its year and time when it has them (backend cite._DATE_IN_TEXT_RE)
const DATE_IN_TEXT_RE = new RegExp(`(?<![\\w.])(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\b\\.?|${MONTH_WORD}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?![\\d:]))(?:,?\\s+\\d{4}(?!\\d))?(?:,?\\s+(?:at\\s+)?\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*(?:UTC|GMT|Z)\\b)?)?`, 'gi')

/** Each day and month a text writes in words, where it stands and what it names; `may` in lower case is the verb. */
export function datesInWords(text: string): { at: number; end: number; date: NonNullable<ReturnType<typeof dayMonth>> }[] {
  const out: { at: number; end: number; date: NonNullable<ReturnType<typeof dayMonth>> }[] = []
  for (const m of text.matchAll(DATE_IN_TEXT_RE)) {
    const words = m[0].replace(/[,\s]+$/, '').replace(/\.$/, '')
    const date = dayMonth(words)
    if (date && !/\bmay\b/.test(words)) out.push({ at: m.index!, end: m.index! + words.length, date })
  }
  return out
}

const STAMP_RE = /(?<![\d-])(?:\d{4}-)?\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?(?![\d-])/g

/** Where a line writes the date a shown value names in words, in digits (`23 June` at `2026-06-23`) or in words: each
 *  stamp dateIn accepts, and each date in words of the same day, as [start, end], so a citation's panel marks the date
 *  it cites. */
export function dateSpans(display: string, line: string): number[][] {
  const want = dayMonth(display)
  if (!want) return []
  const stamps = [...line.matchAll(STAMP_RE)].filter(m => dateIn(display, m[0])).map(m => [m.index!, m.index! + m[0].length])
  return [...stamps, ...datesInWords(line).filter(d => sameDate(want, d.date, line)).map(d => [d.at, d.end])].sort((a, b) => a[0]! - b[0]!)
}

/** Whether a shown value is in a text: a number must match a whole number of it, a day and a month in words a date it
 *  writes in digits (dateIn), anything else is a substring. */
export function valueIn(display: string, text: string): boolean {
  for (const m of text.matchAll(NUM_RE)) if (shownMatches(display, m[0])) return true
  if (dateIn(display, text)) return true
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

// the number formats thimble gives a table's columns (backend frames.default_format, which d3-format reads in the
// browser): `,d` and `d` for whole numbers, `,.N~f` and `.N~f` for the others
const FORMAT_RE = /^(,)?(?:d|\.(\d)~f)$/

/** A number in a table column's format, as the browser's table writes it (FrameTable's cellText, d3-format), for the
 *  formats thimble gives; null for any other format. A negative number takes the minus sign, as d3-format writes it. */
export function formatted(v: number, spec: string | undefined): string | null {
  const m = spec ? FORMAT_RE.exec(spec) : null
  if (!m || !Number.isFinite(v)) return null
  const places = m[2] !== undefined ? Number(m[2]) : 0
  // a tie rounds away from zero, as the backend's ROUND_HALF_UP of the float's exact value and JS's toFixed do
  let text = Math.abs(v).toFixed(places)
  const [whole = '0', frac0 = ''] = text.split('.')
  const frac = m[2] !== undefined ? frac0.replace(/0+$/, '') : ''
  const grouped = m[1] ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole
  const zero = Number(text) === 0
  text = `${grouped}${frac ? `.${frac}` : ''}`
  return (v < 0 || Object.is(v, -0)) && !zero ? `−${text}` : text
}

/** A record's fields as a label's example shows them, when its words are a JSON object (a line of a JSON lines file):
 *  `read`, the fields the label's rule reads (a code label's `unit['name']` or `.get('name')`, the field a pattern
 *  matches, the fields a prompt names, else the record's words), each its value as a string; `rest`, the other fields
 *  whose value is one value, in the record's order. null for words that are no JSON object. A cut record (`…` at its
 *  end) is read field by field as far as it goes. */
export function recordFields(text: string, rule: { kind?: string; spec?: string; match?: string }): { read: [string, string][]; rest: [string, string][] } | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  let fields: [string, unknown][] = []
  try {
    const v = JSON.parse(t) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    fields = Object.entries(v as Record<string, unknown>)
  } catch {
    // its fields as far as the cut words go: each `"key": value` of a scalar value
    for (const m of t.matchAll(/"((?:[^"\\]|\\.)+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/g)) {
      try {
        fields.push([JSON.parse(`"${m[1]!}"`) as string, JSON.parse(m[2]!) as unknown])
      } catch {
        // a field whose words cannot be read is left out
      }
    }
    if (!fields.length) return null
  }
  const words = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const keys = fields.map(([k]) => k)
  const spec = rule.spec ?? ''
  let read: string[] = []
  if (rule.kind === 'code') {
    for (const m of spec.matchAll(/\[\s*(['"])([^'"\n]+)\1\s*\]|\.get\(\s*(['"])([^'"\n]+)\3/g)) {
      const k = m[2] ?? m[4]!
      if (keys.includes(k) && !read.includes(k)) read.push(k)
    }
  } else if (rule.kind === 'regex') {
    const hit = (v: unknown) => {
      if (typeof v !== 'string') return false
      if (rule.match) return v.includes(rule.match)
      try {
        return new RegExp(spec).test(v)
      } catch {
        return false
      }
    }
    read = fields.filter(([, v]) => hit(v)).map(([k]) => k).slice(0, 2)
  } else if (spec) {
    const lower = spec.toLowerCase()
    read = keys.filter(k => new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[_ ]')}\\b`).test(lower)).slice(0, 2)
  }
  if (!read.length) {
    // a record's words: its text field, else its longest words
    const text = keys.find(k => /^(text|content|message|body|msg|comment|title|name|summary)$/i.test(k) && typeof fields.find(([x]) => x === k)?.[1] === 'string')
    const longest = fields.filter(([, v]) => typeof v === 'string').sort((a, b) => words(b[1]).length - words(a[1]).length)[0]?.[0]
    read = [text ?? longest ?? keys[0]!].filter(Boolean)
  }
  const one = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
  return {
    read: read.map(k => [k, words(fields.find(([x]) => x === k)?.[1])]),
    rest: fields.filter(([k, v]) => !read.includes(k) && one(v)).map(([k, v]) => [k, words(v)]),
  }
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

// `label` is the label tool's own card (cell.ts labelCard), never one main writes
export const CARD_KINDS = ['bar', 'line', 'timeline', 'table', 'example', 'diagram', 'label'] as const
export const MAX_DIAGRAM_NODES = 40
export const MAX_DIAGRAM_EDGES = 80

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isCell = (v: unknown) => v === null || isStr(v) || isNum(v) || typeof v === 'boolean'

/** Why a card file cannot be drawn, or null when it fits its kind's spec. The mod draws only these typed specs; a card
 *  that fails is drawn as this error, and main is asked to fix it. */
export function validateCard(c: unknown, id?: string): string | null {
  if (!isObj(c)) return 'the file is not a JSON object'
  if (!isStr(c.id) || !/^[A-Za-z0-9_-]+$/.test(c.id)) return 'no valid id'
  if (id !== undefined && c.id !== id) return `its id is ${c.id}, not ${id}`
  if (!isStr(c.kind) || !(CARD_KINDS as readonly string[]).includes(c.kind)) return `kind must be one of ${CARD_KINDS.join(', ')}`
  if (!isStr(c.question) || !c.question.trim()) return 'no question'
  const list = (k: string) => (Array.isArray(c[k]) ? (c[k] as unknown[]) : null)
  switch (c.kind) {
    case 'bar':
    case 'label': {
      const rows = list('rows')
      if (!rows?.length) return `a ${c.kind} card needs rows`
      const bad = rows.findIndex(r => !isObj(r) || !isStr(r.label) || !isNum(r.value))
      if (bad >= 0) return `${c.kind} row ${bad + 1} needs a label and a finite number value`
      if (c.kind === 'bar') break
      const l = c.label
      if (!isObj(l) || !isStr(l.slug) || !isStr(l.name) || !Array.isArray(l.values) || !l.values.every(isStr)) return 'a label card needs its label: slug, name and values'
      const exs = list('examples') ?? []
      const badX = exs.findIndex(e => !isObj(e) || !isStr(e.ref) || !isStr(e.quote) || !isStr(e.value) || !(l.values as string[]).includes(e.value))
      if (badX >= 0) return `label card example ${badX + 1} needs a ref, its words and one of the label's values`
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
      const bad = evs.findIndex(e => !isObj(e) || !isStr(e.time) || !isStr(e.label) || !isStr(e.ref) || !(e.shown === undefined || isStr(e.shown)))
      if (bad >= 0) return `event ${bad + 1} needs time, label and ref (shown is optional text)`
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
    case 'diagram': {
      const nodes = list('nodes')
      const edges = list('edges') ?? []
      if (!nodes?.length) return 'a diagram card needs nodes'
      if (nodes.length > MAX_DIAGRAM_NODES) return `a diagram card shows at most ${MAX_DIAGRAM_NODES} nodes`
      if (edges.length > MAX_DIAGRAM_EDGES) return `a diagram card shows at most ${MAX_DIAGRAM_EDGES} edges`
      const opt = (v: unknown) => v === undefined || isStr(v)
      const bad = nodes.findIndex(n => !isObj(n) || !isStr(n.id) || !n.id || !isStr(n.label) || !n.label.trim() || !opt(n.ref) || !opt(n.detail))
      if (bad >= 0) return `node ${bad + 1} needs an id and a label (ref and detail are optional text)`
      const ids = new Set(nodes.map(n => (n as { id: string }).id))
      if (ids.size !== nodes.length) return 'each node needs an id of its own'
      const badE = edges.findIndex(e => !isObj(e) || !isStr(e.source) || !isStr(e.target) || !ids.has(e.source) || !ids.has(e.target) || !opt(e.label))
      if (badE >= 0) return `edge ${badE + 1} needs a source and a target among the node ids`
      break
    }
  }
  if (c.labels !== undefined) {
    const ls = c.labels
    if (!Array.isArray(ls) || ls.some(l => !isObj(l) || !isStr(l.slug) || !isStr(l.name) || !Array.isArray(l.values) || !l.values.every(isStr) || !(l.marks === undefined || isObj(l.marks)))) {
      return 'labels must be a list of {slug, name, values, marks?}, as the card helper writes it'
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

/** A side thread's answer as the pane draws it: its `FOR MAIN:` line left out (the pane offers it as a button). */
export function threadBody(answer: string): string {
  return answer.replace(/^\s*FOR MAIN:.*$/m, '').trim()
}
