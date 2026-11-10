// @vitest-environment jsdom
// A report figure in a figure style (src/report/FigureBlock.tsx FigureInStyle): thimble's draws the card as the report
// always has; Blog's is the Blog figure, headed by the caption in plain words over the card's question; Paper's is the
// chart with its caption `Figure N. Takeaway. Question` under it. A caption that only repeats the card's question, as a
// figure written without one keeps, gives way to the card's takeaway, and opening its field and leaving it unchanged
// saves nothing. A Blog figure heads with the takeaway's first sentence (src/figures/Figure.tsx), or with the headline
// and subtitle an export gives it. All data is made up.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { Figure } from '../../src/figures/Figure.tsx'
import { api } from '../../src/lib/api'
import { setFigures, type FigureStyle } from '../../src/lib/theme'
import type { Cell } from '../../src/lib/types'
import { FigureBlock } from '../../src/report/FigureBlock.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom lays nothing out: the figure draws its body only once it has a width
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
})

const card: Cell = {
  id: 'c1',
  notebook: 'main',
  kind: 'code',
  title: 'How many runs end early?',
  takeaway: 'Most runs end on [[day 2|card:c1]].',
  created_by: 'main',
  ts: '2026-10-15T10:00:00Z',
  status: 'ok',
  outputs: [{ 'text/plain': 'a made-up chart' }],
}

beforeEach(() => {
  vi.spyOn(api, 'resolveRef').mockImplementation(async () => ({ kind: 'cell', record: { ...card } }) as never)
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  setFigures('thimble')
})

let n = 0
/** A figure block of card c1 with `caption`, drawn in figure style `style`, in an editor whose updateBlock is recorded. */
async function figure(style: FigureStyle, caption: string) {
  setFigures(style)
  const editor = { updateBlock: vi.fn(), removeBlocks: vi.fn() }
  window.history.replaceState(null, '', `/?ws=w-style-${++n}`)
  const el = await mount(<FigureBlock block={{ id: 'f1', props: { cell: 'card:c1', caption } }} editor={editor as never} />)
  await settle()
  return { el, editor }
}

test("thimble's figure is the card as the report draws it, Blog's the Blog figure and Paper's the chart over its caption", async () => {
  const thimble = (await figure('thimble', 'Early ends cluster in **one** topic.')).el
  expect(thimble.querySelector('.wu-fig-q')?.textContent).toBe('How many runs end early?')
  expect(thimble.querySelector('.figure')).toBeNull()

  const blog = (await figure('blog', 'Early ends cluster in **one** topic.')).el
  expect(blog.querySelector('figure.wu-fig.wu-fig-blog')).not.toBeNull()
  expect(blog.querySelector('.wu-fig-q')).toBeNull()
  // the headline is the caption in plain words, with no period at its end, over the card's question
  expect(blog.querySelector('.figure-blog .figure-title')?.textContent).toBe('Early ends cluster in one topic')
  expect(blog.querySelector('.figure-blog .figure-sub')?.textContent).toBe('How many runs end early?')
  expect(blog.querySelector('.figure-blog .figure-chart')?.textContent).toContain('a made-up chart')

  const paper = (await figure('paper', 'Early ends cluster in **one** topic.')).el
  expect(paper.querySelector('figure.wu-fig.wu-fig-paper .figure-paper')).not.toBeNull()
  // its number is the page's count of figures (report.css), which jsdom does not draw
  const cap = paper.querySelector('figcaption.wu-fig-cap')!
  expect(cap.querySelector('b')?.textContent).toBe('Early ends cluster in one topic.')
  expect(cap.textContent).toBe('Early ends cluster in one topic. How many runs end early?')
})

test("a caption that only repeats the card's question gives way to its takeaway, and a field left unchanged saves nothing", async () => {
  const blog = await figure('blog', 'How many runs end early?')
  const title = blog.el.querySelector<HTMLElement>('.figure-title [role="textbox"]')!
  expect(title.textContent).toBe('Most runs end on day 2')
  await act(async () => title.click())
  const field = blog.el.querySelector<HTMLElement>('.figure-title .refedit')!
  expect(field.getAttribute('aria-label')).toBe('Caption')
  await act(async () => field.blur())
  expect(blog.editor.updateBlock).not.toHaveBeenCalled()

  const paper = await figure('paper', 'How many runs end early?')
  expect(paper.el.querySelector('figcaption.wu-fig-cap b')?.textContent).toBe('Most runs end on day 2.')
})

test("a Blog figure heads with the takeaway's first sentence, or the headline and subtitle given, and so does a caption that is the takeaway", async () => {
  const long: Cell = { ...card, takeaway: 'Most runs end on [[day 2|card:c1]]. The rest end on day 3, e.g. run 7.' }
  const label = { concept: null, error: null } as never
  const drawn = await mount(<Figure cell={long} style="blog" label={label} />)
  expect(drawn.querySelector('.figure-title')?.textContent).toBe('Most runs end on day 2')
  expect(drawn.querySelector('.figure-sub')?.textContent).toBe('How many runs end early?')
  // an export's own headline and subtitle (backend card_export export_card's title and subtitle)
  const given = await mount(<Figure cell={long} style="blog" label={label} headline="Runs end early" subtitle="The day each run ended, 40 runs" />)
  expect(given.querySelector('.figure-title')?.textContent).toBe('Runs end early')
  expect(given.querySelector('.figure-sub')?.textContent).toBe('The day each run ended, 40 runs')

  // in a report, a caption that says the card's takeaway word for word heads with its first sentence, as the card's
  // takeaway does; a caption of its own heads whole
  vi.spyOn(api, 'resolveRef').mockImplementation(async () => ({ kind: 'cell', record: { ...long } }) as never)
  const same = await figure('blog', long.takeaway!)
  expect(same.el.querySelector('.figure-title')?.textContent).toBe('Most runs end on day 2')
  const own = await figure('blog', 'Early ends cluster in one topic. Day 3 has the rest.')
  expect(own.el.querySelector('.figure-title')?.textContent).toBe('Early ends cluster in one topic. Day 3 has the rest')
})
