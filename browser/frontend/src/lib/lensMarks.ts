// The lenses and their marks (server features/lenses.py). A lens reads what Claude wrote and marks passages: the
// built-in Explainers, Important details and Unverifiable, and the analyst's own checks; the page calls every lens a
// check. Each lens has a scope, the surfaces it reads (chat, cards, report), set through one route (setLens). A mark is
// shown where its lens is on and its surface is in scope, so a change of scope shows or hides marks at once.
//
// The chat's marks come with the chat's records (a `lens_marks` record after the answer it marks); a card's and the
// report's from GET /lens-marks. Everything here is read again on the stream's `lenses` and `lens_marks` records. (The
// citations `[words](#)` and their check are marks/, a feature of their own.)
import { useEffect, useSyncExternalStore } from 'react'
import { apiBase } from './browserKey'
import { bus } from './bus'
import { featureOn } from '../features'

export type Surface = 'chat' | 'cards' | 'report'
export const SURFACES: readonly Surface[] = ['chat', 'cards', 'report']
export const SURFACE_WORDS: Readonly<Record<Surface, string>> = { chat: 'Chat', cards: 'Cards', report: 'Report' }

export interface Lens {
  id: string
  name: string
  /** a viz family of tokens.css: teal, orange, pink, blue, green, gold, violet */
  color: string
  builtin: boolean
  on: boolean
  scope: Record<Surface, boolean>
  /** what it asks of every passage, as the sidebar shows it */
  question: string
  /** what it leaves where it finds something */
  leaves: string
  instructions: string | null
  /** how many marks it found on each surface, shown there or not */
  found: Record<Surface, number>
}

export interface Mark {
  id: string
  lens: string
  surface?: Surface
  /** the chat, the card's id, or `report` */
  where?: string
  term: string
  title?: string
  body: string
  here?: string
  ts?: string
}

/** A found mark as the sidebar lists it: with its place in words and whether its lens shows it there now. */
export interface FoundMark extends Mark {
  place: string
  shown: boolean
}

/** A lens's colors: the highlight's fill, its ink (swatch, name, underline), and the card's edge. */
export function lensColors(color: string): { fill: string; ink: string; edge: string } {
  const c = /^[a-z]+$/.test(color) ? color : 'teal'
  return { fill: `var(--viz-${c}-1)`, ink: `var(--viz-${c}-3)`, edge: `var(--viz-${c}-2)` }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : detail
    } catch {
      /* the status text stands */
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

const base = (ws: string) => `${apiBase()}/ws/${encodeURIComponent(ws)}`

export const lensApi = {
  lenses: (ws: string) => call<Lens[]>(`${base(ws)}/lenses`),
  found: (ws: string, id: string) => call<FoundMark[]>(`${base(ws)}/lenses/${encodeURIComponent(id)}/found`),
  marks: (ws: string, surface?: Surface) => call<{ marks: Mark[] }>(`${base(ws)}/lens-marks${surface ? `?surface=${surface}` : ''}`),
  /** the one route that turns a lens on or off, sets its scope, or changes an own check's question */
  set: (ws: string, id: string, patch: { on?: boolean; scope?: Partial<Record<Surface, boolean>>; instructions?: string }) =>
    call<Lens>(`${base(ws)}/lenses/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  add: (ws: string, name: string, instructions: string, scope?: Partial<Record<Surface, boolean>>) =>
    call<Lens>(`${base(ws)}/lenses`, { method: 'POST', body: JSON.stringify({ name, instructions, scope }) }),
  remove: (ws: string, id: string) => call<{ deleted: string }>(`${base(ws)}/lenses/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  read: (ws: string, body: { lens?: string; surfaces?: Surface[] }) => call<{ marks: number }>(`${base(ws)}/lenses/read`, { method: 'POST', body: JSON.stringify(body) }),
  dismiss: (ws: string, id: string) => call<{ ok: boolean }>(`${base(ws)}/lens-marks/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
}

// ---- the lenses of the workspace shown, one store for every place that draws a mark

let lensesOf: { ws: string; list: readonly Lens[] } = { ws: '', list: [] }
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((fn) => fn())

/** Read the lenses of `ws` again. */
export async function loadLenses(ws: string): Promise<readonly Lens[]> {
  try {
    const list = await lensApi.lenses(ws)
    lensesOf = { ws, list }
    changed()
  } catch {
    // the marks keep the lenses they had
  }
  return lensesOf.list
}

/** For a test: the lenses as given. */
export function setLenses(ws: string, list: readonly Lens[]): void {
  lensesOf = { ws, list }
  changed()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The lenses of `ws`, read once and again whenever they or their marks change. */
export function useLenses(ws: string): readonly Lens[] {
  useEffect(() => {
    if (!ws) return
    void loadLenses(ws)
    const offs = [bus.on('lenses', () => void loadLenses(ws)), bus.on('lensMarks', () => void loadLenses(ws))]
    return () => offs.forEach((f) => f())
  }, [ws])
  return useSyncExternalStore(subscribe, () => (lensesOf.ws === ws ? lensesOf.list : EMPTY), () => EMPTY)
}
const EMPTY: readonly Lens[] = []

/** Whether `lens` shows its marks on `surface`: the lenses feature and the lens are on, and the surface is in its
 * scope. A lens the page does not know yet shows (the server sent the mark, so it was shown there). Pure but for the
 * feature switch. */
export function lensShows(lenses: readonly Lens[], lens: string, surface: Surface): boolean {
  if (!featureOn('lenses')) return false
  const l = lenses.find((x) => x.id === lens)
  return !l || (l.on && !!l.scope[surface])
}

/** The marks of `marks` that show on `surface` now. Pure but for the feature switch. */
export function shownMarks<T extends Mark>(marks: readonly T[] | undefined, lenses: readonly Lens[], surface: Surface): T[] {
  return (marks ?? []).filter((m) => lensShows(lenses, m.lens, surface))
}

// the marks of one surface of one workspace (cards, report), read once for every place that draws them, and again on
// the stream's `lenses`, `lens_marks` and `cell` records
const surfaceMarks = new Map<string, readonly Mark[]>()
const surfaceUsers = new Map<string, number>()
const surfaceOffs = new Map<string, () => void>()

function readSurface(ws: string, surface: Surface): void {
  const key = `${ws}\u0000${surface}`
  lensApi
    .marks(ws, surface)
    .then((got) => {
      surfaceMarks.set(key, got.marks)
      changed()
    })
    .catch(() => undefined)
}

/** The marks GET /lens-marks gives for one surface (cards, report), shown there now. */
export function useSurfaceMarks(ws: string, surface: Surface): readonly Mark[] {
  const key = `${ws}\u0000${surface}`
  useEffect(() => {
    if (!ws) return
    surfaceUsers.set(key, (surfaceUsers.get(key) ?? 0) + 1)
    if (!surfaceOffs.has(key)) {
      readSurface(ws, surface)
      const offs = [bus.on('lenses', () => readSurface(ws, surface)), bus.on('lensMarks', () => readSurface(ws, surface)), bus.on('cell', () => readSurface(ws, surface))]
      surfaceOffs.set(key, () => offs.forEach((f) => f()))
    }
    return () => {
      const n = (surfaceUsers.get(key) ?? 1) - 1
      surfaceUsers.set(key, n)
      if (n <= 0) {
        surfaceOffs.get(key)?.()
        surfaceOffs.delete(key)
      }
    }
  }, [key, ws, surface])
  return useSyncExternalStore(subscribe, () => surfaceMarks.get(key) ?? EMPTY_MARKS, () => EMPTY_MARKS)
}
const EMPTY_MARKS: readonly Mark[] = []

/** Go to a mark where it stands: open its surface (the chat it is in, its card on the canvas, the report), bring its
 * words into view and flash them. The words carry `data-mark` (components/LensMark.tsx); they are waited for while the
 * surface draws. */
export function revealMark(m: Pick<Mark, 'id' | 'surface' | 'where'>): void {
  if (m.surface === 'chat') bus.emit('openChat', { chatId: m.where || 'main' })
  else if (m.surface === 'cards' && m.where) bus.emit('openRef', { ref: `card:${m.where}` })
  else if (m.surface === 'report') bus.emit('showTab', { tab: 'report' })
  const t0 = Date.now()
  const find = () => {
    const el = document.querySelector<HTMLElement>(`[data-mark="${CSS.escape(m.id)}"]`)
    if (!el) {
      if (Date.now() - t0 < 4000) window.setTimeout(find, 120)
      return
    }
    keepInView(el)
  }
  window.setTimeout(find, 60)
}

/** Where an element sits in what it scrolls with: its top plus every scroll above it. A scroll leaves it alone; a
 * layout that moves the element changes it. */
function placeOf(el: HTMLElement): number {
  let y = el.getBoundingClientRect().top + window.scrollY
  for (let a = el.parentElement; a; a = a.parentElement) y += a.scrollTop
  return y
}

const LET_GO = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

/** Bring an element to the middle of its place, and keep it there while the place lays out (a tab that just opened
 * draws its figures after its text, which pushes the words below them down); flash it once it stays put. It lets go
 * after a few seconds, or as soon as the person scrolls, clicks or types. */
export function keepInView(el: HTMLElement): void {
  const t0 = performance.now()
  let at = placeOf(el)
  let still = t0
  let flashed = false
  let done = false
  const stop = () => {
    done = true
    for (const t of LET_GO) window.removeEventListener(t, stop, true)
  }
  for (const t of LET_GO) window.addEventListener(t, stop, { capture: true, passive: true })
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const tick = () => {
    if (done || !el.isConnected) return stop()
    const now = performance.now()
    const y = placeOf(el)
    if (Math.abs(y - at) > 1) {
      at = y
      still = now
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (!flashed && now - still > 250) {
      flashed = true
      el.classList.remove('mark-flash')
      void el.offsetWidth
      el.classList.add('mark-flash')
      window.setTimeout(() => el.classList.remove('mark-flash'), 1800)
    }
    if (now - t0 > 5000 || (flashed && now - t0 > 2500)) return stop()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
