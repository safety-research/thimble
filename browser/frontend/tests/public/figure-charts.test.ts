// The charts in a figure style (src/lib/theme.ts FigureStyle): a sandboxed frame gets the Blog style's chart face beside
// the page's own (lib/frame), only while that style is on.
import { expect, test } from 'vitest'
import { FIGURE_FACES, pageFaces } from '../../src/lib/frame.ts'

/** an @font-face rule as the browser writes one back, for a family's subset and weight */
const face = (family: string, subset: string, weight = 400) =>
  `@font-face { font-family: "${family}"; font-style: normal; font-display: swap; font-weight: ${weight}; src: url("/assets/${family.toLowerCase().replace(/ /g, '-')}-${subset}-${weight}-normal.woff2") format("woff2"); }`

test("a frame takes the page's two faces, and the Blog style's chart face beside them only while that style is on", () => {
  const rules = ['Hanken Grotesk', 'Geist Mono', 'DM Sans', 'Source Serif 4'].flatMap((f) => [face(f, 'latin'), face(f, 'latin-ext'), face(f, 'cyrillic')])
  const families = (got: { decls: string }[]) => [...new Set(got.map((g) => /font-family:\s*"([^"]+)"/.exec(g.decls)?.[1]))]
  expect(families(pageFaces(rules))).toEqual(['Hanken Grotesk', 'Geist Mono'])
  expect(FIGURE_FACES.thimble).toEqual([])
  expect(FIGURE_FACES.paper).toEqual([])
  const blog = pageFaces(rules, ['Hanken Grotesk', 'Geist Mono', ...FIGURE_FACES.blog])
  expect(families(blog)).toEqual(['Hanken Grotesk', 'Geist Mono', 'DM Sans'])
  // the latin subsets only, each without its src, which the frame gives as data
  expect(blog.filter((g) => g.decls.includes('DM Sans')).map((g) => g.url)).toEqual(['/assets/dm-sans-latin-400-normal.woff2', '/assets/dm-sans-latin-ext-400-normal.woff2'])
  expect(blog.every((g) => !g.decls.includes('src:'))).toBe(true)
})
