// thimble-term's runtime: what it read last and the moves that read thimble again or change what the panel shows.
// register.tsx wires these to Claude Code's events and hands each the context of its hook (hooks/ctx.ts); reply.tsx and
// panel.tsx draw.
//
// Nothing here writes the workspace: a read is `thimble state`, a change is `thimble act` (hooks/data.ts).
import type { ChatNav, ChatNavStep, ChatSignal, TermCard, TermFilesUi, TermHome, TermLabelUi, TermPanel, TermThreadRow } from '../types'
import { busyWords, cardOfCell, checkOf, fixOf, linksOf, printed } from './cell'
import type { ThimbleCell, ThimbleLabel } from './cell'
import type { CardData, CardLabel } from './draw'
import type { Ctx, SurfaceGot } from './ctx'
import { act, actLong, changed, readState, signature } from './data'
import type { Area, Scope, Signature } from './data'
import { cid, citations, clip, labelRef, noteDocPlace, noteLabelName, noteQuestion, questionOf, quoted } from './lib'
import type { Citation } from './lib'
import { agentsOf, cellOf, cellsOf, chatOf, docUnits, docsOf, homeOf, labelIdOf, labelOf, labelsOf, resolutionOf, threadOf, threadRowsOf, uiRecordsOf, verdictOf } from './model'
import { firstChoice, turnsRead, wholeJson } from './files'
import { keepSeen, keptSeen } from './kept'
import { NAV_EMPTY, backTarget, moved, nextTrail, withBack } from './nav'
import { signalEnd, withSignal } from './signal'

export const P = 'thimble-term'
export const LABEL_UI_EMPTY: TermLabelUi = { open: [], kind: {}, runs: {}, said: {} }
export const FILES_UI_EMPTY: TermFilesUi = { folded: [], unfolded: [], pick: '' }
/** The one pane thimble-term opens: home, a card, a citation, a thread, a label, a document, the files, an agent. */
export const PANEL = 'thimble-term'

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
  // a key the panel does not bind went to the prompt (panel.tsx typeThrough): until the prompt has the keys the panel
  // draws neither its list's keys nor its hotkeys, so the next key reaches the prompt
  typeThrough: false,
  // when home was last seen before the open that shows it now (ms): a card made since is new on it
  homeSince: 0,
  // a link to a label whose name no read gave yet was drawn (reply.tsx chipOf): the session's timer reads the labels
  wantLabels: false,
  sc: null as Scope | null,
  sig: null as Signature | null,
  busy: false,
  again: false,
  turn: null as Turn | null,
  // the cards each row of main's chat stands with: its turn's, drawn under the turn's last reply, and those its answer
  // embeds, by the row's uuid, so a sentence of the reply that cites one whole leaves the reference out
  rowCards: new Map<string, string[]>(),
  // the cards a drawing named and no drawing read yet, which the session's timer reads (tick)
  wanted: new Set<string>(),
  // the latest row of main's chat a line can stand under (signal.ts isAnchor)
  anchor: '',
  termColumns: 0,
  // the terminal's width the docked panel was last opened or fitted at
  fittedFor: 0,
  // when the cards were last read (`cards --since`)
  cardsAt: '',
  // the cards some drawing shows, and the label each label card counts
  shown: new Set<string>(),
  labelOf: new Map<string, string>(),
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
  // the cards read only for their questions (nameCards), each once
  named: new Set<string>(),
}

/** The most files one `thimble state opens` reads the head of (backend local.py OPENS_MAX). */
const OPENS_MAX = 100

/** What the listed files of plain text open as, read for those not read yet or changed since (at most OPENS_MAX a
 *  read): a file that opens as a transcript shows `transcript` as its type, as its preview and its view say. */
export async function readOpens(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = (await cx.surface('files')) as SurfaceGot | undefined
  const list = got?.ok ? (Array.isArray(got.value) ? got.value : (got.value as { files?: unknown })?.files) : []
  const files = (Array.isArray(list) ? list : []).filter((f): f is { path: string; kind?: unknown; size_bytes?: unknown; size?: unknown } => Boolean(f) && typeof (f as { path?: unknown }).path === 'string')
  const sizeOf = (f: { size_bytes?: unknown; size?: unknown }) => (typeof f.size_bytes === 'number' ? f.size_bytes : typeof f.size === 'number' ? f.size : 0)
  const want = files.filter(f => (!f.kind || f.kind === 'text') && rt.opens.get(f.path)?.size !== sizeOf(f)).slice(0, OPENS_MAX)
  if (!want.length) return
  const r = await readState(cx, rt.sc, 'opens', [JSON.stringify(want.map(f => f.path))])
  if (!r.ok) return
  const as = (r.value ?? {}) as Record<string, unknown>
  for (const f of want) rt.opens.set(f.path, { size: sizeOf(f), as: typeof as[f.path] === 'string' ? (as[f.path] as string) : '' })
  await cx.bumpPanel()
}

const iso = (ms: number) => new Date(ms).toISOString()

export function panelColumns(): number {
  return rt.termColumns ? Math.max(36, Math.min(PANEL_COLS, rt.termColumns - MAIN_KEEP - 1)) : PANEL_COLS
}

// ------------------------------------------------------------------------------------------------ cards

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
    return { slug: l.id, name: l.name ?? l.id, values: l.labels ?? [], marks, ...(typeof read === 'number' && typeof l.rev === 'number' && l.rev > read ? { stale: true } : {}) }
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
  queueCitations(citations(next.takeaway))
  if (cell.kind === 'example') queueCitations(((cell.payload?.refs as unknown[]) ?? []).map(r => ({ raw: `[[${String(r)}]]`, ref: String(r), display: null })))
}

/** Read these cards now (a turn's call named them, or a panel shows one). */
export async function loadCards(cx: Ctx, ids: readonly string[]): Promise<void> {
  if (!rt.sc) return
  for (const id of ids) {
    rt.shown.add(id)
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
  // a card that waits for its run, runs or is checked is read whole, whatever its stamp says
  for (const id of rt.shown) if (!read.has(id) && (await cx.card(id))?.busy) await loadCards(cx, [id])
  if (labels) {
    // the label cards and the cards that read a label, with the labels as they are now
    rt.labelRead.clear()
    for (const id of new Set([...rt.labelOf.keys(), ...rt.readers])) if (rt.shown.has(id)) await loadCards(cx, [id])
  }
}

// ------------------------------------------------------------------------------------------------ citations

/** Ask for these citations' checks: each is checked once, in a batch the session's timer sends (checkQueued). A
 *  drawing may call it: it only notes them. */
export function queueCitations(cs: readonly Citation[]): void {
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
  if (rt.checking || !rt.sc || !rt.queue.size) return
  rt.checking = true
  try {
    const todo: Citation[] = []
    for (const [id, c] of rt.queue) if (!(await cx.verdict(id))) todo.push(c)
    rt.queue.clear()
    if (todo.length) await resolveCitations(cx, todo)
  } finally {
    rt.checking = false
  }
}

/** Check citations against `thimble state resolve` and keep each one's verdict. */
export async function resolveCitations(cx: Ctx, cs: readonly Citation[]): Promise<void> {
  if (!rt.sc || !cs.length) return
  const refs = [...new Set(cs.map(c => c.ref))]
  const got = await readState(cx, rt.sc, 'resolve', [JSON.stringify(refs)])
  if (!got.ok) return
  const at = await cx.now()
  for (const c of cs) {
    const res = resolutionOf(got.value, c.ref)
    // a label's name and a document's title and passage, for a link to it that has no words (lib.ts chipLabel)
    const meta = (res?.meta ?? {}) as { name?: unknown; title?: unknown }
    if (res?.kind === 'concept') noteLabelName(String(res.concept_id ?? labelRef(c.ref)?.id ?? ''), typeof meta.name === 'string' ? meta.name : undefined)
    if (res?.kind === 'report') noteDocPlace(c.ref, typeof meta.title === 'string' ? meta.title : undefined, typeof res.excerpt === 'string' ? res.excerpt : '')
    await cx.setVerdict(cid(c.raw), verdictOf(c, res, at))
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
  const got = await readState(cx, rt.sc, surface, args)
  // the labels' names and the documents' titles, for a link to one that has no words (lib.ts chipLabel)
  if (got.ok && key === 'labels') for (const l of labelsOf(got.value)) noteLabelName(l.id, l.name)
  if (got.ok && key === 'docs') for (const d of docsOf(got.value)) noteDocPlace(`report:${d.slug}`, d.title)
  await cx.setSurface(key, got.ok ? { ok: true, value: got.value } : { ok: false, error: got.error })
}

export async function surfaceValue<T = unknown>(cx: Ctx, key: string): Promise<{ ok: true; value: T } | { ok: false; error: string } | undefined> {
  return (await cx.surface(key)) as SurfaceGot as never
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
      await Promise.all([readSurface(cx, 'canvas', 'cards', ['--since', iso(0)]), readSurface(cx, 'home-full', 'home'), readSurface(cx, 'labels', 'labels'), readSurface(cx, 'docs', 'docs'), readSurface(cx, 'files', 'files'), refreshThreads(cx)])
      await readOpens(cx)
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
      }
      return
    }
    case 'label':
      if (p.label) await readSurface(cx, `label:${p.label}`, 'label', [p.label])
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
        await readDoc(cx, p.slug)
      }
      return
    case 'files': {
      await readSurface(cx, 'files', 'files')
      await readOpens(cx)
      // the row chosen: the analyst's, else the first file of the first open folder (live check term-fix9, quirk 7: no
      // row was chosen as the browser opened); the chosen file's first lines, shown under the list
      let ui = await cx.filesUi()
      if (!ui.pick) {
        const got = (await cx.surface('files')) as SurfaceGot | undefined
        const list = got?.ok ? (Array.isArray(got.value) ? got.value : (got.value as { files?: unknown })?.files) : []
        const first = firstChoice((Array.isArray(list) ? list : []).filter((f): f is { path: string } => typeof (f as { path?: unknown })?.path === 'string'), ui)
        if (first) {
          ui = { ...ui, pick: first }
          await cx.setFilesUi(ui)
        }
      }
      if (ui.pick && !ui.pick.startsWith('dir:')) await readSurface(cx, `file:${ui.pick}:1`, 'files', [ui.pick])
      return
    }
    case 'file':
      if (p.path) {
        const key = `file:${p.path}:${p.start ?? 1}`
        await readSurface(cx, key, 'files', [p.path, ...(p.start && p.start > 1 ? ['--start', String(p.start)] : [])])
        // a whole-file JSON transcript: a page of the turns thimble parses from the whole file, for its Transcript tab
        const page = await surfaceValue<Record<string, unknown>>(cx, key)
        if (page?.ok && wholeJson(page.value)) {
          const { key: tkey, args } = turnsRead(p)
          await readSurface(cx, tkey, 'turns', args)
        }
      }
      return
    case 'agent':
      if (p.thread) await readThread(cx, p.thread)
      return
    case 'thread':
    case 'threads':
      // the tree shows each thread's latest answer: every thread's chat is read (from where the last read stopped)
      await refreshThreads(cx)
      for (const t of (await cx.threads()).slice(-THREADS_READ)) await readThread(cx, t.id)
      // the one shown, though the list may not hold it yet (one just asked)
      if (p.view === 'thread' && p.thread && !(await cx.threads()).slice(-THREADS_READ).some(t => t.id === p.thread)) await readThread(cx, p.thread)
      if (p.view === 'thread' && p.thread && (await showingThread(cx, p.thread))) await markSeen(cx, p.thread)
      // the cards the shown thread made, drawn under its answers
      if (p.view === 'thread' && p.thread) {
        const tt = await cx.thread(p.thread)
        const ids = tt?.events.length ? [...new Set(threadOf(tt.meta, tt.events).turns.flatMap(t => t.cards ?? []))] : []
        if (ids.length) await loadCards(cx, ids)
      }
      return
    default:
  }
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
    ...(p.slug || p.label || p.path || p.agent ? { slug: String(p.slug || p.label || (p.path ? `${p.path}:${p.start ?? 1}` : '') || p.agent) } : {}),
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

/** Show `p` in the panel: its step on the panel's way, its data read, the pane opened with the keys. A pane opened
 *  from a click on a narrow terminal waits undrawn: the row above the prompt offers it (`pending`). `replace`: `p` takes
 *  the place of the step the panel shows, and back leads where it led (a line chosen in a file, a tab, a slide; the
 *  thread a new thread's form asked). */
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
  void loadPanel(cx, p).then(() => cx.bumpPanel())
  try {
    const title = paneTitle(p)
    rt.fittedFor = rt.termColumns
    const r = await cx.open({ id: PANEL, title, focus: true, columns: panelColumns() })
    await cx.setPending(r.isPlaced ? null : { title })
    // with a draft in the prompt the keys stay there (Claude Code keeps the person's typing)
    if (r.isPlaced && (await cx.promptText().catch(() => '')).trim()) cx.toast('the prompt holds a draft, so it keeps the keys: click the panel to use its keys')
    else if (r.isPlaced) giveKeys(cx, title, p.view === 'ask' ? ASK_FIELD : RELAY_PICK)
  } catch (err) {
    cx.log(`thimble-term: could not open the panel: ${String(err).slice(0, 200)}`)
  }
}

/** The panel asks for the keys once more a moment after it opened, once the press that opened it is over: an open from
 *  a press on the row above the prompt (the toast's `open ›`) is refused the keys while that row holds them (live check
 *  term-fix6, new quirk 4). Given them, its ring goes onto its list's keys (panel.tsx RELAY), which raises the
 *  `ui.focus` that lets its hint row name them (live check term-fix7, quirk 2: ↓ moved the ring to `show all threads`
 *  while the hint named ↑↓). Asked again while the prompt holds them over an empty composer, Claude Code gives them;
 *  else the panel's hint row says how to give them (panel.tsx endHints). */
function giveKeys(cx: Ctx, title: string, ringOn = RELAY_PICK): void {
  // `left`: how many more times the ring is asked onto the keys while the view that draws them may not be drawn yet;
  // `reopened`: the pane was opened again to take the keys from the prompt
  const ask = async (left: number, reopened: boolean) => {
    const pane = (await cx.panes()).find(p => p.id === PANEL)
    if (!pane?.isPlaced) return
    if (pane.isFocused !== false) {
      // the ring onto the list's keys (a ring there already stays, and the call says so); a view that draws none leaves
      // the ring where it is, off them. Neither raises a ui.focus (live check term-fix8, quirk 7)
      // a new thread's field likewise: an open of a pane that holds the keys already is no take, so its `autoFocus` puts
      // no ring there. Only a text field the panel draws keeps the ring from them; a button's ring (the hotkey pressed,
      // `t` for the threads) or a field the view no longer draws does not (live check term-fix9, quirks 1 and 12)
      if (rt.panelFocus !== ringOn && rt.fields.has(rt.panelFocus)) return
      if (await cx.focus(ringOn)) {
        if (rt.panelFocus !== ringOn) {
          rt.panelFocus = ringOn
          await cx.bumpPanel()
        }
      } else if (left > 0) cx.later(KEYS_AGAIN_MS, () => void ask(left - 1, reopened))
      return
    }
    if (reopened || (await cx.promptText().catch(() => '')).trim()) return
    const p = await cx.panel()
    await cx.open({ id: PANEL, title: p ? paneTitle(p) : title, focus: true, columns: panelColumns() }).catch(() => undefined)
    await cx.bumpPanel()
    cx.later(KEYS_AGAIN_MS, () => void ask(left, true))
  }
  cx.later(KEYS_AGAIN_MS, () => void ask(KEYS_TRIES - 1, false))
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
    rt.typeThrough = false
    rt.panelFocus = NO_RING
  }
  await cx.open({ id: PANEL, title: paneTitle(p), focus: true, columns: panelColumns() }).catch(() => undefined)
  await cx.bumpPanel()
  giveKeys(cx, paneTitle(p))
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
    case 'files':
      return 'Files'
    default:
      return p.title || 'thimble'
  }
}

export async function closePanel(cx: Ctx): Promise<void> {
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

/** A list (`labels`, `docs`) from the step it holds, as the path's list step opens it: in place of that step, back
 *  leading to the step (live check term-fix9, quirk 10: `l` pushed `home › documents › "…" › documents`). */
export async function openList(cx: Ctx, p: TermPanel): Promise<void> {
  const nav = (await cx.nav()) ?? NAV_EMPTY
  const at = nav.trail.findIndex(s => s.view === p.view)
  const keep = at >= 0 ? nav.trail.slice(0, at) : nav.trail.slice(0, -1)
  rt.navTo = { trail: [...keep, stepOf(p)], back: withBack(nav.back, nav.trail) }
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
  if (cited.size) void nameCards(cx, [...cited]).then(() => cx.bumpPanel())
}

/** The questions of these cards noted (noteQuestion), each read once, so that a citation of one names it: a card a
 *  thread's words cite, which no drawing reads. */
async function nameCards(cx: Ctx, ids: readonly string[]): Promise<void> {
  if (!rt.sc) return
  for (const id of ids) {
    rt.named.add(id)
    const got = await readState(cx, rt.sc, 'card', [id])
    const cell = got.ok ? cellOf(got.value) : null
    if (cell) noteQuestion(cell.id, cell.title)
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
  if (!rt.sc) return { error: 'thimble is not in terminal mode in this session' }
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
  if (!rt.sc) return { error: 'thimble is not in terminal mode in this session', queued: false }
  const got = await act(cx, rt.sc, 'thread-message', { thread, message })
  if (!got.ok) return { error: got.error, queued: false }
  await readThread(cx, thread)
  return { error: '', queued: (got.value as { queued?: unknown }).queued === true }
}

// ------------------------------------------------------------------------------------------------ labels

/** What the label panel changes of a label (`thimble act label`): its kind, its prompt (or pattern or code), its files,
 *  its values. */
export type LabelPatch = { kind?: string; body?: string; glob?: string; values?: string[] }

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
  if (!rt.sc) return 'thimble is not in terminal mode in this session'
  const got = await act(cx, rt.sc, 'label', { label: id, ...patch })
  await readSurface(cx, `label:${id}`, 'label', [id])
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

/** Run a label from its panel on a sample of `limit` records, or on every record (`limit` 0), with `thimble act
 *  label-run`, which answers once the run ends: the panel says `◌ labeling` meanwhile and the counts after. A code
 *  label's code runs only in main's Bash: main is asked to run the command the act gives. */
export async function runLabel(cx: Ctx, id: string, name: string, limit: number): Promise<void> {
  if (!rt.sc) return
  await labelSaid(cx, id, '', { limit, at: await cx.now() })
  const got = await actLong<{ deferred?: boolean; command?: string; summary?: { counts?: Record<string, number>; labeled?: number; failed?: number; message?: string | null; stopped?: boolean } }>(cx, rt.sc, 'label-run', { label: id, ...(limit ? { limit } : {}) })
  if (!got.ok) {
    await labelSaid(cx, id, `× ${got.error}`, null)
    return
  }
  if (got.value.deferred && got.value.command) {
    await cx.submit(`Run the code label "${name}" ${limit ? `on a sample of ${limit} records` : 'on every record'}, as I changed it in its panel. Run this with Bash: ${got.value.command}`)
    await labelSaid(cx, id, 'its code runs in main\'s Bash: main was asked to run it', null)
    return
  }
  const s = got.value.summary ?? {}
  const counts = Object.entries(s.counts ?? {}).map(([v, n]) => `${v} ${n.toLocaleString('en-US')}`).join(' · ')
  const failed = s.failed ? ` · ${plural(s.failed, 'record')} failed` : ''
  await readSurface(cx, `label:${id}`, 'label', [id])
  // the label cards that count it are read again
  for (const [card, lid] of rt.labelOf) if (lid === id) await loadCards(cx, [card])
  const how = s.stopped ? `stopped after ${(s.labeled ?? 0).toLocaleString('en-US')}` : `ran on ${limit ? `a sample of ${(s.labeled ?? limit).toLocaleString('en-US')}` : `all ${(s.labeled ?? 0).toLocaleString('en-US')}`}`
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
  if (!rt.sc) return 'thimble is not in terminal mode in this session'
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
  await openList(cx, { view: 'labels', title: 'Labels' })
  return ''
}

// ------------------------------------------------------------------------------------------------ the refresh loop

async function refreshAgents(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'agents')
  if (got.ok) await cx.setAgents(agentsOf(got.value))
}

async function refreshHome(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, 'home')
  if (!got.ok) return
  // the views and the rest home draws, which the `↳ view` rows read too
  await cx.setSurface('home-full', { ok: true, value: got.value })
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
const PANEL_AREAS: Record<string, Area[]> = { home: ['cards', 'labels', 'docs', 'chats', 'views', 'agents'], views: ['views'], labels: ['labels'], label: ['labels', 'cards'], docs: ['docs', 'agents'], doc: ['docs', 'cards', 'agents', 'chats'], card: ['cards', 'labels'], cite: ['cards'], threads: ['chats'], thread: ['chats'] }

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
      await loadCards(cx, ids)
    }
    do {
      rt.again = false
      const sig = await signature(cx, rt.sc)
      const areas = new Set<Area>(changed(rt.sig, sig))
      const first = rt.sig === null
      rt.sig = sig
      if (!areas.size) break
      const panel = await cx.panel()
      if (areas.has('cards') || areas.has('labels')) {
        const before = [...rt.shown]
        await refreshCards(cx, areas.has('labels'))
        if (!first) await recheckCards(cx, before)
        // the cards home lists, read again while home is not shown (a thread's fork made one): home opened next shows
        // them at once, not the list as it was when home last showed
        if (areas.has('cards') && !first && panel?.view !== 'home' && panel?.view !== 'label' && (await cx.surface('canvas'))) await readSurface(cx, 'canvas', 'cards', ['--since', iso(0)])
      }
      if (areas.has('chats') || areas.has('agents')) await refreshAgents(cx)
      if (areas.has('chats')) {
        await refreshThreads(cx)
        if (panel?.thread && (panel.view === 'thread' || panel.view === 'agent')) await readThread(cx, panel.thread)
      }
      if (areas.has('ui')) await followUi(cx, ui)
      if (first || areas.has('cards') || areas.has('labels') || areas.has('docs') || areas.has('chats') || areas.has('views') || areas.has('agents')) await refreshHome(cx)
      if (panel && !first) {
        if ((PANEL_AREAS[panel.view] ?? []).some(a => areas.has(a))) await loadPanel(cx, panel)
        await cx.bumpPanel()
      }
    } while (rt.again)
  } finally {
    rt.busy = false
  }
}
