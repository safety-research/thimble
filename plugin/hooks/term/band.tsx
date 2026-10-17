// The rows above the prompt (the AbovePrompt band, SPEC-v2 3.8): thimble's rows stand after other plugins' rows, at
// most these, top to bottom: a panel that waits undrawn and why (the narrow fallback), the view proposal waiting for an
// answer, the open notices (the workspace's and the terminal's own, notices.tsx), the one SSH row of a remote press
// (offramp.ts), and last the thimble line, the one row that stays while thimble is on (the owner's design, 10-16 21:30,
// with the look of mock3/line2 A3; under the pointer the name underlines, 10-16 21:55).
//
// Every row but the thimble line is one line (the owner's live test, 10-17: "bottom tray is a mess"): a dim label
// column (`notice` in red), then its words cut with `…` at the room its acts leave them, then its acts at the right,
// each in the accent and underlined under the pointer as the thimble line's names are, the row's main act bold. A
// notice's words show whole instead, wrapped, so none is cut off; only the newest notice shows, and the others wait
// behind one row under it, `5 more notices ›`, whose press shows them there, newest first, and turns into `show fewer`
// with `dismiss all` (bug hunt B5 and C21: stacked, a view proposal, six notices and the SSH row took 14 of 58 rows):
//
//   view           thimble can build a page for these records: Page Histories
//                  Each wiki page as a strip of its saves over time, colored by the author, whole and wrapped
//                  build it  don't build it  stop suggesting pages  dismiss
//   notice         Claude's safeguards switched a reply of the orientation    see the orientation ›  dismiss
//                  from Opus 5.5 to Opus 4.8.
//                  5 more notices ›
//
// A press on words cut short shows them whole, wrapped, and a second press cuts them again; on the view proposal the
// press is its name's. Where the acts would leave the words fewer than MIN_WORDS cells, or would cut what the view
// proposal says, they take a row of their own under the words.
//
// The thimble line:
//
//   thimble   cards 12 •   threads 2   citations 18 ◌  1 failed   labels 3 •   checks 2 •   coverage 15%
//
// Six items, always in this order, each `name value`: the cards, the side threads, the citations of the session's
// answers and takeaways, the labels, the checks' open comments, and the read share of the data by size. `thimble` is
// bold, in the accent and underlined, and its press opens the panel's home (it is the line's `open ›`); a name is in
// the accent, the color of what can be pressed, and its value bold in the text color; a bold purple `•` (the citation
// purple) follows the value of an item with something new since the person last opened it; citations add a purple `◌`
// while any is checked and a bold red `N failed`, two cells after, when any failed; an item whose value is 0 is dim
// whole. The item of a feature that is off is left out. Each item is a plain Button whose press opens the panel at its
// section (the open is the person's own, so Claude Code places it at any width); under the pointer it gets the
// selection background, one cell past its words, and its name underlines, in place of the inverse a Button gets. The
// line has no `dismiss`. Items stand three cells apart where all fit so, else two; where the band is too narrow even
// then, the zero items go first, then the others from the end, never one with a `•` or a failure while another can go;
// a dim `…` ends a line that lost any. A `•` clears when the panel shows its section (home for the cards; labels,
// threads, checks) or its item is pressed; the counts as last seen are `$.state.seen` (C13), and a session's first
// count is what was there already, so nothing is new at activation.
//
// Claude Code's main screen (the classic renderer, where a fresh config starts) takes no clicks, so none of this can
// be pressed there (bug hunt F1). There the thimble line ends, where it fits, with `/thimble to use these with keys`
// dim: home lists the rows that wait first, each opening its acts on digit keys (waitItems, waitview.tsx), and
// `/thimble <section>` opens each item's section. Fullscreen shows neither.
//
// register.tsx calls registerBand once; each hook builds its context with register.tsx's cxOf (imported, so `claude
// plugin validate` follows `$` into it). refreshSummary (views.ts re-exports it; term.ts tick calls it when the workspace
// changes) reads the labels' unsure counts, notes the seen counts on the session's first pass, toasts each new notice of
// the workspace's, and toasts a writer's start and end while no browser shows thimble's page.
import type { On, RenderElement } from 'claude-code'

import type { AnswerComment, CoverageSummary, FeatureSettings, SummarySeen, TermPanel } from './types'
import type { Ctx } from './ctx'
import { clean, clip, cut, noControls, quoted, width } from './lib'
import { plainCites } from './cite'
import { docsOf } from './model'
import { dismissModNotice, modActWords, modNotices, moreNotices, noticeActWords, runNoticeAct, seeWords, toastNewNotices } from './notices'
import { BROWSER_ITEM, browserShown, copyRemoteLink, copyTunnel, dismissLinks, remoteWords } from './offramp'
import { answerOffer, dismissNotice, dismissOffer, homeNotices, homeOffer, noticeAct, noticeWords, noticesRead, openHomeNew, openNoticeChat, openThread, proposalsOff, refreshUnsure } from './panel'
import type { HomeOffer } from './panel'
import { COLORS } from './paint'
import { readState } from './data'
import { cxOf } from './ctx'
import { PANEL, classicScreen, closePanel, noteScreen, openPanel, openPending, placedLater, readSurface, retryPending, rt, surfaceValue } from './term'
import { keepSeen, keptSeen } from './kept'
import { openChecks } from './checksview'
import { citeCounts, citeItems, openCitations } from './citesview'
import { openCoverage, percent } from './coverageview'

/** The label column: two cells, the label (`view`, `notice`, `browser`), and the cells up to 17 before the words. */
export const ABOVE_LABEL = 17
/** The label column in a band narrower than this many columns (`  browser` and two cells before the words). */
const NARROW = 80
const NARROW_LABEL = 11

// ------------------------------------------------------------------------------------------------ shared state

/** Every feature on: thimble's defaults, and what a session that has no settings yet reads. */
export const FEATURES_ON: FeatureSettings = { viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }

/** The feature switches as the transcript's lane keeps them (C13 `settings`), every one on until then. */
export async function featuresOf(cx: Ctx): Promise<FeatureSettings> {
  return { ...FEATURES_ON, ...((await cx.settings()) ?? {}) }
}

/** Whether thimble is on in this session: its scope holds a workspace (activation put it there). */
export async function activeNow(cx: Ctx): Promise<boolean> {
  return Boolean(rt.sc?.ws) || (await cx.activated()) !== null
}

// the comments dismissed from the Checks view, gone at once (thimble's answer-comments read again leaves them out)
export const hiddenComments = new Set<string>()

/** The checks' open comments on answers, in the order they came. */
export async function openComments(cx: Ctx): Promise<AnswerComment[]> {
  return (await cx.answerComments()).filter(c => c.status !== 'dismissed' && !hiddenComments.has(c.id))
}

/** What the thimble line's `•` compares, now: each section's total, the threads' unread answers, the checks' comments. */
async function counts(cx: Ctx): Promise<SummarySeen & { unread: number }> {
  const home = await cx.home()
  const threads = await cx.threads()
  return {
    cards: home?.cards ?? 0,
    labels: home?.labels ?? 0,
    docs: home?.docs ?? 0,
    views: home?.views ?? 0,
    threads: threads.reduce((n, t) => n + (t.answers || 0), 0),
    unread: threads.reduce((n, t) => n + Math.max(0, t.unread || 0), 0),
    checks: (await openComments(cx)).length,
    at: await cx.now(),
  }
}

export type Section = 'cards' | 'labels' | 'docs' | 'views' | 'threads' | 'checks'

/** These sections' `•` cleared: their counts now are what was seen. */
export async function markSeen(cx: Ctx, sections: readonly Section[]): Promise<void> {
  // before the session's first count (firstSeen, after the first read of the workspace) nothing is new, and counts
  // taken now may be of nothing read yet (the home `/thimble` opens at activation): nothing to clear
  const cur = await cx.seen()
  if (!cur) return
  const now = await counts(cx)
  const next: SummarySeen = { ...cur, at: now.at }
  for (const s of sections) next[s] = now[s]
  await cx.setSeen(next)
  // the workspace's counts as seen, kept for a relaunch (kept.ts), so what was seen is not new after it either
  const home = await cx.home()
  const had = (await cx.homeSeen()) ?? home
  if (home && had && rt.sc) {
    const kept = { ...had }
    for (const s of sections) if (s === 'cards' || s === 'labels' || s === 'docs' || s === 'views') kept[s] = home[s]
    if (sections.includes('cards')) kept.at = home.at || now.at
    await cx.setHomeSeen(kept)
    await keepSeen(cx, rt.sc.ws, kept)
  }
  // a write made inside another write's hook draws its readers only at their next drawing: the band draws again now
  await cx.bumpPanel()
}

/** The session's first count: what home held when it was last seen (kept in the workspace, kept.ts), else what there is
 *  now, so nothing is new at activation. */
export async function firstSeen(cx: Ctx): Promise<void> {
  if (await cx.seen()) return
  const now = await counts(cx)
  const kept = (await cx.homeSeen()) ?? keptSeen()
  await cx.setSeen({ cards: kept?.cards ?? now.cards, labels: kept?.labels ?? now.labels, docs: kept?.docs ?? now.docs, views: kept?.views ?? now.views, threads: now.threads, checks: now.checks, at: now.at })
}

/** A section's list opened in the panel, its `•` cleared: the open handed back, so a press's open is the person's. */
export async function openSection(cx: Ctx, s: 'labels' | 'threads' | 'views' | 'docs'): Promise<void> {
  await markSeen(cx, [s])
  const titles = { labels: 'Labels', threads: 'Threads', views: 'Views', docs: 'Documents' }
  await openPanel(cx, { view: s, title: titles[s] })
}

/** The section a panel view shows, whose `•` clears when the panel shows it (home holds the cards). */
const LIST_OF: Record<string, Section> = { home: 'cards', labels: 'labels', threads: 'threads', views: 'views', docs: 'docs', checks: 'checks' }

/** The thimble line's counts read again (views.ts re-exports it; term.ts tick calls it when the workspace changes): the
 *  labels' unsure counts (the panel's Labels view lists those records), the first seen counts, a toast for each new
 *  notice of the workspace's. */
export async function refreshSummary(cx: Ctx): Promise<void> {
  if (!rt.sc || !(await activeNow(cx))) return
  const f = await featuresOf(cx)
  if (f.labels) {
    const got = await readState<{ labels?: unknown }>(cx, rt.sc, 'label-unsure', ['--counts'])
    const rows = got.ok && Array.isArray(got.value.labels) ? (got.value.labels as Record<string, unknown>[]) : null
    if (rows) {
      const next = rows.map(r => ({ id: String(r.id ?? ''), name: String(r.name ?? r.id ?? ''), noFit: Number(r.noFit) || 0, unsure: Number(r.unsure) || 0 }))
      if (JSON.stringify(next) !== JSON.stringify(await cx.labelUnsure())) await cx.setLabelUnsure(next)
    }
    // the records the panel lists under a label, read again
    await refreshUnsure(cx)
  }
  await firstSeen(cx)
  toastNewNotices(cx, await noticesRead(cx))
  await noteWriters(cx)
}

// each writer's state when last seen, by its chat (null until the session's first look, which notes what runs already)
let writers: Map<string, string> | null = null

/** A writer that starts or ends while no browser shows thimble's page: one toast that says where the report is
 *  (SPEC-v2 3.14: reports are written and edited in the browser workbench). */
async function noteWriters(cx: Ctx): Promise<void> {
  const now = new Map((await cx.agents()).filter(a => a.role === 'writer').map(a => [a.chat || a.name, a] as const))
  const before = writers
  writers = new Map([...now].map(([k, a]) => [k, a.state]))
  if (!before) return
  // the documents read again once a writer ends, so the line under the row that says so links its document
  // (register.tsx writtenEl)
  if ([...now].some(([k, a]) => before.get(k) === 'running' && a.state !== 'running')) await readSurface(cx, 'docs', 'docs')
  if (browserShown()) return
  for (const [k, a] of now) {
    const was = before.get(k)
    const started = was === undefined && a.state === 'running'
    const ended = was === 'running' && a.state !== 'running'
    if (!started && !ended) continue
    const docs = await surfaceValue(cx, 'docs')
    const writing = docs?.ok ? docsOf(docs.value).find(d => d.status === 'generating') : undefined
    const title = noControls(writing?.title || a.label.replace(/^writer:\s*/i, '') || 'the report')
    cx.toast(`the report "${title}" is in the browser workbench · /thimble browser`)
  }
}

// ------------------------------------------------------------------------------------------------ the thimble line

/** A share in the thimble line's words, as the Coverage view and coverage.py say it (coverageview.tsx percent). */
export { percent }

/** The thimble line's coverage value: the read share of the data by size (`15%`, a decimal kept under 1%), as the
 *  Coverage view's total and the line under answers measure it; with no index yet (no size), the files read. The
 *  Coverage view holds searched and the rows' units. */
export function coverageWords(s: CoverageSummary): string | null {
  if (s.size && s.size.total > 0) return percent(s.size.read, s.size.total)
  if (!(s.files.total > 0 || s.files.seen > 0)) return null
  return `${num(s.files.seen)} of ${num(s.files.total)} ${s.files.total === 1 ? 'file' : 'files'}`
}

const num = (n: number) => Math.round(n).toLocaleString('en-US')

/** The cells between two items of the thimble line (from the end of one's words to the start of the next one's, and
 *  before its `…`): three where every item fits so, else two. */
export const WIDE_GAP = 3
export const GAP = 2
/** The thimble line's own label, `  thimble` and the cell its hover lights after it (not the band's label column: the
 *  line reads as one run, and its six items fit a 100-column terminal); each item is a gap past the one before. */
export const LINE_LABEL_W = '  thimble'.length + 1

/** A run of an item's words and its look: its name (in the accent, underlined under the pointer), its value (bold), a
 *  mark in a color (`•`, `◌`, `N failed`), dim (a zero item's words). */
export type ItemSeg = { s: string; fg?: string; bold?: boolean; dim?: boolean; name?: boolean }

/** One item of the thimble line: its words, its press, whether its value is 0 (`zero`, dim whole and the first to go
 *  where the line is cut) and whether it has a `•` or a failure (`keep`, the last to go). */
export type SummaryItem = { key: string; segs: ItemSeg[]; press: () => Promise<void>; zero: boolean; keep: boolean }

/** The width of an item's words. */
export function itemWidth(it: Pick<SummaryItem, 'segs'>): number {
  return it.segs.reduce((n, s) => n + [...s.s].length, 0)
}

/** The citations of the session's answers and of its cards' takeaways: how many, how many are being checked, and how
 *  many failed, as the Citations view lists them (citesview.tsx citeItems, where the one definition of a citation that
 *  counts lives, which the footer under an answer uses too). */
export async function citationCounts(cx: Ctx): Promise<{ all: number; pending: number; bad: number }> {
  return citeCounts(await citeItems(cx))
}

/** Home opened on the first new card, found by what was seen before this press (else the first new view, report or
 *  label), and the cards seen: the press of `thimble` and of the cards' item. The `•` clears here, not only in the
 *  panel's `state.set` hook, whose write draws the line again only at its next drawing. */
export async function openHomeSeen(cx: Ctx): Promise<void> {
  await openHomeNew(cx)
  await markSeen(cx, ['cards'])
}

/** The thimble line's items, in their order: cards, threads, citations, labels, checks, coverage, each but the cards'
 *  and the threads' only while its feature is on. */
export async function summaryItems(cx: Ctx): Promise<SummaryItem[]> {
  const f = await featuresOf(cx)
  const now = await counts(cx)
  const seen = (await cx.seen()) ?? now
  const items: SummaryItem[] = []
  const newOf = (k: Section) => Math.max(0, now[k] - seen[k])
  // `name value`, then a `•` when something is new and the item's own marks (`N failed` two cells after what is before
  // it, as the mockups have it); a zero item dim whole, with no marks
  const add = (key: string, name: string, n: number, value: string, fresh: boolean, marks: ItemSeg[], press: () => Promise<void>) => {
    const zero = n === 0
    const segs: ItemSeg[] = zero ? [{ s: name, dim: true, name: true }, { s: ' ' }, { s: value, dim: true }] : [{ s: name, fg: COLORS.accent, name: true }, { s: ' ' }, { s: value, bold: true }]
    if (!zero && fresh) segs.push({ s: ' ' }, { s: '•', fg: COLORS.cite, bold: true })
    if (!zero) for (const m of marks) segs.push({ s: m.fg === COLORS.problem ? '  ' : ' ' }, m)
    items.push({ key, segs, press, zero, keep: !zero && (fresh || marks.some(m => m.fg === COLORS.problem)) })
  }
  add('cards', 'cards', now.cards, num(now.cards), newOf('cards') > 0, [], () => openHomeSeen(cx))
  const threads = (await cx.threads()).length
  add('threads', 'threads', threads, num(threads), Math.min(now.unread, newOf('threads')) > 0, [], () => openSection(cx, 'threads'))
  if (f.citationMarks) {
    const c = await citationCounts(cx)
    // no mark for citations that checked out: only a `◌` while any is checked and `N failed` in red
    const marks: ItemSeg[] = [...(c.pending ? [{ s: '◌', fg: COLORS.cite }] : []), ...(c.bad ? [{ s: `${num(c.bad)} failed`, fg: COLORS.problem, bold: true }] : [])]
    add('citations', 'citations', c.all, num(c.all), false, marks, () => openCitations(cx))
  }
  if (f.labels) add('labels', 'labels', now.labels, num(now.labels), newOf('labels') > 0, [], () => openSection(cx, 'labels'))
  if (f.checks) add('checks', 'checks', now.checks, num(now.checks), newOf('checks') > 0, [], () => openChecks(cx))
  if (f.coverage) {
    const s = await cx.coverageSummary()
    const read = s ? (s.size && s.size.total > 0 ? s.size.read : s.files.seen) : 0
    add('coverage', 'coverage', read > 0 ? 1 : 0, (s && coverageWords(s)) || '0%', false, [], () => openCoverage(cx))
  }
  return items
}

/** The items that fit `room` cells (the band's width less LINE_LABEL_W), each `gap` cells past the one before (and the
 *  first past `thimble`), in order: WIDE_GAP apart where all fit so, else GAP. Where all do not fit GAP apart, the zero
 *  items go first, then the others from the end, those that `keep` (a `•` or a failure) last; a dim `…` (`gap` after
 *  the last shown) ends the line. */
export function fitItems<T extends Pick<SummaryItem, 'segs'> & Partial<Pick<SummaryItem, 'zero' | 'keep'>>>(items: readonly T[], room: number): { shown: T[]; cut: boolean; gap: number } {
  const width = (xs: readonly T[], gap: number, cut: boolean) => xs.reduce((n, it) => n + itemWidth(it), 0) + gap * xs.length + (cut ? gap : 0)
  for (const gap of [WIDE_GAP, GAP]) if (width(items, gap, false) <= room) return { shown: [...items], cut: false, gap }
  const rank = (it: T) => (it.zero ? 0 : it.keep ? 2 : 1)
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || b.i - a.i)
  const left = new Set(items)
  for (const { it } of order) {
    left.delete(it)
    const shown = items.filter(x => left.has(x))
    if (width(shown, GAP, true) <= room) return { shown, cut: true, gap: GAP }
  }
  return { shown: [], cut: true, gap: GAP }
}

// ------------------------------------------------------------------------------------------------ the tray's rows

/** The cells between a row's words and its acts, and between two acts. */
export const ACT_GAP = 2
/** The fewest cells a row's words keep beside its acts: where the acts would leave them fewer (a band narrower than
 *  about 60 columns), the acts take a row of their own under the words. */
export const MIN_WORDS = 12

/** An act of a row above the prompt: its key, its words and its press; `primary`, the row's main act, is bold. One with
 *  no press is a state drawn dim in the acts' place (`◌ accepting`). `stay`: its press leaves the row (a copy), so the
 *  panel's `waiting` view stays on it. */
export type BandAct = { key: string; label: string; press?: () => Promise<void> | void; primary?: boolean; stay?: boolean }

/** The cells a row's acts take, ACT_GAP apart. */
export function actsWidth(acts: readonly Pick<BandAct, 'label'>[]): number {
  return acts.reduce((n, a, i) => n + width(a.label) + (i ? ACT_GAP : 0), 0)
}

/** The room of a row's words in a band `cols` wide, past its label column (`labelW`) and before its acts and the gap
 *  before them; the whole width past the label column, with the acts on a row of their own (`own`), where that room
 *  would be under MIN_WORDS. */
export function wordsRoom(cols: number, labelW: number, acts: readonly Pick<BandAct, 'label'>[]): { room: number; own: boolean } {
  const rest = Math.max(1, cols - labelW)
  if (!acts.length) return { room: rest, own: false }
  const room = rest - actsWidth(acts) - ACT_GAP
  return room >= MIN_WORDS ? { room, own: false } : { room: rest, own: true }
}

/** Words for a row: one line, no control characters. */
const oneLine = (s: string) => clean(s).replace(/\s+/g, ' ').trim()

/** The view proposal's line in `room` cells: its name, cut only where not even it fits, then two cells and as much of
 *  what the view would show as fits, cut at a word with `…` (none where fewer than two cells are left); `cut` when any
 *  of either is left out. */
export function offerWords(name: string, description: string, room: number): { name: string; rest: string; cut: boolean } {
  const n0 = oneLine(name)
  const d0 = oneLine(description)
  const n = cut(n0, room)
  const left = room - width(n) - 2
  const rest = d0 && left >= 2 ? cut(d0, left) : ''
  return { name: n, rest, cut: n !== n0 || rest !== d0 }
}

/** Under the pointer, a press of the band keeps its look (no inverse, no background): only its words underline (the
 *  owner's pick for the thimble line, 10-16 21:55, and for every act, 10-17); the focus still inverts it. */
const NO_INVERSE = { inverse: false }

// the view proposals dismissed from the band in this session: hidden, neither accepted nor rejected
const hiddenOffers = new Set<string>()

/** A view proposal's `dismiss`: the row gone at once, and thimble told, so the browser's card goes too (dismissOffer). */
async function hideOffer(cx: Ctx, slug: string): Promise<void> {
  hiddenOffers.add(slug)
  await cx.bumpPanel()
  await dismissOffer(cx, slug)
}

// the rows whose words show whole, wrapped (a press on words cut short), by the row's key, in this session
const unfolded = new Set<string>()

/** A row's words shown whole, or cut again. */
async function toggleRow(cx: Ctx, key: string): Promise<void> {
  if (!unfolded.delete(key)) unfolded.add(key)
  await cx.bumpPanel()
}

// whether the notices besides the newest show (`5 more notices ›` pressed), in this session; false again once only one
// is left, so the next that comes waits behind the row
let noticesOpen = false

/** The notices besides the newest shown, or behind their row again. */
async function toggleNotices(cx: Ctx): Promise<void> {
  noticesOpen = !noticesOpen
  await cx.bumpPanel()
}

/** One notice above the prompt: its row's key, when it was posted (ms), its words, its acts with `dismiss` last, and
 *  what `dismiss` does, which `dismiss all` does for each. */
type NoticeRow = { key: string; at: number; words: string; acts: BandAct[]; dismiss: () => Promise<void> }

/** What the view proposal's row says before the view's name: what the analyst gets (live feedback, 10-17: "What is this
 *  proposal?"). */
export const OFFER_LEAD = 'thimble can build a page for these records:'

/** The view proposal's acts, each saying what it does: `build it` (bold; accept), `don't build it` (reject),
 *  `stop suggesting pages`, which turns view proposals off, and `dismiss`; once one is pressed, its state
 *  (`◌ starting the build`) in their place. */
function offerActs(cx: Ctx, offer: HomeOffer): BandAct[] {
  return offer.pressed
    ? [{ key: 'above-offer-pressed', label: offer.pressed === 'accept' ? '◌ starting the build' : '◌ declining' }]
    : [
        { key: 'above-offer-accept', label: 'build it', primary: true, press: () => answerOffer(cx, offer.slug, 'accept') },
        { key: 'above-offer-reject', label: "don't build it", press: () => answerOffer(cx, offer.slug, 'reject') },
        { key: 'above-offer-off', label: 'stop suggesting pages', press: () => proposalsOff(cx) },
        { key: 'above-offer-dismiss', label: 'dismiss', press: () => hideOffer(cx, offer.slug) },
      ]
}

/** The view proposal the band shows: the one waiting for an answer, while view proposals are on and it is not
 *  dismissed here. */
async function shownOffer(cx: Ctx): Promise<HomeOffer | null> {
  const offer = (await featuresOf(cx)).viewProposals ? await homeOffer(cx) : null
  return offer && !hiddenOffers.has(offer.slug) ? offer : null
}

/** Every open notice, every agent's and the terminal's own, newest first, each with its acts and `dismiss` last; the
 *  first act bold where there are several. */
async function noticeRows(cx: Ctx): Promise<NoticeRow[]> {
  const notices = await homeNotices(cx)
  const mainFirst = (acts: BandAct[]) => acts.map((a, i) => (i === 0 && acts.length > 1 ? { ...a, primary: true } : a))
  return [
    ...notices.map(n => {
      const key = 'above-notice-' + n.id
      const dismiss = () => dismissNotice(cx, n)
      const acts = mainFirst([
        ...n.acts.map((a, i) => ({ key: `${key}-act-${i}`, label: noticeActWords(a), press: () => noticeAct(cx, n, a) })),
        ...(n.open ? [{ key: `${key}-open`, label: seeWords(n), press: () => openNoticeChat(cx, n) }] : []),
        { key: `${key}-dismiss`, label: 'dismiss', press: dismiss },
      ])
      return { key, at: n.at, words: noticeWords(n), acts, dismiss }
    }),
    ...(await modNotices(cx)).map(n => {
      const key = `above-mod-${n.key.replace(/[^a-z0-9-]+/gi, '-')}`
      const dismiss = () => dismissModNotice(cx, n.key)
      const acts = mainFirst([
        ...n.acts.map((a, i) => ({ key: `${key}-act-${i}`, label: modActWords(a), press: () => runNoticeAct(cx, n, a) })),
        { key: `${key}-dismiss`, label: 'dismiss', press: dismiss },
      ])
      return { key, at: n.at, words: n.text, acts, dismiss }
    }),
  ].sort((a, b) => b.at - a.at)
}

/** The SSH row's acts: `copy` the tunnel command, `copy link` (a one-time link, never drawn), `dismiss`. `stay`: the
 *  press leaves the row, so the next act is a key away. */
function remoteActs(cx: Ctx): BandAct[] {
  return [
    { key: 'above-remote-copy', label: 'copy', primary: true, stay: true, press: () => copyTunnel(cx) },
    { key: 'above-remote-link', label: 'copy link', stay: true, press: () => copyRemoteLink(cx) },
    { key: 'above-remote-dismiss', label: 'dismiss', press: () => dismissLinks(cx) },
  ]
}

/** A row above the prompt that waits for the analyst, as home lists it on Claude Code's main screen, where the band
 *  takes no clicks (bug hunt F1): its key, its label (the band's label column), its name (the view proposal's), its
 *  words, why its last act failed (`problem`, the view proposal's red row), and its acts, which the panel's `waiting`
 *  view presses with keys (waitview.tsx). */
export type WaitItem = { key: string; label: string; name: string; words: string; problem?: string; acts: BandAct[] }

/** What waits above the prompt, in the band's order: the view proposal, the notices, newest first, the SSH row. */
export async function waitItems(cx: Ctx): Promise<WaitItem[]> {
  const out: WaitItem[] = []
  const offer = await shownOffer(cx)
  if (offer) out.push({ key: `offer:${offer.slug}`, label: 'view', name: oneLine(offer.name), words: oneLine(`${OFFER_LEAD} ${offer.description}`), ...(offer.refused && !offer.pressed ? { problem: oneLine(offer.refused) } : {}), acts: offerActs(cx, offer) })
  for (const r of await noticeRows(cx)) out.push({ key: r.key, label: 'notice', name: '', words: oneLine(r.words), acts: r.acts })
  const links = await cx.links()
  if (links) out.push({ key: BROWSER_ITEM, label: 'browser', name: '', words: oneLine(remoteWords(links)), acts: remoteActs(cx) })
  return out
}

/** The thimble line's last words on Claude Code's main screen, which takes no clicks: where its keys are (bug hunt F1). */
export const CLASSIC_HINT = '/thimble to use these with keys'

export function registerBand(on: On): void {
  // the panel showing a section's list clears that section's `new`; any view but the checks' lets its comment go
  on('state.set', { plugin: 'thimble', key: 'panel' }, async ($, e, next) => {
    const done = await next(e)
    try {
      const p = (e as { value?: TermPanel | null }).value ?? null
      const cx = cxOf($)
      if (p && LIST_OF[p.view] && rt.sc) await markSeen(cx, [LIST_OF[p.view]!])
      if (p?.view !== 'checks' && (await cx.checksOpen()) !== null) await cx.setChecksOpen(null)
    } catch {
      // the panel shows what it was given whatever the band makes of it
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!rt.sc || e.props.hasSurvey) return next(e)
    const cx = cxOf($)
    // other plugins' rows first; thimble's after them
    const theirs = await next(e)
    if (!(await activeNow(cx))) return theirs
    // a bump of the panel draws the band again too (a row hidden here)
    await cx.panelTick()
    const panes = await cx.panes()
    if (e.surface === 'terminal' && e.viewport?.columns && !panes.some(p => p.isPlaced)) rt.termColumns = e.viewport.columns
    noteScreen(e.surface, (e.viewport as { isFullscreen?: unknown } | undefined)?.isFullscreen)
    const cols = Math.max(20, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 100)
    const narrow = cols < NARROW
    const LW = narrow ? NARROW_LABEL : ABOVE_LABEL
    const { Box, Text, Button } = cx.els(e)
    const rows: RenderElement[] = []
    const label = (s: string, color?: string) => (
      <Box width={LW} flexShrink={0}>
        {color ? <Text color={color}>{`  ${s}`}</Text> : <Text dimColor>{`  ${s}`}</Text>}
      </Box>
    )
    // a row under a row's label: the label's width left empty
    const under = (key: string, child: RenderElement) => (
      <Box key={key} flexDirection="row">
        {label('')}
        <Box flexShrink={1}>{child}</Box>
      </Box>
    )
    // an act: in the accent, as the thimble line's names, underlined under the pointer (its own keyed Box is what the
    // pointer is over), the row's main act bold; a state with no press dim
    const actEl = (a: BandAct) =>
      a.press ? (
        <Box key={`${a.key}-lit`} flexDirection="row" flexShrink={0}>
          <Button key={a.key} label={a.label} plain hover={NO_INVERSE} onPress={() => void a.press?.()}>
            <Text color={COLORS.accent} {...(a.primary ? { bold: true } : {})} hover={{ underline: true }}>
              {a.label}
            </Text>
          </Button>
        </Box>
      ) : (
        <Text key={a.key} dimColor>
          {a.label}
        </Text>
      )
    // one row: the label column, the words, the acts at the right ACT_GAP past them; the acts on a row of their own
    // under the words where wordsRoom says so; `more`, rows under it (the view proposal's files, why accept failed)
    const trayRow = (key: string, name: string, words: RenderElement, acts: readonly BandAct[], o: { color?: string; own?: boolean; more?: RenderElement[] } = {}) => {
      const actsEl = acts.length ? (
        <Box key={`${key}-acts`} flexDirection="row" columnGap={ACT_GAP} flexShrink={0} {...(o.own ? {} : { marginLeft: ACT_GAP })}>
          {acts.map(actEl)}
        </Box>
      ) : null
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row">
            {label(name, o.color)}
            <Box key={`${key}-words`} flexGrow={1} flexShrink={1}>
              {words}
            </Box>
            {o.own ? null : actsEl}
          </Box>
          {o.more ?? null}
          {o.own && actsEl ? under(`${key}-own-acts`, actsEl) : null}
        </Box>
      )
    }
    // a row's words, cut to its room; where cut, or shown whole after a press, the words are that press
    const foldWords = (key: string, text: string, room: number) => {
      const full = oneLine(text)
      const open = unfolded.has(key)
      const shown = open ? full : cut(full, room)
      if (shown === full && !open) return <Text wrap="truncate-end">{shown}</Text>
      return (
        <Button key={`${key}-more`} plain hover={NO_INVERSE} onPress={() => toggleRow(cx, key)}>
          <Text wrap={open ? 'wrap' : 'truncate-end'}>{shown}</Text>
        </Button>
      )
    }
    // a side thread's agent in view (Claude Code's agent list, Enter on it; live feedback, 10-17: a question typed there
    // by mistake, its answer waited for there 10 minutes): one row, `thread` on the label column, which thread it is,
    // that what the analyst types here goes to it and that its answers show in the thread; `back to main` (bold), which
    // puts main's transcript back in view, and `open the thread`, thimble's panel on it. Any other agent's view keeps
    // Claude Code's own band, with none of thimble's rows
    if (e.props.view.agentId) {
      const fork = (await cx.threads()).find(t => t.forkAgent === e.props.view.agentId)
      if (!fork) return theirs
      const acts: BandAct[] = [
        {
          key: 'above-fork-main',
          label: 'back to main',
          primary: true,
          press: async () => {
            const why = await cx.viewMain()
            if (why) cx.toast(`main did not come back: ${why}. Choose main in the agent list under the prompt`)
          },
        },
        { key: 'above-fork-open', label: 'open the thread', press: () => openThread(cx, fork.id) },
      ]
      const asked = clip(plainCites(fork.question || fork.title || fork.anchorText).replace(/\s+/g, ' ').trim(), 60)
      const words = `This is side thread ${quoted(asked)}. What you type here goes to it, and its answers show in the thread.`
      // whole and wrapped, as a notice's, so a narrow band beside the panel keeps where the answer goes
      return (
        <Box flexDirection="column">
          {theirs}
          {trayRow('above-fork', 'thread', <Text wrap="wrap">{words}</Text>, acts, { own: wordsRoom(cols, LW, acts).own })}
        </Box>
      )
    }
    // a panel Claude Code left undrawn (an open it was not asked for, on a terminal narrower than it places those at),
    // and why; `open panel` opens it as `/thimble` does, from the press, which Claude Code places at any width. Gone
    // once the pane is drawn (Claude Code places it when the terminal is widened to that width)
    const pending = await cx.pending()
    const placed = panes.some(p => p.id === PANEL && p.isPlaced)
    if (pending && placed) cx.later(0, () => void placedLater(cx))
    if (pending && !placed) {
      const columns = (e.surface === 'terminal' ? e.viewport?.columns : 0) || pending.columns || 0
      const more = pending.floor && columns ? pending.floor - columns : 0
      if (pending.floor && columns && more <= 0) cx.later(0, () => void retryPending(cx, columns))
      const acts: BandAct[] = [
        { key: 'above-panel-open', label: 'open panel', primary: true, press: () => openPending(cx) },
        { key: 'above-panel-dismiss', label: 'dismiss', press: () => closePanel(cx) },
      ]
      const { room, own } = wordsRoom(cols, LW, acts)
      rows.push(trayRow('above-panel', 'panel', foldWords('above-panel', `${pending.title} is ready`, room), acts, { own }))
    }
    // the view proposal waiting for the analyst's answer (proposer.py, or a viewer for a file type), until it is answered
    // and whatever the panel shows: `view` dim on the label column, then what the analyst gets, `thimble can build a
    // page for these records:` and the view's name bold, and not the task it names; what the page would show whole
    // under it; a press on the name shows a viewer's files; `build it` (bold), `don't build it`, `stop suggesting
    // pages`, which turns view proposals off, and `dismiss`; why the build could not start, in red, under it
    const offer = await shownOffer(cx)
    if (offer) {
      const acts = offerActs(cx, offer)
      const name = oneLine(offer.name)
      // the acts on a row of their own where they would cut what the row says
      const fit = wordsRoom(cols, LW, acts)
      const own = fit.own || fit.room < width(`${OFFER_LEAD} ${name}`)
      const open = unfolded.has(`offer:${offer.slug}`)
      // what the analyst gets and the name on the row with the acts; what the page would show, whole and wrapped, on
      // the rows under it (the owner, 10-17: the full text must be readable); a press on the name shows a file-type
      // viewer's files
      const words = (
        <Button key="above-offer-name" plain hover={NO_INVERSE} onPress={() => toggleRow(cx, `offer:${offer.slug}`)}>
          <Text wrap="wrap">
            {`${OFFER_LEAD} `}
            <Text bold hover={{ underline: true }}>
              {name}
            </Text>
          </Text>
        </Button>
      )
      const more: RenderElement[] = []
      const description = oneLine(offer.description)
      if (description) more.push(under('above-offer-desc', <Text wrap="wrap">{description}</Text>))
      if (open && !offer.task && offer.claims.length) {
        more.push(under('above-offer-files', <Text wrap="wrap"><Text dimColor>{'files  '}</Text>{oneLine(offer.claims.join(', '))}</Text>))
      }
      if (offer.refused && !offer.pressed) {
        const why = oneLine(offer.refused)
        more.push(under('above-offer-refused', <Text color={COLORS.problem} wrap={open ? 'wrap' : 'truncate-end'}>{open ? why : cut(why, cols - LW)}</Text>))
      }
      rows.push(trayRow('above-offer', 'view', words, acts, { own, more }))
    }
    // every open notice, every agent's and the terminal's own, newest first: `notice` in red on the label column, the
    // words in the text color, whole and wrapped; then the acts that fix it, the agent's thread (`see the orientation ›`)
    // and `dismiss`, each saying what its press does. Notices with the same words are one row, their count first (`3×
    // …`), and `dismiss` takes them all. The newest shows; the others wait behind one row under it, `5 more notices ›`,
    // whose press shows them there and turns into `show fewer`, with `dismiss all` at the right. Each new one posts one
    // toast (notices.tsx)
    toastNewNotices(cx, await noticesRead(cx))
    const all = await noticeRows(cx)
    if (all.length < 2) noticesOpen = false
    const noticeEl = (r: NoticeRow) =>
      trayRow(r.key, 'notice', <Text wrap="wrap">{oneLine(r.words)}</Text>, r.acts, { color: COLORS.problem, own: wordsRoom(cols, LW, r.acts).own })
    for (const r of noticesOpen ? all : all.slice(0, 1)) rows.push(noticeEl(r))
    if (all.length > 1) {
      const toggle = (
        <Button key="above-notices-toggle" plain hover={NO_INVERSE} onPress={() => toggleNotices(cx)}>
          <Text color={COLORS.accent} wrap="truncate-end" hover={{ underline: true }}>
            {noticesOpen ? 'show fewer' : moreNotices(all.length - 1)}
          </Text>
        </Button>
      )
      const acts: BandAct[] = noticesOpen
        ? [
            {
              key: 'above-notices-all',
              label: 'dismiss all',
              press: async () => {
                for (const r of all) await r.dismiss()
              },
            },
          ]
        : []
      rows.push(trayRow('above-notices-more', '', toggle, acts))
    }
    // the one SSH row of a press that opened no browser here: in plain words, the tunnel command (its Eternal Terminal
    // form when there is one) to run on your own computer, then `copy link` (bug hunt F11); `copy` the command, `copy
    // link` (a one-time link, never drawn), `dismiss`. It goes once a browser claims the link (offramp.ts watchLink)
    const links = await cx.links()
    if (links) {
      const acts = remoteActs(cx)
      const { room, own } = wordsRoom(cols, LW, acts)
      rows.push(trayRow('above-remote', 'browser', foldWords('above-remote', remoteWords(links), room), acts, { own }))
    }
    // the thimble line, the one row that stays while thimble is on: `thimble` bold, in the accent and underlined, which
    // opens home; then the items that fit. Under the pointer an item's name underlines, nothing else changes
    const fit = fitItems(await summaryItems(cx), cols - LINE_LABEL_W)
    // on Claude Code's main screen nothing here takes a click: the line ends with where the keys are, where it fits
    const used = fit.shown.reduce((n, it) => n + itemWidth(it), 0) + fit.gap * fit.shown.length + (fit.cut ? fit.gap + 1 : 0)
    const keysHint = classicScreen() && cols - LINE_LABEL_W - used >= width(CLASSIC_HINT) + fit.gap ? CLASSIC_HINT : ''
    const segEl = (s: ItemSeg) =>
      s.fg || s.bold || s.dim || s.name ? (
        <Text {...(s.fg ? { color: s.fg } : {})} {...(s.bold ? { bold: true } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.name ? { hover: { underline: true } } : {})}>
          {s.s}
        </Text>
      ) : (
        s.s
      )
    // one blank row between Claude Code's own rows above (its spinner, a tip) and the line (the owner, 10-17)
    rows.push(<Text key="above-summary-gap"> </Text>)
    rows.push(
      <Box key="above-summary" flexDirection="row">
        <Text>{'  '}</Text>
        <Box flexDirection="row" columnGap={fit.gap - 1} flexShrink={0}>
          <Box key="above-summary-lit-thimble" flexDirection="row" flexShrink={0}>
            <Button key="above-summary-thimble" plain hover={NO_INVERSE} onPress={() => openHomeSeen(cx)}>
              <Text bold underline color={COLORS.accent}>
                thimble
              </Text>
            </Button>
            <Text>{' '}</Text>
          </Box>
          {fit.shown.map(it => (
            <Box key={`above-summary-lit-${it.key}`} flexDirection="row" flexShrink={0}>
              <Button key={`above-summary-${it.key}`} plain hover={NO_INVERSE} onPress={it.press}>
                {it.segs.map(segEl)}
              </Button>
              <Text>{' '}</Text>
            </Box>
          ))}
          {fit.cut ? <Text key="above-summary-cut" dimColor>…</Text> : null}
          {keysHint ? <Text key="above-summary-keys" dimColor>{keysHint}</Text> : null}
        </Box>
      </Box>,
    )
    return (
      <Box flexDirection="column">
        {theirs}
        {rows}
      </Box>
    )
  })
}
