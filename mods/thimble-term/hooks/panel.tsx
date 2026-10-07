// The panel: thimble-term's one pane, drawn by the view `panel` names (hooks/term.ts), on the panel's look in SPEC.md
// ("The visual system": rules 1 to 15, sections 2 and 7). A cell of padding at each side,
// then the 2-cell margin where `❯`, `?` and `↳` hang, then the type area. Every view opens with the path row
// (`‹ back`, the steps from home, `show all threads` and `N new` in green at R), its title in the accent colour and bold
// with a dim subtitle, a rule; its actions sit at its bottom after a second rule; a dim italic row of key hints ends it.
// A right-click does what a click does: there is no menu.
//
//   home      everything the workspace holds (home.ts laid out, homeview.tsx drawn): views, documents, threads, cards by
//             group (the newest open, the others folded), labels, files by folder
//   card      a card in its border, its takeaway; its code (`mode: code`)
//   cite      a citation: its value as a link, its status in plain words, its lines with the value marked, or the card
//             it names in its border with the cited mark lit; red when its place does not hold it
//   ask       the question field of a new side thread about what was asked about
//   threads   the threads as a tree under main, the selected one (`thread`) under the second rule, the ask field
//   label     a label after the browser's label editor: its name, type and scope; its prompt (or pattern or code) to edit;
//             run on a sample or on all; counts, examples and cards folded. labels: every label
//   docs      the documents; doc, one document drawn as main's chat draws a reply, its figures as cards
//   files     the file browser: folders that fold, the chosen file's first lines; file, a file's lines or its transcript
//   agent     one of thimble's agents: what it is doing and its latest steps
//   views     the views, one row each; view, one view as one line (the browser draws views)
import type { BoxProps, ButtonProps, ElementConstructor, MatchedEvent, RenderElement, TextProps } from 'claude-code'

import type { ChatNavStep, ChatThread, TermPanel, TermThread, TermVerdict } from '../types'
import type { ThimbleLabel } from './cell'
import { ACCENT, FRESH, LINK, MARGIN_W, controlsEl, fieldEls, freshSeg, hasMargin, headerEls, hintsEl, lineEl, linkSeg, marginKey, pointed, ruleEl, spread, subLine } from './chrome'
import { chipLook, citeLabel, plainCites, quoteSpan, quotedWords, wrapAround } from './cite'
import { MAX_BARS, MAX_NODES, MAX_TABLE_ROWS, amount, cardLayout, cut, demojibake, labelHead, lineWidth, placeWords, shade, share, turnTimes, valueColour, width, wrapRows } from './draw'
import type { BarRow, CardData, Cell, Item, Layout, Line, Seg } from './draw'
import { fileRef } from './files'
import { citationOf, placeOf, targetLabel } from './gestures'
import type { Gesture, Target } from './gestures'
import { groupCards, homeLayout, homePick, homeReduce, labelHue } from './home'
import type { HomeAct, HomeCardGroup, HomeData, HomeFile, HomeLabel, HomeLayout, HomeOpen, HomeReport, HomeThread, HomeUi, HomeView } from './home'
import { cid, clip, clipWords, fmt, recordFields } from './lib'
import type { Citation } from './lib'
import { linesEl } from './lines'
import type { LineHit } from './lines'
import { docUnits, docsOf, labelOf, labelsOf, threadOf } from './model'
import type { DocFigure, DocSection, DocSentence } from './model'
import type { Focus } from './anim'
import { NAV_EMPTY, backTarget, crumbSteps, fitCrumbs, threadBehind, threadOnTrail, threadTitle, threadTree, withBack } from './nav'
import { COLORS, paintLines } from './paint'
import { PANEL_MARGIN, cardBlock, cardName, citeStatus, claimCard, claimSentence, drawReply, linkCheck, placeName, plainWhy, scrubIds } from './reply'
import { closePanel, inPanelNow, navBack, navGo, openHome, openPanel, panelOfStep, readSurface, rt, runLabel, saveLabel, startThread, stopLabel, surfaceValue, threadMessage } from './term'
import type { LabelPatch } from './term'
import type { Ctx } from './ctx'
import { act } from './data'

export type PaneEvent = MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>

type Obj = Record<string, unknown>
type El = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }
type Key = { key: string; hotkey: string; onPress: () => void }
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const plural = (n: number, w: string, many = `${w}s`) => `${num(n)} ${n === 1 ? w : many}`
const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

// ------------------------------------------------------------------------------------------------ opening

/** What a new thread is told it was asked about, beside its anchor: `anchor` (a ref, or none for words on screen),
 *  `anchorText` (the words), `element` (where it was asked, a document's passage). */
export type AskOver = { anchor?: string | null; anchorText?: string; element?: string; about?: string }

/** A side thread about a target: the ask view, its question field first. A thread asked from inside the panel hangs
 *  under the thread on the panel's trail. Its words: a passage's, a mark's name and value, a card by its question, a
 *  citation's sentence. */
export async function openAsk(cx: Ctx, t: Target, over: AskOver = {}): Promise<void> {
  const c = citationOf(t)
  const anchor = over.anchor !== undefined ? over.anchor : t.kind === 'sentence' ? null : t.cardId && t.kind !== 'record' && t.kind !== 'citation' ? `card:${t.cardId}` : c?.ref ?? (t.cardId ? `card:${t.cardId}` : null)
  const anchorText =
    over.anchorText !== undefined
      ? over.anchorText
      : t.kind === 'sentence'
        ? plainCites(t.text ?? '')
        : t.kind === 'card'
          ? t.cardId
            ? await cardName(cx, t.cardId)
            : ''
          : t.kind === 'citation'
            ? plainCites(claimSentence(t.claim)) || (c ? citeLabel(c) : '')
            : plainCites(t.label ? `${t.label}` : t.text ?? '')
  const parent = (await inPanelNow(cx)) ? threadOnTrail(((await cx.nav()) ?? NAV_EMPTY).trail) : ''
  // the subject as the thread and home name it (anchorName): a card by its question, a citation by its words
  const about = over.about ?? (t.kind === 'sentence' && t.label ? t.label : t.kind === 'card' && !t.text && anchorText ? anchorText : targetLabel(t, 60))
  await openPanel(cx, { view: 'ask', title: 'Ask', target: t, anchor, anchorText, about, ...(parent ? { parent } : {}), ...(over.element ? { element: over.element } : {}) })
}

/** The views as home lists them (`thimble state home`): each by its slug and name, its state (built, building,
 *  proposed, failed), when it was proposed or built, the files it claims, and `fresh` once built and not yet opened. */
export async function homeViews(cx: Ctx): Promise<HomeView[]> {
  const homeRaw = await surfaceValue<Obj>(cx, 'home-full')
  if (!homeRaw?.ok || !Array.isArray(homeRaw.value.views)) return []
  return (homeRaw.value.views as unknown[]).filter(isObj).map(v => {
    const st = str(v.status)
    const state = st === 'built' ? 'built' : st === 'building' ? 'building' : st === 'failed' ? 'failed' : 'proposed'
    const slug = str(v.slug)
    const fresh = state === 'built' && !rt.viewsSeen.has(slug) && rt.viewsBuiltBefore !== null && !rt.viewsBuiltBefore.has(slug)
    return { slug, name: str(v.name) || slug, state, words: '', files: Array.isArray(v.files) ? (v.files as unknown[]).map(String) : [], unit: '', drawable: state === 'built', left: 0, at: Date.parse(str(v.ts)) || 0, ...(fresh ? { fresh: true } : {}) }
  })
}

/** A document in the panel, under its title. Opened, it is no longer new. */
export async function openDoc(cx: Ctx, slug: string, title: string): Promise<void> {
  const docs = await surfaceValue(cx, 'docs')
  const d = docs?.ok ? docsOf(docs.value).find(x => x.slug === slug) : undefined
  if (d) rt.docsKnown.set(slug, d.generation)
  await openPanel(cx, { view: 'doc', title: d?.title || title || slug, slug })
}

/** A view's line in the panel: the browser draws views. Opened, it is no longer new. */
export async function openView(cx: Ctx, slug: string, name: string): Promise<void> {
  rt.viewsSeen.add(slug)
  await openPanel(cx, { view: 'view', title: name || slug, slug })
}

/** A citation's panel, its step named by the cited value (or its place, for a citation that shows none). */
/** A citation by its words, or, for a place cited without words, the place in words (`revisions.jsonl line 10879`, a
 *  card by its question): the citation panel's title and its step in the path. */
async function citeTitle(cx: Ctx, c: Citation): Promise<string> {
  if (c.display !== null) return c.display
  if (fileRef(c.ref)) return placeWords(c.ref)
  return /^(?:card|cell):/.test(c.ref) ? placeName(cx, c.ref) : citeLabel(c)
}

/** A citation's panel, its step named by the cited value (or its place, for a citation that shows none); `sentence`
 *  the sentence it stands in, `quote` the passage an example's record quotes. */
export async function openCite(cx: Ctx, ref: string, display: string | null, more: { sentence?: string; quote?: string; of?: string } = {}): Promise<void> {
  const title = clip(await citeTitle(cx, { raw: '', ref, display }), 40)
  await openPanel(cx, { view: 'cite', title, ref, display, ...(more.sentence ? { sentence: more.sentence } : {}), ...(more.quote ? { quote: more.quote } : {}), ...(more.of ? { of: more.of } : {}) })
}

export async function openCard(cx: Ctx, id: string, mode = ''): Promise<void> {
  const tc = await cx.card(id)
  await openPanel(cx, { view: 'card', title: clip((tc?.data as CardData | undefined)?.question ?? 'Card', 60), card: id, ...(mode ? { mode } : {}) })
}

/** A thread opens in the threads panel, selected under the tree; its step named by its first question (`question` when
 *  it was just asked), never thimble's slug of it. */
export async function openThread(cx: Ctx, id: string, question = ''): Promise<void> {
  const row = (await cx.threads()).find(t => t.id === id)
  const tt = await cx.thread(id)
  const q = question || (tt?.events.length ? threadOf(tt.meta, tt.events).turns[0]?.q : '') || row?.question || row?.title || ''
  await openPanel(cx, { view: 'thread', title: q ? `"${clip(plainCites(q).replace(/\s+/g, ' '), 60)}"` : 'thread', thread: id })
}

/** A file in the panel from line `start`, `line` the record a citation or a click chose, lit there. */
export async function openFile(cx: Ctx, path: string, start = 1, line?: number): Promise<void> {
  await openPanel(cx, { view: 'file', title: path.split('/').at(-1) ?? path, path, start, ...(line ? { line } : {}) })
}

/** A label's panel, as it opens: what a save or a run said there before is gone. */
export async function openLabel(cx: Ctx, id: string, name: string): Promise<void> {
  const ui = await cx.labelUi()
  if (ui.said[id] && !ui.runs[id]) {
    const said = { ...ui.said }
    delete said[id]
    await cx.setLabelUi({ ...ui, said })
  }
  await openPanel(cx, { view: 'label', title: name, label: id })
}

/** What a click (or a right-click: it does what a click does) on a target does, as the mod's: open the place it cites
 *  (a citation's, a record's), or ask a side thread about a card's mark; plain words open nothing (only what is drawn as
 *  a link opens a panel). */
export async function onGesture(cx: Ctx, _gesture: Gesture, t: Target): Promise<void> {
  const place = placeOf(t)
  if (place) {
    // a citation of a reply: the sentence it stands in, and the card whose takeaway holds it; an example's record: the
    // passage the card quotes
    const sentence = t.kind === 'citation' ? claimSentence(t.claim) : ''
    const of = t.kind === 'citation' ? claimCard(t.claim) : ''
    let quote = ''
    if (t.kind === 'record' && t.cardId) {
      const card = (await cx.card(t.cardId))?.data as CardData | null | undefined
      quote = card?.examples?.find(x => x.ref === t.ref)?.quote ?? ''
    }
    return openCite(cx, place.ref, place.display, { ...(sentence ? { sentence } : {}), ...(quote ? { quote } : {}), ...(of ? { of } : {}) })
  }
  if (t.cardId) return openAsk(cx, t)
}

// ------------------------------------------------------------------------------------------------ the frame

/** Hotkeys with no label of their own (rule 26: the key-hint row says them): plain Buttons in a Box no row tall. */
function hiddenKeys(cx: Ctx, e: PaneEvent, keys: Key[]): RenderElement | null {
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

/** What a step of the path says: a lower-case kind word and its name, or the name alone after the list it is in. */
function crumbText(s: ChatNavStep): string {
  switch (s.view) {
    case 'thread':
      return s.title
    case 'cite':
      return `citation ${s.title === 'Citation' ? '' : s.title}`.trim()
    case 'card':
      // its code view's step keeps ` · code` whole: the question is cut first
      return panelOfStep(s)?.mode === 'code' ? `card "${clip(s.title, 22)}" · code` : `card "${s.title}"`
    case 'label':
    case 'file':
    case 'agent':
    case 'view':
      return s.title
    case 'doc':
      return `"${s.title}"`
    case 'docs':
      return 'documents'
    case 'ask':
      return 'new thread'
    default:
      return s.view
  }
}

/** The list a step stands in, which the path shows before it unless the step before it is that list. */
function upOf(s: ChatNavStep, earlier: readonly ChatNavStep[]): TermPanel | null {
  const before = earlier.at(-1)
  if (s.view === 'thread') return earlier.some(x => x.view === 'thread' || x.view === 'threads') ? null : { view: 'threads', title: 'Threads' }
  if (s.view === 'label') return before?.view === 'labels' ? null : { view: 'labels', title: 'Labels' }
  if (s.view === 'doc') return before?.view === 'docs' ? null : { view: 'docs', title: 'Documents' }
  if (s.view === 'file') return before?.view === 'files' ? null : { view: 'files', title: 'Files' }
  if (s.view === 'view') return before?.view === 'views' ? null : { view: 'views', title: 'Views' }
  return null
}

/** The path row (SPEC.md, "A panel's header"): `‹ back`, the steps from home, each a lower-case kind word and its
 *  name parted by a dim ›, each a click away, a thread's step followed by `new` in green while answers wait; at R `show
 *  all threads` and `N new` in green. The threads panel leaves those out. */
async function wayRow(cx: Ctx, e: PaneEvent, view: string): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const nav = (await cx.nav()) ?? NAV_EMPTY
  const back = backTarget(nav) !== null
  const inThreads = view === 'threads' || view === 'thread'
  const threads = (await cx.threads()) ?? []
  const fresh = ((await cx.news()) ?? { n: 0 }).n
  const tailW = inThreads ? 0 : 'show all threads'.length + (fresh ? `  ${fresh} new`.length : 0) + 2
  const { steps, skipped } = crumbSteps(nav.trail)
  type Crumb = { text: string; mark: string; go: () => void; here?: boolean; up?: boolean }
  const crumbs: Crumb[] = []
  for (const [i, s] of steps.entries()) {
    const up = upOf(s, steps.slice(0, i))
    if (up) crumbs.push({ text: up.view === 'docs' ? 'documents' : up.view, mark: '', up: true, go: () => void openPanel(cx, up) })
    const t = s.view === 'thread' ? threads.find(x => x.id === s.thread) : undefined
    crumbs.push({ text: crumbText(s), mark: t?.running ? '◌' : t?.unread ? 'new' : '', go: () => void navGo(cx, { trail: nav.trail.slice(0, i + 1 + skipped), back: withBack(nav.back, nav.trail) }), here: i === steps.length - 1 })
  }
  const marksW = crumbs.reduce((n, c) => n + (c.mark ? c.mark.length + 1 : 0), 0)
  const fitted = fitCrumbs(['home', ...crumbs.map(c => c.text)], Math.max(12, cols - (back ? 8 : 0) - tailW - marksW))
  const parts: RenderElement[] = []
  fitted.forEach((text, i) => {
    if (text === null) {
      if (fitted[i - 1] !== null) parts.push(<Text dimColor>{' › …'}</Text>)
      return
    }
    if (i) parts.push(<Text dimColor>{' › '}</Text>)
    const c = i ? crumbs[i - 1]! : null
    if (c?.mark === '◌') parts.push(<Text>{'◌ '}</Text>)
    if (c?.here) parts.push(<Text>{text}</Text>)
    else if (c) parts.push(<Button key={c.up ? `crumb-up-${i}` : `crumb-${i}`} label={text} plain onPress={c.go} />)
    else if (view === 'home' && fitted.length === 1) parts.push(<Text>{text}</Text>)
    else parts.push(<Button key="crumb-home" label={text} plain onPress={() => void openHome(cx)} />)
    if (c?.mark === 'new') parts.push(<Text color={FRESH}>{' new'}</Text>)
  })
  const showAll = () => void openPanel(cx, { view: 'threads', title: 'Threads' })
  return (
    <Box key="way" flexDirection="row">
      {back ? <Button key="nav-back" label="‹ back" plain onPress={() => void navBack(cx)} /> : null}
      {back ? <Text>{'  '}</Text> : null}
      {parts}
      <Box flexGrow={1} />
      {inThreads ? null : <Button key="threads" label="show all threads" plain onPress={showAll} />}
      {!inThreads && fresh ? <Text color={FRESH}>{`  ${fresh} new`}</Text> : null}
      {hiddenKeys(cx, e, [...(back ? [{ key: 'back', hotkey: 'b', onPress: () => void navBack(cx) }] : []), ...(inThreads ? [] : [{ key: 'threads', hotkey: 't', onPress: showAll }]), { key: 'close', hotkey: 'x', onPress: () => void closePanel(cx) }])}
    </Box>
  )
}

/** The path row, then the view's rows, each with an empty margin unless it brings its own (a key starting `m:`). */
async function withWay(cx: Ctx, e: PaneEvent, view: string, body: RenderElement): Promise<RenderElement> {
  const way = await wayRow(cx, e, view)
  const { Box } = cx.els(e)
  const b = body as unknown as { type?: string; props?: { flexDirection?: string }; children?: unknown[] }
  const kids = (b.type === 'Box' && b.props?.flexDirection === 'column' ? (b.children ?? []) : [body]).filter(k => Boolean(k)) as RenderElement[]
  const rows = [way, ...kids].map(k => (hasMargin(k) ? k : <Box paddingLeft={MARGIN_W} flexDirection="column">{k}</Box>))
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {rows}
    </Box>
  )
}

/** A list's rows as lines: each item's glyph at A0 and its name at A2, its metadata dim at R, `❯` on the chosen one. */
function listLines(items: { key: string; glyph: Seg | null; name: string; right: Line; run: () => Promise<void> | void }[], pick: string, cols: number): { lines: Line[]; hits: LineHit[] } {
  const lines: Line[] = []
  const hits: LineHit[] = []
  for (const it of items) {
    hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: it.run })
    lines.push(pointed(spread([it.glyph ?? { s: ' ' }, { s: ' ' }, { s: it.name }], it.right, cols), it.key === pick))
  }
  if (!items.length) lines.push(pointed([{ s: '  ' }, dim('none')], false))
  return { lines, hits }
}

// ------------------------------------------------------------------------------------------------ shared parts

/** Code as Claude Code colours it (its `Code` element), its dim gutter of line numbers from `startLine`. */
function codeRows(cx: Ctx, e: PaneEvent, source: string, max = 400, language = 'python', startLine: number | null = 1): RenderElement {
  const { Box, Text, Code } = cx.els(e)
  const lines = source.replace(/\t/g, '    ').split('\n')
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  const shown = lines.slice(0, lines.length > max + 1 ? max : lines.length)
  return (
    <Box flexDirection="column">
      <Code source={shown.join('\n') || ' '} language={language} {...(startLine !== null ? { startLine } : {})} wrap="truncate-end" />
      {lines.length > shown.length ? <Text dimColor>{`… ${lines.length - shown.length} more`}</Text> : null}
    </Box>
  )
}

// the way's keys the panel binds now (wayRow): `b to go back` only when there is a way back, `x to close` always
let wayHints: string[] = ['x to close']

/** A view's key hints with the way's after them, as bound now (rule 26: the hint row names only keys bound on it). */
function endHints(hints: readonly string[]): string[] {
  return [...hints.filter(h => h !== 'b to go back' && h !== 'x to close'), ...wayHints]
}

function hintsRow(els: El, hints: readonly string[], cols: number): RenderElement {
  return hintsEl(els, endHints(hints), cols)
}

/** The panel's bottom part (rule 25): the second rule, the actions 2 cells apart, the fields under them; then the
 *  key-hint row, the panel's last. */
function bottomRows(cx: Ctx, e: PaneEvent, cols: number, controls: (RenderElement | null | false)[], fields: (RenderElement | null | false)[], hints: string[], rule = true): RenderElement[] {
  const els = cx.els(e) as El
  const ctl = controlsEl(els, controls, 'bottom-controls')
  const fs = fields.filter((f): f is RenderElement => Boolean(f))
  return [...(rule && (ctl || fs.length) ? [ruleEl(els, cols, 'rule-bottom')] : []), ...(ctl ? [ctl] : []), ...fs, hintsRow(els, hints, cols)]
}

/** An empty region (rule 28): dim words at A2. */
function none(cx: Ctx, e: PaneEvent, words = 'none'): RenderElement {
  const { Box, Text } = cx.els(e)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor>{words}</Text>
    </Box>
  )
}

/** A field of the panel (rule 27): its label dim and lower case, the field after a gutter. */
function fieldRow(cx: Ctx, e: PaneEvent, label: string, field: RenderElement, key: string): RenderElement {
  const { Box, Text } = cx.els(e)
  return (
    <Box key={key} flexDirection="row">
      <Text dimColor>{`${label}  `}</Text>
      <Box flexGrow={1} flexShrink={1}>
        {field}
      </Box>
    </Box>
  )
}

// ------------------------------------------------------------------------------------------------ home

/** What the home panel lists, from what `thimble state` printed for its surfaces. */
export async function homeData(cx: Ctx): Promise<HomeData> {
  const homeRaw = await surfaceValue<Obj>(cx, 'home-full')
  const views: HomeView[] = await homeViews(cx)
  const docs = await surfaceValue(cx, 'docs')
  const first = docs?.ok ? !rt.docsRead : false
  if (docs?.ok) rt.docsRead = true
  const reports: HomeReport[] = docs?.ok
    ? docsOf(docs.value).map(d => {
        // a document written since the session first read the list, and not opened since, is new
        const known = rt.docsKnown.get(d.slug)
        if (first) rt.docsKnown.set(d.slug, d.generation)
        return { slug: d.slug, title: d.title, form: d.renderer, state: d.status === 'generating' ? 'writing' : 'written', cards: 0, tools: 0, at: Date.parse(d.at) || 0, ...(!first && known !== d.generation && d.status !== 'generating' ? { fresh: true } : {}) }
      })
    : []
  const threads: HomeThread[] = []
  for (const t of (await cx.threads()) ?? []) {
    const st = t.running ? 'run' : rt.failed.has(t.id) ? 'problem' : t.answers ? 'ok' : 'dim'
    // its subject at R only when a card or a citation names it (a few words): a passage's sentence would cut the
    // question beside it
    const about = await anchorName(cx, t)
    const made = Date.parse(t.created ?? '') || 0
    threads.push({ id: t.id, title: `"${clip(plainCites(t.question || t.title || t.anchorText || 'side thread').replace(/\s+/g, ' '), 80)}"`, about: about ? `about ${clip(about, 32)}` : '', words: t.running ? 'answering' : plural(t.answers, 'answer'), tone: st, unread: t.unread, earlier: Boolean(made && rt.startedAt && made < rt.startedAt), at: Date.parse(t.at) || 0 })
  }
  const canvas = await surfaceValue<Obj>(cx, 'canvas')
  const groups = canvas?.ok && Array.isArray(canvas.value.groups) ? (canvas.value.groups as unknown[]).filter(isObj) : []
  const cells = canvas?.ok && Array.isArray(canvas.value.cells) ? (canvas.value.cells as unknown[]).filter(isObj) : []
  // a group by what it holds: a side thread's cards, a document's figures, or a group main named
  const cardOf = (c: Obj) => ({ id: str(c.id), kind: str(c.kind) || 'code', question: str(c.title) || 'a card' })
  // a group by what it holds: a side thread's cards, a document's figures, or a group main named; a card no listed
  // group holds under `other cards`, last
  // a side thread's group by the thread's first question, as everywhere a thread is named (its title is a slug)
  const rowsNow = (await cx.threads()) ?? []
  const threadHead = (chat: string): string => {
    const r = rowsNow.find(t => t.id === chat)
    const q = r ? plainCites(r.question || r.title || '') : ''
    return q.trim() ? `"${clipWords(q, 60)}"` : ''
  }
  const cardGroups: HomeCardGroup[] = groupCards(
    groups.map(g => {
      const from: HomeCardGroup['from'] = g.anchor || g.chat ? 'thread' : g.role === 'figures' ? 'report' : 'other'
      const head = (g.chat ? threadHead(str(g.chat)) : '') || str(g.title) || 'cards'
      return { head, from, cards: cells.filter(c => c.notebook === g.id).map(cardOf), at: Date.parse(str(g.ts)) || 0 }
    }),
    cells.map(cardOf),
  )
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
  const files: HomeFile[] = filesOf(await surfaceValue(cx, 'files')).map(f => ({ file: f.path, records: null, size: f.size, seen: 0, state: 'listed', ranges: [], kind: fileType(f.path, f.kind, rt.opens.get(f.path)?.as) }))
  const root = (await cx.root().catch(() => '')).split('/').filter(Boolean).at(-1) ?? 'folder'
  return { views, reports, threads, cardGroups, labels, files, coverage: homeRaw?.ok ? str(homeRaw.value.coverage) : '', root }
}

// the home panel's last layout, which a key steps through
let homeLast: HomeLayout | null = null

/** The home panel (SPEC.md, "Home"), drawn from home.ts's lines: a click on a row opens it, on a heading its
 *  section's panel, on a group or folder folds it; ↑↓ choose a row, Enter opens it and Space folds it. */
async function drawHome(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>The home panel needs the terminal or the desktop app.</Text>
  const cols = Math.max(40, e.props.bodyColumns)
  const ui = (await cx.homeUi()) as HomeUi
  const lay = homeLayout(await homeData(cx), ui, cols)
  homeLast = lay
  const run = (a: HomeAct) => async () => {
    if (a.op === 'open') await homeOpen(cx, a.open)
    else await cx.setHomeUi(homeReduce((await cx.homeUi()) as HomeUi, a))
  }
  const hits: LineHit[] = lay.hits.map(h => ({
    y: h.y,
    x0: h.x0,
    x1: h.x1,
    row: h.row,
    run: async () => {
      if (h.pick) await cx.setHomeUi({ ...((await cx.homeUi()) as HomeUi), pick: h.pick })
      await run(h.act)()
    },
  }))
  const onKey = async (k: string) => {
    const cur = (await cx.homeUi()) as HomeUi
    const l = homeLast
    if (!l) return
    const pick = cur.pick || l.picks[0]?.key || ''
    const at = l.picks.find(x => x.key === pick)
    if (k === 'return' || k === 'enter') return at ? run(at.act)() : undefined
    if (k === 'space' || k === ' ') return at?.act.op === 'fold' ? run(at.act)() : undefined
    const next = homePick(l, cur, k)
    if (next !== cur.pick) await cx.setHomeUi({ ...cur, pick: next })
  }
  return <Box flexDirection="column">{linesEl(cx, e, marginKey('home'), lay.lines, hits, cols + MARGIN_W, onKey)}</Box>
}

async function homeOpen(cx: Ctx, o: HomeOpen): Promise<void> {
  switch (o.kind) {
    case 'view': {
      const v = (await homeViews(cx)).find(x => x.slug === o.slug)
      return openView(cx, o.slug, v?.name ?? o.slug)
    }
    case 'report':
      return openDoc(cx, o.slug, o.title ?? o.slug)
    case 'thread':
      return openThread(cx, o.id)
    case 'card':
      return openCard(cx, o.id)
    case 'label': {
      const got = await surfaceValue(cx, 'labels')
      const hit = got?.ok ? labelsOf(got.value).find(l => l.name === o.name || l.id === o.name) : undefined
      return openLabel(cx, hit?.id ?? o.name, o.name)
    }
    case 'file':
      return openFile(cx, o.path)
    case 'pane': {
      // a folder's `… N more`: the file browser with that folder whole
      if (o.view === 'coverage' && o.folder) {
        const root = `${(await cx.root().catch(() => '')).split('/').filter(Boolean).at(-1) ?? 'folder'}/`
        // home names a folder as the file browser does: its path, the corpus's own files by the corpus folder's name
        const dir = o.folder === root ? '' : o.folder
        const ui = await cx.filesUi()
        await cx.setFilesUi({ ...ui, whole: [...(ui.whole ?? []).filter(x => x !== dir), dir], unfolded: [...ui.unfolded.filter(x => x !== `dir:${dir}`), `dir:${dir}`], folded: ui.folded.filter(x => x !== `dir:${dir}`) })
      }
      const to: Record<string, TermPanel> = {
        reports: { view: 'docs', title: 'Documents' },
        threads: { view: 'threads', title: 'Threads' },
        labels: { view: 'labels', title: 'Labels' },
        coverage: { view: 'files', title: 'Files' },
        views: { view: 'views', title: 'Views' },
      }
      return openPanel(cx, to[o.view] ?? { view: 'home', title: 'Home' })
    }
  }
}

// ------------------------------------------------------------------------------------------------ a card

/** A card in the panel (SPEC.md, "Cards", the card pane): its question is the panel's title; its kind, who made
 *  it, how its last run ended (`last run failed` in red) and a card check that ended in an error (in red, with why) the
 *  dim subtitle; the card in its border, its takeaway
 *  under it; at the bottom `code  run again  ask about it` (`◌ running` while it runs). Its code (`mode: code`)
 *  through the `Code` element with its gutter at A0, then `output`, the last 8 lines its run printed; `card  run again
 *  ask about it` at the bottom. A run again goes to main, whose Bash runs a card (`thimble-run card`). */
async function drawCard(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const id = p.card ?? ''
  const tc = await cx.card(id)
  const cols = Math.max(30, e.props.bodyColumns)
  if (!tc) return none(cx, e, '◌ reading the card')
  if (!tc.data) return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× this card cannot be drawn: ${tc.error || 'the card is not in this workspace'}`}</Text></Box>
  const data = tc.data as CardData
  const by = tc.by ? `made by ${/^(main|terminal|user)$/.test(tc.by) ? 'main' : /^chat:/.test(tc.by) ? 'a side thread' : tc.by}` : ''
  const ran: Seg | null = tc.ran === 'error' ? { s: 'last run failed', fg: COLORS.problem } : tc.ran === 'ok' ? dim('last run ok') : null
  // a card check that ended in an error says so, and why, in red: the card itself may be fine, but nothing read it
  const checked: Seg | null = tc.check?.state === 'error' ? { s: `its check ended in an error${tc.check.why ? `: ${tc.check.why}` : ''}`, fg: COLORS.problem } : null
  const ask = () => void openAsk(cx, { kind: 'card', ref: `card:${id}`, cardId: id, text: data.question })
  const busy = Boolean(tc.busy)
  const again = () => {
    if (busy) return
    void cx.submit(`Run this card again with Bash: thimble-run card ${id}`)
  }
  const code = p.mode === 'code'
  const body: RenderElement[] = [...headerEls(els, { title: data.question, cols, sub: subLine([code ? 'its code' : tc.kind, by, ran, checked]) })]
  const runEl = busy ? <Text key="card-running">◌ running</Text> : tc.code ? <Button key="card-again" label="run again" plain onPress={again} /> : null
  const keys: Key[] = [{ key: 'ask', hotkey: 'a', onPress: ask }, ...(tc.code && !busy ? [{ key: 'again', hotkey: 'r', onPress: again }] : [])]
  const runHint = tc.code && !busy ? ['r to run again'] : []
  if (code) {
    body.push(tc.code ? codeRows(cx, e, tc.code, 400) : none(cx, e, 'no code'))
    // what its last run printed: its last 8 lines
    const out = (tc.printed ?? '').split('\n').filter(l => l.trim()).slice(-8)
    body.push(
      fieldRow(
        cx,
        e,
        'output',
        out.length ? (
          <Box flexDirection="column">
            {out.map((l, i) => (
              <Text key={`out-${i}`} wrap="truncate-end">
                {demojibake(l)}
              </Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>nothing printed</Text>
        ),
        'card-output',
      ),
    )
    keys.push({ key: 'card', hotkey: 'c', onPress: () => void openCard(cx, id) })
    body.push(...bottomRows(cx, e, cols, [<Button key="card-card" label="card" plain onPress={() => void openCard(cx, id)} />, runEl, <Button key="card-ask" label="ask about it" plain onPress={ask} />], [], ['c for the card', ...runHint, 'a to ask', 'b to go back', 'x to close']))
  } else {
    body.push(<Box key="card-box" flexDirection="column">{await cardBlock(cx, e, id, cols, 'pane', { pane: true })}</Box>)
    if (tc.code) keys.push({ key: 'code', hotkey: 'c', onPress: () => void openCard(cx, id, 'code') })
    body.push(...bottomRows(cx, e, cols, [tc.code ? <Button key="card-code" label="code" plain onPress={() => void openCard(cx, id, 'code')} /> : null, runEl, <Button key="card-ask" label="ask about it" plain onPress={ask} />], [], [...(tc.code ? ['c for its code'] : []), ...runHint, 'a to ask', 'b to go back', 'x to close']))
  }
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// ------------------------------------------------------------------------------------------------ a citation

/** Where position `p` of a line lands once each tab is drawn as two spaces and its mojibake is mended. */
function shifted(raw: string, p: number): number {
  return demojibake(raw.slice(0, p)).replace(/\t/g, '  ').length
}

/** The cited lines nested at A2 (SPEC.md, section 7, "The citation panel"): each line's number right-aligned in
 *  a dim column (the cited one's in the text colour), its text after a gutter; a cited line wrapped over 3 to 8 rows
 *  (by the pane's rows) around the value or the quoted passage on the selection background; two lines of context
 *  around the cited ones when a cited line wraps; a long context line cut with `…` around its value. */
function lineRows(cx: Ctx, e: PaneEvent, v: TermVerdict, cols: number, quote: string): RenderElement[] {
  const { Text } = cx.els(e)
  const all = v.lines.slice(0, 60)
  const gutter = Math.max(1, ...all.map(l => String(l.n || '').length))
  const room = Math.max(10, cols - gutter - 4)
  const hits = all.filter(l => l.hit)
  const hitRows = Math.max(3, Math.min(8, Math.floor(((e.props.scroll?.bodyRows || 20) - 14) / Math.max(1, hits.length))))
  const wraps = hits.some(l => l.text.length > room)
  const near = wraps ? 2 : 99
  const firstHit = all.findIndex(l => l.hit)
  const lastHit = all.length - 1 - [...all].reverse().findIndex(l => l.hit)
  const lines = firstHit < 0 ? all : all.filter((l, i) => l.hit || (i >= firstHit - near && i <= lastHit + near))
  const out: RenderElement[] = []
  for (const l of lines) {
    const text = demojibake(l.text).replace(/\t/g, '  ')
    const n = l.n ? String(l.n).padStart(gutter) : ' '.repeat(gutter)
    const spans = (l.spans ?? []).map(([a, b]) => [shifted(l.text, a!), shifted(l.text, b!)] as [number, number])
    if (!l.hit) {
      // a context line: cut around its value when it is wider than the room
      let t = text
      let sp = spans
      if (t.length > room) {
        // `…` right against the words at each end: no space between them
        const lo = sp.length ? Math.max(0, sp[0]![0] - Math.floor(room / 3)) : 0
        const head = t.slice(lo, lo + room - 2)
        const lead = lo ? head.length - head.trimStart().length : 0
        t = `${lo ? '…' : ''}${head.slice(lead).trimEnd()}…`
        const shift = lo + lead - (lo ? 1 : 0)
        sp = sp.map(([a, b]) => [a - shift, b - shift] as [number, number])
      }
      out.push(
        <Text wrap="truncate-end">
          <Text dimColor>{`  ${n}  `}</Text>
          <Text dimColor>{t || ' '}</Text>
        </Text>,
      )
      continue
    }
    const span: [number, number] | null = quote ? quoteSpan(text, quote) : spans[0] ?? null
    wrapAround(text, span, room, hitRows).forEach((r, i) =>
      out.push(
        <Text wrap="truncate-end">
          <Text>{`  ${i === 0 ? n : ' '.repeat(gutter)}  `}</Text>
          <Text>{r.hi ? r.text.slice(0, r.hi[0]) : r.text || ' '}</Text>
          {r.hi ? <Text backgroundColor={COLORS.selected}>{r.text.slice(r.hi[0], r.hi[1])}</Text> : null}
          {r.hi ? <Text>{r.text.slice(r.hi[1])}</Text> : null}
        </Text>,
      ),
    )
  }
  return out
}

const sameKey = (a: string, b: string) => a === b || (a.trim() !== '' && b.trim() !== '' && Number(a) === Number(b)) || a.toLowerCase() === b.toLowerCase()

/** The item of a card's layout a verdict names (by the resolver's column and row): a table's cell, a bar, a line's
 *  point by its series and x, a timeline's event by its number, a diagram's node or edge; -1 for none. */
function citedItem(card: CardData, items: Item[], v: TermVerdict): number {
  if (!v.column || v.row === undefined || v.row === '') return -1
  if (card.kind === 'diagram' && v.column === 'edge') return items.findIndex(it => it.open === `card:${card.id}#edge/${v.row}`)
  if (card.kind === 'diagram' && v.column === 'node') return (card.nodes ?? []).slice(0, MAX_NODES).findIndex(n => String(n.id) === v.row)
  if (card.kind === 'timeline' && v.column === 'time') {
    const n = Number(v.row) - 1
    return n >= 0 && n < items.length ? n : -1
  }
  const pre = `card:${card.id}#${v.column}/`
  return items.findIndex(it => it.open.startsWith(pre) && sameKey(it.open.slice(pre.length), v.row!))
}

/** A card whose cited table or bar row is past the rows drawn, that row in place of the last one drawn. */
function withCitedRow(card: CardData, v: TermVerdict): CardData {
  const cap = card.kind === 'table' ? MAX_TABLE_ROWS : card.kind === 'bar' || card.kind === 'label' ? MAX_BARS : 0
  const all = card.rows ?? []
  if (!cap || all.length <= cap || !v.row) return card
  const r = all.findIndex(x => sameKey(fmt(card.kind === 'table' ? (x as Cell[])[0] : (x as BarRow).label), v.row!))
  return r < cap ? card : { ...card, rows: [...all.slice(0, cap - 1), all[r]!] as CardData['rows'] }
}

/** The cells of a layout that hit item `k`, on the selection background. */
function litItem(lay: Layout, k: number, bg: string): Line[] {
  if (k < 0) return lay.lines
  const spans: { line: number; x0: number; x1: number }[] = []
  lay.lines.forEach((l, y) => {
    const w = lineWidth(l)
    let x0 = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && lay.hit(x, y) === k
      if (on && x0 < 0) x0 = x
      if (!on && x0 >= 0) {
        spans.push({ line: y, x0, x1: x })
        x0 = -1
      }
    }
  })
  return shade(lay.lines, spans, bg)
}

/** A card with the cited mark on the selection background, kept in view: a cited row past the drawn rows in place of
 *  the last; a table's column names, then the rows around the cited one when the card is taller than the pane's room;
 *  a total's `all` lit. */
function citedLines(card: CardData, v: TermVerdict, w: number, room: number): { card: CardData; lines: Line[] } {
  const shown = withCitedRow(card, v)
  const base = cardLayout(shown, w, -1, 8)
  const k = citedItem(shown, base.items, v)
  let lines = k >= 0 ? litItem(base, k, COLORS.selected) : base.lines
  if (k < 0 && (shown.kind === 'bar' || shown.kind === 'label') && v.row === 'all') {
    lines = lines.map(l => {
      const at = l.findIndex(x => x.s === 'all  ')
      return at < 0 ? l : l.map((x, j) => (j === at + 1 ? { ...x, bg: COLORS.selected } : x))
    })
  }
  const ys = lines.flatMap((l, y) => (l.some(x => x.bg === COLORS.selected) ? [y] : []))
  if (lines.length > room && ys.length && ys.at(-1)! >= room) {
    // a table's column names are the lines before its first row
    let head = 0
    if (shown.kind === 'table') while (head < lines.length && base.hit(0, head) < 0) head++
    const lo = Math.max(head, Math.min(ys[0]! - 1, lines.length - (room - head)))
    lines = [...lines.slice(0, head), ...lines.slice(lo, lo + room - head)]
  }
  return { card: shown, lines }
}

/** A card the panel draws itself, laid out as every card is (reply.tsx cardBlock): a full round border in the rule grey
 *  with a cell of padding; its title in bold, a blank row, its body, then its label rows. */
function framedCard(cx: Ctx, e: PaneEvent, card: CardData, w: number, lines: Line[], key: string): RenderElement {
  const { Box, Text } = cx.els(e)
  const inner = Math.max(10, w - 4)
  return (
    <Box key={key} flexDirection="column" width={w} borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
      {paintLines(Box, Text, [[{ s: cut(card.question, inner), b: true }], [], ...lines, ...labelHead(card, inner).lines])}
    </Box>
  )
}

/** The sentence a citation stands in, its value blue and underlined, in quotation marks. */
function sourceSegs(sentence: string, c: Citation): Line {
  const flat = plainCites(sentence).replace(/\s+/g, ' ').trim()
  // a citation written without words stands in the sentence as its label (`revisions:1`)
  const shown = c.display ?? citeLabel(c)
  const at = shown ? flat.indexOf(shown) : -1
  if (at < 0) return [{ s: `"${flat}"` }]
  return [{ s: `"${flat.slice(0, at)}` }, linkSeg(shown), { s: `${flat.slice(at + shown.length)}"` }]
}

/** In a citation opened from a side thread, a field whose question goes on in that thread, about the citation; the
 *  panel then shows the thread. */
async function followUpField(cx: Ctx, e: PaneEvent, about: string): Promise<RenderElement | null> {
  if (e.surface === 'mobile') return null
  const nav = (await cx.nav()) ?? NAV_EMPTY
  const tid = threadBehind(nav.trail)
  if (!tid) return null
  const { Input } = cx.els(e)
  return fieldRow(
    cx,
    e,
    'follow-up',
    <Input
      key={`follow-${cid(tid)}`}
      submitLabel="ask"
      onSubmit={v => {
        const q = v.trim()
        if (!q) return
        void (async () => {
          const r = await threadMessage(cx, tid, `${q} (about ${about})`)
          if (r.error) return cx.toast(`thimble: ${r.error}`)
          const now = (await cx.nav()) ?? NAV_EMPTY
          let i = now.trail.length - 1
          while (i >= 0 && now.trail[i]!.thread !== tid) i--
          if (i >= 0) await navGo(cx, { trail: now.trail.slice(0, i + 1), back: withBack(now.back, now.trail) })
        })()
      }}
    />,
    'follow-row',
  )
}

/** The citation panel (SPEC.md, section 7, "The citation panel"): the title is the cited value, bold, blue and
 *  underlined (a link to its place; red when the value is not there), ◌ after it while it is checked and a red × for a
 *  problem; the subtitle its status in plain words; under the rule `from` and `source` (the sentence it stands in, the
 *  value in it a link), then the cited lines nested at A2 with the value (or the passage an example quotes) on the
 *  selection background, or the cited card in its border with the cited mark lit; at the bottom `ask about it` and, for
 *  a citation opened from a side thread, the `follow-up` field. */
async function drawCite(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  if (!p.ref) return none(cx, e)
  const c = { raw: p.display === null || p.display === undefined ? `[[${p.ref}]]` : `[[${p.display}|${p.ref}]]`, ref: p.ref, display: p.display ?? null }
  const v = await cx.verdict(cid(c.raw))
  const status = v?.status ?? 'pending'
  const red = status === 'missing' || status === 'differs'
  const target: Target = { kind: 'citation', ref: c.raw, text: citeLabel(c) }
  const f = fileRef(c.ref)
  const cardId = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(c.ref)?.[1]
  const label = cut(await citeTitle(cx, c), Math.max(8, cols - 6))
  // the takeaway's card's links check, as the chat marks the citation: ◌ while it runs, ✓ once a script got the value, a
  // red × when it got another
  const check = p.of ? linkCheck((await cx.card(p.of))?.links, c) : {}
  const look = chipLook(status, undefined, check.state)
  const bad = red || look.state === 'failed'
  const mark: Seg | null = !v || look.spin ? { s: ' ◌' } : bad ? { s: ' ×', fg: COLORS.problem } : look.mark ? { s: ` ${look.mark}` } : null
  const titleSegs: Line = [{ s: label, b: true, fg: bad ? COLORS.problem : LINK, u: true }, ...(mark ? [mark] : [])]
  const opens = f ? () => openFile(cx, f.path, Math.max(1, (f.line ?? 1) - 5), f.line) : cardId ? () => openCard(cx, cardId) : null
  const body: RenderElement[] = []
  body.push(opens ? linesEl(cx, e, 'cite-title', [titleSegs], [{ y: 0, x0: 0, x1: width(label), row: false, run: () => void opens() }], cols) : lineEl(els, titleSegs, 'cite-title'))
  const why = red && v?.why ? await plainWhy(cx, v.why) : check.state === 'refuted' && check.why ? await plainWhy(cx, check.why) : ''
  // a citation with no words is titled by its place: its subtitle does not name the place again, and it has none
  // while the place is there
  const bare = c.display === null
  const said = bare ? (!v || status === 'pending' ? '◌ checking' : red ? 'not found' : '') : await citeStatus(cx, c, v, check)
  const sub = [said, why].filter(Boolean).join(' · ')
  if (sub) body.push(lineEl(els, [{ s: sub, fg: bad ? COLORS.problem : COLORS.dim }], 'cite-sub', true))
  body.push(ruleEl(els, cols, 'cite-rule'))
  // `from` names the place, unless the title is the place already (a citation written without words)
  const from = cardId ? await placeName(cx, `card:${cardId}`) : placeWords(c.ref)
  const rows: [string, RenderElement | string, string?][] = from === (await citeTitle(cx, c)) ? [] : [['from', from]]
  if (p.sentence) rows.push(['source', lineEl(els, sourceSegs(p.sentence, c), 'cite-source', true)])
  if (rows.length) body.push(fieldEls(els, rows, 'cite')!)
  const quote = p.quote || quotedWords(c.display)
  if (v?.card) {
    const tc = await cx.card(v.card)
    const card = tc?.data as CardData | null | undefined
    const w = Math.min(cols, 96)
    if (card) {
      const lit = citedLines(card, v, Math.max(10, w - 4), Math.max(8, (e.props.scroll?.bodyRows || 20) - 14))
      body.push(framedCard(cx, e, lit.card, w, lit.lines, 'cite-card'))
    }
  } else if (v?.lines.length) {
    body.push(<Box key="cite-lines" flexDirection="column">{lineRows(cx, e, v, cols, quote)}</Box>)
    // the passage an example quotes, when the cited lines do not hold it
    if (quote && status !== 'differs' && !v.lines.some(l => l.hit && quoteSpan(demojibake(l.text).replace(/\t/g, '  '), quote))) body.push(fieldEls(els, [['quoted', <Text wrap="wrap" backgroundColor={COLORS.selected}>{clip(demojibake(quote), 600)}</Text>]], 'cite-quoted')!)
  } else if (!v) body.push(<Text key="cite-wait" dimColor>◌ checking</Text>)
  const ask = () => void openAsk(cx, target, p.sentence ? { anchorText: plainCites(p.sentence) } : {})
  const goOn = await followUpField(cx, e, c.raw)
  const keys: Key[] = [{ key: 'ask', hotkey: 'a', onPress: ask }, ...(f ? [{ key: 'files', hotkey: 'f', onPress: () => void opens?.() }] : [])]
  body.push(...bottomRows(cx, e, cols, [<Button key="cite-ask" label="ask about it" plain onPress={ask} />], [goOn], ['a to ask', ...(f ? ['f for its file'] : [])]))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// ------------------------------------------------------------------------------------------------ a new thread

let asking = ''

/** A passage's first sentence, flat. */
function firstSentence(text: string): string {
  const flat = plainCites(text).replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  const end = /[.!?](?=\s|$)/.exec(flat)
  return end ? flat.slice(0, end.index + 1) : flat
}

/** A new side thread (SPEC.md, section 7, "The threads panel", a thread with no question yet): `about <what>`
 *  as its dim subtitle, the first sentence of the passage dim on one row, then the `ask` field, which has the keys. */
async function drawAsk(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  if (e.surface === 'mobile') return none(cx, e, 'A side thread needs a surface with text fields.')
  const els = cx.els(e) as El
  const { Box, Text, Input } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const opens = p.anchorText && p.target?.kind !== 'card' ? firstSentence(p.anchorText) : ''
  const body: RenderElement[] = [...headerEls(els, { title: 'New thread', cols, sub: subLine([`about ${p.about ?? 'this'}`]) })]
  if (opens && !(p.about ?? '').includes(opens)) body.push(<Text key="ask-words" dimColor wrap="truncate-end">{opens}</Text>)
  if (asking) body.push(<Text key="ask-state" {...(asking.startsWith('×') ? { color: COLORS.problem } : { dimColor: true })}>{asking}</Text>)
  // the field alone, its placeholder saying what it takes: Enter's word (`⏎ ask`) is the only `ask`
  const field = (
    <Box key="ask-row" flexDirection="row">
      <Input
        key="ask-new"
        autoFocus
        placeholder="type your question"
        submitLabel="ask"
        onSubmit={v => {
          void (async () => {
            const q = v.trim()
            if (!q) return
            asking = '◌ asking'
            await cx.bumpPanel()
            // a thread about a citation is titled by the citation's words, as the browser titles a chip's thread: what
            // names its subject in the panel and on home (anchorName)
            const title = p.target?.kind === 'citation' && p.about ? p.about : ''
            const got = await startThread(cx, p.anchor ?? null, p.anchorText ?? '', q, { ...(p.parent ? { parent: p.parent } : {}), ...(p.element ? { element: p.element } : {}), ...(title ? { title } : {}) })
            asking = 'error' in got ? `× ${got.error}` : ''
            if ('id' in got) await openThread(cx, got.id, q)
            else await cx.bumpPanel()
          })()
        }}
      />
    </Box>
  )
  // the header's rule stands alone when nothing comes between it and the field: no second rule right under it
  const between = body.length > headerEls(els, { title: 'New thread', cols, sub: subLine(['x']) }).length
  body.push(...bottomRows(cx, e, cols, [], [field], ['Enter to ask'], between))
  return <Box flexDirection="column">{body}</Box>
}

// ------------------------------------------------------------------------------------------------ threads

/** A thread as the tree and the panel read it: its chat when read, else its row's question. */
async function threadOfRow(cx: Ctx, id: string): Promise<ChatThread | null> {
  const row = (await cx.threads()).find(t => t.id === id)
  const tt: TermThread | undefined = await cx.thread(id)
  if (tt && tt.events.length) return { ...threadOf(tt.meta, tt.events), ...(row?.parent && row.parent !== 'main' ? { parent: row.parent } : {}) }
  if (!row) return null
  return { id, label: row.anchorText || row.title, ref: row.anchor, context: '', agentId: '', engine: '', turns: [{ q: row.question || row.title, a: '', state: row.running ? 'running' : 'done', tools: 0, partial: '' }], file: '', parent: row.parent === 'main' ? '' : row.parent, at: Date.parse(row.at) || 0 }
}

/** A thread title as thimble makes one from the anchor's words when none is given (agents._title_from): its first four
 *  words, lower case, joined by '-'. */
function slugOf(text: string): string {
  return (text.slice(0, 80).match(/[A-Za-z0-9]+/g) ?? []).slice(0, 4).join('-').toLowerCase()
}

type AboutRow = { anchor: string; anchorText: string; title?: string }

/** What names the thing a thread was asked about, when it is a card or a citation: a card by its question, a citation by
 *  its words (the thread's title, which openAsk gives it) or else its place; '' for words on screen or a passage. The ask
 *  view, the thread and home name the subject the same way. */
export async function anchorName(cx: Ctx, row: AboutRow | undefined): Promise<string> {
  const a = (row?.anchor ?? '').split(',')[0]!
  if (!row || !a || /^report:/.test(a)) return ''
  if (/^(?:card|cell):[A-Za-z0-9_-]+$/.test(a)) {
    // the card by its question; one not read in this session by the words it showed when the thread was asked
    if (((await cx.card(a.replace(/^(?:card|cell):/, '')))?.data as CardData | null | undefined)?.question || !row.anchorText) return placeName(cx, a)
    return clip(plainCites(row.anchorText).replace(/\s+/g, ' ').trim(), 60)
  }
  const slug = slugOf(row.anchorText)
  const t = (row.title ?? '').trim()
  if (t && t !== slug && !t.startsWith(`${slug}-`)) return t
  return /^(?:card|cell):/.test(a) ? placeName(cx, a) : placeWords(a)
}

/** What a thread was asked about, in words: a card or a citation by its name (anchorName), else its passage's words. */
export async function aboutName(cx: Ctx, row: AboutRow | undefined): Promise<string> {
  if (!row) return ''
  const named = await anchorName(cx, row)
  if (named) return named
  if (row.anchorText) return clip(plainCites(row.anchorText).replace(/\s+/g, ' ').trim(), 60)
  if (/^report:/.test(row.anchor)) return `the report's passage`
  return ''
}

/** The first line of a thread's latest answer, or what it is doing. */
function threadLine(t: ChatThread): Seg {
  const last = t.turns.at(-1)
  if (!last) return dim('nothing asked yet')
  if (last.state === 'running') return dim(`◌ ${plural(last.tools, 'tool call')}`)
  if (last.state === 'error') return /^\s*stopped/.test(last.a) ? dim('stopped') : { s: `× ${plainCites(last.a).split('\n')[0] ?? ''}`, fg: COLORS.problem }
  const done = [...t.turns].reverse().find(x => x.state === 'done' && x.a.trim())
  const first = plainCites(done?.a ?? '').replace(/^#+\s*/gm, '').split('\n').find(l => l.trim()) ?? ''
  return dim(first.replace(/\*\*|__|`/g, '').trim() || 'answered')
}

/** The threads panel (SPEC.md, section 7, "The threads panel"): its title and a dim subtitle; under the rule the
 *  tree, a root per place a thread was asked from (`main`, or `report "…"`) with a blank row between them, each thread
 *  under the thread it was asked from, its question in quotation marks with guides, the first line of its latest
 *  answer dim under it, `N questions` dim and `new` in green at R; the selected thread (`❯`, accent) under the second
 *  rule: what it is about, its questions and answers drawn as main's chat draws a reply, `stop` (s) while it answers,
 *  then the `ask` field. ↑↓ or j k choose, Enter or a give the field the keys, 1-9 open the first nine. */
async function drawThreads(cx: Ctx, e: PaneEvent, selected = ''): Promise<RenderElement> {
  if (e.surface === 'mobile') return none(cx, e, 'Threads need a surface with text fields.')
  const els = cx.els(e) as El
  const { Box, Text, Input, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const rows = (await cx.threads()) ?? []
  // the threads listed, and the one selected though the list does not hold it yet (one just asked)
  const ids = [...rows.map(r => r.id), ...(selected && !rows.some(r => r.id === selected) ? [selected] : [])]
  const threads = (await Promise.all(ids.map(id => threadOfRow(cx, id)))).filter((t): t is ChatThread => t !== null)
  const unreadOf = (id: string) => rows.find(r => r.id === id)?.unread ?? 0
  const fresh = rows.filter(t => t.unread).length
  const body: RenderElement[] = [...headerEls(els, { title: 'Threads', cols, sub: subLine([plural(threads.length, 'thread'), fresh ? freshSeg(fresh) : null]) })]
  // a root per place: the threads asked from a document under it, the rest under main
  const byId = new Map(threads.map(t => [t.id, t]))
  const rootOf = (t: ChatThread): ChatThread => {
    const seen = new Set<string>()
    let cur = t
    while (cur.parent && byId.has(cur.parent) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.parent)!
    }
    return cur
  }
  const placeOf = (t: ChatThread) => {
    const el = rows.find(r => r.id === rootOf(t).id)?.element ?? ''
    return /^report:/.test(el) ? el.split('#')[0]! : 'main'
  }
  const docs = await surfaceValue(cx, 'docs')
  const docTitle = (slug: string) => (docs?.ok ? docsOf(docs.value).find(d => d.slug === slug)?.title : '') || slug
  const places = [...new Set(threads.map(placeOf))].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
  const lines: Line[] = []
  const hits: LineHit[] = []
  const order: ChatThread[] = []
  const cap = selected ? 12 : 50
  let drawn = 0
  let more = 0
  for (const [pi, place] of places.entries()) {
    const tree = threadTree(threads.filter(t => placeOf(t) === place))
    if (!tree.length) continue
    if (pi > 0) lines.push([])
    lines.push(pointed([{ s: place === 'main' ? 'main' : `report "${clip(docTitle(place.slice(7)), 60)}"` }], false))
    for (const r of tree) {
      if (drawn >= cap) {
        more++
        continue
      }
      drawn++
      const n = unreadOf(r.t.id)
      const asked = r.t.turns.length
      const guide = r.guide.replace(/(.)../g, (_m, ch: string) => `${ch} `)
      const lead = r.under.replace(/(.)../g, (_m, ch: string) => `${ch} `)
      const right: Line = [...(asked > 1 ? [dim(`${asked} questions`)] : []), ...(n ? [...(asked > 1 ? [{ s: '  ' }] : []), freshSeg()] : [])]
      const y = lines.length
      lines.push(pointed(spread([{ s: guide, fg: COLORS.rule }, { s: threadTitle(r.t) }], right, cols), r.t.id === selected))
      const second = threadLine(r.t)
      lines.push(pointed([{ s: lead.slice(0, guide.length), fg: COLORS.rule }, { ...second, s: cut(second.s, Math.max(10, cols - guide.length)) }], false))
      const open = () => openThread(cx, r.t.id)
      hits.push({ y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: open }, { y: y + 1, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: open })
      order.push(r.t)
    }
  }
  if (!threads.length) lines.push(pointed([{ s: '  ' }, dim('none')], false))
  if (more) {
    const words = `… ${num(more)} more`
    hits.push({ y: lines.length, x0: MARGIN_W + 2, x1: MARGIN_W + 2 + words.length, row: false, run: () => openPanel(cx, { view: 'threads', title: 'Threads' }) })
    lines.push(pointed([{ s: '  ' }, dim(words)], false))
  }
  const t = selected ? threads.find(x => x.id === selected) : undefined
  const running = t?.turns.at(-1)?.state === 'running'
  const askKey = t ? `ask-${cid(t.id)}` : ''
  const focusAsk = () => (askKey ? cx.focus(askKey) : undefined)
  const step = async (d: number) => {
    if (!order.length) return
    const at = order.findIndex(x => x.id === selected)
    await openThread(cx, order[Math.max(0, Math.min(order.length - 1, at < 0 ? (d > 0 ? 0 : order.length - 1) : at + d))]!.id)
  }
  body.push(linesEl(cx, e, marginKey('threads-tree'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : k === 'return' || k === 'enter' ? focusAsk() : undefined)))
  // each thread a press away by its key too, for a surface that draws no Client: no row of its own
  body.unshift(
    <Box key="thread-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {order.map(x => (
        <Button key={`thread-open-${x.id}`} label={threadTitle(x)} plain onPress={() => void openThread(cx, x.id)} />
      ))}
    </Box>,
  )
  const keys: Key[] = order.slice(0, 9).map((x, i) => ({ key: `t${i}`, hotkey: String(i + 1), onPress: () => void openThread(cx, x.id) }))
  const stop = t && running && rt.sc ? () => void act(cx, rt.sc!, 'stop', { agent: t.id }).then(r => (!r.ok ? cx.toast(`thimble: the thread was not stopped: ${r.error}`) : undefined)) : null
  if (t) {
    body.push(ruleEl(els, cols, 'rule-thread'))
    // what it is about, dim, before its first question
    const about = await aboutName(cx, rows.find(r => r.id === t.id))
    if (about) body.push(<Text key="thread-about" dimColor wrap="truncate-end">{`about ${about}`}</Text>)
    let k = 0
    for (const turn of t.turns) {
      k++
      if (k > 1) body.push(<Text key={`thread-gap-${k}`}> </Text>)
      body.push(<Text key={`thread-q-${k}`} wrap="wrap">{`"${plainCites(turn.q)}"`}</Text>)
      if (turn.state === 'running') {
        const partial = turn.partial.trim()
        body.push(<Text key={`thread-run-${k}`} dimColor wrap="truncate-end">{`◌ ${plural(turn.tools, 'tool call')}${partial ? ` · ${clip(partial, cols - 30)}` : ''}`}</Text>)
      } else if (turn.state === 'error') body.push(<Text key={`thread-err-${k}`} color={COLORS.problem} wrap="wrap">{`× ${turn.a}`}</Text>)
      else if (turn.a.trim()) body.push(<Box key={marginKey(`thread-answer-${k}`)} flexDirection="column">{await drawReply(cx, e, turn.a, cols, { margin: PANEL_MARGIN, prefix: `t${k}-`, ask: tgt => void openAsk(cx, tgt), open: id => void openThread(cx, id) })}</Box>)
      // the cards the turn made, under its answer, each in its frame, as main's chat draws a turn's cards
      for (const [ci, id] of (turn.cards ?? []).entries()) body.push(<Box key={`thread-card-${k}-${ci}`} flexDirection="column">{await cardBlock(cx, e, id, cols, `th${k}-${ci}`, { order: ci + 1 })}</Box>)
    }
    if (stop) {
      body.push(controlsEl(els, [<Button key="thread-stop" label="stop" plain onPress={stop} />], 'thread-controls')!)
      keys.push({ key: 'stop', hotkey: 's', onPress: stop })
    }
    // the field for the next question, a blank row under the answer, its placeholder saying what it takes
    body.push(
      <Box key="ask-row" flexDirection="row" marginTop={1}>
        <Input
          key={askKey}
          placeholder="ask a follow-up question"
          submitLabel="ask"
          onSubmit={v => {
            const q = v.trim()
            if (!q) return
            // a question asked while the thread answers waits until its answer ends: thimble queues it
            void threadMessage(cx, t.id, q).then(r => {
              if (r.error) cx.toast(`thimble: ${r.error}`)
              else if (r.queued || running) cx.toast('thimble: the side thread is still answering: your question waits until it ends')
            })
          }}
        />
      </Box>,
    )
    keys.push({ key: 'ask', hotkey: 'a', onPress: () => void focusAsk() })
  }
  body.push(hintsRow(els, ['↑↓ to choose', ...(t ? ['Enter or a to ask'] : []), ...(stop ? ['s to stop'] : [])], cols))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// ------------------------------------------------------------------------------------------------ labels

/** A label as `thimble state label` prints it: the concept with its definition, its colours, its examples and rows. */
type LabelFull = ThimbleLabel

/** What a label's unit is called, many of them. */
function unitWords(unit: string | undefined): string {
  return unit === 'agent' ? 'files' : unit === 'run' ? 'run folders' : unit === 'cell' ? 'cards' : unit === 'span' ? 'sentences' : 'records'
}

/** A label's definition as its panel edits it: a prompt label's prompt, else its pattern or code. */
function definitionOf(l: LabelFull): string {
  return l.kind === 'prompt' ? str(l.spec).trim() || str(l.description).trim() : str(l.spec).trim()
}

/** The cards that use a label: its own label card and every card that read it, from the canvas as last read. */
async function cardsUsing(cx: Ctx, id: string): Promise<{ id: string; question: string }[]> {
  const canvas = await surfaceValue<Obj>(cx, 'canvas')
  const cells = canvas?.ok && Array.isArray(canvas.value.cells) ? (canvas.value.cells as unknown[]).filter(isObj) : []
  return cells
    .filter(c => (Array.isArray(c.labels) && (c.labels as unknown[]).map(String).includes(id)) || (isObj(c.payload) && str(c.payload.concept) === id))
    .map(c => ({ id: str(c.id), question: str(c.title) || 'a card' }))
}

// the text typed in a label's fields and not saved yet, by `<label>:<field>` (the run controls save it first)
const drafts = new Map<string, string>()

/** What the label panel holds unsaved for a label: the kind picked, the words typed in its fields. */
async function pendingEdits(cx: Ctx, l: LabelFull): Promise<LabelPatch> {
  const kind = (await cx.labelUi()).kind[l.id] ?? l.kind ?? 'prompt'
  const patch: LabelPatch = {}
  const body = drafts.get(`${l.id}:body`)?.trim()
  const glob = drafts.get(`${l.id}:glob`)?.trim()
  if (kind !== l.kind) patch.kind = kind
  if (body && (body !== definitionOf(l) || patch.kind)) patch.body = body
  if (glob && glob !== (l.glob ?? '')) patch.glob = glob
  return patch
}

/** Save the label panel's edits of label `id` with `extra` over them (`thimble act label`): true when saved, or when
 *  nothing waited. A kind picked is saved only with its definition. */
async function saveLabelEdits(cx: Ctx, id: string, extra: LabelPatch = {}): Promise<boolean> {
  const got = await surfaceValue(cx, `label:${id}`)
  const l = got?.ok ? (labelOf(got.value) as LabelFull | null) : null
  if (!l) return false
  const patch = { ...(await pendingEdits(cx, l)), ...extra }
  if (patch.kind && !patch.body) {
    const ui = await cx.labelUi()
    await cx.setLabelUi({ ...ui, said: { ...ui.said, [id]: `× give the ${patch.kind === 'regex' ? 'pattern' : patch.kind} before it is saved` } })
    await cx.bumpPanel()
    return false
  }
  if (!Object.keys(patch).length) return true
  const err = await saveLabel(cx, id, patch)
  if (!err) for (const k of ['body', 'glob']) drafts.delete(`${id}:${k}`)
  return !err
}

/** A post of field.tsx: the words typed in a field (a draft), or a save (Enter). */
export async function fieldMessage(cx: Ctx, name: string, text: string, save: boolean): Promise<void> {
  const m = /^label-body:(.+)$/.exec(name)
  if (!m) return
  drafts.set(`${m[1]}:body`, text)
  if (save && text.trim()) await saveLabelEdits(cx, m[1]!, { body: text.trim() })
}

/** The label panel, after the browser's label editor (SPEC.md, section 7, "The label panel"): its header block,
 *  the label's name in the accent and bold after a ● in its colour, its type (prompt, regex or code: the one in use on
 *  the selection background) and its scope (the files, editable, and how many records), then the rule; the prompt (or
 *  pattern or code) in a field to edit, Enter saving it (`thimble act label`); `run on a sample` and `run on all N`,
 *  which save what was typed first and run it (`thimble act label-run`); then `▸ counts`, `▸ examples` and `▸ cards`,
 *  folded. Nothing else shows until it is opened. */
async function drawLabel(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button, Input } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, `label:${p.label ?? ''}`)
  if (!got) return none(cx, e, '◌ reading the label')
  if (!got.ok) return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text></Box>
  const l = labelOf(got.value) as LabelFull | null
  if (!l) return none(cx, e)
  const id = l.id
  const name = l.name ?? id
  const ui = await cx.labelUi()
  const running = ui.runs[id]
  const said = ui.said[id] ?? ''
  const counts = l.label_stats?.counts ?? {}
  const values = [...(l.labels ?? []), ...Object.keys(counts).filter(k => !(l.labels ?? []).includes(k))]
  const kind = ui.kind[id] ?? l.kind ?? 'prompt'
  const files = !l.unit || ['record', 'agent', 'run'].includes(l.unit)
  const last = l.last_run ?? l.applications?.at(-1) ?? null
  const scopeN = typeof last?.matched_total === 'number' ? last.matched_total : typeof last?.total === 'number' && !l.trial ? last.total : null
  const sample = l.trial && last?.limit ? last.limit : 30
  const unit = unitWords(l.unit)
  const opened = (part: string) => ui.open.includes(`${id}:${part}`)
  const flip = (part: string) => async () => {
    const cur = await cx.labelUi()
    const k = `${id}:${part}`
    await cx.setLabelUi({ ...cur, open: cur.open.includes(k) ? cur.open.filter(x => x !== k) : [...cur.open, k] })
    await cx.bumpPanel()
  }
  // the edits typed and not saved, and the kind picked: what a save or a run stores first
  const save = (extra: LabelPatch = {}) => saveLabelEdits(cx, id, extra)
  const run = (limit: number) => async () => {
    if (running) return
    if (await save()) await runLabel(cx, id, name, limit)
  }
  const rows: RenderElement[] = []
  const keys: Key[] = []
  // the header block: name, type, scope, each on the label column, as Matt wrote them (`name:`), then the definition
  const L = 'pattern:'.length + 2
  const fieldLine = (label: string, el: RenderElement) => (
    <Box key={`lf-${label}`} flexDirection="row">
      <Box width={L} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {el}
      </Box>
    </Box>
  )
  rows.push(fieldLine('name:', lineEl(els, [{ s: '●', fg: labelHue(values) }, { s: ' ' }, { s: name, fg: ACCENT, b: true }], undefined, true)))
  rows.push(
    fieldLine(
      'type:',
      <Box flexDirection="row" columnGap={2}>
        {(['prompt', 'regex', 'code'] as const).map(k =>
          running ? (
            // while a run goes, the type is plain text, as the fields are
            <Text key={`lk-${k}`} {...(k === kind ? { backgroundColor: COLORS.selected } : { dimColor: true })}>{k}</Text>
          ) : k === kind ? (
            <Text key={`lk-${k}`} backgroundColor={COLORS.selected}>{k}</Text>
          ) : (
            <Button
              key={`lk-${k}`}
              label={k}
              plain
              onPress={() =>
                void (async () => {
                  const cur = await cx.labelUi()
                  const next = { ...cur.kind }
                  if (k === l.kind) delete next[id]
                  else next[id] = k
                  await cx.setLabelUi({ ...cur, kind: next })
                  await cx.bumpPanel()
                })()
              }
            />
          ),
        )}
      </Box>,
    ),
  )
  const scopeCount = scopeN !== null ? `${num(scopeN)} ${unit}` : ''
  rows.push(
    fieldLine(
      'scope:',
      files && !running && e.surface !== 'mobile' ? (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Input key={`lb-glob-${id}`} value={drafts.get(`${id}:glob`) ?? l.glob ?? ''} submitLabel="save" onInput={v => void drafts.set(`${id}:glob`, v)} onSubmit={v => void (v.trim() ? save({ glob: v.trim() }) : undefined)} />
          </Box>
          {scopeCount ? <Text dimColor>{`  ${scopeCount}`}</Text> : null}
        </Box>
      ) : (
        <Text wrap="wrap">
          <Text>{files ? l.glob ?? '' : l.unit === 'cell' ? "the canvas's cards" : "the report's sentences"}</Text>
          {scopeCount ? <Text dimColor>{` · ${scopeCount}`}</Text> : null}
        </Text>
      ),
    ),
  )
  rows.push(ruleEl(els, cols, 'lb-rule'))
  // the definition, whole, in a field to edit (field.tsx, in a border as the search box is): a click gives it the
  // keyboard, Enter saves it (in code, ctrl+s)
  const defName = kind === 'prompt' ? 'prompt' : kind === 'regex' ? 'pattern' : 'code'
  const shownDef = kind === l.kind ? definitionOf(l) : ''
  // the definition starts on L like the rows above it
  const defW = Math.max(10, cols - L - 4)
  if (running || (e.surface !== 'terminal' && e.surface !== 'desktop')) rows.push(fieldLine(`${defName}:`, kind === 'code' ? <Box key="lb-def">{codeRows(cx, e, shownDef, 30)}</Box> : <Text key="lb-def" wrap="wrap">{shownDef}</Text>))
  else {
    const { Client } = cx.els(e)
    rows.push(
      fieldLine(
        `${defName}:`,
        <Box key="lb-def" flexDirection="column" borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
          <Client key={`lb-def-${id}-${kind}`} module="./field.tsx" width={defW} props={JSON.parse(JSON.stringify({ name: `label-body:${id}`, text: shownDef, cols: defW, placeholder: `the ${defName}: click to write it`, multiline: kind === 'code' }))} />
        </Box>,
      ),
    )
  }
  // run it: on a sample, or on every record; they save what was typed first
  const lastWords = last ? (l.trial || last.limit ? `last run on a sample of ${num(last.labeled ?? 0)}` : `last run on all ${num(last.labeled ?? 0)}`) : 'not run yet'
  const stop = () => void stopLabel(cx, id)
  if (running)
    rows.push(
      <Box key="lb-running" flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text>{`◌ labeling ${running.limit ? `a sample of ${num(running.limit)}` : `all ${scopeN !== null ? num(scopeN) : ''} ${unit}`.replace(/\s+/g, ' ')}`}</Text>
        <Button key="lb-stop" label="stop" plain onPress={stop} />
      </Box>,
    )
  else
    rows.push(
      <Box key="lb-runs" flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="lb-sample" label="run on a sample" plain onPress={() => void run(sample)()} />
        <Button key="lb-all" label={scopeN !== null ? `run on all ${num(scopeN)}` : 'run on all'} plain onPress={() => void run(0)()} />
        <Text dimColor>{lastWords}</Text>
      </Box>,
    )
  // what the last save or run said: `×` and `!` rows in red
  said.split('\n').filter(Boolean).forEach((line, i) => rows.push(<Text key={`lb-said-${i}`} wrap="wrap" {...(/^[×!]/.test(line) ? { color: COLORS.problem } : { dimColor: true })}>{line}</Text>))
  if (!running) keys.push({ key: 'sample', hotkey: 'r', onPress: () => void run(sample)() })
  else keys.push({ key: 'stop', hotkey: 's', onPress: stop })
  // the counts, the examples and the cards, folded
  const toggle = (part: string, words: string, n: number | null) => (
    <Box key={`lb-t-${part}`} flexDirection="row">
      <Button key={`lb-open-${part}`} label={`${opened(part) ? '▾' : '▸'} ${words}`} plain onPress={() => void flip(part)()} />
      {n !== null ? <Text dimColor>{`  ${num(n)}`}</Text> : null}
    </Box>
  )
  const total = values.reduce((a, v) => a + (counts[v] ?? 0), 0)
  rows.push(<Text key="lb-gap"> </Text>)
  rows.push(toggle('counts', 'counts', total))
  keys.push({ key: 'counts', hotkey: 'c', onPress: () => void flip('counts')() })
  if (opened('counts')) {
    const vw = Math.min(Math.max(12, Math.floor(cols / 3)), Math.max(4, ...values.map(v => width(v))))
    const cs = values.map(v => num(counts[v] ?? 0))
    const cw = Math.max(1, ...cs.map(c => c.length))
    const barW = Math.max(8, cols - 2 - 2 - vw - 2 - 2 - cw - 7)
    values.forEach((v, i) => {
      const n = counts[v] ?? 0
      const w = total ? Math.round((barW * n) / total) : 0
      const colour = valueColour(values, v)
      const tone = colour && colour !== COLORS.dim ? { color: colour } : { dimColor: true }
      rows.push(
        <Text key={`lb-c-${v}`} wrap="truncate-end">
          <Text>{'  '}</Text>
          <Text {...tone}>{'● '}</Text>
          <Text>{`${clip(v, vw).padEnd(vw)}  `}</Text>
          <Text {...tone}>{'█'.repeat(w)}</Text>
          <Text color={COLORS.rule}>{'─'.repeat(Math.max(0, barW - w))}</Text>
          <Text>{`  ${cs[i]!.padStart(cw)}`}</Text>
          <Text dimColor>{total ? `  ${share(n, total).padStart(5)}` : ''}</Text>
        </Text>,
      )
    })
    if (!values.length) rows.push(<Text key="lb-c-none" dimColor>{'  none'}</Text>)
    // its values, editable here: Enter saves them
    if (!running && e.surface !== 'mobile')
      rows.push(
        <Box key="lb-values" flexDirection="row" marginLeft={2}>
          <Text dimColor>{'values  '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Input
              key={`lb-values-${id}`}
              value={values.join(' · ')}
              submitLabel="save"
              onSubmit={v => {
                const vs = [...new Set(v.split(/\s*[·,]\s*/).map(x => x.trim()).filter(Boolean))]
                if (vs.length >= 2) void save({ values: vs })
              }}
            />
          </Box>
        </Box>,
      )
  }
  // the examples: the records the label gave each value, with the analyst's agree or another value
  const recs = (l.rows ?? []).filter(r => r.ref)
  // a blank row between an opened part and the next toggle
  if (opened('counts')) rows.push(<Text key="lb-gap-examples"> </Text>)
  rows.push(toggle('examples', 'examples', recs.length))
  keys.push({ key: 'examples', hotkey: 'e', onPress: () => void flip('examples')() })
  // a record's words: a JSON record as the field the rule reads first, its value in quotation marks and italic, then
  // its other fields on one dim row, never its JSON inside quotation marks; other words in quotation marks, up to three
  // rows
  const room = Math.max(120, (cols - 4) * 3 - 2)
  const recordRows = (ref: string, raw: string, match: string): RenderElement | null => {
    const text = demojibake(raw)
    if (!text.trim()) return null
    const f = recordFields(text, { kind: l.kind ?? '', spec: definitionOf(l), ...(match ? { match } : {}) })
    if (!f) return <Text italic wrap="wrap">{`"${clip(text.replace(/\s+/g, ' ').trim(), room)}"`}</Text>
    return (
      <Box flexDirection="column">
        {fieldEls(els, f.read.map(([k, v]): [string, RenderElement] => [k, <Text italic wrap="wrap">{`"${clip(v.replace(/\s+/g, ' ').trim(), room - k.length - 2)}"`}</Text>]), `lx-f-${cid(ref)}`)}
        {f.rest.length ? <Text dimColor wrap="truncate-end">{f.rest.map(([k, v]) => `${k} ${clip(v, 48)}`).join(' · ')}</Text> : null}
      </Box>
    )
  }
  if (opened('examples')) {
    for (const v of values) {
      const xs = recs.filter(r => (typeof r.analyst === 'string' && r.analyst ? r.analyst : str(r.label)) === v)
      if (!xs.length) continue
      rows.push(
        <Text key={`lb-h-${v}`} wrap="truncate-end">
          <Text>{'  '}</Text>
          <Text color={valueColour(values, v)}>{'● '}</Text>
          <Text>{v}</Text>
          <Text dimColor>{`  ${num(xs.length)}`}</Text>
        </Text>,
      )
      for (const x of xs) {
        const ref = x.ref!
        const place = placeWords(ref)
        const set = Boolean(x.analyst)
        const others = values.filter(o => o !== v)
        // each value a button as wide as the longest value, so `agree  it is  …` stands in one place for every value
        const vw = Math.max(1, ...values.map(o => width(clip(o, 24))))
        const verdict = (value: string) => async () => {
          if (!rt.sc) return
          const r = await act(cx, rt.sc, 'verdict', { label: id, ref, value })
          if (!r.ok) cx.toast(`thimble: the verdict was not kept: ${r.error}`)
          await readSurface(cx, `label:${id}`, 'label', [id])
          await cx.bumpPanel()
        }
        rows.push(
          <Box key={`lb-x-${ref}`} flexDirection="column" marginLeft={4}>
            <Box flexDirection="row" columnGap={2}>
              <Box flexShrink={1}>{linesEl(cx, e, `lx-${cid(ref)}`, [[{ s: '↗', fg: LINK }, { s: ' ' }, linkSeg(cut(place, Math.max(8, cols - 30)))]], [{ y: 0, x0: 0, x1: 2 + width(cut(place, Math.max(8, cols - 30))), row: false, run: () => openCite(cx, ref, null) }], Math.min(cols - 4, 2 + width(cut(place, Math.max(8, cols - 30)))))}</Box>
              <Box flexGrow={1} />
              {set ? <Text dimColor>{str(x.label) && str(x.label) !== v ? '✓ set by you' : '✓ agreed'}</Text> : null}
              {set ? null : <Button key={`lb-agree-${ref}`} label="agree" plain onPress={() => void verdict(v)()} />}
              {set ? null : (
                <Box flexDirection="row" columnGap={2} flexWrap="wrap">
                  <Text dimColor>it is</Text>
                  {others.map(o => (
                    <Button key={`lb-set-${ref}-${o}`} label={clip(o, 24).padEnd(vw)} plain onPress={() => void verdict(o)()} />
                  ))}
                </Box>
              )}
            </Box>
            {recordRows(x.ref!, str(x.text), str(x.match))}
            {x.rationale ? <Text dimColor wrap="wrap">{`why  ${clip(str(x.rationale), cols * 2)}`}</Text> : null}
          </Box>,
        )
      }
    }
    if (!recs.length) rows.push(<Text key="lb-x-none" dimColor>{'  none'}</Text>)
  }
  // the cards that use it, each a click away
  const cards = await cardsUsing(cx, id)
  if (opened('examples')) rows.push(<Text key="lb-gap-cards"> </Text>)
  rows.push(toggle('cards', 'cards', cards.length))
  keys.push({ key: 'cards', hotkey: 'd', onPress: () => void flip('cards')() })
  if (opened('cards')) {
    for (const c of cards.slice(0, 8)) rows.push(<Box key={`lb-card-${c.id}`} flexDirection="row" marginLeft={2}><Button key={`lb-card-open-${c.id}`} label={`${clip(c.question, Math.max(20, cols - 6))} ›`} plain onPress={() => void openCard(cx, c.id)} /></Box>)
    if (cards.length > 8) rows.push(<Text key="lb-cards-more" dimColor>{`  … ${num(cards.length - 8)} more`}</Text>)
    if (!cards.length) rows.push(<Text key="lb-cards-none" dimColor>{'  none'}</Text>)
  }
  keys.push({ key: 'list', hotkey: 'l', onPress: () => void openPanel(cx, { view: 'labels', title: 'Labels' }) })
  // the keys that fit one row: the field says how to save it (its placeholder), the folded parts open with c, e, d
  rows.push(hintsRow(els, [running ? 's to stop' : 'r to run on a sample', 'c, e or d to open', 'l for all labels'], cols))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...rows]}</Box>
}

// the labels list's chosen row
let labelPick = ''

/** The labels (SPEC.md, "The label panel", the labels list): one row per label, its kind and last run dim at R,
 *  `❯` on the chosen one; under the second rule `describe a new label`, whose words go to main. */
async function drawLabels(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Button, Input } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'labels')
  const ls = (got?.ok ? labelsOf(got.value) : []) as LabelFull[]
  const body: RenderElement[] = [...headerEls(els, { title: 'Labels', cols, sub: subLine([plural(ls.length, 'label')]) })]
  const pick = ls.find(x => x.id === labelPick)?.id ?? ls[0]?.id ?? ''
  const { lines, hits } = listLines(
    ls.map(l => {
      const n = Object.values(l.label_stats?.counts ?? {}).reduce((a, b) => a + b, 0)
      const run = l.trial ? `a sample of ${num(n)}` : `all ${num(n)}`
      return { key: l.id, glyph: { s: (l.last_run?.status ?? '') === 'running' ? '◌' : '●' }, name: l.name ?? l.id, right: [dim(`${l.kind ?? ''} · ${run}`)], run: () => openLabel(cx, l.id, l.name ?? l.id) }
    }),
    pick,
    cols,
  )
  const step = (d: number) => {
    const at = ls.findIndex(x => x.id === pick)
    labelPick = ls[Math.max(0, Math.min(ls.length - 1, at + d))]?.id ?? ''
    return cx.bumpPanel()
  }
  body.push(linesEl(cx, e, marginKey('labels-list'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? openLabel(cx, pick, ls.find(x => x.id === pick)?.name ?? pick) : undefined)))
  body.unshift(
    <Box key="label-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {ls.map((l, i) => <Button key={`label-open-${i}`} label={l.name ?? l.id} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} onPress={() => void openLabel(cx, l.id, l.name ?? l.id)} />)}
    </Box>,
  )
  const field = e.surface === 'mobile' ? null : fieldRow(cx, e, 'describe a new label', <Input key="lbs-describe" submitLabel="make it" onSubmit={v => void (v.trim() ? cx.submit(`Make a label with apply_label and try it on a sample of 30: ${v.trim()}`) : undefined)} />, 'lbs-new')
  body.push(...bottomRows(cx, e, cols, [], [field], ['↑↓ to choose', 'Enter to open', 'b to go back', 'x to close']))
  return <Box flexDirection="column">{body}</Box>
}

// ------------------------------------------------------------------------------------------------ documents

// the documents list's chosen row
let docPick = ''

/** The documents (SPEC.md, section 7, "Documents"): one row per document, ◌ while its writer writes, ● written,
 *  its title, its kind dim at R; `❯` on the chosen row, ↑↓ or j k choose, Enter or a click opens it, 1-9 the first
 *  nine; at most 40. */
async function drawDocs(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'docs')
  const docs = (got?.ok ? docsOf(got.value) : []).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, 40)
  const body: RenderElement[] = [...headerEls(els, { title: 'Documents', cols, sub: subLine([plural(docs.length, 'document')]) })]
  const pick = docs.find(d => d.slug === docPick)?.slug ?? docs[0]?.slug ?? ''
  const open = (d: (typeof docs)[number]) => openDoc(cx, d.slug, d.title)
  const { lines, hits } = listLines(
    docs.map(d => ({ key: d.slug, glyph: { s: d.status === 'generating' ? '◌' : '●' }, name: d.title, right: [dim(d.status === 'generating' ? `${d.renderer} · writing` : d.renderer)], run: () => open(d) })),
    pick,
    cols,
  )
  const step = (k: number) => {
    const at = docs.findIndex(d => d.slug === pick)
    docPick = docs[Math.max(0, Math.min(docs.length - 1, at + k))]?.slug ?? ''
    return cx.bumpPanel()
  }
  body.push(linesEl(cx, e, marginKey('docs-list'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? open(docs.find(d => d.slug === pick)!) : undefined)))
  body.unshift(
    <Box key="doc-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {docs.map((d, i) => (
        <Button key={`doc-open-${i}`} label={d.title} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} onPress={() => void open(d)} />
      ))}
    </Box>,
  )
  body.push(hintsRow(els, docs.length ? ['↑↓ to choose', 'Enter to open'] : [], cols))
  return <Box flexDirection="column">{body}</Box>
}

/** What a document's writer is doing while it writes: its tool calls, its latest words, and the request it was given. */
async function writerState(cx: Ctx): Promise<{ tools: number; words: string; request: string } | null> {
  const a = ((await cx.agents()) ?? []).find(x => x.role === 'writer' && x.state === 'running')
  const tt = a?.chat ? await cx.thread(a.chat) : undefined
  if (!a) return null
  let tools = 0
  let words = ''
  let request = ''
  for (const ev of tt?.events ?? []) {
    if (ev.type === 'user' && !request) request = str(ev.text)
    if (ev.type === 'tool_use') {
      tools++
      words = ''
    } else if (ev.type === 'text') words += str(ev.delta ?? ev.text)
  }
  return { tools, words: words.replace(/\s+/g, ' ').trim(), request: request || str(tt?.meta.title) }
}

/** A document's unit as Markdown: its heading, its paragraphs (a slide's sentences as a list), each figure where it
 *  stands, its caption italic under it. */
function unitMarkdown(s: DocSection): string {
  const figs = s.figures ?? []
  const placed = new Set<number>()
  // a section with no heading (a report's opening summary) starts with its words: no empty heading line
  const head = plainCites(str(s.heading)).trim() ? `## ${str(s.heading)}` : ''
  const md: string[] = head ? [head] : []
  const figure = (k: number) => {
    const f = figs[k]!
    placed.add(k)
    const cell = str(f.cell).replace(/^(?:card|cell):/, '')
    if (cell) md.push(...(md.length ? [''] : []), `[[card:${cell}]]`, ...(f.caption ? [`*${str(f.caption).replace(/\*/g, '')}*`] : []))
  }
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
    if (words.trim()) md.push(...(md.length ? [''] : []), words)
    figs.forEach((f, k) => (f.after_paragraph === para.id && !placed.has(k) ? figure(k) : undefined))
  }
  figs.forEach((_f, k) => (!placed.has(k) ? figure(k) : undefined))
  return md.join('\n')
}

/** The mark each figure of a story's beat lights: the rows, events or nodes its step names (story.step_of). */
function stepFocus(s: DocSection): Record<string, Focus> {
  const out: Record<string, Focus> = {}
  for (const f of (s.figures ?? []) as (DocFigure & { highlight?: unknown })[]) {
    const first = Array.isArray(f.highlight) ? str(f.highlight[0]) : ''
    const cell = str(f.cell).replace(/^(?:card|cell):/, '')
    if (cell && first) out[cell] = { row: first, event: first, node: first }
  }
  return out
}

/** One document (SPEC.md, section 7, "A document"): the title in the accent and bold, wrapped; while its writer
 *  writes, `◌ writing · N tool calls · <its latest words>` (and the request until anything is written). A report:
 *  `Contents` from three headings, each a click (or 1-9) away; each section drawn as main's chat draws a reply. A deck
 *  or a story steps one slide or beat at a time: `‹ 3 of 9 ›`, `previous  next` (p, n), a deck's `notes` (o), a
 *  story's `read as a page` (a), its figure lit at the beat's step. At the bottom `all documents ›` (l) and the retell
 *  controls, `as slides` (s) and `as a story` (y), which ask main to write it again in that form. A passage's "?" asks a
 *  side thread told the document, its section and the passage. */
async function drawDoc(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue<Obj>(cx, `doc:${p.slug ?? ''}`)
  const listed = await surfaceValue(cx, 'docs')
  const entry = listed?.ok ? docsOf(listed.value).find(d => d.slug === p.slug) : undefined
  const writing = entry?.status === 'generating' ? await writerState(cx) : null
  if (!got && !writing) return none(cx, e, '◌ reading the document')
  if (got && !got.ok && !writing) return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text></Box>
  const doc = got?.ok ? got.value : {}
  const title = str(doc.title) || entry?.title || p.title
  const slug = p.slug ?? ''
  const form = str(doc.renderer) || str(doc.type) || entry?.renderer || 'document'
  const { units } = docUnits(doc)
  const sub = writing ? subLine([`◌ writing · ${plural(writing.tools, 'tool call')}${writing.words ? ` · ${clip(writing.words, Math.max(20, cols - 30))}` : ''}`]) : undefined
  const body: RenderElement[] = [...headerEls(els, { title, cols, ...(sub ? { sub } : {}) })]
  if (writing && !units.length && writing.request) body.push(<Text key="doc-request" dimColor wrap="wrap">{`the request: ${clip(writing.request, 600)}`}</Text>)
  const keys: Key[] = []
  const at = (k: number) => openPanel(cx, { ...p, start: k })
  // a passage's thread is told the document, its section and the passage
  const askIn = (u: DocSection) => (tgt: Target) =>
    void openAsk(cx, tgt, tgt.kind === 'sentence' ? { anchor: `report:${slug}${u.id ? `#${u.id}` : ''}`, anchorText: `"${title}" › ${plainCites(str(u.heading))}: ${plainCites(tgt.text ?? '')}`, element: `report:${slug}${u.id ? `#${u.id}` : ''}` } : { element: `report:${slug}${u.id ? `#${u.id}` : ''}` })
  const drawUnit = async (u: DocSection, i: number, focus?: Record<string, Focus>) => drawReply(cx, e, unitMarkdown(u), cols, { margin: PANEL_MARGIN, prefix: `d${i}-`, ask: askIn(u), open: id => void openThread(cx, id), in: 'report', ...(focus ? { focus } : {}) })
  const stepped = units.length > 0 && (form === 'slides' || (form === 'story' && p.mode !== 'page'))
  const controls: (RenderElement | null)[] = []
  const hints: string[] = []
  if (stepped) {
    const i = Math.max(0, Math.min(units.length - 1, p.start ?? 0))
    const u = units[i]!
    body.push(<Box key={marginKey(`doc-unit-${i}`)} flexDirection="column">{await drawUnit(u, i, form === 'story' ? stepFocus(u) : undefined)}</Box>)
    const notes = str((u as { notes?: unknown }).notes)
    if (form === 'slides' && notes && p.mode === 'notes') body.push(<Box key="doc-notes" flexDirection="column" marginTop={1}><Text bold>Notes</Text><Text wrap="wrap">{notes}</Text></Box>)
    // the page row: ‹ and › a click away, ← → once it has the keys
    const pageWords = `${i + 1} of ${units.length}`
    const pageLine: Line = [{ s: '‹', fg: i > 0 ? LINK : COLORS.dim }, { s: `  ${pageWords}  ` }, { s: '›', fg: i < units.length - 1 ? LINK : COLORS.dim }]
    const prev = () => (i > 0 ? at(i - 1) : undefined)
    const next = () => (i < units.length - 1 ? at(i + 1) : undefined)
    body.push(<Box key="doc-page" marginTop={1}>{linesEl(cx, e, 'doc-page', [pageLine], [{ y: 0, x0: 0, x1: 1, row: false, run: prev }, { y: 0, x0: width(pageWords) + 5, x1: width(pageWords) + 6, row: false, run: next }], cols, k => (k === 'left' || k === 'pageup' ? prev() : k === 'right' || k === 'pagedown' || k === 'space' || k === ' ' ? next() : undefined))}</Box>)
    controls.push(i > 0 ? <Button key="doc-prev" label="previous" plain onPress={() => void prev()} /> : null, i < units.length - 1 ? <Button key="doc-next" label="next" plain onPress={() => void next()} /> : null)
    keys.push({ key: 'prev', hotkey: 'p', onPress: () => void prev() }, { key: 'next', hotkey: 'n', onPress: () => void next() })
    hints.push('p n to step')
    if (form === 'slides' && units.some(x => str((x as { notes?: unknown }).notes))) {
      const flip = () => void openPanel(cx, { ...p, mode: p.mode === 'notes' ? '' : 'notes' })
      controls.push(<Button key="doc-notes-flip" label={p.mode === 'notes' ? 'hide notes' : 'notes'} plain onPress={flip} />)
      keys.push({ key: 'notes', hotkey: 'o', onPress: flip })
      hints.push('o for notes')
    }
    if (form === 'story') {
      const page = () => void openPanel(cx, { ...p, mode: 'page', start: 0 })
      controls.push(<Button key="doc-page-read" label="read as a page" plain onPress={page} />)
      keys.push({ key: 'page', hotkey: 'a', onPress: page })
      hints.push('a for the page')
    }
  } else {
    const from = Math.max(0, Math.min(units.length - 1, p.start ?? 0))
    // the contents from three headings: each heading a click away (and 1-9), drawing the document from there; a section
    // with no heading (an opening summary) is not listed
    const headed = units.map((u, i) => ({ u, i })).filter(x => plainCites(str(x.u.heading)).trim())
    if (headed.length >= 3) {
      body.push(<Text key="doc-contents" bold>Contents</Text>)
      const shown = headed.slice(0, 24)
      const w = String(shown.length).length
      const lines: Line[] = shown.map((x, k) => [dim(`${String(k + 1).padStart(w)}  `), { s: plainCites(str(x.u.heading)), ...(x.i === from && from > 0 ? { fg: ACCENT } : {}) }])
      body.push(linesEl(cx, e, 'doc-toc', lines, shown.map((x, k) => ({ y: k, x0: 0, x1: cols, row: true, run: () => at(x.i) })), cols))
      shown.slice(0, 9).forEach((x, k) => keys.push({ key: `sec${k}`, hotkey: String(k + 1), onPress: () => void at(x.i) }))
      hints.push('1-9 for a section')
    }
    for (const [i, u] of units.entries()) {
      if (i < from) continue
      // one blank row between sections, and between the contents and the first; none above a first section under the
      // header's rule
      const top = i === from && headed.length < 3 ? 0 : 1
      body.push(<Box key={marginKey(`doc-sec-${i}`)} flexDirection="column" marginTop={top}>{await drawUnit(u, i)}</Box>)
    }
  }
  // retell: main writes the document again in another form (thimble's writer)
  const retell = (to: 'slides' | 'story') => () => void cx.command('thimble:write', `${to} Retell the document "${title}" as ${to === 'slides' ? 'slides' : 'a story'}.`).catch(err => cx.toast(`thimble: could not start the writer: ${String(err).slice(0, 200)}`))
  if (units.length && !writing) {
    const letters: string[] = []
    if (form !== 'slides') {
      controls.push(<Button key="doc-as-slides" label="as slides" plain onPress={retell('slides')} />)
      keys.push({ key: 'slides', hotkey: 's', onPress: retell('slides') })
      letters.push('s')
    }
    if (form !== 'story') {
      controls.push(<Button key="doc-as-story" label="as a story" plain onPress={retell('story')} />)
      keys.push({ key: 'story', hotkey: 'y', onPress: retell('story') })
      letters.push('y')
    }
    hints.push(`${letters.join(' ')} to retell`)
  }
  const all = () => void openPanel(cx, { view: 'docs', title: 'Documents' })
  controls.push(<Button key="doc-all" label="all documents ›" plain onPress={all} />)
  keys.push({ key: 'all', hotkey: 'l', onPress: all })
  hints.push('l for all documents')
  body.push(...bottomRows(cx, e, cols, controls, [], hints))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// ------------------------------------------------------------------------------------------------ files

type FileEntry = { path: string; kind: string; size: number }

function filesOf(got: { ok: true; value: unknown } | { ok: false; error: string } | undefined): FileEntry[] {
  const list = got?.ok ? (Array.isArray(got.value) ? got.value : isObj(got.value) && Array.isArray(got.value.files) ? got.value.files : []) : []
  return (list as unknown[]).filter(isObj).map(f => ({ path: str(f.path), kind: str(f.kind), size: typeof f.size_bytes === 'number' ? f.size_bytes : typeof f.size === 'number' ? f.size : 0 }))
}

/** What the type column says of a file: thimble's kind for the kinds it reads in its own way (an agent's transcript, a
 *  board, events, a database, a prompt); for a file it knows only as text, what it opens as when that is not its lines
 *  (`transcript`, as its preview and its view say), else its format by its extension (`jsonl`, `md`); never the bare
 *  `text` that a transcript or a table of records would contradict. */
export function fileType(path: string, kind: string, opens = ''): string {
  if (kind && kind !== 'text') return kind
  if (opens) return opens
  const name = path.split('/').at(-1) ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 && name.length - dot <= 9 ? name.slice(dot + 1).toLowerCase() : 'text'
}

/** Paths in natural order (`run-2` before `run-10`), as home lists them. */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

function fmtSize(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`
}

/** The text of a file page's records, one per line as written. */
function pageLines(page: Obj): { n: number; text: string }[] {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const first = typeof page.start === 'number' ? page.start : 1
  return records.map((r, i) => ({
    n: typeof r.line === 'number' ? r.line : first + i,
    text: demojibake((Array.isArray(r.blocks) ? (r.blocks as Obj[]).map(b => str(b.text)).join(' ') : str(r.text ?? r.raw ?? (isObj(r.record) ? JSON.stringify(r.record) : r.record))).replace(/\s+/g, ' ').slice(0, 2000)),
  }))
}

/** The folders open in the file browser: the first unless folded, any other once unfolded. */
const FOLDER_FILES = 20

/** A short name cut in its middle to `n` cells, its extension kept (`revis…ns.jsonl`); a longer title at its end. */
function middleCut(name: string, n: number): string {
  if (width(name) <= n) return name
  if (name.split(/\s+/).length > 3 || n < 8) return cut(name, n)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
  const stem = ext ? name.slice(0, dot) : name
  const room = n - width(ext) - 1
  if (room < 4) return cut(name, n)
  const head = Math.ceil(room / 2)
  return `${stem.slice(0, head)}…${stem.slice(stem.length - (room - head))}${ext}`
}

/** The tab a file opens on, by its first page: Transcript when its head reads as a transcript surely (thimble's sniff,
 *  transcripts.STRONG), else Raw, its lines. */
function firstMode(page: Obj): 'transcript' | 'raw' {
  const hint = isObj(page.transcript) ? page.transcript : null
  return turnsOf(page) && typeof hint?.score === 'number' && hint.score >= 0.95 ? 'transcript' : 'raw'
}

/** What a file opens as, by its first page, as its view opens it (firstMode): its transcript or its lines; a binary
 *  file not at all. */
function opensAs(page: Obj | undefined): string {
  if (!page) return ''
  if (page.binary) return 'raw bytes: not shown'
  return firstMode(page) === 'transcript' ? 'transcript' : 'lines'
}

/** The file browser (SPEC.md, section 7, "The file browser"): a folder per group, which folds; an open folder
 *  shows its first 20 files (`… N more` shows them all), each with a dim `●`, its name cut in its middle; `❯` and the
 *  accent on the chosen file, whose name, what it opens as and its first lines show
 *  under the second rule; Enter or a second click opens it, Space folds its folder. */
async function drawFiles(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'files')
  if (!got) return none(cx, e, '◌ reading the files')
  if (!got.ok) return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text></Box>
  // each folder's files in natural order, as home lists them; the folder of the corpus's own files first
  const files = filesOf(got)
    .map(f => ({ ...f, kind: fileType(f.path, f.kind, rt.opens.get(f.path)?.as) }))
    .sort((a, b) => {
      const da = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/') + 1) : ''
      const db = b.path.includes('/') ? b.path.slice(0, b.path.lastIndexOf('/') + 1) : ''
      return da === db ? natural(a.path, b.path) : !da ? -1 : !db ? 1 : natural(da, db)
    })
  const ui = await cx.filesUi()
  const byDir = new Map<string, FileEntry[]>()
  for (const f of files) {
    const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
    byDir.set(d, [...(byDir.get(d) ?? []), f])
  }
  const root = `${(await cx.root().catch(() => '')).split('/').filter(Boolean).at(-1) ?? 'folder'}/`
  const kindW = Math.max(4, ...files.map(f => width(f.kind)))
  const sizeW = Math.max(4, ...files.map(f => fmtSize(f.size).length))
  const body: RenderElement[] = [...headerEls(els, { title: 'Files', cols, sub: subLine([plural(files.length, 'file')]) })]
  const lines: Line[] = []
  const hits: LineHit[] = []
  const order: string[] = []
  const dirOf = new Map<string, string>()
  const pick = ui.pick && files.some(f => f.path === ui.pick) ? ui.pick : ''
  const choose = (path: string) => async () => {
    const cur = await cx.filesUi()
    if (cur.pick === path) return openFile(cx, path)
    await cx.setFilesUi({ ...cur, pick: path })
    await readSurface(cx, `file:${path}:1`, 'files', [path])
    await cx.bumpPanel()
  }
  const right = (f: FileEntry): Line => [dim(f.kind.padEnd(kindW)), { s: '  ' }, dim(fmtSize(f.size).padStart(sizeW))]
  lines.push(pointed(spread([{ s: '    ' }, dim('name')], [dim('type'.padEnd(kindW)), { s: '  ' }, dim('size'.padStart(sizeW))], cols), false))
  const flipOf = (dir: string, open: boolean) => async () => {
    const key = `dir:${dir}`
    const cur = await cx.filesUi()
    const without = (xs: string[]) => xs.filter(x => x !== key)
    await cx.setFilesUi(open ? { ...cur, folded: [...without(cur.folded), key], unfolded: without(cur.unfolded) } : { ...cur, folded: without(cur.folded), unfolded: [...without(cur.unfolded), key] })
    await cx.bumpPanel()
  }
  const opened = new Map<string, boolean>()
  ;[...byDir.entries()].forEach(([dir, fs], i) => {
    const key = `dir:${dir}`
    const open = i === 0 ? !ui.folded.includes(key) : ui.unfolded.includes(key)
    opened.set(dir, open)
    hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: flipOf(dir, open) })
    lines.push(pointed([{ s: open ? '▾' : '▸' }, { s: ' ' }, { s: dir || root }, dim(`  ${num(fs.length)}`)], false))
    if (!open) return
    const whole = (ui.whole ?? []).includes(dir)
    const shown = !whole && fs.length > FOLDER_FILES + 1 ? fs.slice(0, FOLDER_FILES) : fs
    // each file's dot dim, as home's: the type column names its type, and only a Color by colours
    for (const f of shown) {
      const hue = COLORS.dim
      const name = middleCut(f.path.slice(dir.length), Math.max(8, cols - 4 - kindW - sizeW - 6))
      hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: choose(f.path) })
      lines.push(pointed(spread([{ s: '  ' }, { s: '●', fg: hue }, { s: ' ' }, { s: name }], right(f), cols), f.path === pick, true))
      order.push(f.path)
      dirOf.set(f.path, dir)
    }
    if (fs.length > shown.length) {
      // `… N more` shows the folder whole
      const more = `… ${num(fs.length - shown.length)} more`
      hits.push({ y: lines.length, x0: MARGIN_W + 4, x1: MARGIN_W + 4 + width(more), row: false, run: async () => {
        const cur = await cx.filesUi()
        await cx.setFilesUi({ ...cur, whole: [...(cur.whole ?? []).filter(x => x !== dir), dir] })
        await cx.bumpPanel()
      } })
      lines.push(pointed([{ s: '    ' }, dim(more)], false))
    }
  })
  if (!files.length) lines.push(pointed([{ s: '  ' }, dim('none')], false))
  const step = async (d: number) => {
    if (!order.length) return
    const at = order.indexOf(pick)
    const next = order[Math.max(0, Math.min(order.length - 1, at < 0 ? 0 : at + d))]!
    await cx.setFilesUi({ ...(await cx.filesUi()), pick: next })
    await readSurface(cx, `file:${next}:1`, 'files', [next])
  }
  const onKey = (k: string) => {
    if (k === 'up' || k === 'k') return step(-1)
    if (k === 'down' || k === 'j') return step(1)
    if ((k === 'return' || k === 'enter') && pick) return openFile(cx, pick)
    // Space folds the chosen file's folder
    if ((k === 'space' || k === ' ') && pick) {
      const dir = dirOf.get(pick) ?? ''
      return flipOf(dir, opened.get(dir) ?? true)()
    }
    return undefined
  }
  body.push(linesEl(cx, e, marginKey('files-tree'), lines, hits, cols + MARGIN_W, onKey))
  body.unshift(
    <Box key="file-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {files.map((f, i) => <Button key={`file-open-${i}`} label={f.path} plain onPress={() => void openFile(cx, f.path)} />)}
    </Box>,
  )
  // the chosen file: its name, what it opens as, its first lines
  if (pick) {
    const page = await surfaceValue<Obj>(cx, `file:${pick}:1`)
    const as = page?.ok ? opensAs(page.value) : page && !page.ok ? '' : ''
    body.push(ruleEl(els, cols, 'rule-preview'))
    body.push(lineEl(els, spread([{ s: pick }], as ? [dim(`opens as ${as}`)] : [], cols), 'preview-name'))
    if (page?.ok && !page.value.binary) {
      const ls = pageLines(page.value).slice(0, 6)
      const gw = Math.max(1, ...ls.map(l => String(l.n).length))
      for (const l of ls) body.push(<Text key={`preview-${l.n}`} wrap="truncate-end"><Text dimColor>{`${String(l.n).padStart(gw + 2)}  `}</Text><Text>{cut(l.text, Math.min(160, cols - gw - 4)) || ' '}</Text></Text>)
    }
    if (page && !page.ok) body.push(<Text key="preview-err" color={COLORS.problem} wrap="wrap">{`× ${page.error}`}</Text>)
    if (!page) body.push(<Text key="preview-wait" dimColor>◌ reading</Text>)
  }
  body.push(hintsRow(els, ['↑↓ to choose', 'Enter to open', 'Space to fold'], cols))
  return <Box flexDirection="column">{body}</Box>
}

// the keys a transcript's record names its speaker, its words and its time by, in the order tried, where thimble's sniff
// names none
const SPEAKER_KEYS = ['speaker', 'role', 'author', 'agent', 'sender', 'from', 'user', 'name']
const TEXT_KEYS = ['text', 'content', 'message', 'body', 'msg', 'comment']
const TIME_KEYS = ['time', 'timestamp', 'ts', 'created_at', 'date', 'at']

/** A turn of a transcript: its line, who speaks, the words, when; a tool call folded to one line (`tool`). */
type Turn = { n: number; who: string; text: string; time: string; tool?: boolean }

/** A dotted key's value in a record (`data.speakerId`). */
function dotted(o: Obj, key: string): unknown {
  let v: unknown = o
  for (const k of key.split('.')) v = isObj(v) ? v[k] : undefined
  return v
}

/** Words held as a string, or as a list of blocks with text. */
function wordsOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(b => (typeof b === 'string' ? b : isObj(b) ? str(b.text) : '')).filter(Boolean).join(' ')
  return ''
}

/** A page's records as a transcript's turns: by the keys thimble's sniff named (`page.transcript`), a text log's turns
 *  (each record's `meta.turn`), else when most records name a speaker and hold words; else null. */
function turnsOf(page: Obj): Turn[] | null {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const hint = isObj(page.transcript) ? page.transcript : null
  const out: Turn[] = []
  const lineOf = (r: Obj, i: number) => (typeof r.line === 'number' ? r.line : (typeof page.start === 'number' ? page.start : 1) + i)
  if (hint?.format === 'text') {
    records.forEach((r, i) => {
      const text = isObj(r.record) ? str(r.record.text) : str(r.text)
      const turn = isObj(r.meta) && isObj(r.meta.turn) ? r.meta.turn : null
      if (turn) out.push({ n: lineOf(r, i), who: demojibake(str(turn.speaker)), text: demojibake(text.slice(typeof turn.at === 'number' ? turn.at : 0).trim()), time: str(turn.time) })
      else if (out.length && text.trim()) out.at(-1)!.text += ` ${demojibake(text.trim())}`
    })
    return out.length ? out : null
  }
  const keys = hint && isObj(hint.keys) ? hint.keys : null
  for (const [i, r] of records.entries()) {
    const o = isObj(r.record) ? r.record : null
    if (!o) continue
    const who = keys ? str(keys.speaker).split('|').map(k => dotted(o, k)).find(v => typeof v === 'string' && v.trim()) : SPEAKER_KEYS.map(k => o[k]).find(v => typeof v === 'string' && v.trim())
    const text = keys ? wordsOf(dotted(o, str(keys.text))) : TEXT_KEYS.map(k => o[k]).find(v => typeof v === 'string' && v.trim())
    const time = keys && keys.time ? dotted(o, str(keys.time)) : TIME_KEYS.map(k => o[k]).find(v => typeof v === 'string' || typeof v === 'number')
    if (typeof who !== 'string' || typeof text !== 'string' || !text.trim()) {
      // a tool record of an agent's transcript: one dim line
      if (hint?.tools && (o.tool_use_id || o.tool || o.name || o.type === 'tool_use' || o.type === 'tool_result')) out.push({ n: lineOf(r, i), who: '', text: str(o.name ?? o.tool ?? o.type ?? 'tool call'), time: '', tool: true })
      continue
    }
    out.push({ n: lineOf(r, i), who: demojibake(who.trim()), text: demojibake(text.replace(/\s+/g, ' ').trim()), time: time === undefined ? '' : String(time) })
  }
  const spoken = out.filter(t => !t.tool).length
  if (hint) return spoken ? out : null
  return records.length && spoken >= Math.ceil(records.length * 0.6) ? out : null
}

/** The records of a page that are objects (JSON lines, a JSON list's items, CSV rows), each with its line. */
function recordsOf(page: Obj): { n: number; o: Obj }[] {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const first = typeof page.start === 'number' ? page.start : 1
  const out = records.flatMap((r, i) => (isObj(r.record) && !('text' in r.record && Object.keys(r.record).length === 1) ? [{ n: typeof r.line === 'number' ? r.line : first + i, o: r.record }] : []))
  return out.length * 2 >= records.length ? out : []
}

/** A record's value as a table's cell: words as written, a number, anything else as JSON. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return demojibake(v.replace(/\s+/g, ' '))
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v === 'number' ? amount(v) : String(v)
  return JSON.stringify(v)
}

/** A file (SPEC.md, "The file browser", a file): its name as the title; under it its kind, its records and the
 *  lines shown of how many, `earlier  later` at R; the tabs `Table  Transcript  Raw` as its records read (1 2 3); the
 *  record chosen (a citation's, a click's, ↑↓) on the selection background, its place a link and a blue `?` under the
 *  view; ← or Backspace back to the file browser. Raw: each line's number right-aligned in a dim column, a Markdown
 *  file's headings bold. Transcript: per turn its time dim, a ● in the speaker's hue, the speaker bold, the words under
 *  the name up to three rows, a tool call one dim line. Table: the records' keys as columns, a click on one sorts. */
async function drawFile(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const start = p.start ?? 1
  const got = await surfaceValue<Obj>(cx, `file:${p.path}:${start}`)
  if (!got) return none(cx, e, `◌ reading ${p.title}`)
  if (!got.ok) {
    if (!rt.toasted.has(`${p.path}:${got.error}`)) {
      rt.toasted.add(`${p.path}:${got.error}`)
      cx.toast(`thimble: could not read ${p.title}: ${got.error}`)
    }
    return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text></Box>
  }
  const page = got.value
  const path = p.path ?? ''
  const ls = pageLines(page)
  const total = typeof page.total_lines === 'number' ? page.total_lines : 0
  const first = ls[0]?.n ?? start
  const last = ls.at(-1)?.n ?? first
  const turns = turnsOf(page)
  const recs = recordsOf(page)
  const modes = [...(recs.length ? ['table'] : []), ...(turns ? ['transcript'] : []), 'raw']
  const wanted = p.mode === 'lines' ? 'raw' : p.mode
  const mode = wanted && modes.includes(wanted) ? wanted : firstMode(page)
  const tabName: Record<string, string> = { table: 'Table', transcript: 'Transcript', raw: 'Raw' }
  // each tab's name with a cell of space at each side, selected or not, the selected one inverse (SPEC.md, "A panel's
  // header"), so choosing a tab moves none; the row brings its own margin and starts one cell left of the edge, so the
  // first tab's left cell hangs in the margin and its name starts at the edge, where the title starts
  const tab = (m: string) =>
    m === mode ? (
      <Text key={`tab-${m}`} inverse>{` ${tabName[m]} `}</Text>
    ) : (
      <Button key={`tab-${m}`} label={` ${tabName[m]} `} plain onPress={() => void openPanel(cx, { ...p, mode: m })} />
    )
  const earlier = first > 1 ? () => void openPanel(cx, { ...p, start: Math.max(1, first - 200) }) : null
  const later = total && last < total ? () => void openPanel(cx, { ...p, start: last + 1 }) : null
  const subWords = [fileType(path, str(page.kind), firstMode(page) === 'transcript' ? 'transcript' : ''), recs.length ? plural(recs.length, 'record') : '', ls.length ? `lines ${num(first)}-${num(last)}${total ? ` of ${num(total)}` : ''}` : page.binary ? 'raw bytes: not shown' : '']
  const subRow = (
    <Box key="file-sub" flexDirection="row">
      <Box flexShrink={1}>{lineEl(els, subLine(subWords))}</Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} flexDirection="row" columnGap={2}>
        {earlier ? <Button key="file-earlier" label="earlier" plain onPress={earlier} /> : null}
        {later ? <Button key="file-later" label="later" plain onPress={later} /> : null}
      </Box>
    </Box>
  )
  const tabsRow = (
    <Box key={marginKey('file-tabs')} flexDirection="row" paddingLeft={MARGIN_W - 1}>
      {modes.map(m => tab(m))}
    </Box>
  )
  const more = [subRow, ...(modes.length > 1 ? [tabsRow] : [])]
  const body: RenderElement[] = [...headerEls(els, { title: p.title || path, cols, more })]
  // the record chosen, by its line; a click or ↑↓ chooses another
  const chosen = p.line && p.line >= first && p.line <= last ? p.line : 0
  const choose = (n: number) => () => openPanel(cx, { ...p, line: n })
  const back = () => openPanel(cx, { view: 'files', title: 'Files' })
  const lineNs: number[] = []
  const lines: Line[] = []
  const hits: LineHit[] = []
  const gw = Math.max(1, ...ls.map(l => String(l.n).length))
  if (!ls.length) {
    if (!page.binary) body.push(none(cx, e))
  } else if (mode === 'transcript') {
    const speakers = [...new Set(turns!.filter(t => !t.tool).map(t => t.who))]
    // the clock in the time column, the day on a dim row of its own where it changes
    const times = turnTimes(turns!.map(t => (t.tool ? '' : t.time)))
    const tw = Math.min(22, Math.max(0, ...times.map(x => width(x.clock))))
    for (const [ti, t] of turns!.entries()) {
      const when = times[ti]!
      if (when.day) lines.push(pointed([dim(when.day)], false))
      const y = lines.length
      if (t.tool) {
        lines.push(pointed([...(tw ? [{ s: ' '.repeat(tw + 2) }] : []), dim(`  ⎿ ${cut(t.text, Math.max(10, cols - tw - 8))}`)], false))
        hits.push({ y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: choose(t.n) })
        lineNs.push(t.n)
        continue
      }
      const hue = COLORS.series[speakers.indexOf(t.who) % COLORS.series.length]!
      lines.push(pointed([...(tw ? [dim(`${cut(when.clock, tw).padEnd(tw)}  `)] : []), { s: '●', fg: hue }, { s: ' ' }, { s: t.who, b: true }], t.n === chosen, true))
      const room = Math.max(10, cols - (tw ? tw + 2 : 0) - 2)
      // the words under the name, up to three rows
      const rows = wrapRows(t.text, room, 3)
      for (const r of rows) lines.push(pointed([{ s: ' '.repeat((tw ? tw + 2 : 0) + 2) }, { s: r }], false))
      for (let k = y; k < lines.length; k++) hits.push({ y: k, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: choose(t.n) })
      lineNs.push(t.n)
    }
  } else if (mode === 'table') {
    // the records' keys as columns (the first 8 any of them hold), a click on a column's name sorts by it
    const heads = [...new Set(recs.flatMap(r => Object.keys(r.o)))].slice(0, 8)
    const [sortKey, sortDir] = (p.sort ?? '').split(':')
    const rows = recs.map(r => ({ n: r.n, cells: heads.map(h => r.o[h]) }))
    if (sortKey && heads.includes(sortKey)) {
      const k = heads.indexOf(sortKey)
      rows.sort((a, b) => {
        const x = a.cells[k]
        const y = b.cells[k]
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : cellText(x).localeCompare(cellText(y), undefined, { numeric: true })
        return sortDir === 'desc' ? -c : c
      })
    }
    const numeric = heads.map((_h, k) => rows.every(r => typeof r.cells[k] === 'number' || r.cells[k] === null || r.cells[k] === undefined))
    const natural = heads.map((h, k) => Math.max(width(h) + 2, ...rows.map(r => width(cellText(r.cells[k])))))
    const room = cols - 2 * (heads.length - 1)
    const ws = natural.slice()
    while (ws.reduce((a, b) => a + b, 0) > room && Math.max(...ws) > 6) ws[ws.indexOf(Math.max(...ws))]!--
    const cellSeg = (v: string, k: number): string => (numeric[k] ? cut(v, ws[k]!).padStart(ws[k]!) : cut(v, ws[k]!).padEnd(ws[k]!))
    // the column names dim, no rule; the sorted one with ▼ or ▲
    const headLine: Line = []
    let x = 0
    heads.forEach((h, k) => {
      if (k) {
        headLine.push({ s: '  ' })
        x += 2
      }
      const mark = sortKey === h ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''
      const name = cellSeg(`${h}${mark}`, k)
      headLine.push(dim(name))
      const next = sortKey === h && sortDir !== 'desc' ? `${h}:desc` : `${h}:asc`
      hits.push({ y: 0, x0: MARGIN_W + x, x1: MARGIN_W + x + ws[k]!, row: false, run: () => openPanel(cx, { ...p, sort: next }) })
      x += ws[k]!
    })
    lines.push(pointed(headLine, false))
    for (const r of rows) {
      hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: choose(r.n) })
      lines.push(pointed(r.cells.flatMap((v, k): Seg[] => [...(k ? [{ s: '  ' }] : []), { s: cellSeg(cellText(v), k) }]), r.n === chosen, true))
      lineNs.push(r.n)
    }
  } else {
    // raw: a Markdown file's headings bold and its blank lines left out
    const md = /\.(md|markdown)$/i.test(path)
    for (const l of ls) {
      if (md && !l.text.trim()) continue
      const head = md && /^#{1,6}\s/.test(l.text)
      const text = cut(l.text, Math.max(10, cols - gw - 2)) || ' '
      hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: choose(l.n) })
      const line: Line = [dim(`${String(l.n).padStart(gw)}  `), l.n === chosen ? { s: text, bg: COLORS.selected } : { s: text, ...(head ? { b: true } : {}) }]
      lines.push(pointed(line, false))
      lineNs.push(l.n)
    }
  }
  // the record chosen, right under the header so it shows however long the view: its place a link to the citation
  // panel, and a blue "?" that asks a thread about it
  if (chosen) {
    const ref = `${path}#L${chosen}`
    const words = ls.find(l => l.n === chosen)?.text ?? ''
    const place = `↗ ${placeWords(ref)}`
    const ask = () => openAsk(cx, { kind: 'record', ref, text: clip(words, 600), label: `${placeWords(ref)}: ${clip(words, 200)}` })
    body.push(linesEl(cx, e, 'file-detail', [[{ s: '↗', fg: LINK }, { s: ' ' }, linkSeg(placeWords(ref)), { s: '  ' }, { s: '?', fg: LINK }]], [{ y: 0, x0: 0, x1: width(place), row: false, run: () => openCite(cx, ref, null) }, { y: 0, x0: width(place) + 2, x1: width(place) + 3, row: false, run: ask }], width(place) + 3))
  }
  if (lines.length) {
    const at = chosen ? lineNs.indexOf(chosen) : -1
    const onKey = (k: string) => {
      if (k === 'left' || k === 'backspace' || k === 'delete') return back()
      if ((k === 'up' || k === 'k' || k === 'down' || k === 'j') && lineNs.length) {
        const d = k === 'up' || k === 'k' ? -1 : 1
        return choose(lineNs[Math.max(0, Math.min(lineNs.length - 1, at < 0 ? 0 : at + d))]!)()
      }
      if ((k === 'return' || k === 'enter') && chosen) return openCite(cx, `${path}#L${chosen}`, null)
      if (k === 'tab') return openPanel(cx, { ...p, mode: modes[(modes.indexOf(mode) + 1) % modes.length]! })
      return undefined
    }
    body.push(linesEl(cx, e, marginKey('file-body'), lines, hits, cols + MARGIN_W, onKey))
  }
  // the tabs by their digits
  const keys: Key[] = modes.length > 1 ? modes.map((m, i) => ({ key: `tab${i}`, hotkey: String(i + 1), onPress: () => void openPanel(cx, { ...p, mode: m }) })) : []
  body.push(...bottomRows(cx, e, cols, [], [], [...(modes.length > 1 ? [`${modes.map((_m, i) => i + 1).join(' ')} for the tabs`] : []), '↑↓ to choose', '← for the files']))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// ------------------------------------------------------------------------------------------------ agents and views

async function drawAgent(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const agents = (await cx.agents()) ?? []
  // by its thread when the panel names one: a role's earlier run that ended (done) has the same name, and is listed first
  const a = p.thread ? agents.find(x => x.chat === p.thread) : agents.find(x => x.name === p.agent)
  const tt: TermThread | undefined = p.thread ? await cx.thread(p.thread) : undefined
  const meta = tt?.meta ?? {}
  const state = a ? a.state : str(meta.status) || 'done'
  const body: RenderElement[] = [...headerEls(els, { title: a?.label ?? (str(meta.title) || p.title), cols, sub: subLine([state]) })]
  const steps: string[] = []
  let text = ''
  for (const ev of tt?.events ?? []) {
    if (ev.type === 'tool_use') {
      const inp = isObj(ev.input) ? ev.input : {}
      const what = str(inp.question ?? inp.command ?? inp.file_path ?? inp.pattern ?? inp.name ?? inp.description ?? '')
      steps.push(await scrubIds(cx, `${str(ev.name).replace(/^mcp__.*__/, '')}${what ? ` · ${what.replace(/\s+/g, ' ')}` : ''}`))
      text = ''
    } else if (ev.type === 'text') text += str(ev.delta ?? ev.text)
    else if (ev.type === 'done' && ev.result) text = str(ev.result)
  }
  if (!(tt?.events ?? []).length) body.push(<Text key="agent-none" dimColor>{tt ? 'nothing yet' : '◌ reading its chat'}</Text>)
  if (steps.length) {
    body.push(<Text key="agent-steps"><Text bold>Steps</Text><Text dimColor>{` (${num(steps.length)})`}</Text></Text>)
    steps.slice(-12).forEach((s, i) => body.push(<Text key={`agent-step-${i}`} dimColor wrap="truncate-end">{`  ${s}`}</Text>))
  }
  if (text.trim()) body.push(<Box key={marginKey('agent-text')} flexDirection="column" marginTop={steps.length ? 1 : 0}>{await drawReply(cx, e, text.trim(), cols, { margin: PANEL_MARGIN, prefix: 'agent-' })}</Box>)
  const stop = a && rt.sc ? () => void act(cx, rt.sc!, 'stop', { agent: a.chat || a.name, name: a.name }) : null
  body.push(...bottomRows(cx, e, cols, [stop ? <Button key="agent-stop" label="stop" plain onPress={stop} /> : null], [], [...(stop ? ['s to stop'] : []), 'b to go back', 'x to close']))
  const hk = stop ? hiddenKeys(cx, e, [{ key: 'stop', hotkey: 's', onPress: stop }]) : null
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// the views list's chosen row
let viewPick = ''

/** The views pane (SPEC.md, section 7, "The views pane"): `N views · N built`; one row per view, newest first, its glyph
 *  (● built, ◌ building, ○ proposed, × failed in red) and its name, the files it claims dim at R and `new` in green
 *  until a built one is opened (no word that repeats the glyph); `❯` on the chosen row, ↑↓ or j k choose, Enter or a
 *  click opens it, 1-9 the first nine. */
async function drawViews(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const els = cx.els(e) as El
  const cols = Math.max(30, e.props.bodyColumns)
  const vs = (await homeViews(cx)).sort((a, b) => b.at - a.at)
  const { Box, Button } = cx.els(e)
  const built = vs.filter(v => v.state === 'built').length
  const body: RenderElement[] = [...headerEls(els, { title: 'Views', cols, sub: subLine([plural(vs.length, 'view'), built ? `${num(built)} built` : '']) })]
  const glyph = (v: HomeView): Seg => (v.state === 'built' ? { s: '●' } : v.state === 'building' ? { s: '◌' } : v.state === 'failed' ? { s: '×', fg: COLORS.problem } : dim('○'))
  const pick = vs.find(v => v.slug === viewPick)?.slug ?? vs[0]?.slug ?? ''
  const open = (v: HomeView) => openView(cx, v.slug, v.name)
  const { lines, hits } = listLines(
    vs.map(v => ({ key: v.slug, glyph: glyph(v), name: v.name, right: [...(v.files.length ? [dim(v.files.join(', '))] : []), ...(v.fresh ? [{ s: '  ' }, freshSeg()] : [])], run: () => open(v) })),
    pick,
    cols,
  )
  const step = (d: number) => {
    const at = vs.findIndex(v => v.slug === pick)
    viewPick = vs[Math.max(0, Math.min(vs.length - 1, at + d))]?.slug ?? ''
    return cx.bumpPanel()
  }
  body.push(linesEl(cx, e, marginKey('views-list'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? open(vs.find(v => v.slug === pick)!) : undefined)))
  // each view a press away by its key too, for a surface that draws no Client: no row of its own
  body.unshift(
    <Box key="view-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {vs.map((v, i) => (
        <Button key={`view-open-${i}`} label={v.name} plain onPress={() => void open(v)} />
      ))}
    </Box>,
  )
  body.push(hintsRow(els, vs.length ? ['↑↓ to choose', 'Enter to open'] : [], cols))
  const hk = hiddenKeys(cx, e, vs.slice(0, 9).map((v, i) => ({ key: `v${i}`, hotkey: String(i + 1), onPress: () => void open(v) })))
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

function drawView(cx: Ctx, e: PaneEvent, p: TermPanel): RenderElement {
  const els = cx.els(e) as El
  const { Box, Text } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  return (
    <Box flexDirection="column">
      {[
        ...headerEls(els, { title: p.title || p.slug || 'view', cols, sub: subLine(['view']) }),
        <Text key="view-words" wrap="wrap">The browser draws this view. To see it, quit, run `thimble mode browser`, and start `thimble` again in this folder.</Text>,
        hintsRow(els, ['b to go back', 'x to close'], cols),
      ]}
    </Box>
  )
}

// ------------------------------------------------------------------------------------------------ the panel

/** The panel's drawing: the path row, then the view `panel` names, on the panel's grid (a cell of padding at each side,
 *  then the 2-cell margin, then the type area). */
export async function drawPanel(cx: Ctx, pe: PaneEvent): Promise<RenderElement> {
  await cx.panelTick()
  const e = { ...pe, props: { ...pe.props, bodyColumns: Math.max(20, pe.props.bodyColumns - 2 - MARGIN_W) } } as PaneEvent
  const p = (await cx.panel()) ?? { view: 'home', title: 'Home' }
  wayHints = [...(backTarget((await cx.nav()) ?? NAV_EMPTY) !== null ? ['b to go back'] : []), 'x to close']
  const body = await (async () => {
    switch (p.view) {
      case 'home':
        return drawHome(cx, e)
      case 'card':
        return drawCard(cx, e, p)
      case 'cite':
        return drawCite(cx, e, p)
      case 'ask':
        return drawAsk(cx, e, p)
      case 'thread':
        return drawThreads(cx, e, p.thread ?? '')
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
      case 'views':
        return drawViews(cx, e)
      case 'view':
        return drawView(cx, e, p)
      default:
        return none(cx, e)
    }
  })()
  return withWay(cx, e, p.view, body)
}

