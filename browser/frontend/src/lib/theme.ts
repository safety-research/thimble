// The theme: a paper (Warm, the default; Neutral; Dark), an accent (iris by default) and a figure style (thimble's own
// by default; Blog; Paper), chosen in the top bar and kept in localStorage (`thimble:paper`, `thimble:accent`,
// `thimble:figures`), applied as `data-paper`, `data-accent`, `data-theme` and `data-figures` on <html> for
// styles/tokens.css. Importing this module applies the stored theme before the first paint.
import { useSyncExternalStore } from 'react'

export type Paper = 'warm' | 'neutral' | 'dark'
export type Accent = 'pink' | 'orange' | 'yellow' | 'lime' | 'blue' | 'iris' | 'graphite'
export type Resolved = 'light' | 'dark'
/** How the charts are drawn: thimble's own style, or a figure style for a document that leaves the workbench, Blog
 * (blogpost-figure's) or Paper (paper-figure's). The paper and the accent keep their jobs for the page. */
export type FigureStyle = 'thimble' | 'blog' | 'paper'

export const PAPER_KEY = 'thimble:paper'
export const ACCENT_KEY = 'thimble:accent'
export const FIGURES_KEY = 'thimble:figures'

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

export const FIGURE_STYLES: readonly { id: FigureStyle; label: string }[] = [
  { id: 'thimble', label: 'thimble' },
  { id: 'blog', label: 'Blog' },
  { id: 'paper', label: 'Paper' },
]

export const DEFAULT_PAPER: Paper = 'warm'
export const DEFAULT_ACCENT: Accent = 'iris'
export const DEFAULT_FIGURES: FigureStyle = 'thimble'

const isPaper = (v: unknown): v is Paper => PAPERS.some((p) => p.id === v)
const isAccent = (v: unknown): v is Accent => ACCENTS.some((a) => a.id === v)
const isFigures = (v: unknown): v is FigureStyle => FIGURE_STYLES.some((f) => f.id === v)

/** The paper from what storage holds: a stored paper, else Warm. Pure. */
export const readPaper = (stored: string | null): Paper => (isPaper(stored) ? stored : DEFAULT_PAPER)

/** The accent from what storage holds, iris when nothing valid is stored. Pure. */
export const readAccent = (stored: string | null): Accent => (isAccent(stored) ? stored : DEFAULT_ACCENT)

/** The figure style from what storage holds, thimble's own when nothing valid is stored. Pure. */
export const readFigures = (stored: string | null): FigureStyle => (isFigures(stored) ? stored : DEFAULT_FIGURES)

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

export const getPaper = (): Paper => readPaper(read(PAPER_KEY))
export const getAccent = (): Accent => readAccent(read(ACCENT_KEY))
export const getFigures = (): FigureStyle => readFigures(read(FIGURES_KEY))
export const getResolved = (): Resolved => paperScheme(getPaper())

/** Write the attributes tokens.css reads. */
export function applyTheme(paper: Paper = getPaper(), accent: Accent = getAccent(), figures: FigureStyle = getFigures()): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.setAttribute('data-paper', paper)
  el.setAttribute('data-accent', accent)
  el.setAttribute('data-theme', paperScheme(paper))
  el.setAttribute('data-figures', figures)
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

export function setFigures(figures: FigureStyle): void {
  write(FIGURES_KEY, figures)
  applyTheme(getPaper(), getAccent(), figures)
  notify()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // another tab changed the theme: follow it
  const onStorage = (e: StorageEvent) => {
    if (e.key === PAPER_KEY || e.key === ACCENT_KEY || e.key === FIGURES_KEY) {
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
  figures: FigureStyle
  /** light or dark, for a value that must be picked in JS (a chart's scheme, an iframe's colour scheme) */
  resolved: Resolved
  /** changes whenever the paper, the accent or the figure style does: a memo that reads tokens at build time (a chart,
   * a sandboxed frame) keys on it, so it rebuilds in the new colours */
  key: string
  setPaper: (p: Paper) => void
  setAccent: (a: Accent) => void
  setFigures: (f: FigureStyle) => void
}

/** The chosen paper, accent and figure style; re-renders when any of them changes. */
export function useTheme(): ThemeState {
  const paper = useSyncExternalStore(subscribe, getPaper, () => DEFAULT_PAPER)
  const accent = useSyncExternalStore(subscribe, getAccent, () => DEFAULT_ACCENT)
  const figures = useSyncExternalStore(subscribe, getFigures, () => DEFAULT_FIGURES)
  return { paper, accent, figures, resolved: paperScheme(paper), key: `${paper}:${accent}:${figures}`, setPaper, setAccent, setFigures }
}

applyTheme()
