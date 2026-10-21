// paint.js: a terminal grid (term.js) as Claude Code elements, for a mod's render hook.
//
//   paintGrid(grid, $.ui.resolve(e), {theme, selected, key, painted}) -> one Box of rows
//
// Rows of text are Text lines, one nested Text per run of one style, so bold, links and theme colors work and the
// text follows the theme a person picked. A band of rows that holds pixels (a plot, a canvas's px and lines) and
// no bold or link is one Raster: the cells packed as Claude Code's cell-grid leaf wants them, each cell's glyph
// with its own foreground and background. A selection marks text one way and marks another (selectionOf): in a Text
// line the selected region's words are bold in their own color and its marks (a bar's cells, a spark, term.js `m`) are
// drawn as they are, so a selection never hides or recolors a bar; in a Raster, which has no bold, the words get the
// palette's `select` background and the marks light up in their own color (palette.js selectedMark), so a selected
// series is its own dots alone.
// `painted`: the grid stands on a background Claude Code paints from the theme (a pane), so ink is the theme's text
// color rather than the terminal's own.
// No `$`: the caller resolves the elements and hands them in.
import { hex, selectedHex, selectedMark, termColor } from './palette.js'

const DEFAULT = 0x01000000
const rgb = h => parseInt(String(h).slice(1, 7), 16)

/**
 * @param {{w: number, h: number, rows: object[][], regions: {id: string, rects: object[]}[]}} grid
 * @param {{Box: Function, Text: Function, Raster?: Function}} els
 * @param {{theme?: 'dark'|'light', selected?: string|null, key?: string, raster?: boolean, painted?: boolean}} [opts]
 */
/**
 * How the selection marks each cell: (x, y) -> null | 'text' | 'mark'. A cell is selected when it lies in the selected
 * region. A cell of a mark (term.js `m`) is 'mark'; when the selection is a plot's series, its dots are (`sr`, wherever
 * they lie), and never the rest of the plot's area.
 * @param {{w: number, rows: object[][], regions: {id: string, rects: object[]}[]}} grid
 * @param {string|null|undefined} selected
 */
export function selectionOf(grid, selected) {
  const sel = new Set()
  const r = selected ? grid.regions.find(x => x.id === selected) : null
  if (r) for (const q of r.rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) sel.add(y * grid.w + x)
  const series = !!r && grid.rows.some(row => row.some(c => c.sr === selected))
  return (x, y) => {
    const c = grid.rows[y] && grid.rows[y][x]
    if (!c) return null
    // a series' dots light up wherever they are (its region may be its legend entry alone)
    if (series && c.sr === selected) return 'mark'
    if (!sel.has(y * grid.w + x)) return null
    if (series && c.m) return null
    return c.m ? 'mark' : 'text'
  }
}

export function paintGrid(grid, els, opts = {}) {
  const { Box, Text, Raster } = els
  const theme = opts.theme || 'dark'
  const key = opts.key || 'draw'
  const look = selectionOf(grid, opts.selected)
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
      const s = look(x, y)
      const k = `${c.tone}|${c.b ? 1 : 0}|${c.bg || ''}|${c.ref ? 1 : 0}|${s || ''}`
      if (cur && cur.k === k) cur.s += c.ch
      else { cur = { k, s: c.ch, c, sel: s }; segs.push(cur) }
    })
    return Text({
      wrap: 'truncate-end',
      children: segs.map(g => {
        const p = { children: g.s }
        // a selection marks its words, bold in their own color, and never hides or recolors a mark (a bar's cells)
        const color = termColor(g.c.tone, theme, { painted: !!opts.painted })
        if (color) p.color = color
        if (g.c.b || g.sel === 'text') p.bold = true
        if (g.c.ref) p.underline = true
        if (g.c.bg) p.backgroundColor = hex(g.c.bg, theme)
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
        const on = look(x, y)
        words[i++] = on === 'mark' ? rgb(selectedMark(c.tone, theme)) : on ? rgb(selectedHex(c.tone, theme, !!c.bg)) : c.tone === 'ink' || !c.tone ? (opts.painted ? rgb(hex('ink', theme)) : DEFAULT) : rgb(hex(c.tone, theme))
        words[i++] = on === 'text' ? rgb(hex('select', theme)) : c.bg ? rgb(on === 'mark' ? selectedMark(c.bg, theme) : hex(c.bg, theme)) : DEFAULT
      })
    }
    const bytes = new Uint8Array(words.buffer)
    let bin = ''
    for (let j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000))
    return Raster({ key: `${key}-rows-${y0}`, columns: grid.w, rows, cells: btoa(bin) })
  }
}
