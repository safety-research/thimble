// The chart style as each renderer takes it (src/lib/vizTheme): the Vega-Lite theme draws one series in the first series
// color, never ink, groups in the series, amounts in the accent's ramps and notes in ink, at the chart sizes; a timeline
// colors its lanes' dots by the series; and the frames of custom cards and card types get the style as CSS variables, and
// a view's page every token of the theme that the view kit's styles, its docs and the worked examples name.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import { VIEW_TOKENS } from '../../src/lib/frame.ts'

test("a view's page, in the app and in the checks' shots, gets every token of the theme that the kit's styles and scripts, its docs and the worked examples name, the links' color among them", () => {
  const root = path.resolve(__dirname, '../../..')
  const inDir = (dir: string, re: RegExp) => readdirSync(path.join(root, dir)).filter((n) => re.test(n)).map((n) => path.join(root, dir, n))
  const theme = new Set([...readFileSync(path.join(root, 'frontend/src/styles/tokens.css'), 'utf8').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]))
  const files = [
    ...inDir('backend/app', /^viewer_.*\.(css|js)$/),
    ...inDir('docs', /\.md$/),
    ...readdirSync(path.join(root, 'plugin/viewers'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, 'plugin/viewers', d.name, 'view.html')),
  ]
  const named = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])))
  expect(named.size).toBeGreaterThan(40)
  expect([...named].filter((name) => theme.has(name) && !VIEW_TOKENS.includes(name))).toEqual([])
  // a view draws its own links in the app's link color, as the kit's text does
  expect(VIEW_TOKENS).toContain('--text-link')
  expect(named).toContain('--text-link')
  // the checks' headless shots give a view's page the same tokens (scripts/view_shot.mjs)
  const shot = readFileSync(path.join(root, 'scripts/view_shot.mjs'), 'utf8').split('const VIEW_TOKENS = [')[1].split(']')[0]
  expect([...shot.matchAll(/'(--[\w-]+)'/g)].map((m) => m[1]).sort()).toEqual([...VIEW_TOKENS].sort())
})
