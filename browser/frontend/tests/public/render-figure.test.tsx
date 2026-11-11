// @vitest-environment jsdom
// The card harness's page draws a figure for an export as the report's page draws it (src/render.tsx, `figure`): the
// card's art alone, at the figure's width and scaled by `zoom`, without the card face around it (its question and
// takeaway, which the export sets as text).
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

test('without figure the page draws the card face, as the card check reads it', async () => {
  const res = await draw(request({}))
  expect(res.error).toBeUndefined()
  expect(document.querySelector('article.canvas-card')).not.toBeNull()
  expect(document.querySelector('.render-figure')).toBeNull()
})
