// @vitest-environment jsdom
// A report figure (src/report/FigureBlock.tsx) mounted while its tab is hidden draws its card once the tab is shown.
// A figure draws its output at the width it measures. Under jsdom nothing is laid out, so the test gives elements the
// widths a browser gives them: 0 while the tab is hidden, and 0 for an empty figure body, which report.css hides
// (`.wu-fig-body:empty`). A hidden figure measured at 0 must still draw once shown, and hiding it again keeps what it
// drew.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FigureView } from '../../src/report/FigureBlock.tsx'
import type { WriteupFigure } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let hidden = true
const observers: { cb: ResizeObserverCallback; els: Set<Element> }[] = []

class FakeResizeObserver {
  private entry: { cb: ResizeObserverCallback; els: Set<Element> }
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, els: new Set() }
    observers.push(this.entry)
  }
  observe(el: Element) {
    this.entry.els.add(el)
  }
  unobserve(el: Element) {
    this.entry.els.delete(el)
  }
  disconnect() {
    this.entry.els.clear()
  }
}

/** Every observed element whose width changed is reported, as a browser does after a layout. */
const layout = async () => {
  await act(async () => {
    for (const o of observers) if (o.els.size) o.cb([...o.els].map((target) => ({ target }) as ResizeObserverEntry), o as never)
  })
  await settle()
}

beforeEach(() => {
  hidden = true
  observers.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (hidden || !this.isConnected) return 0
    if (this.classList.contains('wu-fig-body') && this.childElementCount === 0) return 0
    return 480
  })
  const cell = { id: 'abcd1234', title: 'Reviews per agent', takeaway: 'Three agents reviewed a PR.', outputs: [{ 'text/plain': 'agent-01 2\nagent-02 1' }] }
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ kind: 'cell', record: cell }), { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const FIGURE: WriteupFigure = { id: 'f1', cell: 'card:abcd1234', caption: 'Three agents reviewed a PR.' } as WriteupFigure

describe('a report figure mounted in a hidden tab', () => {
  test('draws its card once the tab is shown, and keeps it when the tab is hidden again', async () => {
    const el = await mount(<FigureView ws="w-hidden" figure={FIGURE} />)
    await settle()
    await layout()
    const body = () => el.querySelector('.wu-fig-body')!
    expect(body().textContent).toBe('')
    hidden = false
    await layout()
    expect(body().textContent).toMatch(/agent-01 2/)
    hidden = true
    await layout()
    expect(body().textContent).toMatch(/agent-01 2/)
  })
})
