// The terminal UI's runtime: what it read last and the moves that read thimble again or change what the panel shows.
// register.tsx wires these to Claude Code's events and hands each the context of its hook (hooks/ctx.ts); reply.tsx and
// panel.tsx draw. Nothing runs before thimble is on in the session (activate.ts sets the scope, `rt.sc`, and starts
// the timers here).
//
// Nothing here writes the workspace: a read is `thimble state`, a change is `thimble act` (hooks/data.ts).
import type { ChatNav, ChatNavStep, ChatSignal, TermCard, TermFilesUi, TermHome, TermLabelUi, TermPanel, TermPending, TermThreadRow } from './types'
import { busyWords, cardOfCell, checkOf, fixOf, linksOf, printed } from './cell'
import type { ThimbleCell, ThimbleLabel } from './cell'
import { SCRIPT_ASK } from './cite'
import type { CardData, CardLabel } from './draw'
import type { Ctx, SurfaceGot } from './ctx'
import { act, actLong, changed, dirStamp, readState, signature } from './data'
import type { Area, Scope, Signature } from './data'
import { cid, citations, clean, clip, embeddedCards, labelRef, noteDocPlace, noteLabelName, noteName, noteQuestion, questionOf, quoted } from './lib'
import type { Citation } from './lib'
import { agentsOf, cellOf, cellsOf, chatOf, docUnits, docsOf, homeOf, labelIdOf, labelOf, labelsOf, resolutionOf, threadOf, threadRowsOf, uiRecordsOf, verdictOf } from './model'
import { classColors, labelArgs, setLabelGone } from './labels'
import { fileRef } from './files'
import { keepSeen, keptSeen, loadKept, resetKept } from './kept'
import { NAV_EMPTY, backTarget, moved, nextTrail, withBack } from './nav'
import { signalEnd, withSignal } from './signal'
import type { AnswerComment } from './contracts'
import { featureOn, watchConfig } from './settings'
import { summaryOf } from './tracker'
import { PUMP_MS, viewPump } from './viewhost'
import { refreshSummary } from './views'

export const P = 'thimble'
export const LABEL_UI_EMPTY: TermLabelUi = { open: [], kind: {}, runs: {}, said: {} }
export const FILES_UI_EMPTY: TermFilesUi = { folded: [], unfolded: [], pick: '' }
/** The one pane thimble-term opens: home, a card, a citation, a thread, a label, a document, the files, an agent. */
export const PANEL = 'thimble'
/** The roles an orientation's chat and row carry (its chat's `role`, its row's): its panel offers `run again`. */
export const ORIENT_ROLES = new Set(['orient', 'orientation'])

/** The threads whose chats the threads panel reads, the newest. */
const THREADS_READ = 30

/** The panel's width: 96 columns, or what leaves main 70 beside it. */
const PANEL_COLS = 96
const MAIN_KEEP = 70

/** main's turn as it runs: the cards it made, its latest text row, its text rows in parts (a tool call starts the next),
 *  the views it proposed, and whether thimble-term gave its prompt (`own`). */
type Turn = { id: string; at: string; cards: string[]; row: string; parts: { uuid: string; text: string }[][]; views: string[]; own: boolean }

/** A ui.jsonl record's effect: what register.tsx does with a record a tool wrote for the renderer. */
export type UiApply = (cx: Ctx, kind: string, args: Record<string, unknown>) => Promise<void>

/** What thimble-term holds while the module runs (a reload starts it over; session.start reads the scope again). */
export const rt = {
  // the key of the panel's element that holds its focus ring (ui.focus), '' for none: while a text field holds it, the
  // letters a hint names go into the field
  panelFocus: '',
  // the text fields the panel's last drawing drew, by their keys: a ring a field held stays there only while the panel
  // draws that field (live check term-fix9, quirk 1: back from a new thread's form, the citation panel's hint still said
  // `Enter to ask · Esc to leave the field`)
  fields: new Set<string>(),
  // the field the view shown last starts its ring on in place of the list's keys, '' for those: the labels list's entry
  // box while the list holds no label (bug hunt C2), which giveKeys gives the ring after an open
  startRing: '',
  // a key the panel does not bind went to the prompt (panel.tsx typeThrough): every key that still reaches the panel
  // goes there too until the person gives the panel its keys back (keysBack); while the pane holds the keys it draws
  // neither its list's keys nor its hotkeys, so the next key reaches the prompt
  typeThrough: false,
  // the pane was drawn without the keys since the typing went to the prompt: a ring, a press or a drawing with the keys
  // after that is the person's giving the panel its keys back (bug hunt D8)
  typeAway: false,
  // the orientation run whose rerun the analyst asked from thimble (panel.tsx orientAgain), and the orientation runs
  // listed then: the panel on that run shows the first run listed after it (followRerun)
  rerun: null as { chat: string; known: string[] } | null,
  // when home was last seen before the open that shows it now (ms): a card made since is new on it
  homeSince: 0,
  // a link to a label whose name no read gave yet was drawn (reply.tsx chipOf): the session's timer reads the labels
  wantLabels: false,
  sc: null as Scope | null,
  sig: null as Signature | null,
  busy: false,
  again: false,
  // the labels' lane (labelsLane): the label definitions' folder as last listed (null before the first listing), and
  // whether a pass of the lane runs
  labelsStamp: null as string | null,
  labelsBusy: false,
  // the reads of a surface asked so far, and by key the one whose answer the surface holds: an answer of a read asked
  // before it never replaces it (two lanes read the labels and home)
  reads: 0,
  landed: new Map<string, number>(),
  turn: null as Turn | null,
  // the cards a drawing named and no drawing read yet, which the session's timer reads (tick) to name them
  wanted: new Set<string>(),
  // the latest row of main's chat a line can stand under (signal.ts isAnchor)
  anchor: '',
  termColumns: 0,
  // which of Claude Code's two screens the terminal draws (a command's `presentation`, a drawing's `viewport`, fixed per
  // session): true fullscreen, the only one that takes clicks; false the main screen (the classic renderer), where
  // nothing above the prompt can be pressed and home lists those rows with keys; null before either said
  fullscreen: null as boolean | null,
  // the terminal's width the docked panel was last opened or fitted at
  fittedFor: 0,
  // the pane waits undrawn (its open answered `isPlaced: false`): its first drawing takes the row above the prompt
  // away; and the width the row above the prompt last asked for it again at (retryPending)
  waiting: false,
  retriedAt: 0,
  // when the cards were last read (`cards --since`)
  cardsAt: '',
  // the cards some drawing shows, and the label each label card counts
  shown: new Set<string>(),
  labelOf: new Map<string, string>(),
  // the cards main deleted in this session (delete_card), which no answer draws or counts (bug hunt C16)
  deleted: new Set<string>(),
  // the last ui.jsonl record followed (-1 until the first read, which follows none of the earlier ones)
  uiN: -1,
  // where the latest gesture came from: inside the panel or not; the way a press on back or a crumb chose
  navFrom: null as { panel: boolean; at: number } | null,
  navTo: null as ChatNav | null,
  // each Client's gestures handled, by its origin
  seenGestures: new Map<string, number>(),
  // the answers each side thread had when last read: a new one while the panel does not show it is news
  answers: new Map<string, number>(),
  // whether each side thread ran when last read, and those whose last turn failed
  running: new Map<string, boolean>(),
  failed: new Set<string>(),
  // the text a paragraph's drag selected last (para.tsx), for "ask about this"
  selection: '',
  // citations waiting for their check, by id (a drawing queues them; the session's timer checks them)
  queue: new Map<string, Citation>(),
  checking: false,
  // every citation of a card's value seen, by the card: checked again when the card changes
  cardCites: new Map<string, Map<string, Citation>>(),
  // the citations whose place may resolve soon (a view's key while the view is built or indexed), by id: the checks
  // again so far and when the next is due (resolveCitations)
  retries: new Map<string, { c: Citation; n: number; due: number }>(),
  // the labels read for the cards that read them (their label rows and colours), read again when the labels change;
  // and those cards
  labelRead: new Map<string, ThimbleLabel | null>(),
  readers: new Set<string>(),
  // the prompts thimble-term gave main itself (a code label's run, a label described): their answers get no footer
  own: new Set<string>(),
  // when this session started: a thread made before is an earlier session's
  startedAt: 0,
  // the views a `↳ view` row stands for already, the views opened, and those built when the session first read them
  // (null until then): a view built since and not opened is new
  viewsTold: new Set<string>(),
  viewsSeen: new Set<string>(),
  viewsBuiltBefore: null as Set<string> | null,
  // each document's generation as the session first read it or last opened it: a newer one is new
  docsKnown: new Map<string, number>(),
  docsRead: false,
  // the failures a toast said already
  toasted: new Set<string>(),
  // the last turn's text and cards, which `/thimble cite` and `/thimble card` open by number
  lastReply: '',
  lastCards: [] as string[],
  // what each file opens as where that is not its lines (`thimble state opens`: `transcript`), by path, with the size it
  // had when read ('' for a file of lines)
  opens: new Map<string, { size: number; as: string }>(),
  // the threads main's chat has a `↳ thread` row of thimble-term's for: main's own `↳ thread` line about one is hidden
  told: new Set<string>(),
  // the writer run each row of main's chat with a `↳ The writer …` line reports (its chat), and the row that said each
  // run's end first: a later row's line about the same run is hidden (model.ts withoutWriterLines)
  writerOf: new Map<string, string>(),
  writerSaid: new Map<string, string>(),
  // the first report of each subagent run main was told of (model.ts reportOf: a hand-back or a task notification), by
  // the agent's id: its kind, whether main's answer to it said a `↳` line, and whether the run's other report came since;
  // the reports main's next text row answers, in order, each with whether it is a run's second after a first main
  // answered with a `↳` line; and, by row, main's `↳` lines that answer such a second report, which are hidden, as the
  // browser hides them
  reports: new Map<string, { kind: string; said: boolean; paired: boolean }>(),
  answering: null as { reports: { agent: string; again: boolean }[] } | null,
  repeats: new Map<string, string[]>(),
  // the cards read only for their questions (nameCards), each once
  named: new Set<string>(),
  // the refresh loop, the citation queue and the view pump run (started once thimble is on: startTimers)
  timers: false,
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Which screen the terminal draws, as a command's `presentation` or a terminal drawing's `viewport` says it. */
export function noteScreen(surface: string | undefined, fullscreen: unknown): void {
  if ((surface === undefined || surface === 'terminal') && typeof fullscreen === 'boolean') rt.fullscreen = fullscreen
}

/** Whether the terminal draws Claude Code's main screen (the classic renderer), which takes no clicks: the rows above the
 *  prompt and the thimble line cannot be pressed there, so home lists them with keys (band.tsx waitItems). */
export function classicScreen(): boolean {
  return rt.fullscreen === false
}

export function panelColumns(): number {
  return rt.termColumns ? Math.max(36, Math.min(PANEL_COLS, rt.termColumns - MAIN_KEEP - 1)) : PANEL_COLS
}

// ------------------------------------------------------------------------------------------------ cards

/** A card main deleted (delete_card): gone from the turn that runs and from what `/thimble card` opens, and from every
 *  answer's cards and footer from now on (liveCards). A card made again under its id is drawn again (cardMade). */
export function cardDeleted(id: string): void {
  rt.deleted.add(id)
  rt.shown.delete(id)
  if (rt.turn) rt.turn.cards = rt.turn.cards.filter(x => x !== id)
  rt.lastCards = rt.lastCards.filter(x => x !== id)
}

/** A card a call of main's made or changed (add_card, edit_card): no longer deleted. */
export function cardMade(id: string): void {
  rt.deleted.delete(id)
}

/** The cards of `ids` main has not deleted. */
export function liveCards(ids: readonly string[]): string[] {
  return ids.filter(id => !rt.deleted.has(id))
}

/** A cell as the drawing holds it. */
export function termCard(cell: ThimbleCell, label: ThimbleLabel | null, rev: number): TermCard {
  const { card, error } = cardOfCell(cell, label)
  const links = linksOf(cell)
  const out = printed(cell)
  return {
    id: cell.id,
    data: card,
    takeaway: String(cell.takeaway ?? ''),
    busy: busyWords(cell),
    error,
    group: String(cell.notebook ?? ''),
    by: String(cell.created_by ?? ''),
    kind: String(cell.kind ?? 'code'),
    label: labelIdOf(cell),
    code: String(cell.code ?? ''),
    rev,
    ...(links ? { links } : {}),
    ...(out ? { printed: out } : {}),
    ran: error || cell.status === 'error' ? 'error' : cell.status === 'ok' ? 'ok' : '',
    ...(checkOf(cell).state ? { check: checkOf(cell) } : {}),
    ...(fixOf(cell) ? { fixed: fixOf(cell)! } : {}),
  }
}

/** A label as the cards that read it draw it, read once until the labels change. */
async function labelFor(cx: Ctx, id: string): Promise<ThimbleLabel | null> {
  if (rt.labelRead.has(id)) return rt.labelRead.get(id)!
  if (!rt.sc) return null
  const got = await readState(cx, rt.sc, 'label', [id])
  const l = got.ok ? labelOf(got.value) : null
  rt.labelRead.set(id, l)
  if (l) noteLabelName(l.id, l.name)
  return l
}

/** The label rows of a card that read labels (SPEC.md, "Cards", the label row): each label's name, its values in
 *  their colours, the value of each record it marked (from the label's rows), and whether it changed since the card ran
 *  (the cell's `label_revs`, concepts.stale_in). */
export function cardLabelsOf(cell: ThimbleCell, labels: readonly ThimbleLabel[]): CardLabel[] {
  return labels.map(l => {
    const read = cell.label_revs?.[l.id]
    const marks: Record<string, string> = {}
    for (const r of l.rows ?? []) {
      const v = typeof r.analyst === 'string' && r.analyst ? r.analyst : String(r.label ?? '')
      if (r.ref && v) marks[r.ref] = v
    }
    const colors = classColors(l.classes)
    return { slug: l.id, name: l.name ?? l.id, values: l.labels ?? [], marks, ...(typeof read === 'number' && typeof l.rev === 'number' && l.rev > read ? { stale: true } : {}), ...(colors ? { colors } : {}) }
  })
}

async function putCard(cx: Ctx, cell: ThimbleCell): Promise<void> {
  const lid = labelIdOf(cell)
  let label: ThimbleLabel | null = null
  if (cell.kind === 'label' && lid && rt.sc) {
    rt.labelOf.set(cell.id, lid)
    label = await labelFor(cx, lid)
  }
  const prev = await cx.card(cell.id)
  const next = termCard(cell, label, (prev?.rev ?? 0) + 1)
  // a card that read labels shows each on a row, and its marks take the values' colours
  const read = cell.kind === 'label' ? [] : [...new Set((cell.labels ?? []).map(String))]
  if (read.length && next.data) {
    rt.readers.add(cell.id)
    const ls = (await Promise.all(read.map(id => labelFor(cx, id)))).filter((l): l is ThimbleLabel => l !== null)
    if (ls.length) next.data = { ...(next.data as CardData), labels: cardLabelsOf(cell, ls) }
  } else rt.readers.delete(cell.id)
  await cx.setCard(cell.id, next)
  // its question, which names it where a reply cites it without words
  noteQuestion(cell.id, (next.data as CardData | null)?.question ?? cell.title)
  noteName(cell.id, cell.slug)
  queueCitations(citations(next.takeaway))
  if (cell.kind === 'example') queueCitations(((cell.payload?.refs as unknown[]) ?? []).map(r => ({ raw: `[[${String(r)}]]`, ref: String(r), display: null })))
}

/** Read these cards now (a turn's call named them, or a panel shows one). `named`: read only to name them where a chip
 *  cites them (`card "How many…"`), not drawn, so not among the cards the session drew (`rt.shown`), whose takeaways'
 *  citations the thimble line counts (citesview.tsx citeItems). */
export async function loadCards(cx: Ctx, ids: readonly string[], opts: { named?: boolean } = {}): Promise<void> {
  if (!rt.sc) return
  for (const id of ids) {
    if (!opts.named) rt.shown.add(id)
    const got = await readState(cx, rt.sc, 'card', [id])
    const cell = got.ok ? cellOf(got.value) : null
    if (cell) await putCard(cx, cell)
    else {
      // a card that cannot be read is said so, in red, never by its id
      const why = got.ok ? '' : got.error
      const prev = await cx.card(id)
      await cx.setCard(id, { id, data: null, takeaway: '', busy: '', error: !why || why.includes(id) ? 'the card is not in this workspace' : why, group: '', by: '', kind: '', label: '', code: '', rev: (prev?.rev ?? 0) + 1 })
    }
  }
}

/** These cards read in one call (`cards --since` the epoch), each it does not list on its own (said so in red): the cards
 *  a resumed session's rows draw (register.tsx restoreKept). */
export async function loadCardsBatch(cx: Ctx, ids: readonly string[]): Promise<void> {
  if (!rt.sc || !ids.length) return
  const want = new Set(ids)
  const got = await readState(cx, rt.sc, 'cards', ['--since', iso(0)])
  const read = new Set<string>()
  if (got.ok) {
    for (const cell of cellsOf(got.value)) {
      if (!want.has(cell.id)) continue
      rt.shown.add(cell.id)
      read.add(cell.id)
      await putCard(cx, cell)
    }
  }
  await loadCards(cx, ids.filter(id => !read.has(id)))
}

/** The cards some drawing shows, read again: those the notebooks changed since the last read, and the label cards
 *  whose label changed. */
async function refreshCards(cx: Ctx, labels: boolean): Promise<void> {
  if (!rt.sc || !rt.shown.size) return
  const since = rt.cardsAt || iso(0)
  rt.cardsAt = iso((await cx.now()) - 5000)
  const got = await readState(cx, rt.sc, 'cards', ['--since', since])
  const read = new Set<string>()
  if (got.ok) {
    for (const cell of cellsOf(got.value)) {
      if (!rt.shown.has(cell.id)) continue
      read.add(cell.id)
      await putCard(cx, cell)
    }
  }
  // a card that waits for its run, runs or is checked is read whole, whatever its stamp says; so is one whose takeaway's
  // links check runs, so its citations (in the chat and an open citation panel) say when the check ends
  for (const id of rt.shown) {
    const tc = read.has(id) ? undefined : await cx.card(id)
    if (tc?.busy || tc?.links?.pending) await loadCards(cx, [id])
  }
  if (labels) {
    // the label cards and the cards that read a label, with the labels as they are now
    rt.labelRead.clear()
    for (const id of new Set([...rt.labelOf.keys(), ...rt.readers])) if (rt.shown.has(id)) await loadCards(cx, [id])
  }
}

// ------------------------------------------------------------------------------------------------ citations

/** Ask for these citations' checks: each is checked once, in a batch the session's timer sends (checkQueued), or
 *  again while its place may resolve soon (resolveCitations). A drawing may call it: it only notes them. */
export function queueCitations(cs: readonly Citation[]): void {
  // "Citation marks" off: citations are plain links, and nothing checks them
  if (!featureOn('citationMarks')) return
  for (const c of cs) {
    if (labelRef(c.ref)) continue // a label's link names no place to check
    const id = cid(c.raw)
    if (!rt.queue.has(id)) rt.queue.set(id, c)
    const card = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(c.ref)?.[1]
    if (card) {
      const m = rt.cardCites.get(card) ?? new Map<string, Citation>()
      m.set(id, c)
      rt.cardCites.set(card, m)
    }
  }
}

export async function checkQueued(cx: Ctx): Promise<void> {
  if (rt.checking || !rt.sc || (!rt.queue.size && !rt.retries.size)) return
  rt.checking = true
  try {
    const now = await cx.now()
    const due = [...rt.retries].filter(([, r]) => r.due <= now)
    const todo: Citation[] = []
    for (const [id, c] of rt.queue) if (!(await cx.verdict(id)) && !rt.retries.has(id)) todo.push(c)
    rt.queue.clear()
    // the citations whose place may resolve soon, whose next check is due (resolveCitations)
    for (const [, r] of due) todo.push(r.c)
    // a call that failed (a timeout, a crash) asks again on the next pass, so its citations do not stay ◌ for good
    if (todo.length && !(await resolveCitations(cx, todo))) for (const c of todo) if (!rt.queue.has(cid(c.raw))) rt.queue.set(cid(c.raw), c)
  } finally {
    rt.checking = false
  }
}

/** How long a citation whose place may resolve soon waits for each check again: a view's key that main cites as the
 *  view's build ends, before any process wrote the key's answer from the view's index (bug hunt D3: the index took
 *  15 s to 4 minutes). Past the last it is missing, and checked again only when the views' answers change
 *  (retryViewCites). */
export const RETRY_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 240_000, 300_000]

/** Check citations against `thimble state resolve` and keep each one's verdict; false when the call failed, so none
 *  was kept. A place that may resolve soon (`retry`) stays pending, its next check due after RETRY_MS, until it
 *  resolves or its checks again are spent, when it is missing (a red × is for a place that does not resolve for good). */
export async function resolveCitations(cx: Ctx, cs: readonly Citation[]): Promise<boolean> {
  if (!rt.sc || !cs.length) return true
  const refs = [...new Set(cs.map(c => c.ref))]
  const got = await readState(cx, rt.sc, 'resolve', [JSON.stringify(refs)])
  if (!got.ok) return false
  const at = await cx.now()
  for (const c of cs) {
    const res = resolutionOf(got.value, c.ref)
    // a label's name and a document's title and passage, for a link to it that has no words (lib.ts chipLabel)
    const meta = (res?.meta ?? {}) as { name?: unknown; title?: unknown }
    if (res?.kind === 'concept') noteLabelName(String(res.concept_id ?? labelRef(c.ref)?.id ?? ''), typeof meta.name === 'string' ? meta.name : undefined)
    if (res?.kind === 'report') noteDocPlace(c.ref, typeof meta.title === 'string' ? meta.title : undefined, typeof res.excerpt === 'string' ? res.excerpt : '')
    const id = cid(c.raw)
    let final = false
    if (res?.error !== undefined && res.retry === true) {
      const n = (rt.retries.get(id)?.n ?? 0) + 1
      final = n > RETRY_MS.length
      rt.retries.set(id, { c, n, due: final ? Infinity : at + RETRY_MS[n - 1]! })
    } else rt.retries.delete(id)
    await cx.setVerdict(id, verdictOf(c, res, at, final))
  }
  return true
}

/** The citations whose place may resolve soon checked again at the next pass of the citation queue: the views'
 *  answers changed (a process wrote a key's answer from a view's index, views/key-refs.json), so a key that did not
 *  resolve may now; one whose checks again are spent gets one more. */
export function retryViewCites(): void {
  for (const r of rt.retries.values()) {
    if (r.n > RETRY_MS.length) r.n = RETRY_MS.length
    r.due = 0
  }
}

/** The verdicts of the cards' takeaways checked again, and of every citation of a card's value seen anywhere (main's
 *  prose, a thread's answer, a document): a card ran again, its cell holds new values, so a stale one turns red. */
async function recheckCards(cx: Ctx, ids: readonly string[]): Promise<void> {
  const cs: Citation[] = []
  for (const id of ids) {
    const card = await cx.card(id)
    // a label's link names no place to check (queueCitations)
    if (card) cs.push(...citations(card.takeaway).filter(c => !labelRef(c.ref)))
  }
  for (const m of rt.cardCites.values()) cs.push(...m.values())
  if (cs.length) await resolveCitations(cx, cs)
}

// ------------------------------------------------------------------------------------------------ what the panel shows

/** A surface the panel reads, under the key the panel names it by. */
export async function readSurface(cx: Ctx, key: string, surface: string, args: readonly string[] = []): Promise<void> {
  if (!rt.sc) return
  const asked = ++rt.reads
  const got = await readState(cx, rt.sc, surface, args)
  if (!lands(key, asked)) return
  // the labels' names and the documents' titles, for a link to one that has no words (lib.ts chipLabel)
  if (got.ok && key === 'labels') for (const l of labelsOf(got.value)) noteLabelName(l.id, l.name)
  if (got.ok && key === 'docs') for (const d of docsOf(got.value)) noteDocPlace(`report:${d.slug}`, d.title)
  await cx.setSurface(key, got.ok ? { ok: true, value: got.value } : { ok: false, error: got.error })
}

/** Whether the answer of the read of `key` asked as `asked` (rt.reads) is the newest asked to land: a slow read asked
 *  before one that landed already is dropped, so it never puts back what was there before a change. */
function lands(key: string, asked: number): boolean {
  if ((rt.landed.get(key) ?? 0) > asked) return false
  rt.landed.set(key, asked)
  return true
}

export async function surfaceValue<T = unknown>(cx: Ctx, key: string): Promise<{ ok: true; value: T } | { ok: false; error: string } | undefined> {
  return (await cx.surface(key)) as SurfaceGot as never
}

// the step between the starts of the pages of a file the citation panel reads (`thimble state files` gives 200 lines
// a page), so a window up to 100 rows tall stands within one page
const CITE_STEP = 100

/** The start of the page of a file that holds `line` in its first hundred lines, as the citation panel reads them. */
export function citePage(line: number): number {
  return Math.floor((Math.max(1, line) - 1) / CITE_STEP) * CITE_STEP + 1
}

/** A page of a file's lines from `start` (`thimble state files <path> --start`), kept under `file:<path>:<start>`,
 *  the key it returns. */
export async function readFilePage(cx: Ctx, path: string, start: number): Promise<string> {
  const key = `file:${path}:${start}`
  await readSurface(cx, key, 'files', [path, ...(start > 1 ? ['--start', String(start)] : [])])
  return key
}

/** The citation a panel names (`ref`, and the value it shows). */
export function panelCitation(p: TermPanel): Citation | null {
  if (!p.ref) return null
  return { raw: p.display === null || p.display === undefined ? `[[${p.ref}]]` : `[[${p.display}|${p.ref}]]`, ref: p.ref, display: p.display ?? null }
}

/** The surfaces a panel view reads, read again. */
export async function loadPanel(cx: Ctx, p: TermPanel): Promise<void> {
  switch (p.view) {
    case 'home':
      // its surfaces read at once, so home draws what changed within one read's time of opening
      await Promise.all([readSurface(cx, 'canvas', 'cards', ['--since', iso(0)]), readSurface(cx, 'home-full', 'home'), readSurface(cx, 'labels', 'labels'), readSurface(cx, 'docs', 'docs'), refreshThreads(cx)])
      return
    case 'card':
      if (p.card) await loadCards(cx, [p.card])
      return
    case 'cite': {
      const c = panelCitation(p)
      if (c) {
        await resolveCitations(cx, [c])
        const v = await cx.verdict(cid(c.raw))
        if (v?.card) await loadCards(cx, [v.card])
        // a file citation: the page of its file around the cited line, the start of the window the panel scrolls
        // through the whole file (panel.tsx citeWindow)
        else if (v?.path && typeof v.line === 'number' && v.lines.length) await readFilePage(cx, v.path, citePage(v.line - 10))
        // the side thread asked for its verification script from the panel: its chat, which holds the script
        const asked = [...(await cx.threads())].reverse().find(t => t.anchor === c.ref && (t.question ?? '').startsWith(SCRIPT_ASK))
        if (asked) await readThread(cx, asked.id)
      }
      return
    }
    case 'label':
      if (p.label) await readSurface(cx, `label:${p.label}`, 'label', labelArgs(p.label))
      // the cards that use it: its own label card and every card that read it
      await readSurface(cx, 'canvas', 'cards', ['--since', iso(0)])
      return
    case 'labels':
      await readSurface(cx, 'labels', 'labels')
      return
    case 'docs':
      await readSurface(cx, 'docs', 'docs')
      return
    case 'doc':
      if (p.slug) {
        // while its writer writes: the writer's chat, for what it is doing
        await readSurface(cx, 'docs', 'docs')
        const writer = (await cx.agents()).find(a => a.role === 'writer' && a.state === 'running')
        if (writer?.chat) await readThread(cx, writer.chat)
        // the checks, which name its comments' checks and say which run on it (report.ts)
        await readSurface(cx, 'checks', 'checks')
        await readDoc(cx, p.slug)
      }
      return
    case 'agent':
      if (p.thread) await readThread(cx, p.thread)
      return
    case 'ask':
      await loadSubject(cx, p.anchor ?? '', p.target?.kind === 'card' ? (p.target.cardId ?? '') : '')
      return
    case 'thread':
    case 'threads':
      // the tree shows each thread's latest answer: every thread's chat is read (from where the last read stopped)
      await refreshThreads(cx)
      for (const t of (await cx.threads()).slice(-THREADS_READ)) await readThread(cx, t.id)
      // the one shown, though the list may not hold it yet (one just asked)
      if (p.view === 'thread' && p.thread && !(await cx.threads()).slice(-THREADS_READ).some(t => t.id === p.thread)) await readThread(cx, p.thread)
      if (p.view === 'thread' && p.thread && (await showingThread(cx, p.thread))) await markSeen(cx, p.thread)
      // the cards the shown thread made, drawn under its answers, and what it is about, drawn above them
      if (p.view === 'thread' && p.thread) {
        const tt = await cx.thread(p.thread)
        const ids = tt?.events.length ? [...new Set(threadOf(tt.meta, tt.events).turns.flatMap(t => t.cards ?? []))] : []
        if (ids.length) await loadCards(cx, ids)
        const row = (await cx.threads()).find(t => t.id === p.thread)
        if (row) await loadSubject(cx, row.anchor)
      }
      return
    default:
      await loaders.get(p.view)?.(cx, p)
  }
}

/** The place a side thread is about (its anchor, `card` a card asked about), as the panel shows it above the thread's
 *  chat (panel.tsx subjectEls), read: the card, or the cited lines of a file. */
async function loadSubject(cx: Ctx, anchor: string, card = ''): Promise<void> {
  const a = (anchor ?? '').split(',')[0] ?? ''
  const id = card || /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(a)?.[1] || ''
  if (id) return void (await loadCards(cx, [id]))
  if (subjectFile(a)) await resolveCitations(cx, [{ raw: `[[${a}]]`, ref: a, display: null }])
}

/** Whether a thread's anchor is a line or an item of a file of the folder, whose lines its subject shows. */
export function subjectFile(anchor: string): boolean {
  if (!anchor || /^[a-z]+:/i.test(anchor)) return false
  const f = fileRef(anchor)
  return Boolean(f && (f.line !== undefined || f.item !== undefined))
}

/** The reads of a panel view drawn by a module of its own (filesview.tsx: the file browser and a file), by its name. */
const loaders = new Map<string, (cx: Ctx, p: TermPanel) => Promise<void>>()
export function loadsView(view: string, load: (cx: Ctx, p: TermPanel) => Promise<void>): void {
  loaders.set(view, load)
}

/** A document read for the panel, with the cards it draws as figures and those its words cite read first, so its
 *  first drawing names each card by its question (live check term-fix9, quirk 9: a sentence read `(a card)` until the
 *  panel drew again). */
export async function readDoc(cx: Ctx, slug: string): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'doc', [slug])
  if (got.ok) {
    const card = (ref: string) => /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(ref.trim())?.[1] ?? ''
    const { units } = docUnits(got.value as Record<string, unknown>)
    const figures = units.flatMap(u => [...(u.figures ?? []), ...(u.figure ? [u.figure] : [])].map(f => card(String(f.cell ?? '')))).filter(Boolean)
    const words = units.flatMap(u => [String(u.heading ?? ''), ...[...(u.paragraphs ?? []).flatMap(q => q.sentences ?? []), ...(u.sentences ?? [])].map(x => String(x.text ?? '')), ...(u.figures ?? []).map(f => String(f.caption ?? ''))])
    const cited = [...new Set(words.flatMap(w => citations(w).map(c => card(c.ref)).filter(Boolean)))].filter(id => !figures.includes(id) && !questionOf(id) && !rt.named.has(id))
    await loadCards(cx, figures)
    await nameCards(cx, cited)
  }
  await cx.setSurface(`doc:${slug}`, got.ok ? { ok: true, value: got.value } : { ok: false, error: got.error })
}

/** What a panel's step remembers: its view, what names it, and the panel whole (in `mode`), so back shows it again. */
export function stepOf(p: TermPanel): ChatNavStep {
  return {
    view: p.view,
    title: p.title,
    ...(p.thread ? { thread: p.thread } : {}),
    ...(p.ref ? { open: p.display ? `${p.display}|${p.ref}` : p.ref } : {}),
    ...(p.card ? { card: p.card } : {}),
    // the Coverage view's group of a folder's files (`match`) is a step of its own after its folder's
    ...(p.slug || p.label || p.path || p.agent || p.match ? { slug: String(p.slug || p.label || (p.path || p.match ? `${p.path ?? ''}:${p.start ?? 1}${p.match ? `|${p.match}` : ''}` : '') || p.agent) } : {}),
    mode: JSON.stringify(p),
  }
}

export function panelOfStep(s: ChatNavStep): TermPanel | null {
  try {
    const p = JSON.parse(s.mode ?? '') as TermPanel
    return p && typeof p.view === 'string' ? p : null
  } catch {
    return null
  }
}

export async function navOrigin(cx: Ctx, panel: boolean): Promise<void> {
  rt.navFrom = { panel, at: await cx.now() }
}

async function inPanel(cx: Ctx): Promise<boolean> {
  return !!rt.navFrom?.panel && (await cx.now()) - rt.navFrom.at < 5000
}

/** Whether the latest gesture came from inside the panel (within 5 s): what it opens stands on the panel's trail. */
export async function inPanelNow(cx: Ctx): Promise<boolean> {
  return inPanel(cx)
}

/** A thread's step after the steps of the threads it was asked from, the root first (at most 12): where a thread
 *  opened from outside the panel starts its trail. */
async function threadChain(cx: Ctx, p: TermPanel, step: ChatNavStep): Promise<ChatNavStep[]> {
  const rows = await cx.threads()
  const chain: ChatNavStep[] = [step]
  const seen = new Set<string>([p.thread ?? ''])
  for (let id = rows.find(r => r.id === p.thread)?.parent ?? ''; id && id !== 'main' && !seen.has(id) && chain.length < 12; id = rows.find(r => r.id === id)?.parent ?? '') {
    seen.add(id)
    const r = rows.find(x => x.id === id)
    if (!r) break
    const name = r.question || r.title
    chain.unshift(stepOf({ view: 'thread', title: name ? quoted(clip(name, 60)) : 'thread', thread: id }))
  }
  return chain
}

/** Show `p` in the panel: its step on the panel's way, its data read, the pane opened with the keys (placePanel). A pane
 *  Claude Code leaves undrawn waits: the row above the prompt offers it (`pending`). `replace`: `p` takes the place of
 *  the step the panel shows, and back leads where it led (a line chosen in a file, a tab, a slide; the thread a new
 *  thread's form asked). */
export async function openPanel(cx: Ctx, p: TermPanel, opts: { replace?: boolean } = {}): Promise<void> {
  const step = stepOf(p)
  let nav = rt.navTo
  rt.navTo = null
  if (!nav && opts.replace) {
    const cur = (await cx.nav()) ?? NAV_EMPTY
    if (cur.trail.length) nav = { trail: [...cur.trail.slice(0, -1), step], back: cur.back.slice() }
  }
  if (!nav) {
    const cur = (await cx.nav()) ?? NAV_EMPTY
    nav = moved(cur, nextTrail(cur.trail, step, await inPanel(cx), p.view === 'thread' ? await threadChain(cx, p, step) : [step]))
  }
  rt.navFrom = null
  // the view drawn next puts the focus ring where it starts (an autoFocus field), or nowhere; a ring on the list's keys
  // stays there while the next view draws them too (the file view drawn again at the line ↓ chose), so its hint row
  // keeps them; giveKeys checks it
  if (rt.panelFocus !== RELAY_PICK || p.view === 'ask') rt.panelFocus = ''
  await cx.setNav(nav)
  await cx.setPanel(p)
  void loadPanel(cx, p).then(() => cx.bumpPanel()).catch(() => undefined)
  await placePanel(cx, p)
}

/** The pane opened for what the panel shows, `p`, with the keys. Claude Code places an open the person asked for at any
 *  width: one made while the hook of a command they typed or the handler of a Button they pressed still runs (so a
 *  press hands back the promise that opens the panel; a handler that returns first ends the asking). Any other open (a
 *  timer's, a click in a card, main's tool) it places only from 144 columns, or 110 for a pane the person opened before
 *  and has not closed by hand; below that it waits undrawn, the row above the prompt offers it and says why, and Claude
 *  Code places it once the terminal is widened to that width (the Pane's first drawing then takes the row away). */
async function placePanel(cx: Ctx, p: TermPanel): Promise<void> {
  opens++
  try {
    const title = paneTitle(p)
    rt.fittedFor = rt.termColumns
    const r = await cx.open({ id: PANEL, title, focus: true, columns: panelColumns() })
    rt.waiting = !r.isPlaced
    // placed, a later wait is asked for again at any width (retryPending)
    if (r.isPlaced) rt.retriedAt = 0
    await cx.setPending(r.isPlaced ? null : pendingOf(title, r.reason))
    // with a draft in the prompt the keys stay there (Claude Code keeps the person's typing)
    if (r.isPlaced && (await cx.promptText().catch(() => '')).trim()) cx.toast('the prompt holds a draft, so it keeps the keys: click the panel to use its keys')
    else if (r.isPlaced) giveKeys(cx, title, p.view === 'ask' ? ASK_FIELD : RELAY_PICK)
  } catch (err) {
    cx.log(`thimble-term: could not open the panel: ${String(err).slice(0, 200)}`)
  }
}

/** Why Claude Code left a pane undrawn, from its answer's `reason` (UiOpenResult): `unasked below 144 columns (120
 *  now…)`, the width from which it places a pane it was not asked for and the width then, or `no attached surface
 *  places panes`. */
export function pendingOf(title: string, reason: string): TermPending {
  const below = /below (\d+) columns \((\d+) now/.exec(reason)
  if (below) return { title, floor: Number(below[1]), columns: Number(below[2]) }
  return /no attached surface places panes/.test(reason) ? { title, noScreen: true } : { title }
}

/** The row above the prompt's `open panel`: the pane that waits opened again, as `/thimble` opens it, without a step
 *  of its own on the panel's way (the open that waited put it there). Its Button hands back this promise, so the open
 *  is the press's own and Claude Code places it at any width. */
export async function openPending(cx: Ctx): Promise<void> {
  const p = await cx.panel()
  if (!p) return void (await cx.setPending(null))
  await placePanel(cx, p)
  // still not placed after the press: the terminal is too narrow for the panel (Matt, 10-08: just the button, and
  // feedback when it is too narrow)
  if (rt.waiting) cx.toast('the terminal is too narrow for thimble\'s panel: widen it, then press open panel')
  void loadPanel(cx, p).then(() => cx.bumpPanel()).catch(() => undefined)
}

/** The row above the prompt gone once the panel is drawn: Claude Code placed a pane that waited (the terminal widened
 *  to its width, or a screen that draws panes attached), and the Pane's drawing or the row's own drawing saw it. */
export async function placedLater(cx: Ctx): Promise<void> {
  rt.waiting = false
  if ((await cx.pending()) === null) return
  if ((await cx.panes()).some(x => x.id === PANEL && x.isPlaced)) {
    rt.retriedAt = 0
    await cx.setPending(null)
  } else rt.waiting = true
}

/** The waiting pane asked for again, from a timer, once the terminal is as wide as the width Claude Code places it
 *  from (the row above the prompt saw that width): placed at once rather than when Claude Code's own look at the new
 *  width comes. Once per width until the pane is placed, so a refusal at that width is not asked again and again. */
export async function retryPending(cx: Ctx, columns: number): Promise<void> {
  if (rt.retriedAt === columns) return
  rt.retriedAt = columns
  const [w, p] = [await cx.pending(), await cx.panel()]
  if (!w || !p || (w.floor ?? Infinity) > columns) return
  if ((await cx.panes()).some(x => x.id === PANEL && x.isPlaced)) return void (await placedLater(cx))
  await placePanel(cx, p)
}

/** The panel asks for the keys once more a moment after it opened, once the press that opened it is over: an open from
 *  a press on the row above the prompt (the toast's `open ›`) is refused the keys while that row holds them (live check
 *  term-fix6, new quirk 4). Given them, its ring goes onto its list's keys (panel.tsx RELAY), which raises the
 *  `ui.focus` that lets its hint row name them (live check term-fix7, quirk 2: ↓ moved the ring to `show all threads`
 *  while the hint named ↑↓). Asked again while the prompt holds them over an empty composer, Claude Code gives them;
 *  else the panel's hint row says how to give them (panel.tsx endHints). */
function giveKeys(cx: Ctx, title: string, ringAsked = RELAY_PICK): void {
  // `left`: how many more times the ring is asked onto the keys while the view that draws them may not be drawn yet;
  // `reopened`: the pane was opened again to take the keys from the prompt
  const ask = async (left: number, reopened: boolean) => {
    const pane = (await cx.panes()).find(p => p.id === PANEL)
    if (!pane?.isPlaced) return
    if (pane.isFocused !== false) {
      // a view with no list whose keys a field takes in their place (the empty labels list's entry box)
      const ringOn = ringAsked === RELAY_PICK && rt.startRing ? rt.startRing : ringAsked
      // the ring onto the list's keys (a ring there already stays, and the call says so); a view that draws none leaves
      // the ring where it is, off them. Neither raises a ui.focus (live check term-fix8, quirk 7)
      // a new thread's field likewise: an open of a pane that holds the keys already is no take, so its `autoFocus` puts
      // no ring there. Only a text field the panel draws keeps the ring from them; a button's ring (a hotkey or a control
      // pressed, `show all threads`) or a field the view no longer draws does not (live check term-fix9, quirks 1 and 12)
      if (rt.panelFocus !== ringOn && rt.fields.has(rt.panelFocus)) return
      if (await cx.focus(ringOn)) {
        if (rt.panelFocus !== ringOn) {
          rt.panelFocus = ringOn
          await cx.bumpPanel()
        }
      } else if (left > 0) cx.later(KEYS_AGAIN_MS, () => void ask(left - 1, reopened).catch(() => undefined))
      return
    }
    if (reopened || (await cx.promptText().catch(() => '')).trim()) return
    const p = await cx.panel()
    await cx.open({ id: PANEL, title: p ? paneTitle(p) : title, focus: true, columns: panelColumns() }).catch(() => undefined)
    await cx.bumpPanel()
    cx.later(KEYS_AGAIN_MS, () => void ask(left, true).catch(() => undefined))
  }
  // a step of the session's after it ended rejects: nothing waits for it
  cx.later(KEYS_AGAIN_MS, () => void ask(KEYS_TRIES - 1, false).catch(() => undefined))
}

/** The keys back to the panel after a click on an empty part of a list, which gave them to the list's Client: its keys
 *  then reach the list through the pane's own (panel.tsx RELAY), and the hint row can say so (live check term-fix7,
 *  quirk 2: after such a click the list took ↓ while the hint said to click the panel). */
export async function takeKeys(cx: Ctx): Promise<void> {
  const p = await cx.panel()
  if (!p) return
  // typing that went to the prompt ends with a click on the panel: its list's keys are drawn again, and the ring goes
  // onto them as after an open (giveKeys)
  if (rt.typeThrough) {
    keysBack()
    rt.panelFocus = NO_RING
  }
  await cx.open({ id: PANEL, title: paneTitle(p), focus: true, columns: panelColumns() }).catch(() => undefined)
  await cx.bumpPanel()
  giveKeys(cx, paneTitle(p))
}

/** Typing that went to the prompt (panel.tsx typeThrough) ends: the person gave the panel its keys back, so the keys
 *  that reach it are its own again. */
export function keysBack(): void {
  rt.typeThrough = false
  rt.typeAway = false
}

// the panel's opens so far (placePanel): an act that opened a view asked for the keys itself
let opens = 0

/** The keys kept by the panel after the person pressed one of its own acts (a Button such as `checked ›` or a passage's
 *  `?`, a link, a row, a card's mark), as a click on a list keeps them (takeKeys). A click can leave the keys with the
 *  prompt though the act changed only the panel (bug hunt B28: after `checked ›` the hint row said `click the panel for
 *  its keys`, and the next `f` went to main's prompt). A moment after the press, once its act ran, a pane that no longer
 *  holds the keys takes them back; nothing when the act opened a view (placePanel asked for them), while the pane holds
 *  them, or once it closed. */
export function keepKeys(cx: Ctx): void {
  const at = opens
  cx.later(KEYS_AGAIN_MS, () =>
    void (async () => {
      if (opens !== at) return
      const pane = (await cx.panes()).find(x => x.id === PANEL)
      if (!pane?.isPlaced || (pane.isFocused !== false && !rt.typeThrough)) return
      await takeKeys(cx)
    })().catch(() => undefined),
  )
}

// the relay's field (panel.tsx RELAY.pick), a new thread's question field (panel.tsx drawAsk) and the ring off every
// element (register.tsx NO_FOCUS)
const RELAY_PICK = 'keys-pick'
const ASK_FIELD = 'ask-new'
const NO_RING = '-'

/** How long after an open the panel asks for the keys again (giveKeys), and how many times it asks while the ring does
 *  not go onto them (the list's keys not drawn yet). */
const KEYS_AGAIN_MS = 120
const KEYS_TRIES = 4

/** The title Claude Code shows on the pane for what the panel shows: `Citation`, a card's question, `Threads`, `Home`,
 *  a view's name, `Label: <name>`, a document's title, the lists by their names. The path names each step itself. */
export function paneTitle(p: TermPanel): string {
  switch (p.view) {
    case 'cite':
      return 'Citation'
    case 'thread':
    case 'threads':
    case 'ask':
      return 'Threads'
    case 'label':
      return `Label: ${p.title}`
    case 'docs':
      return 'Documents'
    default:
      return p.title || 'thimble'
  }
}

export async function closePanel(cx: Ctx): Promise<void> {
  rt.waiting = false
  await cx.setPending(null)
  await cx.close(PANEL).catch(() => undefined)
  await cx.setPanel(null)
}

export async function navGo(cx: Ctx, nav: ChatNav): Promise<void> {
  const s = nav.trail.at(-1)
  const p = s ? panelOfStep(s) : null
  if (!p) return
  rt.navTo = nav
  await openPanel(cx, p)
}

/** A list (`labels`, `docs`) from the step it holds, as the path's list step opens it: in place of that step (live
 *  check term-fix9, quirk 10: `l` pushed `home › documents › "…" › documents`), back leading where the path shows, the
 *  step before the list (home), never the step it replaced (live check term-fix10, new quirk 8). */
export async function openList(cx: Ctx, p: TermPanel): Promise<void> {
  const nav = (await cx.nav()) ?? NAV_EMPTY
  const at = nav.trail.findIndex(s => s.view === p.view)
  const keep = at >= 0 ? nav.trail.slice(0, at) : nav.trail.slice(0, -1)
  const before = keep.length ? keep : [stepOf({ view: 'home', title: 'Home' })]
  rt.navTo = { trail: [...keep, stepOf(p)], back: withBack(nav.back, before) }
  await openPanel(cx, p)
}

export async function navBack(cx: Ctx): Promise<void> {
  const to = backTarget((await cx.nav()) ?? NAV_EMPTY)
  if (to) await navGo(cx, to)
}

export async function openHome(cx: Ctx): Promise<void> {
  // the cards made since home was last seen are new on it while it shows
  rt.homeSince = (await cx.homeSeen())?.at ?? 0
  await openPanel(cx, { view: 'home', title: 'Home' })
  // what home holds now is seen: the row above the prompt shows only what arrives after
  const home = await cx.home()
  if (home) await seeHome(cx, home)
}

/** What home holds as seen: the row above the prompt counts what arrives after, in this session and after a relaunch
 *  (kept.ts keeps it in the workspace: live check term-fix8, low quirk: the slides made before a quit and never opened
 *  had no toast after the relaunch). */
export async function seeHome(cx: Ctx, home: TermHome): Promise<void> {
  await cx.setHomeSeen(home)
  if (rt.sc) await keepSeen(cx, rt.sc.ws, home)
}

// ------------------------------------------------------------------------------------------------ threads

/** A thread's chat, read again from where the last read stopped. */
export async function readThread(cx: Ctx, id: string): Promise<void> {
  if (!rt.sc || !id) return
  const prev = await cx.thread(id)
  const after = prev?.n ?? 0
  const got = await readState(cx, rt.sc, 'thread', [id, ...(after ? ['--after', String(after)] : [])])
  if (!got.ok) return
  const { meta, events } = chatOf(got.value)
  // the route answers the events past `--after`; one that says how many the chat holds (`total`) and gives them all is
  // read whole
  const total = (got.value as { total?: unknown })?.total
  const whole = !prev || (typeof total === 'number' && events.length === total)
  const all = whole ? events : [...prev.events, ...events]
  await cx.setThread(id, { id, meta, events: all.slice(-2000), n: whole ? events.length : after + events.length, rev: (prev?.rev ?? 0) + 1 })
  // the cards its words cite, read so that each is named by its question, as when the thread was asked, also in a
  // resumed session before the thread is opened (live check term-fix6, new quirk 9: a row read `(a card)`)
  const cited = new Set<string>()
  for (const e of events) {
    if (e.type !== 'text' && e.type !== 'user') continue
    for (const c of citations(String(e.delta ?? e.text ?? ''))) {
      const card = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(c.ref)?.[1]
      if (card && !questionOf(card) && !rt.named.has(card)) cited.add(card)
    }
  }
  if (cited.size) void nameCards(cx, [...cited]).then(() => cx.bumpPanel()).catch(() => undefined)
}

/** The questions of these cards noted (noteQuestion), each read once, so that a citation of one names it: a card a
 *  thread's words cite, which no drawing reads. */
async function nameCards(cx: Ctx, ids: readonly string[]): Promise<void> {
  if (!rt.sc) return
  for (const id of ids) {
    rt.named.add(id)
    const got = await readState(cx, rt.sc, 'card', [id])
    const cell = got.ok ? cellOf(got.value) : null
    if (cell) {
      noteQuestion(cell.id, cell.title)
      noteName(cell.id, cell.slug)
    }
  }
}

function newsOf(rows: readonly TermThreadRow[]): { n: number; one: string } {
  const fresh = rows.filter(t => t.unread > 0)
  return { n: fresh.length, one: fresh.length === 1 ? fresh[0]!.id : '' }
}

/** Whether the panel shows a thread now: drawn (no panel waits undrawn) and showing it. */
async function showingThread(cx: Ctx, id: string): Promise<boolean> {
  const shown = await cx.panel()
  if (shown?.view !== 'thread' || shown.thread !== id) return false
  if ((await cx.pending()) !== null) return false
  return (await cx.panes()).some(p => p.id === PANEL && p.isPlaced)
}

/** The threads as `thimble state threads` lists them now, read past what the session holds (a thread asked a moment
 *  ago, whose fork's name its meta holds once its question went to main). */
export async function threadsNow(cx: Ctx): Promise<TermThreadRow[]> {
  if (!rt.sc) return []
  const got = await readState(cx, rt.sc, 'threads')
  return got.ok ? threadRowsOf(got.value) : []
}

/** The threads list read again: the counts above the prompt, and a row in main's chat for each turn that ended (an
 *  answer, or a failure; not a stop) while the panel did not show its thread (hooks/signal.ts). */
export async function refreshThreads(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'threads')
  if (!got.ok) return
  const rows = threadRowsOf(got.value)
  const first = rt.answers.size === 0
  for (const t of rows) {
    const was = rt.answers.get(t.id)
    const ran = rt.running.get(t.id)
    rt.answers.set(t.id, t.answers)
    rt.running.set(t.id, t.running)
    if (first || was === undefined || !rt.anchor) continue
    const answered = t.answers > was
    // a run that ended with no answer: failed, or stopped by the analyst (not news)
    const ended = !answered && ran === true && !t.running
    if (!answered && !ended) continue
    if (await showingThread(cx, t.id)) continue
    await readThread(cx, t.id)
    const tt = await cx.thread(t.id)
    const th = tt?.events.length ? threadOf(tt.meta, tt.events) : null
    const turn = th ? th.turns.length : t.answers
    if (ended && (!th || signalEnd(th, turn) !== 'failed')) continue
    if (ended) rt.failed.add(t.id)
    else rt.failed.delete(t.id)
    const at = rt.anchor
    rt.told.add(t.id)
    await cx.setThreadRows(at, withSignal(await cx.threadRows(at), { thread: t.id, turn: Math.max(1, turn) }))
  }
  await cx.setThreads(rows)
  await cx.setNews(newsOf(rows))
  for (const t of rows) if (t.unread && (await showingThread(cx, t.id))) await markSeen(cx, t.id)
}

/** The analyst has read a thread's answers: thimble keeps it in the chat's meta (`thimble act seen`). */
export async function markSeen(cx: Ctx, id: string): Promise<void> {
  if (!rt.sc) return
  const rows = await cx.threads()
  const t = rows.find(r => r.id === id)
  if (t && !t.unread) return
  await act(cx, rt.sc, 'seen', { thread: id })
  if (t) {
    const next: TermThreadRow[] = rows.map(r => (r.id === id ? { ...r, unread: 0, seen: r.answers } : r))
    await cx.setThreads(next)
    await cx.setNews(newsOf(next))
  }
}

/** The signal rows a row of main's chat carries. */
export async function signalsAt(cx: Ctx, row: string): Promise<ChatSignal[]> {
  return cx.threadRows(row)
}

/** A new side thread about `anchor` (a ref) or `anchorText` (words on screen), with its first question: main forks
 *  `thread:<name>` for it, as for the browser's. Its id, or why it was refused. */
export async function startThread(cx: Ctx, anchor: string | null, anchorText: string, message: string, more: { parent?: string; element?: string; title?: string } = {}): Promise<{ id: string } | { error: string }> {
  if (!rt.sc) return { error: 'thimble is not on in this session' }
  const got = await act(cx, rt.sc, 'thread', { anchor, message, ...(anchorText ? { anchor_text: anchorText } : {}), ...(more.parent ? { parent: more.parent } : {}), ...(more.element ? { element: more.element } : {}), ...(more.title ? { title: more.title } : {}) })
  if (!got.ok) return { error: got.error }
  const v = got.value as { thread?: unknown; id?: unknown; meta?: { id?: unknown } }
  const id = String(v.thread ?? v.id ?? v.meta?.id ?? '')
  if (!id) return { error: 'thimble made no thread' }
  rt.answers.set(id, 0)
  await refreshThreads(cx)
  return { id }
}

/** A question in a thread that exists: why it was refused (''), and whether thimble queued it because the thread
 *  still answers. */
export async function threadMessage(cx: Ctx, thread: string, message: string): Promise<{ error: string; queued: boolean }> {
  if (!rt.sc) return { error: 'thimble is not on in this session', queued: false }
  const got = await act(cx, rt.sc, 'thread-message', { thread, message })
  if (!got.ok) return { error: got.error, queued: false }
  await readThread(cx, thread)
  return { error: '', queued: (got.value as { queued?: unknown }).queued === true }
}

// ------------------------------------------------------------------------------------------------ labels

/** What the label panel changes of a label (`thimble act label`): its name, its kind, its prompt (or pattern or code),
 *  its files, its values. */
export type LabelPatch = { name?: string; kind?: string; body?: string; glob?: string; values?: string[]; model?: string }

async function labelSaid(cx: Ctx, id: string, words: string, run?: { limit: number; at: number } | null): Promise<void> {
  const ui = await cx.labelUi()
  const runs = { ...ui.runs }
  if (run === null) delete runs[id]
  else if (run) runs[id] = run
  await cx.setLabelUi({ ...ui, runs, said: { ...ui.said, [id]: words } })
  await cx.bumpPanel()
}

/** Save the label panel's edits (`thimble act label`), then read the label again. '' when saved, else why not. */
export async function saveLabel(cx: Ctx, id: string, patch: LabelPatch): Promise<string> {
  if (!rt.sc) return 'thimble is not on in this session'
  const got = await act(cx, rt.sc, 'label', { label: id, ...patch })
  await readSurface(cx, `label:${id}`, 'label', labelArgs(id))
  if (!got.ok) {
    await labelSaid(cx, id, `× not saved: ${got.error}`)
    return got.error
  }
  const ui = await cx.labelUi()
  const kind = { ...ui.kind }
  delete kind[id]
  await cx.setLabelUi({ ...ui, kind })
  await labelSaid(cx, id, 'saved')
  return ''
}

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

/** What the analyst did that a code label's run follows, for main's prompt: `changed`, the press saved an edit of the
 *  label first; `reads`, what the run reads (labels.ts runReads: `30 of its 33 files`). */
/** `again`: a run over the units the label's last run could not label (a label notice's act, bug hunt C17). */
export type LabelRunHow = { changed: boolean; reads: string; again?: boolean }

/** Run a label from its panel on a sample of `limit` records, or on every record (`limit` 0), with `thimble act
 *  label-run`, which answers once the run ends: the panel says `◌ labeling` meanwhile and the counts after. A code
 *  label's code runs only in main's Bash: main is asked to run the command the act gives, in words that say only what
 *  the analyst did (`asked`); a code label whose last run covers this one runs nothing, and the panel says so, with no
 *  turn of main's (bug hunt B31: main was told "as I changed it" of a label nobody changed, and its run kept the old
 *  rows). With `asked.again`, a prompt label runs over the units its last run could not label alone, and main hears of
 *  it once it ends (`label_done`). */
export async function runLabel(cx: Ctx, id: string, name: string, limit: number, asked: LabelRunHow = { changed: false, reads: '' }): Promise<void> {
  if (!rt.sc) return
  await labelSaid(cx, id, '', { limit, at: await cx.now() })
  const got = await actLong<{ deferred?: boolean; unchanged?: boolean; command?: string; summary?: { counts?: Record<string, number>; labeled?: number; failed?: number; message?: string | null; stopped?: boolean; again?: { total?: number } } }>(cx, rt.sc, 'label-run', { label: id, ...(asked.again ? { again: true } : limit ? { limit } : {}) })
  if (!got.ok) {
    await labelSaid(cx, id, `× ${got.error}`, null)
    return
  }
  if (got.value.unchanged) {
    await labelSaid(cx, id, 'nothing changed since the last run, so thimble did not run it again', null)
    return
  }
  if (got.value.deferred && got.value.command) {
    const reads = asked.reads || (limit ? `a sample of ${limit.toLocaleString('en-US')}` : 'all of its records')
    const what = asked.changed ? `I changed the code label "${name}" in its panel. Run it on ${reads}.` : `Run the code label "${name}" on ${reads}.`
    await cx.submit(`${what} Use Bash to run this command: ${got.value.command}`)
    await labelSaid(cx, id, 'its code runs in main\'s Bash: main was asked to run it', null)
    return
  }
  const s = got.value.summary ?? {}
  const counts = Object.entries(s.counts ?? {}).map(([v, n]) => `${v} ${n.toLocaleString('en-US')}`).join(' · ')
  const failed = s.failed ? ` · ${plural(s.failed, 'record')} failed` : ''
  await readSurface(cx, `label:${id}`, 'label', labelArgs(id))
  // the label cards that count it are read again
  for (const [card, lid] of rt.labelOf) if (lid === id) await loadCards(cx, [card])
  const how = s.stopped
    ? `stopped after ${(s.labeled ?? 0).toLocaleString('en-US')}`
    : asked.again
      ? `ran again on the ${(s.again?.total ?? 0).toLocaleString('en-US')} it could not label`
      : `ran on ${limit ? `a sample of ${(s.labeled ?? limit).toLocaleString('en-US')}` : `all ${(s.labeled ?? 0).toLocaleString('en-US')}`}`
  // a run with failures says the first error on a row of its own, `!` in red
  const err = s.failed && s.message && !s.stopped ? `\n! ${s.message}` : ''
  await labelSaid(cx, id, `${how}${counts ? `: ${counts}` : ''}${failed}${err}`, null)
}

/** Stop a label's run started from its panel, after its current record (`thimble act label-stop`). */
export async function stopLabel(cx: Ctx, id: string): Promise<void> {
  if (!rt.sc) return
  const got = await act(cx, rt.sc, 'label-stop', { label: id })
  if (!got.ok) cx.toast(`thimble: the label's run was not stopped: ${got.error}`)
  else await labelSaid(cx, id, '◌ stopping after the current record')
}

/** Delete a label from its panel (`thimble act label-delete`): the label, its marks, its card and any filter that uses
 *  it, as the browser's Delete label does. Then the labels and home are read again and the labels list opens. '' when
 *  deleted, else why not, which the panel says on a `×` row. */
export async function deleteLabel(cx: Ctx, id: string, name: string): Promise<string> {
  if (!rt.sc) return 'thimble is not on in this session'
  const got = await act(cx, rt.sc, 'label-delete', { label: id })
  if (!got.ok) {
    await labelSaid(cx, id, `× not deleted: ${got.error}`)
    return got.error
  }
  const ui = await cx.labelUi()
  const drop = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)) as Record<string, T>
  await cx.setLabelUi({ ...ui, runs: drop(ui.runs), said: drop(ui.said), kind: drop(ui.kind), open: ui.open.filter(k => !k.startsWith(`${id}:`)) })
  await readSurface(cx, 'labels', 'labels')
  await refreshHome(cx)
  cx.toast(`thimble: deleted the label "${name}"`)
  // the labels list offers to undo it, as the browser's top bar does
  setLabelGone({ id, name })
  await openList(cx, { view: 'labels', title: 'Labels' })
  return ''
}

/** A label's change seen everywhere it shows: its panel, the labels list, home, its card and the cards that read it. */
async function relabel(cx: Ctx, id: string): Promise<void> {
  await readSurface(cx, `label:${id}`, 'label', labelArgs(id))
  await readSurface(cx, 'labels', 'labels')
  rt.labelRead.delete(id)
  for (const card of new Set([...rt.labelOf.keys(), ...rt.readers])) if (rt.shown.has(card)) await loadCards(cx, [card])
  await refreshHome(cx)
  await cx.bumpPanel()
}

/** Turn a label over files on or off in Files and the views, or give a value a color by its name (`thimble act
 *  label-show`, as the Labels pane's toggle and palette do). '' when done, else why not, which the panel says on a `×`
 *  row. */
export async function showLabel(cx: Ctx, id: string, change: { on?: boolean; colors?: Record<string, string> }): Promise<string> {
  if (!rt.sc) return 'thimble is not on in this session'
  const got = await act(cx, rt.sc, 'label-show', { label: id, ...(change.on !== undefined ? { on: change.on } : {}), ...(change.colors ? { colors: change.colors } : {}) })
  if (!got.ok) {
    await labelSaid(cx, id, `× not changed: ${got.error}`)
    return got.error
  }
  await relabel(cx, id)
  return ''
}

/** Keep only the units a label gives `value` in its scope (Files, the canvas or the report), or with null clear that
 *  filter (`thimble act label-filter`, as a label card's value does). '' when done, else why not. */
export async function filterLabel(cx: Ctx, id: string, value: string | null): Promise<string> {
  if (!rt.sc) return 'thimble is not on in this session'
  const got = await act(cx, rt.sc, 'label-filter', { label: id, ...(value ? { value } : {}) })
  if (!got.ok) {
    await labelSaid(cx, id, `× the filter was not set: ${got.error}`)
    return got.error
  }
  await relabel(cx, id)
  return ''
}

/** Undo the delete of the label deleted last (`thimble act label-undelete`): the label back with its marks, its card
 *  and its filters, its panel open. '' when done, else why not. */
export async function undeleteLabel(cx: Ctx, id: string, name: string): Promise<string> {
  if (!rt.sc) return 'thimble is not on in this session'
  const got = await act<{ name?: string }>(cx, rt.sc, 'label-undelete', { label: id })
  if (!got.ok) {
    // the labels list says why on a red `×` row in place of `undo`
    setLabelGone({ id, name, error: got.error })
    await cx.bumpPanel()
    return got.error
  }
  setLabelGone(null)
  await readSurface(cx, 'labels', 'labels')
  await refreshHome(cx)
  cx.toast(`thimble: restored the label "${got.value.name || name}"`)
  await openPanel(cx, { view: 'label', title: got.value.name || name, label: id })
  return ''
}

// ------------------------------------------------------------------------------------------------ the refresh loop

async function refreshAgents(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'agents')
  if (got.ok) await cx.setAgents(agentsOf(got.value))
}

/** The orientation run again from thimble (panel.tsx orientAgain) once its new run is listed: a panel that shows the run
 *  it replaces shows the new one in its place, running, then done (bug hunt E13: the panel kept the old failure for the
 *  whole of the new run). True when the panel changed. */
export async function followRerun(cx: Ctx): Promise<boolean> {
  const r = rt.rerun
  if (!r) return false
  const next = (await cx.agents()).filter(a => ORIENT_ROLES.has(a.role) && a.chat && !r.known.includes(a.chat)).at(-1)
  if (!next) return false
  rt.rerun = null
  const p = await cx.panel()
  if (p?.view !== 'agent' || p.thread !== r.chat) return false
  const now: TermPanel = { ...p, title: next.label || p.title, thread: next.chat }
  const nav = (await cx.nav()) ?? NAV_EMPTY
  if (nav.trail.length) await cx.setNav({ ...nav, trail: [...nav.trail.slice(0, -1), stepOf(now)] })
  await cx.setPanel(now)
  await readThread(cx, next.chat)
  return true
}

async function refreshHome(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const asked = ++rt.reads
  const got = await readState(cx, rt.sc, 'home')
  if (!got.ok || !lands('home', asked)) return
  // the views and the rest home draws, which the `↳ view` rows read too
  if (lands('home-full', asked)) await cx.setSurface('home-full', { ok: true, value: got.value })
  const views = Array.isArray((got.value as { views?: unknown })?.views) ? ((got.value as { views: { slug?: unknown; status?: unknown }[] }).views) : []
  if (rt.viewsBuiltBefore === null) rt.viewsBuiltBefore = new Set(views.filter(v => v?.status === 'built').map(v => String(v.slug)))
  const home = homeOf(got.value, await cx.now())
  await cx.setHome(home)
  if (!home) return
  // what the workspace held when home was last seen, in this session or the one before a relaunch (kept.ts), else the
  // session's first count: the row above the prompt shows only what comes after
  const seen = (await cx.homeSeen()) ?? keptSeen()
  // while home shows, what it holds is seen (the row above the prompt is hidden then)
  const showing = (await cx.panel())?.view === 'home' && (await cx.panes()).some(x => x.id === PANEL && x.isPlaced)
  if (!seen || showing) await seeHome(cx, home)
  else if (!(await cx.homeSeen())) await cx.setHomeSeen(seen)
}

/** The ui.jsonl records past the last one followed, handed to `apply` in order. The first read follows none. */
async function followUi(cx: Ctx, apply: UiApply): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'ui', ['--after', String(Math.max(0, rt.uiN))])
  if (!got.ok) return
  const recs = uiRecordsOf(got.value)
  const first = rt.uiN < 0
  if (first) rt.uiN = 0
  for (const r of recs) {
    if (r.n <= rt.uiN) continue
    rt.uiN = r.n
    if (!first) await apply(cx, r.kind, r.args)
  }
}

/** The areas a panel view reads. */
const PANEL_AREAS: Record<string, Area[]> = { home: ['cards', 'labels', 'docs', 'chats', 'views', 'agents'], files: ['labels'], file: ['labels'], views: ['views'], labels: ['labels'], label: ['labels', 'cards'], docs: ['docs', 'agents'], doc: ['docs', 'cards', 'agents', 'chats'], card: ['cards', 'labels'], cite: ['cards', 'chats'], threads: ['chats'], thread: ['chats'] }

/** One pass: what changed in the workspace since the last pass, read again where some drawing shows it. */
export async function tick(cx: Ctx, ui: UiApply): Promise<void> {
  if (!rt.sc) return
  if (rt.busy) {
    rt.again = true
    return
  }
  rt.busy = true
  try {
    // the labels a link with no words names (reply.tsx chipOf), and the cards a drawing named and could not read while
    // it drew (a drawing writes no state): read now
    if (rt.wantLabels) {
      rt.wantLabels = false
      await readSurface(cx, 'labels', 'labels')
    }
    if (rt.wanted.size) {
      const ids = [...rt.wanted]
      rt.wanted.clear()
      await loadCards(cx, ids, { named: true })
    }
    do {
      rt.again = false
      const sig = await signature(cx, rt.sc)
      const areas = new Set<Area>(changed(rt.sig, sig))
      const first = rt.sig === null
      rt.sig = sig
      if (!areas.size) break
      let panel = await cx.panel()
      if (areas.has('cards') || areas.has('labels')) {
        const before = [...rt.shown]
        await refreshCards(cx, areas.has('labels'))
        if (!first) await recheckCards(cx, before)
        // the cards home lists, read again while home is not shown (a thread's fork made one): home opened next shows
        // them at once, not the list as it was when home last showed
        if (areas.has('cards') && !first && panel?.view !== 'home' && panel?.view !== 'label' && (await cx.surface('canvas'))) await readSurface(cx, 'canvas', 'cards', ['--since', iso(0)])
      }
      // a key's answer written from a view's index: the citations of views' keys that did not resolve are checked again
      if (areas.has('viewKeys') && !first) retryViewCites()
      if (areas.has('chats') || areas.has('agents')) {
        await refreshAgents(cx)
        if (await followRerun(cx)) panel = await cx.panel()
      }
      if (areas.has('chats')) {
        await refreshThreads(cx)
        if (panel?.thread && (panel.view === 'thread' || panel.view === 'agent')) await readThread(cx, panel.thread)
      }
      if (areas.has('ui')) await followUi(cx, ui)
      // a record count that ended (coverage.py touches the folder): the summary line says the percent at once
      if (areas.has('coverage') && featureOn('coverage')) await readCoverage(cx)
      // the checks' comments on Claude's answers, and the checks reading one now
      if (areas.has('answers') && featureOn('checks')) await readAnswerComments(cx)
      if (first || areas.has('cards') || areas.has('labels') || areas.has('docs') || areas.has('chats') || areas.has('views') || areas.has('agents')) await refreshHome(cx)
      // the summary line above the prompt counts these (the panel lane's band.tsx)
      if (SUMMARY_AREAS.some(a => areas.has(a))) await refreshSummary(cx)
      if (panel && !first) {
        if ((PANEL_AREAS[panel.view] ?? []).some(a => areas.has(a))) await loadPanel(cx, panel)
        await cx.bumpPanel()
      }
    } while (rt.again)
    // the browser's Settings changed thimble's config: the switches follow (settings.ts)
    await watchConfig(cx)
  } finally {
    rt.busy = false
  }
}

/** The labels' lane (bug hunt D4: a sub-label and labels made in the browser reached the labels list and the thimble
 *  line minutes late, three places giving three counts): each second, the folder of the label definitions (concepts/,
 *  a file per label, written as a label is made, changed or deleted, not as its run marks records) listed; once it
 *  changed, the labels list's labels and home's counts, which the thimble line's `labels N` reads, read again at once,
 *  beside the refresh loop (tick), whose pass may take minutes while labels run, as it reads again every card that
 *  shows a label whose records grew. */
export async function labelsLane(cx: Ctx): Promise<void> {
  if (!rt.sc || rt.labelsBusy) return
  rt.labelsBusy = true
  try {
    const stamp = await dirStamp(cx, rt.sc, LABEL_DEFS)
    if (stamp === rt.labelsStamp) return
    const first = rt.labelsStamp === null
    rt.labelsStamp = stamp
    if (first) return
    await Promise.all([readSurface(cx, 'labels', 'labels'), refreshHome(cx)])
    await cx.bumpPanel()
  } finally {
    rt.labelsBusy = false
  }
}

/** The folder of the label definitions, in the workspace (data.ts AREAS `labels`). */
const LABEL_DEFS = 'concepts'

/** The areas whose change the summary line above the prompt counts. */
const SUMMARY_AREAS: Area[] = ['labels', 'coverage', 'answers', 'cards', 'docs']

/** The session's coverage summary read again (`thimble state coverage --summary`, C7). */
export async function readCoverage(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'coverage', ['--session', await cx.sessionId(), '--summary'])
  if (!got.ok) return
  const summary = summaryOf((got.value as { summary?: unknown })?.summary)
  if (summary) await cx.setCoverageSummary(summary)
}

/** A comment as C9 prints it, in the terminal's spelling; null for one that names no passage. */
export function answerCommentOf(v: unknown): AnswerComment | null {
  const o = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x : '')
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : -1)
  if (!str(o.id) || !str(o.row) || !str(o.quote)) return null
  const color = Math.max(1, Math.min(8, Math.round(num(o.color) > 0 ? num(o.color) : 1)))
  return {
    id: str(o.id),
    check: str(o.check),
    checkName: clean(str(o.check_name) || str(o.checkName) || str(o.check)),
    color,
    about: clean(str(o.about)),
    turn: str(o.turn),
    row: str(o.row),
    ref: str(o.ref),
    start: num(o.start),
    end: num(o.end),
    quote: str(o.quote),
    text: clean(str(o.text)),
    details: clean(str(o.details)),
    status: o.status === 'dismissed' ? 'dismissed' : 'open',
    at: str(o.at),
  }
}

/** The checks' open comments on this session's answers and the checks reading an answer now (`thimble state
 *  answer-comments`, C9). */
export async function readAnswerComments(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'answer-comments', ['--session', await cx.sessionId(), '--status', 'open'])
  if (!got.ok) return
  const v = (got.value ?? {}) as { comments?: unknown; running?: unknown }
  const comments = (Array.isArray(v.comments) ? v.comments : []).map(answerCommentOf).filter((c): c is AnswerComment => c !== null && c.status === 'open')
  await cx.setAnswerComments(comments)
  await cx.setChecksRunning(Array.isArray(v.running) ? v.running.length : 0)
}

/** A ui.jsonl record a tool wrote for the panel (set_layout, open_view, set_filter, show_label): the panel shows the
 *  surface it names. */
export const applyUi: UiApply = async (cx, kind, args) => {
  const surfaces = Array.isArray(args.surfaces) ? args.surfaces.map(String) : typeof args.surface === 'string' ? [args.surface] : []
  const view = String(args.view ?? args.slug ?? '')
  if (kind === 'open_view' || (kind === 'layout' && surfaces.some(s => s.startsWith('view:')))) {
    const slug = view || (surfaces.find(s => s.startsWith('view:')) ?? '').slice(5)
    if (slug) await openPanel(cx, { view: 'view', title: String(args.name ?? slug), slug })
    return
  }
  if (kind === 'layout') {
    const first = surfaces.find(s => s !== 'canvas') ?? surfaces[0] ?? ''
    // the browser's Files: in the terminal, Coverage lists the files (there is no file browser)
    if (first === 'files') await openPanel(cx, { view: 'coverage', title: 'Coverage' })
    else if (first === 'report') await openPanel(cx, { view: 'docs', title: 'Documents' })
    else if (first) await openHome(cx)
    return
  }
  const p = await cx.panel()
  if ((kind === 'filter' || kind === 'label') && p?.view.startsWith('file')) await openPanel(cx, p)
}

/** The refresh loop (every second), the labels' lane (every second), the citation queue (every 250 ms) and the view
 *  pump, once per module copy, from the moment thimble is on. */
export function startTimers(cx: Ctx): void {
  if (rt.timers) return
  rt.timers = true
  // a pass that a session's end cut short rejects: nothing waits for it
  const quiet = () => undefined
  cx.every(1000, () => void tick(cx, applyUi).catch(quiet))
  cx.every(1000, () => void labelsLane(cx).catch(quiet))
  cx.every(250, () => void checkQueued(cx).catch(quiet))
  // the open view matched to what the panel draws, and thimble's view host started the first time a view opens, from a
  // timer of the session's, which lives as long as it (viewhost.ts)
  cx.every(PUMP_MS, () => void viewPump(cx).catch(quiet))
  void tick(cx, applyUi).catch(quiet)
}

/** What main's chat drew under its rows in earlier processes of this conversation (kept.ts), put in the state where it
 *  holds none; then, beside the session, the cards those rows draw, read in one call, and the threads their `↳ thread`
 *  rows name. */
export async function restoreKept(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  resetKept()
  const k = await loadKept(cx, rt.sc.ws)
  const ids = new Set<string>()
  for (const [row, r] of Object.entries(k.rows)) {
    await cx.restoreRow(row, r)
    for (const id of [...(r.cards ?? []), ...(r.answer?.cards ?? []), ...embeddedCards(r.answer?.text ?? '')]) ids.add(id)
    for (const v of r.views ?? []) rt.viewsTold.add(v)
    for (const t of r.threads ?? []) rt.told.add(t.thread)
    if (r.repeat?.length) rt.repeats.set(row, r.repeat)
    if (r.writer) {
      if (!rt.writerOf.has(row)) rt.writerOf.set(row, r.writer.chat)
      if (r.writer.first && !rt.writerSaid.has(r.writer.chat)) rt.writerSaid.set(r.writer.chat, row)
    }
  }
  if (!rt.lastReply && k.last.reply) rt.lastReply = k.last.reply
  if (!rt.lastCards.length && k.last.cards.length) rt.lastCards = k.last.cards
  const threads = new Set(Object.values(k.rows).flatMap(r => (r.threads ?? []).map(t => t.thread)))
  void (async () => {
    await loadCardsBatch(cx, [...ids])
    // each `↳ thread` row names its turn's question, from the thread's chat
    for (const id of threads) await readThread(cx, id)
  })().catch(err => cx.log(`thimble: the cards main's chat drew before could not be read: ${String(err).slice(0, 200)}`))
}
