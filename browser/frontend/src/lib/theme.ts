// The theme: a paper (Warm, the default; Neutral; Dark) and an accent (iris by default), chosen in the top bar and kept
// in localStorage (`thimble:paper`, `thimble:accent`), applied as `data-paper`, `data-accent` and `data-theme` on
// <html> for styles/tokens.css. Importing this module applies the stored theme before the first paint.
import { useSyncExternalStore } from 'react'

export type Paper = 'warm' | 'neutral' | 'dark'
export type Accent = 'pink' | 'orange' | 'yellow' | 'lime' | 'blue' | 'iris' | 'graphite'
export type Resolved = 'light' | 'dark'

export const PAPER_KEY = 'thimble:paper'
export const ACCENT_KEY = 'thimble:accent'
/** the key the light/dark toggle used before the papers; a stored `dark` still opens on Dark */
export const LEGACY_THEME_KEY = 'thimble:theme'

export const PAPERS: readonly { id: Paper; label: string }[] = [
  { id: 'warm', label: 'Warm' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'dark', label: 'Dark' },
]

/** The seven accents in the order the popover shows them, around the wheel. `hex` is the fill (tokens.css carries it
 * too); the swatch shows it. */
export const ACCENTS: readonly { id: Accent; hex: string }[] = [
  { id: 'pink', hex: '#d6336c' },
  { id: 'orange', hex: '#e0590c' },
  { id: 'yellow', hex: '#f2b705' },
  { id: 'lime', hex: '#74b816' },
  { id: 'blue', hex: '#1876d1' },
  { id: 'iris', hex: '#5135ff' },
  { id: 'graphite', hex: '#3d3b37' },
]

export const DEFAULT_PAPER: Paper = 'warm'
export const DEFAULT_ACCENT: Accent = 'iris'

const isPaper = (v: unknown): v is Paper => PAPERS.some((p) => p.id === v)
const isAccent = (v: unknown): v is Accent => ACCENTS.some((a) => a.id === v)

/** The paper from what storage holds: a stored paper, else Dark when the legacy key holds `dark`, else Warm. Pure. */
export function readPaper(stored: string | null, legacy: string | null = null): Paper {
  if (isPaper(stored)) return stored
  return legacy === 'dark' ? 'dark' : DEFAULT_PAPER
}

/** The accent from what storage holds, iris when nothing valid is stored. Pure. */
export const readAccent = (stored: string | null): Accent => (isAccent(stored) ? stored : DEFAULT_ACCENT)

/** Whether a paper paints light or dark. Pure. */
export const paperScheme = (paper: Paper): Resolved => (paper === 'dark' ? 'dark' : 'light')

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage is a convenience; the attribute still applies for this page */
  }
}

export const getPaper = (): Paper => readPaper(read(PAPER_KEY), read(LEGACY_THEME_KEY))
export const getAccent = (): Accent => readAccent(read(ACCENT_KEY))
export const getResolved = (): Resolved => paperScheme(getPaper())

/** Write the attributes tokens.css reads. */
export function applyTheme(paper: Paper = getPaper(), accent: Accent = getAccent()): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.setAttribute('data-paper', paper)
  el.setAttribute('data-accent', accent)
  el.setAttribute('data-theme', paperScheme(paper))
}

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

export function setPaper(paper: Paper): void {
  write(PAPER_KEY, paper)
  applyTheme(paper, getAccent())
  notify()
}

export function setAccent(accent: Accent): void {
  write(ACCENT_KEY, accent)
  applyTheme(getPaper(), accent)
  notify()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // another tab changed the theme: follow it
  const onStorage = (e: StorageEvent) => {
    if (e.key === PAPER_KEY || e.key === ACCENT_KEY) {
      applyTheme()
      fn()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

export interface ThemeState {
  paper: Paper
  accent: Accent
  /** light or dark, for a value that must be picked in JS (a chart's scheme, an iframe's colour scheme) */
  resolved: Resolved
  /** changes whenever the paper or the accent does: a memo that reads tokens at build time (a chart, a sandboxed
   * frame) keys on it, so it rebuilds in the new colours */
  key: string
  setPaper: (p: Paper) => void
  setAccent: (a: Accent) => void
}

/** The chosen paper and accent; re-renders when either changes. */
export function useTheme(): ThemeState {
  const paper = useSyncExternalStore(subscribe, getPaper, () => DEFAULT_PAPER)
  const accent = useSyncExternalStore(subscribe, getAccent, () => DEFAULT_ACCENT)
  return { paper, accent, resolved: paperScheme(paper), key: `${paper}:${accent}`, setPaper, setAccent }
}

applyTheme()
