// draw.js: an object drawn in a page, as the terminal draws it in cells: its program runs in the browser's sandbox
// (draw/browser/sandbox.js, no network, no page access) and the drawing is laid out as SVG by draw/svg.js. The parts
// (regions) are the same ids in both, so a part selected here is the part the terminal knows.
import { canvasMeasure, renderSvg } from '../draw/svg.js'
import { makeSandbox } from '../draw/browser/sandbox.js'
import { forDrawing } from '../lib/object.js'
import { BASE } from './base.js'

export const CW = 8.2
let sandbox = null
let measure = null
const drawings = new Map()

async function box() {
  if (sandbox) return sandbox
  const kit = await fetch(`${BASE}/draw/kit.js`).then(r => r.text())
  sandbox = makeSandbox(kit)
  measure = canvasMeasure(document)
  return sandbox
}

/** The columns a drawing gets in `px` pixels. */
export const columnsIn = px => Math.max(40, Math.min(150, Math.floor((px - 8) / CW)))

/**
 * Run an object's program for `w` columns (`mode` 'inline' under a reply, 'detail' on its page; `state` its knobs).
 * Kept per object version, width, mode and state.
 */
export async function drawingOf(object, { w, mode = 'inline', state } = {}) {
  const o = forDrawing(object)
  const key = `${o.id}@${o.v}|${w}|${mode}|${state ? JSON.stringify(state) : ''}`
  if (drawings.has(key)) return drawings.get(key)
  const p = box().then(s => s.run(o, { w, h: 24, mode, state }))
  drawings.set(key, p)
  return p
}

/**
 * The drawing as SVG: {svg, w, h, regions, error}. `selected` gets an outline over its parts; `hover` a faint one.
 * `parts` lists the parts a person can select, top to bottom (knobs left out).
 */
export function svgOf(drawing, { w, selected = null, hover = null } = {}) {
  const res = renderSvg(drawing, { w, cw: CW, measure, theme: 'light', hover: null, selected: null })
  const outline = (id, cls) => {
    const r = res.regions.find(x => x.id === id)
    return r ? r.rects.map(q => `<rect class="${cls}" x="${(q.x - 4).toFixed(1)}" y="${(q.y - 1).toFixed(1)}" width="${(q.w + 8).toFixed(1)}" height="${(q.h + 2).toFixed(1)}" rx="6"/>`).join('') : ''
  }
  const over = `<g class="sel-layer">${hover && hover !== selected ? outline(hover, 'hovbox') : ''}${selected ? outline(selected, 'selbox') : ''}</g>`
  // the outlines go under the hit rects, so a click still lands on a part
  const svg = res.svg.replace('<g class="dk-hits">', `${over}<g class="dk-hits">`)
  const knobs = new Set((drawing.controls || []).map(c => c.id))
  const parts = res.regions.filter(r => r.rects.length && !knobs.has(r.id) && !r.meta?.knob)
    .slice().sort((a, b) => a.rects[0].y - b.rects[0].y || a.rects[0].x - b.rects[0].x)
  return { ...res, svg, parts }
}

/** Fonts first: text is measured with the face the SVG sets. */
export const fontsReady = Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 2500))])
