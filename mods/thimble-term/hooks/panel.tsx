// The panel: thimble-term's one pane, drawn by the view `panel` names (hooks/term.ts). Every view has the mod's header
// (views/SPEC.md, "A panel's header"): the path row (`‹ back`, the steps from home, `threads` and its news at R), the
// title row, then a rule. The views:
//
//   home      everything the workspace holds (home.ts laid out, homeview.tsx drawn): reports, side threads, cards by
//             group, labels, files
//   card      a card whole: its chart, its takeaway, its code
//   cite      a citation's place: its lines with the value marked, or the card cell it names; red when it does not hold
//   menu      a right-click's choices: open, open in files, ask about it
//   ask       the question field of a new side thread about what was asked about
//   thread    a side thread: each question and its answer, and the field that asks the next
//   threads   every side thread
//   label     a label: its counts, its records with agree and disagree; labels, every label
//   docs      the documents; doc, one document with its figures as cards and its citations as links
//   files     the corpus's files; file, a file's lines
//   agent     one of thimble's agents: what it is doing and its latest steps
//   view      a view: one line, since the browser draws views
import type { MatchedEvent, RenderElement } from 'claude-code'

import type { ChatNavStep, TermPanel, TermThread, TermVerdict } from '../types'
import { labelCard } from './cell'
import type { ThimbleLabel } from './cell'
import { citeLabel, plainCites, quoteSpan, wrapAround } from './cite'
import { cardLayout, cut, placeWords } from './draw'
import type { CardData, Line } from './draw'
import { fileRef } from './files'
import { citationOf, menuItems, placeOf, targetLabel } from './gestures'
import type { Target } from './gestures'
import { homeLayout, homeReduce } from './home'
import type { HomeAct, HomeCardGroup, HomeData, HomeFile, HomeLabel, HomeOpen, HomeReport, HomeThread, HomeUi, HomeView } from './home'
import { cid, clip } from './lib'
import { docUnits, docsOf, labelOf, labelsOf, threadOf } from './model'
import { crumbSteps, fitCrumbs, threadState, withBack } from './nav'
import { COLORS, paintLines } from './paint'
import { MEASURE, PANEL_MARGIN, cardBlock, drawReply } from './reply'
import {
  P,
  closePanel,
  navBack,
  navGo,
  openHome,
  openPanel,
  rt,
  startThread,
  surfaceValue,
  threadMessage,
} from './term'
import type { Ctx } from './ctx'
import { act } from './data'

export type PaneEvent = MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

// ------------------------------------------------------------------------------------------------ opening

/** A side thread about a target: the ask view, its question field first. */
export async function openAsk(cx: Ctx, t: Target): Promise<void> {
  const c = citationOf(t)
  const anchor = t.kind === 'sentence' ? null : t.cardId && t.kind !== 'record' && t.kind !== 'citation' ? `card:${t.cardId}` : c?.ref ?? (t.cardId ? `card:${t.cardId}` : null)
  const anchorText = t.kind === 'card' ? '' : t.kind === 'citation' ? '' : plainCites(t.label ? `${t.label}` : t.text ?? '')
  await openPanel(cx, { view: 'ask', title: 'Ask', target: t, anchor, anchorText, about: targetLabel(t, 60) })
}

export async function openCite(cx: Ctx, ref: string, display: string | null): Promise<void> {
  await openPanel(cx, { view: 'cite', title: 'Citation', ref, display })
}

export async function openCard(cx: Ctx, id: string): Promise<void> {
  const tc = (await cx.card(id))
  await openPanel(cx, { view: 'card', title: clip((tc?.data as CardData | undefined)?.question ?? 'Card', 60), card: id })
}

export async function openThread(cx: Ctx, id: string): Promise<void> {
  await openPanel(cx, { view: 'thread', title: 'Side thread', thread: id })
}

export async function openFile(cx: Ctx, path: string, start = 1): Promise<void> {
  await openPanel(cx, { view: 'file', title: path.split('/').at(-1) ?? path, path, start })
}

/** What a click on a target opens: a citation's or a record's place, a card whole; plain words open nothing (only
 *  what is drawn as a link opens a panel). A right-click opens the menu. */
export async function onGesture(cx: Ctx, gesture: 'primary' | 'menu', t: Target): Promise<void> {
  if (gesture === 'menu') {
    await cx.setMenu(t)
    await openPanel(cx, { view: 'menu', title: 'Menu', target: t })
    return
  }
  const place = placeOf(t)
  if (place) return openCite(cx, place.ref, place.display)
  if (t.cardId) return openCard(cx, t.cardId)
}

async function menuAct(cx: Ctx, what: string, t: Target): Promise<void> {
  if (what === 'open') {
    const place = placeOf(t) ?? citationOf(t)
    if (place) return openCite(cx, place.ref, place.display)
  }
  if (what === 'files') {
    const f = fileRef(citationOf(t)?.ref ?? '')
    if (f) return openFile(cx, f.path, Math.max(1, (f.line ?? 1) - 5))
  }
  if (what === 'card' && t.cardId) return openCard(cx, t.cardId)
  if (what === 'thread') return openAsk(cx, t)
}

// ------------------------------------------------------------------------------------------------ the header

/** Hotkeys with no label of their own (rule 24): plain Buttons in a Box no row tall, so the panel's keys press them. */
function hiddenKeys(cx: Ctx, e: PaneEvent, keys: { key: string; hotkey: string; onPress: () => void }[]): RenderElement | null {
  if (!keys.length || e.surface === 'mobile') return null
  const { Box, Button } = cx.els(e)
  return (
    <Box key="hidden-keys" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {keys.map(k => (
        <Button key={`hk-${k.key}`} label={k.hotkey} hotkey={k.hotkey} plain onPress={k.onPress} />
      ))}
    </Box>
  )
}

function crumbText(s: ChatNavStep): string {
  switch (s.view) {
    case 'thread':
      return `thread ${s.title === 'Side thread' ? '' : s.title}`.trim()
    case 'cite':
      return `citation ${s.title === 'Citation' ? '' : s.title}`.trim()
    case 'card':
      return `card ${s.title}`
    case 'label':
      return `label ${s.title}`
    case 'doc':
      return `document "${s.title}"`
    case 'file':
      return s.title
    case 'agent':
      return s.title
    default:
      return s.view
  }
}

/** The path row: back, the steps from home (each a press away), and at the right `threads` with its news. */
async function wayRow(cx: Ctx, e: PaneEvent, view: string): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns - 1)
  const nav = (await cx.nav()) ?? { trail: [], back: [] }
  const back = nav.back.length > 0 || nav.trail.length > 1
  const threads = (await cx.threads()) ?? []
  const fresh = ((await cx.news()) ?? { n: 0 }).n
  const running = threads.filter(t => t.running).length
  const tail = [fresh ? `${fresh} new` : '', running ? `${running} answering` : ''].filter(Boolean)
  const threadsW = view === 'threads' ? 0 : 7 + tail.reduce((n, t) => n + t.length + 3, 0) + 2
  const { steps, skipped } = crumbSteps(nav.trail)
  const fitted = fitCrumbs(['home', ...steps.map(crumbText)], Math.max(12, cols - (back ? 8 : 0) - threadsW))
  const parts: RenderElement[] = []
  fitted.forEach((text, i) => {
    if (text === null) {
      if (fitted[i - 1] !== null) parts.push(<Text dimColor>{' › …'}</Text>)
      return
    }
    if (i) parts.push(<Text dimColor>{' › '}</Text>)
    if (i && i === fitted.length - 1) parts.push(<Text>{text}</Text>)
    else if (i) parts.push(<Button key={`crumb-${i}`} label={text} plain onPress={() => void navGo(cx, { trail: nav.trail.slice(0, i + skipped), back: withBack(nav.back, nav.trail) })} />)
    else if (view === 'home' && fitted.length === 1) parts.push(<Text>{text}</Text>)
    else parts.push(<Button key="crumb-home" label={text} plain onPress={() => void openHome(cx)} />)
  })
  return (
    <Box key="way" flexDirection="row">
      {back ? <Button key="nav-back" label="‹ back" plain onPress={() => void navBack(cx)} /> : null}
      {back ? <Text>{'  '}</Text> : null}
      {parts}
      <Box flexGrow={1} />
      {view === 'threads' ? null : <Button key="threads" label="threads" plain onPress={() => void openPanel(cx, { view: 'threads', title: 'Side threads' })} />}
      {view !== 'threads' && fresh ? <Text bold>{`  ${fresh} new`}</Text> : null}
      {view !== 'threads' && running ? <Text dimColor>{`${fresh ? ' · ' : '  '}${running} answering`}</Text> : null}
      {hiddenKeys(cx, e, [
        ...(back ? [{ key: 'back', hotkey: 'b', onPress: () => void navBack(cx) }] : []),
        ...(view === 'threads' ? [] : [{ key: 'threads', hotkey: 't', onPress: () => void openPanel(cx, { view: 'threads', title: 'Side threads' }) }]),
        { key: 'close', hotkey: 'x', onPress: () => void closePanel(cx) },
      ])}
    </Box>
  )
}

/** A title row: the subject's name, its stats dim after a gutter, its controls against R. */
function titleRow(cx: Ctx, e: PaneEvent, name: string, stats: string, controls: RenderElement[] = [], red = false): RenderElement {
  const { Box, Text } = cx.els(e)
  return (
    <Box key="title" flexDirection="row">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text {...(red ? { color: COLORS.problem } : {})}>{name}</Text>
          {stats ? <Text {...(red ? { color: COLORS.problem } : { dimColor: true })}>{`  ${stats}`}</Text> : null}
        </Text>
      </Box>
      <Box flexGrow={1} />
      {controls.length ? (
        <Box flexShrink={0} flexDirection="row" columnGap={2}>
          {controls}
        </Box>
      ) : null}
    </Box>
  )
}

function rule(cx: Ctx, e: PaneEvent, cols: number): RenderElement {
  const { Text } = cx.els(e)
  return <Text color={COLORS.rule}>{'─'.repeat(cols)}</Text>
}

/** Label/value rows (rule 6): each label dim, lower case, in a column as wide as the longest label + 2. */
function fieldRows(cx: Ctx, e: PaneEvent, rows: [string, RenderElement | string, string?][]): RenderElement | null {
  if (!rows.length) return null
  const { Box, Text } = cx.els(e)
  const w = Math.max(...rows.map(([k]) => k.length)) + 2
  return (
    <Box flexDirection="column">
      {rows.map(([k, v, colour]) => (
        <Box key={`f:${k}`} flexDirection="row">
          <Box width={w} flexShrink={0}>
            <Text dimColor>{k}</Text>
          </Box>
          <Box flexShrink={1}>{typeof v === 'string' ? <Text wrap="wrap" {...(colour ? { color: colour } : {})}>{v}</Text> : v}</Box>
        </Box>
      ))}
    </Box>
  )
}

/** Source lines with dim line numbers (rule 23: no syntax colour; a comment dim). */
function codeRows(cx: Ctx, e: PaneEvent, source: string, max = 400, first = 1): RenderElement {
  const { Box, Text } = cx.els(e)
  const lines = source.replace(/\t/g, '    ').split('\n')
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  const shown = lines.slice(0, max)
  const w = String(first + shown.length - 1).length
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => {
        const at = /^\s*#/.test(l) ? l.indexOf('#') : -1
        return (
          <Text wrap="truncate-end">
            <Text dimColor>{`  ${String(first + i).padStart(w)}  `}</Text>
            <Text>{at < 0 ? l || ' ' : l.slice(0, at)}</Text>
            {at >= 0 ? <Text dimColor>{l.slice(at)}</Text> : null}
          </Text>
        )
      })}
      {lines.length > shown.length ? <Text dimColor>{`… ${lines.length - shown.length} more`}</Text> : null}
    </Box>
  )
}

function none(cx: Ctx, e: PaneEvent, words = 'none'): RenderElement {
  const { Text } = cx.els(e)
  return <Text dimColor>{`  ${words}`}</Text>
}

// ------------------------------------------------------------------------------------------------ the views

const homeStamps = new Map<string, HomeAct[]>()
const homeSeen = new Map<string, number>()
let homeDraws = 0

/** What the home panel lists, from what `thimble state` printed for its surfaces. */
export async function homeData(cx: Ctx): Promise<HomeData> {
  const homeRaw = await surfaceValue<Obj>(cx, 'home-full')
  const views: HomeView[] = homeRaw?.ok && Array.isArray(homeRaw.value.views)
    ? (homeRaw.value.views as unknown[]).filter(isObj).map(v => ({ slug: str(v.slug), name: str(v.name) || str(v.slug), state: str(v.status) || 'built', words: str(v.status), files: [], unit: '', drawable: false, left: 0, at: Date.parse(str(v.ts)) || 0 }))
    : []
  const docs = await surfaceValue(cx, 'docs')
  const reports: HomeReport[] = docs?.ok ? docsOf(docs.value).map(d => ({ slug: d.slug, title: d.title, form: d.renderer, state: d.status === 'generating' ? 'writing' : 'written', cards: 0, tools: 0, at: 0 })) : []
  const threads: HomeThread[] = ((await cx.threads()) ?? []).map(t => {
    const st = t.running ? 'run' : t.answers ? 'ok' : 'dim'
    return { id: t.id, title: `"${clip(t.title || t.anchorText || 'side thread', 80)}"`, about: t.anchorText ? `about ${clip(plainCites(t.anchorText), 60)}` : '', words: t.running ? 'answering' : plural(t.answers, 'answer'), tone: st, unread: t.unread, earlier: false, at: Date.parse(t.at) || 0 }
  })
  const canvas = await surfaceValue<Obj>(cx, 'canvas')
  const groups = canvas?.ok && Array.isArray(canvas.value.groups) ? (canvas.value.groups as unknown[]).filter(isObj) : []
  const cells = canvas?.ok && Array.isArray(canvas.value.cells) ? (canvas.value.cells as unknown[]).filter(isObj) : []
  const cardGroups: HomeCardGroup[] = groups
    .map(g => {
      const cards = cells.filter(c => c.notebook === g.id).map(c => ({ id: str(c.id), kind: str(c.kind) || 'code', question: str(c.title) || 'a card' }))
      const from: HomeCardGroup['from'] = g.anchor || g.chat ? 'thread' : g.role === 'figures' ? 'report' : g.role === 'analyst' ? 'answer' : 'other'
      return { head: str(g.title) || 'cards', from, cards, at: Date.parse(str(g.ts)) || 0 }
    })
    .filter(g => g.cards.length)
    .reverse()
  const labelsRaw = await surfaceValue(cx, 'labels')
  const labels: HomeLabel[] = labelsRaw?.ok
    ? labelsOf(labelsRaw.value).map(l => ({
        slug: l.id,
        name: l.name ?? l.id,
        kind: l.kind ?? '',
        trial: Boolean(l.trial),
        counts: l.label_stats?.counts ?? {},
        values: l.labels ?? Object.keys(l.label_stats?.counts ?? {}),
        paths: (l.glob ?? '').split(/,\s*/).filter(Boolean),
        running: (l.last_run?.status ?? '') === 'running',
      }))
    : []
  const filesRaw = await surfaceValue(cx, 'files')
  const list = filesRaw?.ok ? (Array.isArray(filesRaw.value) ? filesRaw.value : isObj(filesRaw.value) && Array.isArray(filesRaw.value.files) ? filesRaw.value.files : []) : []
  const files: HomeFile[] = (list as unknown[]).filter(isObj).map(f => ({
    file: str(f.path),
    records: typeof f.records === 'number' ? f.records : typeof f.lines === 'number' ? f.lines : null,
    size: typeof f.size_bytes === 'number' ? f.size_bytes : typeof f.size === 'number' ? f.size : 0,
    seen: 0,
    state: 'listed',
    ranges: [],
    kind: str(f.kind),
  }))
  return { views, reports, threads, cardGroups, labels, files, coverage: homeRaw?.ok ? str(homeRaw.value.coverage) : '' }
}

async function drawHome(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>The home panel needs the terminal or the desktop app.</Text>
  const { Client } = cx.els(e)
  const cols = Math.max(40, e.props.bodyColumns)
  const ui = ((await cx.homeUi()) ?? { layout: 'stacked', folded: [], more: [], pick: '' }) as HomeUi
  const lay = homeLayout(await homeData(cx), ui, cols)
  const stamp = `h${++homeDraws}`
  homeStamps.set(stamp, lay.hits.map(h => h.act))
  for (const k of [...homeStamps.keys()].slice(0, -4)) homeStamps.delete(k)
  const groups = new Map<HomeAct, number>()
  const packed = lay.hits.flatMap(h => {
    if (!groups.has(h.act)) groups.set(h.act, groups.size)
    return [h.y, h.x0, h.x1, h.row ? 1 : 0, groups.get(h.act)!]
  })
  return (
    <Box flexDirection="column">
      <Client key="home" module="./homeview.tsx" width={cols} height={lay.lines.length} props={JSON.parse(JSON.stringify({ lines: lay.lines, hits: packed, stamp, cols }))} />
    </Box>
  )
}

/** A click the home panel's Client posted: the hit's act, from the drawing it was in. Each is handled once. */
export async function homeMessage(cx: Ctx, origin: unknown, raw: unknown): Promise<void> {
  if (!Array.isArray(raw) || typeof origin !== 'string') return
  for (const a of raw as { seq?: unknown; i?: unknown; s?: unknown }[]) {
    if (typeof a?.seq !== 'number' || a.seq <= (homeSeen.get(origin) ?? 0)) continue
    homeSeen.set(origin, a.seq)
    const did = homeStamps.get(String(a.s))?.[Number(a.i)]
    if (!did) continue
    if (did.op === 'open') await homeOpen(cx, did.open)
    else await cx.setHomeUi(homeReduce(((await cx.homeUi()) ?? { layout: 'stacked', folded: [], more: [], pick: '' }) as HomeUi, did))
  }
}

async function labelIdByName(cx: Ctx, name: string): Promise<string> {
  const got = await surfaceValue(cx, 'labels')
  const hit = got?.ok ? labelsOf(got.value).find(l => l.name === name || l.id === name) : undefined
  return hit?.id ?? name
}

async function homeOpen(cx: Ctx, o: HomeOpen): Promise<void> {
  switch (o.kind) {
    case 'view':
      return openPanel(cx, { view: 'view', title: o.slug, slug: o.slug })
    case 'report':
      return openPanel(cx, { view: 'doc', title: o.slug, slug: o.slug })
    case 'thread':
      return openThread(cx, o.id)
    case 'card':
      return openCard(cx, o.id)
    case 'label':
      return openPanel(cx, { view: 'label', title: o.name, label: await labelIdByName(cx, o.name) })
    case 'file':
      return openFile(cx, o.path)
    case 'pane': {
      const to: Record<string, TermPanel> = {
        reports: { view: 'docs', title: 'Documents' },
        threads: { view: 'threads', title: 'Side threads' },
        labels: { view: 'labels', title: 'Labels' },
        coverage: { view: 'files', title: 'Files' },
        views: { view: 'home', title: 'Home' },
      }
      return openPanel(cx, to[o.view] ?? { view: 'home', title: 'Home' })
    }
  }
}

async function drawCard(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const id = p.card ?? ''
  const tc = (await cx.card(id))
  const cols = Math.max(30, e.props.bodyColumns)
  if (!tc) return none(cx, e, '◌ reading the card')
  const body: RenderElement[] = [await cardBlock(cx, e, id, cols, 'pane', { pane: true })]
  const facts = [tc.kind, tc.by ? `made by ${tc.by.replace(/^chat:[A-Za-z0-9_-]+$/, 'an agent').replace(/^main$/, 'main')}` : ''].filter(Boolean).join(' · ')
  body.push(
    <Box key="card-foot" flexDirection="row" marginTop={1}>
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-end">{facts}</Text>
      </Box>
      <Box flexGrow={1} />
      <Button key="card-ask" label="ask about it" plain onPress={() => void openAsk(cx, { kind: 'card', ref: `card:${id}`, cardId: id, text: (tc.data as CardData).question })} />
    </Box>,
  )
  const source = tc.code
  if (source) body.push(<Box marginTop={1} flexDirection="column">{fieldRows(cx, e, [['code', '']])}{codeRows(cx, e, source)}</Box>)
  return (
    <Box flexDirection="column">
      {hiddenKeys(cx, e, [{ key: 'ask', hotkey: 'a', onPress: () => void openAsk(cx, { kind: 'card', ref: `card:${id}`, cardId: id }) }])}
      {body}
    </Box>
  )
}

/** A cited line wrapped around its value, on the selection background, its number in the text colour. */
function lineRows(cx: Ctx, e: PaneEvent, v: TermVerdict, cols: number): RenderElement[] {
  const { Text } = cx.els(e)
  const gutter = Math.max(1, ...v.lines.map(l => String(l.n || '').length))
  const room = Math.max(10, cols - gutter - 4)
  const quote = v.display && /^["“'‘]/.test(v.display.trim()) ? v.display.trim().replace(/^["“'‘]|["”'’]$/g, '') : ''
  const out: RenderElement[] = []
  for (const l of v.lines.slice(0, 60)) {
    const text = l.text.replace(/\t/g, '  ')
    const num = l.n ? String(l.n).padStart(gutter) : ' '.repeat(gutter)
    if (!l.hit) {
      out.push(
        <Text wrap="truncate-end">
          <Text dimColor>{`  ${num}  `}</Text>
          <Text dimColor>{cut(text, room) || ' '}</Text>
        </Text>,
      )
      continue
    }
    const first = l.spans?.[0]
    const span: [number, number] | null = quote ? quoteSpan(text, quote) : first ? [first[0]!, first[1]!] : null
    wrapAround(text, span, room, 6).forEach((r, i) =>
      out.push(
        <Text wrap="truncate-end">
          <Text>{`  ${i === 0 ? num : ' '.repeat(gutter)}  `}</Text>
          <Text>{r.hi ? r.text.slice(0, r.hi[0]) : r.text || ' '}</Text>
          {r.hi ? <Text backgroundColor={COLORS.selected}>{r.text.slice(r.hi[0], r.hi[1])}</Text> : null}
          {r.hi ? <Text>{r.text.slice(r.hi[1])}</Text> : null}
        </Text>,
      ),
    )
  }
  return out
}

/** A card with the cited cell on the selection background: a table's cell or row, a bar. */
function citedLines(card: CardData, v: TermVerdict, w: number): Line[] {
  const lay = cardLayout(card, w, -1, 8)
  if (!v.row && !v.column) return lay.lines
  const k = lay.items.findIndex(it => (v.row ? it.label.startsWith(`${v.row} ·`) || it.label === v.row : false) && (!v.column || it.label.endsWith(`· ${v.column}`) || card.kind !== 'table'))
  if (k < 0) return lay.lines
  const hot = cardLayout(card, w, k, 8)
  // the hovered item is drawn in inverse; the panel draws it on the selection background instead
  return hot.lines.map(l => l.map(s => (s.inv ? { ...s, inv: false, bg: COLORS.selected } : s)))
}

async function drawCite(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  if (!p.ref) return none(cx, e)
  const c = { raw: p.display === null || p.display === undefined ? `[[${p.ref}]]` : `[[${p.display}|${p.ref}]]`, ref: p.ref, display: p.display ?? null }
  const v = (await cx.verdict(cid(c.raw)))
  const status = v?.status ?? 'pending'
  const red = status === 'missing' || status === 'differs'
  const said = !v || status === 'pending' ? '◌ checking' : v.why
  const target: Target = { kind: 'citation', ref: c.raw, text: citeLabel(c) }
  const f = fileRef(c.ref)
  const controls = [
    <Button key="cite-ask" label="ask about it" plain onPress={() => void openAsk(cx, target)} />,
    ...(f ? [<Button key="cite-files" label="in files" plain onPress={() => void openFile(cx, f.path, Math.max(1, (f.line ?? 1) - 5))} />] : []),
  ]
  const body: RenderElement[] = [titleRow(cx, e, citeLabel(c), said, controls, red), rule(cx, e, cols)]
  const where = placeWords(c.ref.replace(/^(?:card|cell):[A-Za-z0-9_-]+/, 'card'))
  const rows: [string, RenderElement | string, string?][] = [['from', where]]
  if (v?.card) {
    const tc = (await cx.card(v.card))
    const card = tc?.data as CardData | undefined
    if (card) rows.push(['card', card.question])
    if (v.column || v.row) rows.push(['cell', [v.row, v.column].filter(Boolean).join(' · ') + (v.value ? `  ${v.value}` : '')])
    body.push(fieldRows(cx, e, rows)!)
    if (card) body.push(<Box marginTop={1} flexDirection="column">{paintLines(Box, Text, citedLines(card, v, Math.min(cols, 90)))}</Box>)
  } else {
    body.push(fieldRows(cx, e, rows)!)
    if (v?.lines.length) body.push(<Box marginTop={1} flexDirection="column">{lineRows(cx, e, v, cols)}</Box>)
  }
  return (
    <Box flexDirection="column">
      {hiddenKeys(cx, e, [{ key: 'ask', hotkey: 'a', onPress: () => void openAsk(cx, target) }, ...(f ? [{ key: 'files', hotkey: 'f', onPress: () => void openFile(cx, f.path, Math.max(1, (f.line ?? 1) - 5)) }] : [])])}
      {body}
    </Box>
  )
}

async function drawMenu(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const t = p.target ?? (await cx.menu())
  if (!t) return none(cx, e)
  const cols = Math.max(20, e.props.bodyColumns)
  // the mod's choices that thimble-term has: open the place, open its file, ask; and a card's own panel
  const items = menuItems(t).filter(m => m.act === 'open' || m.act === 'files' || m.act === 'thread')
  // a card's cell, bar or point: its citation's panel, the card with the cell marked
  if (t.cardId && (t.kind === 'mark' || t.kind === 'row') && citationOf(t) && !items.some(m => m.act === 'open')) items.unshift({ act: 'open', label: 'open its cell', hotkey: 'o', hint: '' })
  if (t.cardId && t.kind !== 'card') items.push({ act: 'card' as never, label: 'open the card', hotkey: 'c', hint: '' })
  if (t.kind === 'card') items.unshift({ act: 'card' as never, label: 'open the card', hotkey: 'o', hint: '' })
  return (
    <Box flexDirection="column">
      {hiddenKeys(cx, e, items.map(m => ({ key: String(m.act), hotkey: m.hotkey, onPress: () => void menuAct(cx, String(m.act), t) })))}
      <Text wrap="truncate-end">{targetLabel(t, cols)}</Text>
      {rule(cx, e, cols)}
      {items.map((m, i) => (
        <Box key={`menu-row-${String(m.act)}`} flexDirection="row" paddingLeft={2}>
          <Button key={`menu-${String(m.act)}`} label={m.label} plain {...(i === 0 ? { autoFocus: true as const } : {})} onPress={() => void menuAct(cx, String(m.act), t)} />
        </Box>
      ))}
    </Box>
  )
}

let asking = ''

async function drawAsk(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  if (e.surface === 'mobile') return none(cx, e, 'A side thread needs a surface with text fields.')
  const { Box, Text, Input } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const words = p.anchorText ? clip(p.anchorText, 400) : ''
  const body: RenderElement[] = [titleRow(cx, e, `ask about ${p.about ?? 'this'}`, ''), rule(cx, e, cols)]
  if (words && p.target?.kind !== 'card') body.push(<Box width={Math.min(MEASURE, cols)}><Text italic wrap="wrap">{words}</Text></Box>)
  if (asking) body.push(<Text dimColor>{asking}</Text>)
  body.push(
    <Box key="ask-row" flexDirection="row" marginTop={1}>
      <Text dimColor>{'ask  '}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Input
          key="ask-new"
          autoFocus
          submitLabel="ask"
          onSubmit={v => {
            void (async () => {
              const q = v.trim()
              if (!q) return
              asking = '◌ asking'
              await cx.bumpPanel()
              const got = await startThread(cx, p.anchor ?? null, p.anchorText ?? '', q)
              asking = 'error' in got ? `× ${got.error}` : ''
              if ('id' in got) await openThread(cx, got.id)
              else await cx.bumpPanel()
            })()
          }}
        />
      </Box>
    </Box>,
  )
  return <Box flexDirection="column">{body}</Box>
}

async function drawThread(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  if (e.surface === 'mobile') return none(cx, e, 'A side thread needs a surface with text fields.')
  const { Box, Text, Input } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const tt: TermThread | undefined = p.thread ? (await cx.thread(p.thread)) : undefined
  if (!tt) return none(cx, e, '◌ reading the thread')
  const t = threadOf(tt.meta, tt.events)
  const st = threadState(t)
  const body: RenderElement[] = [titleRow(cx, e, clip(plainCites(t.label), cols - 20), st.words, [], st.tone === 'problem'), rule(cx, e, cols)]
  let k = 0
  for (const turn of t.turns) {
    k++
    if (k > 1) body.push(<Text> </Text>)
    body.push(<Box width={Math.min(MEASURE, cols)}><Text wrap="wrap">{`"${plainCites(turn.q)}"`}</Text></Box>)
    if (turn.state === 'running') {
      const partial = turn.partial.trim()
      body.push(<Text dimColor wrap="truncate-end">{`◌ answering · ${plural(turn.tools, 'tool call')}${partial ? ` · ${clip(partial, cols - 30)}` : ''}`}</Text>)
    } else if (turn.state === 'error') body.push(<Text color={COLORS.problem} wrap="wrap">{`× ${turn.a}`}</Text>)
    else body.push(<Box flexDirection="column">{await drawReply(cx, e, turn.a, cols - PANEL_MARGIN, { margin: PANEL_MARGIN, prefix: `t${k}-`, ask: tgt => void openAsk(cx, tgt) })}</Box>)
  }
  if (t.turns.length) body.push(rule(cx, e, cols))
  body.push(
    <Box key="ask-row" flexDirection="row">
      <Text dimColor>{'ask  '}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Input
          key={`ask-${cid(t.id)}`}
          submitLabel="ask"
          onSubmit={v => {
            const q = v.trim()
            if (q) void threadMessage(cx, t.id, q).then(err => (err ? cx.toast(`thimble: ${err}`) : undefined))
          }}
        />
      </Box>
    </Box>,
  )
  return <Box flexDirection="column">{body}</Box>
}

async function drawThreads(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const rows = (await cx.threads()) ?? []
  const fresh = rows.filter(t => t.unread).length
  const running = rows.filter(t => t.running).length
  const body: RenderElement[] = [
    <Text>
      <Text>Side threads</Text>
      <Text dimColor>{`  ${rows.length}${running ? ` · ${running} answering` : ''}`}</Text>
      {fresh ? <Text dimColor>{' · '}</Text> : null}
      {fresh ? <Text bold>{`${fresh} new`}</Text> : null}
    </Text>,
    rule(cx, e, cols),
  ]
  if (!rows.length) body.push(none(cx, e))
  for (const [i, t] of [...rows].reverse().entries()) {
    const glyph = t.running ? '◌' : t.answers ? '●' : '○'
    const name = `"${clip(t.title || t.anchorText || 'side thread', Math.max(12, cols - 10))}"`
    body.push(
      <Box key={`thread-row-${i}`} flexDirection="column">
        <Box flexDirection="row">
          <Text {...(glyph === '○' ? { dimColor: true } : {})}>{`${glyph} `}</Text>
          <Button key={`thread-open-${i}`} label={name} plain onPress={() => void openThread(cx, t.id)} />
          {t.unread ? <Text bold>{'  new'}</Text> : null}
        </Box>
        <Text dimColor wrap="truncate-end">{`  ${[t.running ? 'answering' : plural(t.answers, 'answer'), t.anchorText ? `about ${plainCites(t.anchorText)}` : ''].filter(Boolean).join(' · ')}`}</Text>
      </Box>,
    )
  }
  return <Box flexDirection="column">{body}</Box>
}

async function drawLabel(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, `label:${p.label ?? ''}`)
  if (!got) return none(cx, e, '◌ reading the label')
  if (!got.ok) return <Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>
  const l = labelOf(got.value) as ThimbleLabel | null
  if (!l) return none(cx, e)
  const card = labelCard({ id: `label-${l.id}`, kind: 'label', title: l.name ?? l.id, payload: { concept: l.id } }, l)
  const run = l.last_run ?? l.applications?.at(-1)
  const stats = [l.kind, l.trial ? 'trial' : '', run?.status && run.status !== 'done' ? run.status : '', l.glob].filter(Boolean).join(' · ')
  const def = str((got.value as Obj).description) || str((got.value as Obj).spec)
  const body: RenderElement[] = [titleRow(cx, e, l.name ?? l.id, stats), rule(cx, e, cols)]
  if (def) body.push(<Box width={Math.min(MEASURE, cols)} marginLeft={2}><Text wrap="wrap">{def}</Text></Box>)
  if (e.surface === 'terminal' || e.surface === 'desktop') {
    const { Client } = cx.els(e)
    body.push(<Box marginTop={def ? 1 : 0}><Client key={`label-${l.id}`} module="./card.tsx" width={cols} props={JSON.parse(JSON.stringify({ card: { ...card, question: '' }, cols, meta: {}, pane: true }))} /></Box>)
  } else body.push(paintLines(Box, Text, cardLayout(card, cols, -1).lines))
  return <Box flexDirection="column">{body}</Box>
}

async function drawLabels(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'labels')
  const ls = got?.ok ? labelsOf(got.value) : []
  const body: RenderElement[] = [titleRow(cx, e, 'Labels', plural(ls.length, 'label')), rule(cx, e, cols)]
  if (!ls.length) body.push(none(cx, e))
  for (const [i, l] of ls.entries()) {
    const counts = l.label_stats?.counts ?? {}
    const values = l.labels ?? Object.keys(counts)
    body.push(
      <Box key={`label-row-${i}`} flexDirection="column">
        <Box flexDirection="row">
          <Text>{'● '}</Text>
          <Button key={`label-open-${i}`} label={clip(l.name ?? l.id, cols - 6)} plain onPress={() => void openPanel(cx, { view: 'label', title: l.name ?? l.id, label: l.id })} />
        </Box>
        <Text dimColor wrap="truncate-end">{`  ${[l.kind, ...values.map(v => `${v} ${(counts[v] ?? 0).toLocaleString('en-US')}`)].filter(Boolean).join(' · ')}`}</Text>
      </Box>,
    )
  }
  return <Box flexDirection="column">{body}</Box>
}

async function drawDocs(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'docs')
  const docs = got?.ok ? docsOf(got.value) : []
  const body: RenderElement[] = [titleRow(cx, e, 'Documents', plural(docs.length, 'document')), rule(cx, e, cols)]
  if (!docs.length) body.push(none(cx, e))
  for (const [i, d] of docs.entries()) {
    body.push(
      <Box key={`doc-row-${i}`} flexDirection="column">
        <Box flexDirection="row">
          <Text>{d.status === 'generating' ? '◌ ' : '● '}</Text>
          <Button key={`doc-open-${i}`} label={clip(d.title, cols - 6)} plain onPress={() => void openPanel(cx, { view: 'doc', title: d.title, slug: d.slug })} />
        </Box>
        <Text dimColor wrap="truncate-end">{`  ${d.renderer}${d.status === 'generating' ? ' · writing' : ''}`}</Text>
      </Box>,
    )
  }
  return <Box flexDirection="column">{body}</Box>
}

async function drawDoc(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue<Obj>(cx, `doc:${p.slug ?? ''}`)
  if (!got) return none(cx, e, '◌ reading the document')
  if (!got.ok) return <Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>
  const doc = got.value
  const { units: sections, word } = docUnits(doc)
  const figures = sections.reduce((n, s) => n + (s.figures?.length ?? 0), 0)
  const text = sections.flatMap(s => (s.paragraphs ?? []).flatMap(pp => (pp.sentences ?? []).map(x => str(x.text)))).join(' ')
  const cites = (text.match(/\[\[/g) ?? []).length
  const stats = [str(doc.renderer) || str(doc.type) || 'document', plural(sections.length, word), plural(cites, 'citation'), figures ? plural(figures, 'card') : ''].filter(Boolean).join(' · ')
  const body: RenderElement[] = [titleRow(cx, e, clip(str(doc.title) || p.title, cols), ''), <Text dimColor wrap="truncate-end">{stats}</Text>, rule(cx, e, cols)]
  if (sections.length > 1) {
    body.push(<Text>Contents</Text>)
    sections.forEach((s, i) => body.push(<Text wrap="truncate-end"><Text dimColor>{`  ${String(i + 1).padStart(String(sections.length).length)}  `}</Text><Text>{plainCites(str(s.heading))}</Text></Text>))
  }
  const w = Math.min(cols - PANEL_MARGIN, MEASURE + 20)
  for (const [i, s] of sections.entries()) {
    body.push(<Box marginTop={1}><Text wrap="wrap">{plainCites(str(s.heading))}</Text></Box>)
    const figs = s.figures ?? []
    const placed = new Set<number>()
    for (const [j, para] of (s.paragraphs ?? []).entries()) {
      const words = (para.sentences ?? []).map(x => str(x.text)).join(para.sentences?.some(x => x.bullet) ? '\n' : ' ')
      if (words.trim()) body.push(<Box flexDirection="column">{await drawReply(cx, e, words, w, { margin: PANEL_MARGIN, prefix: `d${i}-${j}-`, ask: tgt => void openAsk(cx, tgt) })}</Box>)
      for (const [k, f] of figs.entries()) {
        if (f.after_paragraph !== para.id || placed.has(k)) continue
        placed.add(k)
        body.push(await figure(cx, e, f, w, `f${i}-${k}`))
      }
    }
    for (const [k, f] of figs.entries()) if (!placed.has(k)) body.push(await figure(cx, e, f, w, `f${i}-${k}`))
  }
  return <Box flexDirection="column">{body}</Box>
}

async function figure(cx: Ctx, e: PaneEvent, f: { cell?: string; caption?: string }, w: number, key: string): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  const id = str(f.cell).replace(/^(?:card|cell):/, '')
  return (
    <Box key={key} flexDirection="column" marginLeft={PANEL_MARGIN}>
      {await cardBlock(cx, e, id, w, key, { takeaway: false })}
      {f.caption ? <Box width={Math.min(MEASURE, w)}><Text dimColor wrap="wrap">{plainCites(f.caption)}</Text></Box> : null}
    </Box>
  )
}

function fmtSize(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
}

async function drawFiles(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'files')
  if (!got) return none(cx, e, '◌ reading the files')
  if (!got.ok) return <Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>
  const list = (Array.isArray(got.value) ? got.value : isObj(got.value) && Array.isArray(got.value.files) ? got.value.files : []) as unknown[]
  const files = list.filter(isObj).map(f => ({ path: str(f.path), kind: str(f.kind), size: typeof f.size_bytes === 'number' ? f.size_bytes : 0 }))
  const byDir = new Map<string, typeof files>()
  for (const f of files) {
    const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
    byDir.set(d, [...(byDir.get(d) ?? []), f])
  }
  const kindW = Math.max(4, ...files.map(f => f.kind.length))
  const body: RenderElement[] = [titleRow(cx, e, 'Files', plural(files.length, 'file')), rule(cx, e, cols)]
  if (!files.length) body.push(none(cx, e))
  let i = 0
  for (const [dir, fs] of byDir) {
    if (dir) body.push(<Box marginTop={1}><Text><Text>{dir}</Text><Text dimColor>{`  ${fs.length}`}</Text></Text></Box>)
    for (const f of fs) {
      const name = f.path.slice(dir.length)
      const size = fmtSize(f.size)
      const room = Math.max(10, cols - kindW - size.length - 8)
      body.push(
        <Box key={`file-${i++}`} flexDirection="row">
          <Text>{'  '}</Text>
          <Box width={room} flexShrink={1}>
            <Button key={`file-open-${i}`} label={cut(name, room)} plain onPress={() => void openFile(cx, f.path)} />
          </Box>
          <Box flexGrow={1} />
          <Text dimColor>{f.kind.padEnd(kindW)}</Text>
          <Text dimColor>{`  ${size.padStart(8)}`}</Text>
        </Box>,
      )
    }
  }
  return <Box flexDirection="column">{body}</Box>
}

async function drawFile(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const start = p.start ?? 1
  const got = await surfaceValue<Obj>(cx, `file:${p.path}:${start}`)
  if (!got) return none(cx, e, '◌ reading the file')
  if (!got.ok) return <Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text>
  const page = got.value
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const total = typeof page.total_lines === 'number' ? page.total_lines : 0
  const first = typeof page.start === 'number' ? page.start : start
  const text = records.map(r => (Array.isArray(r.blocks) ? (r.blocks as Obj[]).map(b => str(b.text)).join(' ') : str(r.text ?? r.raw ?? (isObj(r.record) ? JSON.stringify(r.record) : r.record)))).map(t => t.replace(/\s+/g, ' ').slice(0, 2000))
  const last = first + Math.max(0, records.length - 1)
  const controls = [
    ...(first > 1 ? [<Button key="file-earlier" label="earlier" plain onPress={() => void openPanel(cx, { ...p, start: Math.max(1, first - 200) })} />] : []),
    ...(total && last < total ? [<Button key="file-later" label="later" plain onPress={() => void openPanel(cx, { ...p, start: last + 1 })} />] : []),
  ]
  const body: RenderElement[] = [titleRow(cx, e, p.path ?? '', [str(page.kind), total ? `${total.toLocaleString('en-US')} lines` : '', records.length ? `lines ${first}-${last}` : ''].filter(Boolean).join(' · '), controls), rule(cx, e, cols)]
  if (!records.length) body.push(none(cx, e))
  else body.push(codeRows(cx, e, text.join('\n'), 400, first))
  return <Box flexDirection="column">{body}</Box>
}

async function drawAgent(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const agents = (await cx.agents()) ?? []
  // by its thread when the panel names one: a role's earlier run that ended (done) has the same name, and is listed first
  const a = p.thread ? agents.find(x => x.chat === p.thread) : agents.find(x => x.name === p.agent)
  const tt: TermThread | undefined = p.thread ? (await cx.thread(p.thread)) : undefined
  const meta = tt?.meta ?? {}
  const state = a ? a.state : str(meta.status) || 'done'
  const controls = a && rt.sc ? [<Button key="agent-stop" label="stop" plain onPress={() => void act(cx, rt.sc!, 'stop', { agent: a.chat || a.name, name: a.name })} />] : []
  const body: RenderElement[] = [titleRow(cx, e, a?.label ?? (str(meta.title) || p.title), state, controls), rule(cx, e, cols)]
  const events = tt?.events ?? []
  const steps: string[] = []
  let text = ''
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const inp = isObj(ev.input) ? ev.input : {}
      const what = str(inp.question ?? inp.command ?? inp.file_path ?? inp.pattern ?? inp.name ?? inp.description ?? '')
      steps.push(`${str(ev.name).replace(/^mcp__.*__/, '')}${what ? ` · ${what.replace(/\s+/g, ' ')}` : ''}`)
      text = ''
    } else if (ev.type === 'text') text += str(ev.delta ?? ev.text)
    else if (ev.type === 'done' && ev.result) text = str(ev.result)
  }
  if (!events.length) body.push(none(cx, e, tt ? 'nothing yet' : '◌ reading its chat'))
  if (steps.length) {
    body.push(<Text><Text>steps</Text><Text dimColor>{`  ${steps.length}`}</Text></Text>)
    for (const s of steps.slice(-12)) body.push(<Text dimColor wrap="truncate-end">{`  ${s}`}</Text>)
  }
  if (text.trim()) body.push(<Box marginTop={1} flexDirection="column">{await drawReply(cx, e, text.trim(), cols - PANEL_MARGIN, { margin: PANEL_MARGIN, prefix: 'agent-' })}</Box>)
  return <Box flexDirection="column">{body}</Box>
}

function drawViewLine(cx: Ctx, e: PaneEvent, p: TermPanel): RenderElement {
  const { Box, Text } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  return (
    <Box flexDirection="column">
      {titleRow(cx, e, p.title || p.slug || 'view', 'view')}
      {rule(cx, e, cols)}
      <Box width={Math.min(MEASURE, cols)}>
        <Text wrap="wrap">The browser draws this view. To see it, quit, run `thimble mode browser`, and start `thimble` again in this folder.</Text>
      </Box>
    </Box>
  )
}

/** The panel's drawing: the path row, then the view `panel` names, in the type area (1 cell inside each edge). */
export async function drawPanel(cx: Ctx, pe: PaneEvent): Promise<RenderElement> {
  await cx.panelTick()
  const e = { ...pe, props: { ...pe.props, bodyColumns: Math.max(20, pe.props.bodyColumns - 2) } } as PaneEvent
  const { Box } = cx.els(e)
  const p = (await cx.panel()) ?? { view: 'home', title: 'Home' }
  const body = await (async () => {
    switch (p.view) {
      case 'home':
        return drawHome(cx, e)
      case 'card':
        return drawCard(cx, e, p)
      case 'cite':
        return drawCite(cx, e, p)
      case 'menu':
        return drawMenu(cx, e, p)
      case 'ask':
        return drawAsk(cx, e, p)
      case 'thread':
        return drawThread(cx, e, p)
      case 'threads':
        return drawThreads(cx, e)
      case 'label':
        return drawLabel(cx, e, p)
      case 'labels':
        return drawLabels(cx, e)
      case 'docs':
        return drawDocs(cx, e)
      case 'doc':
        return drawDoc(cx, e, p)
      case 'files':
        return drawFiles(cx, e)
      case 'file':
        return drawFile(cx, e, p)
      case 'agent':
        return drawAgent(cx, e, p)
      case 'view':
        return drawViewLine(cx, e, p)
      default:
        return none(cx, e)
    }
  })()
  const way = await wayRow(cx, e, p.view)
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {way}
      {body}
    </Box>
  )
}

