// Reports (pure, no `$`): the report types a writer subagent writes, each type's markdown read into what its panel
// view draws, and what the analyst's questions of a report work on: its sections (verify this section) and its
// passages (side threads, highlights).
//
// Report types are one registry (TYPES): each names its writer's guidance (prompt/reports/<prompt>) and its renderer,
// which is both how the panel draws it (reports.tsx) and the contract its text keeps (formProblems here, and
// helper/report.py check --contract for the writer). A new output is a new entry, with a new renderer only when none of
// the three draws it.
//
// - document (and the types drawn as one: casefile, comparison, timeline, custom): read whole, a notion-style page;
//   `<details>` blocks are toggles, `> [!NOTE]` blocks callouts, `![caption](card:<id>)` a figure with its caption.
// - slides: a title slide from the `# ` title, then one slide per `## ` section, its cards, bullets and `Notes`.
// - story: interactive graphics, beats one per `## ` section, each with one figure, which may name a step to light.
import type { ChatHighlightMark } from '../types'
import type { Focus } from './anim'
import { focusFromRef, focusItem } from './anim'
import { blockLayout, plainCites, richMarkdown, scriptAim } from './cite'
import { MAX_BARS, MAX_TABLE_ROWS, cardLayout, width } from './draw'
import type { CardData } from './draw'
import { EMBED_RE, askPieces, citations, clip, mdPieces, parseReply } from './lib'

// ------------------------------------------------------------------------------------------------ the types

/** How the panel draws a report, and the contract its text keeps. */
export type Renderer = 'document' | 'slides' | 'story'
export const RENDERERS: readonly Renderer[] = ['document', 'slides', 'story']

/** A report type: its id (the `report` tool's `form`), its name for the analyst, its renderer, its writer's guidance
 *  (prompt/reports/), a phrase for main's tool description, the words of a request that name it, whether it is written
 *  only when the analyst names it (else a request becomes a document), and the button that retells another report as
 *  it. */
export type ReportType = { id: string; name: string; renderer: Renderer; prompt: string; blurb: string; words?: RegExp; onRequest?: boolean; retell?: { label: string; hotkey: string } }
export type ReportForm = string

export const DEFAULT_TYPE = 'document'

// in the order a request's words are tried against them
export const TYPES: readonly ReportType[] = [
  { id: 'slides', name: 'slides', renderer: 'slides', prompt: 'slides.md', blurb: 'a deck, one slide at a time', words: /\b(slides?|deck|presentation)\b/, retell: { label: 'as slides', hotkey: 's' } },
  { id: 'story', name: 'interactive story', renderer: 'story', prompt: 'story.md', blurb: 'newsroom-style interactive graphics: beats stepped through beside a figure that stays and changes with them', words: /\bstor(?:y|ies)\b|\bscrolly|\binteractive (?:story|graphics?|piece)\b/, onRequest: true, retell: { label: 'as a story', hotkey: 'y' } },
  { id: 'casefile', name: 'case file', renderer: 'document', prompt: 'casefile.md', blurb: 'a section per case, such as an agent, a run or a session', words: /\bcase ?files?\b/ },
  { id: 'timeline', name: 'incident timeline', renderer: 'document', prompt: 'timeline.md', blurb: 'what happened in order, in phases', words: /\btimeline\b|\bchronolog/ },
  { id: 'comparison', name: 'comparison', renderer: 'document', prompt: 'comparison.md', blurb: 'the cases side by side against the measures that tell them apart', words: /\bcompar(?:e|ison)\b|\bmatrix\b/ },
  { id: 'custom', name: 'custom page', renderer: 'document', prompt: 'custom.md', blurb: 'a form the request describes, such as a dashboard, a gallery or a brief', words: /\b(dashboard|gallery|glossary|brief)\b/ },
  { id: 'document', name: 'document', renderer: 'document', prompt: 'document.md', blurb: 'a page with contents, callouts and toggles, the default' },
]

const BY_ID = new Map(TYPES.map(t => [t.id, t]))

export function isForm(v: unknown): v is ReportForm {
  return typeof v === 'string' && BY_ID.has(v)
}

/** A type by its id; an unknown id is a document. */
export function typeOf(id: string | undefined): ReportType {
  return BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_TYPE)!
}

/** The type a request names in words, else a document. */
export function guessType(request: string): ReportForm {
  const r = request.toLowerCase()
  return TYPES.find(t => t.words?.test(r))?.id ?? DEFAULT_TYPE
}

/** The type to write for a form main chose and the analyst's words: a type written only on request (a story)
 *  needs the request to name it, else the report is a document. */
export function settleType(form: unknown, request: string): ReportForm {
  const asked = isForm(form) ? form : guessType(request)
  return typeOf(asked).onRequest && guessType(request) !== asked ? DEFAULT_TYPE : asked
}

/** A file name from a title: lowercase words joined by dashes, at most 48 characters, made unique against `taken`. */
export function slugOf(title: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'report'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

const FENCE = /^\s*```/

/** The `# ` title of a report and the text after it. */
export function splitTitle(md: string): { title: string; body: string } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const i = lines.findIndex(l => l.trim() !== '')
  const m = i >= 0 ? /^#\s+(.*)$/.exec(lines[i]!) : null
  if (!m) return { title: '', body: lines.join('\n').trim() }
  return { title: m[1]!.trim(), body: lines.slice(i + 1).join('\n').trim() }
}

/** The paragraphs of a text (blank-line separated, a fence kept whole), each list item one, `> ` taken off. */
function paragraphs(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence = false
  const flush = () => {
    const t = cur.join(' ').replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
    cur = []
  }
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (fence) continue
    if (!line.trim()) {
      flush()
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      cur.push(item[1]!)
      continue
    }
    cur.push(line.replace(/^\s*>\s?/, '').trim())
  }
  flush()
  return out
}

/** `## ` sections of a body: the text before the first, and each heading with its lines. */
function sections(body: string): { lead: string; secs: { heading: string; text: string }[] } {
  const secs: { heading: string; text: string[] }[] = []
  const lead: string[] = []
  let fence = false
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    const h = fence ? null : /^##\s+(.*)$/.exec(line)
    if (h) secs.push({ heading: h[1]!.trim(), text: [] })
    else (secs.at(-1)?.text ?? lead).push(line)
  }
  return { lead: lead.join('\n').trim(), secs: secs.map(s => ({ heading: s.heading, text: s.text.join('\n').trim() })) }
}

// ------------------------------------------------------------------------------------------------ figures

/** A figure line: `![caption](card:<id> "step")`, `![caption](card:<id>)` or `[[card:<id>]]`. */
export type Figure = { id: string; caption: string; step: string }
const FIGURE_RE = /^\s*!\[([^\]\n]*)\]\(\s*card:([A-Za-z0-9_-]+)(?:\s+"([^"\n]*)")?\s*\)\s*$/

export function figureOf(line: string): Figure | null {
  const m = FIGURE_RE.exec(line)
  if (m) return { id: m[2]!, caption: m[1]!.trim(), step: (m[3] ?? '').trim() }
  const e = EMBED_RE.exec(line)
  return e ? { id: (e[1] ?? e[2])!, caption: '', step: '' } : null
}

/** A text's figure lines taken out: the figures in order, and the text without them. */
function takeFigures(text: string): { figures: Figure[]; rest: string } {
  const figures: Figure[] = []
  const rest: string[] = []
  for (const line of text.split('\n')) {
    const f = figureOf(line)
    if (f) figures.push(f)
    else rest.push(line)
  }
  return { figures, rest: rest.join('\n').trim() }
}

/** The focus a step names on a card ("week 11", a row's label, an event's time, a node's id), undefined when it names
 *  nothing there. */
export function stepFocus(card: CardData, step: string): Focus | undefined {
  const label = step.replace(/^(?:row|event|node|point)\s*:\s*/i, '').trim()
  if (!label || /^callout\s*:/i.test(step)) return undefined
  const items = cardLayout(card, 80, -1).items
  for (const f of [{ row: label }, { x: label }, { event: label }, { node: label }] as Focus[]) if (focusItem(card, items, f) >= 0) return f
  return undefined
}

/** A caption's focus on its card: a cited place (`card:<id>#...` or a record the card shows) or `step:<label>`. */
export function captionFocus(card: CardData, focus: string): Focus | undefined {
  if (!focus) return undefined
  if (focus.startsWith('step:')) return stepFocus(card, focus.slice(5))
  return focusFromRef(card, focus)
}

/** A step that is a callout ("callout: 212 requests"): its words, else ''. */
export function calloutOf(step: string): string {
  return /^callout\s*:\s*(.+)$/i.exec(step)?.[1]?.trim() ?? ''
}

// ------------------------------------------------------------------------------------------------ document

/** A document as the panel draws it: Markdown segments (drawn as a reply is, so citations are chips and cards are
 *  drawn), and toggles (`<details>`), whose body shows once opened. */
export type DocSegment = { kind: 'md'; text: string } | { kind: 'toggle'; key: string; summary: string; body: string }

const CALLOUT_RE = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i
// a callout's kind as a word (views/SPEC.md, "The visual system": no callout icons)
const CALLOUT_LOOK: Record<string, string> = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'important', WARNING: 'warning', CAUTION: 'caution' }

/** A document's lines with each callout's marker as its kind's word opening its quote, and each figure as an embed
 *  line with its caption under it. */
export function normalizeDoc(text: string): string {
  const out: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (fence) {
      out.push(line)
      continue
    }
    const c = CALLOUT_RE.exec(line)
    if (c) {
      const label = CALLOUT_LOOK[c[1]!.toUpperCase()]!
      out.push(`> ${label}${c[2] ? `  ${c[2]}` : ''}`)
      continue
    }
    const f = figureOf(line)
    if (f) {
      out.push(`[[card:${f.id}]]`)
      // its caption right under it, which drawReply draws dim under the card (views/SPEC.md, "A report")
      if (f.caption) out.push(`*${f.caption.replace(/\*/g, '')}*`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** A document's body (its title taken off) as segments: Markdown between toggles, each toggle keyed by its order. */
export function docSegments(body: string): DocSegment[] {
  const out: DocSegment[] = []
  const lines = body.split('\n')
  let md: string[] = []
  let fence = false
  let n = 0
  const flush = () => {
    const t = normalizeDoc(md.join('\n')).trim()
    if (t) out.push({ kind: 'md', text: t })
    md = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) fence = !fence
    if (fence || !/^\s*<details\b/i.test(line)) {
      md.push(line)
      continue
    }
    flush()
    // the summary on the same line or a later one, the body up to </details>
    let rest = line.replace(/^\s*<details[^>]*>/i, '')
    const inner: string[] = []
    let j = i
    for (;;) {
      const close = /<\/details>/i.exec(rest)
      if (close) {
        inner.push(rest.slice(0, close.index))
        break
      }
      inner.push(rest)
      j++
      if (j >= lines.length) break
      rest = lines[j]!
    }
    i = j
    const all = inner.join('\n')
    const sm = /<summary>([\s\S]*?)<\/summary>/i.exec(all)
    const summary = (sm?.[1] ?? 'Details').replace(/\s+/g, ' ').trim()
    const text = (sm ? all.slice(0, sm.index) + all.slice(sm.index + sm[0].length) : all).trim()
    out.push({ kind: 'toggle', key: `toggle-${++n}`, summary, body: normalizeDoc(text) })
  }
  flush()
  return out
}

/** A heading of a document for its contents: its level (2 or 3), words, and the segment it stands in. */
export type TocEntry = { level: number; text: string; segment: number; line: string }

export function tocOf(segs: readonly DocSegment[]): TocEntry[] {
  const out: TocEntry[] = []
  segs.forEach((s, i) => {
    if (s.kind !== 'md') return
    let fence = false
    for (const line of s.text.split('\n')) {
      if (FENCE.test(line)) fence = !fence
      const h = fence ? null : /^(#{2,3})\s+(.*)$/.exec(line)
      if (h) out.push({ level: h[1]!.length, text: plainCites(h[2]!.trim()).replace(/\*\*|__|`/g, ''), segment: i, line })
    }
  })
  return out
}

/** The key of the row the reply drawing (register.tsx drawReply) gives the block a heading line opens, for a text
 *  drawn with `prefix`: `<prefix>md-<n>-<j>` for a heading in Markdown, `<prefix>parabox-<n>` for one with citations.
 *  The contents scroll the panel to it. */
export function headingKey(text: string, prefix: string, line: string): string {
  let n = 0
  for (const b of parseReply(text)) {
    n++
    if (b.type === 'md') {
      const j = askPieces(b.text).findIndex(p => p.text.split('\n')[0]!.trim() === line.trim())
      if (j >= 0) return `${prefix}md-${n}-${j}`
    } else if (b.type === 'rich' && b.heading && line.trim().startsWith('#'.repeat(b.heading))) {
      const words = line.replace(/^#+\s*/, '').trim()
      const runs = b.runs.map(r => r.cite?.raw ?? r.text).join('')
      if (runs.trim() === words || plainCites(runs).trim() === plainCites(words)) return `${prefix}parabox-${n}`
    }
  }
  return ''
}

// ------------------------------------------------------------------------------------------------ slides

export const LAYOUTS = ['title', 'bullets', 'paragraph', 'bullets + card', 'paragraph + card', 'card', 'two cards', 'three cards', 'four cards', 'card grid', 'quote'] as const

export type Slide = { kind: 'title' | 'slide'; heading: string; body: string; notes: string; layout: string; cards: Figure[] }

/** The deck: a title slide (the `# ` title and the text under it), then a slide per `## ` section. */
export function slidesOf(md: string): { title: string; slides: Slide[] } {
  const { title, body } = splitTitle(md)
  const { lead, secs } = sections(body)
  const slides: Slide[] = [{ kind: 'title', heading: title, body: lead, notes: '', layout: 'title', cards: [] }]
  for (const s of secs) {
    const { figures, rest } = takeFigures(s.text)
    let layout = ''
    let notes = ''
    const kept: string[] = []
    for (const p of rest.split(/\n\s*\n/)) {
      const lay = /^\s*Layout\s*:\s*(.+?)\s*\.?\s*$/i.exec(p)
      if (lay && !p.includes('\n')) {
        layout = lay[1]!.toLowerCase()
        continue
      }
      if (/^\s*Notes\b[.:]?/.test(p)) {
        notes = p.replace(/^\s*Notes\b[.:]?\s*/, '').trim()
        continue
      }
      kept.push(p)
    }
    const text = kept.join('\n\n').trim()
    const kind = layout === 'title' || (!text && !figures.length) ? 'title' : 'slide'
    slides.push({ kind, heading: s.heading, body: text, notes, layout: layout || (figures.length > 1 ? `${figures.length} cards` : figures.length ? 'bullets + card' : 'bullets'), cards: figures })
  }
  return { title, slides }
}

// ------------------------------------------------------------------------------------------------ a slide that fits

/** The rows a text takes wrapped at word breaks to `w` columns. */
export function wrapRows(text: string, w: number): number {
  const room = Math.max(1, w)
  let rows = 1
  let used = 0
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    const ww = width(word)
    if (!ww) continue
    if (used && used + 1 + ww > room) {
      rows++
      used = 0
    }
    if (ww > room) {
      rows += Math.ceil(ww / room) - 1
      used = ww % room || room
    } else used += (used ? 1 : 0) + ww
  }
  return rows
}

/** The rows a report's Markdown takes as the panel draws it `w` columns wide (register.tsx drawReply): a paragraph with
 *  citations laid out as its chips are, other Markdown wrapped at word breaks, a blank row where the text has one. */
export function textRows(md: string, w: number): number {
  let rows = 0
  for (const b of parseReply(md)) {
    if (b.gap) rows++
    if (b.type === 'card') rows += 12
    else if (b.type === 'rich') rows += blockLayout(b, [], w, -1).lines.length
    else
      mdPieces(b.text).forEach((piece, i) => {
        if (i) rows++
        for (const line of piece.split('\n')) {
          const item = /^(\s*(?:[-*+]|\d+[.)])\s+|\s*>\s?|#{1,6}\s+)/.exec(line)
          rows += wrapRows(line.slice(item?.[0].length ?? 0), w - width(item?.[0] ?? ''))
        }
      })
  }
  return rows
}

/** The rows a row of buttons takes `cols` wide: each `[ label ]`, two columns between, wrapped whole. */
export function buttonRows(labels: readonly string[], cols: number): number {
  let rows = labels.length ? 1 : 0
  let used = 0
  for (const l of labels) {
    const w = width(l) + 4
    if (used && used + 2 + w > cols) {
      rows++
      used = 0
    }
    used += (used ? 2 : 0) + w
  }
  return rows
}

/** The rows a card takes in a report `w` columns wide: its border, its question, its params row and its layout. */
export function cardRows(card: CardData, w: number): number {
  return 3 + (card.params?.length ? 1 : 0) + cardLayout(card, Math.max(20, w - 4), -1).lines.length
}

const FIT_UNITS: Record<string, { field: 'rows' | 'events' | 'examples'; unit: string; cap: number }> = {
  table: { field: 'rows', unit: 'rows', cap: MAX_TABLE_ROWS },
  bar: { field: 'rows', unit: 'bars', cap: MAX_BARS },
  timeline: { field: 'events', unit: 'events', cap: 30 },
  example: { field: 'examples', unit: 'examples', cap: 8 },
}

/** A card cut to its first rows (a table's rows, a chart's bars, a timeline's events, the examples) so that it and a
 *  line saying how many are left out take at most `room` rows, `w` columns wide; at least three are kept. A card
 *  that fits, or of a kind that cannot be cut, comes back whole with `more` 0. */
export function fitCard(card: CardData, w: number, room: number): { card: CardData; more: number; unit: string } {
  const u = FIT_UNITS[card.kind]
  const all = (u ? (card[u.field] as unknown[] | undefined) : undefined) ?? []
  const n = Math.min(all.length, u?.cap ?? 0)
  if (!u || n <= 3 || cardRows(card, w) <= room) return { card, more: 0, unit: '' }
  const keep = (k: number) => ({ ...card, [u.field]: all.slice(0, k) }) as CardData
  let k = n - 1
  while (k > 3 && cardRows(keep(k), w) + 1 > room) k--
  return { card: keep(k), more: all.length - k, unit: u.unit }
}

// ------------------------------------------------------------------------------------------------ story

export type Beat = { heading: string; figure: Figure | null; place: 'right' | 'left' | 'full' | 'none'; body: string }

/** The story: its title, the answer in one paragraph, and the beats. */
export function storyOf(md: string): { title: string; lead: string; beats: Beat[] } {
  const { title, body } = splitTitle(md)
  const { lead, secs } = sections(body)
  const beats = secs.map(s => {
    let place: Beat['place'] = 'right'
    const lines: string[] = []
    let figure: Figure | null = null
    for (const line of s.text.split('\n')) {
      const p = /^\s*Card\s*:\s*(left|right|full|none)\s*\.?\s*$/i.exec(line)
      if (p) {
        place = p[1]!.toLowerCase() as Beat['place']
        continue
      }
      const f: Figure | null = figure ? null : figureOf(line)
      if (f) figure = f
      else lines.push(line)
    }
    return { heading: s.heading, figure, place, body: normalizeDoc(lines.join('\n')).trim() }
  })
  return { title, lead, beats }
}

// ------------------------------------------------------------------------------------------------ every form

/** What a report's text lacks for its form, in words for the analyst; the writer's own check (helper/report.py) is
 *  stricter. */
export function formProblems(md: string, form: ReportForm): string[] {
  const out: string[] = []
  const { title, body } = splitTitle(md)
  if (!title) out.push('it has no "# " title')
  const view = typeOf(form).renderer
  if (view === 'slides') {
    if (slidesOf(md).slides.length < 2) out.push('the deck has no "## " slide')
  } else if (view === 'story') {
    if (!storyOf(md).beats.length) out.push('the story has no "## " beat')
  } else if (!sections(body).secs.length && body.length > 1200) out.push('the document has no "## " section')
  return out
}

/** The cards a report embeds, each once, in order. */
export function reportCards(md: string): string[] {
  const out: string[] = []
  for (const line of md.split('\n')) {
    const f = figureOf(line)
    if (f && !out.includes(f.id)) out.push(f.id)
  }
  return out
}

/** The steps a renderer pages through: a deck's slides, a story's opening and beats; one for the others. */
export function stepCount(md: string, renderer: Renderer): number {
  if (renderer === 'slides') return slidesOf(md).slides.length
  if (renderer === 'story') return storyOf(md).beats.length + 1
  return 1
}

// ------------------------------------------------------------------------------------------------ sections and passages

/** A text the panel draws with drawReply, and the answer its claims are keyed by (cite.ts claimKey). */
export type Part = { text: string; answer: string }
/** A section of a report as its renderer draws it: a document's `## ` section (its toggles with it), a slide, a beat,
 *  a scene; `key` names it in the panel. "verify this section" checks the claims of its parts. */
export type Section = { key: string; heading: string; parts: Part[] }

/** A report's sections, each with the texts it is drawn from, so their claims are the ones the panel's chips show. */
export function reportSections(md: string, renderer: Renderer, slug: string): Section[] {
  const answer = `report:${slug}`
  if (renderer === 'slides') {
    return slidesOf(md).slides.map((s, i) => ({ key: `s${i}`, heading: plainCites(s.heading), parts: [s.body, s.notes].filter(Boolean).map(text => ({ text, answer: `${answer}#${i + 1}` })) }))
  }
  if (renderer === 'story') {
    const st = storyOf(md)
    return [{ key: 's0', heading: plainCites(st.title), parts: st.lead ? [{ text: st.lead, answer }] : [] }, ...st.beats.map((b, k) => ({ key: `s${k + 1}`, heading: plainCites(b.heading), parts: b.body ? [{ text: b.body, answer }] : [] }))]
  }
  const out: Section[] = [{ key: 's0', heading: '', parts: [] }]
  for (const seg of docSegments(splitTitle(md).body)) {
    if (seg.kind === 'toggle') {
      if (seg.body.trim()) out.at(-1)!.parts.push({ text: seg.body, answer })
      continue
    }
    let cur: string[] = []
    let fence = false
    const flush = () => {
      const t = cur.join('\n').trim()
      if (t) out.at(-1)!.parts.push({ text: t, answer })
      cur = []
    }
    for (const line of seg.text.split('\n')) {
      if (FENCE.test(line)) fence = !fence
      const h = fence ? null : /^##\s+(.*)$/.exec(line)
      if (h) {
        flush()
        out.push({ key: `s${out.length}`, heading: plainCites(h[1]!.trim()).replace(/\*\*|__|`/g, ''), parts: [] })
      }
      cur.push(line)
    }
    flush()
  }
  return out.filter(s => s.parts.length)
}

/** The section a heading line opens (a document's `## `, a storyboard's `### 0:12 · <scene>`), by its words. */
export function sectionOfHeading(sections: readonly Section[], line: string): Section | undefined {
  const words = plainCites(line.replace(/^#+\s*/, '').replace(/^\d+:\d\d · /, '')).replace(/\*\*|__|`/g, '').trim()
  return words ? sections.find(s => s.heading === words) : undefined
}

/** A passage of a report as drawReply draws it, one "?" each: a paragraph, a list item, a quote or callout, a table,
 *  a figure. `key` matches the words drawReply hands its `mark` (passageKey); `text` is as written, citations kept. */
export type Passage = { id: string; section: string; text: string; key: string; card?: string }

/** A passage's words reduced to what the eye reads, for matching a drawn block to a highlighted passage. */
export function passageKey(words: string): string {
  const card = EMBED_RE.exec(words)
  if (card) return `card:${card[1] ?? card[2]}`
  return plainCites(words)
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|`|(?<!\w)[*_]|[*_](?!\w)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Every passage of a report, numbered P1, P2, … in reading order; headings are not passages. */
export function reportPassages(md: string, renderer: Renderer, slug: string): Passage[] {
  const out: Passage[] = []
  const add = (section: string, text: string, card?: string) => {
    const key = passageKey(card ? `[[card:${card}]]` : text)
    if (key && !out.some(p => p.key === key)) out.push({ id: `P${out.length + 1}`, section, text, key, ...(card ? { card } : {}) })
  }
  for (const sec of reportSections(md, renderer, slug)) {
    for (const part of sec.parts) {
      for (const b of parseReply(part.text)) {
        if (b.type === 'card') add(sec.heading, `(the figure card:${b.id})`, b.id)
        else if (b.type === 'rich') {
          if (!b.heading) add(sec.heading, richMarkdown(b, c => c.raw))
        } else for (const p of askPieces(b.text)) if (!/^#{1,6}\s/.test(p.text) || p.text.includes('\n')) add(sec.heading, p.text)
      }
    }
  }
  return out
}

/** The highlighter's prompt: the analyst's words, and the report's passages by id to choose from. */
export function highlightPrompt(a: { title: string; file: string; request: string; passages: readonly Passage[] }): string {
  return [
    `thimble-cc-mod: the analyst asks to highlight, in the report "${a.title}" (${a.file}): "${a.request}".`,
    'Find the passages of the report this applies to, and check each against the corpus in this folder (read-only) or the cards it cites, so that each mark rests on evidence and not on the passage\'s wording alone. Mark only what the evidence bears out; marking none is a fine answer.',
    '',
    'The report\'s passages, by id:',
    ...a.passages.map(p => `${p.id}${p.section ? ` [${clip(p.section, 50)}]` : ''}: ${clip(p.text.replace(/\s+/g, ' '), 400)}`),
    '',
    'End with one JSON line per passage you mark, at most 12, and nothing after them:',
    '{"p": "P3", "ref": "<the place that shows it, as a citation\'s ref, such as a file#L<n>, a CSV row or card:<id>#<column>/<row>>", "why": "<what that place shows, in under 12 words>"}',
  ].join('\n')
}

/** The JSON objects of a subagent's answer, one per line (a code fence around them allowed). */
function jsonLines(answer: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of answer.split('\n')) {
    const t = line.trim().replace(/^[-*]\s+/, '').replace(/,$/, '')
    if (!t.startsWith('{') || !t.endsWith('}')) continue
    try {
      const v = JSON.parse(t) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>)
    } catch {
      // not a line of the answer's JSON
    }
  }
  return out
}

/** The marks a highlighter's answer names: each passage it names that exists, once, with its place and why. */
export function parseMarks(answer: string, passages: readonly Passage[]): ChatHighlightMark[] {
  const out: ChatHighlightMark[] = []
  for (const o of jsonLines(answer)) {
    const id = String(o.p ?? o.passage ?? '').trim().toUpperCase()
    const p = passages.find(x => x.id === (/^\d+$/.test(id) ? `P${id}` : id))
    if (!p || out.some(m => m.key === p.key)) continue
    const ref = String(o.ref ?? '').trim().replace(/^\[\[|\]\]$/g, '').replace(/^[^|]*\|/, '')
    out.push({ key: p.key, text: clip(plainCites(p.text).replace(/\s+/g, ' ').trim(), 120), ref, why: clip(String(o.why ?? '').replace(/\s+/g, ' ').trim(), 120) })
    if (out.length >= 12) break
  }
  return out
}

/** A highlight set's label from the analyst's words: "highlight where the agents coordinate" → "where the agents
 *  coordinate". */
export function highlightLabel(request: string): string {
  const t = request
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:please\s+)?(?:highlight|mark|show(?: me)?|find|color|colour)\s+(?:in (?:the|this) report\s+)?/i, '')
    .replace(/[.?!]+$/, '')
  return clip(t || request.trim(), 48)
}

/** A citation a section's verifier checks: its claim's key, the citation, its sentence, and for a value the script that
 *  recomputes it. */
export type VerifyItem = { key: string; raw: string; display: string | null; sentence: string; script: string }

/** The verifier's prompt: each citation of the section, a value recomputed by a script the mod runs, a citation
 *  without a value judged by reading its place. */
export function verifyPrompt(a: { title: string; file: string; heading: string; items: readonly VerifyItem[] }): string {
  const where = a.heading ? `the section "${a.heading}" of the report "${a.title}"` : `the report "${a.title}"`
  return [
    `thimble-cc-mod: the analyst asks to verify ${where} (${a.file}). Check each citation below against the corpus in this folder, read-only, and trust the raw files over anything written about them.`,
    '',
    ...a.items.flatMap((it, i) => [
      `${i + 1}. ${it.raw} in "${clip(it.sentence || it.raw, 300)}"`,
      it.display !== null
        ? `   Its value: write a standalone script at ${it.script} that ${scriptAim(it.display, citations(it.raw)[0]?.ref ?? '')}, following "Verification scripts" in thimble-cc-mod's guidance, and run it once.`
        : '   Its support: read the cited place and judge whether it shows what the sentence claims, no more.',
    ]),
    '',
    'End with one JSON line per citation, in order, and nothing after them:',
    '{"n": 1, "supported": true, "why": "<one short sentence: what the place or the script shows>"}',
  ].join('\n')
}

/** A verifier's verdicts by citation number (from 1). */
export function parseVerdicts(answer: string): Map<number, { supported: boolean; why: string }> {
  const out = new Map<number, { supported: boolean; why: string }>()
  for (const o of jsonLines(answer)) {
    const n = Number(o.n)
    if (!Number.isInteger(n) || n < 1 || typeof o.supported !== 'boolean') continue
    out.set(n, { supported: o.supported, why: clip(String(o.why ?? '').replace(/\s+/g, ' ').trim(), 300) })
  }
  return out
}
