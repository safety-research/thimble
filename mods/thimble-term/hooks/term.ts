// thimble-term's runtime: what it read last and the moves that read thimble again or change what the panel shows.
// register.tsx wires these to Claude Code's events and hands each the context of its hook (hooks/ctx.ts); reply.tsx and
// panel.tsx draw.
//
// Nothing here writes the workspace: a read is `thimble state`, a change is `thimble act` (hooks/data.ts).
import type { ChatNav, ChatNavStep, ChatSignal, TermCard, TermFilesUi, TermLabelUi, TermPanel, TermThreadRow } from '../types'
import { busyWords, cardOfCell, linksOf, printed } from './cell'
import type { ThimbleCell, ThimbleLabel } from './cell'
import type { CardData, CardLabel } from './draw'
import type { Ctx, SurfaceGot } from './ctx'
import { act, actLong, changed, readState, signature } from './data'
import type { Area, Scope, Signature } from './data'
import { cid, citations } from './lib'
import type { Citation } from './lib'
import { agentsOf, cellOf, cellsOf, chatOf, docUnits, homeOf, labelIdOf, labelOf, resolutionOf, threadOf, threadRowsOf, uiRecordsOf, verdictOf } from './model'
import { NAV_EMPTY, backTarget, moved, nextTrail } from './nav'
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
  sc: null as Scope | null,
  sig: null as Signature | null,
  busy: false,
  again: false,
  turn: null as Turn | null,
  // the latest row of main's chat a line can stand under (signal.ts isAnchor)
  anchor: '',
  termColumns: 0,
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
  }
}

/** A label as the cards that read it draw it, read once until the labels change. */
async function labelFor(cx: Ctx, id: string): Promise<ThimbleLabel | null> {
  if (rt.labelRead.has(id)) return rt.labelRead.get(id)!
  if (!rt.sc) return null
  const got = await readState(cx, rt.sc, 'label', [id])
  const l = got.ok ? labelOf(got.value) : null
  rt.labelRead.set(id, l)
  return l
}

/** The label rows of a card that read labels (views/SPEC.md, "Cards", the label row): each label's name, its values in
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
  for (const c of cs) await cx.setVerdict(cid(c.raw), verdictOf(c, resolutionOf(got.value, c.ref), at))
}

/** The verdicts of the cards' takeaways checked again, and of every citation of a card's value seen anywhere (main's
 *  prose, a thread's answer, a document): a card ran again, its cell holds new values, so a stale one turns red. */
async function recheckCards(cx: Ctx, ids: readonly string[]): Promise<void> {
  const cs: Citation[] = []
  for (const id of ids) {
    const card = await cx.card(id)
    if (card) cs.push(...citations(card.takeaway))
  }
  for (const m of rt.cardCites.values()) cs.push(...m.values())
  if (cs.length) await resolveCitations(cx, cs)
}

// ------------------------------------------------------------------------------------------------ what the panel shows

/** A surface the panel reads, under the key the panel names it by. */
export async function readSurface(cx: Ctx, key: string, surface: string, args: readonly string[] = []): Promise<void> {
  if (!rt.sc) return
  const got = await readState(cx, rt.sc, surface, args)
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
      await readSurface(cx, 'home-full', 'home')
      await readSurface(cx, 'labels', 'labels')
      await readSurface(cx, 'docs', 'docs')
      await readSurface(cx, 'canvas', 'cards', ['--since', iso(0)])
      await readSurface(cx, 'files', 'files')
      await refreshThreads(cx)
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
        await readSurface(cx, `doc:${p.slug}`, 'doc', [p.slug])
        const doc = await surfaceValue<Record<string, unknown>>(cx, `doc:${p.slug}`)
        const ids = doc?.ok ? docUnits(doc.value).units.flatMap(s => (s.figures ?? []).map(f => String(f.cell ?? '').replace(/^(?:card|cell):/, ''))).filter(Boolean) : []
        await loadCards(cx, ids)
      }
      return
    case 'files': {
      await readSurface(cx, 'files', 'files')
      // the chosen file's first lines, shown under the list
      const pick = (await cx.filesUi()).pick
      if (pick) await readSurface(cx, `file:${pick}:1`, 'files', [pick])
      return
    }
    case 'file':
      if (p.path) await readSurface(cx, `file:${p.path}:${p.start ?? 1}`, 'files', [p.path, ...(p.start && p.start > 1 ? ['--start', String(p.start)] : [])])
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
      return
    default:
  }
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

/** Show `p` in the panel: its step on the panel's way, its data read, the pane opened with the keys. A pane opened
 *  from a click on a narrow terminal waits undrawn: the row above the prompt offers it (`pending`). */
export async function openPanel(cx: Ctx, p: TermPanel): Promise<void> {
  const step = stepOf(p)
  let nav = rt.navTo
  rt.navTo = null
  if (!nav) {
    const cur = (await cx.nav()) ?? NAV_EMPTY
    nav = moved(cur, nextTrail(cur.trail, step, await inPanel(cx)))
  }
  rt.navFrom = null
  await cx.setNav(nav)
  await cx.setPanel(p)
  void loadPanel(cx, p).then(() => cx.bumpPanel())
  try {
    const r = await cx.open({ id: PANEL, title: p.title || 'thimble', focus: true, columns: panelColumns() })
    await cx.setPending(r.isPlaced ? null : { title: p.title })
  } catch (err) {
    cx.log(`thimble-term: could not open the panel: ${String(err).slice(0, 200)}`)
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

export async function navBack(cx: Ctx): Promise<void> {
  const to = backTarget((await cx.nav()) ?? NAV_EMPTY)
  if (to) await navGo(cx, to)
}

export async function openHome(cx: Ctx): Promise<void> {
  await openPanel(cx, { view: 'home', title: 'Home' })
  // what home holds now is seen: the row above the prompt shows only what arrives after
  const home = await cx.home()
  if (home) await cx.setHomeSeen(home)
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
export async function startThread(cx: Ctx, anchor: string | null, anchorText: string, message: string, more: { parent?: string; element?: string } = {}): Promise<{ id: string } | { error: string }> {
  if (!rt.sc) return { error: 'thimble is not in terminal mode in this session' }
  const got = await act(cx, rt.sc, 'thread', { anchor, message, ...(anchorText ? { anchor_text: anchorText } : {}), ...(more.parent ? { parent: more.parent } : {}), ...(more.element ? { element: more.element } : {}) })
  if (!got.ok) return { error: got.error }
  const v = got.value as { thread?: unknown; id?: unknown; meta?: { id?: unknown } }
  const id = String(v.thread ?? v.id ?? v.meta?.id ?? '')
  if (!id) return { error: 'thimble made no thread' }
  rt.answers.set(id, 0)
  await refreshThreads(cx)
  return { id }
}

export async function threadMessage(cx: Ctx, thread: string, message: string): Promise<string> {
  if (!rt.sc) return 'thimble is not in terminal mode in this session'
  const got = await act(cx, rt.sc, 'thread-message', { thread, message })
  if (!got.ok) return got.error
  await readThread(cx, thread)
  return ''
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
  const got = await actLong<{ deferred?: boolean; command?: string; summary?: { counts?: Record<string, number>; labeled?: number; failed?: number; message?: string | null } }>(cx, rt.sc, 'label-run', { label: id, ...(limit ? { limit } : {}) })
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
  await labelSaid(cx, id, `ran on ${limit ? `a sample of ${(s.labeled ?? limit).toLocaleString('en-US')}` : `all ${(s.labeled ?? 0).toLocaleString('en-US')}`}${counts ? `: ${counts}` : ''}${failed}`, null)
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
  // the session's first count is what was there already: the row above the prompt shows only what comes after
  if (home && !(await cx.homeSeen())) await cx.setHomeSeen(home)
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
const PANEL_AREAS: Record<string, Area[]> = { home: ['cards', 'labels', 'docs', 'chats'], labels: ['labels'], label: ['labels', 'cards'], docs: ['docs'], doc: ['docs', 'cards'], card: ['cards', 'labels'], cite: ['cards'], threads: ['chats'], thread: ['chats'] }

/** One pass: what changed in the workspace since the last pass, read again where some drawing shows it. */
export async function tick(cx: Ctx, ui: UiApply): Promise<void> {
  if (!rt.sc) return
  if (rt.busy) {
    rt.again = true
    return
  }
  rt.busy = true
  try {
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
      }
      if (areas.has('chats') || areas.has('agents')) await refreshAgents(cx)
      if (areas.has('chats')) {
        await refreshThreads(cx)
        if (panel?.thread && (panel.view === 'thread' || panel.view === 'agent')) await readThread(cx, panel.thread)
      }
      if (areas.has('ui')) await followUi(cx, ui)
      if (first || areas.has('cards') || areas.has('labels') || areas.has('docs') || areas.has('chats')) await refreshHome(cx)
      if (panel && !first) {
        if ((PANEL_AREAS[panel.view] ?? []).some(a => areas.has(a))) await loadPanel(cx, panel)
        await cx.bumpPanel()
      }
    } while (rt.again)
  } finally {
    rt.busy = false
  }
}
