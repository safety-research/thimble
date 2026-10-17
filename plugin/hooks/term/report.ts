// The report in the terminal, read only (SPEC-v2 3.14): a written document read as Markdown with its cards drawn where
// it places them, and the comments on it (a check's, Claude's note from add_comment, the analyst's) at the passages they
// are on. Documents are written and edited in the browser workbench.
//
// Pure, but for the act at the end (`thimble act comment-resolve | comment-reopen`, backend term_report.py). panel.tsx
// draws (drawDoc).
import type { Ctx } from './ctx'
import type { Line, Seg } from './draw'
import { width, wrapRows } from './draw'
import { MARGIN_W, pointed, spread } from './chrome'
import { plainCites } from './cite'
import { act } from './data'
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
          out.push({ id: `tag:${x.id}`, sid: x.id, check: UNVERIFIED, name: by.get(UNVERIFIED)?.name ?? 'Unverifiable', meta: 'citation check', text: note || 'Not checked', evidence: [], open: true, tag: true, colour: by.get(UNVERIFIED)?.colour ?? 0 })
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

/** A comment resolved (the margin's ✓) or opened again. Returns '' once done, else why not. */
export async function setComment(cx: Ctx, sc: Scope, slug: string, c: DocComment): Promise<string> {
  if (c.tag) return 'the citation check marks this sentence until its citation is fixed'
  const got = await act(cx, sc, c.open ? 'comment-resolve' : 'comment-reopen', { doc: slug, comment: c.id })
  return got.ok ? '' : got.error
}
