// @vitest-environment jsdom
// A matplotlib figure's black and white turn with the paper (src/lib/svg.ts inlineSvg): matplotlib writes no fill for
// black text or a black face, which SVG then paints black, unreadable on Dark; the root gives them the paper's ink, and
// a white box the card's paper, so a node's black name on a white or a clear box reads on every paper.
import { expect, test } from 'vitest'
import { inlineSvg } from '../../src/lib/svg.ts'

// what matplotlib writes for a node: a box with a white face (or none) and its name as text with no fill (black)
const FIGURE = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200pt" height="80pt" viewBox="0 0 200 80">
 <g id="figure_1"><g id="patch_1"><path d="M 0 80 L 200 80 L 200 0 L 0 0 z" style="fill: #ffffff"/></g>
 <g id="axes_1">
  <g id="text_1"><g id="patch_2"><path id="box" d="M 10 30 L 90 30 L 90 50 L 10 50 z" style="fill: #ffffff; stroke: #000000"/></g>
   <text id="name" x="50" y="44" style="font: 13.333px 'DejaVu Sans'; text-anchor: middle">Scheduler</text></g>
  <g id="text_2"><g id="patch_3"><path id="clear" d="M 110 30 L 190 30 L 190 50 L 110 50 z" style="fill: none; stroke: #000000"/></g>
   <text id="name2" x="150" y="44" style="font: 13.333px 'DejaVu Sans'; text-anchor: middle">Build</text></g>
 </g></g>
</svg>`

test("a node's name that matplotlib leaves black takes the paper's ink, and its white box the card's paper", () => {
  const fig = inlineSvg(FIGURE, 'f-')!
  const doc = new DOMParser().parseFromString(fig.markup, 'image/svg+xml')
  const root = doc.documentElement
  // what declares no fill takes the root's: the paper's text ink, which is near-white on Dark
  expect(root.getAttribute('style')).toMatch(/(^|;)\s*fill:\s*var\(--text-primary\)/)
  for (const id of ['f-name', 'f-name2']) expect(doc.getElementById(id)!.getAttribute('style') ?? '').not.toMatch(/fill/)
  // a white box turns with the paper too, so the ink reads on it
  expect(doc.getElementById('f-box')!.getAttribute('style')).toMatch(/fill:\s*var\(--surface-card\)/)
  expect(doc.getElementById('f-clear')!.getAttribute('style')).toMatch(/fill:\s*none/)
})

/** The fill an element is painted with: its own (a style declaration over the attribute), else the nearest ancestor's,
 * else SVG's black. */
function fillOf(el: Element | null): string {
  for (let e = el; e; e = e.parentElement) {
    const decl = /(?:^|;)\s*fill:\s*([^;]+)/.exec(e.getAttribute('style') ?? '')
    if (decl) return decl[1].trim()
    if (e.hasAttribute('fill')) return e.getAttribute('fill')!
  }
  return 'black'
}
const parse = (markup: string) => new DOMParser().parseFromString(markup, 'image/svg+xml')

// a seaborn-style annotated heatmap as matplotlib writes it: white labels ('w') on its dark cells, near-black ones on
// its light cells, and a white figure and axes background
const HEAT = `<svg xmlns="http://www.w3.org/2000/svg" width="288pt" height="158.4pt" viewBox="0 0 288 158.4">
 <defs><style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style></defs>
 <g id="figure_1"><g id="patch_1"><path id="figbg" d="M 0 158.4 L 288 158.4 L 288 0 L 0 0 z" style="fill: #ffffff"/></g>
 <g id="axes_1"><g id="patch_2"><path id="axbg" d="M 36 141 L 259 141 L 259 19 L 36 19 z" style="fill: #ffffff"/></g>
  <g id="QuadMesh_1"><path id="dark" d="M 36 141 L 110 141 L 110 80 L 36 80" style="fill: #440154"/><path id="light" d="M 184 141 L 259 141 L 259 80 L 184 80" style="fill: #fde725"/></g>
  <g id="text_13"><text id="w" x="73" y="112" style="font-size: 8.25px; font-family: 'DejaVu Sans'; text-anchor: middle; fill: #ffffff">0.1</text></g>
  <g id="text_15"><text id="k" x="222" y="112" style="font-size: 8.25px; font-family: 'DejaVu Sans'; text-anchor: middle; fill: #262626">0.9</text></g>
 </g></g>
</svg>`

// what graphviz writes: a white background polygon, black outlines and text that declares no fill (SVG's black)
const GRAPHVIZ = `<svg width="170pt" height="62pt" viewBox="0.00 0.00 170.00 62.00" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<g id="graph0" class="graph" transform="scale(1 1) rotate(0) translate(4 58)">
<polygon id="paper" fill="white" stroke="none" points="-4,4 -4,-58 166,-58 166,4 -4,4"/>
<g id="node1" class="node"><ellipse id="ring" fill="none" stroke="black" cx="27" cy="-27" rx="27" ry="18"/>
<text id="build" text-anchor="middle" x="27" y="-22.8" font-family="Times,serif" font-size="14.00">Build</text></g>
</g></svg>`

// an icon drawn in outline: its root says fill none
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#e26101" stroke-width="2"><circle id="dot" cx="12" cy="12" r="9"/><path id="bar" d="M8 12h8"/></svg>`

test("an annotated heatmap's white label stays white on its dark cell, and its near-black label on its light cell, on every paper", () => {
  const doc = parse(inlineSvg(HEAT, 'h-')!.markup)
  expect([fillOf(doc.getElementById('h-w')), fillOf(doc.getElementById('h-dark'))]).toEqual(['#ffffff', '#440154'])
  expect([fillOf(doc.getElementById('h-k')), fillOf(doc.getElementById('h-light'))]).toEqual(['#262626', '#fde725'])
})

test("a matplotlib figure's white figure and axes background is dropped, so the card's paper shows", () => {
  const doc = parse(inlineSvg(HEAT, 'h-')!.markup)
  expect([fillOf(doc.getElementById('h-figbg')), fillOf(doc.getElementById('h-axbg'))]).toEqual(['none', 'none'])
})

test('a drawing that is not a matplotlib figure keeps its own black and white: a graphviz graph, an outlined icon', () => {
  const gv = parse(inlineSvg(GRAPHVIZ, 'g-')!.markup)
  // black text on the white polygon, as graphviz drew it
  expect(fillOf(gv.getElementById('g-build'))).toBe('black')
  expect(fillOf(gv.getElementById('g-paper'))).toBe('white')
  expect(fillOf(gv.getElementById('g-ring'))).toBe('none')
  const icon = parse(inlineSvg(ICON, 'i-')!.markup)
  expect([fillOf(icon.getElementById('i-dot')), fillOf(icon.getElementById('i-bar'))]).toEqual(['none', 'none'])
})

test('a matplotlib figure whose root declares a fill keeps its own black and white', () => {
  const doc = parse(inlineSvg(FIGURE.replace('viewBox="0 0 200 80"', 'viewBox="0 0 200 80" fill="#333333"'), 'f-')!.markup)
  expect(fillOf(doc.getElementById('f-name'))).toBe('#333333')
  expect(fillOf(doc.getElementById('f-box'))).toBe('#ffffff')
})
