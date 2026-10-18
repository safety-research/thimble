// draw.ts: an object drawn by lean's drawing contract, as the terminal draws it: its program runs in the browser
// sandbox (draw/browser/sandbox.js: no network, no page access) and the drawing is laid out as SVG by draw/svg.js. The
// modules come from the page server, so the app and the terminal draw with the same code. The SVG is set in 0.9's
// faces and colors, so a card on the canvas reads like 0.9's.
import { BASE, serverModule } from './api'

export const CW = 8.1
const SANS09 = '"Hanken Grotesk", ui-sans-serif, system-ui, sans-serif'
const MONO09 = '"Geist Mono", ui-monospace, Menlo, monospace'

// lean's light palette (draw/palette.js) to 0.9's tokens (styles/tokens.css): ink, the viz ramp and the violet accent
const COLORS: [string, string][] = [
  ['#ffffff', '#fffdf8'], ['#1d1b18', '#1b1a18'], ['#8a847a', '#6b675f'], ['#d8d4cb', '#ddd9d0'], ['#2a78c4', '#5135ff'],
  ['#1f8a84', '#018d82'], ['#7b5bb6', '#9d9cff'], ['#a8875a', '#a08319'], ['#5b6b82', '#0471c8'], ['#c25c8a', '#c8367b'],
  ['#7c8a2e', '#306602'], ['#3f8a3e', '#0b7c5f'], ['#c94f4a', '#c93a28'], ['#b7791f', '#9a6512'], ['#b9b2a6', '#cfcbc2'],
  ['#e6eefb', '#eeeffe'], ['#f3f1ec', '#f5f3ee'],
]

interface Mods {
  svg: any
  sandbox: any
  object: any
  events: any
  measure: (s: string, o?: { size?: number; bold?: boolean; mono?: boolean }) => number
}
let mods: Promise<Mods> | null = null

function measureWith(): Mods['measure'] {
  const ctx = document.createElement('canvas').getContext('2d')!
  const cache = new Map<string, number>()
  return (s, o = {}) => {
    const font = `${o.bold ? 600 : 400} ${o.size || 13}px ${o.mono ? MONO09 : SANS09}`
    const key = font + '|' + s
    let v = cache.get(key)
    if (v == null) {
      ctx.font = font
      v = ctx.measureText(String(s)).width
      cache.set(key, v)
    }
    return v
  }
}

export function drawModules(): Promise<Mods> {
  if (!mods) {
    mods = (async () => {
      const [svg, sb, object, events, kit] = await Promise.all([
        serverModule('draw/svg.js'),
        serverModule('draw/browser/sandbox.js'),
        serverModule('lib/object.js'),
        serverModule('draw/browser/events.js'),
        fetch(`${BASE}/draw/kit.js`).then((r) => r.text()),
      ])
      await fontsReady
      return { svg, object, events, sandbox: sb.makeSandbox(kit), measure: measureWith() }
    })()
  }
  return mods
}

export const fontsReady: Promise<unknown> = Promise.race([
  (document as any).fonts ? Promise.all([(document as any).fonts.load('13px "Hanken Grotesk"'), (document as any).fonts.load('13px "Geist Mono"')]) : Promise.resolve(),
  new Promise((r) => setTimeout(r, 2500)),
])

/** The columns a drawing gets in `px` pixels. */
export const columnsIn = (px: number): number => Math.max(36, Math.min(160, Math.floor((px - 8) / CW)))

// the keys the page keeps where a card is drawn (panes/host.js hostKeys): a card's program learns them as k.keys
let hostMod: Promise<any> | null = null
const keysAt = async (mode: string) => {
  hostMod ??= import(/* @vite-ignore */ `${BASE}/code/panes/host.js`)
  try {
    return { taken: (await hostMod).hostKeys(mode === 'detail' ? 'detail' : 'inline', 'browser') }
  } catch {
    return undefined
  }
}

const drawings = new Map<string, Promise<any>>()
/** Run an object's program for `w` columns ('inline' on the canvas, 'detail' in the card's detail; `state`: its knobs). */
export async function drawingOf(object: any, { w, mode = 'inline', state }: { w: number; mode?: string; state?: Record<string, unknown> }): Promise<any> {
  const m = await drawModules()
  const o = m.object.forDrawing(object)
  const key = `${o.id}@${o.v}|${w}|${mode}|${state ? JSON.stringify(state) : ''}`
  if (!drawings.has(key)) drawings.set(key, keysAt(mode).then((keys) => m.sandbox.run(o, { w, h: 24, mode, state, keys })))
  return drawings.get(key)!
}

/** What the person did, run as the card program's event (k.on): the drawing it answers with carries the new `state`
 *  and, when a handler called k.ask, the selection to ask about. Never cached: an event happens once. */
export async function eventOf(object: any, { w, mode = 'detail', state, event }: { w: number; mode?: string; state?: Record<string, unknown>; event: Record<string, unknown> }): Promise<any> {
  const m = await drawModules()
  return m.sandbox.run(m.object.forDrawing(object), { w, h: 24, mode, state, event, keys: await keysAt(mode) })
}

/** The browser surface's event helpers (draw/browser/events.js). */
export async function eventsLib(): Promise<any> {
  return (await drawModules()).events
}

const words = (runs: any): string => (Array.isArray(runs) ? runs.map((r: any) => (r.br ? ' ' : r.s)).join('') : String(runs || '')).trim()

/** A drawing that is one frame, as its inside: the card draws its own header, so the frame's words come back as text. */
export function unframe(drawing: any): { drawing: any; title: string; right: string; bottom: string } {
  const r = drawing?.root
  if (!r || r.t !== 'frame' || !r.kid || r.tone === 'bad' || drawing.error) return { drawing, title: '', right: '', bottom: '' }
  return { drawing: { ...drawing, root: r.kid }, title: words(r.title), right: words(r.right), bottom: words(r.bottom) }
}

export interface Part {
  id: string
  label: string
  meta: any
  rects: { x: number; y: number; w: number; h: number }[]
}

/** The drawing as SVG in 0.9's look: {svg, w, h, regions, parts}. `selected` gets an outline, `hover` a faint one. */
export async function svgOf(drawing: any, { w, selected = null, hover = null }: { w: number; selected?: string | null; hover?: string | null }): Promise<{ svg: string; w: number; h: number; regions: Part[]; parts: Part[] }> {
  const m = await drawModules()
  const res = m.svg.renderSvg(drawing, { w, cw: CW, measure: m.measure, theme: 'light' })
  let svg: string = res.svg
  svg = svg.split(m.svg.SANS).join(SANS09).split(m.svg.MONO).join(MONO09)
  for (const [a, b] of COLORS) svg = svg.split(a).join(b).split(a.toUpperCase()).join(b)
  const outline = (id: string | null, cls: string) => {
    const r = id ? res.regions.find((x: Part) => x.id === id) : null
    return r ? r.rects.map((q: Part['rects'][0]) => `<rect class="${cls}" x="${(q.x - 4).toFixed(1)}" y="${(q.y - 1).toFixed(1)}" width="${(q.w + 8).toFixed(1)}" height="${(q.h + 2).toFixed(1)}" rx="4"/>`).join('') : ''
  }
  const over = `<g class="sel-layer">${hover && hover !== selected ? outline(hover, 'hovbox') : ''}${selected ? outline(selected, 'selbox') : ''}</g>`
  svg = svg.replace('<g class="dk-hits">', `${over}<g class="dk-hits">`)
  const knobs = new Set((drawing.controls || []).map((c: any) => c.id))
  const parts = (res.regions as Part[])
    .filter((r) => r.rects.length && !knobs.has(r.id) && !r.meta?.knob)
    .map((r) => ({ ...r, label: String(r.meta?.label || r.id) }))
    .sort((a, b) => a.rects[0].y - b.rects[0].y || a.rects[0].x - b.rects[0].x)
  return { svg, w: res.w, h: res.h, regions: res.regions, parts }
}

/** shell/object.js, what both views say of an object (refs of a part, a resolve chain in words). */
export async function objectLib(): Promise<any> {
  return (await drawModules()).object
}
