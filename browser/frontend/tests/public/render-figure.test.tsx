// @vitest-environment jsdom
// The card harness's page draws a figure for an export as the report's page draws it (src/render.tsx, `figure`): the
// card's art alone, at the figure's width and scaled by `zoom`, without the card face around it (its question and
// takeaway, which the export sets as text); for an export of the card alone (`whole`), the question and the takeaway
// with the art in one picture, and the chart as an SVG file when asked.
import { beforeAll, expect, test } from 'vitest'
import type { RenderRequest, RenderResult } from '../../src/render.tsx'
import type { Cell } from '../../src/lib/types'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>'

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom has no font loading: the page waits on it, and checks its faces
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), load: async () => [], check: () => true } })
  await import('../../src/render.tsx')
})

const card: Cell = {
  id: 'c1',
  notebook: 'main',
  kind: 'code',
  title: 'How many runs end early?',
  takeaway: 'Most runs end early.',
  created_by: 'main',
  ts: '2026-10-15T10:00:00Z',
  status: 'ok',
  outputs: [{ 'image/svg+xml': SVG }],
}

const request = (over: Partial<RenderRequest>): RenderRequest => ({
  ws: 'w',
  card,
  citations: {},
  names: [],
  theme: { paper: 'neutral', accent: 'iris' },
  width: 480,
  ...over,
})

const draw = (req: RenderRequest): Promise<RenderResult> =>
  (window as unknown as { __thimbleRender: { render: (r: RenderRequest) => Promise<RenderResult> } }).__thimbleRender.render(req)

test("a figure is the card's art alone, laid out at its width and scaled by its zoom", async () => {
  const res = await draw(request({ figure: true, zoom: 1.5 }))
  expect(res.error).toBeUndefined()
  const art = document.querySelector<HTMLElement>('.render-figure')
  expect(art).not.toBeNull()
  expect(art?.style.width).toBe('480px')
  expect(art?.style.zoom).toBe('1.5')
  expect(art?.querySelector('svg')).not.toBeNull()
  expect(document.querySelector('article.canvas-card')).toBeNull()
  expect(art?.textContent).not.toContain('Most runs end early.')
})

test("an export of the card alone draws it whole, its question, art and takeaway without citations, and its chart as an SVG file", async () => {
  const cited = { ...card, takeaway: 'Most runs [end early](#), [[12|card:c1]] of them [[card:c1]].' }
  const res = await draw(request({ card: cited, figure: true, whole: true, files: ['svg'] }))
  expect(res.error).toBeUndefined()
  const fig = document.querySelector<HTMLElement>('.render-figure-whole')
  expect(fig?.style.width).toBe('480px')
  expect(fig?.querySelector('.wu-fig-q')?.textContent).toBe('How many runs end early?')
  expect(fig?.querySelector('.render-figure-art svg')).not.toBeNull()
  expect(fig?.querySelector('.wu-fig-take .wu-fig-caption')?.textContent?.trim()).toBe('Most runs end early, 12 of them.')
  expect(document.querySelector('article.canvas-card')).toBeNull()
  // the chart alone, as a file of its own, its tokens written as their values
  expect(res.svg).toMatch(/^<svg[\s\S]*<rect width="40" height="20"/)
  expect(res.svg).not.toContain('var(')
  // a report's figure is the art alone, with no file asked for
  const art = await draw(request({ figure: true }))
  expect(art.svg).toBeUndefined()
  expect(document.querySelector('.render-figure-whole')).toBeNull()
})

test('without figure the page draws the card face, as the card check reads it', async () => {
  const res = await draw(request({}))
  expect(res.error).toBeUndefined()
  expect(document.querySelector('article.canvas-card')).not.toBeNull()
  expect(document.querySelector('.render-figure')).toBeNull()
})

test("each render's theme stays on its own page: the page stores none, so pages drawing side by side in other themes keep theirs", async () => {
  const { PAPER_KEY, applyTheme } = await import('../../src/lib/theme')
  localStorage.removeItem(PAPER_KEY)
  const res = await draw(request({ figure: true, theme: { paper: 'dark', accent: 'iris' } }))
  expect(res.error).toBeUndefined()
  expect(document.documentElement.dataset.paper).toBe('dark')
  expect(localStorage.getItem(PAPER_KEY)).toBeNull()
  // another page of the pool draws in Neutral, which a stored theme would have carried here
  localStorage.setItem(PAPER_KEY, 'neutral')
  window.dispatchEvent(new StorageEvent('storage', { key: PAPER_KEY, newValue: 'neutral' }))
  applyTheme()
  expect(document.documentElement.dataset.paper).toBe('dark')
  localStorage.removeItem(PAPER_KEY)
})
