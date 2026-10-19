// paint.js: a terminal grid (term.js) as Claude Code elements, for a mod's render hook.
//
//   paintGrid(grid, $.ui.resolve(e), {theme, selected, key, painted}) -> one Box of rows
//
// Rows of text are Text lines, one nested Text per run of one style, so bold, links and theme colors work and the
// text follows the theme a person picked. A band of rows that holds pixels (a plot, a canvas's px and lines) and
// no bold or link is one Raster: the cells packed as Claude Code's cell-grid leaf wants them, each cell's glyph
// with its own foreground and background. The selected region's cells get the selection background, and their text
// the theme's text color (palette.js selectedColor). `painted`: the grid stands on a background Claude Code paints
// from the theme (a pane), so ink is the theme's text color rather than the terminal's own.
// No `$`: the caller resolves the elements and hands them in.
import { hex, selectedColor, selectedHex, termColor } from './palette.js'

const DEFAULT = 0x01000000
const rgb = h => parseInt(String(h).slice(1, 7), 16)

/**
 * @param {{w: number, h: number, rows: object[][], regions: {id: string, rects: object[]}[]}} grid
 * @param {{Box: Function, Text: Function, Raster?: Function}} els
 * @param {{theme?: 'dark'|'light', selected?: string|null, key?: string, raster?: boolean, painted?: boolean}} [opts]
 */
export function paintGrid(grid, els, opts = {}) {
  const { Box, Text, Raster } = els
  const theme = opts.theme || 'dark'
  const key = opts.key || 'draw'
  const sel = new Set()
  const r = opts.selected ? grid.regions.find(x => x.id === opts.selected) : null
  if (r) for (const q of r.rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) sel.add(y * grid.w + x)
  const isSel = (x, y) => sel.has(y * grid.w + x)
  const pixelRow = y => grid.rows[y].some(c => c.px) && !grid.rows[y].some(c => c.b || c.ref || c.w2)

  const out = []
  let y = 0
  while (y < grid.h) {
    if (Raster && opts.raster !== false && pixelRow(y)) {
      let y1 = y
      while (y1 < grid.h && pixelRow(y1)) y1++
      out.push(rasterBand(y, y1))
      y = y1
    } else { out.push(textLine(y)); y++ }
  }
  return Box({ flexDirection: 'column', children: out })

  function textLine(y) {
    const segs = []
    let cur = null
    grid.rows[y].forEach((c, x) => {
      if (c.cont) return
      const s = isSel(x, y)
      const k = `${c.tone}|${c.b ? 1 : 0}|${c.bg || ''}|${c.ref ? 1 : 0}|${s ? 1 : 0}`
      if (cur && cur.k === k) cur.s += c.ch
      else { cur = { k, s: c.ch, c, sel: s }; segs.push(cur) }
    })
    return Text({
      wrap: 'truncate-end',
      children: segs.map(g => {
        const p = { children: g.s }
        const color = g.sel ? selectedColor(g.c.tone, theme, !!g.c.bg) : termColor(g.c.tone, theme, { painted: !!opts.painted })
        if (color) p.color = color
        if (g.c.b) p.bold = true
        if (g.c.ref) p.underline = true
        if (g.sel) p.backgroundColor = 'selectionBg'
        else if (g.c.bg) p.backgroundColor = hex(g.c.bg, theme)
        return Text(p)
      }),
    })
  }

  function rasterBand(y0, y1) {
    const rows = y1 - y0
    const words = new Uint32Array(grid.w * rows * 3)
    let i = 0
    for (let y = y0; y < y1; y++) {
      grid.rows[y].forEach((c, x) => {
        const ch = c.cont ? ' ' : c.ch
        const cp = ch.codePointAt(0)
        words[i++] = cp > 0xFFFF || cp < 0x20 ? 0x3F : cp
        const on = isSel(x, y)
        words[i++] = on ? rgb(selectedHex(c.tone, theme, !!c.bg)) : c.tone === 'ink' || !c.tone ? (opts.painted ? rgb(hex('ink', theme)) : DEFAULT) : rgb(hex(c.tone, theme))
        words[i++] = on ? rgb(hex('select', theme)) : c.bg ? rgb(hex(c.bg, theme)) : DEFAULT
      })
    }
    const bytes = new Uint8Array(words.buffer)
    let bin = ''
    for (let j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000))
    return Raster({ key: `${key}-rows-${y0}`, columns: grid.w, rows, cells: btoa(bin) })
  }
}
