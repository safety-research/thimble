// cells.ts: a terminal grid (draw/term.js) as Claude Code elements, with each region's cells pressable. It is
// draw/paint.js's text rows, cut once more at region edges: a run of cells inside a region is a plain Button around its
// Text, so a click on a bar selects that bar, Tab walks the regions in reading order (the engine's focus ring, drawn
// inverse), and `onFocus` hears each one the ring reaches. Rows of pixels (a plot) stay one Raster, as paint.js draws
// them; their regions are reached by the regions around them or not at all.
//
//   paintRegions(grid, els, {theme, selected, key, from, rows, onPress}) -> one Box of rows
//   from, rows: the window of rows to draw (default all), so a tall object fits a pane
//   each region's Button has the key `r|<key>|<row>|<region id>` (regionOfKey reads it back)
import { paintGrid } from '../draw/paint.js'
import { hex, termColor } from '../draw/palette.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Cell = { ch: string; tone?: string; b?: boolean; bg?: string; ref?: string; px?: boolean; w2?: boolean; cont?: boolean }
type Rect = { x: number; y: number; w: number; h: number }
type Region = { id: string; meta?: Record<string, unknown>; rects: Rect[]; link?: boolean }
type Grid = { w: number; h: number; rows: Cell[][]; regions: Region[] }

/** For each cell, the id of the smallest region that holds it (links to an id included), or ''. */
export function regionMap(grid: Grid): string[] {
  const at: string[] = new Array(grid.w * grid.h).fill('')
  const area: number[] = new Array(grid.w * grid.h).fill(Infinity)
  for (const r of grid.regions) {
    for (const q of r.rects) {
      const a = q.w * q.h
      for (let y = q.y; y < q.y + q.h && y < grid.h; y++) {
        for (let x = q.x; x < q.x + q.w && x < grid.w; x++) {
          const i = y * grid.w + x
          if (a < (area[i] ?? Infinity)) { area[i] = a; at[i] = r.id }
        }
      }
    }
  }
  return at
}

/** The regions a person can select, in reading order: those drawn with at least one cell, links left out. */
export function selectable(grid: Grid): Region[] {
  return grid.regions.filter(r => r.rects.length && !r.link).slice().sort((a, b) => (a.rects[0]!.y - b.rects[0]!.y) || (a.rects[0]!.x - b.rects[0]!.x))
}

export function paintRegions(grid: Grid, els: Any, opts: { theme?: 'dark' | 'light'; selected?: string | null; key?: string; from?: number; rows?: number; onPress?: (id: string) => unknown }): Any {
  const { Box, Text, Button } = els
  const theme = opts.theme || 'dark'
  const key = opts.key || 'cells'
  const from = Math.max(0, Math.min(grid.h, opts.from ?? 0))
  const to = Math.min(grid.h, from + (opts.rows ?? grid.h))
  const owner = regionMap(grid)
  const sel = opts.selected || ''
  const pixelRow = (y: number) => grid.rows[y]!.some(c => c.px) && !grid.rows[y]!.some(c => c.b || c.ref || c.w2)
  const out: Any[] = []
  let y = from
  while (y < to) {
    if (pixelRow(y)) {
      // a band of pixels: paint.js's Raster for exactly these rows
      let y1 = y
      while (y1 < to && pixelRow(y1)) y1++
      const band = { ...grid, h: y1 - y, rows: grid.rows.slice(y, y1), regions: grid.regions.map(r => ({ ...r, rects: r.rects.map(q => ({ ...q, y: q.y - y })) })) }
      out.push(paintGrid(band, els, { theme, selected: sel, key: `${key}-${y}` }))
      y = y1
      continue
    }
    out.push(line(y))
    y++
  }
  return Box({ flexDirection: 'column', children: out })

  function line(y: number) {
    type Seg = { k: string; s: string; c: Cell; region: string }
    const segs: Seg[] = []
    let cur: Seg | null = null
    grid.rows[y]!.forEach((c, x) => {
      if (c.cont) return
      const region = owner[y * grid.w + x] || ''
      const k = `${c.tone}|${c.b ? 1 : 0}|${c.bg || ''}|${c.ref ? 1 : 0}|${region}`
      if (cur && cur.k === k) cur.s += c.ch
      else { cur = { k, s: c.ch, c, region }; segs.push(cur) }
    })
    const text = (g: Seg) => {
      const p: Any = { children: g.s }
      const color = termColor(g.c.tone, theme)
      if (color) p.color = color
      if (g.c.b) p.bold = true
      if (g.c.ref) p.underline = true
      if (g.region && g.region === sel) p.backgroundColor = 'selectionBg'
      else if (g.c.bg) p.backgroundColor = hex(g.c.bg, theme)
      return Text(p)
    }
    if (!opts.onPress || !segs.some(g => g.region)) return Text({ wrap: 'truncate-end', children: segs.map(text) })
    // runs of one region are one Button: a click anywhere on it selects the region
    const kids: Any[] = []
    let i = 0
    while (i < segs.length) {
      const g = segs[i]!
      if (!g.region) { kids.push(Text({ wrap: 'truncate-end', children: [text(g)] })); i++; continue }
      const run: Seg[] = []
      while (i < segs.length && segs[i]!.region === g.region) run.push(segs[i++]!)
      const id = g.region
      kids.push(Button({ key: `r|${key}|${y}|${id}`, plain: true, label: String(grid.regions.find(r => r.id === id)?.meta?.label || id), children: run.map(text), onPress: () => opts.onPress!(id) }))
    }
    return Box({ flexDirection: 'row', children: kids })
  }
}

/** The region id a cell Button's key names, or null. */
export function regionOfKey(k: string): string | null {
  const parts = String(k).split('|')
  return parts[0] === 'r' && parts.length >= 4 ? parts.slice(3).join('|') : null
}
