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
