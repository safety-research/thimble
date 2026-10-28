// @vitest-environment jsdom
// A matplotlib figure's marks drawn with <use> (src/lib/svg.ts inlineSvg, src/lib/sanitize.ts purifySvg): matplotlib
// draws a scatter's markers and an axis's ticks as one path in <defs> and a <use> of it at each place. The inlined
// figure keeps each <use> whose href names a shape of the same figure, under the figure's id prefix; a <use> that names
// anything else (another host, a data: or media URL, an id the figure does not have, a group) loses its href, so nothing
// loads from outside the figure and no figure multiplies what it draws.
import { expect, test } from 'vitest'
import { inlineSvg } from '../../src/lib/svg.ts'

// what matplotlib writes for a scatter of five points with three ticks on its x axis
const SCATTER = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="360pt" height="230pt" viewBox="0 0 360 230" xmlns="http://www.w3.org/2000/svg" version="1.1">
 <defs><style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style></defs>
 <g id="figure_1">
  <g id="patch_1"><path d="M 0 230 L 360 230 L 360 0 L 0 0 z" style="fill: none"/></g>
  <g id="axes_1">
   <g id="PathCollection_1">
    <defs><path id="C0_0_8f3a2b" d="M 0 2.12 C 0.56 2.12 1.1 1.9 1.5 1.5 C 1.9 1.1 2.12 0.56 2.12 0 C 2.12 -0.56 1.9 -1.1 1.5 -1.5 C 1.1 -1.9 0.56 -2.12 0 -2.12 C -0.56 -2.12 -1.1 -1.9 -1.5 -1.5 C -1.9 -1.1 -2.12 -0.56 -2.12 0 C -2.12 0.56 -1.9 1.1 -1.5 1.5 C -1.1 1.9 -0.56 2.12 0 2.12 z" style="stroke: #0471c8"/></defs>
    <g clip-path="url(#p1c2d3e)">
     <use xlink:href="#C0_0_8f3a2b" x="81.2" y="160.4" style="fill: #0471c8; stroke: #0471c8"/>
     <use xlink:href="#C0_0_8f3a2b" x="130.9" y="122.7" style="fill: #0471c8; stroke: #0471c8"/>
     <use xlink:href="#C0_0_8f3a2b" x="190.3" y="101.5" style="fill: #0471c8; stroke: #0471c8"/>
     <use xlink:href="#C0_0_8f3a2b" x="244.6" y="80.2" style="fill: #0471c8; stroke: #0471c8"/>
     <use xlink:href="#C0_0_8f3a2b" x="301.8" y="44.9" style="fill: #0471c8; stroke: #0471c8"/>
    </g>
   </g>
   <g id="matplotlib.axis_1">
    <g id="xtick_1"><g id="line2d_1"><defs><path id="m5c1e0f" d="M 0 0 L 0 3.5" style="stroke: #64625b; stroke-width: 0.8"/></defs><g><use xlink:href="#m5c1e0f" x="60" y="200" style="fill: #64625b; stroke: #64625b; stroke-width: 0.8"/></g></g></g>
    <g id="xtick_2"><g id="line2d_2"><g><use xlink:href="#m5c1e0f" x="190" y="200" style="fill: #64625b; stroke: #64625b; stroke-width: 0.8"/></g></g></g>
    <g id="xtick_3"><g id="line2d_3"><g><use xlink:href="#m5c1e0f" x="320" y="200" style="fill: #64625b; stroke: #64625b; stroke-width: 0.8"/></g></g></g>
   </g>
  </g>
 </g>
 <defs><clipPath id="p1c2d3e"><rect x="45" y="20" width="300" height="180"/></clipPath></defs>
</svg>`

// a figure whose uses name a shape of its own, and what lies outside it or would multiply it
const REACHING = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="40" viewBox="0 0 100 40">
 <defs><path id="dot" d="M 0 0 L 2 0 L 2 2 z"/><g id="group"><path d="M 0 0 L 4 0 L 4 4 z"/><use xlink:href="#dot"/></g></defs>
 <use id="own" xlink:href="#dot" x="5" y="5"/>
 <use id="own2" href="#dot" x="9" y="5"/>
 <use id="remote" xlink:href="https://evil.example/marks.svg#dot" x="15" y="5"/>
 <use id="data" xlink:href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=#a" x="25" y="5"/>
 <use id="media" href="/api/ws/w/media?path=marks.svg#dot" x="35" y="5"/>
 <use id="elsewhere" href="#app-icon" x="45" y="5"/>
 <use id="grouped" xlink:href="#group" x="55" y="5"/>
</svg>`

/** The figure as the page holds it, in a div as Outputs puts it. */
function inlined(svg: string, prefix: string): HTMLDivElement {
  const div = document.createElement('div')
  div.innerHTML = inlineSvg(svg, prefix)!.markup
  return div
}
const href = (el: Element) => el.getAttribute('href') ?? el.getAttribute('xlink:href')

test("a scatter's markers and its ticks, drawn with <use>, are kept, each naming its shape in the same figure", () => {
  const div = inlined(SCATTER, 'f1-')
  const uses = Array.from(div.querySelectorAll('use'))
  expect(uses.map(href)).toEqual([...Array(5).fill('#f1-C0_0_8f3a2b'), ...Array(3).fill('#f1-m5c1e0f')])
  for (const u of uses) expect(div.querySelector(`path[id="${href(u)!.slice(1)}"]`)).not.toBeNull()
  // a marker keeps its place and its color, as a token of the paper
  expect([uses[0].getAttribute('x'), uses[0].getAttribute('y')]).toEqual(['81.2', '160.4'])
  expect(uses[0].getAttribute('style')).toMatch(/fill:\s*var\(--viz-1\)/)
})

test('a <use> that names anything but a shape of its own figure loses its href: another host, a data: or media URL, an id the figure lacks, a group', () => {
  const div = inlined(REACHING, 'f2-')
  const got = Object.fromEntries(Array.from(div.querySelectorAll('use[id]')).map((u) => [u.id.replace(/^f2-/, ''), href(u)]))
  expect(got).toEqual({ own: '#f2-dot', own2: '#f2-dot', remote: null, data: null, media: null, elsewhere: null, grouped: null })
  expect(div.innerHTML).not.toMatch(/evil\.example|data:image\/svg|\/api\/ws/)
})
