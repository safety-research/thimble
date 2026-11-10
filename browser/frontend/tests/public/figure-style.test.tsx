// @vitest-environment jsdom
// The figure style (src/lib/theme.ts FigureStyle): thimble's own by default, Blog or Paper, kept in localStorage as
// `thimble:figures` and applied as `data-figures` on <html>, chosen in the theme popover's Figures row.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FIGURES_KEY, readFigures, setFigures } from '../../src/lib/theme.ts'
import { ThemePopover } from '../../src/shell/ThemePopover.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  act(() => setFigures('thimble'))
  unmountAll()
  vi.unstubAllGlobals()
})

test('a stored figure style is read as it is, and anything else as thimble', () => {
  expect(readFigures('blog')).toBe('blog')
  expect(readFigures('paper')).toBe('paper')
  expect(readFigures('thimble')).toBe('thimble')
  for (const stored of [null, '', 'Blog', 'neon', 'warm']) expect(readFigures(stored)).toBe('thimble')
})

test('a figure style chosen is kept in storage and set on the page, where the charts read it', () => {
  setFigures('paper')
  expect(window.localStorage.getItem(FIGURES_KEY)).toBe('paper')
  expect(document.documentElement.getAttribute('data-figures')).toBe('paper')
  // the paper and the accent stay as they were
  expect(document.documentElement.getAttribute('data-paper')).toBe('warm')
  expect(document.documentElement.getAttribute('data-accent')).toBe('iris')
})

test('the theme popover names the figure styles in a Figures row, and a pick applies at once', async () => {
  const anchor = document.body.appendChild(document.createElement('button'))
  await mount(<ThemePopover anchor={anchor} open onClose={() => {}} />)
  await settle()
  const row = document.body.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Figures"]')!
  expect(Array.from(row.querySelectorAll('[role="radio"]'), (b) => b.textContent)).toEqual(['thimble', 'Blog', 'Paper'])
  expect(row.querySelector('[aria-checked="true"]')?.textContent).toBe('thimble')
  const blog = Array.from(row.querySelectorAll<HTMLElement>('[role="radio"]')).find((b) => b.textContent === 'Blog')!
  await act(async () => blog.click())
  await settle()
  expect(document.documentElement.getAttribute('data-figures')).toBe('blog')
  expect(window.localStorage.getItem(FIGURES_KEY)).toBe('blog')
  expect(row.querySelector('[aria-checked="true"]')?.textContent).toBe('Blog')
})
