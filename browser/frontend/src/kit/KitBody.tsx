// The body of a card drawn by a program (kind `program`), as the terminal plugin draws its cards: the drawing the
// server kept with the card's run (canvas.KIT_MIME), drawn by svg.js in the page's theme, scaled to the card's width. A part
// opens what it stands for, its records (`ref` or `refs`), in the Files tab. A knob's ◂ or ▸, or a part whose presses
// the program answers (k.on 'press'), runs the program again in the page's sandbox (sandbox.ts) with the new state, and
// the card draws what comes back; a press whose handler asks (k.ask) opens a thread about that part. Each part carries
// `data-anchor` card:<id>#<part id>, so a ⌘-click asks about it, and a citation of it names it.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { bus } from '../lib/bus'
import { purifySvg } from '../lib/sanitize'
import { teleport } from '../lib/teleport'
import { useTheme } from '../lib/theme'
import type { Cell } from '../lib/types'
import { knobOf, turn } from './knobs.js'
import { programSandbox } from './sandbox'
import { approxMeasure, canvasMeasure, renderSvg, type Measure } from './svg.js'
import { KIT_MIME, type Drawing, type KitRun } from './types'

/** The drawing a program card's last run kept, or null for a card with none. Pure. */
export function kitRunOf(cell: Pick<Cell, 'outputs'>): KitRun | null {
  for (const o of [...(cell.outputs ?? [])].reverse()) {
    const kit = (o as Record<string, unknown>)[KIT_MIME] as KitRun | undefined
    if (kit && typeof kit === 'object' && kit.drawing) return kit
  }
  return null
}

/** What a part opens: its record, or the first of its records. Pure. */
export function partRef(meta: Record<string, unknown>): string | null {
  if (typeof meta.ref === 'string' && meta.ref) return meta.ref
  const many = Array.isArray(meta.refs) ? meta.refs : Array.isArray(meta.ref) ? meta.ref : null
  const first = many?.find((x): x is string => typeof x === 'string' && !!x)
  return first ?? null
}

/** Whether the drawing's program answers a press on part `id`. Pure. */
export const takesPress = (d: Drawing, id: string): boolean => (d.on ?? []).some((h) => h.name === `press:${id}` || h.name === 'press')

// a column is CW pixels, which keeps the toolkit's proportions at the page's type size (svg.js); the server draws a
// card at the canvas's width in columns (canvas.DRAW_W), and a narrower place scales the drawing down
const CW = 7.8

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// each tone of the toolkit as thimble's charts color it (styles/tokens.css): the inks, the axis and the gridlines, the
// series (the accent's family first), the status colors and the card's own surface. A tone with `-faint` is its color
// a third of the way from the card's surface, as the palette makes it.
const TONE_TOKENS: Record<string, string> = {
  ink: '--viz-ink-1', dim: '--viz-label', rule: '--viz-axis', axis: '--viz-axis', grid: '--viz-grid', unseen: '--viz-ink-4',
  accent: '--viz-highlight', good: '--status-positive', bad: '--status-negative', warn: '--status-warning',
  c1: '--viz-1', c2: '--viz-2', c3: '--viz-3', c4: '--viz-4', c5: '--viz-5', c6: '--viz-6',
  paper: '--surface-card', hover: '--surface-hover', select: '--accent-soft',
}

/** The page's color of each tone, read from its tokens now (a light or dark page, its accent), or null where the page
 *  has no tokens (tests), so the drawing keeps the plugin's palette. */
export function themeColors(): ((tone: string) => string | null) | null {
  if (typeof document === 'undefined' || !document.body || typeof getComputedStyle !== 'function') return null
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const read = (expr: string): string | null => {
    probe.style.color = ''
    probe.style.color = expr
    const v = probe.style.color ? getComputedStyle(probe).color : ''
    return v && !v.includes('var(') ? v : null
  }
  const out = new Map<string, string>()
  try {
    for (const [tone, name] of Object.entries(TONE_TOKENS)) {
      const v = read(`var(${name})`)
      if (!v) continue
      out.set(tone, v)
      const faint = read(`color-mix(in srgb, var(${name}) 34%, var(--surface-card))`)
      if (faint) out.set(`${tone}-faint`, faint)
    }
  } finally {
    probe.remove()
  }
  // a page without the tokens (no stylesheet) reads every token as nothing: the palette draws then
  if (!out.has('ink')) return null
  return (tone) => out.get(tone) ?? null
}

/** themeColors, read again when the page's theme or accent changes. */
function useThemeColors(resolved: string) {
  const [colors, setColors] = useState(themeColors)
  useEffect(() => {
    const again = () => setColors(() => themeColors())
    // the theme's attributes are set after the page renders: read the tokens once they apply
    const raf = requestAnimationFrame(again)
    const watch = new MutationObserver(again)
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-paper', 'data-accent', 'class'] })
    return () => {
      cancelAnimationFrame(raf)
      watch.disconnect()
    }
  }, [resolved])
  return colors
}

/** The page's measure of type: the canvas's metrics where there is a canvas, else svg.js's estimate (tests). */
function pageMeasure(): Measure {
  try {
    if (typeof document !== 'undefined' && document.createElement('canvas').getContext('2d')) return canvasMeasure(document)
  } catch {
    // no canvas: the estimate below
  }
  return approxMeasure
}

export function KitBody({ cell, width }: { cell: Cell; width?: number }) {
  const run = kitRunOf(cell)
  const { resolved } = useTheme()
  const colors = useThemeColors(resolved)
  // what the analyst turned or pressed, for this run of the card: a new run draws from its own drawing again
  const [live, setLive] = useState<{ drawing: Drawing; state: Record<string, unknown> } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setLive(null), [run])
  // a place much narrower than the drawing (an answer's card in the chat) draws the program again at its own width in
  // columns, as the terminal draws a card at the width it has, rather than shrinking the type
  const fitW = width && run ? Math.max(32, Math.floor(width / CW)) : null
  useEffect(() => {
    if (!run || !fitW || fitW >= (run.w || run.drawing?.w || 0) * 0.8) return
    let alive = true
    programSandbox()
      .run(String(cell.program ?? ''), run.data, { w: fitW, state: {}, title: cell.title, id: cell.id })
      .then((d) => alive && setLive({ drawing: d, state: (d.state as Record<string, unknown> | undefined) ?? {} }))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [run, fitW, cell.program, cell.title, cell.id])
  const measure = useMemo(pageMeasure, [])
  const drawing = live?.drawing ?? run?.drawing ?? null
  const rendered = useMemo(
    () => (drawing ? renderSvg(drawing, { cw: CW, measure, theme: resolved, color: colors, selected, hover }) : null),
    [drawing, measure, resolved, colors, selected, hover],
  )
  if (!run || !drawing || !rendered) return null
  const labels = new Map(rendered.regions.map((r) => [r.id, String(r.meta.label ?? r.id)]))
  // the drawing's words are the model's and the folder's: svg.js escapes them, and the markup is sanitized as every
  // inlined SVG is (lib/sanitize purifySvg, which drops its <style>: canvas.css sets the drawing's type instead)
  const svg = purifySvg(rendered.svg.replace(/data-region="([^"]*)"/g, (m, id: string) => `${m} data-anchor="${attr(`card:${cell.id}#${id}`)}" data-anchor-text="${attr(labels.get(id) ?? id)}"`))
  const again = (state: Record<string, unknown>, event?: Record<string, unknown>, el?: HTMLElement | null) =>
    void programSandbox()
      .run(String(cell.program ?? ''), run.data, { w: run.w || drawing.w, state, event, title: cell.title, id: cell.id })
      .then((d) => {
        setLive({ drawing: d, state: (d.state as Record<string, unknown> | undefined) ?? state })
        if (d.ask && el) bus.emit('askAbout', { el })
      })
  const regionAt = (e: MouseEvent<HTMLElement>) => {
    const t = (e.target as Element).closest?.('[data-region]') as HTMLElement | null
    const id = t?.getAttribute('data-region') ?? null
    return { el: t, region: id ? rendered.regions.find((r) => r.id === id) ?? null : null }
  }
  const click = (e: MouseEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey) return
    const { el, region } = regionAt(e)
    if (!region) return
    e.stopPropagation()
    const state = live?.state ?? {}
    const knob = typeof region.meta.knob === 'string' ? knobOf(drawing, region.meta.knob) : null
    if (knob && el) {
      // a click on the left third of ◂ value ▸ turns it down, on the right third up
      const b = el.getBoundingClientRect()
      const f = (e.clientX - b.left) / (b.width || 1)
      if (f < 0.34 || f > 0.66) return again(turn(drawing, state, knob.id, f < 0.34 ? -1 : 1))
    }
    setSelected(region.id)
    if (takesPress(drawing, region.id)) return again(state, { type: 'press', region: region.id }, el)
    const ref = partRef(region.meta)
    if (ref) teleport(ref)
  }
  return (
    <div
      ref={box}
      className="bcell-output bcell-output-kit"
      data-kit-w={drawing.w}
      onClick={click}
      onMouseMove={(e) => {
        const id = regionAt(e).region?.id ?? null
        if (id !== hover) setHover(id)
      }}
      onMouseLeave={() => hover && setHover(null)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
