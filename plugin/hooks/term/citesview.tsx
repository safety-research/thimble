// The Citations view (SPEC-v2 3.8, 3.10): every citation of this session, the problems first. A citation is one that
// main's chat drew, in an answer's words (C13 `citeIndex`, its verdict in `verdicts`) or in the takeaway of a card the
// session drew (its verdict there too, and the card's links check, `verification.links`: broken, typed and quiet, each
// with its why), each once by its spelling; a chip counts (its own kind of citation), a label's link does not, since it
// names no place a check reads. The thimble line (band.tsx) and the footer under an answer (register.tsx) count the
// citations as this view lists them, the footer those drawn in its answer (answerItems): one count, defined once here
// (the bug hunt of 10-17: the line said 30, the view 13, the footer 1 under an answer with six chips). Order: refuted
// (a script got another value) and missing, then differs, typed and quiet, then pending, then ok. A row: `value · place
// · verdict`, a chip's `<its place in words> · verdict` (a card by its question), and `card <n>` for a takeaway's. Enter
// opens the existing citation view (a card's row: the card); `o` and the title row's `↗` open the browser at the cited
// place.
import type { RenderElement } from 'claude-code'

import type { TermCard, TermLinks, TermPanel } from './types'
import { chipName } from './cite'
import { MARGIN_W, headerEls, marginKey, pointed, setBrowser, spread, subLine } from './chrome'
import type { Ctx } from './ctx'
import { placeWords } from './draw'
import type { Line, Seg } from './draw'
import { cid, citations, clip, decodeLabel, labelRef, noControls, noteQuestion, width } from './lib'
import type { Citation } from './lib'
import { linesEl } from './lines'
import type { LineHit } from './lines'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'
import { drawsView, hintHeight, hintsRow, none, openCard, openCite, paneRows, windowList } from './panel'
import { linkCheck } from './reply'
import { checkQueued, loadsView, navOrigin, openPanel, queueCitations, rt } from './term'

/** How a citation stands, in the view's order. */
export type CiteVerdict = 'refuted' | 'missing' | 'differs' | 'typed' | 'quiet' | 'pending' | 'ok'
const ORDER: readonly CiteVerdict[] = ['refuted', 'missing', 'differs', 'typed', 'quiet', 'pending', 'ok']

/** A row of the view: the value, the cited ref, how it stands and why, the card whose takeaway it is in (with its
 *  number among the session's cards), the citation's raw spelling, and a chip's place in words (`chip`, a card by its
 *  question), which names a citation that has no words of its own. */
export type CiteItem = { key: string; value: string; ref: string; verdict: CiteVerdict; why: string; card?: string; n?: number; raw?: string; chip?: string }

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

/** The value and the ref of a links check's key (`<value>|<ref>`). */
function splitKey(key: string): { value: string; ref: string } {
  const at = key.indexOf('|')
  return at < 0 ? { value: '', ref: key } : { value: key.slice(0, at), ref: key.slice(at + 1) }
}

/** Whether a citation counts, wherever thimble counts them (this view, the thimble line, the footer under an answer):
 *  every one but a label's link (`[33](concept:<id>/yes)`), which names no place a check reads; a chip counts. */
export function counted(c: Pick<Citation, 'ref'>): boolean {
  return !labelRef(c.ref)
}

/** Whether a row is a problem: anything but found and checking. */
export function problem(it: Pick<CiteItem, 'verdict'>): boolean {
  return it.verdict !== 'ok' && it.verdict !== 'pending'
}

/** How many citations, how many are being checked, how many failed: the thimble line's, the view's and the footer's. */
export function citeCounts(items: readonly CiteItem[]): { all: number; pending: number; bad: number } {
  return { all: items.length, pending: items.filter(x => x.verdict === 'pending').length, bad: items.filter(problem).length }
}

const CARD_OF = /^(?:card|cell):([A-Za-z0-9_-]+)/

/** A chip's place in words (cite.ts chipName): a card by its question, read now where no drawing noted it, else asked
 *  of the session's timer (term.ts tick), which reads the card to name it; a card's cell adds its column and row. */
async function chipOf(cx: Ctx, c: Citation): Promise<string> {
  const card = CARD_OF.exec(c.ref)?.[1]
  if (card) {
    const tc = await cx.card(card)
    if (tc) noteQuestion(card, (tc.data as { question?: string } | null)?.question ?? '')
    else if (!rt.shown.has(card)) rt.wanted.add(card)
  }
  const cell = /^(?:card|cell):[A-Za-z0-9_-]+#[^/]+\/.+$/.test(c.ref) ? ` ${citePlace(c.ref)}` : ''
  return `${chipName(c)}${cell}`
}

/** A citation of main's words as a row: its place's check (`verdicts`), and the links check of the card whose value it
 *  cites, which found another value or the value typed in. One not checked yet is asked of the session's timer
 *  (term.ts checkQueued), so its `◌` clears wherever it is counted, the view open or not. */
async function chatItem(cx: Ctx, c: Citation): Promise<CiteItem> {
  const id = cid(c.raw)
  const v = await cx.verdict(id)
  if (!v) queueCitations([c])
  const card = CARD_OF.exec(c.ref)?.[1]
  const check = card ? linkCheck((await cx.card(card))?.links, c) : {}
  const verdict: CiteVerdict = check.state === 'refuted' ? 'refuted' : v?.status === 'missing' ? 'missing' : v?.status === 'differs' ? 'differs' : check.state === 'typed' ? 'typed' : !v || v.status === 'pending' ? 'pending' : 'ok'
  const why = check.state === 'refuted' ? (check.source ? `a script got ${check.source}` : check.why ?? '') : verdict === 'typed' ? check.why ?? '' : v?.why ?? ''
  return { key: `chat:${id}`, value: c.display ?? '', ref: c.ref, verdict, why: noControls(why), raw: c.raw, ...(c.display === null ? { chip: await chipOf(cx, c) } : {}) }
}

type Quiet = { key?: string; why?: string }
const cardLinks = (tc: TermCard) => tc.links as (TermLinks & { quiet?: Quiet[] }) | undefined
/** Whether a links check's entry (`<value>|<ref>`) is of citation `c`, as reply.tsx linkCheck matches them. */
const entryOf = (key: string, c: Citation) => key === `${c.display ?? ''}|${c.ref}` || key.endsWith(`|${c.ref}`)

/** The citations of a card's takeaway as rows, as the card draws them (reply.tsx chipOf with its card): the place's
 *  check and the links check, `◌` while that runs; then any problem the links check names that no citation of the
 *  takeaway holds now. `seen`, the spellings counted already (main's words cite the same place the same way: one). */
async function takeawayItems(cx: Ctx, id: string, tc: TermCard, n: number, seen: Set<string>): Promise<CiteItem[]> {
  const l = cardLinks(tc)
  const quiet = Array.isArray(l?.quiet) ? l!.quiet : []
  const out: CiteItem[] = []
  const mine: Citation[] = []
  for (const c of citations(tc.takeaway || '')) {
    if (!counted(c)) continue
    mine.push(c)
    const at = cid(c.raw)
    if (seen.has(at)) continue
    seen.add(at)
    const v = await cx.verdict(at)
    const check = linkCheck(l, c)
    const q = quiet.find(x => entryOf(String(x.key ?? ''), c))
    const verdict: CiteVerdict =
      check.state === 'refuted' ? (check.source ? 'refuted' : 'missing') : v?.status === 'missing' ? 'missing' : v?.status === 'differs' ? 'differs' : check.state === 'typed' ? 'typed' : q ? 'quiet' : !v || v.status === 'pending' || check.state === 'running' ? 'pending' : 'ok'
    const why = check.state === 'refuted' ? (check.source ? `a script got ${check.source}` : check.why ?? '') : verdict === 'missing' || verdict === 'differs' ? v?.why ?? '' : verdict === 'typed' ? check.why ?? '' : verdict === 'quiet' ? String(q?.why ?? '') : ''
    out.push({ key: `card:${id}:${c.display ?? ''}|${c.ref}`, value: c.display ?? '', ref: c.ref, verdict, why: noControls(why), card: id, n, raw: c.raw, ...(c.display === null ? { chip: await chipOf(cx, c) } : {}) })
  }
  const held = (key: string) => mine.some(c => entryOf(key, c))
  if (l) {
    for (const b of l.broken) if (!held(b.key)) out.push({ key: `card:${id}:${b.key}`, ...splitKey(b.key), verdict: b.source ? 'refuted' : 'missing', why: noControls(b.source ? `a script got ${b.source}` : b.why), card: id, n })
    for (const t of l.typed ?? []) if (!held(t.key)) out.push({ key: `card:${id}:${t.key}`, ...splitKey(t.key), verdict: 'typed', why: noControls(t.why), card: id, n })
    for (const q of quiet) if (!held(String(q.key ?? ''))) out.push({ key: `card:${id}:${String(q.key ?? '')}`, ...splitKey(String(q.key ?? '')), verdict: 'quiet', why: noControls(String(q.why ?? '')), card: id, n })
  }
  return out
}

/** Rows in the view's order: the problems first, then those checked, then those found; else as they came. */
function inOrder(items: CiteItem[]): CiteItem[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => ORDER.indexOf(a.it.verdict) - ORDER.indexOf(b.it.verdict) || a.i - b.i).map(x => x.it)
}

/** Every citation of the session, the problems first (see the file's head): main's words', then the takeaways' of the
 *  cards the session drew (`rt.shown`, numbered in that order), each once. */
export async function citeItems(cx: Ctx): Promise<CiteItem[]> {
  const out: CiteItem[] = []
  const seen = new Set<string>()
  for (const c of await cx.citeIndex()) {
    const id = cid(c.raw)
    if (seen.has(id) || !counted(c)) continue
    seen.add(id)
    out.push(await chatItem(cx, c))
  }
  let n = 0
  for (const id of rt.shown) {
    const tc = await cx.card(id)
    n++
    if (tc) out.push(...(await takeawayItems(cx, id, tc, n, seen)))
  }
  return inOrder(out)
}

/** The citations drawn in one answer, as citeItems counts them: its words' and the takeaways' of the cards drawn under
 *  it, each once. What the footer under the answer counts. */
export async function answerItems(cx: Ctx, text: string, cards: readonly string[]): Promise<CiteItem[]> {
  const out: CiteItem[] = []
  const seen = new Set<string>()
  for (const c of citations(text)) {
    if (!counted(c)) continue
    seen.add(cid(c.raw))
    out.push(await chatItem(cx, c))
  }
  for (const id of cards) {
    const tc = await cx.card(id)
    if (tc) out.push(...(await takeawayItems(cx, id, tc, 0, seen)))
  }
  return inOrder(out)
}

/** A verdict's glyph and words: `×` red for a value that is not there, `!` red for one no script checked, a dim `◌`
 *  while it is checked, no glyph once found (never a ✓). */
function verdictLook(it: CiteItem): { glyph: Seg; words: string } {
  switch (it.verdict) {
    case 'refuted':
      return { glyph: { s: '×', fg: COLORS.problem }, words: it.why || 'a script got another value' }
    case 'missing':
      return { glyph: { s: '×', fg: COLORS.problem }, words: it.why || 'not found' }
    case 'differs':
      return { glyph: { s: '×', fg: COLORS.problem }, words: it.why || 'the place shows another value' }
    case 'typed':
      return { glyph: { s: '!', fg: COLORS.problem }, words: it.why || 'typed in, not computed' }
    case 'quiet':
      return { glyph: { s: '!', fg: COLORS.problem }, words: it.why || 'not checked' }
    case 'pending':
      return { glyph: { s: '◌', fg: COLORS.dim }, words: 'checking' }
    default:
      return { glyph: { s: ' ' }, words: 'found' }
  }
}

/** A cited place in words: a card's cell by its column and row (`merged agent-02`), its output by its lines, a file's
 *  line as draw.ts placeWords says it. */
export function citePlace(ref: string): string {
  // a card's column and row as the labels they stand for (bug hunt B18: `mean merged PRs managed%5Fprs`)
  const cell = /^(?:card|cell):[A-Za-z0-9_-]+#([^/]+)\/(.+)$/.exec(ref)
  if (cell) return `${decodeLabel(cell[1]!)} ${decodeLabel(cell[2]!)}`
  const out = /^(?:card|cell):[A-Za-z0-9_-]+@out\d*#L(\d+)(?:-L?(\d+))?$/.exec(ref)
  if (out) return out[2] && out[2] !== out[1] ? `output lines ${out[1]}-${out[2]}` : `output line ${out[1]}`
  if (/^(?:card|cell):[A-Za-z0-9_-]+$/.test(ref)) return 'the card'
  return placeWords(ref)
}

/** The rows as lines in `cols`: the glyph at A0, `value · place · verdict` at A2 (a chip's `<its place in words> ·
 *  verdict`, `card "How many pages…" · found`), `card <n>` dim at R. */
export function citeLines(items: readonly CiteItem[], pick: string, cols: number): { lines: Line[]; hits: { y: number; key: string }[] } {
  const lines: Line[] = []
  const hits: { y: number; key: string }[] = []
  for (const it of items) {
    const look = verdictLook(it)
    const bad = problem(it)
    const right: Line = it.card ? [dim(`card ${it.n}`)] : []
    const room = cols - 2 - (right.length ? width(`card ${it.n}`) + 2 : 0)
    const verdict: Seg = bad ? { s: look.words } : dim(look.words)
    const red = bad ? { fg: COLORS.problem } : {}
    const chip = it.chip === undefined ? '' : noControls(it.chip)
    const value = noControls(it.value) || '(no words)'
    const place = noControls(citePlace(it.ref))
    const left: Line = chip
      ? [look.glyph, { s: ' ' }, { s: clip(chip, Math.max(16, room - 5 - Math.min(40, width(look.words)))), ...red }, dim(' · '), verdict]
      : [look.glyph, { s: ' ' }, { s: clip(value, 24), ...red }, dim(` · ${clip(place, Math.max(10, room - width(value) - 6 - Math.min(40, width(look.words))))} · `), verdict]
    hits.push({ y: lines.length, key: it.key })
    lines.push(pointed(spread(left, right, cols), it.key === pick))
  }
  if (!items.length) lines.push(pointed([{ s: '  ' }, dim('no citations in this session yet')], false))
  return { lines, hits }
}

// the row the keys chose
let citePick = ''

/** The Citations view opened in the panel (SPEC-v2 C13), the row of `pick` (a ref) chosen when given. */
export async function openCitations(cx: Ctx, pick?: string): Promise<void> {
  if (pick) citePick = pick
  await openPanel(cx, { view: 'citations', title: 'Citations' })
}

/** The chat's citations checked where no verdict is kept yet (term.ts resolves them in one batch). */
async function loadCitations(cx: Ctx): Promise<void> {
  queueCitations((await cx.citeIndex()).map(c => ({ raw: c.raw, ref: c.ref, display: c.display })))
  await checkQueued(cx)
}

async function drawCitations(cx: Ctx, e: PaneEvent, _p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const items = await citeItems(cx)
  // as the footer under an answer and the thimble line count them: `◌ checking N` while checks run, `N failed` in red
  const { all, pending: checking, bad } = citeCounts(items)
  const sub: (string | Seg)[] = [`${num(all)} citation${all === 1 ? '' : 's'}`, checking ? `◌ checking ${num(checking)}` : '', bad ? { s: `${num(bad)} failed`, fg: COLORS.problem } : '']
  const body: RenderElement[] = [...headerEls(els as never, { title: 'Citations', cols, sub: subLine(sub) })]
  // a pick given by its ref (openCitations) or by its row's key
  const chosen = items.find(x => x.key === citePick) ?? items.find(x => x.ref === citePick) ?? items[0]
  const pick = chosen?.key ?? ''
  if (chosen) setBrowser(chosen.ref)
  const open = async (it: CiteItem) => {
    await navOrigin(cx, true)
    if (it.card) return openCard(cx, it.card)
    return openCite(cx, it.ref, it.value || null)
  }
  const lay = citeLines(items, pick, cols)
  const step = (d: number) => {
    const at = items.findIndex(x => x.key === pick)
    citePick = items[Math.max(0, Math.min(items.length - 1, at + d))]?.key ?? ''
    return cx.bumpPanel()
  }
  const hits: LineHit[] = lay.hits.map(h => ({ y: h.y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => {
    citePick = h.key
    const it = items.find(x => x.key === h.key)
    return it ? open(it) : undefined
  } }))
  const hints = [...(items.length ? ['↑↓ to choose', 'Enter to open its place', 'o to open it in the browser'] : []), 'b to go back', 'x to close']
  const room = paneRows() - 1 - body.length - hintHeight(hints, cols)
  const win = windowList('citations-list', lay.lines, hits, items.findIndex(x => x.key === pick), room, () => cx.bumpPanel())
  const onKey = (k: string) => {
    if (k === 'up' || k === 'k') return step(-1)
    if (k === 'down' || k === 'j') return step(1)
    if ((k === 'return' || k === 'enter') && chosen) return open(chosen)
    return undefined
  }
  body.push(items.length ? linesEl(cx, e, marginKey('citations-list'), win.lines, win.hits, cols + MARGIN_W, onKey) : none(cx, e, 'no citations in this session yet'))
  body.push(hintsRow(els as never, hints, cols))
  return <Box flexDirection="column">{body}</Box>
}

/** The Citations view's read and drawing registered with the panel (views.ts registerPanelViews). */
export function registerCitationsView(): void {
  loadsView('citations', loadCitations)
  drawsView('citations', drawCitations)
}
