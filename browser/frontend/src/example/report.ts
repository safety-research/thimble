// The tour's example report, in memory: what thimble's server answers about the example folder's report, its cards
// and its document types, for the Report in the example frame (./main.tsx), through the example's server (./server.ts).
// ./data.json holds the report as main saved it in two drafts, with a comment of each check that is on, the
// cards on the canvas and every ref the report cites, resolved (browser/scripts/tour_example.py).
//
// What the person changes is kept here for the frame's life. A save of the editor is reconciled into the document as
// the server reconciles it (backend report_types.apply_blocks): an unchanged sentence keeps its id, its refs and the
// comments on it, new text is the person's, and a passage the editor dropped goes with its comments. A lock, a comment
// added or resolved, and a past draft restored are kept too. Each change is told on the frame's bus, as the server's
// stream tells a workspace. What needs Claude (a write or a revision, a request from the page, a new document) is
// refused with the line that says so, and so is Export, which would take the example out of the frame.
import { bus } from '../lib/bus'
import type { CanvasResponse, DocHistory, DocVersion, Writeup, WriteupComment, WriteupFigure, WriteupParagraph, WriteupSection, WriteupSentence } from '../lib/types'

/** What data.json holds of the report. */
export interface ReportData {
  doc: Writeup
  history: DocHistory
  /** each draft whose text is kept, by its number */
  versions: Record<string, Writeup>
  canvas: CanvasResponse
  names: unknown[]
  presets: unknown[]
  /** every ref the drafts and the comments cite, and every card, as the server resolves it */
  refs: Record<string, unknown>
}

/** The report's slug, the one document of the example. */
const SLUG = 'report'
/** The title block's id in the editor (backend report_types.TITLE_BLOCK). */
const TITLE = 'title'
const ANALYST = 'analyst'
/** A comment the person resolved (backend report.SETTLED_STATUS, canvas_comments.RESOLUTION_DONE). */
const DISMISSED = 'dismissed'
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refused = (status: number, detail: string) => json({ detail }, status)
/** Whitespace collapsed, as the server's _collapse. */
const collapse = (v: unknown): string => String(v ?? '').split(/\s+/).filter(Boolean).join(' ')
/** The time now, as the server writes it. */
const now = () => new Date().toISOString().replace(/\.\d+Z$/, '+00:00')

/** A new id, not in `used` (backend report._new_id). */
function newId(used: Set<string>): string {
  for (;;) {
    const id = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
}

// ---- the text of a passage, as the server reads it

const BRACKETS = /\[\[([^[\]]+?)\]\]/g
const KEY_MARKS = /[*_`\\]/g

/** Every ref `[[…]]` cites, in order, each once (backend refs.extract_refs). */
export function extractRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(BRACKETS)) {
    let r = m[1].trim()
    if (r.includes('|')) r = r.split('|').slice(1).join('|').trim()
    if (r && !out.includes(r)) out.push(r)
  }
  return out
}

/** What two spellings of one sentence share (backend report_types.sentence_key): a citation as what it shows, no
 * emphasis or code marks, whitespace collapsed, case folded. */
export function sentenceKey(text: unknown): string {
  const shown = String(text ?? '').replace(BRACKETS, (_m, inner: string) => (inner.includes('|') ? inner.split('|')[0] : inner).trim())
  return collapse(shown.replace(KEY_MARKS, '')).toLowerCase()
}

// placeholders for a citation and a code span, so a sentence never splits inside one (backend report_format._mask)
const MASK_OPEN = ''
const MASK_CLOSE = ''
const CODE_OPEN = ''
const CODE_CLOSE = ''
const MASKED = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g')
const CODE_MASKED = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g')
const CODE_SPAN = /(`+)([^`\n]+?)\1/g
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'cf', 'etc', 'approx', 'al', 'fig', 'dr', 'mr', 'ms', 'mrs', 'st', 'no'])
/** A sentence's end: terminal punctuation, closing quotes, brackets or emphasis, whitespace, then what opens a sentence. */
const SPLIT = new RegExp(`[.!?]+["'”’)\\]*_]*\\s+(?=[A-Z0-9"“‘'(\\[*_${MASK_OPEN}${CODE_OPEN}])`, 'g')
const LEADING_REFS = new RegExp(`^((?:${MASK_OPEN}\\d+${MASK_CLOSE}\\s*)+)(?=\\s|$)`)
const strip = (s: string, chars: string) => {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a])) a++
  while (b > a && chars.includes(s[b - 1])) b--
  return s.slice(a, b)
}

/** One masked text cut into sentences (backend report_format._split_sentences): no cut after an initial or an
 * abbreviation, and bare citations that open a sentence stay with the one before. */
function splitSentences(chunk: string, tokens: string[]): string[] {
  const parts: string[] = []
  let last = 0
  for (const m of chunk.matchAll(SPLIT)) {
    const at = m.index ?? 0
    const before = chunk.slice(0, at).split(/\s+/).filter(Boolean)
    const word = strip(before[before.length - 1] ?? '', `"'“”‘’()[]*_`).replace(/\.+$/, '')
    const low = word.toLowerCase()
    const after = chunk.slice(at + m[0].length)
    if (/^[A-Z]$/.test(word)) continue
    if (ABBREVIATIONS.has(low) && (low !== 'no' || /^\d/.test(after))) continue
    parts.push(chunk.slice(last, at + m[0].trimEnd().length))
    last = at + m[0].length
  }
  parts.push(chunk.slice(last))
  const out: string[] = []
  for (let part of parts) {
    part = part.trim()
    if (!part) continue
    const lead = LEADING_REFS.exec(part)
    if (lead && out.length) {
      const heads = [...lead[1].matchAll(MASKED)].map((x) => Number(x[1]))
      if (heads.every((k) => !tokens[k].includes('|'))) {
        out[out.length - 1] = `${out[out.length - 1]} ${lead[1].trim()}`
        part = part.slice(lead[0].length).trim()
        if (!part) continue
      }
    }
    out.push(part)
  }
  return out
}

/** A block's text as its sentences, each collapsed (backend report_types._flat_units, for prose). */
export function sentencesOf(text: string): string[] {
  const tokens: string[] = []
  const masked = text
    .replace(BRACKETS, (m) => `${MASK_OPEN}${tokens.push(m) - 1}${MASK_CLOSE}`)
    .replace(CODE_SPAN, (m) => `${CODE_OPEN}${tokens.push(m) - 1}${CODE_CLOSE}`)
    .trim()
  if (!masked) return []
  const unmask = (s: string) => s.replace(CODE_MASKED, (_m, k: string) => tokens[Number(k)]).replace(MASKED, (_m, k: string) => tokens[Number(k)])
  return splitSentences(masked, tokens)
    .map((s) => collapse(unmask(s)))
    .filter(Boolean)
}

// ---- the editor's save, reconciled into the document

/** One block of the editor's save (backend report_types.BlockIn). */
interface BlockIn {
  id: string
  type: string
  text?: string | null
  level?: number | null
  cell?: string | null
  caption?: string | null
  marker?: string | null
  children?: BlockIn[] | null
}

/** The blocks depth first: a child follows its parent. */
const flat = (blocks: BlockIn[]): BlockIn[] => blocks.flatMap((b) => [b, ...(b.children?.length ? flat(b.children) : [])])

/** A heading's level as stored: 2 unless it names a deeper one, at most 6. */
const levelOf = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 2 ? Math.min(v, 6) : 2)

/** Every id the document holds: its passages, figures and comments. */
function idsOf(doc: Writeup): Set<string> {
  const out = new Set<string>()
  for (const s of doc.sections ?? []) {
    out.add(s.id)
    for (const p of s.paragraphs ?? []) {
      out.add(p.id)
      for (const x of p.sentences ?? []) out.add(x.id)
    }
    for (const f of s.figures ?? []) out.add(f.id)
  }
  for (const c of doc.comments ?? []) out.add(c.id)
  return out
}

const sentencesIn = (doc: Writeup): WriteupSentence[] => (doc.sections ?? []).flatMap((s) => (s.paragraphs ?? []).flatMap((p) => p.sentences ?? []))

/** The editor's blocks reconciled into `doc` (backend report_types.apply_blocks): kept ids keep their records, an
 * unchanged or respelled sentence keeps its id, refs and tags, new or changed text is the person's, a figure needs a
 * card of the canvas (`cards`), and a comment goes with its passage. Mutates and returns `doc`. Throws a Response for a
 * block it does not know. */
export function applyBlocks(doc: Writeup, title: string, blocks: BlockIn[], cards: ReadonlySet<string>): Writeup {
  const secs = new Map<string, WriteupSection>()
  const paras = new Map<string, WriteupParagraph>()
  const sents = new Map<string, WriteupSentence>()
  const figs = new Map<string, WriteupFigure>()
  const paraOf = new Map<string, string>()
  for (const s of doc.sections ?? []) {
    secs.set(s.id, s)
    for (const p of s.paragraphs ?? []) {
      paras.set(p.id, p)
      for (const x of p.sentences ?? []) {
        sents.set(x.id, x)
        paraOf.set(x.id, p.id)
      }
    }
    for (const f of s.figures ?? []) figs.set(f.id, f)
  }
  const used = idsOf(doc)
  const taken = new Set<string>()
  const changed = new Set<string>()
  // an anchor of a comment that names no passage any more -> the passage that holds its text now
  const renamed = new Map<string, string>()
  const rename = (from: string, to: string) => void (renamed.has(from) || renamed.set(from, to))

  const wasLocked = (bid: string): boolean => {
    const sec = secs.get(bid)
    if (sec) return sec.locked === true
    return (paras.get(bid) ?? paras.get(paraOf.get(bid) ?? ''))?.locked === true
  }
  const claim = (preferred: string | null | undefined): string => {
    const id = preferred && BLOCK_ID.test(preferred) && !taken.has(preferred) ? preferred : newId(used)
    used.add(id)
    taken.add(id)
    return id
  }
  const pinned = <T extends object>(rec: T): T & { pinned: true; by: string } => Object.assign(rec, { pinned: true as const, by: ANALYST })
  const newSentence = (sid: string | null, text: string, bullet: '-' | '1.' | null): WriteupSentence =>
    pinned({ id: claim(sid), text, refs: extractRefs(text), tags: [], tag_notes: {}, ...(bullet ? { bullet } : {}) })
  const keptSentence = (old: WriteupSentence, text: string, bullet: '-' | '1.' | null, sid?: string): WriteupSentence => {
    const rec = clone(old)
    rec.id = claim(sid ?? old.id)
    if (rec.id !== old.id) rename(old.id, rec.id)
    rec.text = text
    if (bullet) rec.bullet = bullet
    else delete rec.bullet
    return rec
  }
  const same = (old: WriteupSentence, text: string) => collapse(old.text) === text || sentenceKey(old.text) === sentenceKey(text)
  // a sentence anywhere in the document with exactly this text, not claimed yet: one the person moved, not rewrote
  const moved = (text: string) => [...sents.values()].find((x) => !taken.has(x.id) && collapse(x.text) === text)
  const matchProse = (texts: string[], pool: WriteupSentence[], own: WriteupSentence | null): WriteupSentence[] => {
    const left = pool.filter((x) => !taken.has(x.id) || x === own)
    return texts.map((text) => {
      const hit = left.find((x) => collapse(x.text) === text) ?? left.find((x) => same(x, text)) ?? moved(text)
      if (!hit) return newSentence(null, text, null)
      if (left.includes(hit)) left.splice(left.indexOf(hit), 1)
      return keptSentence(hit, text, null)
    })
  }

  const sections: WriteupSection[] = []
  let cur: WriteupSection | null = null
  let lastPid: string | null = null
  const open = (sec: WriteupSection) => {
    cur = sec
    lastPid = null
    sections.push(sec)
    return sec
  }
  const section = (): WriteupSection => cur ?? open(pinned({ id: claim(null), heading: '', role: 'custom', paragraphs: [], figures: [] }))

  const list = flat(blocks)
  for (let i = 0; i < list.length; ) {
    const b = list[i++]
    if (b.type === 'heading') {
      const heading = collapse(b.text)
      const old = taken.has(b.id) ? undefined : secs.get(b.id)
      let sec: WriteupSection
      if (old) {
        sec = { ...clone(old), id: claim(b.id), paragraphs: [], figures: [] }
        if (heading !== (old.heading ?? '')) Object.assign(sec, { heading, edited_by: ANALYST })
      } else {
        const source = !taken.has(b.id)
        sec = pinned({ id: claim(b.id), heading, role: 'custom', paragraphs: [], figures: [] })
        // a paragraph or a list item made a heading keeps its lock, and the comments on its sentences move to it
        if (source && wasLocked(b.id)) sec.locked = true
        if (source) for (const x of paras.get(b.id)?.sentences ?? []) rename(x.id, sec.id)
      }
      if (levelOf(b.level) > 2) sec.level = levelOf(b.level)
      else delete sec.level
      open(sec)
    } else if (b.type === 'paragraph') {
      const text = collapse(b.text)
      if (!text) continue
      const sec = section()
      const oldP = taken.has(b.id) ? undefined : paras.get(b.id)
      const source = !oldP && !taken.has(b.id)
      const item = source ? (sents.get(b.id) ?? null) : null
      const pool = oldP ? [...(oldP.sentences ?? [])] : item ? [item] : []
      const pid = claim(b.id)
      const para: WriteupParagraph = oldP ? clone(oldP) : pinned({ id: pid, sentences: [] })
      para.id = pid
      para.sentences = matchProse(sentencesOf(text), pool, item)
      // a heading or a list item made a paragraph keeps its lock, and a comment on the heading moves to its text
      if (source && wasLocked(b.id)) para.locked = true
      if (source && secs.has(b.id) && para.sentences.length) rename(b.id, para.sentences[0].id)
      sec.paragraphs.push(para)
      lastPid = pid
    } else if (b.type === 'bullet') {
      const numbered = b.marker === '1.'
      const run = [b]
      while (i < list.length && list[i].type === 'bullet' && (list[i].marker === '1.') === numbered) run.push(list[i++])
      const items = run.map((blk) => ({ blk, text: sentencesOf(collapse(blk.text)).join(' ') })).filter((x) => x.text)
      if (!items.length) continue
      const sec = section()
      const marker = numbered ? '1.' : '-'
      const oldPid = items.map((x) => x.blk.id).find((id) => paraOf.has(id) && !taken.has(id))
      const oldP = oldPid ? paras.get(paraOf.get(oldPid)!) : undefined
      const pid = claim(oldP && !taken.has(oldP.id) ? oldP.id : null)
      const ids = new Set(items.map((x) => x.blk.id))
      const spare = (oldP?.sentences ?? []).filter((x) => !ids.has(x.id))
      const sentences: WriteupSentence[] = []
      let lockedSource = false
      for (const { blk, text } of items) {
        // a paragraph or a heading made a list item: its lock goes to the list, its comments to the item
        const source = !taken.has(blk.id) && !sents.has(blk.id)
        const old = taken.has(blk.id) ? undefined : sents.get(blk.id)
        const hit = old && same(old, text) ? null : (spare.find((x) => !taken.has(x.id) && same(x, text)) ?? moved(text))
        if (old && same(old, text)) sentences.push(keptSentence(old, text, marker))
        else if (hit) {
          if (spare.includes(hit)) spare.splice(spare.indexOf(hit), 1)
          sentences.push(keptSentence(hit, text, marker, blk.id))
        } else {
          if (old) changed.add(blk.id)
          sentences.push(newSentence(blk.id, text, marker))
        }
        if (source) {
          lockedSource ||= wasLocked(blk.id)
          for (const x of paras.get(blk.id)?.sentences ?? []) rename(x.id, sentences[sentences.length - 1].id)
        }
      }
      const para: WriteupParagraph = oldP ? clone(oldP) : pinned({ id: pid, sentences: [] })
      para.id = pid
      para.sentences = sentences
      if (lockedSource) para.locked = true
      sec.paragraphs.push(para)
      lastPid = pid
    } else if (b.type === 'figure') {
      const sec = section()
      const oldF = taken.has(b.id) ? undefined : figs.get(b.id)
      const card = String(b.cell ?? '').trim().replace(/^(card|cell):/, '')
      const caption = collapse(b.caption)
      let fig: WriteupFigure
      if (oldF) {
        fig = { ...clone(oldF), id: claim(b.id) }
        if (card && cards.has(card) && String(fig.cell ?? '').replace(/^cell:/, 'card:') !== `card:${card}`) {
          fig.cell = `card:${card}`
          for (const k of ['make', 'kind', 'status', 'note'] as const) delete fig[k]
        }
        if (caption) fig.caption = caption
      } else {
        if (!card || !cards.has(card)) continue
        fig = pinned({ id: claim(b.id), cell: `card:${card}`, caption })
      }
      fig.after_paragraph = lastPid
      if (lastPid == null) Object.assign(fig, { lead: true })
      else delete (fig as { lead?: boolean }).lead
      sec.figures = [...(sec.figures ?? []), fig]
    } else {
      throw refused(400, `unknown block type '${b.type}'`)
    }
  }
  doc.sections = sections
  const t = collapse(title)
  if (t !== collapse(doc.title)) doc.title = t
  // a comment stays with its passage: on a sentence given another id it follows it, on a passage the save dropped it goes
  const heads = new Set(sections.map((s) => s.id))
  const anchors = new Set([...heads, ...sentencesIn(doc).map((x) => x.id)])
  const kept: WriteupComment[] = []
  for (const cm of doc.comments ?? []) {
    let at = String(cm.sentence_id ?? '')
    const to = renamed.get(at)
    if (!anchors.has(at) && to && anchors.has(to)) {
      at = cm.sentence_id = to
      if (heads.has(at)) delete cm.paragraph
    }
    if (!taken.has(at)) continue
    if (changed.has(at) && (cm.status ?? 'open') === 'open' && cm.check) Object.assign(cm, { status: DISMISSED, resolution: 'superseded' })
    kept.push(cm)
  }
  doc.comments = kept
  return doc
}

/** The document's comments carried onto a draft it restores (backend report_types.carry_comments): each on the
 * sentence or heading that holds its words now; an open check comment whose words are gone is superseded. */
function carry(prev: Writeup, next: Writeup): WriteupComment[] {
  const byText = new Map<string, string>()
  for (const x of sentencesIn(next)) if (!byText.has(`s:${x.text}`)) byText.set(`s:${x.text}`, x.id)
  for (const s of next.sections ?? []) if (!byText.has(`h:${s.heading}`)) byText.set(`h:${s.heading}`, s.id)
  const sents = new Map(sentencesIn(prev).map((x) => [x.id, x]))
  const heads = new Map((prev.sections ?? []).map((s) => [s.id, s]))
  return (prev.comments ?? []).map((c) => {
    const cm = clone(c)
    const sentence = sents.get(cm.sentence_id)
    const key = sentence ? `s:${sentence.text}` : heads.has(cm.sentence_id) ? `h:${heads.get(cm.sentence_id)!.heading}` : null
    const to = key ? byText.get(key) : undefined
    if (to) cm.sentence_id = to
    else if ((cm.status ?? 'open') === 'open' && cm.check) Object.assign(cm, { status: DISMISSED, resolution: 'superseded' })
    return cm
  })
}

/** The words of a document, as History counts them (backend report_types.doc_words). */
const wordsOf = (doc: Writeup) =>
  [doc.title, ...(doc.sections ?? []).flatMap((s) => [s.heading, ...(s.paragraphs ?? []).flatMap((p) => p.sentences.map((x) => x.text)), ...(s.figures ?? []).map((f) => f.caption)])]
    .join(' ')
    .replace(/\[\[([^[\]|]*)\|[^[\]]*\]\]/g, '$1')
    .replace(/\[\[[^[\]]*\]\]/g, '')
    .split(/\s+/)
    .filter(Boolean).length

/** The line a refused Export says: the example stays in its frame. */
export const NO_EXPORT = "This is the tour's example data. Export works in your own workspace."

export interface ReportRoutes {
  /** The answer to a request under the example's /ws/<name>/ about its report, cards or document types; null when the
   * request is about something else. */
  answer: (method: string, rest: string, body: Record<string, unknown>) => Response | null
  /** The report as the example starts. */
  reset: () => void
}

/** The report's routes for one frame. `needsClaude` is the line that answers what needs Claude. */
export function createReport(data: ReportData, needsClaude: string): ReportRoutes {
  let doc: Writeup
  let history: DocHistory
  let versions: Record<string, Writeup>
  const reset = () => {
    doc = clone(data.doc)
    history = clone(data.history)
    versions = clone(data.versions)
  }
  reset()
  const cards = new Set(data.canvas.cells.map((c) => c.id))

  /** A change told as the server's stream tells it: the record, and its own event. */
  const tell = (status: string, extra: Record<string, unknown> = {}) => {
    bus.emit('wsEvent', { type: 'report', slug: SLUG, status, by: ANALYST, ...extra } as never)
    bus.emit('report', { slug: SLUG, status, span: typeof extra.span === 'string' ? extra.span : undefined })
  }
  const anchored = () => {
    const ids = new Set([TITLE, ...(doc.sections ?? []).map((s) => s.id), ...sentencesIn(doc).map((x) => x.id)])
    return (doc.comments ?? []).filter((c) => (c.status ?? 'open') === 'open' && ids.has(c.sentence_id)).length
  }
  const types = () => ({
    [SLUG]: { exists: true, generation: doc.generation, generated_at: doc.generated_at, renderer: 'document', title: doc.title, open_comments: anchored(), name: 'Report' },
  })

  /** Restore: draft `n` made the newest draft again, as the person's (backend report_types.restore_draft). */
  const restore = (n: number): Response => {
    const current = Math.max(doc.generation ?? 1, 1)
    if (n === current) return refused(409, 'that draft is the current one')
    const old = versions[String(n)]
    if (!old) return refused(404, 'This draft was not kept')
    versions[String(current)] = clone(doc)
    const drop = new Set(['frame', 'writer_run', 'revision', 'what_changed', 'instructions', 'lock_reverts', 'generation_failed'])
    const next = Object.fromEntries(Object.entries(clone(old)).filter(([k]) => !drop.has(k))) as unknown as Writeup
    Object.assign(next, { generation: current + 1, generated_at: now(), written_by: ANALYST })
    next.comments = carry(doc, next)
    const words = wordsOf(next)
    Object.assign(next, { words })
    const entry: DocVersion = { n: current + 1, ts: now(), source: ANALYST, instructions: null, summary: [], summary_from: null, run: null, current: true, available: true, words, writer: null, revisions: [], restored: { n, rev: null } }
    history = { ...history, generation: current + 1, versions: [entry, ...history.versions.map((v) => ({ ...v, current: false }))] }
    doc = next
    versions[String(current + 1)] = clone(doc)
    tell('edited')
    return json(doc)
  }

  const path = `investigations/main/types/${SLUG}`
  function answer(method: string, rest: string, body: Record<string, unknown>): Response | null {
    if (method === 'GET') {
      if (rest === 'investigations/main/types') return json(types())
      if (rest === path || rest === `${path}/frame`) return json(doc)
      if (rest === `${path}/versions`) return json(history)
      // a draft as it stood, the current one as it stands now
      const v = new RegExp(`^${path}/versions/(\\d+)$`).exec(rest)
      if (v) return Number(v[1]) === doc.generation ? json(doc) : versions[v[1]] ? json(versions[v[1]]) : refused(404, 'This draft was not kept')
      if (rest.startsWith(`${path}/versions/`)) return refused(404, 'This save was not kept')
      // the formats the server lists, none of which leaves the frame
      if (rest === `${path}/exports`) return json({ formats: [['markdown', 'Markdown', 'md'], ['html', 'HTML', 'html'], ['pdf', 'PDF', 'pdf']].map(([id, name, ext]) => ({ id, name, ext, ok: false, why: NO_EXPORT })) })
      if (rest.startsWith(`${path}/export`)) return refused(409, NO_EXPORT)
      if (rest === 'canvas') return json(data.canvas)
      if (rest === 'cells/names') return json(data.names)
      if (rest === 'report-types/presets') return json(data.presets)
      if (/^cells\/[^/]+\/versions\//.test(rest)) return refused(404, 'no such version')
      return null
    }
    if (method === 'PUT' && rest === `${path}/blocks`) {
      const blocks = Array.isArray(body.blocks) ? (body.blocks as BlockIn[]) : []
      const next = clone(doc)
      try {
        applyBlocks(next, typeof body.title === 'string' ? body.title : '', blocks, cards)
      } catch (e) {
        if (e instanceof Response) return e
        throw e
      }
      doc = next
      tell('edited', typeof body.client === 'string' ? { client: body.client } : {})
      return json(doc)
    }
    const lock = new RegExp(`^${path}/locks/([^/]+)$`).exec(rest)
    if (method === 'PUT' && lock) {
      const bid = decodeURIComponent(lock[1])
      const locked = body.locked === true
      const next = clone(doc)
      let holder: { locked?: boolean; title_locked?: boolean } | null = null
      let key: 'locked' | 'title_locked' = 'locked'
      if (bid === TITLE) [holder, key] = [next, 'title_locked']
      for (const s of next.sections ?? []) {
        if (holder) break
        if (s.id === bid) holder = s
        holder ??= (s.paragraphs ?? []).find((p) => p.id === bid || p.sentences.some((x) => x.id === bid)) ?? null
        holder ??= (s.figures ?? []).find((f) => f.id === bid) ?? null
      }
      if (!holder) return refused(404, `no block ${bid}`)
      if (locked) holder[key] = true
      else delete holder[key]
      doc = next
      tell('edited', typeof body.client === 'string' ? { client: body.client } : {})
      return json(doc)
    }
    if (method === 'POST' && rest === `${path}/comments`) {
      const sid = String(body.sentence_id ?? '').trim()
      const text = collapse(body.text)
      if (!text) return refused(400, 'comment text is required')
      if (!(doc.sections ?? []).some((s) => s.id === sid) && !sentencesIn(doc).some((x) => x.id === sid)) return refused(404, `no sentence or unit ${sid}`)
      const comment: WriteupComment = { id: newId(idsOf(doc)), sentence_id: sid, text, author: ANALYST, ts: now(), status: 'open', reply: null }
      doc = { ...doc, comments: [...(doc.comments ?? []), comment] }
      tell('commented', { span: `report:${SLUG}#${sid}` })
      return json(comment, 201)
    }
    const dismiss = new RegExp(`^${path}/comments/([^/]+)/dismiss$`).exec(rest)
    if (method === 'POST' && dismiss) {
      const id = decodeURIComponent(dismiss[1])
      const cm = (doc.comments ?? []).find((c) => c.id === id)
      if (!cm) return refused(404, `no comment ${id}`)
      doc = { ...doc, comments: (doc.comments ?? []).map((c) => (c.id === id ? { ...c, status: DISMISSED, resolution: 'done', resolved_ts: now() } : c)) }
      tell('commented', { span: `report:${SLUG}#${cm.sentence_id}` })
      return json(doc)
    }
    const back = new RegExp(`^${path}/versions/(\\d+)/restore$`).exec(rest)
    if (method === 'POST' && back) return restore(Number(back[1]))
    if (method === 'POST' && new RegExp(`^${path}/versions/\\d+/revisions/\\d+/restore$`).test(rest)) return refused(404, 'This save was not kept')
    if (method === 'PUT' && rest === `${path}/html`) return refused(409, `'${SLUG}' is not a page`)
    // a write or a revision, a request from the page and a new document each start Claude
    if (method === 'POST' && (rest === 'write' || rest === 'report-types/new')) return refused(403, needsClaude)
    if (rest.startsWith('report-types/')) return refused(409, `'${SLUG}' is built in`)
    return null
  }

  return { answer, reset }
}
