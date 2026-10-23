// tray.ts: the cite and explain tray, one small panel above the prompt (0.10: shell.tsx openMark, stepMark, stepEnds,
// trayBand, trayFileLink, trayScope, the tray branch of emptyPromptKey; panes/tray.js; shell/cards.js explainerCard).
//
// It shows one mark at a time, the top of a stack (tray.mjs): a citation with its check and its evidence, or an
// explainer (what a term is, where it mattered here) or an important detail (a heads-up). ] and [ at an empty prompt
// step through the answers' citations, explainers, heads-ups and cards (drawn inline at Claude's calls, or under an
// answer by v), in reading order (a heads-up on a citation's words before the citation), and open the tray on the one
// reached; a press on a citation or an explainer opens it too. The marked words draw in focus (the
// answer view asks trayFocus). While it is open its keys are in the bar, after the busy step:
//
//   a ask       a side thread about the mark (threads/seam.ts openThread); 1 too, unnamed
//   c           a citation computed by code: all its code and output in place of the one line, and back
//   h explain   the explainer (or heads-up) on the citation's words, over it
//   e expand    an explainer written again at more length, in its place (explain/seam.ts expandExplainer)
//   2–9         a citation inside an explainer's words, over it (a click on it too), unnamed
//   x repair    on a failed citation: a check of that one claim again in the background, which looks in
//               the records for the right value and corrects the cited words (marks/checker.ts launchRepair), or
//               for one whose check did not run, its check; the
//               citation spins while it runs and shows its new status when it ends; a click on `x repair` in the
//               card or the bar too (this module's ui.press hook, so the fork starts inside a hook)
//   0 close     back to the mark under it, or close
//   m more      a tray taller than the rows above the bar: its next lines, then from the top (the line under it says)
//   ] [         the next mark or card, and the one before
//
// The tray takes only the rows the band has over the bar (bar/register.ts), so the bar stays on screen. A card ] reaches
// takes the keys (cards/store.ts setFocus); `a` asks about it and 0 gives the keys back. A question
// typed with the tray open is about the mark: its scope reaches Claude with the prompt (core/tell.ts), the person's
// prompt shows `▸ about …` under it, and the tray closes. What the person opens reaches main through core/engaged.ts.
//
//   state: tray ({stack} or null), trayCard (the card ] reached: {row, card}), trayAsked (by turn: what its prompt was
//          about)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failNotice, noticeLine } from '../bar/notice'
import type { MarkRef, Span } from '../core/answerview'
import { actingRow, messageOf, partOf, pickAnswer, turnOfRow, turnsNow, type TurnRec } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { startDir } from '../core/env'
import { openPane } from '../core/pane'
import { tellAtNextPrompt } from '../core/tell'
import { revealCard } from '../cards/draw'
import { themeNow } from '../core/theme'
import { anchoredAt, metaOf, setFocus } from '../cards/store'
import { explainSpans, expandExplainer, type ExplainPart, type Gloss } from '../explain/seam'
import { launchRepair, repairOf } from '../marks/checker'
import { highlighted, wrapCode } from '../marks/evidence'
import { tableLines } from '../marks/table.mjs'
import { marksIn, plainSentence, withoutMarks, withRewrites } from '../marks/message.js'
import { looksByWords } from '../marks/register'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageEl, wordsLook, type MarkStatus } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { squeezeBar, squeezeHidesCard, squeezeView } from '../squeeze/seam'
import { openThread, threadAsked } from '../threads/seam'
import {
  aboutOf, back, base, canRepair, cutTitle, drawsHyperlinks, evidenceLine, explainerText, fileHref, firstSentence, hiddenOutput, indexOf, lineWindow,
  moreLines, open, pageOf, printLine, push, refOf, rowsOf, sameRef, scopeText, stepFrom, stepWords, stopWhat, stopsOfRow, stopsOfTurn, top,
} from './tray.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Frame = MarkRef & { open?: 'code' | null; page?: number }
export type Tray = { stack: Frame[] } | null
type Stop = { row: string; kind?: 'citation' | 'explain' | 'heads'; n?: number; id?: string; at?: number; card?: string }
type Stand = { row: string; card: string } | null

const TRAY = { plugin: 'thimble', key: 'tray' } as const
const STAND = { plugin: 'thimble', key: 'trayCard' } as const
const ASKED = { plugin: 'thimble', key: 'trayAsked' } as const

/** The colors of the tray's frame by what it shows, the ones its words are drawn in (explain/place.mjs markColors): a
 *  citation's purple, an explainer's teal and a heads-up's orange, theme keys that follow the person's theme. */
const TONES = { citation: 'merged', explain: 'planMode', heads: 'claude' } as const

// the question the person typed with the tray open, until main's turn for it starts (then kept by its turn)
let pendingAbout: string | null = null
// the tray as last drawn, when its body was taller than the room above the bar: the frame and where m goes next
let paged: { f: Frame; next: number | null } | null = null

const quietly = (p: Promise<unknown> | unknown) => Promise.resolve(p).catch(() => undefined)

// ------------------------------------------------------------------------------------------------ state

export async function trayNow($: Engine): Promise<Tray> {
  const t = (await $.state.get(TRAY)).value as Tray | undefined
  return t && Array.isArray(t.stack) && t.stack.length ? t : null
}

async function standNow($: Engine): Promise<Stand> {
  return ((await $.state.get(STAND)).value ?? null) as Stand
}

/** The tray as it stands now: what a question asked with it open carries for Claude follows its top (core/tell.ts),
 *  and nothing once it closed. */
async function setTray($: Engine, tray: Tray): Promise<void> {
  const next = tray && tray.stack.length ? tray : null
  await $.state.set(TRAY, next as never)
  if (next) await $.state.set(STAND, null as never)
  const f = top(next) as Frame | null
  await tellAtNextPrompt($, 'tray', f ? scopeText(f, await infoOf($, f)) : '')
}

export async function closeTray($: Engine): Promise<void> {
  await setTray($, null)
}

// ------------------------------------------------------------------------------------------------ marks of a row

/** The text a row shows now (a squeezed version in its place), and its citations; null when it draws nothing. */
async function shownOf($: Engine, row: string): Promise<{ text: string; marks: { start: number; end: number; words: string }[]; own: boolean } | null> {
  const raw = (await messageOf($, row))?.text ?? ''
  if (!raw) return null
  let v: Any = null
  try { v = await squeezeView($, row, raw) } catch { v = null }
  if (v?.hidden) return null
  const shown = typeof v?.text === 'string' ? v.text : raw
  const marksOn = featureOn('marks')
  const text = marksOn ? shown : withoutMarks(shown)
  const own = text === raw
  // Claude's own words, with each sentence a check rewrote in place of the one Claude wrote (marks/register.ts)
  const drawn = own && marksOn ? withRewrites(text, (await rowMarks($, row))?.items ?? []) : text
  return { text: drawn, marks: marksOn ? marksIn(drawn) : [], own }
}

/** The row's citations as it shows them: each with its number in the reply (0: one the check does not know). */
async function citesOf($: Engine, row: string, shown: { text: string; marks: { start: number; end: number; words: string }[]; own: boolean }): Promise<{ n: number; start: number; end: number; words: string }[]> {
  const items = (await rowMarks($, row))?.items ?? []
  const looks = shown.own ? shown.marks.map((_m, k) => ({ n: items[k]?.n ?? 0 })) : looksByWords(shown.marks, items, false)
  return shown.marks.map((m, k) => ({ ...m, n: looks[k]?.n ?? 0 }))
}

/** The explainers and heads-ups on the row's words (explain/seam.ts), each with its kind. */
async function spansOf($: Engine, row: string, shown: { text: string; marks: { start: number; end: number; words: string }[] }): Promise<(Span & { kind: 'explain' | 'heads' })[]> {
  let spans: Span[] = []
  try { spans = (await explainSpans($, row, shown.text, shown.marks)) ?? [] } catch { spans = [] }
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

/** Where ] and [ stand now: the tray's first mark, else the card ] reached (-1: neither). */
async function stepPlace($: Engine): Promise<{ list: Stop[]; at: number }> {
  const list = await allStops($)
  const b = base(await trayNow($)) as Frame | null
  const stand = b ? null : await standNow($)
  return { list, at: indexOf(list, b ?? stand) }
}

/** Whether ] and [ go anywhere from where they stand, and what each goes to. */
export async function stepEnds($: Engine): Promise<{ next: boolean; prev: boolean; nextWhat?: string; prevWhat?: string }> {
  const { list, at } = await stepPlace($)
  if (at < 0) return { next: true, prev: true }
  const next = stepFrom(list, at, 1)
  const prev = stepFrom(list, at, -1)
  return { next: !!next, prev: !!prev, ...(next ? { nextWhat: stopWhat(next) } : {}), ...(prev ? { prevWhat: stopWhat(prev) } : {}) }
}

// ------------------------------------------------------------------------------------------------ what a mark is

type Info = { begins: string; words?: string; status?: string; failedBy?: string; evidence?: MarkItem['evidence']; item?: MarkItem; gloss?: Gloss }

async function itemOf($: Engine, row: string, n: number): Promise<MarkItem | null> {
  return (await rowMarks($, row))?.items.find(x => x.n === n) ?? null
}

async function glossOf($: Engine, row: string, id: string): Promise<Gloss | null> {
  return (await partOf<ExplainPart>($, row, 'explain'))?.items?.[id] ?? null
}

/** What the tray, the scope and the side thread read of a frame. */
async function infoOf($: Engine, f: Frame): Promise<Info> {
  const begins = (await shownOf($, f.row))?.text ?? (await messageOf($, f.row))?.text ?? ''
  if (f.kind === 'citation') {
    const item = await itemOf($, f.row, f.n)
    return { begins: withoutMarks(begins), words: item?.shown ?? item?.words ?? '', status: item?.status, failedBy: item?.failedBy, evidence: item?.evidence, ...(item ? { item } : {}) }
  }
  return { begins: withoutMarks(begins), gloss: (await glossOf($, f.row, f.id)) ?? undefined }
}

/** The mark as core/engaged.ts tells it. */
function engagedMark(f: Frame, info: Info): Any {
  if (f.kind === 'citation') return { kind: 'citation', row: f.row, n: f.n, words: info.words ?? '', status: info.status, failedBy: info.failedBy }
  const g = info.gloss
  return f.kind === 'heads' ? { kind: 'heads', row: f.row, term: g?.term ?? '', title: g?.title ?? '' } : { kind: 'explain', row: f.row, term: g?.term ?? '' }
}

/** The person opened a mark: main hears it with their next prompt. */
async function told($: Engine, f: Frame): Promise<void> {
  const info = await infoOf($, f)
  await tellOpened($, engagedMark(f, info), info.begins).catch(() => undefined)
}

/** The explainer or heads-up on a citation's words, if any: a press on those words opens the citation, so its tray
 *  offers the explainer (h). */
async function innerOf($: Engine, f: Frame): Promise<Frame | null> {
  if (f.kind !== 'citation') return null
  const shown = await shownOf($, f.row)
  if (!shown) return null
  const c = (await citesOf($, f.row, shown)).find(x => x.n === f.n)
  if (!c) return null
  const s = (await spansOf($, f.row, shown)).find(x => x.start >= c.start + 1 && x.end <= c.start + 1 + c.words.length)
  return s ? { row: f.row, kind: s.kind, id: s.id } : null
}

/** The citations inside an explainer's words, each the reply's citation with the same words (marks/register.ts
 *  looksByWords): the frames they open, by their order in the words (0: none). */
async function linksOf($: Engine, f: Frame, text: string): Promise<{ marks: { start: number; end: number; words: string }[]; looks: Any[] }> {
  const marks = marksIn(text)
  const items = (await rowMarks($, f.row))?.items ?? []
  return { marks, looks: looksByWords(marks, items, false) }
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
  await setTray($, open(f) as Tray)
  const t = await turnOfRow($, f.row)
  if (t?.answer) await pickAnswer($, t.answer)
  await told($, f)
  if (o.reveal) await reveal($, f)
}

/** A mark over the one the tray shows (a citation inside an explainer, the explainer on a citation's words). */
async function pushMark($: Engine, f: Frame): Promise<void> {
  await setTray($, push(await trayNow($), f) as Tray)
  await told($, f)
}

/** 0: the code back to the output, then the mark under this one, then closed. */
async function goBack($: Engine): Promise<void> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return
  if (f.open) { await setTray($, { stack: [...tray.stack.slice(0, -1), { ...f, open: null }] }); return }
  await setTray($, back(tray) as Tray)
}

/** c on a citation computed by code: its whole code and output in place of the one line of evidence, and back. */
async function toggleCode($: Engine): Promise<void> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return
  await $.state.set(TRAY, { stack: [...tray.stack.slice(0, -1), { ...f, open: f.open === 'code' ? null : 'code', page: 0 }] } as never)
}

/** m on a tray taller than the room above the bar: its next rows, and from the top again after the last. */
async function setPage($: Engine, page: number): Promise<void> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return
  await $.state.set(TRAY, { stack: [...tray.stack.slice(0, -1), { ...f, page }] } as never)
}

/** A card ] reached takes the keys, its own first, and shows framed in focus. */
async function standOn($: Engine, row: string, card: string): Promise<void> {
  await setTray($, null)
  await setFocus($, card)
  await $.state.set(STAND, { row, card } as never)
  const t = await turnOfRow($, row)
  if (t?.answer) await pickAnswer($, t.answer)
  await reveal($, { row, card })
}

/** ] and [: the next mark or card in reading order, and the one before. From rest, the answer the keys act on: ] its
 *  first, [ its last (else the newest answer's). At the newest reply's last stop, ] stays. */
export async function stepMark($: Engine, dir: number): Promise<void> {
  const { list, at } = await stepPlace($)
  let next: Stop | null = null
  if (at >= 0) { next = stepFrom(list, at, dir) as Stop | null; if (!next) return }
  else {
    const row = await actingRow($)
    const turn = row ? await turnOfRow($, row) : null
    const here = list.filter(p => (turn ? turn.rows.includes(p.row) : p.row === row))
    const pool = here.length ? here : list.filter(p => p.row === list[list.length - 1]?.row)
    next = (dir > 0 ? pool[0] : pool[pool.length - 1]) ?? null
  }
  if (!next) { noticeLine($, 'Nothing to step to yet.', 'tray'); return }
  if (next.card) await standOn($, next.row, next.card)
  else await openMark($, refOf(next) as Frame, { reveal: true })
}

/** a: a side thread about the mark the tray shows; the tray gives way to it when it opened. */
async function askAbout($: Engine, f: Frame): Promise<void> {
  const info = await infoOf($, f)
  const placed = await openThread($, { about: aboutOf(f, info), mark: refOf(f) as MarkRef })
  if (placed) await setTray($, null)
}

/** a on the card ] reached: a side thread about it. */
async function askCard($: Engine, stand: NonNullable<Stand>): Promise<void> {
  const meta = await metaOf($, stand.card)
  await openThread($, { about: `the card "${meta?.title ?? stand.card}"`, card: stand.card })
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

/** e on an explainer: written again at more length, in its place; the tray shows the longer one when it lands. */
async function expand($: Engine, f: Frame): Promise<void> {
  const why = await expandExplainer($, refOf(f) as MarkRef)
  if (typeof why === 'string' && why) failNotice($, `The longer explainer was not written: ${why}. Press e in the tray to try again.`, 'tray:expand')
}

// ------------------------------------------------------------------------------------------------ the keys

/** Whether the squeeze chips hold the keys now (their items show as the bar's focus): [ and ] are theirs then. */
async function chipsOpen($: Engine): Promise<boolean> {
  try { return ((await squeezeBar($, featureOn, false)) ?? []).some(x => x?.focus) } catch { return false }
}

/** The tray's keys at an empty prompt (hooks/keys.ts takes them as a Take): ] and [ always (but while the squeeze chips
 *  are open at rest), its own while it is open, a's and 0 on a card ] reached. */
export async function trayKey($: Engine, key: string, until = 0): Promise<Any | null> {
  const tray = await trayNow($)
  const stand = tray ? null : await standNow($)
  if (key === ']' || key === '[') {
    if (!tray && !stand && (await chipsOpen($))) return null
    return { now: () => stepMark($, key === ']' ? 1 : -1) }
  }
  if (stand) {
    if (key === 'a') return { later: () => askCard($, stand) }
    if (key === '0') return { now: () => $.state.set(STAND, null as never) }
    return null
  }
  const f = top(tray) as Frame | null
  if (!f) return null
  if (key === '0') return { now: () => goBack($) }
  if (key === 'm' && paged && sameRef(paged.f, f) && (paged.f.open ?? null) === (f.open ?? null) && paged.next !== null) {
    const was = f.page ?? 0
    const to = paged.next
    return { now: () => setPage($, to), undo: () => setPage($, was) }
  }
  if (key === 'a') return { later: () => askAbout($, f) }
  if (key === '1') return { now: () => askAbout($, f) }
  if (f.kind === 'citation') {
    const ev = (await itemOf($, f.row, f.n))?.evidence
    if (key === 'c' && ev?.kind === 'computed') return { now: () => toggleCode($), undo: () => toggleCode($) }
    if (key === 'x' && canRepair(await itemOf($, f.row, f.n))) {
      const r = await repairOf($, f.row, f.n)
      if (r === null) return null
      if (typeof r === 'string') return { later: async () => failNotice($, r, 'tray:repair') }
      // the spawn is made while this key's hook runs (launchRepair's first call), and waits out the word window
      // (marks/register.ts); a word refuses it
      const hold = { until, cancelled: false }
      const failed = (err: unknown) => failNotice($, `The repair did not start: ${String((err as Error)?.message || err).slice(0, 160)}. Press x to try again.`, 'tray:repair')
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
  const g = await glossOf($, f.row, f.id)
  if (key === 'e' && f.kind === 'explain' && g && !g.expanded) return { later: () => expand($, f) }
  if (/^[2-9]$/.test(key) && g) {
    const { looks } = await linksOf($, f, explainerText(g))
    const links = looks.filter((l: Any) => l.n > 0).slice(0, 8)
    const l = links[Number(key) - 2]
    if (l) return { now: () => pushMark($, { row: f.row, kind: 'citation', n: l.n }) }
  }
  return null
}

// ------------------------------------------------------------------------------------------------ the bar

/** The tray's items at the bar's left: while it is open (or a card ] reached holds the keys), its keys, as `focus`
 *  items, so the bar names only those; at rest none. */
export async function trayBar($: Engine, _on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (preview) return []
  const tray = await trayNow($)
  const stand = tray ? null : await standNow($)
  const steps = (): Promise<BarItem[]> => stepEnds($).then(ends => stepWords(ends).map((s: Any) => ({ id: `tray-${s.key}`, key: s.key, words: s.words, focus: true, press: () => stepMark($, s.key === ']' ? 1 : -1) })))
  if (stand) {
    return [
      { id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askCard($, stand) },
      ...(await steps()),
      { id: 'tray-0', key: '0', words: 'back', focus: true, press: () => $.state.set(STAND, null as never) },
    ]
  }
  const f = top(tray) as Frame | null
  if (!tray || !f) return []
  const out: BarItem[] = []
  const zero: BarItem = { id: 'tray-0', key: '0', words: f.open || tray.stack.length > 1 ? 'back' : 'close', focus: true, press: () => goBack($) }
  if (f.kind === 'citation') {
    const m = await itemOf($, f.row, f.n)
    out.push({ id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askAbout($, f) })
    // a click is the ui.press hook's (registerTray), which starts the repair inside a hook
    if (canRepair(m)) out.push({ id: 'tray-x', key: 'x', words: 'repair', focus: true, press: () => undefined })
    if (m?.evidence?.kind === 'computed') out.push({ id: 'tray-c', key: 'c', words: f.open === 'code' ? 'one line' : 'all code and output', focus: true, press: () => toggleCode($) })
    out.push(zero, ...(await steps()))
    const inner = await innerOf($, f)
    if (inner) {
      const g = inner.kind !== 'citation' ? await glossOf($, inner.row, inner.id) : null
      const term = String(g?.term ?? '')
      out.push({ id: 'tray-h', key: 'h', words: inner.kind === 'heads' ? 'heads up' : `explain ${term.length > 24 ? `${term.slice(0, 23)}…` : term}`, focus: true, press: () => pushMark($, inner) })
    }
    return out
  }
  const g = await glossOf($, f.row, f.id)
  if (f.kind === 'explain' && g && !g.expanded) out.push({ id: 'tray-e', key: 'e', words: 'expand', focus: true, press: () => expand($, f) })
  out.push({ id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askAbout($, f) }, zero, ...(await steps()))
  return out
}

// ------------------------------------------------------------------------------------------------ the answer view

/** What the tray shows on this row, so the row draws it in focus. */
export async function trayFocus($: Engine, row: string): Promise<MarkRef | null> {
  const f = top(await trayNow($)) as Frame | null
  return f && f.row === row ? (refOf(f) as MarkRef) : null
}

/** A press on a citation opens the tray on it, as in 0.10 (its whole evidence is a click on its place there). */
export async function markPressed($: Engine, row: string, n: number): Promise<boolean> {
  if (!(n > 0)) return false
  const f: Frame = { row, kind: 'citation', n }
  if (sameRef(top(await trayNow($)), f)) return true
  await openMark($, f)
  return true
}

/** The tray on an explainer or a heads-up (a press on its words, explain/seam.ts). */
export async function openTray($: Engine, mark: MarkRef): Promise<boolean> {
  if (!mark || !mark.row) return false
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

/** A citation's status as its header says it, beside the kind: a sign, the word and its color. */
const STATUS: Record<string, { word: string; color?: string; dim?: boolean }> = {
  checking: { word: 'checking', dim: true },
  verified: { word: '✓ verified', color: 'success' },
  corrected: { word: '✓ verified', color: 'success' },
  failed: { word: '× failed', color: 'error' },
}

/** A citation's status: the store's, and failed for one with no check (marks/store.ts notRun; one the store no longer
 *  holds, whose reply the reply draws failed too, says so under it). */
const statusOf = (m: MarkItem | null) => (m ? STATUS[m.status] : null) ?? STATUS.failed!

/** The color of a line of code: the theme key thimble draws inline code in (marks/view.ts), a blue Claude Code shades
 *  for the theme it draws in. */
const CODE_INK = 'permission'

/** A part of the tray's body and the rows it takes: an element, or a line of code (the code's lines draw as one Code). */
type Unit = { h: number; el?: Any; code?: string }

/** A line of evidence in the ruled block under the code or the file's place: a dim rule on the left, so code and
 *  output read apart, and the line, the cited words bold in the citations' look (marks/evidence.tsx citeWords). */
function ruled(els: Any, text: string, spans: [number, number][], w: number, key: string): Unit {
  const { Box, Text } = els
  const h = rowsOf(text, w - 2)
  return { h, el: Box({ key, flexDirection: 'row', children: [
    Text({ key: 'rule', dimColor: true, children: Array(h).fill('│').join('\n') }),
    Box({ key: 'l', flexShrink: 1, marginLeft: 1, children: [highlighted(els, text, spans, 't')] }),
  ] }) }
}

/** A citation's card under its header (the status is in the header). A corrected one says what it was; a failed one
 *  why in one sentence; after a repair (x), what it did; all dim, and under it
 *  `x repair`, a press that checks it again (the ui.press hook, as x does). Then its evidence. For a value code computed: the
 *  one line of the code that printed the cited value, in code color, then the output line that holds it in the ruled
 *  block, ended by a dim count of the output lines it leaves out; with c, all the code (as code), then all the output
 *  in the ruled block. For a file: its place (`place`, a click opens the side pane), then the cited line in the ruled
 *  block. For a card's value: the card's title, then the header over the cited row in the ruled block; printed output
 *  that is a table shows so too. The cited words bold in the citations' look. */
function citationBody(els: Any, f: Frame, m: MarkItem | null, w: number, place: Any | null): Unit[] {
  const { Text } = els
  if (!m) return [{ h: 1, el: Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: 'This citation is no longer in the session.' }) }]
  const ev = m.evidence
  const rows: Unit[] = []
  const dim = (key: string, text: string) => rows.push({ h: rowsOf(text, w), el: Text({ key, dimColor: true, wrap: 'wrap', children: text }) })
  const fixed = m.rewrite ? (m.repair ? 'repaired by rewriting the sentence; ' : 'sentence rewritten; ') : m.narrowed ? (m.repair ? 'repaired by narrowing; ' : 'narrowed; ') : m.repair ? 'repaired; ' : 'corrected; '
  const notFixed = m.repair ? 'not repaired: ' : ''
  // a rewrite's history is the sentence Claude wrote
  if (m.status === 'corrected' && m.was) dim('was', `${fixed}was ${(m.rewrite ? plainSentence(m.sentence) : m.was).replace(/\*\*|`/g, '')}`)
  else if (m.status === 'failed' && m.reason) dim('why', `${notFixed}${firstSentence(m.reason)}`)
  else if (m.status === 'checking') dim('why', m.repair ? 'The repair is running: the check reads the records again.' : 'The check is running.')
  else if (m.repair && m.status === 'verified') dim('why', `verified as written${m.reason ? `: ${firstSentence(m.reason)}` : ''}`)
  // a check that did not run: x starts it
  const unrun = m.status === 'failed' && m.failedBy === 'none'
  if (canRepair(m)) rows.push({ h: 1, el: els.Button({ key: 'repair', plain: true, label: unrun ? 'check this citation' : 'repair this citation', hover: { bold: true }, onPress: () => undefined, children: [
    Text({ key: 'k', wrap: 'truncate-end', children: [Text({ key: 'x', bold: true, color: 'suggestion', children: 'x' }), Text({ key: 'w', children: ' repair' }), Text({ key: 'd', dimColor: true, children: unrun ? ': start its check' : ': check it again and correct the cited words' })] }),
  ] }) })
  if (!ev) {
    if (m.status !== 'checking' && !unrun) dim('none', 'The check gave no evidence for it.')
    return rows
  }
  if (m.status === 'checking') return rows
  if (ev.kind === 'computed' && f.open === 'code') {
    for (const line of wrapCode(ev.code, w).split('\n')) rows.push({ h: 1, code: line })
    const spans = (ev.highlight ?? []) as [number, number][]
    let at = 0
    String(ev.output ?? '').split('\n').forEach((line, i) => {
      const s0 = at
      at += line.length + 1
      const mine = spans.map(([a, b]) => [Math.max(a, s0) - s0, Math.min(b, s0 + line.length) - s0] as [number, number]).filter(([a, b]) => b > a)
      rows.push(ruled(els, line, mine, w, `o${i}`))
    })
    return rows
  }
  const table = ev.kind === 'card' || ev.kind === 'computed' ? ev.table : undefined
  const tl = table ? tableLines(table, w - 2) : null
  if (ev.kind === 'card') rows.push({ h: 1, el: Text({ key: 'card', wrap: 'truncate-end', children: [Text({ key: 'k', dimColor: true, children: 'card ' }), Text({ key: 't', bold: true, children: ev.title || ev.card })] }) })
  if (ev.kind === 'card' && tl) {
    rows.push(ruled(els, tl[0]!.text, [], w, 'th'), ruled(els, tl[1]!.text, tl[1]!.spans as [number, number][], w, 'tr'))
    return rows
  }
  const line = evidenceLine(ev)
  if (!line) return rows
  if (ev.kind === 'computed' && tl) {
    const said = printLine(ev.code, line.text)
    if (said) rows.push({ h: 1, el: Text({ key: 'said', color: CODE_INK, wrap: 'truncate-end', children: said }) })
    rows.push(ruled(els, tl[0]!.text, [], w, 'th'), ruled(els, tl[1]!.text, tl[1]!.spans as [number, number][], w, 'tr'))
    return rows
  }
  if (ev.kind === 'computed') {
    const said = printLine(ev.code, line.text)
    if (said) rows.push({ h: 1, el: Text({ key: 'said', color: CODE_INK, wrap: 'truncate-end', children: said }) })
  } else if (place) rows.push({ h: 1, el: place })
  const cut = lineWindow(line, w - 2)
  rows.push(ruled(els, cut.text, cut.spans, w, 'ev'))
  // the output lines the one line leaves out, counted at the end of the ruled block (c shows them)
  const more = hiddenOutput(ev)
  if (more) rows.push({ h: 1, el: els.Box({ key: 'more', flexDirection: 'row', children: [
    Text({ key: 'rule', dimColor: true, children: '│' }),
    els.Box({ key: 'l', flexShrink: 1, marginLeft: 1, children: [Text({ key: 'n', dimColor: true, wrap: 'truncate-end', children: moreLines(more) })] }),
  ] }) })
  return rows
}

/** Units start..end-1 as elements: consecutive lines of code as one Code. */
function drawUnits(els: Any, units: Unit[]): Any[] {
  const out: Any[] = []
  let code: string[] = []
  const flush = () => {
    if (!code.length) return
    const source = code.join('\n')
    out.push(els.Code ? els.Code({ key: `code${out.length}`, source, language: 'python' }) : els.Text({ key: `code${out.length}`, color: 'permission', children: source }))
    code = []
  }
  for (const u of units) {
    if (u.code !== undefined) { code.push(u.code); continue }
    flush()
    out.push(u.el)
  }
  flush()
  return out
}

/** In a citation of a file's lines, the file's place (`runs.jsonl:41`), dim: a click opens the citation's whole
 *  evidence in the side pane, which works over ssh too. Where Claude Code draws OSC 8 hyperlinks it is also a link to the file,
 *  which a ctrl or cmd click opens on this machine. */
async function fileLinkEl($: Engine, els: Any, f: Frame, m: MarkItem | null): Promise<Any | null> {
  const ev = m?.evidence
  if (!ev || ev.kind === 'computed' || ev.kind === 'card' || f.kind !== 'citation') return null
  const label = `${ev.file}:${evidenceLine(ev)?.n ?? ev.line}`
  const openIt = () => {
    void openPane($, 'evidence', { row: f.row, n: f.n }, `citation ${f.n}`).then(placed => {
      if (!placed) noticeLine($, 'Claude Code did not open the side pane here. Click the citation in the reply to see its evidence.', 'tray')
    }, () => undefined)
  }
  if (els.Markdown && (await hyperlinksHere($))) {
    const start = await startDir($)
    const abs = ev.file.startsWith('/') ? ev.file : `${start.replace(/\/+$/, '')}/${ev.file}`
    const href = fileHref(abs, String(evidenceLine(ev)?.n ?? ev.line))
    return els.Markdown({ key: 'tray-file', text: `[${label.replace(/[[\]\\]/g, c => '\\' + c)}](${href})`, onLinkPress: openIt, pressableLinks: [href] })
  }
  return els.Button({ key: 'tray-file', plain: true, label: `open ${label}`, onPress: openIt, children: [els.Text({ dimColor: true, children: label })] })
}

/** The tray, drawn above the bar while it is open: one frame, its title and its kind (cite, explain, heads up) on top
 *  (a citation's status beside its kind),
 *  the mark's card under them, its rows starting where the title starts. `room`: the rows it may take, so the bar
 *  under it stays on screen (0: no limit); a body taller than that shows the rows that fit, and m shows the next. */
export async function trayBand($: Engine, els: Any, width: number, room = 0): Promise<Any[]> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) { paged = null; return [] }
  const { Box, Text } = els
  const w = Math.max(40, Math.min(104, width - 3))
  const inner = w - 4
  let title = ''
  let units: Unit[] = []
  let words: { text: string; start: number; end: number } | null = null
  let status: ReturnType<typeof statusOf> | null = null
  let citeStatus: MarkStatus | null = null
  if (f.kind === 'citation') {
    const m = await itemOf($, f.row, f.n)
    citeStatus = m?.status ?? null
    await themeNow($)
    title = (m?.shown ?? m?.words ?? `citation ${f.n}`).replace(/\*\*|`/g, '')
    status = statusOf(m)
    units = citationBody(els, f, m, inner, await fileLinkEl($, els, f, m))
  } else {
    const g = await glossOf($, f.row, f.id)
    const heads = f.kind === 'heads'
    title = String(g?.term || g?.title || (heads ? 'heads up' : 'explain'))
    if (!g) units = [{ h: 1, el: Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: `This ${heads ? 'heads-up' : 'explainer'} is no longer in the session.` }) }]
    else {
      // each line of its words is a unit, drawn together as one message
      const lines = explainerText(g).split('\n')
      units = lines.map(l => ({ h: /^- /.test(l) ? rowsOf(l.slice(2), inner - 2) : rowsOf(l, inner) }))
      words = { text: lines.join('\n'), start: 0, end: lines.length }
    }
  }
  // the thread about this mark, once a question was asked in it: a opens it
  const asked = f.open === 'code' ? null : await threadAsked($, { about: '', mark: refOf(f) as MarkRef })
  if (asked) units.push({ h: 1, el: Text({ key: 'thread', wrap: 'truncate-end', children: [
    Text({ key: 'a', dimColor: true, children: '↳ thread: ' }),
    Text({ key: 'q', children: asked.length > 60 ? asked.slice(0, 59) + '…' : asked }),
    Text({ key: 'b', dimColor: true, children: ' · a opens it' }),
  ] }) })
  // what fits above the bar: the frame's two borders and title take three rows, and an explainer's or heads-up's words
  // one more, the blank row messageEl draws above them (marks/view.ts)
  const gap = words && words.text.trim() ? 1 : 0
  const fit = room > 0 ? Math.max(3, room - 3 - gap) : 0
  const page = pageOf(units.map(u => u.h), fit, f.page ?? 0)
  paged = page.next === null ? null : { f, next: page.next }
  const shown = units.slice(page.start, page.end)
  let body: Any[]
  if (words) {
    const lines = words.text.split('\n')
    const text = lines.slice(page.start, Math.min(page.end, lines.length)).join('\n')
    const { marks, looks } = await linksOf($, f, text)
    const id = (f as { id: string }).id
    body = [
      ...(text.trim() ? [messageEl(els, {
        text, marks, looks, key: `tray-${f.row}-${id}`, cols: inner, first: false, spin: '', gutter: false,
        onMark: (k: number) => { const n = looks[k]?.n; if (n > 0) void pushMark($, { row: f.row, kind: 'citation', n }) },
      })] : []),
      ...drawUnits(els, shown.slice(Math.max(0, lines.length - page.start))),
    ]
  } else body = drawUnits(els, shown)
  if (page.next !== null) {
    const n = units.length
    body = [
      Box({ key: 'tray-page', flexDirection: 'column', height: Math.max(1, fit - 1) + gap, overflow: 'hidden', children: body }),
      Text({ key: 'tray-more', dimColor: true, wrap: 'truncate-end', children: `${page.next === 0 ? 'm from the top' : 'm more'} · lines ${page.start + 1}–${page.end} of ${n}` }),
    ]
  }
  // the right of the title says what kind of mark it is, and a citation's status before it
  const kind = f.kind === 'citation' ? 'cite' : f.kind === 'heads' ? 'heads up' : 'explain'
  const right = status ? `${status.word} · ${kind}` : kind
  const avail = inner - 2
  const roomT = title.length + right.length + 3 <= avail ? title.length : Math.max(8, avail - Math.min(right.length, Math.floor(avail / 2)) - 3)
  const tone = TONES[f.kind]
  // a citation's title is its words, drawn as the reply draws them (marks/view.ts wordsLook: tinted on hover); the frame
  // keeps its tone
  const titleLook = f.kind === 'citation' ? wordsLook(citeStatus ?? 'failed', `tray:${f.row}:${f.n}`) : { color: tone }
  const head = Box({ key: 'tray-head', flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ key: 't', bold: true, ...titleLook, wrap: 'truncate-end', children: cutTitle(title, roomT) }),
    status
      ? Text({ key: 'r', children: [Text({ key: 's', ...(status.color ? { color: status.color } : { dimColor: true }), children: status.word }), Text({ key: 'k', dimColor: true, children: ` · ${kind}` })] })
      : Text({ key: 'r', dimColor: true, children: right }),
  ] })
  const frame = Box({ key: 'tray', flexDirection: 'column', borderStyle: 'round', borderColor: tone, paddingX: 1, width: w, children: [head, Box({ key: 'tray-body', flexDirection: 'column', children: body })] })
  return [Box({ key: 'tray-band', marginLeft: 2, flexDirection: 'column', children: [frame] })]
}

// ------------------------------------------------------------------------------------------------ hooks

/** A /clear or a /resume (hooks/turnover.ts): the tray on the earlier conversation's citations closes. */
export async function turnTray($: Engine): Promise<void> {
  await $.state.set(TRAY, null as never)
  await $.state.set(STAND, null as never)
}

export const registerTray: Register = on => {
  // a question the person typed with the tray open is about its mark: its scope is already waiting for this prompt
  // (core/tell.ts sends it), so the tray closes without taking it back, and the prompt shows what it was about
  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    try {
      if (!e.command && !e.isMeta) {
        const f = top(await trayNow($)) as Frame | null
        if (f) {
          pendingAbout = aboutOf(f, await infoOf($, f))
          await $.state.set(TRAY, null as never)
        } else pendingAbout = null
      }
    } catch {
      // the prompt goes in as typed
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // main's turn for that prompt: what it was about, kept by the turn, so its prompt row shows it
  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined && pendingAbout) {
      const about = pendingAbout
      pendingAbout = null
      try { await $.state.set({ ...ASKED, id: e.turnId } as never, about as never) } catch { /* the prompt shows as typed */ }
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
      failNotice($, `The repair did not start: ${String((err as Error)?.message || err).slice(0, 160)}. Press x to try again.`, 'tray:repair')
      return { element: e.element }
    }
  }).catch(($, e, next) => next(e))

  // a prompt asked with the tray open: under it, `▸ about the citation "…"`
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    try {
      const row = String((e as Any).requestId ?? '')
      if (!row) return next(e)
      const turn = (await turnsNow($)).find(t => t.prompt.row === row)
      const about = turn ? ((await $.state.get({ ...ASKED, id: turn.turnId } as never)).value as string | undefined) : undefined
      if (!about) return next(e)
      const { Box, Text } = $.ui.resolve(e) as Any
      const own = await next(e)
      return Box({ flexDirection: 'column', children: [own, Text({ key: 'tray-about', dimColor: true, wrap: 'truncate-end', children: `  ▸ about ${about}` })] })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetTray(): void {
  pendingAbout = null
  paged = null
}
