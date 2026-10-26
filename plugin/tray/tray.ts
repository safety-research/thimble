// tray.ts: the cite and explain tray, one small panel above the prompt (0.10: shell.tsx openMark, stepMark, stepEnds,
// trayBand, trayFileLink, trayScope, the tray branch of emptyPromptKey; panes/tray.js; shell/cards.js explainerCard).
//
// It shows one mark at a time, the top of a stack (tray.mjs): a citation with its check and its evidence, or an
// explainer (what a term is, where it mattered here) or an important detail (a heads-up). ] and [ at an empty prompt
// step through the answers' citations, explainers, heads-ups and cards (drawn inline at Claude's calls, or under an
// answer by v), in reading order (a heads-up on a citation's words before the citation), and open the tray on the one
// reached; a press on a citation or an explainer opens it too. The marked words draw in focus (the
// answer view asks trayFocus). While it is open its keys are in its header, at the right, each where it acts (the bar
// keeps its own):
//
//   a ask       a side thread about the mark (threads/seam.ts openThread); 1 too, unnamed. With a thread about it
//               already, a opens that thread
//   + −         a citation computed by code: all its code and output in place of the one line (+ expand all), and
//               the one line again (- collapse)
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
//   ] [         the next mark or card, and the one before
//
// Each key's words in the tray are a click too: the header's keys, `x repair` in the card, `+ expand all` (and `− collapse`)
// under the evidence is + (and -); a click on the citation's words, in the tray's title as in the
// reply, closes it, as a second click on the open mark in the reply does.
//
// The tray shows all of its body. When it is taller than the rows Claude Code gives the band above the prompt, the band
// scrolls (the wheel over it, Claude Code's own `n more` row). A card ] reaches takes the keys (cards/store.ts
// setFocus); `a` asks about it and 0 gives the keys back. An open tray does not change what the next prompt asks: a
// question about the mark goes to a side thread (a). The tray closes when the person sends a prompt. What the person
// opens reaches main through core/engaged.ts.
//
//   state: tray ({stack} or null), trayCard (the card ] reached: {row, card})
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failNotice, noticeLine } from '../bar/notice'
import type { MarkRef, Span } from '../core/answerview'
import { actingRow, messageOf, partOf, pickAnswer, turnOfRow, turnsNow, type TurnRec } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { startDir } from '../core/env'
import { openPane } from '../core/pane'
import { revealCard } from '../cards/draw'
import { quiet } from '../core/askcell.js'
import { accent, themeLast, themeNow } from '../core/theme'
import { markColors } from '../explain/place.mjs'
import { anchoredAt, metaOf, setFocus } from '../cards/store'
import { explainSpans, type ExplainPart, type Gloss } from '../explain/seam'
import { placeLines } from '../explain/expand'
import { citeLinks } from '../explain/place.mjs'
import { checkOpened, launchRepair, repairOf } from '../marks/checker'
import { highlighted, wrapCode } from '../marks/evidence'
import { tableLines } from '../marks/table.mjs'
import { marksIn, plainSentence, withAsked, withoutMarks, withRewrites } from '../marks/message.js'
import { looksByWords, quietLooks } from '../marks/register'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageEl, wordsLook, type MarkStatus } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { squeezeBar, squeezeHidesCard, squeezeHolds, squeezeView } from '../squeeze/seam'
import { openThread } from '../threads/seam'
import {
  aboutOf, back, base, canRepair, cutTitle, drawsHyperlinks, evidenceLine, explainerText, fileHref, firstSentence, indexOf, lineWindow,
  open, printLine, push, refOf, restStop, rowsOf, sameRef, stepFrom, stepWords, stopWhat, stopsOfRow, stopsOfTurn, top,
} from './tray.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A mark the tray shows, or (`place`) the lines of a file an explainer's or a heads-up's words cite, `id` the place
 *  as `path:from-to`. */
export type Frame = (MarkRef | { row: string; kind: 'place'; id: string }) & { open?: 'code' | null }
export type Tray = { stack: Frame[] } | null
type Stop = { row: string; kind?: 'citation' | 'explain' | 'heads'; n?: number; id?: string; at?: number; card?: string }
type Stand = { row: string; card: string } | null

const TRAY = { plugin: 'thimble', key: 'tray' } as const
const STAND = { plugin: 'thimble', key: 'trayCard' } as const

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

/** The tray as it stands now; an open tray gives back the keys of a card ] reached. */
async function setTray($: Engine, tray: Tray): Promise<void> {
  const next = tray && tray.stack.length ? tray : null
  await writeTray($, next)
  if (next) await writeStand($, null)
}

export async function closeTray($: Engine): Promise<void> {
  await setTray($, null)
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

/** The person opened a mark: main hears it with their next prompt. */
async function told($: Engine, f: Frame): Promise<void> {
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
  // a citation that waits to be checked until it is opened (Citations auto cite, or asked words in manual) starts its
  // check: the spawn first
  if (f.kind === 'citation') await checkOpened($, f.row, f.n).catch(() => undefined)
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
  if (f.open) { await setTray($, { ...tray, stack: [...tray.stack.slice(0, -1), { ...f, open: null }] }); return }
  await setTray($, back(tray) as Tray)
}

/** A second click on the mark the tray shows: it closes, as 0 does (the one under it shows again, if any). */
async function pressedAgain($: Engine, f: Frame): Promise<boolean> {
  const tray = await trayNow($)
  if (!tray || !sameRef(top(tray), f)) return false
  await setTray($, back(tray) as Tray)
  return true
}

/** + and - on a citation computed by code: its whole code and output in place of the one line of evidence (`all`),
 *  or the one line again. */
async function showCode($: Engine, all: boolean): Promise<void> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return
  await writeTray($, { ...tray, stack: [...tray.stack.slice(0, -1), { ...f, open: all ? 'code' : null }] })
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
 *  the newest answer's): ] its first mark, [ its last stop (restStop). At the newest reply's last stop, ] stays. */
export async function stepMark($: Engine, dir: number): Promise<void> {
  const { list, at } = await stepPlace($)
  let next: Stop | null = null
  if (at >= 0) { next = stepFrom(list, at, dir) as Stop | null; if (!next) return }
  else {
    const row = await actingRow($)
    const turn = row ? await turnOfRow($, row) : null
    const here = list.filter(p => (turn ? turn.rows.includes(p.row) : p.row === row))
    const pool = here.length ? here : list.filter(p => p.row === list[list.length - 1]?.row)
    next = restStop(pool, dir) as Stop | null
  }
  if (!next) { noticeLine($, 'Nothing to step to yet.', 'tray'); return }
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
  if (f.kind === 'citation') {
    const ev = (await itemOf($, f.row, f.n))?.evidence
    if ((key === '+' || key === '-') && ev?.kind === 'computed' && (key === '+') !== (f.open === 'code')) {
      const all = key === '+'
      return { now: () => showCode($, all), undo: () => showCode($, !all) }
    }
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
 *  names only those; an open tray's keys are in its header; at rest none. */
export async function trayBar($: Engine, _on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (preview) return []
  const tray = await trayNow($)
  const stand = tray ? null : await standNow($)
  const steps = (): Promise<BarItem[]> => stepEnds($).then(ends => stepWords(ends).map((s: Any) => ({ id: `tray-${s.key}`, key: s.key, words: s.words, focus: true, press: () => stepMark($, s.key === ']' ? 1 : -1) })))
  if (stand) {
    return [
      { id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askCard($, stand) },
      ...(await steps()),
      { id: 'tray-0', key: '0', words: 'back', focus: true, press: () => writeStand($, null) },
    ]
  }
  // an open tray names its keys in its header (trayKeys), so the bar keeps its own
  return []
}

/** An open tray's keys, in its header at the right, each a click that does what its key does: ] (or [) the next mark,
 *  h the explainer on a citation's words, a ask, 0 back or close. x repair and + expand all (− collapse) are in the
 *  citation's card, where they act, and 2–9 are its links in an explainer's words. */
async function trayKeys($: Engine, tray: NonNullable<Tray>, f: Frame): Promise<BarItem[]> {
  const out: BarItem[] = (await stepEnds($).then(ends => stepWords(ends))).map((s: Any) => ({ id: `tray-${s.key}`, key: s.key, words: s.words, press: () => stepMark($, s.key === ']' ? 1 : -1) }))
  if (f.kind === 'citation') {
    const inner = await innerOf($, f)
    if (inner) {
      const g = inner.kind !== 'citation' ? await glossOf($, inner.row, inner.id) : null
      const term = String(g?.term ?? '')
      out.push({ id: 'tray-h', key: 'h', words: inner.kind === 'heads' ? 'heads-up' : `explain ${term.length > 24 ? `${term.slice(0, 23)}…` : term}`, press: () => pushMark($, inner) })
    }
  }
  out.push({ id: 'tray-a', key: 'a', words: 'ask', press: () => askAbout($, f) })
  out.push({ id: 'tray-0', key: '0', words: f.open || tray.stack.length > 1 ? 'back' : 'close', press: () => goBack($) })
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

/** A citation's status as its header says it, beside the kind: a sign, the word and its color. */
const STATUS: Record<string, { word: string; color?: string; dim?: boolean }> = {
  checking: { word: 'checking', dim: true },
  deferred: { word: 'not checked', dim: true },
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
 *  block, ended by `+ expand all`, a click that shows all the code and output (`fold`, as +); expanded, all the code
 *  (as code), then all the output in the ruled block, ended by `− collapse`, a click back (as -). For a file: its place (`place`, a click opens the side pane), then the cited line in the ruled
 *  block. For a card's value: the card's title, then the header over the cited row in the ruled block; printed output
 *  that is a table shows so too. The cited words bold in the citations' look. */
function citationBody(els: Any, f: Frame, m: MarkItem | null, w: number, place: Any | null, fold: (all: boolean) => unknown = () => undefined): Unit[] {
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
    Text({ key: 'k', wrap: 'truncate-end', children: [Text({ key: 'x', bold: true, color: accent(), children: 'x' }), Text({ key: 'w', children: ' repair' }), Text({ key: 'd', dimColor: true, children: unrun ? ': start its check' : ': check it again and correct the cited words' })] }),
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
    rows.push(foldRow(els, '− collapse', 'show the one line again', () => fold(false)))
    return rows
  }
  const table = ev.kind === 'card' || ev.kind === 'computed' ? ev.table : undefined
  const tl = table ? tableLines(table, w - 2) : null
  if (ev.kind === 'card') rows.push({ h: 1, el: Text({ key: 'card', wrap: 'truncate-end', children: [Text({ key: 'k', dimColor: true, children: 'card ' }), Text({ key: 't', bold: true, children: ev.title || ev.card })] }) })
  if (ev.kind === 'card' && tl) {
    rows.push(ruled(els, tl[0]!.text, [], w, 'th'), ...tl.slice(1).map((l, i) => ruled(els, l.text, l.spans as [number, number][], w, i ? `tr${i}` : 'tr')))
    return rows
  }
  const line = evidenceLine(ev)
  if (!line) return rows
  if (ev.kind === 'computed' && tl) {
    const said = printLine(ev.code, line.text)
    if (said) rows.push({ h: 1, el: Text({ key: 'said', color: CODE_INK, wrap: 'truncate-end', children: said }) })
    rows.push(ruled(els, tl[0]!.text, [], w, 'th'), ...tl.slice(1).map((l, i) => ruled(els, l.text, l.spans as [number, number][], w, i ? `tr${i}` : 'tr')))
    return rows
  }
  if (ev.kind === 'computed') {
    const said = printLine(ev.code, line.text)
    if (said) rows.push({ h: 1, el: Text({ key: 'said', color: CODE_INK, wrap: 'truncate-end', children: said }) })
  } else if (place) rows.push({ h: 1, el: place })
  const cut = lineWindow(line, w - 2)
  rows.push(ruled(els, cut.text, cut.spans, w, 'ev'))
  // all the code and output, at the end of the ruled block (+ shows them)
  if (ev.kind === 'computed') rows.push(foldRow(els, '+ expand all', 'show all the code and output', () => fold(true)))
  return rows
}

/** The ruled block's last line, a click that shows all the code and output (`+ expand all`) or the one line again
 *  (`− collapse`), as + and - do: dim, underlined under the pointer. */
function foldRow(els: Any, words: string, label: string, press: () => unknown): Unit {
  const { Box, Button, Text } = els
  return { h: 1, el: Box({ key: 'more', flexDirection: 'row', children: [
    Text({ key: 'rule', dimColor: true, children: '│' }),
    Box({ key: 'l', flexShrink: 1, marginLeft: 1, children: [Button({ key: 'more-press', plain: true, label, hover: quiet('tray-more-lines'), onPress: press, children: [Text({ key: 'n', dimColor: true, wrap: 'truncate-end', children: words })] })] }),
  ] }) }
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

/** The press on a citation's file place: the citation's evidence in the side pane. The open is awaited inside the
 *  handler, so it is made while the person's press runs: Claude Code places a pane at any width only for such an open,
 *  and one left to run after the handler returned (`void openPane(...)`) is unasked and waits undrawn below 144
 *  columns (110 for a pane the person opened before). When Claude Code still places none (no surface here draws
 *  panes), the notice says so; the tray keeps showing the cited line. */
export function evidenceOpener($: Engine, f: { row: string; n: number }): () => Promise<void> {
  return async () => {
    const placed = await openPane($, 'evidence', { row: f.row, n: f.n }, `citation ${f.n}`).catch(() => true)
    if (!placed) noticeLine($, 'Claude Code did not open the side pane here. The tray above still shows the cited line.', 'tray')
  }
}

/** In a citation of a file's lines, the file's place (`runs.jsonl:41`), dim: a click opens the citation's whole
 *  evidence in the side pane, which works over ssh too. Where Claude Code draws OSC 8 hyperlinks it is also a link to the file,
 *  which a ctrl or cmd click opens on this machine. */
async function fileLinkEl($: Engine, els: Any, f: Frame, m: MarkItem | null): Promise<Any | null> {
  const ev = m?.evidence
  if (!ev || ev.kind === 'computed' || ev.kind === 'card' || f.kind !== 'citation') return null
  const label = `${ev.file}:${evidenceLine(ev)?.n ?? ev.line}`
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
  return got.map((l, i) => ruled(els, cutTitle(`${l.n}  ${l.text}`.replace(/\t/g, '  '), w - 2), [], w, `pl${i}`))
}

/** The tray, drawn above the bar while it is open: one frame, its title (a citation's words, drawn and clicked as in
 *  the reply) on top, a citation's status and its keys at its right (trayKeys), then the mark's card, its rows starting where the
 *  title starts. All of it shows: a tray taller than the band's rows scrolls in the band (Claude Code's). */
export async function trayBand($: Engine, els: Any, width: number, _room = 0): Promise<Any[]> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return []
  const { Box, Text } = els
  const w = Math.max(40, Math.min(104, width - 3))
  const inner = w - 4
  let title = ''
  let units: Unit[] = []
  let words: { text: string } | null = null
  let status: ReturnType<typeof statusOf> | null = null
  let citeStatus: MarkStatus | null = null
  if (f.kind === 'citation') {
    const m = await itemOf($, f.row, f.n)
    citeStatus = m?.status ?? null
    await themeNow($)
    title = (m?.shown ?? m?.words ?? `citation ${f.n}`).replace(/\*\*|`/g, '')
    status = statusOf(m)
    units = citationBody(els, f, m, inner, await fileLinkEl($, els, f, m), all => showCode($, all))
  } else if (f.kind === 'place') {
    title = f.id
    units = await placeBody($, els, f, inner)
  } else {
    const g = await glossOf($, f.row, f.id)
    const heads = f.kind === 'heads'
    title = String(g?.term || g?.title || (heads ? 'heads-up' : 'explainer'))
    if (!g) units = [{ h: 1, el: Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: `This ${heads ? 'heads-up' : 'explainer'} is no longer in the session.` }) }]
    else words = { text: explainerText(g) }
  }
  let body: Any[]
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
      ...drawUnits(els, units),
    ]
  } else body = drawUnits(els, units)
  const tone = TONES[f.kind]
  // its keys at the right, after a citation's status, each drawn as the bar draws a key and a click that presses it
  const keys = await trayKeys($, tray, f)
  const keysLen = keys.reduce((n, k) => n + (n ? 3 : 0) + `${k.key} ${k.words}`.length, 0)
  const rightLen = (status ? status.word.length + 2 : 0) + keysLen
  // the title and the keys on one row when both fit, else the title on a row of its own above them
  const oneRow = title.length + 2 + rightLen <= inner
  const roomT = oneRow ? title.length : inner
  // the title is the marked words, drawn as the reply draws the open mark (marks/view.ts markEl: bold on its tint, a
  // citation underlined; an explainer's or a heads-up's words on their stronger fill), and a click on
  // them closes the tray, as a second click on the open mark in the reply does
  const fills = markColors(themeLast())
  const cite = f.kind === 'citation' ? wordsLook(citeStatus ?? 'failed', `tray:${f.row}:${f.n}`) : f.kind === 'place' ? wordsLook('unchecked', `tray:${f.row}:${f.id}`) : null
  const look: Any = cite ? { ...cite, bold: true, backgroundColor: cite.hover.backgroundColor } : { bold: true, backgroundColor: f.kind === 'heads' ? fills.headsFocus : fills.glossFocus }
  const titleEl = els.Button({ key: 'tray-title', plain: true, label: 'close the tray', hover: { inverse: false, ...(look.hover ? { scope: look.hover.scope } : {}) }, onPress: () => closeTray($), children: [
    Text({ key: 't', ...look, wrap: 'truncate-end', children: cutTitle(title, roomT) }),
  ] })
  const about = aboutOf(f, await infoOf($, f))
  const keyEls = keys.flatMap((k, i) => [
    ...(i ? [Text({ key: `ksep${i}`, dimColor: true, children: ' · ' })] : []),
    els.Button({ key: k.id, plain: true, label: k.key === 'a' ? `ask about ${about}` : `${k.key} ${k.words}`, hover: quiet(k.id), onPress: k.press, children: [
      Text({ key: 'k', color: accent(), bold: true, children: k.key }), Text({ key: 'w', dimColor: true, children: ` ${k.words}` }),
    ] }),
  ])
  const rightEl = Box({ key: 'r', flexDirection: 'row', ...(oneRow ? { flexShrink: 0 } : { flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }), children: [
    ...(status ? [Text({ key: 's', ...(status.color ? { color: status.color } : { dimColor: true }), children: status.word }), Text({ key: 'gap', children: '  ' })] : []),
    ...keyEls,
  ] })
  const head = oneRow
    ? Box({ key: 'tray-head', flexDirection: 'row', justifyContent: 'space-between', children: [Box({ key: 'l', flexShrink: 1, children: [titleEl] }), rightEl] })
    : Box({ key: 'tray-head', flexDirection: 'column', children: [titleEl, Box({ key: 'r-row', flexDirection: 'row', justifyContent: 'flex-end', width: inner, children: [rightEl] })] })
  const frame = Box({ key: 'tray', flexDirection: 'column', borderStyle: 'round', borderColor: tone, paddingX: 1, width: w, children: [head, Box({ key: 'tray-body', flexDirection: 'column', children: body })] })
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
      failNotice($, `The repair did not start: ${String((err as Error)?.message || err).slice(0, 160)}. Press x to try again.`, 'tray:repair')
      return { element: e.element }
    }
  }).catch(($, e, next) => next(e))
}
