// The rows above the prompt (the AbovePrompt band, SPEC-v2 3.8): thimble's rows stand after other plugins' rows, at
// most these, top to bottom: a panel that waits undrawn and why (the narrow fallback), the view proposal waiting for an
// answer, the open notices (the workspace's and the terminal's own, notices.tsx), the one SSH row of a remote press
// (offramp.ts), and last the thimble line, the one row that stays while thimble is on (the owner's design, 10-16 21:30,
// with the look of mock3/line2 A3; under the pointer the name underlines, 10-16 21:55):
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
// register.tsx calls registerBand once; each hook builds its context with register.tsx's cxOf (imported, so `claude
// plugin validate` follows `$` into it). refreshSummary (views.ts re-exports it; term.ts tick calls it when the workspace
// changes) reads the labels' unsure counts, notes the seen counts on the session's first pass, toasts each new notice of
// the workspace's, and toasts a writer's start and end while no browser shows thimble's page.
import type { On, RenderElement } from 'claude-code'

import type { AnswerComment, CoverageSummary, FeatureSettings, SummarySeen, TermPanel } from './types'
import type { Ctx } from './ctx'
import { citations, labelRef, noControls } from './lib'
import { docsOf } from './model'
import { dismissModNotice, modNotices, runNoticeAct, toastNewNotices } from './notices'
import { browserShown, copyRemoteLink, copyTunnel, dismissLinks } from './offramp'
import { answerOffer, dismissNotice, homeNotices, homeOffer, noticeAct, openHomeNew, openNoticeChat, proposalsOff, refreshUnsure } from './panel'
import { COLORS } from './paint'
import { readState } from './data'
import { cxOf } from './ctx'
import { PANEL, closePanel, openPanel, openPending, placedLater, readSurface, retryPending, rt, surfaceValue } from './term'
import { keepSeen, keptSeen } from './kept'
import { openChecks } from './checksview'
import { citeItems, openCitations } from './citesview'
import { openCoverage, percent } from './coverageview'

const ABOVE_LABEL = 16
/** The label column in a band narrower than this many columns. */
const NARROW = 80
const NARROW_LABEL = 10

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
  toastNewNotices(cx, await homeNotices(cx))
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
    cx.toast(`thimble: the report "${title}" is in the browser workbench · /thimble open`)
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
 *  many failed, as the Citations view lists them (citesview.tsx citeItems: a chat citation not found or refuted, a
 *  takeaway's citation its links check found another value for, typed in or left unchecked). */
export async function citationCounts(cx: Ctx): Promise<{ all: number; pending: number; bad: number }> {
  const items = await citeItems(cx)
  let all = items.filter(it => it.key.startsWith('chat:')).length
  let pending = items.filter(it => it.verdict === 'pending').length
  const bad = items.filter(it => it.verdict !== 'pending' && it.verdict !== 'ok').length
  for (const id of rt.shown) {
    const tc = await cx.card(id)
    if (!tc) continue
    const l = tc.links as (NonNullable<typeof tc.links> & { quiet?: unknown[] }) | undefined
    const checked = l ? (Array.isArray(l.ok) ? l.ok.length : 0) + l.broken.length + (l.typed ?? []).length + (Array.isArray(l.quiet) ? l.quiet.length : 0) : 0
    const n = Math.max(citations(tc.takeaway || '').filter(c => !labelRef(c.ref)).length, checked)
    all += n
    if (n && l?.pending) pending++
  }
  return { all, pending, bad }
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

/** Under the pointer, a press of the thimble line keeps its look (no inverse, no background): only its name
 *  underlines (the owner's pick, 10-16 21:55); the focus still inverts it. */
const NO_INVERSE = { inverse: false }

// ------------------------------------------------------------------------------------------------ the band

// the view proposals dismissed from the band in this session: hidden, neither accepted nor rejected
const hiddenOffers = new Set<string>()

async function hideOffer(cx: Ctx, slug: string): Promise<void> {
  hiddenOffers.add(slug)
  await cx.bumpPanel()
}

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
    if (!rt.sc || e.props.hasSurvey || e.props.view.agentId) return next(e)
    const cx = cxOf($)
    // other plugins' rows first; thimble's after them
    const theirs = await next(e)
    if (!(await activeNow(cx))) return theirs
    // a bump of the panel draws the band again too (a row hidden here)
    await cx.panelTick()
    const panes = await cx.panes()
    if (e.surface === 'terminal' && e.viewport?.columns && !panes.some(p => p.isPlaced)) rt.termColumns = e.viewport.columns
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
    // a row of words that wrap and acts that are never cut, under its label
    const actRow = (key: string, name: string, words: RenderElement, acts: RenderElement[], color?: string) => (
      <Box key={key} flexDirection="row">
        {label(name, color)}
        <Box flexDirection="row" columnGap={2} flexShrink={1}>
          <Box flexShrink={1}>{words}</Box>
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            {acts}
          </Box>
        </Box>
      </Box>
    )
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
      rows.push(
        actRow('above-panel', 'panel', <Text wrap="truncate-end">{`${pending.title} is ready`}</Text>, [
          <Button key="above-panel-open" label="open panel" plain onPress={() => openPending(cx)} />,
          <Button key="above-panel-dismiss" label="dismiss" plain onPress={() => closePanel(cx)} />,
        ]),
      )
    }
    // the view proposal waiting for the analyst's answer (proposer.py, or a viewer for a file type), until it is answered
    // and whatever the panel shows: `view proposal` in the accent, its name in bold, what it would show (for a viewer of
    // a file type, then its files) wrapped whole, never behind a press, and not the task it names; `accept`, `reject` and
    // `don't ask again`, which turns view proposals off; why accept could not start its build, in red, under them
    const offer = (await featuresOf(cx)).viewProposals ? await homeOffer(cx) : null
    if (offer && !hiddenOffers.has(offer.slug)) {
      const accept = () => answerOffer(cx, offer.slug, 'accept')
      const reject = () => answerOffer(cx, offer.slug, 'reject')
      rows.push(
        actRow(
          'above-offer',
          narrow ? 'proposal' : 'view proposal',
          <Text bold wrap="wrap">{offer.name}</Text>,
          offer.pressed
            ? [<Text key="above-offer-pressed" dimColor>{offer.pressed === 'accept' ? '◌ accepting' : '◌ rejecting'}</Text>]
            : [
                <Button key="above-offer-accept" label="accept" plain onPress={accept} />,
                <Button key="above-offer-reject" label="reject" plain onPress={reject} />,
                <Button key="above-offer-off" label="don't ask again" plain onPress={() => proposalsOff(cx)} />,
                <Button key="above-offer-dismiss" label="dismiss" plain onPress={() => hideOffer(cx, offer.slug)} />,
              ],
          COLORS.accent,
        ),
      )
      if (offer.description) rows.push(under('above-offer-description', <Text wrap="wrap">{offer.description}</Text>))
      if (!offer.task && offer.claims.length) rows.push(under('above-offer-files', <Text wrap="wrap"><Text dimColor>{'files  '}</Text>{offer.claims.join(', ')}</Text>))
      if (offer.refused && !offer.pressed) rows.push(under('above-offer-refused', <Text color={COLORS.problem} wrap="wrap">{offer.refused}</Text>))
    }
    // every agent's open notices, newest first, then the terminal's own: a failure with its fix, in red, wrapped whole;
    // then the acts that fix it, `open ›` to the agent's thread, `dismiss`. Each new one posts one toast (notices.tsx)
    const notices = await homeNotices(cx)
    toastNewNotices(cx, notices)
    for (const n of notices) {
      rows.push(
        actRow('above-notice-' + n.id, 'notice', <Text color={COLORS.problem} wrap="wrap">{n.text}</Text>, [
          ...n.acts.map((a, i) => <Button key={`above-notice-${n.id}-act-${i}`} label={a.label} plain onPress={() => noticeAct(cx, n, a)} />),
          ...(n.open ? [<Button key={`above-notice-${n.id}-open`} label="open ›" plain onPress={() => openNoticeChat(cx, n)} />] : []),
          <Button key={`above-notice-${n.id}-dismiss`} label="dismiss" plain onPress={() => dismissNotice(cx, n)} />,
        ]),
      )
    }
    for (const n of await modNotices(cx)) {
      const k = n.key.replace(/[^a-z0-9-]+/gi, '-')
      rows.push(
        actRow(`above-mod-${k}`, 'notice', <Text color={COLORS.problem} wrap="wrap">{n.text}</Text>, [
          ...n.acts.map((a, i) => <Button key={`above-mod-${k}-act-${i}`} label={a} plain onPress={() => runNoticeAct(cx, n, a)} />),
          <Button key={`above-mod-${k}-dismiss`} label="dismiss" plain onPress={() => dismissModNotice(cx, n.key)} />,
        ]),
      )
    }
    // the one SSH row of a remote press: the tunnel command (its Eternal Terminal form when there is one), `copy` it,
    // `copy link` (a one-time link, never drawn), `dismiss`
    const links = await cx.links()
    if (links) {
      rows.push(
        actRow('above-remote', 'browser', <Text wrap="wrap">{links.et ?? links.tunnel}</Text>, [
          <Button key="above-remote-copy" label="copy" plain onPress={() => copyTunnel(cx)} />,
          <Button key="above-remote-link" label="copy link" plain onPress={() => copyRemoteLink(cx)} />,
          <Button key="above-remote-dismiss" label="dismiss" plain onPress={() => dismissLinks(cx)} />,
        ]),
      )
    }
    // the thimble line, the one row that stays while thimble is on: `thimble` bold, in the accent and underlined, which
    // opens home; then the items that fit. Under the pointer an item's name underlines, nothing else changes
    const fit = fitItems(await summaryItems(cx), cols - LINE_LABEL_W)
    const segEl = (s: ItemSeg) =>
      s.fg || s.bold || s.dim || s.name ? (
        <Text {...(s.fg ? { color: s.fg } : {})} {...(s.bold ? { bold: true } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.name ? { hover: { underline: true } } : {})}>
          {s.s}
        </Text>
      ) : (
        s.s
      )
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
