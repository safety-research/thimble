// What main's chat draws under its rows, kept in the workspace so a resumed session draws it again. Claude Code keeps a
// row's uuid across `--continue` and `--resume`, and the drawings stand under rows by that uuid (their `requestId`), but
// the plugin's state lives only as long as its process. So each row's cards, its answer's footer, its `↳ thread` rows
// and its `↳ view` rows are written to `<workspace>/terminal/chat.json` as they are set, and read back into the state
// when the session starts. The file is the renderer's own: browser mode does not read it.
//
// No `$` here: register.tsx reads and writes through the context (hooks/ctx.ts).
import type { ChatSignal, TermAnswer, TermHome } from '../types'
import type { Ctx } from './ctx'

/** What the file is read and written with. */
type Io = Pick<Ctx, 'read' | 'write'>

/** What one row of main's chat carries under it; `writer`, the writer run its `↳ The writer …` line reports (its chat)
 *  and whether it said that run's end first. */
export type KeptRow = { cards?: string[]; answer?: TermAnswer; threads?: ChatSignal[]; views?: string[]; writer?: { chat: string; first: boolean } }

/** The file: each row's drawings by its uuid, oldest first, the last turn's text and cards (`/thimble cite` and
 *  `/thimble card` open them by number), and what the workspace held when home was last seen (`seen`), so the row above
 *  the prompt counts what came after across a relaunch. */
export type Kept = { rows: Record<string, KeptRow>; last: { reply: string; cards: string[] }; seen?: TermHome }

/** The workspace file, under the workspace folder. */
export const KEPT_FILE = 'terminal/chat.json'
/** The rows kept, the newest. */
const ROWS_MAX = 400

export const keptEmpty = (): Kept => ({ rows: {}, last: { reply: '', cards: [] } })

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

function signalsOf(v: unknown): ChatSignal[] {
  return Array.isArray(v) ? v.filter((s): s is ChatSignal => Boolean(s) && typeof (s as ChatSignal).thread === 'string' && typeof (s as ChatSignal).turn === 'number').map(s => ({ thread: s.thread, turn: s.turn })) : []
}

function answerOf(v: unknown): TermAnswer | undefined {
  const a = v as Partial<TermAnswer> | null | undefined
  if (!a || typeof a !== 'object' || typeof a.text !== 'string') return undefined
  return { rows: strings(a.rows), text: a.text, cards: strings(a.cards) }
}

/** The file's text as Kept: lenient, a part it cannot read is left out. */
export function parseKept(raw: string): Kept {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return keptEmpty()
  }
  const o = (v ?? {}) as { rows?: unknown; last?: { reply?: unknown; cards?: unknown } }
  const rows: Record<string, KeptRow> = {}
  for (const [k, r] of Object.entries(o.rows && typeof o.rows === 'object' ? (o.rows as Record<string, unknown>) : {})) {
    const x = (r ?? {}) as Record<string, unknown>
    const row: KeptRow = {}
    const cards = strings(x.cards)
    const threads = signalsOf(x.threads)
    const views = strings(x.views)
    const answer = answerOf(x.answer)
    const writer = x.writer as { chat?: unknown; first?: unknown } | null | undefined
    if (writer && typeof writer === 'object' && typeof writer.chat === 'string' && writer.chat) row.writer = { chat: writer.chat, first: writer.first === true }
    if (cards.length) row.cards = cards
    if (threads.length) row.threads = threads
    if (views.length) row.views = views
    if (answer) row.answer = answer
    if (Object.keys(row).length) rows[k] = row
  }
  const seen = seenOf((o as { seen?: unknown }).seen)
  return { rows, last: { reply: typeof o.last?.reply === 'string' ? o.last.reply : '', cards: strings(o.last?.cards) }, ...(seen ? { seen } : {}) }
}

function seenOf(v: unknown): TermHome | undefined {
  const o = v as Partial<Record<keyof TermHome, unknown>> | null | undefined
  if (!o || typeof o !== 'object') return undefined
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return { cards: n(o.cards), labels: n(o.labels), docs: n(o.docs), threads: n(o.threads), views: n(o.views), files: n(o.files), at: n(o.at) }
}

/** The file's text: the newest ROWS_MAX rows. */
export function keptJson(k: Kept): string {
  const keys = Object.keys(k.rows)
  const rows = Object.fromEntries(keys.slice(Math.max(0, keys.length - ROWS_MAX)).map(key => [key, k.rows[key]!]))
  return JSON.stringify({ rows, last: k.last, ...(k.seen ? { seen: k.seen } : {}) })
}

/** `kept` with one row's part set (a row moves to the end, the newest). */
export function withRow(k: Kept, row: string, part: KeptRow): Kept {
  const rows = { ...k.rows }
  const cur = rows[row] ?? {}
  delete rows[row]
  rows[row] = { ...cur, ...part }
  return { ...k, rows }
}

// what this process holds of the file, and the writes in order
let kept: Kept = keptEmpty()
let writes: Promise<void> = Promise.resolve()

function pathOf(ws: string): string {
  return `${ws.replace(/\/+$/, '')}/${KEPT_FILE}`
}

/** The file as earlier sessions left it, merged under what this process set already (a reload keeps its own). */
export async function loadKept(cx: Io, ws: string): Promise<Kept> {
  const got = parseKept(await cx.read(pathOf(ws)).catch(() => ''))
  const seen = kept.seen ?? got.seen
  kept = { rows: { ...got.rows, ...kept.rows }, last: kept.last.reply || kept.last.cards.length ? kept.last : got.last, ...(seen ? { seen } : {}) }
  return kept
}

/** What the workspace held when home was last seen, kept. */
export async function keepSeen(cx: Io, ws: string, seen: TermHome): Promise<void> {
  const k = kept.seen
  if (k && (Object.keys(seen) as (keyof TermHome)[]).every(x => k[x] === seen[x])) return
  kept = { ...kept, seen }
  await save(cx, ws)
}

/** What the workspace held when home was last seen, as the file read at the session's start (or this process) keeps it. */
export function keptSeen(): TermHome | null {
  return kept.seen ?? null
}

/** One row's part kept, and the file written (one write at a time, in order). */
export async function keepRow(cx: Io, ws: string, row: string, part: KeptRow): Promise<void> {
  if (!row) return
  kept = withRow(kept, row, part)
  await save(cx, ws)
}

/** The last turn's text and cards kept. */
export async function keepLast(cx: Io, ws: string, reply: string, cards: string[]): Promise<void> {
  kept = { ...kept, last: { reply, cards } }
  await save(cx, ws)
}

async function save(cx: Io, ws: string): Promise<void> {
  const text = keptJson(kept)
  writes = writes.then(() => cx.write(pathOf(ws), text)).catch(() => undefined)
  await writes
}

/** For the tests: what this process holds, and a fresh start. */
export function keptNow(): Kept {
  return kept
}
export function resetKept(): void {
  kept = keptEmpty()
  writes = Promise.resolve()
}
