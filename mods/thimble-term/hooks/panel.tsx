// The panel: thimble-term's one pane, drawn by the view `panel` names (hooks/term.ts), on the panel's look in SPEC.md
// ("The visual system": rules 1 to 15, sections 2 and 7). A cell of padding at each side,
// then the 2-cell margin where `❯`, `?` and `↳` hang, then the type area. Every view opens with its title row, the path
// from home with the current step last in the accent colour and bold (`home › Threads`; on home `show all threads` and
// `N new` in green at R), a dim subtitle, a rule; its actions sit at its bottom after a second rule; a dim italic row of
// key hints ends it.
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
//   docs      the documents; doc, one document drawn as main's chat draws a reply, its figures as cards, its comments
//             under the passages they are on (report.ts); its edit as Markdown (`mode: edit`, docedit.tsx)
//   files     the file browser and a file: filesview.tsx, through drawsView
//   agent     one of thimble's agents: what it is doing and its latest steps
//   views     the views, one row each; view, one view as one line (the browser draws views)
import type { BoxProps, ButtonProps, ElementConstructor, MatchedEvent, RenderElement, TextProps } from 'claude-code'

import type { ChatNavStep, ChatThread, TermPanel, TermThread, TermVerdict } from '../types'
import type { ThimbleLabel } from './cell'
import { ACCENT, FRESH, LINK, MARGIN_W, controlsEl, fieldEls, fitTo, freshSeg, hasMargin, headerEls, hintLines, hintsEl, lineEl, linkSeg, marginKey, pointed, ruleEl, setHead, spread, subLine, takeHead } from './chrome'
import { chipLook, chipName, citeLabel, plainCites, quoteSpan, quotedWords, wrapAround } from './cite'
import { MAX_BARS, MAX_NODES, MAX_TABLE_ROWS, amount, cardLayout, cut, cutRef, demojibake, labelHead, lineWidth, placeWords, shade, share, shares, turnTimes, valueColour, width, wrapRows } from './draw'
import type { BarRow, CardData, Cell, Item, Layout, Line, Seg } from './draw'
import { fileRef, fileType, filesOf } from './files'
import { citationOf, placeOf, targetLabel } from './gestures'
import type { Gesture, Target } from './gestures'
import { FIRST as HOME_FIRST, HOME_HINTS, groupCards, homeLayout, homePick, homeReduce, labelHue, NAME_WHOLE } from './home'
import type { HomeAct, HomeCardGroup, HomeData, HomeFile, HomeLabel, HomeLayout, HomeOpen, HomeReport, HomeThread, HomeUi, HomeView } from './home'
import { chipLabel, chipWords, cid, clip, cutLine, fmt, itemsRow, labelRef, middleCut, labelState, labelStateWords, noControls, outputLine, quoted, recordFields, reportRef, stoppedTurn, windowAt } from './lib'
import type { Citation } from './lib'
import { linesEl, setListKeys, takeListKeys } from './lines'
import type { LineHit } from './lines'
import { aroundLine, docUnits, docsOf, labelOf, labelsOf, threadOf } from './model'
import type { DocFigure, DocSection } from './model'
import { TITLE_ID, beginEdit, checksOf, commentFacts, commentLines, commentWho, commentsOf, discardEdit, draftEdit, editChanged, editOf, flipResolved, passageWords, pickOf, resolvedShown, saveEdit, setComment, setPick, shownComments, stepPick, unitOf, unitParts } from './report'
import type { DocComment } from './report'
import { focusFromRef } from './anim'
import type { Focus } from './anim'
import { NAV_EMPTY, backTarget, crumbSteps, fitPath, pathWidth, threadBehind, threadOnTrail, threadTitle, threadTree, withBack } from './nav'
import { COLORS, paintLines } from './paint'
import { PANEL_MARGIN, cardBlock, cardName, citeStatus, claimCard, claimSentence, drawReply, linkCheck, placeName, plainWhy, scrubIds } from './reply'
import { PANEL, citePage, closePanel, deleteLabel, filterLabel, handBack, inPanelNow, loadCards, navBack, navGo, openHome, openList, openPanel, panelOfStep, queueCitations, readDoc, readFilePage, readSurface, rt, runLabel, saveLabel, showLabel, startThread, stepOf, stopLabel, subjectFile, surfaceValue, threadMessage, undeleteLabel } from './term'
import { COLOR_NAMES, MORE_ROWS, agreementLine, classColors, hueOf, labelArgs, labelGone, labelRows, setLabelGone } from './labels'
import type { LabelPatch } from './term'
import type { Ctx } from './ctx'
import { act } from './data'
import { closeView, onViewAct, openViewState, retryView, sendEvent, viewFor } from './viewhost'
import type { ViewFrame } from './viewhost'

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

/** The `element` of a thread asked about a whole answer, from the answer's footer. */
export const ANSWER_ELEMENT = 'answer'

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
    return { slug, name: str(v.name) || slug, state, words: '', files: Array.isArray(v.files) ? (v.files as unknown[]).map(String) : [], unit: '', drawable: state === 'built', left: 0, at: Date.parse(str(v.ts)) || 0, ...(fresh ? { fresh: true } : {}), ...(v.term === true ? { term: true } : {}) }
  })
}

/** A document in the panel, under its title. Opened, it is no longer new. */
export async function openDoc(cx: Ctx, slug: string, title: string): Promise<void> {
  const docs = await surfaceValue(cx, 'docs')
  const d = docs?.ok ? docsOf(docs.value).find(x => x.slug === slug) : undefined
  if (d) rt.docsKnown.set(slug, d.generation)
  await openPanel(cx, { view: 'doc', title: d?.title || title || slug, slug })
}

/** A document opened at the section, slide or beat that holds `unit` (a sentence's, a heading's or a paragraph's id,
 *  `p<id>`), from a link to it (`report:<slug>#<unit>`). */
async function openDocAt(cx: Ctx, slug: string, unit: string): Promise<void> {
  await readDoc(cx, slug)
  const got = await surfaceValue<Obj>(cx, `doc:${slug}`)
  const doc = got?.ok ? got.value : {}
  const holds = (u: DocSection) => u.id === unit || (u.paragraphs ?? []).some(p => p.id === unit || `p${p.id}` === unit || (p.sentences ?? []).some(x => x.id === unit))
  const at = unit ? docUnits(doc).units.findIndex(holds) : -1
  const docs = await surfaceValue(cx, 'docs')
  const d = docs?.ok ? docsOf(docs.value).find(x => x.slug === slug) : undefined
  if (d) rt.docsKnown.set(slug, d.generation)
  await openPanel(cx, { view: 'doc', title: d?.title || str(doc.title) || slug, slug, ...(at > 0 ? { start: at } : {}) })
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
  if (fileRef(c.ref) || /^call:/.test(c.ref)) return placeWords(c.ref)
  return /^(?:card|cell):/.test(c.ref) ? placeName(cx, c.ref) : chipWords(c)
}

/** A citation's panel, its step named by the cited value (or its place, for a citation that shows none); `sentence`
 *  the sentence it stands in, `quote` the passage an example's record quotes. */
export async function openCite(cx: Ctx, ref: string, display: string | null, more: { sentence?: string; quote?: string; of?: string } = {}): Promise<void> {
  // a label's link: the label's panel at the value it names (live check term-fix5, new quirk 2)
  const lr = labelRef(ref)
  if (lr) return openLabelAt(cx, lr.id, lr.value)
  // a document's link: the document, from the section that holds the passage
  const rr = reportRef(ref)
  if (rr) return openDocAt(cx, rr.slug, rr.unit)
  // its step in the path: its words cut at a word; for a place cited with no words, the words of the chip the reply
  // draws (`agent-chat.jsonl line 2`)
  const c = { raw: '', ref, display }
  const title = display === null && fileRef(ref) ? chipWords(c) : clip(await citeTitle(cx, c), 40)
  // opened anew, a file citation's window starts at the cited lines again
  citeTops.delete(ref)
  await openPanel(cx, { view: 'cite', title, ref, display, ...(more.sentence ? { sentence: more.sentence } : {}), ...(more.quote ? { quote: more.quote } : {}), ...(more.of ? { of: more.of } : {}) })
}

export async function openCard(cx: Ctx, id: string, mode = ''): Promise<void> {
  // its step named by its question: a card no drawing read yet (one a side thread made) is read first (live check
  // term-fix8, low quirk: the path read `card "Card"` on its first open)
  if (!(await cx.card(id))?.data) await loadCards(cx, [id]).catch(() => undefined)
  const tc = await cx.card(id)
  await openPanel(cx, { view: 'card', title: clip((tc?.data as CardData | undefined)?.question ?? 'Card', 60), card: id, ...(mode ? { mode } : {}) })
}

/** A thread opens in the threads panel, selected under the tree; its step named by its first question (`question` when
 *  it was just asked), never thimble's slug of it. */
export async function openThread(cx: Ctx, id: string, question = '', opts: { replace?: boolean } = {}): Promise<void> {
  const row = (await cx.threads()).find(t => t.id === id)
  const tt = await cx.thread(id)
  const q = question || (tt?.events.length ? threadOf(tt.meta, tt.events).turns[0]?.q : '') || row?.question || row?.title || ''
  await openPanel(cx, { view: 'thread', title: q ? quoted(clip(plainCites(q), 60)) : 'thread', thread: id }, opts)
}

/** A file in the panel from line `start`, `line` the record a citation or a click chose, lit there. */
export async function openFile(cx: Ctx, path: string, start = 1, line?: number): Promise<void> {
  await openPanel(cx, { view: 'file', title: path.split('/').at(-1) ?? path, path, start, ...(line ? { line } : {}) })
}

/** A label's panel, as it opens: what a save or a run said there before is gone. With `value`, its counts and examples
 *  open, the value lit in them. */
export async function openLabel(cx: Ctx, id: string, name: string, value = ''): Promise<void> {
  // the labels list's `undo` of a delete is offered only until another label opens
  setLabelGone(null)
  const ui = await cx.labelUi()
  const said = { ...ui.said }
  if (ui.said[id] && !ui.runs[id]) delete said[id]
  const open = value ? [...new Set([...ui.open, `${id}:counts`, `${id}:examples`])] : ui.open
  if (said[id] !== ui.said[id] || open !== ui.open) await cx.setLabelUi({ ...ui, said, open })
  await openPanel(cx, { view: 'label', title: name, label: id, ...(value ? { value } : {}) })
}

/** A label's panel opened from a link to it (`concept:<id>/<value>`), named as the labels list names it. */
async function openLabelAt(cx: Ctx, id: string, value: string): Promise<void> {
  await readSurface(cx, 'labels', 'labels')
  const got = await surfaceValue(cx, 'labels')
  const name = (got?.ok ? labelsOf(got.value) : []).find(l => l.id === id)?.name ?? 'label'
  await openLabel(cx, id, name, value)
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

/** Hotkeys with no label of their own (rule 26: the key-hint row says them): plain Buttons in a Box no row tall. Each
 *  is kept by its letter too, for the list's keys (listKeysEl), whose field takes the letters while it holds the ring;
 *  none is drawn while the panel's typing goes to the prompt (typeThrough), so the next letter reaches it. */
export function hiddenKeys(cx: Ctx, e: PaneEvent, keys: Key[]): RenderElement | null {
  for (const k of keys) hotkeysDrawing.set(k.hotkey, k.onPress)
  if (!keys.length || e.surface === 'mobile' || rt.typeThrough) return null
  const { Box, Button } = cx.els(e)
  return (
    <Box key="hidden-keys" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {keys.map(k => (
        <Button key={`hk-${k.key}`} label={k.hotkey} hotkey={k.hotkey} plain onPress={typedOr(cx, k.hotkey, k.onPress)} />
      ))}
    </Box>
  )
}

/** A hotkey's press, or, once the panel's typing goes to the prompt (typeThrough), its letter typed into the prompt: a
 *  key typed before the panel drew again without its hotkeys reached one (live check term-fix10: `table` typed into the
 *  prompt opened the threads at its `t` and reached main as `able`). */
function typedOr(cx: Ctx, hotkey: string, onPress: () => void): () => void {
  return () => (rt.typeThrough ? void cx.fill(hotkey) : onPress())
}

/** A Button's hotkey prop (`hotkey` for its key) and its press (typedOr), kept by its letter for the list's keys as
 *  hiddenKeys keeps one: no hotkey for a Button past the first nine, or while the panel's typing goes to the prompt. */
function hotkeyOf(cx: Ctx, hotkey: string | null, onPress: () => void): { hotkey?: string; onPress: () => void } {
  if (!hotkey) return { onPress }
  hotkeysDrawing.set(hotkey, onPress)
  return rt.typeThrough ? { onPress: typedOr(cx, hotkey, onPress) } : { hotkey, onPress: typedOr(cx, hotkey, onPress) }
}

/** What a step of the path says: a lower-case kind word and its name, or the name alone after the list it is in. */
function crumbText(s: ChatNavStep): string {
  switch (s.view) {
    case 'thread':
      return s.title
    case 'cite':
      return `citation ${s.title === 'Citation' ? '' : s.title}`.trim()
    case 'card':
      // its code view's step keeps ` · code` whole: the question inside its marks is cut, once (lib.ts cut)
      return panelOfStep(s)?.mode === 'code' ? `card ${quoted(s.title)} · code` : `card ${quoted(s.title)}`
    case 'label':
    case 'file':
    case 'agent':
    case 'view':
      return s.title
    case 'doc':
      // its edit takes the document's step, as a card's code view takes the card's
      return panelOfStep(s)?.mode === 'edit' ? `${quoted(s.title)} · edit` : quoted(s.title)
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

// the cells of the title row's separator (` › `)
const SEP_W = 3

// a list's step as the title names it where it is the current step (`home › Threads`); earlier on the path it reads as
// its lower-case kind word (`home › threads › "…"`)
const LIST_TITLES: Record<string, string> = { home: 'Home', threads: 'Threads', labels: 'Labels', docs: 'Documents', files: 'Files', views: 'Views', ask: 'New thread' }

/** The current step's words: a list's title; a thread by its question; else the step as the path names it, with the
 *  subject's name as the view gave it (a card's whole question). */
function hereText(s: ChatNavStep, title: string | undefined): string {
  const list = LIST_TITLES[s.view]
  if (list) return list
  return s.view === 'thread' || !title ? crumbText(s) : crumbText({ ...s, title })
}

/** The title row (SPEC.md, "A panel's header"; Matt, 2026-10-07: "can just be one line for title"): the path from
 *  home, each earlier step dim and a click away, a dim ` › ` between steps, and the current step last, its title in the
 *  accent and bold (a citation's value its link); a thread's step followed by `new` in green while answers wait, one
 *  that answers starting with `◌`. Against R what the view puts there (`◌ loading…`), and on home `show all threads`
 *  and `N new` in green. No `‹ back`: b goes back. Where the path does not fit, the earlier steps shorten first, then
 *  the current one is cut with `…`. */
async function wayRow(cx: Ctx, e: PaneEvent, view: string): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const els = cx.els(e) as El
  // the row's own width: never more than the pane gives it, or it wraps (live check term-fix9, quirk 3)
  const cols = Math.max(10, e.props.bodyColumns)
  const nav = (await cx.nav()) ?? NAV_EMPTY
  const back = backTarget(nav) !== null
  const head = takeHead()
  // `show all threads` only where the threads are the subject, home; the threads panel is the threads, and on a view,
  // a file, a card or a citation home is one step away (Matt, 2026-10-07: "does 'show all threads' really need to be
  // there when you're not in a thread?")
  const showThreads = view === 'home'
  const threads = (await cx.threads()) ?? []
  const fresh = ((await cx.news()) ?? { n: 0 }).n
  const { steps, skipped } = crumbSteps(nav.trail)
  type Crumb = { text: string; mark: string; go: () => void; here?: boolean; up?: boolean }
  const crumbs: Crumb[] = []
  for (const [i, s] of steps.entries()) {
    const up = upOf(s, steps.slice(0, i))
    // the list a step stands in goes back to that list: the trail up to the step, then the list, never a step pushed
    // after the step (`home › files › a.jsonl › files`)
    const upTrail = nav.trail.slice(0, i + skipped)
    if (up) crumbs.push({ text: up.view === 'docs' ? 'documents' : up.view, mark: '', up: true, go: () => void navGo(cx, { trail: [...upTrail, stepOf(up)], back: withBack(nav.back, nav.trail) }) })
    const t = s.view === 'thread' ? threads.find(x => x.id === s.thread) : undefined
    const here = i === steps.length - 1
    // a card's step taken before the card was read names it by its question once it is
    const card = s.view === 'card' && (s.title === 'Card' || (here && !head.title)) ? ((await cx.card(panelOfStep(s)?.card ?? ''))?.data as CardData | null | undefined) : null
    const named = card?.question ? { ...s, title: here ? card.question : clip(card.question, 60) } : s
    crumbs.push({ text: here ? hereText(named, head.title) : crumbText(named), mark: t?.running ? '◌' : t?.unread ? 'new' : '', go: () => void navGo(cx, { trail: nav.trail.slice(0, i + 1 + skipped), back: withBack(nav.back, nav.trail) }), here })
  }
  const home = !crumbs.length
  // the current step's own words, where the view draws them (a citation's value as its link), after the step's kind
  // word in the accent and bold (`citation`)
  const own: Line | null = head.line && crumbs.length ? head.line : null
  const kind = own && view === 'cite' ? 'citation ' : ''
  if (own) crumbs[crumbs.length - 1]!.text = `${kind}${own.map(x => x.s).join('')}`
  const marksW = crumbs.reduce((n, c) => n + (c.mark ? c.mark.length + 1 : 0), 0)
  // at R `show all threads` and `N new`, while the steps keep the room they need beside them (home, the last step at
  // up to 12 cells); else `threads` and `N new`, else `threads` alone, so the threads stay one click away in a narrow
  // pane; else neither. No letter opens them: `t` did, unnamed, and a word typed while the panel held the keys (`table`)
  // opened the threads and lost its first letter (live check term-fix10, new quirk 4)
  const labels = [home ? LIST_TITLES.home! : 'home', ...crumbs.map(c => c.text)]
  const rightW = head.right ? 2 + 12 : 0
  const room = cols - marksW - rightW
  const newW = fresh ? `${fresh} new`.length : 0
  type Tail = { all: string; fresh: boolean; w: number }
  const tail0 = (all: string, withNew: boolean): Tail => ({ all, fresh: withNew, w: (all ? 2 + all.length : 0) + (withNew ? 2 + newW : 0) })
  const tails: Tail[] = !showThreads
    ? [tail0('', false)]
    : [tail0('show all threads', Boolean(fresh)), ...(fresh ? [tail0('threads', true)] : []), tail0('threads', false), tail0('', false)]
  const need = Math.min(pathWidth(labels.map((l, i) => (i < labels.length - 1 ? clip(l, 34) : l))), 4 + (labels.length > 2 ? 4 : 0) + (labels.length > 1 ? SEP_W + Math.min(12, width(labels.at(-1)!)) : 0))
  const tail = tails.find(t => room - t.w >= need) ?? tails.at(-1)!
  const fitted = fitPath(labels, Math.max(4, room - tail.w))
  const parts: RenderElement[] = []
  let drawn = false
  fitted.forEach((text, i) => {
    if (text === null) {
      if (drawn && fitted[i - 1] !== null) parts.push(<Text dimColor>{' › …'}</Text>)
      return
    }
    if (drawn) parts.push(<Text dimColor>{' › '}</Text>)
    drawn = true
    const c = i ? crumbs[i - 1]! : null
    if (c?.mark === '◌') parts.push(<Text>{'◌ '}</Text>)
    if (c?.here || (!c && home)) {
      // the current step: the title, in the accent and bold, or the view's own words for it, cut to the room
      if (!own) parts.push(lineEl(els, [{ s: text, fg: ACCENT, b: true }]))
      else {
        if (kind) parts.push(lineEl(els, [{ s: cut(kind, width(text)), fg: ACCENT, b: true }]))
        const line = fitTo(own, Math.max(1, width(text) - width(kind)))
        if (width(text) > width(kind)) parts.push(head.press ? linesEl(cx, e, head.key ?? 'way-here', [line], [{ y: 0, x0: 0, x1: lineWidth(line), row: false, run: head.press }], lineWidth(line)) : lineEl(els, line, head.key))
      }
    } else if (c) parts.push(<Button key={c.up ? `crumb-up-${i}` : `crumb-${i}`} label={text} plain dimColor onPress={c.go} />)
    else parts.push(<Button key="crumb-home" label={text} plain dimColor onPress={() => void openHome(cx)} />)
    if (c?.mark === 'new') parts.push(<Text color={FRESH}>{' new'}</Text>)
  })
  const showAll = () => void openPanel(cx, { view: 'threads', title: 'Threads' })
  return (
    <Box key="way" flexDirection="row">
      <Box flexShrink={1} flexDirection="row">
        {parts}
      </Box>
      <Box flexGrow={1} />
      {head.right ? <Box flexShrink={0}>{head.right}</Box> : null}
      {tail.all ? <Button key="threads" label={tail.all} plain onPress={showAll} /> : null}
      {tail.fresh ? <Text color={FRESH}>{`${tail.all ? '  ' : ''}${fresh} new`}</Text> : null}
      {hiddenKeys(cx, e, [...(back ? [{ key: 'back', hotkey: 'b', onPress: () => void navBack(cx) }] : []), { key: 'close', hotkey: 'x', onPress: () => void closePanel(cx) }])}
      {listKeysEl(cx, e)}
    </Box>
  )
}

/** The title row, then the view's rows, each with an empty margin unless it brings its own (a key starting `m:`). */
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
// whether the pane holds the keys as it is drawn (its `isFocused`)
let paneFocused = true
// the key handler of the list the view draws (lines.tsx takeListKeys), which the panel's own keys reach (listKeysEl)
let listRelay: ((k: string) => Promise<void> | void) | null = null
// the panel's hotkeys by their letters, as the drawing shown last bound them (hiddenKeys, hotkeyOf), and as the one being
// drawn does
let hotkeys = new Map<string, () => void>()
let hotkeysDrawing = new Map<string, () => void>()
// the list's own keys besides ↑↓ and Enter, as the view's hint row names them (endHints): Space folds, Backspace goes
// back; as the drawing shown last named them, and as the one being drawn does
let listExtra = { space: false, backspace: false }
let listExtraDrawing = { space: false, backspace: false }

/** The panel's own keys for the list a view draws (live checks term-fix7, quirk 2, and term-fix8, quirks 1, 2 and 7). A
 *  list is drawn by a Client, and a Client takes keys only from a click, which leaves the pane without them, so the
 *  list's keys are the pane's: an Input between two Buttons, all no row tall, the ring on the Input (`autoFocus`). While
 *  an Input holds the ring Claude Code moves the ring at ↑ and ↓ and never scrolls the pane, so the `ui.focus` hook
 *  (register.tsx) turns a move onto either Button into ↑ or ↓ for the list and keeps the ring where it is; Enter submits
 *  the Input; a letter, a digit or Space goes into it, and its change is that key (relayInput): the panel's hotkey by its
 *  letter, Space for the list where its hint names it, any other key typing for the prompt (typeThrough). ←, →, the page
 *  keys, Home and End reach no element while an Input holds the ring, so the hint row never names them. The Input holds
 *  a mark of its own, drawn anew after each key, so a Backspace changes it too. */
export const RELAY = { up: 'keys-up', pick: 'keys-pick', down: 'keys-down' } as const
const RELAY_KEYS: readonly string[] = Object.values(RELAY)
// the two marks the relay's Input holds in turn: drawing the other one gives it that text again (Claude Code keeps
// what the person typed until the hook draws another value)
const MARKS = ['\u200b', '\u200c'] as const
// the mark drawn last, whether a key came since (the next drawing draws the other one), and the text last seen
let relayMark = 0
let relayFlip = false
let relayLast = ''

/** The key a move of the panel's focus ring onto `element` stands for while it rests on the relay's Input (`up`,
 *  `down`), `park` for a move onto a neighbour from elsewhere (the ring goes to the Input), or '' for any other move. */
export function relayMove(from: string, element: string | undefined): 'up' | 'down' | 'park' | '' {
  if (element !== RELAY.up && element !== RELAY.down) return ''
  if (from !== RELAY.pick) return 'park'
  return element === RELAY.up ? 'up' : 'down'
}

/** Whether the panel shows a list whose keys the relay passes on. */
export function hasList(): boolean {
  return listRelay !== null
}

/** A key for the list the panel shows now, from the panel's own keys (the relay); false when it shows none. */
export async function relayKey(k: string): Promise<boolean> {
  if (!listRelay) return false
  await listRelay(k)
  return true
}

/** What the person typed into the relay's Input, from its text now (`value`) and the text seen last (`last`): each
 *  character, or `backspace` when the text got shorter. Its text starts as the mark drawn; a key typed before the next
 *  drawing adds to what is there. */
export function relayTyped(value: string, last: string): string[] {
  const mark = (v: string) => (v && (MARKS as readonly string[]).includes(v[0]!) ? v[0]! : '')
  const m = mark(value)
  const before = mark(last) === m && m ? last : m
  if (value.length < before.length || (!m && !value)) return ['backspace']
  return [...value.slice(before.length)]
}

/** The mark the relay's Input holds as drawn now, for the tests. */
export function relayValue(): string {
  return MARKS[relayMark]!
}

/** A change of the relay's Input: each key typed is the panel's hotkey by its letter or digit, Space or Backspace for
 *  the list where its hint names them, else typing meant for the prompt (typeThrough). The Input is drawn again with
 *  the other mark, so its next change starts afresh. */
export async function relayInput(cx: Ctx, value: string): Promise<void> {
  const typed = relayTyped(value, relayLast)
  relayLast = value
  relayFlip = true
  for (const ch of typed) {
    if (rt.typeThrough) {
      if (ch !== 'backspace') await cx.fill(ch)
      continue
    }
    if (ch === 'backspace') {
      if (listExtra.backspace) await relayKey('backspace')
      continue
    }
    if (ch === ' ' && listExtra.space) {
      await relayKey('space')
      continue
    }
    const run = hotkeys.get(ch)
    if (run) {
      run()
      continue
    }
    await typeThrough(cx, ch)
  }
  await cx.bumpPanel()
}

// while a field of a terminal view takes typing (its search), the relay's Input is that field: it holds the field's
// text, each change of which goes to the view whole, and Enter ends it (drawView)
let viewField: { slug: string; text: string; send: (text: string) => Promise<void>; enter: () => Promise<void> } | null = null
// while a field of a panel's own takes typing (the file browser's find), the relay's Input is that field as it is for a
// view's: the panel sets it on each drawing that types into it (relayField), and no other drawing keeps it
type PanelField = { text: string; send: (text: string) => Promise<void>; enter: () => Promise<void> }
let panelField: PanelField | null = null

/** The relay's Input as a field of the panel being drawn, which takes typing until a drawing sets none: it holds
 *  `text`, each change goes to `send` whole, Enter to `enter`; ↑↓ still move the list's choice. */
export function relayField(f: PanelField | null): void {
  panelField = f
}

/** The hint row while a field of the panel's own takes typing through the relay (relayField): what its keys do there,
 *  then `Esc to leave the field`; while the prompt holds the keys, only how to give the panel them. */
export function fieldHintsRow(els: El, hints: readonly string[], cols: number): RenderElement {
  endHints(hints)
  return hintsEl(els, paneFocused && !rt.typeThrough ? [...hints, 'Esc to leave the field'] : [UNFOCUSED_HINT], cols)
}

/** Whether the pane holds the keys as it is drawn, its typing not on the way to the prompt. */
export function panelHasKeys(): boolean {
  return paneFocused && !rt.typeThrough
}

/** The pane's body rows as the drawing measured them, 0 when not known (a list is then drawn whole). */
export function paneRows(): number {
  return bodyRows
}

/** A panel view drawn by a module of its own (filesview.tsx: the file browser and a file), by its name. */
type Drawer = (cx: Ctx, e: PaneEvent, p: TermPanel) => Promise<RenderElement>
const drawers = new Map<string, Drawer>()
export function drawsView(view: string, draw: Drawer): void {
  drawers.set(view, draw)
}

/** Enter on the relay's Input: Enter for the list. */
export async function relaySubmit(cx: Ctx): Promise<void> {
  relayLast = ''
  relayFlip = true
  if (!rt.typeThrough) await relayKey('return')
  await cx.bumpPanel()
}

/** A key the panel does not bind, typed while its list held the keys: it goes to the prompt, as Claude Code sends a
 *  pane's unbound letter there. Until the prompt has the keys (the next key the person types, which no element and no
 *  hotkey of the panel takes now) the panel draws neither the relay nor its hotkeys, and its hint row says to click it
 *  for its keys; a move of its ring or a click gives them back (register.tsx, term.ts takeKeys). */
async function typeThrough(cx: Ctx, ch: string): Promise<void> {
  rt.typeThrough = true
  rt.panelFocus = NO_RING
  await cx.fill(ch)
}

// the ring on no element (register.tsx NO_FOCUS)
const NO_RING = '-'

// the pane's body rows as the drawing measured them (0: not known, and no list is cut)
let bodyRows = 0
// the list the drawing cut to the pane's rows (windowList), and the one the drawing shown last cut, which the wheel moves
let windowed = ''
let shownWindow = ''
// each cut list's first row shown, the row the keys chose then, how many rows it has and shows, and whether the wheel
// or a click on a count row moved it since the choice last moved (`free`), by the list's key
const windowTops = new Map<string, { top: number; at: number; len: number; room: number; free: boolean }>()

/** The rows of a cut list that `top` leaves for the list's own lines: a dim row counts the lines above, another those
 *  below. */
function windowFit(top: number, len: number, room: number): { up: number; down: number; n: number } {
  const up = top > 0 ? 1 : 0
  let n = room - up
  const down = top + n < len ? 1 : 0
  n -= down
  return { up, down, n }
}

/** A list's lines cut to `room` rows so that its chosen line (`at`, -1 for none) shows, the hits moved with them: a
 *  list taller than its pane pushed the chosen row and the hint row out of view, and ↑↓ scrolled the pane instead of
 *  choosing (live check term-fix8, quirk 1). The wheel and a click on a count row move the rows shown (wheelWindow)
 *  until the choice moves again; the lines cut off above and below are counted on a dim row each, which a click moves
 *  by a page. A list that fits, or a pane whose rows are not known, is drawn whole. */
export function windowList(key: string, lines: Line[], hits: LineHit[], at: number, room: number, bump: () => Promise<void>, lead?: number): { lines: Line[]; hits: LineHit[] } {
  windowed = key
  const len = lines.length
  if (room < 5 || len <= room) {
    windowTops.delete(key)
    return { lines, hits }
  }
  const last = len - room + 1
  const prev = windowTops.get(key)
  const free = Boolean(prev?.free && prev.at === at)
  let top = Math.max(0, Math.min(prev?.top ?? 0, last))
  if (at >= 0 && !free) {
    for (let i = 0; i < 3; i++) {
      const f = windowFit(top, len, room)
      // a choice that moves up to the window's first row or above it: the window starts at the row that leads it (its
      // section's heading, or the list's top for its first row), so those rows can be reached by keys (live check
      // term-fix10, new quirk 5: ↑ back to home's first row left `↑ 4 more` and hid the Views and Documents headings)
      if (at < top || (lead !== undefined && lead < top && at === top)) top = lead !== undefined && lead <= at ? lead : at
      else if (at >= top + f.n) top = at - f.n + 1
      else break
      top = Math.max(0, Math.min(top, last))
    }
  }
  windowTops.set(key, { top, at, len, room, free })
  const f = windowFit(top, len, room)
  const page = Math.max(1, f.n - 1)
  const move = (to: number) => async () => {
    const cur = windowTops.get(key)
    if (cur) windowTops.set(key, { ...cur, top: Math.max(0, Math.min(to, last)), free: true })
    await bump()
  }
  const out: Line[] = []
  const outHits: LineHit[] = []
  if (f.up) {
    const words = `↑ ${num(top)} more`
    outHits.push({ y: 0, x0: MARGIN_W + 2, x1: MARGIN_W + 2 + width(words), row: false, run: move(top - page) })
    out.push(pointed([{ s: '  ' }, dim(words)], false))
  }
  out.push(...lines.slice(top, top + f.n))
  for (const h of hits) if (h.y >= top && h.y < top + f.n) outHits.push({ ...h, y: h.y - top + f.up })
  if (f.down) {
    const words = `↓ ${num(len - top - f.n)} more`
    outHits.push({ y: out.length, x0: MARGIN_W + 2, x1: MARGIN_W + 2 + width(words), row: false, run: move(top + page) })
    out.push(pointed([{ s: '  ' }, dim(words)], false))
  }
  return { lines: out, hits: outHits }
}

/** The wheel over the panel while it shows a cut list: the list's rows move by `by`, the choice where it is; false when
 *  the panel shows no cut list. */
export function wheelWindow(by: number): boolean {
  if (scrollShown && by) {
    scrollShown(by)
    return true
  }
  const cur = shownWindow ? windowTops.get(shownWindow) : undefined
  if (!cur || !by) return false
  const top = Math.max(0, Math.min(cur.top + by, cur.len - cur.room + 1))
  windowTops.set(shownWindow, { ...cur, top, free: true })
  return true
}

function listKeysEl(cx: Ctx, e: PaneEvent): RenderElement | null {
  if (!listRelay || e.surface === 'mobile' || rt.typeThrough) return null
  const { Box, Button, Input } = cx.els(e)
  const key = (k: string) => () => void relayKey(k)
  if (relayFlip) {
    relayMark = 1 - relayMark
    relayFlip = false
  }
  return (
    <Box key="list-keys" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      <Button key={RELAY.up} label="↑" plain onPress={key('up')} />
      {viewField || panelField ? (
        <Input key={RELAY.pick} value={(viewField ?? panelField)!.text} autoFocus onInput={v => {
          const f = viewField ?? panelField
          if (!f) return
          f.text = v
          void f.send(v)
        }} onSubmit={() => void (viewField ?? panelField)?.enter()} />
      ) : (
        <Input key={RELAY.pick} value={MARKS[relayMark]} autoFocus onInput={v => void relayInput(cx, v)} onSubmit={() => void relaySubmit(cx)} />
      )}
      <Button key={RELAY.down} label="↓" plain onPress={key('down')} />
    </Box>
  )
}

/** Whether the panel's focus ring rests on its list's keys (the relay), as the last `ui.focus` put it. */
function listKeysHeld(): boolean {
  return paneFocused && !rt.typeThrough && RELAY_KEYS.includes(rt.panelFocus)
}

// a list's keys, which the relay passes on while the ring rests on it: ↑↓, Enter, Space and Backspace; ← and → reach no
// element of a pane, nor do the page keys while the relay's Input holds the ring
const LIST_HINT = /^(?:↑↓|←|→|Enter |Space |Backspace |PgUp|PgDn)/
const UNRELAYED_HINT = /^(?:←|→|PgUp|PgDn)/

// the text fields the drawing being made draws, by their keys (rt.fields once it is shown)
let fieldsDrawing = new Set<string>()

/** A text field's key, noted as drawn by the drawing being made: its ring's hint is named only while it is drawn. */
function fieldKey(key: string): string {
  fieldsDrawing.add(key)
  return key
}

// the panel's text fields by their keys, with what Enter does in each
const FIELD_KEYS: [RegExp, string][] = [
  [/^(?:ask-new|ask-|follow-)/, 'Enter to ask'],
  [/^(?:lb-glob-|lb-values-)/, 'Enter to save'],
  [/^lbs-describe$/, 'Enter to make it'],
  [/^lb-name-/, 'Enter to rename'],
]

/** What Enter does in the text field that holds the panel's focus ring now; '' when no field holds it. */
export function focusedField(key: string): string {
  return FIELD_KEYS.find(([re]) => re.test(key))?.[1] ?? ''
}

/** A view's key hints with the way's after them, as bound now (rule 26: the hint row names only keys bound on it).
 *  While a text field holds the focus a letter goes into the field, so the hints are what Enter does there and that
 *  Esc leaves it. The list's Space and Backspace are bound as the view names them. */
function endHints(hints: readonly string[], autoFocus = ''): string[] {
  listExtraDrawing = { space: hints.some(h => h.startsWith('Space ')), backspace: hints.some(h => h.startsWith('Backspace ')) }
  // while the prompt holds the keys (Esc left a field, or a click on the prompt), a letter or Enter goes to the prompt,
  // and Enter would send it to main: no key of the panel's is named, only how to give the panel the keys; so too while
  // the panel's typing goes to the prompt (typeThrough)
  if (!paneFocused || rt.typeThrough) return [UNFOCUSED_HINT]
  // `autoFocus`: the view's field that takes the ring as it opens, before any ui.focus says where the ring is; a ring
  // on a field this drawing does not draw (one of the view before, live check term-fix9, quirk 1) is on none
  const field = rt.panelFocus ? (fieldsDrawing.has(rt.panelFocus) ? focusedField(rt.panelFocus) : '') : focusedField(autoFocus)
  if (field) return [field, 'Esc to leave the field']
  // a list's keys only while the ring rests on them (listKeysHeld): until a ui.focus says so, ↑↓ walk the panel's
  // buttons and Enter presses the one the ring is on
  const held = listKeysHeld()
  const own = hints
    .map(h => (h === 'Enter or a to ask' && !held ? 'a to ask' : h))
    .filter(h => h !== 'b to go back' && h !== 'x to close' && !(held ? UNRELAYED_HINT : LIST_HINT).test(h))
  return [...own, ...wayHints]
}

/** The hint row while the panel does not hold the keys. */
export const UNFOCUSED_HINT = 'click the panel for its keys'

export function hintsRow(els: El, hints: readonly string[], cols: number, autoFocus = ''): RenderElement {
  return hintsEl(els, endHints(hints, autoFocus), cols)
}

/** The rows a view's key hints take as the panel draws them now (hintLines): what a list cut to the pane leaves them. */
export function hintHeight(hints: readonly string[], cols: number, autoFocus = ''): number {
  return hintLines(endHints(hints, autoFocus), cols).length
}

/** The panel's bottom part (rule 25): the second rule, the actions 2 cells apart, the fields under them; then the
 *  key-hint row, the panel's last. */
export function bottomRows(cx: Ctx, e: PaneEvent, cols: number, controls: (RenderElement | null | false)[], fields: (RenderElement | null | false)[], hints: string[], rule = true, autoFocus = ''): RenderElement[] {
  const els = cx.els(e) as El
  const ctl = controlsEl(els, controls, 'bottom-controls')
  const fs = fields.filter((f): f is RenderElement => Boolean(f))
  return [...(rule && (ctl || fs.length) ? [ruleEl(els, cols, 'rule-bottom')] : []), ...(ctl ? [ctl] : []), ...fs, hintsRow(els, hints, cols, autoFocus)]
}

/** An empty region (rule 28): dim words at A2. */
export function none(cx: Ctx, e: PaneEvent, words = 'none'): RenderElement {
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
    threads.push({ id: t.id, title: quoted(clip(plainCites(t.question || t.title || t.anchorText || 'side thread'), 80)), about: about ? `about ${clip(about, 32)}` : '', words: t.running ? 'answering' : plural(t.answers, 'answer'), tone: st, unread: t.unread, earlier: Boolean(made && rt.startedAt && made < rt.startedAt), at: Date.parse(t.at) || 0 })
  }
  const canvas = await surfaceValue<Obj>(cx, 'canvas')
  const groups = canvas?.ok && Array.isArray(canvas.value.groups) ? (canvas.value.groups as unknown[]).filter(isObj) : []
  const cells = canvas?.ok && Array.isArray(canvas.value.cells) ? (canvas.value.cells as unknown[]).filter(isObj) : []
  // a card made since home was last seen is new on it (openHome)
  const cardOf = (c: Obj) => ({ id: str(c.id), kind: str(c.kind) || 'code', question: str(c.title) || 'a card', ...(rt.homeSince && madeAt(c) > rt.homeSince ? { fresh: true } : {}) })
  // a group by what it holds: a side thread's cards, a document's figures, or a group main named; a card no listed
  // group holds under `other cards`, last
  // a side thread's group by the thread's first question, as everywhere a thread is named (its title is a slug)
  const rowsNow = (await cx.threads()) ?? []
  const threadHead = (chat: string): string => {
    const r = rowsNow.find(t => t.id === chat)
    const q = r ? plainCites(r.question || r.title || '') : ''
    return q.trim() ? quoted(clip(q, 60)) : ''
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
  // a run the session's own process holds shows only as the chat that follows it (lib.ts labelRunning)
  const agents = (await cx.agents()) ?? []
  const labels: HomeLabel[] = labelsRaw?.ok
    ? labelsOf(labelsRaw.value).map(l => {
        // its runs as the labels list, its panel and its card say them (lib.ts labelState)
        const st = labelState(l, agents)
        // made since home was last seen, as a card is new (openHome)
        const made = Date.parse(str((l as { ts?: unknown }).ts)) || 0
        const colors = classColors(l.classes)
        return {
          slug: l.id,
          name: l.name ?? l.id,
          kind: l.kind ?? '',
          trial: Boolean(l.trial),
          // as thimble.labels() reads the rows: a record the analyst set to another value under that value
          counts: l.verdicts?.counts ?? l.label_stats?.counts ?? {},
          values: l.labels ?? Object.keys(l.label_stats?.counts ?? {}),
          paths: (l.glob ?? '').split(/,\s*/).filter(Boolean),
          running: st.running,
          ran: st.ran,
          state: labelStateWords(st),
          ...(rt.homeSince && made > rt.homeSince ? { fresh: true } : {}),
          // its values' colors as its classes have them, as its panel draws them
          ...(colors ? { colors } : {}),
        }
      })
    : []
  const files: HomeFile[] = filesOf(await surfaceValue(cx, 'files')).map(f => ({ file: f.path, records: null, size: f.size, seen: 0, state: 'listed', ranges: [], kind: fileType(f.path, f.kind, rt.opens.get(f.path)?.as) }))
  const root = (await cx.root().catch(() => '')).split('/').filter(Boolean).at(-1) ?? 'folder'
  return { views, reports, threads, cardGroups, labels, files, coverage: homeRaw?.ok ? str(homeRaw.value.coverage) : '', root }
}

/** When a card was made (ms), as the canvas lists it. */
function madeAt(c: Obj): number {
  return Date.parse(str(c.created_ts) || str(c.ts)) || 0
}

/** Home opened from the row above the prompt (its `open ›`): the group that holds the first new card unfolded (its
 *  section shown whole when the group is past the first few), the choice on that card; with no new card, on the first
 *  new document, view or label (live check term-fix8, quirk 6: the new card stood folded, the choice on an old row). */
export async function openHomeNew(cx: Ctx): Promise<void> {
  const seen = await cx.homeSeen()
  const since = seen?.at ?? 0
  await Promise.all([readSurface(cx, 'canvas', 'cards', ['--since', new Date(0).toISOString()]), readSurface(cx, 'labels', 'labels'), readSurface(cx, 'docs', 'docs')])
  const canvas = await surfaceValue<Obj>(cx, 'canvas')
  const cells = canvas?.ok && Array.isArray(canvas.value.cells) ? (canvas.value.cells as unknown[]).filter(isObj) : []
  const fresh = new Set(cells.filter(c => since && madeAt(c) > since).map(c => str(c.id)))
  const d = await homeData(cx)
  let ui = (await cx.homeUi()) as HomeUi
  const without = (xs: string[], x: string) => xs.filter(y => y !== x)
  const gi = d.cardGroups.findIndex(g => g.cards.some(c => fresh.has(c.id)))
  if (gi >= 0) {
    const g = d.cardGroups[gi]!
    const fold = `cards:${g.from}:${g.head}`
    ui = { ...ui, folded: without(ui.folded, fold), unfolded: [...without(ui.unfolded, fold), fold], pick: `card:${g.cards.find(c => fresh.has(c.id))!.id}`, more: gi >= HOME_FIRST && !ui.more.includes('cards') ? [...ui.more, 'cards'] : ui.more }
  } else {
    const r = d.reports.find(x => x.fresh)
    const v = d.views.find(x => x.fresh)
    const newLabels = seen ? Math.max(0, d.labels.length - seen.labels) : 0
    const l = newLabels ? d.labels[d.labels.length - newLabels] : undefined
    const pick = v ? `view:${v.slug}` : r ? `report:${r.slug}` : l ? `label:${l.slug}` : ''
    if (pick) ui = { ...ui, pick }
  }
  await cx.setHomeUi(ui)
  await openHome(cx)
}

// the home panel's last layout, which a key steps through
let homeLast: HomeLayout | null = null

/** The home panel (SPEC.md, "Home"), drawn from home.ts's lines: a click on a row opens it, on a heading its
 *  section's panel, on a group or folder folds it; ↑↓ choose a row, Enter opens it and Space folds it. */
async function drawHome(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>The home panel needs the terminal or the desktop app.</Text>
  // the pane's own width, never more: a pane 40 columns wide cut each row's right part (live check term-fix10)
  const cols = e.props.bodyColumns
  const ui = (await cx.homeUi()) as HomeUi
  // its keys named only while it holds them, as every view's (endHints; live check term-fix6, new quirk 4: home opened
  // from the toast named its keys while they went to the prompt)
  const lay = homeLayout(await homeData(cx), ui, cols, endHints(HOME_HINTS))
  homeLast = lay
  const run = (a: HomeAct) => async () => {
    if (a.op === 'open') return homeOpen(cx, a.open)
    const cur = (await cx.homeUi()) as HomeUi
    const next = homeReduce(cur, a)
    // a section shown whole: the choice moves from its `… N more` onto the first row it showed
    await cx.setHomeUi(a.op === 'more' && a.next && cur.pick === `more:${a.sec}` ? { ...next, pick: a.next } : next)
  }
  const allHits: LineHit[] = lay.hits.map(h => ({
    y: h.y,
    x0: h.x0,
    x1: h.x1,
    row: h.row,
    run: async () => {
      if (h.pick) await cx.setHomeUi({ ...((await cx.homeUi()) as HomeUi), pick: h.pick })
      await run(h.act)()
    },
  }))
  // the sections cut to the pane's rows around the chosen row, the rule and the hint rows kept (windowList): the title
  // row, the rule and the hint rows take the rest
  const pick = ui.pick || lay.picks[0]?.key || ''
  const pickY = lay.hits.find(h => h.pick === pick)?.y ?? -1
  const last = lay.lines.length - lay.hintRows
  // the rows above the sections: the rule (the title is the title row's)
  const top = 1
  // the row that leads the chosen one: the top for the first row the keys choose, else its section's heading
  const lead = pick === lay.picks[0]?.key ? top : Math.max(top, ...lay.heads.filter(y => y <= pickY))
  const win = windowList('home', lay.lines.slice(top, last), allHits.filter(h => h.y >= top && h.y < last).map(h => ({ ...h, y: h.y - top })), pickY - top, bodyRows - 1 - top - lay.hintRows, () => cx.bumpPanel(), lead - top)
  const lines = [...lay.lines.slice(0, top), ...win.lines, ...lay.lines.slice(last)]
  const hits: LineHit[] = [...allHits.filter(h => h.y < top), ...win.hits.map(h => ({ ...h, y: h.y + top }))]
  const onKey = async (k: string) => {
    const cur = (await cx.homeUi()) as HomeUi
    const l = homeLast
    if (!l) return
    const pick = cur.pick || l.picks[0]?.key || ''
    const at = l.picks.find(x => x.key === pick)
    if (k === 'return' || k === 'enter') return at ? run(at.act)() : undefined
    if (k === 'space' || k === ' ') return at?.act.op === 'fold' || at?.act.op === 'more' ? run(at.act)() : undefined
    const next = homePick(l, cur, k)
    if (next !== cur.pick) await cx.setHomeUi({ ...cur, pick: next })
  }
  return <Box flexDirection="column">{linesEl(cx, e, marginKey('home'), lines, hits, cols + MARGIN_W, onKey)}</Box>
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

/** Whether a citation's cited lines are lit whole: none of them holds the value it shows (a place cited without words,
 *  `[[README.md#L5]]`, or a value the line does not hold), and no example's quote marks a passage, so the cited part is
 *  the lines themselves (Matt, 2026-10-07: "the part it cited isn't highlighted"). */
function wholeLit(hits: readonly TermVerdict['lines'][number][], quote: string): boolean {
  return !quote && !hits.some(l => l.spans?.length)
}

/** The cited lines nested at A2 (SPEC.md, section 7, "The citation panel"): each line's number right-aligned in
 *  a dim column (the cited one's in the text colour), its text after a gutter; a cited line wrapped over 3 to 8 rows
 *  (by the pane's rows) around the value or the quoted passage on the selection background; two lines of context
 *  around the cited ones when a cited line wraps; a long context line cut with `…` around its value. */
function lineRows(cx: Ctx, e: PaneEvent, v: TermVerdict, cols: number, quote: string): RenderElement[] {
  const { Text } = cx.els(e)
  // at most 60 rows, never ending on part of a record: a record's rows after its first have no number
  let all = v.lines.slice(0, 60)
  if (v.lines.length > all.length && v.lines[all.length]!.n === 0) {
    let end = all.length
    while (end > 0 && all[end - 1]!.n === 0) end--
    if (all.slice(0, end - 1).some(l => l.hit)) all = all.slice(0, end - 1)
  }
  const gutter = Math.max(1, ...all.map(l => String(l.n || '').length))
  const room = Math.max(10, cols - gutter - 4)
  const hits = all.filter(l => l.hit)
  const hitRows = Math.max(3, Math.min(8, Math.floor(((e.props.scroll?.bodyRows || 20) - 14) / Math.max(1, hits.length))))
  const wraps = hits.some(l => l.text.length > room)
  const near = wraps ? 2 : 99
  const firstHit = all.findIndex(l => l.hit)
  const lastHit = all.length - 1 - [...all].reverse().findIndex(l => l.hit)
  const lines = firstHit < 0 ? all : all.filter((l, i) => l.hit || (i >= firstHit - near && i <= lastHit + near))
  const whole = wholeLit(hits, quote)
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
        // each end cut at a word, `…` right against the words: no space between them
        const w = windowAt(t, sp.length ? sp[0]![0] : 0, room)
        t = w.text
        sp = sp.map(([a, b]) => [a - w.shift, b - w.shift] as [number, number])
      }
      out.push(
        <Text wrap="truncate-end">
          <Text dimColor>{`  ${n}  `}</Text>
          <Text dimColor>{t || ' '}</Text>
        </Text>,
      )
      continue
    }
    const span: [number, number] | null = quote ? quoteSpan(text, quote) : (spans[0] ?? (whole ? [0, text.length] : null))
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

// where a file citation's window over its file starts once the analyst moved it, by the citation's ref: the `at` of
// its first row (citeWindow); none, and it starts a few lines above the cited one
const citeTops = new Map<string, number>()
// the pages of a file the window reads as it moves, by their surface key, while they are read
const citeReading = new Set<string>()
// what the wheel does to the window the drawing being made draws, and to the one the drawing shown last drew (wheelWindow)
let scrollDrawing: ((by: number) => void) | null = null
let scrollShown: ((by: number) => void) | null = null

/** A row of a file citation's window: a line of the file (`at` its number), or a row of the cited record (`at` its
 *  line and the row's place in it in thousandths; `n` 0 for a record's rows after its first). */
type WinRow = { at: number; line: number; n: number; text: string; hit: boolean; spans: number[][] }

/** A file citation's lines as a window over the whole file (Matt, 2026-10-07: "you can't see beyond the few lines it
 *  picks and the part it cited isn't highlighted"): the lines nested at A2 as lineRows draws them, the cited ones in
 *  the text colour with the value (the passage an example quotes, or the whole line for a citation that marks none) on
 *  the selection background, the lines around them dim, one row each; `room` rows tall, opening with the cited lines
 *  a third of the way down, `↑ N more` and `↓ N more` dim on a row each for the file's lines above and below, a click on
 *  one a page. ↑↓ (the list's keys, through the relay) and the wheel (wheelWindow) move it a line; as it nears a page's
 *  end the next page of the file is read (term.ts citePage). Null until a page of the file is read, or when the file
 *  does not page as lines; lineRows draws the cited lines then. */
async function citeWindow(cx: Ctx, e: PaneEvent, key: string, v: TermVerdict, cols: number, quote: string, room: number): Promise<{ el: RenderElement; scrolls: boolean } | null> {
  const path = v.path ?? ''
  const hits = v.lines.filter(l => l.hit)
  if (!path || typeof v.line !== 'number' || !hits.length) return null
  const first = v.line
  const last = Math.max(first, ...hits.map(l => l.n))
  // the pages read around where the window stands (the first, the page term.ts loadPanel read for the cited lines),
  // and the page of the cited lines, so the window has rows while the page it moved to is read
  const stand = Math.floor(citeTops.get(key) ?? Math.max(1, first - 10))
  const known = new Map<number, string>()
  const held: number[] = []
  let total = 0
  const pages: number[] = []
  for (let at = citePage(stand - room - 100); at <= citePage(stand + 2 * room + 100); at += 100) pages.push(at)
  if (!pages.includes(citePage(first - 10))) pages.push(citePage(first - 10))
  for (const at of pages) {
    const got = await surfaceValue<Obj>(cx, `file:${path}:${at}`)
    if (!got?.ok || got.value.binary) continue
    const page = got.value
    if (typeof page.total_lines === 'number') total = Math.max(total, page.total_lines)
    const from = typeof page.start === 'number' ? page.start : at
    held.push(from)
    ;((Array.isArray(page.records) ? page.records : []) as unknown[]).forEach((r, i) => known.set(isObj(r) && typeof r.line === 'number' ? r.line : from + i, aroundLine(r)))
  }
  if (!held.length) return null
  // once the window moved (a key, the wheel, a click: never while it is drawn, which writes nothing), the page of each
  // line a window's height above or below where it stands that no page read holds, read once, so a line or a page more
  // is there as it moves on
  const readAround = (to: number) => {
    for (const l of [Math.max(1, to - room), to, to + 2 * room]) {
      const at = citePage(l)
      const k = `file:${path}:${at}`
      if ((total && l > total) || held.some(h => h <= l && l < h + 200) || citeReading.has(k)) continue
      citeReading.add(k)
      void (async () => {
        if (!(await surfaceValue(cx, k))) await readFilePage(cx, path, at)
        citeReading.delete(k)
        await cx.bumpPanel()
      })()
    }
  }
  // the lines around the cited ones as the check read them; then the run of lines without a gap where the window
  // stands (a page not read yet ends it), the cited record over its rows in its place when the run holds it
  for (const l of v.lines) if (!l.hit && l.n > 0) known.set(l.n, l.text)
  for (let n = first; n <= last; n++) if (!known.has(n)) known.set(n, '')
  const anchor = !citeTops.has(key) ? first : known.has(stand) ? stand : [...known.keys()].reduce((a, n) => (Math.abs(n - stand) < Math.abs(a - stand) ? n : a))
  let lo = anchor
  let hi = anchor
  while (known.has(lo - 1)) lo--
  while (known.has(hi + 1)) hi++
  const rows: WinRow[] = []
  const ctx = (n: number): WinRow => ({ at: n, line: n, n, text: known.get(n)!, hit: false, spans: [] })
  for (let n = lo; n <= Math.min(hi, first - 1); n++) rows.push(ctx(n))
  if (first >= lo && last <= hi) {
    let rec = first
    let part = 0
    for (const l of hits) {
      if (l.n) {
        rec = l.n
        part = 0
      }
      rows.push({ at: rec + part++ / 1000, line: rec, n: l.n, text: l.text, hit: true, spans: l.spans ?? [] })
    }
  }
  for (let n = Math.max(lo, last + 1); n <= hi; n++) rows.push(ctx(n))
  total = Math.max(total, rows.at(-1)!.line)
  const gutter = String(total).length
  const textRoom = Math.max(10, cols - gutter - 4)
  const hitRows = Math.max(3, Math.min(8, Math.floor(((e.props.scroll?.bodyRows || 20) - 14) / Math.max(1, hits.length))))
  const whole = wholeLit(hits, quote)
  // each row as the lines it takes: a line around the cited ones on one dim row, cut around its start; a cited row
  // wrapped over up to `hitRows` rows around its value
  const linesOf = (r: WinRow): Line[] => {
    const text = demojibake(r.text).replace(/\t/g, '  ')
    const n = r.n ? String(r.n).padStart(gutter) : ' '.repeat(gutter)
    if (!r.hit) return [pointed([dim(`  ${n}  `), dim((text.length > textRoom ? windowAt(text, 0, textRoom).text : text) || ' ')], false)]
    const spans = r.spans.map(([a, b]) => [shifted(r.text, a!), shifted(r.text, b!)] as [number, number])
    const span: [number, number] | null = quote ? quoteSpan(text, quote) : (spans[0] ?? (whole ? [0, text.length] : null))
    return wrapAround(text, span, textRoom, hitRows).map((w, i) =>
      pointed([{ s: `  ${i === 0 ? n : ' '.repeat(gutter)}  ` }, ...(w.hi ? [{ s: w.text.slice(0, w.hi[0]) }, { s: w.text.slice(w.hi[0], w.hi[1]), bg: COLORS.selected }, { s: w.text.slice(w.hi[1]) }] : [{ s: w.text || ' ' }])].filter(x => x.s !== ''), false),
    )
  }
  const height = rows.map(r => linesOf(r).length)
  // the last row the window can start at once the file's end is read: the end on its last row
  const endRead = rows.at(-1)!.line >= total
  let maxTop = rows.length - 1
  if (endRead) {
    let sum = height[maxTop]!
    while (maxTop > 0 && sum + height[maxTop - 1]! + (rows[maxTop - 1]!.line > 1 ? 1 : 0) <= room) sum += height[--maxTop]!
  }
  // where it opens: the cited rows a third of the way down, two lines above them at least where they fit
  const block = Math.max(0, rows.findIndex(r => r.hit))
  const blockH = height.slice(block, block + hits.length).reduce((a, b) => a + b, 0)
  const lead = Math.max(0, Math.min(block, Math.max(Math.min(2, room - 2 - blockH), Math.floor((room - 2 - blockH) / 3))))
  const want = citeTops.get(key)
  let top = want === undefined ? block - lead : rows.findIndex(r => r.at >= want)
  if (top < 0) top = rows.length - 1
  top = Math.max(0, Math.min(top, maxTop))
  const out: Line[] = []
  const outHits: LineHit[] = []
  const page = Math.max(1, room - 3)
  // where the window stands among the rows (below 0 or past the last: lines not read yet), moved by each key and turn
  // of the wheel until the panel draws again, never above the file's first line or past where its end shows
  let pos = top
  const scroll = (by: number) => {
    pos = Math.max(1 - rows[0]!.line, Math.min(pos + by, endRead ? maxTop : rows.length - 1 + total - rows.at(-1)!.line))
    const at = pos < 0 ? rows[0]!.line + pos : pos < rows.length ? rows[pos]!.at : rows.at(-1)!.line + pos - (rows.length - 1)
    citeTops.set(key, at)
    readAround(Math.floor(at))
  }
  const countRow = (words: string, by: number) => {
    outHits.push({ y: out.length, x0: MARGIN_W + 2, x1: MARGIN_W + 2 + width(words), row: false, run: () => scroll(by) })
    out.push(pointed([{ s: '  ' }, dim(words)], false))
  }
  const above = rows[top]!.line - 1
  if (above > 0) countRow(`↑ ${num(above)} more`, -page)
  let shownLast = top - 1
  for (let i = top; i < rows.length; i++) {
    const ls = linesOf(rows[i]!)
    // a row below for `↓ N more` unless this is the file's last
    const left = room - out.length - (i === rows.length - 1 && endRead ? 0 : 1)
    if (ls.length > left && i > top) break
    out.push(...ls.slice(0, Math.max(1, left)))
    shownLast = i
    if (ls.length > left) break
  }
  const below = total - rows[shownLast]!.line + (shownLast < rows.length - 1 && rows[shownLast + 1]!.line === rows[shownLast]!.line ? 1 : 0)
  if (below > 0) countRow(`↓ ${num(below)} more`, page)
  const onKey = (k: string) => {
    if (k === 'up' || k === 'k') return scroll(-1)
    if (k === 'down' || k === 'j') return scroll(1)
    if (k === 'pageup') return scroll(-page)
    if (k === 'pagedown') return scroll(page)
    return undefined
  }
  scrollDrawing = scroll
  return { el: linesEl(cx, e, marginKey('cite-lines'), out, outHits, cols + MARGIN_W, onKey), scrolls: above > 0 || below > 0 }
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

/** A card whose cited table or bar row is past the rows drawn, that row in place of the last one drawn (a bar's label
 *  with each of its groups' rows). */
function withCitedRow(card: CardData, v: TermVerdict): CardData {
  const cap = card.kind === 'table' ? MAX_TABLE_ROWS : card.kind === 'bar' || card.kind === 'label' ? MAX_BARS : 0
  const all = card.rows ?? []
  if (!cap || all.length <= cap || !v.row) return card
  if (card.kind !== 'table') {
    const bars = all as BarRow[]
    const labels = [...new Set(bars.map(b => b.label))]
    const at = labels.findIndex(l => sameKey(l, v.row!))
    if (at < cap) return card
    const keep = new Set([...labels.slice(0, cap - 1), labels[at]!])
    return { ...card, rows: bars.filter(b => keep.has(b.label)) as CardData['rows'] }
  }
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

/** The sentence a citation stands in, its value blue and underlined (a chip blue, `[ card ]`), in quotation marks. */
function sourceSegs(sentence: string, c: Citation): Line {
  const flat = plainCites(sentence).replace(/\s+/g, ' ').trim()
  // a citation written without words stands in the sentence as its chip (`[ revisions.jsonl line 1 ]`)
  const shown = c.display ?? citeLabel(c)
  const at = shown ? flat.indexOf(shown) : -1
  // in quotation marks of the kind its words do not hold (lib.ts quoted)
  const [open, close] = quoted(flat) === flat ? ['', ''] : flat.includes('"') ? ['“', '”'] : ['"', '"']
  if (at < 0) return [{ s: `${open}${flat}${close}` }]
  return [{ s: `${open}${flat.slice(0, at)}` }, c.display === null ? { s: shown, fg: LINK } : linkSeg(shown), { s: `${flat.slice(at + shown.length)}${close}` }]
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
      key={fieldKey(`follow-${cid(tid)}`)}
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
  // a place cited with no words keeps its line where its path is cut (`…/agent-ad502eca.jsonl line 20`)
  const label = c.display === null && fileRef(c.ref) ? cutRef(c.ref, Math.max(8, cols - 6)) : cut(await citeTitle(cx, c), Math.max(8, cols - 6))
  // the takeaway's card's links check, as the chat marks the citation: ◌ while it runs, ✓ once a script got the value, a
  // red × when it got another
  const check = p.of ? linkCheck((await cx.card(p.of))?.links, c) : {}
  const look = chipLook(status, undefined, check.state)
  const bad = red || look.state === 'failed'
  const mark: Seg | null = !v || look.spin ? { s: ' ◌' } : bad ? { s: ' ×', fg: COLORS.problem } : look.mark ? { s: ` ${look.mark}` } : null
  const titleSegs: Line = [{ s: label, b: true, fg: bad ? COLORS.problem : LINK, u: true }, ...(mark ? [mark] : [])]
  const opens = f ? () => openFile(cx, f.path, Math.max(1, (f.line ?? 1) - 5), f.line) : cardId ? () => openCard(cx, cardId) : null
  const body: RenderElement[] = []
  // the title row's current step: the value as its link, a click on it opening its place
  setHead({ line: titleSegs, key: 'cite-title', ...(opens ? { press: () => void opens() } : {}) })
  const why = red && v?.why ? await plainWhy(cx, v.why) : check.state === 'refuted' && check.why ? await plainWhy(cx, check.why) : ''
  // a citation with no words is titled by its place: its subtitle does not name the place again, and it has none
  // while the place is there
  const bare = c.display === null
  // `from` names the place, unless the title is the place already (a citation written without words)
  const from = outputLine(c.ref) ? await placeName(cx, c.ref) : cardId ? await placeName(cx, `card:${cardId}`) : placeWords(c.ref)
  const rows: [string, RenderElement | string, string?][] = from === (await citeTitle(cx, c)) ? [] : [['from', from]]
  // the subtitle names the place only where no `from` row does: under one, a citation found is `found`
  const status0 = bare ? (!v || status === 'pending' ? '◌ checking' : red ? 'not found' : '') : await citeStatus(cx, c, v, check)
  const said = rows.length && !red ? status0.replace(/^found (?:on the card|in the command's output(?:, line \d+(?:-\d+)?)?|in .+?)(?=;|,|$)/, 'found') : status0
  const sub = [said, why].filter(Boolean).join(' · ')
  if (sub) body.push(lineEl(els, [{ s: sub, fg: bad ? COLORS.problem : COLORS.dim }], 'cite-sub', true))
  body.push(ruleEl(els, cols, 'cite-rule'))
  if (p.sentence) rows.push(['source', lineEl(els, sourceSegs(p.sentence, c), 'cite-source', true)])
  if (rows.length) body.push(fieldEls(els, rows, 'cite')!)
  const quote = p.quote || quotedWords(c.display)
  // a card's cell as the card draws it, the cell lit; lines the card printed as lines, the cited ones lit
  if (v?.card && !v.lines.length) {
    const tc = await cx.card(v.card)
    const card = tc?.data as CardData | null | undefined
    const w = Math.min(cols, 96)
    if (card) {
      const lit = citedLines(card, v, Math.max(10, w - 4), Math.max(8, (e.props.scroll?.bodyRows || 20) - 14))
      body.push(framedCard(cx, e, lit.card, w, lit.lines, 'cite-card'))
    }
  }
  const goOn = await followUpField(cx, e, c.raw)
  let hints = ['a to ask', ...(f ? ['f for its file'] : [])]
  if (!(v?.card && !v.lines.length) && v?.lines.length) {
    // the passage an example quotes, when the cited lines do not hold it
    const quotedRow = quote && status !== 'differs' && !v.lines.some(l => l.hit && quoteSpan(demojibake(l.text).replace(/\t/g, '  '), quote))
    // a file's lines: a window over the whole file, as tall as the rows the panel's other parts leave it (the title
    // row, the subtitle, the rule, the label/value rows, a `quoted` row, the rule, `ask about it`, the follow-up field
    // and the hint rows)
    const fieldW = Math.max(0, ...rows.map(([k]) => width(k))) + 2
    const tall = (words: string, w: number) => (words ? wrapRows(words, Math.max(1, w), 999).length : 0)
    const used =
      2 +
      tall(sub, cols) +
      rows.reduce((n, [k, val]) => n + tall(typeof val === 'string' ? val : k === 'source' && p.sentence ? sourceSegs(p.sentence, c).map(x => x.s).join('') : ' ', cols - fieldW), 0) +
      (quotedRow ? tall(clip(demojibake(quote), 600), cols - 8) : 0) +
      2 +
      (goOn ? 1 : 0) +
      hintHeight(['↑↓ to scroll', ...hints], cols)
    const win = v.path && typeof v.line === 'number' ? await citeWindow(cx, e, c.ref, v, cols, quote, Math.max(5, (bodyRows || 30) - used)) : null
    if (win?.scrolls) hints = ['↑↓ to scroll', ...hints]
    body.push(win?.el ?? <Box key="cite-lines" flexDirection="column">{lineRows(cx, e, v, cols, quote)}</Box>)
    if (quotedRow) body.push(fieldEls(els, [['quoted', <Text wrap="wrap" backgroundColor={COLORS.selected}>{clip(demojibake(quote), 600)}</Text>]], 'cite-quoted')!)
  } else if (!v) body.push(<Text key="cite-wait" dimColor>◌ checking</Text>)
  const ask = () => void openAsk(cx, target, p.sentence ? { anchorText: plainCites(p.sentence) } : {})
  const keys: Key[] = [{ key: 'ask', hotkey: 'a', onPress: ask }, ...(f ? [{ key: 'files', hotkey: 'f', onPress: () => void opens?.() }] : [])]
  body.push(...bottomRows(cx, e, cols, [<Button key="cite-ask" label="ask about it" plain onPress={ask} />], [goOn], hints))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// ------------------------------------------------------------------------------------------------ a thread's subject

// the rows of a side thread's subject shown before its `… N more`
const SUBJECT_ROWS = 6
// the subjects shown whole, by their key (a thread's id, or a new thread's anchor): `… N more` shows one whole
const subjectWhole = new Set<string>()

/** What a side thread is about: its anchor (a card, a value on one, a file's line, a document's passage, none for words
 *  on screen), the words it was asked about, and the card a new thread asks about. */
type Subject = { anchor: string; text: string; card?: string; lit?: string }

/** Whether words that name a thread's subject (`about "…"`) hold its passage whole, which then is not drawn again. */
function saidIn(about: string, words: string): boolean {
  const flat = plainCites(words).replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return Boolean(flat) && about.includes(flat)
}

/** A passage's words as rows of `cols` cells: each line of it wrapped, a Markdown heading bold without its marks, the
 *  marks of bold, italic and code left out, citations as their words, blank lines left out. */
function passageRows(text: string, cols: number): Line[] {
  const out: Line[] = []
  for (const raw of plainCites(text).replace(/\[([^\[\]\n]*)\]\([^()\s]*\)/g, '$1').split('\n')) {
    const head = /^#{1,6}\s+/.test(raw)
    const words = raw.replace(/^#{1,6}\s+/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
    if (!words) continue
    for (const r of wrapRows(words, Math.max(10, cols), 999)) out.push([{ s: r, ...(head ? { b: true } : {}) }])
  }
  return out
}

/** The thing a side thread is about, above its chat and its field for as long as the thread shows (Matt, 2026-10-07:
 *  "keep that thing above the chat so I know what I'm referencing"): a card in its frame, a value cited on it lit; a
 *  file's cited line with up to two lines on each side, as the citation panel draws lines; a passage or a quote as its
 *  words. At most SUBJECT_ROWS rows of it, then `… N more`, which shows it whole; never `… 1 more`. */
async function subjectEls(cx: Ctx, e: PaneEvent, s: Subject, cols: number, key: string): Promise<RenderElement[]> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const whole = subjectWhole.has(key)
  const showAll = () => {
    subjectWhole.add(key)
    void cx.bumpPanel()
  }
  const moreEl = (n: number) => (
    <Box key={`subject-more-row-${key}`} flexDirection="row">
      <Button key={`subject-more-${key}`} label={`… ${num(n)} more`} plain dimColor onPress={showAll} />
    </Box>
  )
  const anchor = (s.anchor ?? '').split(',')[0] ?? ''
  const cardId = s.card || /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(anchor)?.[1] || ''
  if (cardId) {
    const data = (await cx.card(cardId))?.data as CardData | null | undefined
    const at = s.lit || (anchor.includes('#') ? anchor : '')
    const focus = data && at ? focusFromRef(data, at.replace(/^cell:/, 'card:')) : undefined
    const card = await cardBlock(cx, e, cardId, cols, `subject-${cid(key)}`, { ...(focus ? { focus } : {}), ...(whole ? {} : { clip: { rows: SUBJECT_ROWS, more: showAll } }) })
    return [
      <Box key={`subject-${key}`} flexDirection="column">
        {card}
      </Box>,
    ]
  }
  if (subjectFile(anchor)) {
    const c = { raw: `[[${anchor}]]`, ref: anchor, display: null }
    const v = await cx.verdict(cid(c.raw))
    if (!v) {
      queueCitations([c])
      return [<Text key={`subject-${key}`} dimColor>◌ reading its lines</Text>]
    }
    if (v.lines.length) {
      // the cited lines and two on each side; the others the citation read too once shown whole
      const first = v.lines.findIndex(l => l.hit)
      const last = v.lines.length - 1 - [...v.lines].reverse().findIndex(l => l.hit)
      const near = first < 0 ? v.lines : v.lines.filter((_l, i) => i >= first - 2 && i <= last + 2)
      const all = lineRows(cx, e, v, cols, '')
      const some = lineRows(cx, e, { ...v, lines: near }, cols, '')
      // never `… 1 more`: one row past them is drawn
      const rows = whole || all.length - Math.min(some.length, SUBJECT_ROWS) < 2 ? all : some
      const cutAt = rows === all || rows.length <= SUBJECT_ROWS + 1 ? rows.length : SUBJECT_ROWS
      const hidden = all.length - cutAt
      return [
        <Box key={`subject-${key}`} flexDirection="column">
          {rows.slice(0, cutAt)}
        </Box>,
        ...(hidden >= 2 ? [moreEl(hidden)] : []),
      ]
    }
  }
  const lines = passageRows(s.text, cols)
  if (!lines.length) return []
  const cutAt = whole || lines.length <= SUBJECT_ROWS + 1 ? lines.length : SUBJECT_ROWS
  return [
    <Box key={`subject-${key}`} flexDirection="column">
      {lines.slice(0, cutAt).map((l, i) => lineEl(els, l, `subject-${key}-${i}`))}
    </Box>,
    ...(cutAt < lines.length ? [moreEl(lines.length - cutAt)] : []),
  ]
}

// ------------------------------------------------------------------------------------------------ a new thread

let asking = ''

/** A new side thread (SPEC.md, section 7, "The threads panel", a thread with no question yet): `about <what>`
 *  as its dim subtitle, what it is about (subjectEls: the card, the cited lines, the passage), then the `ask` field,
 *  which has the keys. */
async function drawAsk(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  if (e.surface === 'mobile') return none(cx, e, 'A side thread needs a surface with text fields.')
  const els = cx.els(e) as El
  const { Box, Text, Input } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  // a citation's words in quotation marks, as every subject (aboutName); a citation with no words by its place, as it
  // shows; a card and a passage come quoted already
  const cited = p.target?.kind === 'citation' ? citationOf(p.target) : null
  const about = cited?.display && p.about ? subjectWords(p.about) : (p.about ?? 'this')
  const body: RenderElement[] = [...headerEls(els, { title: 'New thread', cols, sub: subLine([`about ${about}`]) })]
  // what it is about, above the field: the card, the cited lines, the passage (its words, unless the subtitle holds them)
  const words = p.target?.kind === 'card' ? '' : p.anchorText ?? ''
  const said = saidIn(p.about ?? '', words)
  const lit = p.target?.kind === 'mark' && p.target.ref ? { lit: p.target.ref } : {}
  body.push(...(await subjectEls(cx, e, { anchor: p.anchor ?? '', text: said ? '' : words, ...(p.target?.kind === 'card' && p.target.cardId ? { card: p.target.cardId } : {}), ...lit }, cols, `ask:${p.anchor ?? ''}:${cid(words)}`)))
  if (asking) body.push(<Text key="ask-state" {...(asking.startsWith('×') ? { color: COLORS.problem } : { dimColor: true })}>{asking}</Text>)
  // the field alone, its placeholder saying what it takes: Enter's word (`⏎ ask`) is the only `ask`
  const field = (
    <Box key="ask-row" flexDirection="row">
      <Input
        key={fieldKey('ask-new')}
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
            // the thread takes the form's place on the way, so back leads where the form was asked from (live check
            // term-fix9, quirk 12: back from a thread just asked showed an empty form)
            if ('id' in got) await openThread(cx, got.id, q, { replace: true })
            else await cx.bumpPanel()
          })()
        }}
      />
    </Box>
  )
  // the header's rule stands alone when nothing comes between it and the field: no second rule right under it
  const between = body.length > headerEls(els, { title: 'New thread', cols, sub: subLine(['x']) }).length
  body.push(...bottomRows(cx, e, cols, [], [field], ['Enter to ask'], between, 'ask-new'))
  return <Box flexDirection="column">{body}</Box>
}

// ------------------------------------------------------------------------------------------------ threads

/** A thread as the tree and the panel read it: its chat when read, else its row's question. */
async function threadOfRow(cx: Ctx, id: string): Promise<ChatThread | null> {
  const row = (await cx.threads()).find(t => t.id === id)
  const tt: TermThread | undefined = await cx.thread(id)
  if (tt && tt.events.length) return { ...threadOf(tt.meta, tt.events), ...(row?.parent && row.parent !== 'main' ? { parent: row.parent } : {}) }
  if (!row) return null
  // until its chat is read, its turn holds the state its row gives: answered, stopped, failed or running, never words
  // (live check term-fix6, new quirk 9: every row read `answered` for a few seconds, a stopped thread's too)
  const turn = row.running ? { state: 'running' } : row.turn === 'stopped' ? { state: 'error', stopped: true } : row.turn === 'failed' ? { state: 'error' } : row.turn === '' ? { state: 'running' } : { state: 'done' }
  return { id, label: row.anchorText || row.title, ref: row.anchor, context: '', agentId: '', engine: '', turns: [{ q: row.question || row.title, a: '', tools: 0, partial: '', ...turn }], file: '', parent: row.parent === 'main' ? '' : row.parent, at: Date.parse(row.at) || 0, loading: true }
}

/** A thread title as thimble makes one from the anchor's words when none is given (agents._title_from): its first four
 *  words, lower case, joined by '-'. */
function slugOf(text: string): string {
  return (text.slice(0, 80).match(/[A-Za-z0-9]+/g) ?? []).slice(0, 4).join('-').toLowerCase()
}

type AboutRow = { anchor: string; anchorText: string; title?: string; element?: string }

/** A citation's words as a thread's subject: in quotation marks, as someone's words are; a value alone (`4579`) as it
 *  is written. */
function subjectWords(words: string): string {
  return /^[\d.,%\s−-]+$/.test(words) ? words : quoted(words)
}

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
  // a citation's words in quotation marks; a chip by its place in words (`agent-chat.jsonl line 2`), as its thread was
  // titled (gestures.tsx targetLabel)
  const chip = { raw: `[[${a}]]`, ref: a, display: null }
  if (t && t !== slug && !t.startsWith(`${slug}-`)) return t === chipName(chip) || t === chipLabel(chip) ? t : subjectWords(t)
  return /^(?:card|cell):/.test(a) ? placeName(cx, a) : placeWords(a)
}

/** What a thread was asked about, in words: a card or a citation by its name (anchorName), else its passage's words. */
export async function aboutName(cx: Ctx, row: AboutRow | undefined): Promise<string> {
  if (!row) return ''
  // a thread asked about a whole answer (its footer's `ask about this answer`)
  if (row.element === ANSWER_ELEMENT) return 'this answer'
  const named = await anchorName(cx, row)
  if (named) return named
  if (row.anchorText) return quoted(clip(plainCites(row.anchorText).replace(/\s+/g, ' ').trim(), 60))
  if (/^report:/.test(row.anchor)) return `the report's passage`
  return ''
}

/** The first line of a thread's latest answer, or what it is doing. */
function threadLine(t: ChatThread): Seg {
  const last = t.turns.at(-1)
  if (!last) return dim('nothing asked yet')
  if (last.state === 'running') return dim(`◌ ${plural(last.tools, 'tool call')}`)
  if (last.state === 'error') return stoppedTurn(last) ? dim('stopped') : { s: `× ${plainCites(last.a).split('\n')[0] || 'failed'}`, fg: COLORS.problem }
  const done = [...t.turns].reverse().find(x => x.state === 'done' && x.a.trim())
  const first = plainCites(done?.a ?? '').replace(/^#+\s*/gm, '').split('\n').find(l => l.trim()) ?? ''
  // an answer not read yet shows nothing until it is
  return dim(first.replace(/\*\*|__|`/g, '').trim() || (t.loading ? '' : 'answered'))
}

// the threads whose answer is being handed back to main, until `thimble act hand-back` answers
const handing = new Set<string>()

/** Hand thread `id`'s answer back to main once (handBack), the panel saying so meanwhile; a refusal is a toast. */
async function handOver(cx: Ctx, id: string): Promise<void> {
  if (handing.has(id)) return
  handing.add(id)
  await cx.bumpPanel()
  try {
    const err = await handBack(cx, id)
    if (err) cx.toast(`thimble: the answer was not handed back: ${err}`)
  } finally {
    handing.delete(id)
    await cx.bumpPanel()
  }
}

/** The threads panel (SPEC.md, section 7, "The threads panel"): its title and a dim subtitle; under the rule the
 *  tree, a root per place a thread was asked from (`main`, or `report "…"`) with a blank row between them, each thread
 *  under the thread it was asked from, its question in quotation marks with guides, the first line of its latest
 *  answer dim under it, `N questions` dim and `new` in green at R; the selected thread (`❯`, accent) under the second
 *  rule: what it is about, its questions and answers drawn as main's chat draws a reply, `stop` (s) while it answers,
 *  `hand back to main` (h) once its run ended with an answer, then the `ask` field. ↑↓ or j k choose, Enter or a give
 *  the field the keys, 1-9 open the first nine. */
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
    lines.push(pointed([{ s: place === 'main' ? 'main' : `report ${quoted(clip(docTitle(place.slice(7)), 60))}` }], false))
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
  // the module's own move of the ring raises no ui.focus: the hint row names the field's keys once the ring is there
  // (live check term-fix8, quirk 7: the hint still named b while a typed b went into the field)
  const focusAsk = async () => {
    if (!askKey || !(await cx.focus(askKey))) return
    rt.panelFocus = askKey
    await cx.bumpPanel()
  }
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
  // whether the thread's answer can be handed back to main (backend threads.hand_back_state): `offer` once its run ended
  // with one, `handed` once it was
  const handState = t && !running ? str((await cx.thread(t.id))?.meta?.hand_back) : ''
  const hand = t && handState === 'offer' && rt.sc && !handing.has(t.id) ? () => void handOver(cx, t.id) : null
  if (t) {
    body.push(ruleEl(els, cols, 'rule-thread'))
    // what it is about, dim, then the thing itself (a passage's words unless `about` holds them whole), above its first
    // question
    const row = rows.find(r => r.id === t.id)
    const about = await aboutName(cx, row)
    if (about) body.push(<Text key="thread-about" dimColor wrap="truncate-end">{cut(`about ${about}`, cols)}</Text>)
    const words = row?.anchorText ?? ''
    if (row) body.push(...(await subjectEls(cx, e, { anchor: row.anchor ?? '', text: saidIn(about, words) ? '' : words }, cols, t.id)))
    let k = 0
    for (const turn of t.turns) {
      k++
      if (k > 1) body.push(<Text key={`thread-gap-${k}`}> </Text>)
      body.push(<Text key={`thread-q-${k}`} wrap="wrap">{quoted(plainCites(turn.q))}</Text>)
      if (turn.state === 'running') {
        const partial = turn.partial.trim()
        body.push(<Text key={`thread-run-${k}`} dimColor wrap="truncate-end">{cut(`◌ ${plural(turn.tools, 'tool call')}${partial ? ` · ${clip(partial, cols - 30)}` : ''}`, cols)}</Text>)
      } else if (stoppedTurn(turn)) body.push(<Text key={`thread-err-${k}`} dimColor wrap="wrap">{turn.a.trim().replace(/([^.!?])$/, '$1.')}</Text>)
      else if (turn.state === 'error') body.push(<Text key={`thread-err-${k}`} color={COLORS.problem} wrap="wrap">{`× ${turn.a}`}</Text>)
      else if (turn.a.trim()) body.push(<Box key={marginKey(`thread-answer-${k}`)} flexDirection="column">{await drawReply(cx, e, turn.a, cols, { margin: PANEL_MARGIN, prefix: `t${k}-`, ask: tgt => void openAsk(cx, tgt), open: id => void openThread(cx, id) })}</Box>)
      // the cards the turn made, under its answer, each in its frame, as main's chat draws a turn's cards
      for (const [ci, id] of (turn.cards ?? []).entries()) body.push(<Box key={`thread-card-${k}-${ci}`} flexDirection="column">{await cardBlock(cx, e, id, cols, `th${k}-${ci}`, { order: ci + 1 })}</Box>)
    }
    if (stop) {
      body.push(controlsEl(els, [<Button key="thread-stop" label="stop" plain onPress={stop} />], 'thread-controls')!)
      keys.push({ key: 'stop', hotkey: 's', onPress: stop })
    }
    // a finished answer goes back to main only when the analyst asks: `hand back to main` (h) sends it as their message,
    // then the panel says so until a later question's answer can be handed back
    if (handState === 'offer' && handing.has(t.id)) body.push(<Text key="thread-handing" dimColor>◌ handing back to main</Text>)
    else if (hand) {
      body.push(controlsEl(els, [<Button key="thread-hand-back" label="hand back to main" plain onPress={hand} />], 'thread-controls')!)
      keys.push({ key: 'hand-back', hotkey: 'h', onPress: hand })
    } else if (handState === 'handed') body.push(<Text key="thread-handed" dimColor>handed back to main</Text>)
    // the field for the next question, a blank row under the answer, its placeholder saying what it takes
    body.push(
      <Box key="ask-row" flexDirection="row" marginTop={1}>
        <Input
          key={fieldKey(askKey)}
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
  body.push(hintsRow(els, ['↑↓ to choose', ...(t ? ['Enter or a to ask'] : []), ...(stop ? ['s to stop'] : []), ...(hand ? ['h to hand back'] : [])], cols))
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

// the label whose delete the label panel asks about (`delete label "…"? … y to delete · n to keep`), '' for none
let labelDeleting = ''
// the label whose name the label panel's `rename` field edits, '' for none
let labelRenaming = ''
// the value whose colors the label panel's counts show under it (`<label>\n<value>`), '' for none
let labelPainting = ''

/** The label panel, after the browser's label editor (SPEC.md, section 7, "The label panel"): its header block,
 *  the label's name in the accent and bold after a ● in its colour, its type (prompt, regex or code: the one in use on
 *  the selection background) and its scope (the files, editable, and how many records), then the rule; the prompt (or
 *  pattern or code) in a field to edit, Enter saving it (`thimble act label`); `run on a sample` and `run on all N`,
 *  which save what was typed first and run it (`thimble act label-run`), `rename` (`thimble act label`) and `delete`,
 *  which asks once in the panel (y deletes, n keeps; `thimble act label-delete`); a label over files is turned on or off
 *  in Files and the views (`in files: on off`, `thimble act label-show`). Then `▸ counts`, `▸ examples` and `▸ cards`,
 *  folded, nothing of them shown until one is opened: each value's `color` (the label colors by name) and `filter`
 *  (`thimble act label-filter`) in the counts, the held-out agreement and `… N more` records in the examples. */
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
  // a delete asked about another label is not asked here, nor a rename or a value's colors
  if (labelDeleting !== id) labelDeleting = ''
  if (labelRenaming !== id) labelRenaming = ''
  if (!labelPainting.startsWith(`${id}\n`)) labelPainting = ''
  const ui = await cx.labelUi()
  const running = ui.runs[id]
  const said = ui.said[id] ?? ''
  // the counts as thimble.labels() reads the rows, each record the analyst set to another value under that value
  // (live check term-fix5, new quirk 5: one record set to `no` left the counts at 33/467)
  const counts = l.verdicts?.counts ?? l.label_stats?.counts ?? {}
  const setByYou = l.verdicts?.set ?? 0
  const values = [...(l.labels ?? []), ...Object.keys(counts).filter(k => !(l.labels ?? []).includes(k))]
  const kind = ui.kind[id] ?? l.kind ?? 'prompt'
  const files = !l.unit || ['record', 'agent', 'run'].includes(l.unit)
  // each value's color as its class has it (the browser's label colors), else in the values' order
  const colors = classColors(l.classes)
  const shownOn = Boolean(l.shown)
  const filtered = typeof l.filter === 'string' && l.filter ? l.filter : ''
  const last = l.last_run ?? l.applications?.at(-1) ?? null
  // the records its scope holds: its last full run's count, else the count `thimble state` gives a label with no run
  // that ended (live check term-fix10, low quirk: `run on all` and `scope: pages.jsonl` showed no number after a first
  // run stopped part way)
  const scopeN = typeof last?.matched_total === 'number' ? last.matched_total : typeof last?.total === 'number' && !l.trial ? last.total : typeof l.scope_total === 'number' ? l.scope_total : null
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
  // delete: asked once in the panel (labelDeleting), then `thimble act label-delete` and the labels list
  const askDelete = async () => {
    labelDeleting = id
    await cx.bumpPanel()
  }
  const keepIt = async () => {
    labelDeleting = ''
    await cx.bumpPanel()
  }
  const deleteIt = async () => {
    if (labelDeleting !== id) return
    labelDeleting = ''
    await deleteLabel(cx, id, name)
  }
  const rows: RenderElement[] = []
  const keys: Key[] = []
  // rename: a field in the run row's place, Enter saving the name (`thimble act label`)
  const askRename = async () => {
    labelRenaming = id
    labelDeleting = ''
    await cx.bumpPanel()
  }
  const keepName = async () => {
    labelRenaming = ''
    await cx.bumpPanel()
  }
  const rename = async (v: string) => {
    const next = v.replace(/\s+/g, ' ').trim()
    if (!next || next === name) return keepName()
    labelRenaming = ''
    await saveLabel(cx, id, { name: next })
  }
  // on or off in Files and the views, as the Labels pane's toggle (`thimble act label-show`)
  const turn = (on: boolean) => async () => {
    if (on !== shownOn) await showLabel(cx, id, { on })
  }
  // the header block: name, type, scope, each on the label column, as Matt wrote them (`name:`), and for a label over
  // files whether it is on in Files; then the definition
  const L = (files ? 'in files:' : 'pattern:').length + 2
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
  rows.push(fieldLine('name:', lineEl(els, [{ s: '●', fg: labelHue(values, colors) }, { s: ' ' }, { s: name, fg: ACCENT, b: true }], undefined, true)))
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
            <Input key={fieldKey(`lb-glob-${id}`)} value={drafts.get(`${id}:glob`) ?? l.glob ?? ''} submitLabel="save" onInput={v => void drafts.set(`${id}:glob`, v)} onSubmit={v => void (v.trim() ? save({ glob: v.trim() }) : undefined)} />
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
  // on or off in Files and the views: the one in use on the selection background, the other a click away
  if (files)
    rows.push(
      fieldLine(
        'in files:',
        <Box flexDirection="row" columnGap={2}>
          {([true, false] as const).map(on =>
            on === shownOn ? (
              <Text key={`lo-${on ? 'on' : 'off'}`} backgroundColor={COLORS.selected}>{on ? 'on' : 'off'}</Text>
            ) : (
              <Button key={`lo-${on ? 'on' : 'off'}`} label={on ? 'on' : 'off'} plain onPress={() => void turn(on)()} />
            ),
          )}
        </Box>,
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
  // run it: on a sample, or on every record; they save what was typed first. Its state as home, the list and its card
  // say it (lib.ts labelState): a run main's chat follows is `◌ labeling 3,000 of 4,579` here too, and a first run
  // stopped part way `stopped at 3,150 of 4,579`, never `not run yet` beside its counts (live check term-fix9, quirk 4)
  const agents = (await cx.agents()) ?? []
  const st = labelState(l, agents)
  const lastWords = last ? (l.trial || last.limit ? `last run on a sample of ${num(last.labeled ?? 0)}` : `last run on all ${num(last.labeled ?? 0)}`) : labelStateWords(st)
  // the run main's chat follows, which a stop of that chat stops (as the agent panel's stop)
  const follower = !running && st.running ? agents.find(a => a.role === 'labels' && a.state === 'running' && a.label === `label ${name}`) : undefined
  const stop = follower && rt.sc ? () => void act(cx, rt.sc!, 'stop', { agent: follower.chat || follower.name, name: follower.name }) : () => void stopLabel(cx, id)
  if (running)
    rows.push(
      <Box key="lb-running" flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text>{`◌ labeling ${running.limit ? `a sample of ${num(running.limit)}` : `all ${scopeN !== null ? num(scopeN) : ''} ${unit}`.replace(/\s+/g, ' ')}`}</Text>
        <Button key="lb-stop" label="stop" plain onPress={stop} />
      </Box>,
    )
  else if (st.running)
    rows.push(
      <Box key="lb-running" flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text>{labelStateWords(st)}</Text>
        {follower ? <Button key="lb-stop" label="stop" plain onPress={stop} /> : null}
      </Box>,
    )
  else if (labelRenaming === id && e.surface !== 'mobile')
    // the name in a field, in the run row's place: Enter renames, `keep the name` leaves it
    rows.push(
      <Box key="lb-rename" flexDirection="row">
        <Text dimColor>{'new name  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Input key={fieldKey(`lb-name-${id}`)} value={name} autoFocus submitLabel="rename" onSubmit={v => void rename(v)} />
        </Box>
        <Text>{'  '}</Text>
        <Button key="lb-rename-keep" label="keep the name" plain onPress={() => void keepName()} />
      </Box>,
    )
  else if (labelDeleting === id)
    // the delete asks once, in the run row's place: y deletes, n keeps
    rows.push(
      <Box key="lb-delete" flexDirection="row" flexWrap="wrap">
        <Text>{`delete label "${name}"? its marks and card go too · `}</Text>
        <Button key="lb-delete-yes" label="y to delete" plain onPress={() => void deleteIt()} />
        <Text>{' · '}</Text>
        <Button key="lb-delete-no" label="n to keep" plain onPress={() => void keepIt()} />
      </Box>,
    )
  else
    rows.push(
      <Box key="lb-runs" flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="lb-sample" label="run on a sample" plain onPress={() => void run(sample)()} />
        <Button key="lb-all" label={scopeN !== null ? `run on all ${num(scopeN)}` : 'run on all'} plain onPress={() => void run(0)()} />
        <Button key="lb-rename" label="rename" plain onPress={() => void askRename()} />
        <Button key="lb-delete" label="delete" plain onPress={() => void askDelete()} />
        <Text dimColor>{lastWords}</Text>
      </Box>,
    )
  // what the last save or run said: `×` and `!` rows in red
  said.split('\n').filter(Boolean).forEach((line, i) => rows.push(<Text key={`lb-said-${i}`} wrap="wrap" {...(/^[×!]/.test(line) ? { color: COLORS.problem } : { dimColor: true })}>{line}</Text>))
  const asking = labelDeleting === id && !running && !st.running
  const renaming = labelRenaming === id && !running && !st.running
  if (asking) keys.push({ key: 'delete-yes', hotkey: 'y', onPress: () => void deleteIt() }, { key: 'delete-no', hotkey: 'n', onPress: () => void keepIt() })
  else if (renaming) {
    // the field takes the letters; its Enter renames
  } else if (!running && !st.running) keys.push({ key: 'sample', hotkey: 'r', onPress: () => void run(sample)() }, { key: 'rename', hotkey: 'n', onPress: () => void askRename() }, { key: 'delete', hotkey: 'k', onPress: () => void askDelete() })
  else if (running || follower) keys.push({ key: 'stop', hotkey: 's', onPress: stop })
  // o turns a label over files on or off in Files
  if (files && !asking && !renaming) keys.push({ key: 'files-on', hotkey: 'o', onPress: () => void turn(!shownOn)() })
  // the counts, the examples and the cards, folded
  const toggle = (part: string, words: string, n: number | null, note = '') => (
    <Box key={`lb-t-${part}`} flexDirection="row">
      <Button key={`lb-open-${part}`} label={`${opened(part) ? '▾' : '▸'} ${words}`} plain onPress={() => void flip(part)()} />
      {n !== null ? <Text dimColor>{`  ${num(n)}${note ? ` · ${note}` : ''}`}</Text> : null}
    </Box>
  )
  const total = values.reduce((a, v) => a + (counts[v] ?? 0), 0)
  rows.push(<Text key="lb-gap"> </Text>)
  rows.push(toggle('counts', 'counts', total, [setByYou ? `${num(setByYou)} set by you` : '', filtered ? `filtered to ${filtered}` : ''].filter(Boolean).join(' · ')))
  keys.push({ key: 'counts', hotkey: 'c', onPress: () => void flip('counts')() })
  if (opened('counts')) {
    const vw = Math.min(Math.max(12, Math.floor(cols / 3)), Math.max(4, ...values.map(v => width(v))))
    const cs = values.map(v => num(counts[v] ?? 0))
    const pcts = shares(values.map(v => counts[v] ?? 0), total)
    const cw = Math.max(1, ...cs.map(c => c.length))
    // each value's controls after its share: its colors (a label over files, whose colors Files and the views show) and
    // the filter that keeps its units, `clear filter` on the value the filter keeps, a gutter apart, as wide on every row
    const ctlW = (files ? 'color'.length + 2 : 0) + 'clear filter'.length
    // in a pane too narrow for them beside a bar of 8 cells, the controls stand on a row of their own under each value
    const below = cols - 2 - 2 - vw - 2 - 2 - cw - 7 - 2 - ctlW < 8
    const barW = Math.max(8, cols - 2 - 2 - vw - 2 - 2 - cw - 7 - (below ? 0 : 2 + ctlW))
    const paint = (v: string) => async () => {
      labelPainting = labelPainting === `${id}\n${v}` ? '' : `${id}\n${v}`
      await cx.bumpPanel()
    }
    const pick = (v: string, colorName: string) => async () => {
      labelPainting = ''
      await showLabel(cx, id, { colors: { [v]: colorName } })
    }
    values.forEach((v, i) => {
      const n = counts[v] ?? 0
      const w = total ? Math.round((barW * n) / total) : 0
      const colour = valueColour(values, v, colors)
      const tone = colour && colour !== COLORS.dim ? { color: colour } : { dimColor: true }
      const on = filtered === v
      const controls = [
        files ? <Button key={`lb-color-${v}`} label="color" plain onPress={() => void paint(v)()} /> : null,
        files ? <Text key={`lb-gap-${v}`}>{'  '}</Text> : null,
        <Button key={`lb-filter-${v}`} label={on ? 'clear filter' : 'filter'} plain onPress={() => void filterLabel(cx, id, on ? null : v)} />,
      ]
      rows.push(
        <Box key={`lb-c-${v}`} flexDirection="row">
          <Text wrap="truncate-end">
            <Text>{'  '}</Text>
            <Text {...tone}>{'● '}</Text>
            {/* the value a link to the label named, or the one the filter keeps, on the selection background */}
            <Text {...(v === p.value || on ? { backgroundColor: COLORS.selected } : {})}>{clip(v, vw).padEnd(vw)}</Text>
            <Text>{'  '}</Text>
            <Text {...tone}>{'█'.repeat(w)}</Text>
            <Text color={COLORS.rule}>{'─'.repeat(Math.max(0, barW - w))}</Text>
            <Text>{`  ${cs[i]!.padStart(cw)}`}</Text>
            <Text dimColor>{total ? `  ${pcts[i]!.padStart(5)}` : '       '}</Text>
            {below ? null : <Text>{'  '}</Text>}
          </Text>
          {below ? null : controls}
        </Box>,
      )
      if (below)
        rows.push(
          <Box key={`lb-c-${v}-controls`} flexDirection="row" marginLeft={4}>
            {controls}
          </Box>,
        )
      // the label colors under the value whose `color` was pressed, each `●` in its hue and its name, the one it has
      // on the selection background (as show_label names them)
      if (files && labelPainting === `${id}\n${v}`) {
        const now = colors?.[v]
        rows.push(
          <Box key={`lb-colors-${v}`} flexDirection="row" flexWrap="wrap" columnGap={2} marginLeft={4}>
            {COLOR_NAMES.map((c, k) => (
              <Box key={`lb-pick-${v}-${c}`} flexDirection="row">
                <Text color={hueOf(k + 1)}>{'● '}</Text>
                {now === k + 1 ? <Text backgroundColor={COLORS.selected}>{c}</Text> : <Button key={`lb-pick-${v}-${k + 1}`} label={c} plain onPress={() => void pick(v, c)()} />}
              </Box>
            ))}
          </Box>,
        )
      }
    })
    if (!values.length) rows.push(<Text key="lb-c-none" dimColor>{'  none'}</Text>)
    // its values, editable here: Enter saves them
    if (!running && e.surface !== 'mobile')
      rows.push(
        <Box key="lb-values" flexDirection="row" marginLeft={2}>
          <Text dimColor>{'values  '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Input
              key={fieldKey(`lb-values-${id}`)}
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
  // the label's agreement with the values the analyst set, those its runs took as examples apart (the browser's
  // agreement line above its examples)
  rows.push(toggle('examples', 'examples', recs.length, agreementLine(l.calibration)))
  keys.push({ key: 'examples', hotkey: 'e', onPress: () => void flip('examples')() })
  // a record's words: a JSON record as the field the rule reads first, its value in quotation marks and italic, then
  // its other fields on one dim row, never its JSON inside quotation marks; other words in quotation marks, up to three
  // rows
  const room = Math.max(120, (cols - 4) * 3 - 2)
  const recordRows = (ref: string, raw: string, match: string): RenderElement | null => {
    const text = demojibake(raw)
    if (!text.trim()) return null
    const f = recordFields(text, { kind: l.kind ?? '', spec: definitionOf(l), ...(match ? { match } : {}) })
    if (!f) return <Text italic wrap="wrap">{quoted(clip(text, room))}</Text>
    return (
      <Box flexDirection="column">
        {fieldEls(els, f.read.map(([k, v]): [string, RenderElement] => [k, <Text italic wrap="wrap">{quoted(clip(v, room - k.length - 2))}</Text>]), `lx-f-${cid(ref)}`)}
        {f.rest.length ? <Text dimColor wrap="truncate-end">{itemsRow(f.rest.map(([k, v]) => `${k} ${clip(v, 48)}`), Math.max(10, cols - 4))}</Text> : null}
      </Box>
    )
  }
  if (opened('examples')) {
    // the value a link to the label named first, lit
    for (const v of p.value && values.includes(p.value) ? [p.value, ...values.filter(x => x !== p.value)] : values) {
      const xs = recs.filter(r => (typeof r.analyst === 'string' && r.analyst ? r.analyst : str(r.label)) === v)
      if (!xs.length) continue
      rows.push(
        <Text key={`lb-h-${v}`} wrap="truncate-end">
          <Text>{'  '}</Text>
          <Text color={valueColour(values, v, colors)}>{'● '}</Text>
          <Text {...(v === p.value ? { backgroundColor: COLORS.selected } : {})}>{v}</Text>
          <Text dimColor>{`  ${num(Math.max(xs.length, l.totals?.[v] ?? 0))}`}</Text>
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
      // the value's records past those shown, as the browser's examples page through them: a click reads the next
      // MORE_ROWS (`thimble state label --rows`), and the last one with them rather than leave one behind
      const all = l.totals?.[v] ?? 0
      const left = all - xs.length
      if (left > 1) {
        const more = async () => {
          const k = `${id}\n${v}`
          const next = Math.min(all, (labelRows.get(k) ?? xs.length) + MORE_ROWS)
          labelRows.set(k, all - next === 1 ? all : next)
          await readSurface(cx, `label:${id}`, 'label', labelArgs(id))
          await cx.bumpPanel()
        }
        rows.push(
          <Box key={`lb-more-${v}`} flexDirection="row" marginLeft={4}>
            <Button key={`lb-more-${v}`} label={`… ${num(left)} more`} plain onPress={() => void more()} />
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
  // the labels list with this label chosen (live check term-fix10, new quirk 8: it chose the list's remembered row)
  keys.push({ key: 'list', hotkey: 'l', onPress: () => {
    labelPick = l.id || p.label || labelPick
    void openList(cx, { view: 'labels', title: 'Labels' })
  } })
  // the keys that fit one row: the field says how to save it (its placeholder); each folded part's key by what it opens
  rows.push(
    hintsRow(
      els,
      [
        ...(running || follower ? ['s to stop'] : st.running || asking || renaming ? [] : ['r to run a sample', 'n to rename', 'k to delete']),
        ...(files && !asking && !renaming ? [shownOn ? 'o to hide in files' : 'o to show in files'] : []),
        'c counts, e examples, d cards',
        'l for labels',
      ],
      cols,
      renaming ? `lb-name-${id}` : '',
    ),
  )
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...rows]}</Box>
}

// the labels list's chosen row
let labelPick = ''

/** The labels (SPEC.md, "The label panel", the labels list): one row per label, its kind and last run dim at R,
 *  `❯` on the chosen one; under the second rule `describe a new label`, whose words go to main. */
async function drawLabels(cx: Ctx, e: PaneEvent): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Button, Input, Text } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const got = await surfaceValue(cx, 'labels')
  const ls = (got?.ok ? labelsOf(got.value) : []) as LabelFull[]
  const body: RenderElement[] = [...headerEls(els, { title: 'Labels', cols, sub: subLine([plural(ls.length, 'label')]) })]
  const pick = ls.find(x => x.id === labelPick)?.id ?? ls[0]?.id ?? ''
  const agents = (await cx.agents()) ?? []
  const { lines, hits } = listLines(
    ls.map(l => {
      const n = Object.values(l.label_stats?.counts ?? {}).reduce((a, b) => a + b, 0)
      // its runs as home, its panel and its card say them (lib.ts labelState): `◌ labeling 3,000 of 4,579` while a run
      // goes, `stopped at 3,150 of 4,579`, `not run yet`, else what its last run covered (live check term-fix9, quirk 4)
      const st = labelState(l, agents)
      const run = labelStateWords(st).replace(/^◌ /, '') || (l.trial ? `a sample of ${num(n)}` : `all ${num(n)}`)
      return { key: l.id, glyph: st.running ? { s: '◌' } : st.ran || st.stopped ? { s: '●' } : dim('○'), name: l.name ?? l.id, right: [dim(`${l.kind ?? ''} · ${run}`)], run: () => openLabel(cx, l.id, l.name ?? l.id) }
    }),
    pick,
    cols,
  )
  const step = (d: number) => {
    const at = ls.findIndex(x => x.id === pick)
    labelPick = ls[Math.max(0, Math.min(ls.length - 1, at + d))]?.id ?? ''
    return cx.bumpPanel()
  }
  // the label deleted last from its panel: `undo` puts it back with its marks, its card and its filters, as the
  // browser's top bar's Undo (`thimble act label-undelete`); a refusal says why in red
  const gone = labelGone && !ls.some(x => x.id === labelGone!.id) ? labelGone : null
  const undo = gone && !gone.error ? () => void undeleteLabel(cx, gone.id, gone.name) : null
  const goneRow = gone ? (
    gone.error ? (
      <Text key="lbs-gone" color={COLORS.problem} wrap="wrap">{`× the label "${gone.name}" was not restored: ${gone.error}`}</Text>
    ) : (
      <Box key="lbs-gone" flexDirection="row">
        <Text dimColor>{`deleted the label "${gone.name}"  `}</Text>
        <Button key="lbs-undo" label="undo" plain onPress={undo!} />
      </Box>
    )
  ) : null
  const listHints = ['↑↓ to choose', 'Enter to open', ...(undo ? ['u to undo'] : []), 'b to go back', 'x to close']
  // the title row, the header, the rule under the list, the field and the hint rows aside
  const win = windowList('labels-list', lines, hits, ls.findIndex(x => x.id === pick), bodyRows - 3 - (goneRow ? 1 : 0) - hintHeight(listHints, cols) - body.length, () => cx.bumpPanel())
  body.push(linesEl(cx, e, marginKey('labels-list'), win.lines, win.hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? openLabel(cx, pick, ls.find(x => x.id === pick)?.name ?? pick) : undefined)))
  body.unshift(
    <Box key="label-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {ls.map((l, i) => {
        const go = () => void openLabel(cx, l.id, l.name ?? l.id)
        return <Button key={`label-open-${i}`} label={l.name ?? l.id} plain {...hotkeyOf(cx, i < 9 ? String(i + 1) : null, go)} />
      })}
    </Box>,
  )
  const field = e.surface === 'mobile' ? null : fieldRow(cx, e, 'describe a new label', <Input key={fieldKey('lbs-describe')} submitLabel="make it" onSubmit={v => void (v.trim() ? cx.submit(`Make a label with apply_label and try it on a sample of 30: ${v.trim()}`) : undefined)} />, 'lbs-new')
  body.push(...bottomRows(cx, e, cols, [], [goneRow, field], listHints))
  const hk = undo ? hiddenKeys(cx, e, [{ key: 'undo', hotkey: 'u', onPress: undo }]) : null
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
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
  const listHints = docs.length ? ['↑↓ to choose', 'Enter to open'] : []
  const win = windowList('docs-list', lines, hits, docs.findIndex(d => d.slug === pick), bodyRows - 1 - hintHeight(listHints, cols) - body.length, () => cx.bumpPanel())
  body.push(linesEl(cx, e, marginKey('docs-list'), win.lines, win.hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? open(docs.find(d => d.slug === pick)!) : undefined)))
  body.unshift(
    <Box key="doc-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {docs.map((d, i) => (
        <Button key={`doc-open-${i}`} label={d.title} plain {...hotkeyOf(cx, i < 9 ? String(i + 1) : null, () => void open(d))} />
      ))}
    </Box>,
  )
  body.push(hintsRow(els, listHints, cols))
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
 *  writes, `◌ writing · N tool calls · <its latest words>` (and the request until anything is written), else its
 *  comments' facts (`2 open comments · 1 resolved`, `◌ <check> checking` while a check runs on it). A report:
 *  `Contents` from three headings, each a click (or 1-9) away; each section drawn as main's chat draws a reply, its
 *  cards in their frames. A deck or a story steps one slide or beat at a time: `‹ 3 of 9 ›`, `previous  next` (p, n), a
 *  deck's `notes` (o), a story's `read as a page` (a), its figure lit at the beat's step. The comments (report.ts) stand
 *  under the passages they are on, as the browser's margin shows them: ↑↓ choose one (`❯`), r resolves it or opens it
 *  again, Enter or a asks a side thread about it, v shows the resolved ones too. At the bottom `edit` (e, a report),
 *  `all documents ›` (l) and the retell controls, `as slides` (s) and `as a story` (y), which ask main to write it again
 *  in that form. A passage's "?" asks a side thread told the document, its section and the passage. */
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
  if (p.mode === 'edit' && got?.ok && form === 'document' && !writing) return drawDocEdit(cx, e, p, doc, title)
  const { units } = docUnits(doc)
  // the comments as the browser's margin shows them, the resolved ones too when asked
  const checksGot = await surfaceValue(cx, 'checks')
  const checks = checksOf(checksGot?.ok ? checksGot.value : [])
  const all = got?.ok ? commentsOf(doc, checks) : []
  const shown = shownComments(all, resolvedShown(slug))
  const chosen = shown.find(c => c.id === pickOf(slug))
  const checking = checks.filter(c => c.running.includes(slug)).map(c => `◌ ${c.name} checking`)
  const sub = writing ? subLine([`◌ writing · ${plural(writing.tools, 'tool call')}${writing.words ? ` · ${clip(writing.words, Math.max(20, cols - 30))}` : ''}`]) : all.length || checking.length ? subLine([...commentFacts(all), ...checking]) : undefined
  const body: RenderElement[] = [...headerEls(els, { title, cols, ...(sub ? { sub } : {}) })]
  if (writing && !units.length && writing.request) body.push(<Text key="doc-request" dimColor wrap="wrap">{`the request: ${clip(writing.request, 600)}`}</Text>)
  const keys: Key[] = []
  // a slide, a beat or a section chosen in place: back leads where the document was opened from
  const at = (k: number) => openPanel(cx, { ...p, start: k }, { replace: true })
  // a passage's thread is told the document, its section and the passage
  const askIn = (u: DocSection) => (tgt: Target) =>
    void openAsk(cx, tgt, tgt.kind === 'sentence' ? { anchor: `report:${slug}${u.id ? `#${u.id}` : ''}`, anchorText: `${quoted(title)} › ${plainCites(str(u.heading))}: ${plainCites(tgt.text ?? '')}`, element: `report:${slug}${u.id ? `#${u.id}` : ''}` } : { element: `report:${slug}${u.id ? `#${u.id}` : ''}` })
  // a block of comments under their passage: a click on one chooses it, a click on one of its chips opens the place
  const blockKey = (key: string) => marginKey(`doc-cm-${key}`)
  const commentBlock = (list: readonly DocComment[], key: string): RenderElement => {
    const lines: Line[] = []
    const hits: LineHit[] = []
    for (const c of list) {
      const { lines: ls, chips } = commentLines(c, c.id === chosen?.id, cols)
      const y0 = lines.length
      ls.forEach((_l, k) => hits.push({ y: y0 + k, x0: 0, x1: cols + MARGIN_W, row: true, run: () => choose(c, false) }))
      for (const ch of chips) hits.unshift({ y: y0 + ch.y, x0: ch.x0, x1: ch.x1, row: false, run: () => openCite(cx, ch.ref, null) })
      lines.push(...ls)
    }
    return linesEl(cx, e, blockKey(key), lines, hits, cols + MARGIN_W)
  }
  const drawUnit = async (u: DocSection, i: number, focus?: Record<string, Focus>): Promise<RenderElement[]> => {
    const out: RenderElement[] = []
    for (const [k, part] of unitParts(u, shown).entries()) {
      if (part.md.trim()) {
        const rows = await drawReply(cx, e, part.md, cols, { margin: PANEL_MARGIN, prefix: k ? `d${i}.${k}-` : `d${i}-`, ask: askIn(u), open: id => void openThread(cx, id), in: 'report', ...(focus ? { focus } : {}) })
        // a blank row between a passage's comments and the words after them; a card's border stands in for one
        out.push(k && !part.md.startsWith('[[card:') ? <Box key={`doc-part-${i}-${k}`} flexDirection="column" marginTop={1}>{rows}</Box> : <Box key={`doc-part-${i}-${k}`} flexDirection="column">{rows}</Box>)
      }
      if (part.after.length) out.push(commentBlock(part.after, `${i}-${k}`))
    }
    return out
  }
  const stepped = units.length > 0 && (form === 'slides' || (form === 'story' && p.mode !== 'page'))
  // the slide or beat shown, or the section the page starts at
  const current = Math.max(0, Math.min(units.length - 1, p.start ?? 0))
  // a comment chosen by the keys: the slide or section that holds it shown first, then its block scrolled into view
  // once the panel is drawn again (scrollPending; a block's key is its unit's place and the part of it the comment
  // stands under)
  const choose = async (c: DocComment, reveal: boolean) => {
    setPick(slug, c.id)
    const u = unitOf(doc, c.sid)
    const part = u >= 0 ? unitParts(units[u]!, shown).findIndex(x => x.after.some(y => y.id === c.id)) : 0
    if (reveal) docScrollKey = blockKey(u >= 0 ? `${u}-${part}` : 'title')
    if (reveal && u >= 0 && ((stepped && u !== current) || (!stepped && u < current))) await at(u)
    else await cx.bumpPanel()
  }
  const controls: (RenderElement | null)[] = []
  const hints: string[] = []
  // the comments on the title, under the header
  const onTitle = shown.filter(c => c.sid === TITLE_ID)
  if (onTitle.length) body.push(commentBlock(onTitle, 'title'))
  if (stepped) {
    const i = current
    const u = units[i]!
    body.push(<Box key={marginKey(`doc-unit-${i}`)} flexDirection="column">{await drawUnit(u, i, form === 'story' ? stepFocus(u) : undefined)}</Box>)
    const notes = str((u as { notes?: unknown }).notes)
    if (form === 'slides' && notes && p.mode === 'notes') body.push(<Box key="doc-notes" flexDirection="column" marginTop={1}><Text bold>Notes</Text><Text wrap="wrap">{notes}</Text></Box>)
    // the page row: ‹ and › a click away (p and n are its keys)
    const pageWords = `${i + 1} of ${units.length}`
    const pageLine: Line = [{ s: '‹', fg: i > 0 ? LINK : COLORS.dim }, { s: `  ${pageWords}  ` }, { s: '›', fg: i < units.length - 1 ? LINK : COLORS.dim }]
    const prev = () => (i > 0 ? at(i - 1) : undefined)
    const next = () => (i < units.length - 1 ? at(i + 1) : undefined)
    body.push(<Box key="doc-page" marginTop={1}>{linesEl(cx, e, 'doc-page', [pageLine], [{ y: 0, x0: 0, x1: 1, row: false, run: prev }, { y: 0, x0: width(pageWords) + 5, x1: width(pageWords) + 6, row: false, run: next }], cols)}</Box>)
    controls.push(i > 0 ? <Button key="doc-prev" label="previous" plain onPress={() => void prev()} /> : null, i < units.length - 1 ? <Button key="doc-next" label="next" plain onPress={() => void next()} /> : null)
    keys.push({ key: 'prev', hotkey: 'p', onPress: () => void prev() }, { key: 'next', hotkey: 'n', onPress: () => void next() })
    hints.push('p n to step')
    if (form === 'slides' && units.some(x => str((x as { notes?: unknown }).notes))) {
      const flip = () => void openPanel(cx, { ...p, mode: p.mode === 'notes' ? '' : 'notes' }, { replace: true })
      controls.push(<Button key="doc-notes-flip" label={p.mode === 'notes' ? 'hide notes' : 'notes'} plain onPress={flip} />)
      keys.push({ key: 'notes', hotkey: 'o', onPress: flip })
      hints.push('o for notes')
    }
    if (form === 'story') {
      const page = () => void openPanel(cx, { ...p, mode: 'page', start: 0 }, { replace: true })
      controls.push(<Button key="doc-page-read" label="read as a page" plain onPress={page} />)
      keys.push({ key: 'page', hotkey: 'a', onPress: page })
      hints.push('a for the page')
    }
  } else {
    const from = current
    // the contents from three headings: each heading a click away (and 1-9), drawing the document from there; a section
    // with no heading (an opening summary) is not listed
    const headed = units.map((u, i) => ({ u, i })).filter(x => plainCites(str(x.u.heading)).trim())
    if (headed.length >= 3) {
      body.push(<Text key="doc-contents" bold>Contents</Text>)
      const shownToc = headed.slice(0, 24)
      const w = String(shownToc.length).length
      const lines: Line[] = shownToc.map((x, k) => [dim(`${String(k + 1).padStart(w)}  `), { s: plainCites(str(x.u.heading)), ...(x.i === from && from > 0 ? { fg: ACCENT } : {}) }])
      body.push(linesEl(cx, e, 'doc-toc', lines, shownToc.map((x, k) => ({ y: k, x0: 0, x1: cols, row: true, run: () => at(x.i) })), cols))
      shownToc.slice(0, 9).forEach((x, k) => keys.push({ key: `sec${k}`, hotkey: String(k + 1), onPress: () => void at(x.i) }))
      hints.push('1-9 for a section')
    }
    for (const [i, u] of units.entries()) {
      if (i < from) continue
      // one blank row between sections, and between the contents and the first; none above a first section under the
      // header's rule
      const top = i === from && headed.length < 3 && !onTitle.length ? 0 : 1
      body.push(<Box key={marginKey(`doc-sec-${i}`)} flexDirection="column" marginTop={top}>{await drawUnit(u, i)}</Box>)
    }
  }
  // the comments' keys: ↑↓ choose one (the list's keys, through the relay), r resolves or reopens the chosen one, Enter
  // or a asks about it, v shows or hides the resolved ones
  const story = stepped && form === 'story'
  if (shown.length && !writing) {
    setListKeys(k => {
      if (k === 'up' || k === 'k' || k === 'down' || k === 'j') {
        const to = stepPick(shown, chosen?.id ?? '', k === 'up' || k === 'k' ? -1 : 1)
        return to ? choose(to, true) : undefined
      }
      if ((k === 'return' || k === 'enter') && chosen) return askComment(cx, doc, slug, chosen)
    })
    hints.push('↑↓ to choose a comment')
  }
  if (chosen && !writing) {
    const flip = () => void resolveComment(cx, slug, chosen, shown)
    if (!chosen.tag) {
      controls.unshift(<Button key="doc-cm-resolve" label={chosen.open ? 'resolve' : 'reopen'} plain onPress={flip} />)
      keys.push({ key: 'resolve', hotkey: 'r', onPress: flip })
      hints.push(chosen.open ? 'r to resolve' : 'r to reopen')
    }
    const ask = () => void askComment(cx, doc, slug, chosen)
    controls.splice(chosen.tag ? 0 : 1, 0, <Button key="doc-cm-ask" label="ask about it" plain onPress={ask} />)
    if (!story) keys.push({ key: 'cm-ask', hotkey: 'a', onPress: ask })
    hints.push(story ? 'Enter to ask' : 'Enter or a to ask')
  }
  const resolvedN = all.filter(c => !c.open).length
  if (resolvedN && !writing) {
    const flip = () => {
      flipResolved(slug)
      if (chosen && !chosen.open) setPick(slug, '')
      void cx.bumpPanel()
    }
    controls.push(<Button key="doc-cm-resolved" label={resolvedShown(slug) ? 'hide resolved' : `show resolved (${num(resolvedN)})`} plain onPress={flip} />)
    keys.push({ key: 'cm-resolved', hotkey: 'v', onPress: flip })
    hints.push(resolvedShown(slug) ? 'v to hide resolved' : 'v to show resolved')
  }
  // edit: the report as Markdown in the panel's editor (drawDocEdit)
  if (form === 'document' && got?.ok && units.length && !writing) {
    const edit = () => void openPanel(cx, { ...p, mode: 'edit' })
    controls.push(<Button key="doc-edit" label={editOf(slug) ? 'edit (unsaved)' : 'edit'} plain onPress={edit} />)
    keys.push({ key: 'edit', hotkey: 'e', onPress: edit })
    hints.push('e to edit')
  }
  // retell: main writes the document again in another form (thimble's writer)
  const retell = (to: 'slides' | 'story') => () => void cx.command('thimble:write', `${to} Retell the document "${title}" as ${to === 'slides' ? 'slides' : 'a story'}.`).catch(err => cx.toast(`thimble: could not start the writer: ${String(err).slice(0, 200)}`))
  if (units.length && !writing) {
    // each key with what it retells the document as, as the label panel's hint names what each key opens
    const forms: string[] = []
    if (form !== 'slides') {
      controls.push(<Button key="doc-as-slides" label="as slides" plain onPress={retell('slides')} />)
      keys.push({ key: 'slides', hotkey: 's', onPress: retell('slides') })
      forms.push('s slides')
    }
    if (form !== 'story') {
      controls.push(<Button key="doc-as-story" label="as a story" plain onPress={retell('story')} />)
      keys.push({ key: 'story', hotkey: 'y', onPress: retell('story') })
      forms.push('y story')
    }
    hints.push(forms.join(', '))
  }
  // the documents list with this document chosen (live check term-fix10, new quirk 8: it chose the other document)
  const allDocs = () => {
    docPick = p.slug ?? docPick
    void openList(cx, { view: 'docs', title: 'Documents' })
  }
  controls.push(<Button key="doc-all" label="all documents ›" plain onPress={allDocs} />)
  keys.push({ key: 'all', hotkey: 'l', onPress: allDocs })
  hints.push('l for all documents')
  const said = docSaid.get(slug)
  body.push(...bottomRows(cx, e, cols, controls, said ? [<Text key="doc-said" color={COLORS.problem} wrap="wrap">{`! ${said}`}</Text>] : [], hints))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// why the last change of a document's comments did not go through, by its slug (shown red at the panel's bottom)
const docSaid = new Map<string, string>()

// the block of a document's comments the keys chose last, which the pane scrolls into view (scrollPending)
let docScrollKey = ''

/** After a key the list's relay passed on (register.tsx, with the hook's own context): the comment block it chose
 *  scrolled into the pane's view, once the panel is drawn again. */
export function scrollPending(cx: Ctx): void {
  if (!docScrollKey) return
  const key = docScrollKey
  docScrollKey = ''
  cx.later(60, () => void cx.scroll(key, 'center'))
}

/** A comment resolved (the margin's ✓) or opened again (`thimble act comment-resolve | comment-reopen`); the document
 *  read again. A comment resolved while the resolved ones are hidden leaves the choice on the next one shown. */
async function resolveComment(cx: Ctx, slug: string, c: DocComment, shown: readonly DocComment[]): Promise<void> {
  if (!rt.sc) return
  const why = await setComment(cx, rt.sc, slug, c)
  if (why) docSaid.set(slug, why)
  else docSaid.delete(slug)
  if (!why && c.open && !resolvedShown(slug)) {
    const at = shown.findIndex(x => x.id === c.id)
    setPick(slug, (shown[at + 1] ?? shown[at - 1])?.id ?? '')
  }
  await readDoc(cx, slug)
  await cx.bumpPanel()
}

/** A side thread about a comment, as the browser's comment card's reply starts one: on the comment's passage, told the
 *  passage's words and the comment. */
async function askComment(cx: Ctx, doc: Obj, slug: string, c: DocComment): Promise<void> {
  const words = passageWords(doc, c.sid)
  const anchor = `report:${slug}#${c.sid}`
  await openAsk(cx, { kind: 'sentence', text: words }, { anchor, anchorText: `${words}\n\n${commentWho(c)}: ${c.text}`, element: anchor, about: `comment ${quoted(clip(c.text, 50))}` })
}

/** A report edited as Markdown (SPEC.md, section 7, "Documents"; report.ts): the title, `editing as Markdown` and
 *  `unsaved edits` dim under it; the document's Markdown whole in the editor (docedit.tsx), a window over it the pane's
 *  height, in a border; at the bottom `save` (ctrl+s in the editor, s outside it) and `discard` (d), then why a save
 *  did not go through, in red. A save goes through the browser editor's route, so each passage the edit kept keeps its
 *  id and its comments; back keeps what was typed for the next edit. */
async function drawDocEdit(cx: Ctx, e: PaneEvent, p: TermPanel, doc: Obj, title: string): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const slug = p.slug ?? ''
  const ed = beginEdit(slug, doc)
  const changed = editChanged(ed)
  const body: RenderElement[] = [...headerEls(els, { title, cols, sub: subLine(['editing as Markdown', 'a card is its line ![caption](card:<id>)', changed ? 'unsaved edits' : null]) })]
  const save = () => void saveDocEdit(cx, slug)
  // the edit dropped: the editor holds the document as it stands now
  const discard = () => {
    discardEdit(slug)
    void readDoc(cx, slug).then(() => cx.bumpPanel())
  }
  const hints = ['ctrl+s or s to save', ...(changed ? ['d to discard'] : [])]
  const controls = [<Button key="doc-save" label="save" plain onPress={save} />, changed ? <Button key="doc-discard" label="discard" plain onPress={discard} /> : null]
  const said = ed.said ? [<Text key="doc-edit-said" color={COLORS.problem} wrap="wrap">{`! ${ed.said}`}</Text>] : []
  // the editor's rows: what the pane leaves under the header (its title row, which holds the path) and above the
  // bottom part
  const rows = Math.max(6, (bodyRows || 30) - 9 - said.length - (hintHeight(hints, cols) - 1))
  if (e.surface === 'terminal' || e.surface === 'desktop') {
    const { Client } = cx.els(e)
    body.push(
      <Box key="doc-editor" flexDirection="column" borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
        <Client key={`doc-editor-${slug}`} module="./docedit.tsx" width={cols - 4} props={JSON.parse(JSON.stringify({ slug, text: ed.text, cols: cols - 4, rows }))} />
      </Box>,
    )
  } else body.push(<Text key="doc-editor" wrap="wrap">{ed.text}</Text>)
  body.push(...bottomRows(cx, e, cols, controls, said, hints))
  const hk = hiddenKeys(cx, e, [{ key: 'save', hotkey: 's', onPress: save }, ...(changed ? [{ key: 'discard', hotkey: 'd', onPress: discard }] : [])])
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

/** Save a document's edit (report.ts saveEdit); once saved, the document read again and shown as it now stands. */
async function saveDocEdit(cx: Ctx, slug: string): Promise<void> {
  if (!rt.sc) return
  const why = await saveEdit(cx, rt.sc, slug)
  if (why) return cx.bumpPanel()
  await readDoc(cx, slug)
  const p = await cx.panel()
  if (p?.view === 'doc' && p.slug === slug && p.mode === 'edit') await navBack(cx)
  else await cx.bumpPanel()
}

/** A post of docedit.tsx: what was typed (a draft), or a save (ctrl+s). */
export async function docEditMessage(cx: Ctx, slug: string, text: string, save: boolean): Promise<void> {
  const ed = editOf(slug)
  if (!ed) return
  const was = editChanged(ed)
  draftEdit(slug, text)
  if (save) return saveDocEdit(cx, slug)
  // the subtitle's `unsaved edits` and the `discard` control follow the first change and its undoing
  const now = editOf(slug)
  if (now && editChanged(now) !== was) await cx.bumpPanel()
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
    steps.slice(-12).forEach((s, i) => body.push(<Text key={`agent-step-${i}`} dimColor wrap="truncate-end">{cut(`  ${s}`, cols)}</Text>))
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
  const listHints = vs.length ? ['↑↓ to choose', 'Enter to open'] : []
  const win = windowList('views-list', lines, hits, vs.findIndex(v => v.slug === pick), bodyRows - 1 - hintHeight(listHints, cols) - body.length, () => cx.bumpPanel())
  body.push(linesEl(cx, e, marginKey('views-list'), win.lines, win.hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? open(vs.find(v => v.slug === pick)!) : undefined)))
  // each view a press away by its key too, for a surface that draws no Client: no row of its own
  body.unshift(
    <Box key="view-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {vs.map((v, i) => (
        <Button key={`view-open-${i}`} label={v.name} plain onPress={() => void open(v)} />
      ))}
    </Box>,
  )
  body.push(hintsRow(els, listHints, cols))
  const hk = hiddenKeys(cx, e, vs.slice(0, 9).map((v, i) => ({ key: `v${i}`, hotkey: String(i + 1), onPress: () => void open(v) })))
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// the rows of a view's panel that are not the view's own: the title row, the rule and the hint row
const VIEW_CHROME = 3
// the panel's own keys, which a view never takes (term_kit/kit.mjs PANEL_KEYS): back, the threads, close
const PANEL_KEYS = ['b', 't', 'x']

/** One view (docs/terminal-views.md): a view built in terminal mode is drawn by its program (hooks/viewhost.ts) under
 *  the panel's header, its subtitle the facts the program gives, its hint row the keys it binds; its keys reach it
 *  through the list's relay (↑↓, Enter, Space, Backspace) and as hotkeys (a letter, a digit, a sign), every key while a
 *  field of it takes typing, and its clicks and drags through hooks/viewclient.tsx. A view built in browser mode is one
 *  line that says so. */
async function drawView(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e) as El
  const { Box, Text, Button, Client } = cx.els(e)
  const cols = Math.max(30, e.props.bodyColumns)
  const slug = p.slug ?? ''
  const v = (await homeViews(cx)).find(x => x.slug === slug)
  if (!v?.term || !rt.sc || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
    return (
      <Box flexDirection="column">
        {[
          ...headerEls(els, { title: p.title || slug || 'view', cols, sub: subLine(['view']) }),
          <Text key="view-words" wrap="wrap">{v && !v.term && v.state === 'built' ? 'This view was built in browser mode, so only the browser draws it. To see it, quit, run `thimble mode browser`, and start `thimble` again in this folder.' : 'The view is not built yet. Its row on home says when it is.'}</Text>,
          hintsRow(els, ['b to go back', 'x to close'], cols),
        ]}
      </Box>
    )
  }
  const shown = openViewState()
  const sub = shown?.slug === slug && shown.frame?.sub?.length ? shown.frame.sub : []
  // the hint row wraps rather than leave a key out, so the view's rows are what the rows its last hints took leave
  const hintsN = shown?.slug === slug && shown.frame && !shown.frame.typing ? hintHeight(shown.frame.hints, cols) : 1
  const rows = Math.max(6, (bodyRows || 34) - VIEW_CHROME - (sub.length ? 1 : 0) - (hintsN - 1))
  const ov = viewFor(rt.sc, slug, cols, rows, p.ref)
  const f: ViewFrame | null = ov.frame
  // `◌ loading…` against R on the title's row while a reader query of the program is out, so the rows stay put
  const right = f?.loading && f.lines.length ? <Text key="view-loading-r" dimColor>◌ loading…</Text> : null
  const head = headerEls(els, { title: p.title || v.name || slug, cols, right, ...(sub.length ? { sub: subLine(sub) } : {}) })
  const body: RenderElement[] = [...head]
  // the relay is drawn from the first drawing on, while the view opens too, so the open gives it the ring (term.ts
  // giveKeys) and the view's keys work as soon as its frame comes
  setListKeys(() => undefined)
  if (ov.error && !f?.lines?.length) {
    body.push(<Text key="view-error" color={COLORS.problem} wrap="wrap">{`× ${ov.error}`}</Text>)
    body.push(<Button key="view-again" label="open it again" plain onPress={() => { retryView(); void cx.bumpPanel() }} />)
    body.push(hintsRow(els, [], cols))
    return <Box flexDirection="column">{body}</Box>
  }
  if (!f) {
    // from the moment the view opens until its program draws its first frame: the host starting, the program reading
    body.push(<Text key="view-opening" dimColor>◌ starting the view…</Text>)
    body.push(hintsRow(els, [], cols))
    return <Box flexDirection="column">{body}</Box>
  }
  const key = (k: string) => sendEvent(cx, { t: 'key', key: k })
  // the view's keys reach it through the list's relay, which a view always draws: ↑↓, Enter, Space and Backspace, and a
  // sign typed into its field (a Button's hotkey is a letter or a digit)
  setListKeys(k => {
    const name = k === 'enter' ? 'return' : k
    if (f.keys.includes(name)) return key(name)
  })
  // while a field of the view takes typing, the relay's field is that field, holding its text (the view's, when it
  // began; then what the analyst typed, which is what it holds)
  if (!f.typing) viewField = null
  else {
    const text = viewField && viewField.slug === slug ? viewField.text : f.field?.text ?? ''
    viewField = { slug, text, send: t => sendEvent(cx, { t: 'text', value: t }), enter: () => key('return') }
  }
  // a first frame with no rows yet, while its first query is out
  if (!f.lines.length && f.loading) body.push(<Text key="view-loading" dimColor>◌ loading…</Text>)
  // the frame's rows bring their margin (`❯`)
  body.push(<Client key={marginKey('view-frame')} module="./viewclient.tsx" width={cols + MARGIN_W} height={Math.max(1, f.lines.length)} props={JSON.parse(JSON.stringify({ lines: f.lines, hits: f.hits, seq: f.seq, cols: cols + MARGIN_W })) as never} />)
  if (ov.error) body.push(<Text key="view-error" color={COLORS.problem} wrap="truncate-end">{`× ${ov.error}`}</Text>)
  // a sign's key works only from the relay's field, so its hint shows only while the ring rests there
  const isSign = (k: string) => [...k].length === 1 && !/[a-z0-9]/.test(k)
  const hints = f.hints.filter((_, i) => listKeysHeld() || !(f.hintKeys?.[i] ?? []).some(isSign))
  // while a field of the view takes typing every key is the field's, b and x among them: the row says only what Enter
  // and Backspace do there
  if (f.typing) {
    endHints(f.hints)
    body.push(hintsEl(els, paneFocused && !rt.typeThrough ? [...f.hints, 'Esc to leave the field'] : [UNFOCUSED_HINT], cols))
  } else body.push(hintsRow(els, hints, cols))
  // each letter or digit the view binds is a hotkey of the panel, a Button no row tall; a sign is one of the relay's
  // (relayInput finds it among the hotkeys); none while a field of the view takes typing
  const chars = f.typing ? [] : f.keys.filter(k => [...k].length === 1 && !PANEL_KEYS.includes(k))
  for (const c of chars.filter(isSign)) hotkeysDrawing.set(c, () => void key(c))
  const hk = hiddenKeys(cx, e, chars.filter(c => !isSign(c)).map(c => ({ key: `v${c.codePointAt(0)}`, hotkey: c, onPress: () => void key(c) })))
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

// what the view's acts do in the panel: a record's place in the citation panel, a side thread about a row, a label's
// panel
onViewAct(async (cx, a) => {
  if (a.kind === 'open' && a.ref) return openCite(cx, a.ref, null)
  if (a.kind === 'ask' && a.ref) return openAsk(cx, { kind: 'record', ref: a.ref, text: a.text ?? '' }, { anchor: a.ref, anchorText: a.text ?? '' })
  if (a.kind === 'label' && a.id) return openLabel(cx, a.id, a.name || a.id)
})

// ------------------------------------------------------------------------------------------------ the panel

/** The panel's drawing: the title row, then the view `panel` names, on the panel's grid (a cell of padding at each side,
 *  then the 2-cell margin, then the type area). */
export async function drawPanel(cx: Ctx, pe: PaneEvent): Promise<RenderElement> {
  await cx.panelTick()
  const e = { ...pe, props: { ...pe.props, bodyColumns: Math.max(20, pe.props.bodyColumns - 2 - MARGIN_W) } } as PaneEvent
  const p = (await cx.panel()) ?? { view: 'home', title: 'Home' }
  wayHints = [...(backTarget((await cx.nav()) ?? NAV_EMPTY) !== null ? ['b to go back'] : []), 'x to close']
  // the keys as the pane's props and the engine's record say: a pane either says is without them names none of its keys
  // (an open the engine refused the keys, live check term-fix6, new quirk 4)
  paneFocused = pe.props.isFocused !== false && (await cx.panes()).find(x => x.id === PANEL)?.isFocused !== false
  // typing meant for the prompt ends once the prompt has the keys: the relay is drawn again for the next time the pane
  // takes them (relayInput, typeThrough)
  if (!paneFocused) rt.typeThrough = false
  bodyRows = pe.props.scroll?.bodyRows || 0
  // the list this drawing draws, read off its drawing (lines.tsx), for the relay in its title row (listKeysEl)
  takeListKeys()
  setHead({})
  hotkeysDrawing = new Map()
  listExtraDrawing = { space: false, backspace: false }
  fieldsDrawing = new Set()
  windowed = ''
  scrollDrawing = null
  panelField = null
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
      case 'agent':
        return drawAgent(cx, e, p)
      case 'views':
        return drawViews(cx, e)
      case 'view':
        return drawView(cx, e, p)
      default:
        return drawers.get(p.view)?.(cx, e, p) ?? none(cx, e)
    }
  })()
  // a terminal view's program lives while its view shows
  if (p.view !== 'view') {
    closeView()
    viewField = null
  }
  listRelay = takeListKeys()
  const tree = await withWay(cx, e, p.view, body)
  hotkeys = hotkeysDrawing
  listExtra = listExtraDrawing
  shownWindow = windowed
  scrollShown = scrollDrawing
  rt.fields = fieldsDrawing
  return tree
}

