// @vitest-environment jsdom
// A custom card's frame (canvas/DataViz CustomFrame): its head carries thimble's chart style, as CSS variables and as
// `thimble.colors` and `thimble.vegaConfig`, and the libraries the card names, fetched from the workspace's card-libs
// route (backend card_libs) and placed before the card's own html, so its scripts find them. A card that names none
// fetches nothing.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CustomFrame } from '../../src/canvas/DataViz.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let asked: string[] = []

beforeEach(() => {
  asked = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    asked.push(url.pathname + url.search)
    if (url.pathname === '/api/ws/w/card-libs') return new Response(JSON.stringify({ head: '<script>window.LIB=1</script>', problems: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

async function frameDoc(el: HTMLElement): Promise<string> {
  for (let i = 0; i < 20 && !el.querySelector('iframe'); i++) await settle()
  return el.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

test('the frame carries the chart style and the libraries the card names, ahead of its html', async () => {
  const el = await mount(<CustomFrame html="<body><div id=c></div><script>draw()</script></body>" title="Runs" ws="w" libs={['vega-lite', 'd3@7.9.0']} />)
  const doc = await frameDoc(el)
  expect(asked).toContain('/api/ws/w/card-libs?libs=vega-lite%2Cd3%407.9.0')
  expect(doc.indexOf('window.LIB=1')).toBeGreaterThan(-1)
  expect(doc.indexOf('window.LIB=1')).toBeLessThan(doc.indexOf('<div id=c>'))
  for (const t of ['--viz-1', '--viz-7', '--viz-ink-1', '--viz-grid', '--label-1', '--font-mono']) expect(doc).toContain(`${t}:`)
  const style = /window\.thimble=Object\.assign\(window\.thimble\|\|\{\},(.*?)\)<\/script>/.exec(doc)?.[1] ?? ''
  const thimble = JSON.parse(style.replace(/\\u003c/g, '<')) as { colors: { series: string[]; ink: string[] }; vegaConfig: { range: { category: string[] } } }
  expect(thimble.colors.series).toHaveLength(7)
  expect(thimble.colors.ink).toHaveLength(4)
  expect(thimble.vegaConfig.range.category).toEqual(thimble.colors.series)
  expect(doc.indexOf('window.thimble=')).toBeLessThan(doc.indexOf('<div id=c>'))
})
