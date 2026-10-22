// A slide layout drawn small: the heading's bar, the lines (dotted when bullets) and the card slots (filled ones
// darker). The layout picker, the new-slide menu and the rail's thumbnails draw layouts with it.
import { TipButton } from '../components/Tooltip'
import { PRESETS, slotsOf, type EditSlide, type LayoutPreset, type SlideLayout } from './model'

export interface GlyphSlide {
  layout: SlideLayout
  slots: number
  grid: boolean
  bullets: boolean
  side?: 'left' | 'right'
  /** the figure's share of the width beside the lines, in percent */
  width?: number
  /** how many slots hold a card */
  filled?: number
}

interface Shape {
  k: 'h' | 't' | 'f'
  x: number
  y: number
  w: number
  h: number
  on?: boolean
}

const W = 64
const LINE = 2
const LINE_GAP = 3.2

/** The lines in box `b`: as many as fit (at most four), the last one shorter, each after a dot when they are bullets. */
function lines(b: { x: number; y: number; w: number; h: number }, bullets: boolean, out: Shape[]) {
  const n = Math.max(1, Math.min(4, Math.floor((b.h + LINE_GAP) / (LINE + LINE_GAP))))
  for (let i = 0; i < n; i++) {
    const y = b.y + i * (LINE + LINE_GAP)
    const last = i === n - 1 && n > 1
    if (bullets) {
      out.push({ k: 't', x: b.x, y, w: LINE, h: LINE })
      out.push({ k: 't', x: b.x + LINE + 1.5, y, w: (b.w - LINE - 1.5) * (last ? 0.65 : 0.95), h: LINE })
    } else out.push({ k: 't', x: b.x, y, w: b.w * (last ? 0.6 : 1), h: LINE })
  }
}

/** `n` card slots in box `b`, `cols` to a row, the first `filled` of them darker. */
function slots(b: { x: number; y: number; w: number; h: number }, n: number, cols: number, filled: number, out: Shape[], gap = 2.5) {
  const rows = Math.ceil(n / cols)
  const cw = (b.w - gap * (cols - 1)) / cols
  const ch = (b.h - gap * (rows - 1)) / rows
  for (let i = 0; i < n; i++) out.push({ k: 'f', x: b.x + (i % cols) * (cw + gap), y: b.y + Math.floor(i / cols) * (ch + gap), w: cw, h: ch, on: i < filled })
}

/** The shapes of a layout in a box W wide and `h` tall; `heading` false leaves out the heading's bar (a rail thumbnail
 * writes the heading above it), except on a title slide, whose heading is the slide. */
function shapes(g: GlyphSlide, h: number, heading: boolean): Shape[] {
  const out: Shape[] = []
  const pad = heading ? 5 : 2.5
  const n = slotsOf(g)
  const filled = Math.min(g.filled ?? 0, n)
  const top = heading ? pad + 3 + 3 : pad
  const body = { x: pad, y: top, w: W - 2 * pad, h: h - pad - top }
  const bar = () => heading && out.push({ k: 'h', x: pad, y: pad, w: 24, h: 3 })
  switch (g.layout) {
    case 'title':
      out.push({ k: 'h', x: W / 2 - 15, y: h / 2 - 4, w: 30, h: 4 })
      out.push({ k: 't', x: W / 2 - 10, y: h / 2 + 3, w: 20, h: LINE })
      break
    case 'text':
      bar()
      lines(body, g.bullets, out)
      break
    case 'figure': {
      bar()
      const gap = 4
      const cw = (body.w - gap) * ((g.width ?? 50) / 100)
      const tw = body.w - gap - cw
      const left = g.side === 'left'
      lines({ ...body, x: left ? body.x + cw + gap : body.x, w: tw }, g.bullets, out)
      slots({ ...body, x: left ? body.x : body.x + tw + gap, w: cw }, n, 1, filled, out)
      break
    }
    case 'card': {
      if (heading) out.push({ k: 'h', x: 3, y: 3, w: 14, h: 2 })
      const inset = heading ? 3 : 2
      const y = heading ? 7 : inset
      slots({ x: inset, y, w: W - 2 * inset, h: h - inset - y }, 1, 1, filled, out)
      break
    }
    case 'figures':
      bar()
      slots(body, n, g.grid ? 2 : n, filled, out)
      break
    case 'quote': {
      if (heading) out.push({ k: 'h', x: 12, y: 6, w: 12, h: 2 })
      const y = heading ? 12 : body.y + 2
      for (let i = 0; i < 3; i++) out.push({ k: 't', x: 12, y: y + i * 5, w: i === 2 ? 26 : 40, h: 3 })
      break
    }
  }
  return out
}

/** A layout drawn small. `heading` (default true) draws the heading's bar; `stretch` fills the box it is given rather
 * than keeping 16:9, as in a rail thumbnail under the heading's text. */
export function LayoutGlyph({ slide, heading = true, stretch = false, className }: { slide: GlyphSlide; heading?: boolean; stretch?: boolean; className?: string }) {
  const h = stretch ? 24 : 36
  return (
    <svg className={`lg${className ? ` ${className}` : ''}`} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio={stretch ? 'none' : 'xMidYMid meet'} aria-hidden="true">
      {shapes(slide, h, heading).map((s, i) => (
        <rect key={i} className={`lg-${s.k}${s.on ? ' on' : ''}`} x={s.x} y={s.y} width={Math.max(0, s.w)} height={Math.max(0, s.h)} rx={s.k === 'f' ? 1.2 : 0.6} />
      ))}
    </svg>
  )
}

/** The glyph of a slide as the editor holds it, its filled slots darker. */
export const glyphOf = (s: EditSlide): GlyphSlide => ({ layout: s.layout, slots: s.slots, grid: s.grid, bullets: s.bullets, side: s.side, width: s.width, filled: s.figures.length })

/** The glyph of a preset, as the picker and the new-slide menu draw it. */
export const presetGlyph = (p: LayoutPreset): GlyphSlide => ({ layout: p.layout, slots: p.slots, grid: p.grid, bullets: p.bullets ?? true })

/** The layout picker: every preset as a small slide, named in the one tooltip, the one the slide matches ringed. */
export function LayoutPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="wu-layout-pick" role="radiogroup" aria-label="Layout">
      {PRESETS.map((p) => (
        <TipButton key={p.id} tip={p.label} role="radio" aria-checked={p.id === value} data-layout={p.id} className={`wu-layout-opt${p.id === value ? ' active' : ''}`} onClick={() => p.id !== value && onChange(p.id)}>
          <LayoutGlyph slide={presetGlyph(p)} />
        </TipButton>
      ))}
    </div>
  )
}
