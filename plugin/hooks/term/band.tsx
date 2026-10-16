// The rows above the prompt (the AbovePrompt band, SPEC-v2 3.8): thimble's rows stand after other plugins' rows, at
// most these, top to bottom: a panel that waits undrawn and why (the narrow fallback), the view proposal waiting for an
// answer, the open notices (the workspace's and the terminal's own, notices.tsx), the one SSH row of a remote press
// (offramp.ts), and last the summary line, the one row that stays:
//
//   thimble   cards 2 new   citations ✓18 ×1   coverage 2%   labels 1 new 3 unsure   threads 1 new   …   open ›   dismiss
//
// An item shows only after activation, only when it is not zero, and only for a feature that is on; `new` is green and
// `×N` red. Each item is a plain Button whose press opens the panel at its section (the open is the person's own, so
// Claude Code places it at any width); `open ›` opens home and marks nothing seen; `dismiss` marks every section seen and
// opens nothing. The line is cut at its end to the band's width, `open ›` and `dismiss` never. A section's `new` clears
// when the panel shows its list (labels, threads, views, documents, checks) or its item is pressed; the counts as last
// seen are `$.state.seen` (C13), and a session's first count is what was there already, so nothing is new at
// activation.
//
// register.tsx calls registerBand once; each hook builds its context with register.tsx's cxOf (imported, so `claude
// plugin validate` follows `$` into it). refreshSummary (views.ts re-exports it; term.ts tick calls it when the workspace
// changes) reads the labels' unsure counts, notes the seen counts on the session's first pass, toasts each new notice of
// the workspace's, and toasts a writer's start and end while no browser shows thimble's page.
import type { On, RenderElement } from 'claude-code'

import type { AnswerComment, FeatureSettings, SummarySeen, TermPanel } from './types'
import type { Ctx } from './ctx'
import { cid, noControls } from './lib'
import { docsOf } from './model'
import { dismissModNotice, modNotices, runNoticeAct, toastNewNotices } from './notices'
import { browserShown, copyRemoteLink, copyTunnel, dismissLinks } from './offramp'
import { answerOffer, dismissNotice, homeNotices, homeOffer, noticeAct, openHomeNew, openNoticeChat, proposalsOff, refreshUnsure } from './panel'
import { COLORS } from './paint'
import { readState } from './data'
import { cxOf } from './ctx'
import { PANEL, closePanel, openPanel, openPending, placedLater, retryPending, rt, surfaceValue } from './term'
import { keepSeen, keptSeen } from './kept'
import { openChecks } from './checksview'
import { openCitations } from './citesview'
import { openCoverage } from './coverageview'

const ABOVE_LABEL = 16
/** The label column in a band narrower than this many columns. */
const NARROW = 80
const NARROW_LABEL = 10

// ------------------------------------------------------------------------------------------------ shared state

/** Every feature on: thimble's defaults, and what a session that has no settings yet reads. */
export const FEATURES_ON: FeatureSettings = { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }

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

/** What the summary line counts, now: each section's total, the threads' unread answers, the checks' comments. */
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
export const SECTIONS: readonly Section[] = ['cards', 'labels', 'docs', 'views', 'threads', 'checks']

/** These sections' `new` cleared: their counts now are what was seen. */
export async function markSeen(cx: Ctx, sections: readonly Section[]): Promise<void> {
  const now = await counts(cx)
  const cur = (await cx.seen()) ?? now
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

/** A section's list opened in the panel, its `new` cleared: the open handed back, so a press's open is the person's. */
export async function openSection(cx: Ctx, s: 'labels' | 'threads' | 'views' | 'docs'): Promise<void> {
  await markSeen(cx, [s])
  const titles = { labels: 'Labels', threads: 'Threads', views: 'Views', docs: 'Documents' }
  await openPanel(cx, { view: s, title: titles[s] })
}

/** The section a panel view is the list of, whose `new` clears when the panel shows it. */
const LIST_OF: Record<string, Section> = { labels: 'labels', threads: 'threads', views: 'views', docs: 'docs', checks: 'checks' }

/** The summary line's counts read again (views.ts re-exports it; term.ts tick calls it when the workspace changes): the
 *  labels' unsure counts, the first seen counts, a toast for each new notice of the workspace's. */
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
  if (!before || browserShown()) return
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

// ------------------------------------------------------------------------------------------------ the summary line

/** A share of records in the summary line's words: `0%`, `<1%` or a whole percent (coverage.py summary). */
export function percent(seen: number, total: number): string {
  if (!total || seen <= 0) return '0%'
  const p = (100 * seen) / total
  return p < 1 ? '<1%' : `${Math.min(100, Math.round(p))}%`
}

const num = (n: number) => Math.round(n).toLocaleString('en-US')

/** One item of the summary line: its words as segments (`new` green, `×N` red), and its press. */
export type SummaryItem = { key: string; segs: { s: string; fg?: string }[]; press: () => Promise<void> }

/** The width of an item's words. */
export function itemWidth(it: Pick<SummaryItem, 'segs'>): number {
  return it.segs.reduce((n, s) => n + [...s.s].length, 0)
}

/** The citations' counts: chat citations checked and found (✓), and the problems of chat citations and of the cards'
 *  links checks (×). */
export async function citationCounts(cx: Ctx): Promise<{ ok: number; bad: number }> {
  let ok = 0
  let bad = 0
  const seen = new Set<string>()
  for (const c of await cx.citeIndex()) {
    const id = cid(c.raw)
    if (seen.has(id)) continue
    seen.add(id)
    const v = await cx.verdict(id)
    if (v?.status === 'missing' || v?.status === 'differs') bad++
    else if (v?.status === 'ok') ok++
  }
  for (const id of rt.shown) {
    const l = (await cx.card(id))?.links as (NonNullable<Awaited<ReturnType<Ctx['card']>>>['links'] & { quiet?: unknown[] }) | undefined
    if (l) bad += l.broken.length + (l.typed ?? []).length + (Array.isArray(l.quiet) ? l.quiet.length : 0)
  }
  return { ok, bad }
}

/** The summary line's items, in order, each only when not zero and its feature on; and whether any is new. */
export async function summaryItems(cx: Ctx): Promise<{ items: SummaryItem[]; fresh: boolean }> {
  const f = await featuresOf(cx)
  const now = await counts(cx)
  const seen = (await cx.seen()) ?? now
  const items: SummaryItem[] = []
  let fresh = false
  const isNew = (n: number) => (n > 0 ? [{ s: `${num(n)} ` }, { s: 'new', fg: COLORS.fresh }] : [])
  const add = (key: string, word: string, parts: { s: string; fg?: string }[], press: () => Promise<void>) => {
    if (!parts.length) return
    const segs: { s: string; fg?: string }[] = [{ s: word }]
    for (const p of parts) segs.push({ s: ' ' }, p)
    items.push({ key, segs: segs.reduce<{ s: string; fg?: string }[]>((out, s) => (out.length && !s.fg && !out.at(-1)!.fg ? [...out.slice(0, -1), { s: out.at(-1)!.s + s.s }] : [...out, s]), []), press })
  }
  const newOf = (k: Section) => Math.max(0, now[k] - seen[k])
  const cards = newOf('cards')
  if (cards) fresh = true
  add('cards', 'cards', cards ? joinNew(isNew(cards)) : [], async () => {
    await markSeen(cx, ['cards'])
    await openHomeNew(cx)
  })
  if (f.citationMarks) {
    const c = await citationCounts(cx)
    add('citations', 'citations', [...(c.ok ? [{ s: `✓${num(c.ok)}` }] : []), ...(c.bad ? [{ s: `×${num(c.bad)}`, fg: COLORS.problem }] : [])], () => openCitations(cx))
  }
  if (f.coverage) {
    const s = await cx.coverageSummary()
    if (s && (s.files.total > 0 || s.files.seen > 0)) {
      const words = s.records.counted && s.records.total > 0 ? percent(s.records.seen, s.records.total) : `${num(s.files.seen)} of ${num(s.files.total)} files`
      add('coverage', 'coverage', [{ s: words }], () => openCoverage(cx))
    }
  }
  if (f.labels) {
    const labels = newOf('labels')
    if (labels) fresh = true
    const unsure = (await cx.labelUnsure()).reduce((n, l) => n + l.noFit + l.unsure, 0)
    add('labels', 'labels', [...joinNew(isNew(labels)), ...(unsure ? [{ s: `${num(unsure)} unsure` }] : [])], () => openSection(cx, 'labels'))
  }
  const threads = Math.min(now.unread, newOf('threads'))
  if (threads) fresh = true
  add('threads', 'threads', joinNew(isNew(threads)), () => openSection(cx, 'threads'))
  const views = newOf('views')
  if (views) fresh = true
  add('views', 'views', joinNew(isNew(views)), () => openSection(cx, 'views'))
  const docs = newOf('docs')
  if (docs) fresh = true
  add('docs', 'documents', joinNew(isNew(docs)), () => openSection(cx, 'docs'))
  if (f.checks) {
    const checks = newOf('checks')
    if (checks) fresh = true
    const running = (await cx.checksRunning()) > 0
    add('checks', 'checks', [...joinNew(isNew(checks)), ...(running ? [{ s: '◌' }] : [])], () => openChecks(cx))
  }
  return { items, fresh }
}

/** `N new` as one plain part and `new` in green, the parts the line's item joins with spaces. */
function joinNew(parts: { s: string; fg?: string }[]): { s: string; fg?: string }[] {
  return parts.length ? [{ s: parts[0]!.s.trimEnd() }, parts[1]!] : []
}

/** The items that fit `room` cells, 3 apart, in order, the rest cut at the end (`…` dim in their place). */
export function fitItems<T extends Pick<SummaryItem, 'segs'>>(items: readonly T[], room: number): { shown: T[]; cut: boolean } {
  const shown: T[] = []
  let used = 0
  for (const [i, it] of items.entries()) {
    const w = itemWidth(it) + (shown.length ? 3 : 0)
    const last = i === items.length - 1
    // a cut leaves room for its `…`
    if (used + w + (last ? 0 : 4) <= room || (last && used + w <= room)) {
      shown.push(it)
      used += w
    } else return { shown, cut: true }
  }
  return { shown, cut: false }
}

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
    // the summary line, the one row that stays
    const { items, fresh } = await summaryItems(cx)
    if (items.length) {
      const controls = 'open ›'.length + (fresh ? 3 + 'dismiss'.length : 0)
      const fit = fitItems(items, cols - LW - controls - 3)
      rows.push(
        <Box key="above-summary" flexDirection="row">
          {label('thimble')}
          <Box flexDirection="row" columnGap={3} flexShrink={0}>
            {fit.shown.map(it => (
              <Button key={`above-summary-${it.key}`} plain dimColor onPress={it.press}>
                {it.segs.map(s => (s.fg ? <Text color={s.fg}>{s.s}</Text> : s.s))}
              </Button>
            ))}
            {fit.cut ? <Text key="above-summary-cut" dimColor>…</Text> : null}
            <Button key="above-summary-open" label="open ›" plain onPress={() => openHomeNew(cx)} />
            {fresh ? <Button key="above-summary-dismiss" label="dismiss" plain onPress={() => markSeen(cx, SECTIONS)} /> : null}
          </Box>
        </Box>,
      )
    }
    if (!rows.length) return theirs
    return (
      <Box flexDirection="column">
        {theirs}
        {rows}
      </Box>
    )
  })
}
