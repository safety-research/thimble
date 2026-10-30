// tray.ts: the cite and explain tray, one small panel above the prompt (0.10: shell.tsx openMark, stepMark, stepEnds,
// trayBand, trayFileLink, trayScope, the tray branch of emptyPromptKey; panes/tray.js; shell/cards.js explainerCard).
//
// It shows one mark at a time, the top of a stack (tray.mjs): a citation with its check and its evidence, or an
// explainer (what a term is, where it mattered here) or an important detail (a heads-up). ] and [ at an empty prompt
// step through the answers' citations, explainers, heads-ups and cards (drawn inline at Claude's calls, or under an
// answer by v), in reading order (a heads-up on a citation's words before the citation), and open the tray on the one
// reached; a press on a citation or an explainer opens it too. The marked words draw in focus (the
// answer view asks trayFocus). At rest, while the answer the keys act on shows marks, the bar names ] and the mark it
// opens (`] show explainer` for the answer's first mark, `] next citation` for a later one; on a narrow bar
// `] explainer`, then `]` alone): while one of the answer's marks is not opened, the first such, its verb in
// thimble's color; once the person opened each, the first mark, its verb drawn as the bar's other keys' words. The
// words that name a mark, there and in the tray's header (`] next heads up`), are in that mark's own look (kindLook:
// an explainer's teal, a heads-up's orange, a citation's underline), so the bar shows what each look is. While it is
// open, ] and [ stay on the bar, named by the mark they reach, and its other keys are in its header, at the right, each
// where it acts (the bar keeps its own, less any key the tray takes, as h; a card's header names no a: core/answerview.ts
// heldKeys):
//
//   a ask       a side thread about the mark (threads/seam.ts openThread), its input taking the keys; 1 too,
//               unnamed. With a thread about it already, a opens that thread
//   + show all  named before a while the card leaves lines out: all of the mark in the side pane, the same pane a
//               opens, to read (showAll)
//   h explain   the explainer (or heads-up) on the citation's words, over it
//   2–9         a citation inside an explainer's or a heads-up's words, over it (a click on it too), unnamed. Its
//               links to a file's lines are citations too, drawn as the answer's: the answer's own citation of those
//               lines when it has one, else the lines themselves (a `place` frame)
//   x repair    on a failed citation: a check of that one claim again in the background, which looks in
//               the records for the right value and corrects the cited words (marks/checker.ts launchRepair), or
//               for one whose check did not run, its check; the
//               citation spins while it runs and shows its new status when it ends; a click on `x repair` in the
//               card too (this module's ui.press hook, so the fork starts inside a hook)
//   0 close     back to the mark under it, or close
//   ] [         on the bar: the next mark or card after the one it shows, and the one before, named by what they
//               are, in their look
//
// Each key's words in the tray are a click too: the header's keys, `x repair` in the card, and each marker of a cut
// card is +; a click on the citation's words, in the tray's title as in the reply, closes it, as a second click on the
// open mark in the reply does.
//
// The tray stands in the band above the prompt, over the bar (bar/register.ts), so the bar with ] and [ stays in view
// under it. It is a summary of the mark: as much of it as fits in the rows the band has over the bar, whole when it
// fits, a blank row between its head and the card. A citation's evidence shows in parts, each under its label, dim: the
// code (`code · 7 lines`, its whole size), a blank row, then its printed output (`output · 62 lines`); a file's lines
// under their place (`changes.log · line 3`); a card's value under the card. A taller card is cut to those rows: a
// citation keeps the line of code that printed its value and the output line that holds it in view, with what fits
// around them; an explainer, a heads-up or a file's lines show from their start. Where it leaves lines out a marker says
// how many, dim (`⋯ 5 lines above`, `⋯ 13 lines below`), and the header names + among its keys (`+ show all`): +, a
// click on those words or on any marker shows all of the mark in the side pane (core/pane.ts), whole, in the same
// parts, where the wheel and ↑ ↓ scroll it and the side thread about the mark has its conversation and its input under
// it. No line is left out without its marker: a band too short for the lines around the key ones and the labels drops
// them first.
//
// A card ] reaches takes the keys (cards/store.ts setFocus); `a` asks about it and 0 gives the keys back. An open tray
// does not change what the next prompt asks: a question about the mark goes to a side thread (a). The tray closes when
// the person sends a prompt, and gives way to the side pane a or + opens; while they scroll the transcript it stays as
// it is, until 0 closes it or they open another mark. What the person opens reaches main through core/engaged.ts.
//
//   state: tray ({stack} or null), trayCard (the card ] reached: {row, card}), traySeen (the marks the person opened:
//   `<row>|c<n>` for a citation, `<row>|<id>` for an explainer or a heads-up)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { spinNow } from '../bar/busy'
import { failNotice, reasonOf } from '../bar/notice'
import type { MarkRef, Span } from '../core/answerview'
import { actingRow, messageOf, partOf, pickAnswer, turnOfRow, turnsNow, type TurnRec } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { startDir } from '../core/env'
import { openPane } from '../core/pane'
import { controlWords } from '../core/selection'
import { revealCard } from '../cards/draw'
import { quiet } from '../core/askcell.js'
import { partsAround, printable } from '../core/text.js'
import { accent, themeLast, themeNow } from '../core/theme'
import { treeRows } from '../core/trail.mjs'
import { markColors } from '../explain/place.mjs'
import { anchoredAt, metaOf, setFocus } from '../cards/store'
import { explainSpans, pendingGloss, pendingSpans, type ExplainPart, type Gloss } from '../explain/seam'
import { placeLines } from '../explain/expand'
import { citeLinks } from '../explain/place.mjs'
import { checkOpened, launchRepair, repairOf } from '../marks/checker'
import { highlighted, statusEls } from '../marks/evidence'
import { tableLines } from '../marks/table.mjs'
import { marksIn, plainSentence, withAsked, withoutMarks, withRewrites } from '../marks/message.js'
import { looksByWords, quietLooks } from '../marks/register'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageEl, wordsLook, type MarkStatus } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { squeezeBar, squeezeHidesCard, squeezeHolds, squeezeView } from '../squeeze/seam'
import { openThread } from '../threads/seam'
import {
  aboutOf, around, back, base, canRepair, cardLabel, checkStatus, cutTitle, cutWords, drawsHyperlinks, evidenceLine, explainerText, fileHref, firstSentence,
  indexOf, lineWindow, open, outputAt, partLabel, placeLabel, printableEvidence, printedAt, push, refOf, restStop, restWords, rowsOf, sameRef, SHOW_ALL,
  stepFrom, stepWords, stopKind, stopWhat, stopsOfRow, stopsOfTurn, TABLE_LABEL, top, wasLine,
} from './tray.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A mark the tray shows, or (`place`) the lines of a file an explainer's or a heads-up's words cite, `id` the place
 *  as `path:from-to`. */
export type Frame = MarkRef | { row: string; kind: 'place'; id: string }
export type Tray = { stack: Frame[] } | null
type Stop = { row: string; kind?: 'citation' | 'explain' | 'heads'; n?: number; id?: string; at?: number; card?: string }
type Stand = { row: string; card: string } | null

const TRAY = { plugin: 'thimble', key: 'tray' } as const
const STAND = { plugin: 'thimble', key: 'trayCard' } as const
const SEEN = { plugin: 'thimble', key: 'traySeen' } as const
/** The most marks the seen list keeps: the newest opened */
const SEEN_KEEP = 400

/** The colors of the tray's frame by what it shows, the ones its words are drawn in (explain/place.mjs markColors): a
 *  citation's purple, an explainer's teal and a heads-up's orange, theme keys that follow the person's theme. */
const TONES = { citation: 'merged', place: 'merged', explain: 'planMode', heads: 'claude' } as const

const quietly = (p: Promise<unknown> | unknown) => Promise.resolve(p).catch(() => undefined)

// ------------------------------------------------------------------------------------------------ state

export async function trayNow($: Engine): Promise<Tray> {
  const t = (await $.state.get(TRAY)).value as Tray | undefined
  return t && Array.isArray(t.stack) && t.stack.length ? t : null
}

async function standNow($: Engine): Promise<Stand> {
  return ((await $.state.get(STAND)).value ?? null) as Stand
}

// The tray and the card ] reached, as this module last wrote or read them: it alone writes them, so the copy is the
// state's. A key at an empty prompt reads the copy (trayHolds, trayKey), since Claude Code gives a key's hook a few
// milliseconds of its own time and each read of the state costs some of it under load. A drawing reads the state
// itself, so a change draws again.
let kept: { tray: Tray; stand: Stand } | null = null

async function keptNow($: Engine): Promise<{ tray: Tray; stand: Stand }> {
  return kept ?? (kept = { tray: await trayNow($), stand: await standNow($) })
}

async function writeTray($: Engine, tray: Tray): Promise<void> {
  const next = tray && Array.isArray(tray.stack) && tray.stack.length ? tray : null
  await $.state.set(TRAY, next as never)
  kept = { ...(await keptNow($)), tray: next }
}

async function writeStand($: Engine, stand: Stand): Promise<void> {
  await $.state.set(STAND, stand as never)
  kept = { ...(await keptNow($)), stand }
}

/** Whether the tray holds the keys: it is open, or a card ] reached stands. */
export async function trayHolds($: Engine): Promise<boolean> {
  const k = await keptNow($)
  return !!k.tray || !!k.stand
}

/** The keys the tray takes now and names in its own place, which nothing else names (core/answerview.ts heldKeys), so
 *  each key shows once, where it acts: while it is open, its header's (h, + while the card leaves lines out, a, 0), its
 *  body's (x) and 1 and 2–9, unnamed (its ] and [ are the bar's, trayBar); on a card ] reached, a, ] [ and 0, which the bar names
 *  as the card's. `ask`: the keys asked about, when not all (a key of a citation's body reads the citation). Read from
 *  the state, so a drawing that asks draws again when the tray opens or closes. */
export async function trayHeld($: Engine, ask?: string[]): Promise<string[]> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return (await standNow($)) ? [']', '[', 'a', '0'] : []
  const out = ['0', 'a', '1']
  if (cutNow?.ref === frameKey(f)) out.push('+')
  if (f.kind === 'citation' && (!ask || ['h', 'x'].some(k => ask.includes(k)))) {
    if (await innerOf($, f)) out.push('h')
    if (canRepair(await itemOf($, f.row, f.n))) out.push('x')
  } else if (f.kind === 'explain' || f.kind === 'heads') out.push('2', '3', '4', '5', '6', '7', '8', '9')
  return out
}

/** The tray as it stands now; an open tray gives back the keys of a card ] reached. */
async function setTray($: Engine, tray: Tray): Promise<void> {
  const next = tray && tray.stack.length ? tray : null
  await writeTray($, next)
  if (next) await writeStand($, null)
}

export async function closeTray($: Engine): Promise<void> {
  await setTray($, null)
}

/** Close the tray when it stands on this row. */
export async function closeOnRow($: Engine, row: string): Promise<void> {
  const tray = await trayNow($)
  if (tray?.stack[0]?.row === row) await closeTray($)
}

/** The tray gives way to what takes the keys from it (the squeeze chips, s): it closes, and a card ] reached gives its
 *  keys back. Returns what puts it back as it stood (the key undone: a letter right after it). */
export async function giveWay($: Engine): Promise<() => Promise<void>> {
  const was = await keptNow($)
  if (!was.tray && !was.stand) return async () => undefined
  await writeTray($, null)
  await writeStand($, null)
  return async () => {
    await writeTray($, was.tray)
    await writeStand($, was.stand)
  }
}

// ------------------------------------------------------------------------------------------------ marks of a row

/** The text a row shows now (a squeezed version in its place), and its citations; null when it draws nothing. */
async function shownOf($: Engine, row: string): Promise<{ text: string; marks: { start: number; end: number; words: string }[]; own: boolean; items?: MarkItem[] } | null> {
  const raw = (await messageOf($, row))?.text ?? ''
  if (!raw) return null
  let v: Any = null
  try { v = await squeezeView($, row, raw) } catch { v = null }
  if (v?.hidden) return null
  const shown = typeof v?.text === 'string' ? v.text : raw
  const marksOn = featureOn('citations')
  const text = marksOn ? shown : withoutMarks(shown)
  const own = text === raw
  // Claude's own words, with the words the analyst asked about as marks and each sentence a check rewrote in place of
  // the one Claude wrote (marks/register.ts)
  const all = marksOn ? (await rowMarks($, row))?.items ?? [] : []
  const asked = own && marksOn ? withAsked(text, all) : { text, items: all }
  const drawn = own && marksOn ? withRewrites(asked.text, asked.items) : text
  return { text: drawn, marks: marksOn ? marksIn(drawn) : [], own, items: asked.items }
}

/** The row's citations as it shows them: each with its number in the reply (0: one the check does not know). */
async function citesOf($: Engine, row: string, shown: { text: string; marks: { start: number; end: number; words: string }[]; own: boolean; items?: MarkItem[] }): Promise<{ n: number; start: number; end: number; words: string }[]> {
  const items = shown.items ?? (await rowMarks($, row))?.items ?? []
  const all = shown.own ? shown.marks.map((_m, k) => ({ n: items[k]?.n ?? 0, status: 'unchecked' as const })) : looksByWords(shown.marks, items, false)
  // a quiet citation (Citations manual) is not shown, so ] passes it
  const looks = quietLooks(all, items, shown.own)
  return shown.marks.map((m, k) => ({ ...m, n: looks[k]?.quiet ? 0 : looks[k]?.n ?? 0 }))
}

/** The explainers and heads-ups on the row's words (explain/seam.ts), each with its kind: first the words being
 *  explained on demand, as the row draws them (core/answerview.ts spansFor), so the explainer's box shown while it is
 *  written stands where its words do, and the bar's ] names the mark after it. */
async function spansOf($: Engine, row: string, shown: { text: string; marks: { start: number; end: number; words: string }[] }): Promise<(Span & { kind: 'explain' | 'heads' })[]> {
  let spans: Span[] = []
  try { spans = [...((await pendingSpans($, row, shown.text)) ?? []), ...((await explainSpans($, row, shown.text, shown.marks)) ?? [])] } catch { spans = [] }
  const part = await partOf<ExplainPart>($, row, 'explain')
  return (Array.isArray(spans) ? spans : [])
    .filter(s => s && typeof s.id === 'string' && s.end > s.start)
    .map(s => ({ ...s, kind: part?.items?.[s.id]?.kind === 'heads' ? 'heads' as const : 'explain' as const }))
}

/** One row's stops: its marks in reading order, then the cards drawn under it (v's). */
async function rowStops($: Engine, row: string): Promise<Stop[]> {
  const shown = await shownOf($, row)
  if (!shown) return []
  const cards: string[] = []
  for (const id of await anchoredAt($, row)) {
    const m = await metaOf($, id)
    if (m && m.version > 0 && m.anchorRow === row && !(await hiddenCard($, id))) cards.push(id)
  }
  return stopsOfRow(row, await citesOf($, row, shown), await spansOf($, row, shown), cards) as Stop[]
}

/** The marks of the answer `row` stands in (its turn's text rows), as ] passes them, in reading order: no cards. */
async function answerMarks($: Engine, row: string): Promise<Stop[]> {
  const out: Stop[] = []
  for (const r of (await turnOfRow($, row))?.rows ?? [row]) {
    const shown = await shownOf($, r)
    if (shown) out.push(...(stopsOfRow(r, await citesOf($, r, shown), await spansOf($, r, shown), []) as Stop[]))
  }
  return out
}

/** A mark as the seen list names it. */
const seenRef = (p: { row: string; kind?: string; n?: number; id?: string }) => `${p.row}|${p.kind === 'citation' ? `c${p.n}` : p.id}`

/** Where ] goes from rest in an answer's stops: while one of its marks is not opened (the bar's ] lit), the first such,
 *  in reading order; else its first mark (restStop). */
const restNext = (stops: Stop[], seen: Set<string>): Stop | null => stops.find(p => !p.card && !seen.has(seenRef(p))) ?? (restStop(stops, 1) as Stop | null)

async function seenNow($: Engine): Promise<Set<string>> {
  const v = (await $.state.get(SEEN)).value
  return new Set(Array.isArray(v) ? v.map(String) : [])
}

/** The person opened the mark `f`: it counts as seen, and the bar's ] dims once each mark of its answer does. Lines of a
 *  file an explainer cites are no mark of the answer. */
async function markSeen($: Engine, f: Frame): Promise<void> {
  if (f.kind === 'place') return
  const had = await seenNow($)
  const ref = seenRef(f)
  if (!had.has(ref)) await $.state.set(SEEN, [...had, ref].slice(-SEEN_KEEP))
}

async function hiddenCard($: Engine, id: string): Promise<boolean> {
  try { return !!(await squeezeHidesCard($, id)) } catch { return false }
}

/** The cards Claude drew inline in a turn, each where its call stands among the turn's text rows (core/answers.ts
 *  CardUse.after; a card whose place was not kept goes after the turn's last row). A card stands in the turn of the call
 *  it draws at. */
async function inlineCards($: Engine, t: TurnRec): Promise<{ id: string; after: number }[]> {
  const out: { id: string; after: number }[] = []
  for (const c of t.cards ?? []) {
    const m = await metaOf($, c.id)
    if (!m || !(m.version > 0) || m.anchorRow || out.some(x => x.id === c.id)) continue
    if (m.turn ? m.turn !== t.turnId : m.toolUseId !== c.toolUseId) continue
    if (await hiddenCard($, c.id)) continue
    out.push({ id: c.id, after: typeof c.after === 'number' ? c.after : t.rows.length })
  }
  return out
}

/** What ] and [ move through, in reading order: each turn's text rows' marks, the cards Claude drew between them, and
 *  the cards under a row. */
async function allStops($: Engine): Promise<Stop[]> {
  const out: Stop[] = []
  for (const t of await turnsNow($)) {
    const byRow = new Map<string, Stop[]>()
    for (const row of t.rows) byRow.set(row, await rowStops($, row))
    out.push(...(stopsOfTurn(t.rows, (row: string) => byRow.get(row) ?? [], await inlineCards($, t)) as Stop[]))
  }
  return out
}

/** Where ] and [ stand now: the mark the tray shows, where ] and [ pass it (a heads-up h opened over a citation stands
 *  where it does, before that citation), so the bar names what follows the mark it shows, whichever way it was
 *  opened; else the tray's first mark (lines of a file an explainer cites stand on it), else the card ] reached (-1:
 *  none). */
async function stepPlace($: Engine): Promise<{ list: Stop[]; at: number }> {
  const list = await allStops($)
  const tray = await trayNow($)
  const shown = indexOf(list, top(tray))
  if (shown >= 0) return { list, at: shown }
  const b = base(tray) as Frame | null
  const stand = b ? null : await standNow($)
  return { list, at: indexOf(list, b ?? stand) }
}

/** Whether ] and [ go anywhere from where they stand, and what each goes to: in words, and its kind (tray.mjs
 *  stopKind). */
export async function stepEnds($: Engine): Promise<{ next: boolean; prev: boolean; nextWhat?: string; prevWhat?: string; nextKind?: string | null; prevKind?: string | null }> {
  const { list, at } = await stepPlace($)
  if (at < 0) return { next: true, prev: true }
  const next = stepFrom(list, at, 1)
  const prev = stepFrom(list, at, -1)
  return {
    next: !!next, prev: !!prev,
    ...(next ? { nextWhat: stopWhat(next), nextKind: stopKind(next) } : {}), ...(prev ? { prevWhat: stopWhat(prev), prevKind: stopKind(prev) } : {}),
  }
}

/** The look of the words that name a kind of mark (`] show explainer`, `] next citation`), on the bar and in the tray's
 *  header: the mark's own look at rest, as the reply draws it (an explainer's teal fill and a heads-up's orange one,
 *  explain/place.mjs markColors; a citation's underline, marks/view.ts citeLook), so the words that name a mark show
 *  what it looks like. A card has none. In the theme set the drawing read last (themeNow). */
function kindLook(kind: string | null | undefined): Record<string, unknown> | null {
  const c = markColors(themeLast())
  if (kind === 'explain') return { backgroundColor: c.glossBg }
  if (kind === 'heads') return { backgroundColor: c.headsBg }
  if (kind === 'citation') return { underline: true }
  return null
}

/** A bar item's `marked`: the words `what` that name a kind of mark, in its look (kindLook); nothing for a card. */
const markedAs = (what: string | undefined, kind: string | null | undefined): Pick<BarItem, 'marked'> => {
  const look = kindLook(kind)
  return what && look ? { marked: { words: what, look } } : {}
}

// ------------------------------------------------------------------------------------------------ what a mark is

type Info = { begins: string; words?: string; status?: string; failedBy?: string; evidence?: MarkItem['evidence']; item?: MarkItem; gloss?: Gloss }

async function itemOf($: Engine, row: string, n: number): Promise<MarkItem | null> {
  return (await rowMarks($, row))?.items.find(x => x.n === n) ?? null
}

/** An explainer or a heads-up of the row; an explainer still being written (explain/seam.ts pendingGloss) is its words
 *  alone. */
async function glossOf($: Engine, row: string, id: string): Promise<Gloss | null> {
  return (await partOf<ExplainPart>($, row, 'explain'))?.items?.[id] ?? pendingGloss(row, id)
}

/** Whether the frame is an explainer still being written: the tray stands on its words until it is (explain/seam.ts
 *  pendingGloss). */
const beingWritten = (f: Frame): boolean => f.kind === 'explain' && !!pendingGloss(f.row, f.id)

/** What the tray and the side thread read of a frame. */
async function infoOf($: Engine, f: Frame): Promise<Info> {
  const begins = (await shownOf($, f.row))?.text ?? (await messageOf($, f.row))?.text ?? ''
  if (f.kind === 'citation') {
    const item = await itemOf($, f.row, f.n)
    return { begins: withoutMarks(begins), words: item?.shown ?? item?.words ?? '', status: item?.status, failedBy: item?.failedBy, evidence: item?.evidence, ...(item ? { item } : {}) }
  }
  if (f.kind === 'place') return { begins: withoutMarks(begins) }
  return { begins: withoutMarks(begins), gloss: (await glossOf($, f.row, f.id)) ?? undefined }
}

/** The mark as core/engaged.ts tells it. */
function engagedMark(f: Frame, info: Info): Any {
  if (f.kind === 'place') return null
  if (f.kind === 'citation') return { kind: 'citation', row: f.row, n: f.n, words: info.words ?? '', status: info.status, failedBy: info.failedBy }
  const g = info.gloss
  return f.kind === 'heads' ? { kind: 'heads', row: f.row, term: g?.term ?? '', title: g?.title ?? '' } : { kind: 'explain', row: f.row, term: g?.term ?? '' }
}

/** The person opened a mark: main hears it with their next prompt (an explainer still being written, once written). */
async function told($: Engine, f: Frame): Promise<void> {
  if (f.kind === 'explain' && pendingGloss(f.row, f.id)) return
  const info = await infoOf($, f)
  await tellOpened($, engagedMark(f, info), info.begins).catch(() => undefined)
}

/** The explainer or heads-up on a citation's words, if any: a press on those words opens it (marks/view.ts markEl),
 *  and ] goes on to the citation; the citation, reached by ] [ or a press on its other words, offers it (h). */
async function innerOf($: Engine, f: Frame): Promise<Frame | null> {
  if (f.kind !== 'citation') return null
  const shown = await shownOf($, f.row)
  if (!shown) return null
  const c = (await citesOf($, f.row, shown)).find(x => x.n === f.n)
  if (!c) return null
  const s = (await spansOf($, f.row, shown)).find(x => x.start >= c.start + 1 && x.end <= c.start + 1 + c.words.length)
  return s ? { row: f.row, kind: s.kind, id: s.id } : null
}

/** A citation's evidence (or one of its other places) cites lines of the place `p` of a file; a whole file is no
 *  citation's. */
function citesPlace(ev: Any, p: { path: string; from: number | null; to: number | null }): boolean {
  if (p.from == null) return false
  const same = (file: string) => !!file && (file === p.path || file.endsWith(`/${p.path}`) || p.path.endsWith(`/${file}`))
  return [ev, ...(Array.isArray(ev?.more) ? ev.more : [])].some(pl => {
    if (!same(String(pl?.file ?? ''))) return false
    const m = /^(\d+)(?:\D+(\d+))?/.exec(String(pl.line ?? ''))
    return !!m && Number(m[1]) <= (p.to ?? p.from) && Number(m[2] || m[1]) >= p.from
  })
}

/** The citations of an explainer's or a heads-up's words, drawn as the answer's (`text`, its links to a file's lines
 *  made citations, explain/place.mjs citeLinks): each the answer's citation with the same words (marks/register.ts
 *  looksByWords) or of the same lines, else, for a link to a file's lines, those lines (`opens`: the frame each opens,
 *  by their order in the words; null: none). */
async function linksOf($: Engine, f: Frame, raw: string): Promise<{ text: string; marks: { start: number; end: number; words: string }[]; looks: Any[]; opens: (Frame | null)[] }> {
  const { text, places } = citeLinks(raw) as { text: string; places: ({ path: string; from: number | null; to: number | null } | null)[] }
  const marks = marksIn(text)
  const items = (await rowMarks($, f.row))?.items ?? []
  const byWords = looksByWords(marks, items, false)
  const looks: Any[] = []
  const opens: (Frame | null)[] = []
  marks.forEach((_m, k) => {
    const p = places[k]
    const it = p ? items.find(x => x.evidence && citesPlace(x.evidence, p)) : null
    const look = it ? { n: it.n, status: it.status === 'corrected' && it.rewrite ? 'failed' : it.status } : p ? { n: 0, status: 'unchecked' } : byWords[k]
    looks.push(look)
    opens.push(look?.n > 0 ? { row: f.row, kind: 'citation', n: look.n } : p ? { row: f.row, kind: 'place', id: `${p.path}${p.from ? `:${p.from}${p.to && p.to !== p.from ? `-${p.to}` : ''}` : ''}` } : null)
  })
  return { text, marks, looks, opens }
}

// ------------------------------------------------------------------------------------------------ what the person does

/** Bring a mark into view where the chat draws it (a press on the bar's ] may open one in a reply above the screen): a
 *  card by the row it is drawn in (cards/draw.ts revealCard). Claude Code moves the chat for a press, not for a key. */
async function reveal($: Engine, at: { row: string; card?: string }): Promise<void> {
  if (at.card) await quietly(revealCard($, at.card))
  else await quietly($.ui.scroll({ to: { requestId: at.row }, block: 'nearest' }))
}

/** Open the tray on a mark (a press on it, ] and [): its answer becomes the one the keys act on. */
export async function openMark($: Engine, f: Frame, o: { reveal?: boolean } = {}): Promise<void> {
  // a citation that waits to be checked until it is opened (Citations auto cite, or words asked about with c) starts
  // its check: the spawn first
  if (f.kind === 'citation') await checkOpened($, f.row, f.n).catch(() => undefined)
  await setTray($, open(f) as Tray)
  const t = await turnOfRow($, f.row)
  if (t?.answer) await pickAnswer($, t.answer)
  await told($, f)
  await quietly(markSeen($, f))
  if (o.reveal) await reveal($, f)
}

/** A mark over the one the tray shows (a citation inside an explainer, the explainer on a citation's words). */
async function pushMark($: Engine, f: Frame): Promise<void> {
  await setTray($, push(await trayNow($), f) as Tray)
  await told($, f)
  await quietly(markSeen($, f))
}

/** 0: the mark under this one, then closed. */
async function goBack($: Engine): Promise<void> {
  const tray = await trayNow($)
  if (tray) await setTray($, back(tray) as Tray)
}

/** A second click on the mark the tray shows: it closes, as 0 does (the one under it shows again, if any). */
async function pressedAgain($: Engine, f: Frame): Promise<boolean> {
  const tray = await trayNow($)
  if (!tray || !sameRef(top(tray), f)) return false
  await setTray($, back(tray) as Tray)
  return true
}

/** +, or a click on `+ show all` in the header of a cut card or on one of its markers: all of the mark in the side
 *  pane, the pane a opens on it (threads/seam.ts openThread): a citation's whole evidence (marks/evidence.tsx: what the
 *  check found, the sentence, all the code and the output), an explainer's or a heads-up's words, a file's lines, with
 *  the side thread about it under them. It opens to be read: the pane takes the keys, so ↑ ↓ and the page keys scroll
 *  it as the wheel does, and its input waits for a click or tab. `byKey`: + at the prompt, which Claude Code lets open
 *  no pane in a narrow terminal; the line then says to click `show all`. The tray gives way to the pane once it
 *  opened. */
async function showAll($: Engine, f: Frame, byKey = false): Promise<void> {
  const info = await infoOf($, f)
  // the words of the header's key to click, which stays there while the line takes a row of the band: the card, cut to
  // fewer rows, still leaves lines out
  const more = byKey ? { key: SHOW_ALL.key, click: SHOW_ALL.words, where: 'in the tray' } : {}
  const placed = await openThread($, { about: aboutOf(f, info), mark: refOf(f) as MarkRef }, { read: true, ...more })
  if (placed) await setTray($, null)
}

/** A card ] reached takes the keys, its own first, and shows framed in focus. */
async function standOn($: Engine, row: string, card: string): Promise<void> {
  await setTray($, null)
  await setFocus($, card)
  await writeStand($, { row, card })
  const t = await turnOfRow($, row)
  if (t?.answer) await pickAnswer($, t.answer)
  await reveal($, { row, card })
}

/** ] and [: the next mark or card in reading order, and the one before. From rest, the answer the keys act on (else
 *  the newest answer's): ] the first of its marks the person has not opened, else its first mark (restNext), [ its last
 *  stop (restStop). At the newest reply's last stop, ] stays. */
export async function stepMark($: Engine, dir: number): Promise<void> {
  const { list, at } = await stepPlace($)
  let next: Stop | null = null
  if (at >= 0) { next = stepFrom(list, at, dir) as Stop | null; if (!next) return }
  else {
    const row = await actingRow($)
    const turn = row ? await turnOfRow($, row) : null
    const here = list.filter(p => (turn ? turn.rows.includes(p.row) : p.row === row))
    const pool = here.length ? here : list.filter(p => p.row === list[list.length - 1]?.row)
    next = (dir > 0 && here.length ? restNext(here, await seenNow($)) : restStop(pool, dir)) as Stop | null
  }
  if (!next) return
  if (next.card) await standOn($, next.row, next.card)
  else await openMark($, refOf(next) as Frame, { reveal: true })
}

/** The bar's words that open a side thread where the a key cannot: Claude Code places the pane at any width only for a
 *  press (`a ask` in the bar, or in the tray's header), never for a key at the prompt. */
const ASK_WORDS = 'a ask'

/** a, or a press on `a ask`: a side thread about the mark the tray shows; the tray gives way to it when it opened. */
async function askAbout($: Engine, f: Frame, byKey = false): Promise<void> {
  const info = await infoOf($, f)
  const placed = await openThread($, { about: aboutOf(f, info), mark: refOf(f) as MarkRef }, byKey ? { key: ASK_WORDS, where: 'in the tray' } : {})
  if (placed) await setTray($, null)
}

/** a, or a press on `a ask`, on the card ] reached: a side thread about it. */
async function askCard($: Engine, stand: NonNullable<Stand>, byKey = false): Promise<void> {
  const meta = await metaOf($, stand.card)
  await openThread($, { about: `the card "${meta?.title ?? stand.card}"`, card: stand.card }, byKey ? { key: ASK_WORDS } : {})
}

/** The Button keys of `x repair`: in the citation's card, and in the bar (bar.tsx draws an item as `bar-<id>`). */
const REPAIR_KEYS = new Set(['repair', 'bar-tray-x'])

/** x, or a click on `x repair`, on the citation the tray shows: a check of it again in the background
 *  (marks/checker.ts). The repair starts inside the hook that calls this; `hold` waits out a key's word window. */
async function repair($: Engine, f: Frame, hold: { until: number; cancelled: boolean }): Promise<boolean> {
  if (f.kind !== 'citation') return false
  const r = await repairOf($, f.row, f.n)
  if (r === null) return false
  const why = typeof r === 'string' ? r : await launchRepair($, r, hold)
  if (why) failNotice($, why, 'tray:repair')
  return true
}

// ------------------------------------------------------------------------------------------------ the keys

/** Whether the squeeze chips hold the keys now (their items show as the bar's focus): [ and ] are theirs then. */
async function chipsOpen($: Engine): Promise<boolean> {
  try { return await squeezeHolds($) } catch { return false }
}

/** The tray's keys at an empty prompt (hooks/keys.ts takes them as a Take): ] and [ always (but while the squeeze chips
 *  are open at rest), its own while it is open, a's and 0 on a card ] reached. */
export async function trayKey($: Engine, key: string, until = 0): Promise<Any | null> {
  const k = await keptNow($)
  const tray = k.tray
  const stand = tray ? null : k.stand
  if (key === ']' || key === '[') {
    if (!tray && !stand && (await chipsOpen($))) return null
    // with nothing to step to, ] and [ are the prompt's
    if (!tray && !stand && !(await allStops($)).length) return null
    return { now: () => stepMark($, key === ']' ? 1 : -1) }
  }
  if (stand) {
    if (key === 'a') return { later: () => askCard($, stand, true) }
    if (key === '0') return { now: () => writeStand($, null) }
    return null
  }
  const f = top(tray) as Frame | null
  if (!f) return null
  if (key === '0') return { now: () => goBack($) }
  if (key === 'a') return { later: () => askAbout($, f, true) }
  if (key === '1') return { now: () => askAbout($, f, true) }
  // on a cut card: all of the mark in the side pane, once the + is out of the prompt box, which gives the pane the
  // keyboard only over an empty box
  if (key === '+' && cutNow?.ref === frameKey(f)) return { later: () => showAll($, f, true) }
  if (f.kind === 'citation') {
    // only the keys that act on the citation read it: a key's hook has a few milliseconds of its own time
    if (key === 'x' && canRepair(await itemOf($, f.row, f.n))) {
      const r = await repairOf($, f.row, f.n)
      if (r === null) return null
      if (typeof r === 'string') return { later: async () => failNotice($, r, 'tray:repair') }
      // the spawn is made while this key's hook runs (launchRepair's first call), and waits out the word window
      // (marks/register.ts); a word refuses it
      const hold = { until, cancelled: false }
      const failed = (err: unknown) => failNotice($, `The repair did not start: ${reasonOf(err)}. Press x to try again.`, 'tray:repair')
      return {
        now: async () => { void launchRepair($, r, hold).then(why => { if (why) failNotice($, why, 'tray:repair') }, failed) },
        undo: async () => { hold.cancelled = true },
      }
    }
    if (key === 'h') {
      const inner = await innerOf($, f)
      if (inner) return { later: () => pushMark($, inner) }
    }
    return null
  }
  if (f.kind === 'place') return null
  const g = await glossOf($, f.row, f.id)
  if (/^[2-9]$/.test(key) && g) {
    const to = (await linksOf($, f, explainerText(g))).opens.filter(Boolean).slice(0, 8)[Number(key) - 2]
    if (to) return { now: () => pushMark($, to) }
  }
  return null
}

// ------------------------------------------------------------------------------------------------ the bar

/** The tray's items at the bar's left: while a card ] reached holds the keys, its keys, as `focus` items, so the bar
 *  names only those; while a tray is open, ] and [ beside the bar's own keys (its other keys are in its header); at
 *  rest, ] (restItem). */
export async function trayBar($: Engine, _on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (preview) return []
  const tray = await trayNow($)
  const stand = tray ? null : await standNow($)
  const steps = async (focus: boolean): Promise<BarItem[]> => {
    const ends = await stepEnds($)
    await themeNow($)
    // on a narrow bar, as at rest (restWords): the mark's name alone, then the key alone
    return stepWords(ends).map((s: Any) => ({ id: `tray-${s.key}`, key: s.key, words: s.words, shorter: s.what ? [s.what, ''] : [''], ...markedAs(s.what, s.kind), ...(focus ? { focus: true } : {}), press: () => stepMark($, s.key === ']' ? 1 : -1) }))
  }
  if (stand) {
    return [
      { id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askCard($, stand) },
      ...(await steps(true)),
      { id: 'tray-0', key: '0', words: 'back', focus: true, press: () => writeStand($, null) },
    ]
  }
  // an open tray: ] and [ stay on the bar, where they are at rest, beside the bar's own keys; its other keys are in its
  // header (trayKeys)
  return tray ? steps(false) : restItem($)
}

/** At rest, while the answer the keys act on shows marks: ] and the mark it opens from rest (restNext), a press too:
 *  `] show explainer` for the answer's first mark, `] next citation` for a later one, the words that name the mark in
 *  its own look (markedAs), so the bar shows what each look is while the answer has marks. The rest of its words in
 *  thimble's color while the answer shows a mark the person has not opened (markSeen). On a narrow bar its words give
 *  way after coverage's file counts: the verb first (`] explainer`), and after the busy step's words the mark's name
 *  (`]` alone) (bar/bar.tsx). */
async function restItem($: Engine): Promise<BarItem[]> {
  const row = await actingRow($)
  const marks = row ? await answerMarks($, row) : []
  if (!marks.length) return []
  const seen = await seenNow($)
  const fresh = marks.some(p => !seen.has(seenRef(p)))
  const next = restNext(marks, seen)
  const w = restWords(next, marks.indexOf(next!) === 0)
  await themeNow($)
  return [{ id: 'tray-next', key: ']', words: w.words, shorter: w.shorter, ...markedAs(w.what, w.kind), ...(fresh ? { color: accent() } : {}), press: () => stepMark($, 1) }]
}

/** An open tray's keys, in its header at the right, each a click that does what its key does: h the explainer on a
 *  citation's words, + show all (showAll), which the header names only while the card leaves lines out (trayBand), a
 *  ask, 0 back or close (] and [ are on the bar, trayBar). x repair is in the citation's card, where it acts, and 2–9
 *  are its links in an explainer's words. */
async function trayKeys($: Engine, tray: NonNullable<Tray>, f: Frame): Promise<BarItem[]> {
  await themeNow($)
  const out: BarItem[] = []
  if (f.kind === 'citation') {
    const inner = await innerOf($, f)
    if (inner) {
      const g = inner.kind !== 'citation' ? await glossOf($, inner.row, inner.id) : null
      const term = String(g?.term ?? '')
      out.push({ id: 'tray-h', key: 'h', words: inner.kind === 'heads' ? 'heads-up' : `explain ${term.length > 24 ? `${term.slice(0, 23)}…` : term}`, press: () => pushMark($, inner) })
    }
  }
  out.push({ id: 'tray-+', key: SHOW_ALL.key, words: SHOW_ALL.words, press: () => showAll($, f) })
  out.push({ id: 'tray-a', key: 'a', words: 'ask', press: () => askAbout($, f) })
  out.push({ id: 'tray-0', key: '0', words: tray.stack.length > 1 ? 'back' : 'close', press: () => goBack($) })
  return out
}

// ------------------------------------------------------------------------------------------------ the answer view

/** What the tray shows on this row, so the row draws it in focus. */
export async function trayFocus($: Engine, row: string): Promise<MarkRef | null> {
  const f = top(await trayNow($)) as Frame | null
  return f && f.row === row && f.kind !== 'place' ? (refOf(f) as MarkRef) : null
}

/** A press on a citation opens the tray on it, as in 0.10 (its whole evidence is a click on its place there); a press
 *  on the one it shows closes it. */
export async function markPressed($: Engine, row: string, n: number): Promise<boolean> {
  if (!(n > 0)) return false
  const f: Frame = { row, kind: 'citation', n }
  if (await pressedAgain($, f)) return true
  await openMark($, f)
  return true
}

/** The tray on an explainer or a heads-up (a press on its words, explain/seam.ts); a press on the one it shows closes
 *  it. */
export async function openTray($: Engine, mark: MarkRef): Promise<boolean> {
  if (!mark || !mark.row) return false
  if (await pressedAgain($, { ...mark } as Frame)) return true
  await openMark($, { ...mark })
  return true
}

// ------------------------------------------------------------------------------------------------ the band

async function hyperlinksHere($: Engine): Promise<boolean> {
  // each name literal at its call, so the variables the module reads can be listed
  const env: Record<string, string | undefined> = {
    FORCE_HYPERLINK: await $.env.get('FORCE_HYPERLINK'), TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TERM_PROGRAM_VERSION: await $.env.get('TERM_PROGRAM_VERSION'), LC_TERMINAL: await $.env.get('LC_TERMINAL'),
    TERMINAL_EMULATOR: await $.env.get('TERMINAL_EMULATOR'), WT_SESSION: await $.env.get('WT_SESSION'), TMUX: await $.env.get('TMUX'),
    TERM: await $.env.get('TERM'), CI: await $.env.get('CI'), TEAMCITY_VERSION: await $.env.get('TEAMCITY_VERSION'), VTE_VERSION: await $.env.get('VTE_VERSION'),
  }
  return drawsHyperlinks(env)
}

/** A citation's status as its header says it, in the words the evidence pane and the claims pane say it in (tray.mjs
 *  checkStatus): the sign the reply draws after the citation's words in that status, so the tray says what it means
 *  (the turning glyph while it is checked, × failed, ? not checked yet; ✓ for a checked one, which has none there), and
 *  its word: verified, or corrected (the right words in place of the ones Claude wrote, which the line under it gives),
 *  repaired when x corrected it. Failed for one with no check (marks/store.ts notRun; one the store no longer holds,
 *  whose reply the reply draws failed too, says so under it). */
const statusOf = (m: MarkItem | null) => checkStatus(m)

/** A part of the tray's body and the rows it takes; `short`, the same on one row, which a cut card shows (fitCitation);
 *  `code`, in place of `el`, a line of code, which unitEls draws with the lines of code beside it; `cut`, in place of
 *  `el`, a marker where the card leaves lines out: how many, and whether they stand above or below the lines it shows
 *  (cutRow draws it). */
type Unit = { h: number; el?: Any; code?: string; short?: Unit; cut?: { n: number; where: 'above' | 'below' } }

/** A card's units as elements: lines of code next to each other as one Code, which Claude Code draws in its own colors
 *  for Python, as the side pane draws the code (marks/evidence.tsx), each line on one row. */
function unitEls(els: Any, units: Unit[]): Any[] {
  const out: Any[] = []
  let code: string[] = []
  const flush = () => {
    if (code.length) out.push(els.Code({ key: `code${out.length}`, source: code.join('\n'), language: 'python', wrap: 'truncate-end' }))
    code = []
  }
  for (const u of units) {
    if (u.code === undefined) { flush(); out.push(u.el) } else code.push(u.code)
  }
  flush()
  return out
}

/** A line of evidence in the ruled block under its label: a dim rule on the left, so code and output read apart, and
 *  the line, the cited words on the citations' purple tint (marks/evidence.tsx evidenceWords); `dim`, a line around
 *  the cited one. */
function ruled(els: Any, text: string, spans: [number, number][], w: number, key: string, dim = false): Unit {
  const { Box, Text } = els
  const h = rowsOf(text, w - 2)
  return { h, el: Box({ key, flexDirection: 'row', children: [
    Text({ key: 'rule', dimColor: true, children: Array(h).fill('│').join('\n') }),
    Box({ key: 'l', flexShrink: 1, marginLeft: 1, children: [dim ? Text({ key: 't', dimColor: true, wrap: 'wrap', children: text || ' ' }) : highlighted(els, text, spans, 't')] }),
  ] }) }
}

/** The label over a part of a citation's evidence (tray.mjs partLabel, TABLE_LABEL, cardLabel), dim, on one row. */
function labelRow(els: Any, key: string, words: string): Unit {
  return { h: 1, el: els.Text({ key, dimColor: true, wrap: 'truncate-end', children: words }) }
}

/** `x repair`, a press that checks a failed citation again (this module's ui.press hook, as x does); for one whose
 *  check did not run, `x repair: start its check`. In its card. */
function repairRow(els: Any, m: MarkItem): Unit {
  const { Text } = els
  const unrun = m.status === 'failed' && m.failedBy === 'none'
  return { h: 1, el: els.Button({ key: 'repair', plain: true, label: unrun ? 'check this citation' : 'repair this citation', hover: { bold: true }, onPress: () => undefined, children: [
    Text({ key: 'k', wrap: 'truncate-end', children: [Text({ key: 'x', bold: true, color: accent(), children: 'x' }), Text({ key: 'w', children: ' repair' }), Text({ key: 'd', dimColor: true, children: unrun ? ': start its check' : ': check it again and correct the cited words' })] }),
  ] }) }
}

/** A part of a citation's evidence: its lines, one row each, of which a cut card shows a window around the line it
 *  keeps in view (`key`): the code around the line that printed the value, the printed output around the line that
 *  holds it, a file's lines around the cited one, a table's header over its cited row. `draw(i)`: line i, the lines
 *  around the cited ones dim. `lead`: its label, the row over it (labelRow; a file's place). `gap`: a blank row over the
 *  part, between it and the part above it (the output's, under the code). */
type Block = { n: number; key: number; draw: (i: number) => Unit; lead?: Unit; gap?: Unit }

/** A citation's card under its header (the status is in the header): what it says over its evidence (`top`), then its
 *  evidence in parts (Block), each under its label. A corrected one says what it was (`was 15 of 40`; a rewritten
 *  sentence or a narrowed citation says which, as the header says only corrected or repaired); a failed one why in one
 *  sentence; after a repair (x) that verified it as written, why; all dim, and under it `x repair` (repairRow). For a
 *  value code computed: the code under `code · 7 lines`, in Claude Code's colors for Python (unitEls), around the line
 *  that printed the value (tray.mjs printedAt; from its start when the code does not show which line printed it), a
 *  blank row, then under `output · 62 lines` the printed output around the line that holds it in the ruled block;
 *  printed output that is a table shows as its header over the cited row, under `output · table`. For a file: its
 *  place (`place`, a click opens the side pane), then its lines around the cited one in the ruled block. For a card's
 *  value: the card, then the header over the cited row, or its printed lines around the cited one. The cited words
 *  stand on the citations' purple tint. */
function citationParts(els: Any, m: MarkItem | null, w: number, place: Any | null): { top: Unit[]; blocks: Block[] } {
  const { Text } = els
  if (!m) return { top: [{ h: 1, el: Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: 'This citation is no longer in the session.' }) }], blocks: [] }
  const ev = printableEvidence(m.evidence)
  const top: Unit[] = []
  const dim = (key: string, text: string) => top.push({
    h: rowsOf(text, w), el: Text({ key, dimColor: true, wrap: 'wrap', children: text }),
    short: { h: 1, el: Text({ key, dimColor: true, wrap: 'truncate-end', children: text }) },
  })
  const notFixed = m.repair ? 'not repaired: ' : ''
  // a rewrite's history is the sentence Claude wrote
  if (m.status === 'corrected' && m.was) dim('was', wasLine({ rewritten: !!m.rewrite, narrowed: !!m.narrowed, was: m.rewrite ? plainSentence(m.sentence) : m.was }))
  else if (m.status === 'failed' && m.reason) dim('why', `${notFixed}${firstSentence(m.reason)}`)
  else if (m.status === 'checking') dim('why', m.repair ? 'The repair is running: the check reads the records again.' : 'The check is running.')
  else if (m.repair && m.status === 'verified') dim('why', `verified as written${m.reason ? `: ${firstSentence(m.reason)}` : ''}`)
  // a check that did not run: x starts it
  const unrun = m.status === 'failed' && m.failedBy === 'none'
  if (canRepair(m)) top.push(repairRow(els, m))
  if (!ev) {
    if (m.status !== 'checking' && !unrun) dim('none', 'The check gave no evidence for it.')
    return { top, blocks: [] }
  }
  if (m.status === 'checking') return { top, blocks: [] }
  const table = ev.kind === 'card' || ev.kind === 'computed' ? ev.table : undefined
  const tl = table ? tableLines(table, w - 2) : null
  // a table: its header over the cited rows, the first cited row kept in view
  const tableBlock = (rows: { text: string; spans: [number, number][] }[], lead: Unit): Block => ({
    n: rows.length, key: Math.min(1, rows.length - 1), lead,
    draw: i => ruled(els, rows[i]!.text, i ? rows[i]!.spans : [], w, i ? `tr${i}` : 'th'),
  })
  // printed output, one row a line: the line that holds the value (its words on the citations' tint), the others dim;
  // `lead` its label, or the label of the output's own size
  const outputBlock = (lead?: Unit): Block => {
    const out = String(ev.kind === 'card' && ev.output == null ? ev.value ?? '' : ev.output ?? '').replace(/\n+$/, '')
    const lines = out.split('\n')
    const spans = (ev.kind === 'card' && ev.output == null ? (out ? [[0, out.length]] : []) : ev.highlight ?? []) as [number, number][]
    const starts: number[] = []
    lines.reduce((at, l) => { starts.push(at); return at + l.length + 1 }, 0)
    const key = Math.max(0, ev.kind === 'card' && ev.output == null ? 0 : outputAt(ev))
    return { n: lines.length, key, lead: lead ?? labelRow(els, 'out-label', partLabel('output', lines.length)), draw: i => {
      const s = starts[i]!
      const mine = spans.map(([a, b]) => [Math.max(a, s) - s, Math.min(b, s + lines[i]!.length) - s] as [number, number]).filter(([a, b]) => b > a)
      const cut = lineWindow({ text: lines[i]!, spans: mine }, w - 2) as { text: string; spans: [number, number][] }
      return ruled(els, cut.text, cut.spans, w, i === key ? 'ev' : `o${i}`, i !== key)
    } }
  }
  if (ev.kind === 'card') {
    const lead = labelRow(els, 'card', cardLabel(ev.title || ev.card))
    return { top, blocks: [tl ? tableBlock(tl as { text: string; spans: [number, number][] }[], lead) : outputBlock(lead)] }
  }
  if (ev.kind === 'computed') {
    const blocks: Block[] = []
    // its lines, without the empty one a last newline leaves; an empty line as a space, so Claude Code gives it its row
    // at the end of the window too
    const code = String(ev.code ?? '').replace(/\n+$/, '').split('\n')
    if (code.some(l => l.trim())) {
      const p = printedAt(ev)
      blocks.push({ n: code.length, key: Math.max(0, p), lead: labelRow(els, 'code-label', partLabel('code', code.length)), draw: i => ({ h: 1, code: code[i] || ' ' }) })
    }
    const out = tl ? tableBlock(tl as { text: string; spans: [number, number][] }[], labelRow(els, 'out-label', TABLE_LABEL)) : outputBlock()
    // under the code, a blank row before its output
    blocks.push(blocks.length ? { ...out, gap: { h: 1, el: Text({ key: 'gap', children: ' ' }) } } : out)
    return { top, blocks }
  }
  // a file's lines: those the check read around the cited ones, which stay bright
  const lines = (Array.isArray(ev.lines) ? ev.lines : []) as { n: number; text: string; highlight?: [number, number] }[]
  const hit = evidenceLine(ev)
  if (!hit || !lines.length) return { top, blocks: [] }
  const key = Math.max(0, lines.findIndex(l => l.n === hit.n))
  const cited = (n: number) => { const [a, b] = String(ev.line ?? '').split('-').map(Number); return n >= a! && n <= (Number.isNaN(b) || b === undefined ? a! : b) }
  return { top, blocks: [{ n: lines.length, key, ...(place ? { lead: { h: 1, el: place } } : {}), draw: i => {
    const l = lines[i]!
    const cut = lineWindow({ text: String(l.text ?? ''), spans: l.highlight ? [l.highlight] : [] }, w - 2) as { text: string; spans: [number, number][] }
    return ruled(els, cut.text, cut.spans, w, i === key ? 'ev' : `q${i}`, i !== key && !cited(l.n))
  } }] }
}

/** What shows of a citation's evidence (fitCitation): of each part, the blank row over it and its label where they
 *  show, then its window of lines (tray.mjs around), with a marker over the window when it starts after the part's
 *  first line and one under it when it ends before its last (Unit `cut`). A part that shows no line shows nothing, and
 *  its lines join the marker beside them: the next part's over its window, else one under the part before. `line(i,
 *  j)`: line j of part i. */
function cutUnits(blocks: Block[], show: { size: number[]; lead: boolean[]; gap: boolean[] }, line: (i: number, j: number) => Unit): Unit[] {
  const out: Unit[] = []
  const cut = (n: number, where: 'above' | 'below'): Unit => ({ h: 1, cut: { n, where } })
  // the lines of the parts before that show none
  let left = 0
  blocks.forEach((b, i) => {
    if (!show.size[i]) { left += b.n; return }
    const [from, to] = around(b.n, b.key, show.size[i]!) as [number, number]
    if (show.gap[i]) out.push(b.gap!)
    if (show.lead[i]) out.push(b.lead!)
    if (left + from) out.push(cut(left + from, 'above'))
    left = 0
    for (let j = from; j < to; j++) out.push(line(i, j))
    if (to < b.n) out.push(cut(b.n - to, 'below'))
  })
  const last = out[out.length - 1]
  if (left && last?.cut) last.cut.n += left
  else if (left) out.push(cut(left, 'below'))
  return out
}

/** A citation's card in at most `rows` rows: whole when it fits, with no marker. Else cut: what it says over its
 *  evidence on a row each, then its parts (cutUnits), a marker at each place it leaves lines out, which says how many.
 *  A marker shows before anything that may be left out, so no line is left out without one: first the key lines (the
 *  value's line, then the line that printed it), with their markers; then, while each part shows a line, the blank row
 *  between the code and its output, then the parts' labels; then a line more to each part in turn, as rows allow. */
function fitCitation(parts: { top: Unit[]; blocks: Block[] }, rows: number): Unit[] {
  const sum = (us: Unit[]) => us.reduce((n, u) => n + u.h, 0)
  const blocks = parts.blocks
  const all = [...parts.top, ...blocks.flatMap(b => [...(b.gap ? [b.gap] : []), ...(b.lead ? [b.lead] : []), ...Array.from({ length: b.n }, (_, i) => b.draw(i))])]
  if (sum(all) <= rows) return all
  const top = parts.top.map(u => u.short ?? u)
  // a row at least for the evidence: its marker, when no line of it fits
  while (top.length && rows - sum(top) < 1) top.pop()
  const room = rows - sum(top)
  // each line drawn once, however often the card is laid out
  const drawn = blocks.map(() => new Map<number, Unit>())
  const line = (i: number, j: number): Unit => drawn[i]!.get(j) ?? drawn[i]!.set(j, blocks[i]!.draw(j)).get(j)!
  const show = { size: blocks.map(() => 0), lead: blocks.map(() => false), gap: blocks.map(() => false) }
  // a change of what shows, kept while the card fits in its rows (a line more may take a marker's row)
  const fits = (change: () => void, undo: () => void): boolean => {
    change()
    if (sum(cutUnits(blocks, show, line)) <= room) return true
    undo()
    return false
  }
  // the output's part first, then the code's
  const order = blocks.map((_, i) => i).reverse()
  for (const i of order) if (blocks[i]!.n) fits(() => { show.size[i] = 1 }, () => { show.size[i] = 0 })
  // the blank row between two parts, and a part's label, only while each part shows a line
  if (blocks.every((b, i) => show.size[i] || !b.n)) {
    for (const i of order) if (blocks[i]!.gap && i > 0) fits(() => { show.gap[i] = true }, () => { show.gap[i] = false })
    for (const i of order) if (blocks[i]!.lead) fits(() => { show.lead[i] = true }, () => { show.lead[i] = false })
  }
  for (let grew = true; grew;) {
    grew = false
    for (const i of order) if (show.size[i] && show.size[i]! < blocks[i]!.n && fits(() => { show.size[i]!++ }, () => { show.size[i]!-- })) grew = true
  }
  return [...top, ...cutUnits(blocks, show, line)]
}

/** A marker where the tray leaves lines out, dim: how many, and where (tray.mjs cutWords: `⋯ 5 lines above`), a click
 *  that shows all of the mark in the side pane, as + does (showAll), which the header names. Underlined under the
 *  pointer. */
function cutRow(els: Any, cut: { n: number; where: 'above' | 'below' }, key: string, press: () => unknown): Unit {
  const { Button, Text } = els
  return { h: 1, el: Button({ key, plain: true, label: 'show all of it in the side pane', hover: quiet(key), onPress: press, children: [
    Text({ key: 'w', dimColor: true, wrap: 'truncate-end', children: cutWords(cut.n, cut.where) }),
  ] }) }
}

/** The press on a citation's file place: the citation's evidence in the side pane. The open is awaited inside the
 *  handler, so it is made while the person's press runs: Claude Code places a pane at any width only for such an open,
 *  and one left to run after the handler returned (`void openPane(...)`) is unasked and waits undrawn below 144
 *  columns (110 for a pane the person opened before). When Claude Code still places none (no surface here draws
 *  panes), the notice says so; the tray keeps showing the cited line. */
export function evidenceOpener($: Engine, f: { row: string; n: number }): () => Promise<void> {
  return async () => {
    const placed = await openPane($, 'evidence', { row: f.row, n: f.n }, `citation ${f.n}`).catch(() => true)
    if (!placed) failNotice($, 'Claude Code did not open the citation\'s evidence here; the tray above still shows the cited line.', 'tray')
  }
}

/** In a citation of a file's lines, the label over them: the file's place (tray.mjs placeLabel, `runs.jsonl · line
 *  41`), dim, a click that opens the citation's whole evidence in the side pane, which works over ssh too. Where Claude
 *  Code draws OSC 8 hyperlinks it is also a link to the file, which a ctrl or cmd click opens on this machine. */
async function fileLinkEl($: Engine, els: Any, f: Frame, m: MarkItem | null): Promise<Any | null> {
  const ev = m?.evidence
  if (!ev || ev.kind === 'computed' || ev.kind === 'card' || f.kind !== 'citation') return null
  const label = printable(placeLabel(ev.file, evidenceLine(ev)?.n ?? ev.line))
  const openIt = evidenceOpener($, f)
  if (els.Markdown && (await hyperlinksHere($))) {
    const start = await startDir($)
    const abs = ev.file.startsWith('/') ? ev.file : `${start.replace(/\/+$/, '')}/${ev.file}`
    const href = fileHref(abs, String(evidenceLine(ev)?.n ?? ev.line))
    return els.Markdown({ key: 'tray-file', text: `[${label.replace(/[[\]\\]/g, c => '\\' + c)}](${href})`, onLinkPress: openIt, pressableLinks: [href] })
  }
  return els.Button({ key: 'tray-file', plain: true, label: `open ${label}`, onPress: openIt, children: [els.Text({ dimColor: true, children: label })] })
}

/** The lines of a file an explainer's or a heads-up's words cite, as a citation of a file shows its evidence: in the
 *  ruled block, each line on one row, numbered (the title names the file). */
async function placeBody($: Engine, els: Any, f: Frame & { kind: 'place' }, w: number): Promise<Unit[]> {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(f.id)!
  const from = m[2] ? Number(m[2]) : null
  const got = await placeLines($, m[1]!, from, m[3] ? Number(m[3]) : from)
  if (typeof got === 'string') return [{ h: rowsOf(got, w), el: els.Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: got }) }]
  return got.map((l, i) => ruled(els, cutTitle(printable(`${l.n}  ${l.text}`.replace(/\t/g, '  ')), w - 2), [], w, `pl${i}`))
}

/** Whether the band's blank row stands between the tray as last drawn and the bar: a tray that does not fit with it
 *  takes it (bar/register.ts). */
let gapRow = true

/** What the tray as last drawn left out (the frame it showed, and how many lines in all): + shows it all in the side
 *  pane while the tray's header names it (showAll). */
let cutNow: { ref: string; n: number } | null = null
const frameKey = (f: Frame) => `${f.row}|${f.kind}|${f.kind === 'citation' ? f.n : f.id}`

/** The rows the band above the prompt has for the tray: those over the bar (bar/register.ts). */
export type BandRoom = { rows: number }

/** The tray as last drawn: whether the band's blank row stands between it and the bar (`gap`). */
export const trayShape = (): { gap: boolean } => ({ gap: gapRow })

/** The tray, drawn above the bar while it is open: one frame, its title (a citation's words, bold on the tint the
 *  reply gives the open mark, and a click that closes it, as in the reply) on top, a citation's status and its keys at
 *  its right (trayKeys), a blank row, then the mark's card, its rows starting where the title starts. It shows as much
 *  of the card as fits in the rows the band has over the bar (`room`; null: no limit), so the bar with ] and [ stays in
 *  view under it; the band's blank row over the bar stays while the whole card fits with it, and the one under the head
 *  while a row of the card fits under it. A taller card is cut to those rows: a citation keeps the line that printed
 *  its value and the line that holds it in view, with what fits around them (fitCitation); an explainer, a heads-up or
 *  a file's lines show from their start, a marker under them (`⋯ 9 lines below`). Each marker is a click (cutRow), and
 *  the header names + among its keys while the card leaves lines out (`+ show all`, a click too): each shows all of it
 *  in the side pane (showAll). */
export async function trayBand($: Engine, els: Any, width: number, room: BandRoom | null = null): Promise<Any[]> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  gapRow = true
  cutNow = null
  if (!tray || !f) { controlWords('tray', []); return [] }
  const { Box, Text } = els
  const w = Math.max(40, Math.min(104, width - 3))
  const inner = w - 4
  let title = ''
  let units: Unit[] = []
  let parts: { top: Unit[]; blocks: Block[] } | null = null
  let words: { text: string } | null = null
  let status: ReturnType<typeof statusOf> | null = null
  let citeStatus: MarkStatus | null = null
  if (f.kind === 'citation') {
    const m = await itemOf($, f.row, f.n)
    citeStatus = m?.status ?? null
    await themeNow($)
    title = (m?.shown ?? m?.words ?? `citation ${f.n}`).replace(/\*\*|`/g, '')
    status = statusOf(m)
    parts = citationParts(els, m, inner, await fileLinkEl($, els, f, m))
  } else if (f.kind === 'place') {
    title = f.id
    units = await placeBody($, els, f, inner)
  } else {
    const g = await glossOf($, f.row, f.id)
    const heads = f.kind === 'heads'
    title = String(g?.term || g?.title || (heads ? 'heads-up' : 'explainer'))
    if (!g) units = [{ h: 1, el: Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: `This ${heads ? 'heads-up' : 'explainer'} is no longer in the session.` }) }]
    // an explainer still being written (explain/seam.ts pendingGloss): its box is an explainer's, and where its words
    // will stand the turning glyph turns with the bar's and a citation's being checked (bar/busy.ts spinNow), no words
    else if (beingWritten(f)) units = [{ h: 1, el: Text({ key: 'writing', color: accent(), children: await spinNow($) }) }]
    else words = { text: explainerText(g) }
  }
  let body: Any[] = units.map(u => u.el)
  if (words) {
    // an explainer's or a heads-up's words, drawn as the reply draws its words (marks/view.ts messageEl): its citations,
    // and its links to a file's lines, in the citations' look; a click on one opens it over the explainer (linksOf)
    const { text, marks, looks, opens } = await linksOf($, f, words.text)
    const id = (f as { id: string }).id
    body = [
      ...(text.trim() ? [messageEl(els, {
        text, marks, looks, key: `tray-${f.row}-${id}`, cols: inner, first: false, spin: '', gutter: false,
        onMark: (k: number) => { const to = opens[k]; if (to) void pushMark($, to) },
      })] : []),
      ...body,
    ]
  }
  const tone = TONES[f.kind]
  // the title is the marked words, drawn as the reply draws the open mark (marks/view.ts markEl) but not underlined: bold
  // on its tint, a failed citation's in red; an explainer's or a heads-up's words on their stronger fill. A click on them
  // closes the tray, as a second click on the open mark in the reply does
  const fills = markColors(themeLast())
  const cite = f.kind === 'citation' ? wordsLook(citeStatus ?? 'failed', `tray:${f.row}:${f.n}`) : f.kind === 'place' ? wordsLook('unchecked', `tray:${f.row}:${f.id}`) : null
  const look: Any = cite
    ? { ...(cite.color ? { color: cite.color } : {}), hover: cite.hover, bold: true, backgroundColor: cite.hover.backgroundColor }
    : { bold: true, backgroundColor: f.kind === 'heads' ? fills.headsFocus : fills.glossFocus }
  const about = aboutOf(f, await infoOf($, f))
  // a citation's status: the turning glyph beside `checking` turns with the one after its words in the reply
  const spin = status?.sign === 'spin' ? await spinNow($) : ''
  // the head: the title, and its keys `ks` at the right, after a citation's status, each drawn as the bar draws a key
  // and a click that presses it
  const headOf = (ks: BarItem[]): Any => {
    const keysLen = ks.reduce((n, k) => n + (n ? 3 : 0) + `${k.key} ${k.words}`.length, 0)
    // the status: its sign, a space and its word, then two cells before the keys
    const rightLen = (status ? status.word.length + 4 : 0) + keysLen
    // the title and the keys on one row when both fit, else the title on a row of its own above them
    const oneRow = title.length + 2 + rightLen <= inner
    const titleEl = els.Button({ key: 'tray-title', plain: true, label: 'close the tray', hover: { inverse: false, ...(look.hover ? { scope: look.hover.scope } : {}) }, onPress: () => closeTray($), children: [
      Text({ key: 't', ...look, wrap: 'truncate-end', children: cutTitle(title, oneRow ? title.length : inner) }),
    ] })
    // each key's words dim, as the bar draws a key's, and the words that name a kind of mark (`] next heads up`) in that
    // mark's look (kindLook), as the bar's ] names it
    const keyEls = ks.flatMap((k, i) => [
      ...(i ? [Text({ key: `ksep${i}`, dimColor: true, children: ' · ' })] : []),
      els.Button({ key: k.id, plain: true, label: k.key === 'a' ? `ask about ${about}` : `${k.key} ${k.words}`, hover: quiet(k.id), onPress: k.press, children: [
        Text({ key: 'k', color: accent(), bold: true, children: k.key }),
        ...partsAround(` ${k.words}`, k.marked?.words).map((p: { s: string; marked: boolean }, j: number) => Text({ key: j ? `w${j}` : 'w', ...(p.marked ? k.marked!.look : { dimColor: true }), children: p.s })),
      ] }),
    ])
    const rightEl = Box({ key: 'r', flexDirection: 'row', ...(oneRow ? { flexShrink: 0 } : { flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }), children: [
      ...(status ? [...statusEls(els, status, spin), Text({ key: 'gap', children: '  ' })] : []),
      ...keyEls,
    ] })
    return oneRow
      ? Box({ key: 'tray-head', flexDirection: 'row', justifyContent: 'space-between', children: [Box({ key: 'l', flexShrink: 1, children: [titleEl] }), rightEl] })
      : Box({ key: 'tray-head', flexDirection: 'column', children: [titleEl, Box({ key: 'r-row', flexDirection: 'row', justifyContent: 'flex-end', width: inner, children: [rightEl] })] })
  }
  // the rows the band has under `head`, less the frame's two borders (Infinity: no limit); a blank row stands first, so
  // the title stands apart from the card, while a row is left for the card under it too. An explainer's or a heads-up's
  // words start with one of their own, as the reply draws them (marks/view.ts messageEl)
  const leftOf = (head: Any) => (room ? room.rows - 2 - treeRows(head, inner) : Infinity)
  const gapUnder = (head: Any) => !words && leftOf(head) >= 2
  // the card in units, in the rows left for it under `head`, one at least: a citation's fit to its rows (fitCitation);
  // other words taller than the rows, from their start, a window of the rows left over the marker under it, which says
  // how many it leaves out (null: other words that fit, whole)
  const layOut = (head: Any): Unit[] | null => {
    const rows = Math.max(1, leftOf(head) - (gapUnder(head) ? 1 : 0))
    if (parts) return fitCitation(parts, rows)
    if (treeRows(body, inner) <= rows) return null
    const keep = Math.max(0, rows - 1)
    return [
      ...(keep ? [{ h: keep, el: Box({ key: 'tray-window', flexDirection: 'column', height: keep, overflow: 'hidden', children: [
        Box({ key: 'tray-window-in', flexDirection: 'column', flexShrink: 0, children: body }),
      ] }) }] : []),
      { h: 1, cut: { n: treeRows(body, inner) - keep, where: 'below' as const } },
    ]
  }
  // its keys (trayKeys), + among them only while the card leaves lines out. The card is laid out under the head without
  // +; when it leaves lines out the head names + too, and when that head takes a row more, the card is laid out again in
  // the rows left, where it leaves lines out still, so the frame keeps to the band's rows. A band too short for that head
  // and a row of the card keeps the head without +
  const keys = await trayKeys($, tray, f)
  let named = keys.filter(k => k.key !== SHOW_ALL.key)
  let head = headOf(named)
  let laid = layOut(head)
  if (laid?.some(u => u.cut)) {
    const taller = headOf(keys)
    const grew = treeRows(taller, inner) > treeRows(head, inner)
    if (!grew || leftOf(taller) >= 1) {
      named = keys
      head = taller
      if (grew) laid = layOut(head)
    }
  }
  const under: Any[] = gapUnder(head) ? [Text({ key: 'tray-gap', children: ' ' })] : []
  // the rows of the frame but the card's: its two borders, its head and the blank row under it
  const fixed = 2 + treeRows([head, ...under], inner)
  // each marker a click that shows all of it in the side pane, as + does
  const marks = (laid ?? []).filter(u => u.cut)
  const shown: Any[] = laid ? unitEls(els, laid.map((u, k) => (u.cut ? cutRow(els, u.cut, `tray-cut-${k}`, () => showAll($, f)) : u))) : body
  if (marks.length) cutNow = { ref: frameKey(f), n: marks.reduce((n, u) => n + u.cut!.n, 0) }
  gapRow = !room || fixed + treeRows(shown, inner) < room.rows
  // the words of its keys and of its markers, which a click on one leaves selected: no answer's words
  // (core/selection.ts)
  controlWords('tray', [...named.flatMap(k => [k.words, `${k.key} ${k.words}`]), ...marks.map(u => cutWords(u.cut!.n, u.cut!.where))])
  const frame = Box({ key: 'tray', flexDirection: 'column', borderStyle: 'round', borderColor: tone, paddingX: 1, width: w, children: [
    head,
    ...under,
    Box({ key: 'tray-body', flexDirection: 'column', children: shown }),
  ] })
  return [Box({ key: 'tray-band', marginLeft: 2, flexDirection: 'column', children: [frame] })]
}

// ------------------------------------------------------------------------------------------------ hooks

/** A /clear or a /resume (hooks/turnover.ts): the tray on the earlier conversation's citations closes. */
export async function turnTray($: Engine): Promise<void> {
  await writeTray($, null)
  await writeStand($, null)
}

export const registerTray: Register = on => {
  // the person's own prompt: the tray closes. What it showed is no part of the prompt; a question about it goes to a
  // side thread (a)
  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    try {
      if (!e.command && !e.isMeta && (await trayNow($))) await writeTray($, null)
    } catch {
      // the tray stays open
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // a click on `x repair` (the card's or the bar's): the repair starts in this hook, so the plugin's other hooks serve
  // its fork (core/forks.ts)
  on('ui.press', { element: /^(repair|bar-tray-x)$/ }, async ($, e, next) => {
    try {
      if (e.plugin !== 'thimble' || !REPAIR_KEYS.has(String(e.element))) return next(e)
      const f = top(await trayNow($)) as Frame | null
      if (!f || !(await repair($, f, { until: 0, cancelled: false }))) return next(e)
      return { element: e.element }
    } catch (err) {
      failNotice($, `The repair did not start: ${reasonOf(err)}. Press x to try again.`, 'tray:repair')
      return { element: e.element }
    }
  }).catch(($, e, next) => next(e))
}

