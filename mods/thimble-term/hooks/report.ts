// The report in terminal mode: a written document read as Markdown with its cards drawn where it places them, the
// comments on it (a check's, Claude's note from add_comment, the analyst's) at the passages they are on, and the document
// edited as Markdown, saved through the route the browser's editor saves through (PUT …/blocks), so every passage the
// edit kept keeps its id and its comments as the browser keeps them.
//
// Pure, but for the acts at the end (`thimble act comment-resolve | comment-reopen | doc-save`, backend term_report.py).
// panel.tsx draws (drawDoc, drawDocEdit) and docedit.tsx is the editor's field.
import type { Ctx } from './ctx'
import type { Line, Seg } from './draw'
import { width, wrapRows } from './draw'
import { MARGIN_W, pointed, spread } from './chrome'
import { plainCites } from './cite'
import { act, readState } from './data'
import type { Scope } from './data'
import { chipText } from './lib'
import type { DocSection, DocSentence } from './model'
import { docUnits } from './model'
import { COLORS, SERIES } from './paint'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The title's passage id (backend report_types.TITLE_BLOCK). */
export const TITLE_ID = 'title'
/** The author of a note main left with add_comment (backend comments.py AUTHOR). */
const CLAUDE = 'claude'
/** The check the citation check's unverified tag belongs to. */
const UNVERIFIED = 'unverified'

// ------------------------------------------------------------------------------------------------ comments

/** A report check as `thimble state checks` lists it: its name, its palette place, whether it is on, its runs. */
export type DocCheck = { id: string; name: string; colour: number; shown: boolean; running: string[] }

/** One comment as the document draws it: the passage it is on (`sid`), the check that left it (null for a note), its
 *  name (the check's, `Claude` or `You`), what it is (`check`, `comment`, `citation check`), its words, the refs it
 *  rests on, whether it is open, and whether it is the citation check's tag (nothing to resolve). */
export type DocComment = { id: string; sid: string; check: string | null; name: string; meta: string; text: string; evidence: string[]; open: boolean; tag: boolean; colour: number }

export function checksOf(v: unknown): DocCheck[] {
  return (Array.isArray(v) ? v : []).filter(isObj).map(c => ({
    id: str(c.id),
    name: str(c.name) || str(c.id),
    colour: typeof c.colour === 'number' ? c.colour : 1,
    shown: c.shown === true,
    running: isObj(c.runs) ? Object.entries(c.runs).filter(([, r]) => isObj(r) && r.status === 'running').map(([doc]) => doc) : [],
  }))
}

/** The passages of a document in reading order: the title, then each unit's heading and its sentences. */
export function passageOrder(doc: Obj): string[] {
  const out = [TITLE_ID]
  for (const u of docUnits(doc).units) {
    if (u.id) out.push(u.id)
    for (const p of u.paragraphs ?? []) for (const x of p.sentences ?? []) if (x.id) out.push(x.id)
  }
  return out
}

/** The refs a comment rests on, from its `evidence` (refs parted by spaces), each once. */
export function evidenceRefs(evidence: unknown): string[] {
  const out: string[] = []
  for (const raw of str(evidence).split(/\s+/)) {
    const ref = raw.replace(/^[[(]+|[\]),;:.]+$/g, '')
    if (ref && !out.includes(ref)) out.push(ref)
  }
  return out
}

/** The comments the document shows, in reading order, as the browser's margin shows them (checkComments.ts
 *  openComments, shownComments): the analyst's and Claude's notes always, a check's while the check is on, the citation
 *  check's unverified tag on a sentence its check left no open comment on; and, where the browser shows none, the
 *  resolved ones (`open` false). A comment on a passage the document no longer holds is not shown. */
export function commentsOf(doc: Obj, checks: readonly DocCheck[]): DocComment[] {
  const by = new Map(checks.map(c => [c.id, c]))
  const on = (check: string | null) => check === null || by.get(check)?.shown !== false
  const order = passageOrder(doc)
  const rank = new Map(order.map((id, i) => [id, i]))
  const out: DocComment[] = []
  const marked = new Set<string>()
  for (const cm of Array.isArray(doc.comments) ? doc.comments : []) {
    if (!isObj(cm)) continue
    const sid = str(cm.sentence_id)
    // the statement, then its details on the same lines: the panel has no fold to open them in
    const text = plainCites([str(cm.text), str(cm.details)].filter(s => s.trim()).join(' ')).replace(/\s+/g, ' ').trim()
    if (!sid || !text || !rank.has(sid)) continue
    const check = cm.check ? str(cm.check) : null
    const open = (str(cm.status) || 'open') === 'open'
    if (check === UNVERIFIED && open) marked.add(sid)
    if (!on(check)) continue
    const name = check !== null ? (by.get(check)?.name ?? check) : str(cm.author) === CLAUDE ? 'Claude' : 'You'
    out.push({ id: str(cm.id), sid, check, name, meta: check !== null ? 'check' : 'comment', text, evidence: evidenceRefs(cm.evidence), open, tag: false, colour: by.get(check ?? '')?.colour ?? 0 })
  }
  if (on(UNVERIFIED) && by.has(UNVERIFIED)) {
    for (const u of docUnits(doc).units)
      for (const p of u.paragraphs ?? [])
        for (const x of (p.sentences ?? []) as (DocSentence & { tags?: unknown; tag_notes?: Record<string, unknown> })[]) {
          if (!x.id || marked.has(x.id) || !Array.isArray(x.tags) || !x.tags.includes(UNVERIFIED)) continue
          const note = str(isObj(x.tag_notes) ? x.tag_notes[UNVERIFIED] : '').trim()
          out.push({ id: `tag:${x.id}`, sid: x.id, check: UNVERIFIED, name: by.get(UNVERIFIED)?.name ?? 'Unverified', meta: 'citation check', text: note || 'Not checked', evidence: [], open: true, tag: true, colour: by.get(UNVERIFIED)?.colour ?? 0 })
        }
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => rank.get(a.c.sid)! - rank.get(b.c.sid)! || a.i - b.i).map(x => x.c)
}

/** The comments a document draws: every open one, and the resolved ones too when `resolved`. */
export function shownComments(all: readonly DocComment[], resolved: boolean): DocComment[] {
  return all.filter(c => c.open || resolved)
}

/** The unit (its index among the document's units) that holds a passage; -1 for the title or none. */
export function unitOf(doc: Obj, sid: string): number {
  return docUnits(doc).units.findIndex(u => u.id === sid || (u.paragraphs ?? []).some(p => (p.sentences ?? []).some(x => x.id === sid)))
}

/** A comment's hue: its check's place in the palette (the label palette's 1-8 over the seven series hues); a note's
 *  `●` is dim, as the browser draws it grey. */
export function commentHue(c: DocComment): string {
  return c.check === null || !c.colour ? COLORS.dim : SERIES[(c.colour - 1) % SERIES.length]!
}

/** A comment as rows with their margin (SPEC.md, rules 2, 12 and 20): `❯` on the chosen one; at A2 the `●` in its
 *  check's hue and its name (the accent when chosen), what it is dim against R (`check`, `comment`, `citation check`,
 *  then `resolved`); its words under its name at A4, wrapped, dim once resolved; the chosen one's refs as chips under
 *  them. `cols` is the type area's width. Returns the rows and where each chip stands on them. */
export function commentLines(c: DocComment, chosen: boolean, cols: number): { lines: Line[]; chips: { ref: string; x0: number; x1: number; y: number }[] } {
  const dimmed = !c.open
  const name: Seg = { s: c.name, ...(dimmed && !chosen ? { fg: COLORS.dim } : {}) }
  const meta = `${c.meta}${c.open ? '' : ' · resolved'}`
  const head = spread([{ s: '  ' }, { s: '●', fg: dimmed ? COLORS.dim : commentHue(c) }, { s: ' ' }, name], [{ s: meta, fg: COLORS.dim }], cols)
  const lines: Line[] = [pointed(head, chosen)]
  for (const row of wrapRows(c.text, Math.max(10, cols - 4), 12)) lines.push(pointed([{ s: '    ' }, { s: row, ...(dimmed ? { fg: COLORS.dim } : {}) }], false))
  const chips: { ref: string; x0: number; x1: number; y: number }[] = []
  if (chosen && c.evidence.length) {
    const row: Line = [{ s: '    ' }]
    let x = MARGIN_W + 4
    for (const ref of c.evidence.slice(0, 6)) {
      const words = chipText({ raw: `[[${ref}]]`, ref, display: null })
      if (x + width(words) > cols + MARGIN_W) break
      if (row.length > 1) {
        row.push({ s: '  ' })
        x += 2
      }
      row.push({ s: words, fg: COLORS.link })
      chips.push({ ref, x0: x, x1: x + width(words), y: lines.length })
      x += width(words)
    }
    if (chips.length) lines.push(pointed(row, false))
  }
  return { lines, chips }
}

/** What the document's subtitle says of its comments: `N open comments`, `N resolved`; '' with none. */
export function commentFacts(all: readonly DocComment[]): string[] {
  const open = all.filter(c => c.open).length
  const done = all.length - open
  const out: string[] = []
  if (open) out.push(`${open.toLocaleString('en-US')} open ${open === 1 ? 'comment' : 'comments'}`)
  if (done) out.push(`${done.toLocaleString('en-US')} resolved`)
  return out
}

// ------------------------------------------------------------------------------------------------ the document as parts

/** A unit's Markdown in parts: each part ends at a passage that has comments, which stand under it; a unit with none is
 *  one part. Its heading, its paragraphs (a list one item a row), each figure where it stands as its card's line
 *  (`[[card:<id>]]`) with its caption italic under it. */
export function unitParts(s: DocSection, comments: readonly DocComment[] = []): { md: string; after: DocComment[] }[] {
  const figs = s.figures ?? []
  const placed = new Set<number>()
  const parts: { md: string[]; after: DocComment[] }[] = [{ md: [], after: [] }]
  const add = (lines: string[]) => {
    const p = parts.at(-1)!
    p.md.push(...(p.md.length ? [''] : []), ...lines)
  }
  const close = (ids: readonly string[]) => {
    const on = comments.filter(c => ids.includes(c.sid))
    if (!on.length) return
    parts.at(-1)!.after.push(...on)
    parts.push({ md: [], after: [] })
  }
  const figure = (k: number) => {
    const f = figs[k]!
    placed.add(k)
    const cell = str(f.cell).replace(/^(?:card|cell):/, '')
    if (cell) add([`[[card:${cell}]]`, ...(f.caption ? [`*${str(f.caption).replace(/\*/g, '')}*`] : [])])
  }
  // a section with no heading (a report's opening summary) starts with its words: no empty heading line
  if (plainCites(str(s.heading)).trim()) add([`## ${str(s.heading)}`])
  close(s.id ? [s.id] : [])
  for (const para of s.paragraphs ?? []) {
    const ss = para.sentences ?? []
    // sentences with bullets are a list, one item a line: a slide's (docUnits put each bullet before its words) and a
    // report paragraph's (its bullet in `bullet`, not in its words)
    const item = (x: DocSentence) => {
      const t = str(x.text).trim()
      const b = str(x.bullet).trim() || '-'
      return t.startsWith(`${b} `) ? t : `${b} ${t}`
    }
    const words = ss.some(x => x.bullet) ? ss.map(item).join('\n') : ss.map(x => str(x.text)).join(' ')
    if (words.trim()) add([words])
    close(ss.map(x => str(x.id)).filter(Boolean))
    figs.forEach((f, k) => (f.after_paragraph === para.id && !placed.has(k) ? figure(k) : undefined))
  }
  figs.forEach((_f, k) => (!placed.has(k) ? figure(k) : undefined))
  if (parts.length > 1 && !parts.at(-1)!.md.length) parts.pop()
  return parts.map(p => ({ md: p.md.join('\n'), after: p.after }))
}

// ------------------------------------------------------------------------------------------------ editing as Markdown

/** One of the browser editor's blocks (backend report_types.BlockIn), with the id of the unit it was built from; '' for a
 *  new one, which the save gives an id. */
export type DocBlock = { id: string; type: 'heading' | 'paragraph' | 'bullet' | 'figure'; text?: string; level?: number; marker?: '-' | '1.'; cell?: string; caption?: string }

type RawSection = { id?: string; heading?: string; level?: number; paragraphs?: { id?: string; sentences?: (DocSentence & { id?: string })[] }[]; figures?: { id?: string; cell?: string; caption?: string; after_paragraph?: string | null; lead?: boolean }[] }

/** A document's blocks as the browser's editor builds them (frontend/src/report/model.ts blocksFromDoc, backend
 *  editor_blocks): per section its heading, its lead figures, its paragraphs (a block per item for a list) with the
 *  figures after each, then its other figures. */
export function docBlocks(doc: Obj): DocBlock[] {
  const out: DocBlock[] = []
  const figure = (f: NonNullable<RawSection['figures']>[number]): DocBlock => ({ id: str(f.id), type: 'figure', cell: str(f.cell), caption: str(f.caption) })
  for (const sec of (Array.isArray(doc.sections) ? doc.sections : []).filter(isObj) as RawSection[]) {
    if (str(sec.heading).trim()) out.push({ id: str(sec.id), type: 'heading', text: str(sec.heading), level: Math.max(typeof sec.level === 'number' ? sec.level : 2, 2) })
    const figs = (sec.figures ?? []).filter(f => isObj(f))
    const paras = (sec.paragraphs ?? []).filter(p => isObj(p))
    out.push(...figs.filter(f => f.lead).map(figure))
    for (const p of paras) {
      const items = (p.sentences ?? []).filter(x => isObj(x))
      if (items.length && items.every(x => x.bullet)) for (const x of items) out.push({ id: str(x.id), type: 'bullet', text: str(x.text).trim(), marker: x.bullet === '1.' ? '1.' : '-' })
      else out.push({ id: str(p.id), type: 'paragraph', text: items.map(x => str(x.text).trim()).filter(Boolean).join(' ') })
      out.push(...figs.filter(f => str(f.after_paragraph) === str(p.id) && str(p.id)).map(figure))
    }
    const known = new Set(paras.map(p => str(p.id)))
    out.push(...figs.filter(f => !f.lead && !known.has(str(f.after_paragraph))).map(figure))
  }
  return out
}

/** A figure's line: `![caption](card:<id>)`, as write_document's Markdown places a card. */
function figureLine(b: DocBlock): string {
  const id = str(b.cell).replace(/^(?:card|cell):/, '').replace(/#.*$/, '')
  return `![${flat(str(b.caption)).replace(/\]\(/g, '] (')}](card:${id})`
}

/** A document as the Markdown the panel edits: `# title`, then its blocks, a blank line between them and none between
 *  the items of one list; a heading `##` (`###` and deeper for a subheading), a list item `- ` or `1. `, a figure its
 *  card's line `![caption](card:<id>)`. Citations stay as written (`[[4579|card:<id>#pages/TOTAL]]`). */
export function docMarkdown(title: string, blocks: readonly DocBlock[]): string {
  const out: string[] = [`# ${flat(title)}`]
  let prev: DocBlock | null = null
  for (const b of blocks) {
    const line = b.type === 'heading' ? `${'#'.repeat(Math.min(6, Math.max(2, b.level ?? 2)))} ${flat(str(b.text))}` : b.type === 'bullet' ? `${b.marker === '1.' ? '1.' : '-'} ${flat(str(b.text))}` : b.type === 'figure' ? figureLine(b) : flat(str(b.text))
    const sameList = prev?.type === 'bullet' && b.type === 'bullet' && prev.marker === b.marker
    out.push(...(sameList ? [] : ['']), line)
    prev = b
  }
  return `${out.join('\n')}\n`
}

const FIGURE_RE = /^!\[(.*)\]\((?:card|cell):([A-Za-z0-9_-]+)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)$/
const CHIP_FIGURE_RE = /^\[\[(?:card|cell):([A-Za-z0-9_-]+)\]\]$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const BULLET_RE = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBER_RE = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/

/** The Markdown the panel edited, as the title (null when its first line names none) and blocks with no ids yet: a
 *  `# ` line first is the title; `##` and deeper a heading (`#` later on is one too); a card's line alone,
 *  `![caption](card:<id>)` or `[[card:<id>]]`, a figure, an italic line right under it its caption; `- `, `* `, `+ ` a
 *  list item, `1. ` a numbered one, an indented line under an item more of its words; other lines a paragraph, a blank
 *  line ending it. */
export function parseMarkdown(text: string): { title: string | null; blocks: DocBlock[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: DocBlock[] = []
  let title: string | null = null
  let para: string[] = []
  let seen = false
  const flush = () => {
    if (para.length) blocks.push({ id: '', type: 'paragraph', text: flat(para.join(' ')) })
    para = []
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      flush()
      continue
    }
    const first = !seen
    seen = true
    const h = HEADING_RE.exec(line.trim())
    if (h) {
      flush()
      if (first && h[1] === '#') title = flat(h[2]!)
      else blocks.push({ id: '', type: 'heading', text: flat(h[2]!), level: Math.max(2, h[1]!.length) })
      continue
    }
    const fig = FIGURE_RE.exec(line.trim())
    const chip = CHIP_FIGURE_RE.exec(line.trim())
    if (fig || chip) {
      flush()
      blocks.push({ id: '', type: 'figure', cell: `card:${fig ? fig[2] : chip![1]}`, caption: fig ? flat(fig[1]!) : '' })
      continue
    }
    // a caption written under a card's line, as the viewer draws it
    const last = blocks.at(-1)
    const italic = /^\*([^*].*)\*$|^_([^_].*)_$/.exec(line.trim())
    if (!para.length && last?.type === 'figure' && !last.caption && italic) {
      last.caption = flat(italic[1] ?? italic[2] ?? '')
      continue
    }
    const b = BULLET_RE.exec(line)
    const n = b ? null : NUMBER_RE.exec(line)
    if (b || n) {
      flush()
      blocks.push({ id: '', type: 'bullet', text: flat((b ?? n)![1]!), marker: b ? '-' : '1.' })
      continue
    }
    // an indented line under a list item is more of its words
    if (!para.length && last?.type === 'bullet' && /^\s+\S/.test(raw)) {
      last.text = flat(`${last.text ?? ''} ${line}`)
      continue
    }
    para.push(line.trim())
  }
  flush()
  return { title, blocks }
}

/** What two spellings of a block share, for matching an edited block to the one it was built from. */
function blockKey(b: DocBlock): string {
  if (b.type === 'figure') return `figure|${str(b.cell).replace(/^(?:card|cell):/, '').replace(/#.*$/, '')}|${flat(str(b.caption))}`
  return `${b.type}|${b.type === 'heading' ? (b.level ?? 2) : b.type === 'bullet' ? b.marker : ''}|${flat(str(b.text))}`
}

/** The edited blocks with the ids of the blocks they were built from, as the browser's editor keeps a block's id while
 *  it is edited in place: a block whose words the edit left as they were keeps its id (the longest run of such blocks
 *  in order); between two kept ones, each changed block takes the id of the next unkept block of its type there, in
 *  order; any other block is new (''). The save reconciles them (backend report_types.apply_blocks): a kept paragraph
 *  keeps the sentences whose words stayed, with their comments. */
export function alignBlocks(before: readonly DocBlock[], after: readonly DocBlock[]): DocBlock[] {
  const a = before.map(blockKey)
  const b = after.map(blockKey)
  // the longest common run, by dynamic programming over the two lists' keys
  const n = a.length
  const m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++
    else j++
  }
  const out = after.map(x => ({ ...x, id: '' }))
  for (const [i, j] of pairs) out[j]!.id = before[i]!.id
  // the gaps between kept blocks: a changed block takes the id of an unkept one of its type, in order
  const bounds: [number, number][] = [[-1, -1], ...pairs, [n, m]]
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [i0, j0] = bounds[k]!
    const [i1, j1] = bounds[k + 1]!
    let from = i0 + 1
    for (let j = j0 + 1; j < j1; j++) {
      for (let i = from; i < i1; i++) {
        if (before[i]!.type !== out[j]!.type || !before[i]!.id) continue
        out[j]!.id = before[i]!.id
        from = i + 1
        break
      }
    }
  }
  // an id is taken once
  const taken = new Set<string>()
  for (const x of out) {
    if (x.id && taken.has(x.id)) x.id = ''
    if (x.id) taken.add(x.id)
  }
  return out
}

// ------------------------------------------------------------------------------------------------ what the panel keeps

// each document's chosen comment, and the documents whose resolved comments show
const picks = new Map<string, string>()
const resolvedOn = new Set<string>()

/** The comment chosen in document `slug` ('' for none). */
export function pickOf(slug: string): string {
  return picks.get(slug) ?? ''
}

export function setPick(slug: string, id: string): void {
  if (id) picks.set(slug, id)
  else picks.delete(slug)
}

/** Whether document `slug` shows its resolved comments too. */
export function resolvedShown(slug: string): boolean {
  return resolvedOn.has(slug)
}

export function flipResolved(slug: string): void {
  if (resolvedOn.has(slug)) resolvedOn.delete(slug)
  else resolvedOn.add(slug)
}

/** The comment `k` places from the chosen one among those shown, the first (or the last, going up) when none is
 *  chosen; the chosen one at either end. */
export function stepPick(shown: readonly DocComment[], chosen: string, k: number): DocComment | undefined {
  if (!shown.length) return undefined
  const at = shown.findIndex(c => c.id === chosen)
  if (at < 0) return k < 0 ? shown.at(-1) : shown[0]
  return shown[Math.max(0, Math.min(shown.length - 1, at + k))]
}

/** The passage a comment is on, in its words: the title, a heading, a sentence. */
export function passageWords(doc: Obj, sid: string): string {
  if (sid === TITLE_ID) return str(doc.title)
  for (const u of docUnits(doc).units) {
    if (u.id === sid) return plainCites(str(u.heading))
    for (const p of u.paragraphs ?? []) for (const x of p.sentences ?? []) if (x.id === sid) return plainCites(str(x.text))
  }
  return ''
}

/** Who left a comment, as a thread asked about it is told (the browser's Margin.tsx Reply). */
export function commentWho(c: DocComment): string {
  return c.check !== null ? `The comment of the check “${c.name}”` : c.name === 'Claude' ? 'Claude’s note' : 'The analyst’s comment'
}

/** A document being edited: the Markdown it was opened with (`base`, which tells a change made meanwhile), the blocks
 *  it was built from, the text as typed, and what the last save said (a refusal, red). `force`: the next save writes
 *  over a change made meanwhile, as the analyst asked. */
export type DocEdit = { slug: string; base: string; blocks: DocBlock[]; title: string; text: string; said: string; force: boolean }

const edits = new Map<string, DocEdit>()

/** The edit of document `slug`, if one is open. */
export function editOf(slug: string): DocEdit | undefined {
  return edits.get(slug)
}

/** An edit of the document as it stands, or the one already open with what was typed in it. */
export function beginEdit(slug: string, doc: Obj): DocEdit {
  const had = edits.get(slug)
  if (had) return had
  const title = str(doc.title)
  const blocks = docBlocks(doc)
  const base = docMarkdown(title, blocks)
  const e: DocEdit = { slug, base, blocks, title, text: base, said: '', force: false }
  edits.set(slug, e)
  return e
}

/** What the analyst typed, kept as they type it. */
export function draftEdit(slug: string, text: string): void {
  const e = edits.get(slug)
  if (e && e.text !== text) edits.set(slug, { ...e, text, said: '', force: false })
}

/** The edit dropped: the document opens as it stands next time. */
export function discardEdit(slug: string): void {
  edits.delete(slug)
}

/** Whether the edit holds words the document does not. */
export function editChanged(e: DocEdit): boolean {
  return e.text.replace(/\s+$/, '') !== e.base.replace(/\s+$/, '')
}

/** The blocks and title a save sends for an edit (alignBlocks): the edited title, else the title as it was. */
export function savedBlocks(e: DocEdit): { title: string; blocks: DocBlock[] } {
  const got = parseMarkdown(e.text)
  return { title: got.title ?? e.title, blocks: alignBlocks(e.blocks, got.blocks) }
}

/** Save an edit through the browser editor's route (`thimble act doc-save`). The document as it stands is read first:
 *  when it changed since the edit began (a writer or main saved it), the save stops and says so, and the next save
 *  writes over it. Returns '' once saved (the edit is closed), else why not. */
export async function saveEdit(cx: Ctx, sc: Scope, slug: string): Promise<string> {
  const e = edits.get(slug)
  if (!e) return 'nothing is being edited'
  if (!editChanged(e)) {
    edits.delete(slug)
    return ''
  }
  const now = await readState<Obj>(cx, sc, 'doc', [slug])
  if (!now.ok) return keep(e, `could not read the document: ${now.error}`)
  if (!e.force && docMarkdown(str(now.value.title), docBlocks(now.value)) !== e.base) {
    edits.set(slug, { ...e, force: true, said: 'the document changed since you began editing it: s again saves yours over it, d discards yours' })
    return edits.get(slug)!.said
  }
  const { title, blocks } = savedBlocks(e)
  const got = await act(cx, sc, 'doc-save', { doc: slug, title, blocks })
  if (!got.ok) return keep(e, `not saved: ${got.error}`)
  edits.delete(slug)
  return ''
}

function keep(e: DocEdit, said: string): string {
  edits.set(e.slug, { ...e, said })
  return said
}

/** A comment resolved (the margin's ✓) or opened again. Returns '' once done, else why not. */
export async function setComment(cx: Ctx, sc: Scope, slug: string, c: DocComment): Promise<string> {
  if (c.tag) return 'the citation check marks this sentence until its citation is fixed'
  const got = await act(cx, sc, c.open ? 'comment-resolve' : 'comment-reopen', { doc: slug, comment: c.id })
  return got.ok ? '' : got.error
}
