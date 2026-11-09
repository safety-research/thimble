// @vitest-environment jsdom
// The tour's example Report (src/example/main.tsx, the page example.html?pane=report): thimble's own Report and Comments
// sidebar over the example folder's report, used as in a workspace. Its bar, its margin of comments, a citation's
// evidence, History and Export's menu work; Revise, a thread from a comment and Ask for comments need Claude, and say so
// in a toast. The frame's requests are answered by the example (src/example/shield.ts): none reaches the network, and the
// browser's storage keeps nothing of it.
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import type { Writeup } from '../../src/lib/types.ts'
import { PANES_KEY, type ExampleFrame } from '../../src/example/panes.ts'

// the block editor needs a real browser: in its place, the document's title and its sentences as prose, with their
// citations and the tints of the comments on them, as the editor's decorations mark them
vi.mock('../../src/report/Editor', async () => {
  const { createElement } = await import('react')
  const { Prose } = await import('../../src/report/Prose.tsx')
  type Props = { ws: string; slug: string; doc: Writeup; flags: Map<string, { cids: string[]; color: string; active: boolean }> }
  return {
    ReportEditor: ({ ws, slug, doc, flags }: Props) =>
      createElement(
        'div',
        { className: 'wu-editor' },
        createElement('h1', null, doc.title),
        ...doc.sections.map((s) => createElement('div', { key: s.id, className: 'bn-block-content' }, createElement(Prose, { ws, slug, sentences: s.paragraphs.flatMap((p) => p.sentences), flags }))),
      ),
  }
})
vi.mock('../../src/files/Ruler', () => ({ PageRuler: () => null }))

const network: string[] = []
let frame: ExampleFrame
const storage = window.localStorage

/** Waits up to `ms` for `ok`, letting React and the example's answers run; what `ok` gave. */
async function until<T>(ok: () => T, ms = 4000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    const got = ok()
    if (got) return got as NonNullable<T>
    if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms in vain`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const button = (scope: string, words: string) => $$(`${scope} button`).find((b) => text(b) === words)
const toasts = () => $$('.shell-toast .shell-toast-text').map(text)
/** A field's value set as a person types it, which React hears before the next key. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!
  own.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))
}

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => undefined
  // the network: any request that reaches it is a failure of the example's walls
  const reached = async (input: RequestInfo | URL) => {
    network.push(String(input))
    throw new TypeError('the network was reached')
  }
  vi.stubGlobal('fetch', reached)
  window.fetch = reached
  window.history.replaceState(null, '', '/example.html?pane=report')
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  await import('../../src/example/main.tsx')
  frame = await until(() => (window as unknown as Record<string, ExampleFrame | undefined>)[PANES_KEY])
  frame.place({ x: 0, y: 0, width: 1200, height: 800 }, null)
  await until(() => frame.ready())
})
afterAll(() => vi.unstubAllGlobals())

test('the Report shows the example report: its bar, its page, a comment a click opens, and a citation’s evidence', async () => {
  // the bar as a written report has it, with the example's badge in its middle
  expect(text($('.example-report .wu-types'))).toBe('Report')
  expect(['History', 'Export', 'Revise'].map((w) => !!button('.example-report .wu-bar', w))).toEqual([true, true, true])
  expect(text($('.example-report .wu-bar-spacer .example-tag'))).toBe('Example')
  expect(text($('.example-report .wu-editor h1'))).toBe('How three agents fixed the gift box total')
  // a click on a tinted passage opens its comment: the explainer of the member discount
  const tinted = await until(() => $$('.example-report [data-cids]').find((s) => text(s).startsWith('Reading the checkout')))
  tinted.click()
  const card = await until(() => $('.example-report .wu-rail .wu-cm.wu-cm-active'))
  expect(text(card.querySelector('.wu-cm-name'))).toBe('Explainers')
  expect(text(card.querySelector('.wu-cm-statement'))).toMatch(/^member discount: the 10% that members/)
  // its reply would open a thread with Claude
  const reply = card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
  await type(reply, 'Where is the discount set?')
  reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(() => toasts().some((t) => t === "Could not open a thread. This is the tour's example data. Claude does this in your own workspace."))
  // a citation's evidence: the record it cites, as the server resolved it
  const cite = $$('.example-report .refchip-value').find((c) => text(c) === '48.60')!
  cite.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  cite.dispatchEvent(new MouseEvent('mouseenter'))
  const pop = await until(() => $('.refchip-pop .refchip-pop-quote, .refchip-pop .refchip-pop-body:not(:has(.spinner))'))
  expect(text(pop)).toContain('a member pays 48.60 for a 48.00 tin in a gift box')
  expect(network).toEqual([])
})

test('History lists the drafts; Export’s formats stay in the frame; Revise needs Claude', async () => {
  button('.example-report .wu-bar', 'History')!.click()
  const rows = await until(() => ($$('.wu-history-row').length === 2 ? $$('.wu-history-row') : null))
  expect(rows.map((r) => text(r.querySelector('.wu-history-n')))).toEqual(['Draft 2', 'Draft 1'])
  button('.example-report .wu-bar', 'History')!.click()
  button('.example-report .wu-bar', 'Export')!.click()
  const items = await until(() => ($$('.menu-item').length === 3 ? $$('.menu-item') : null))
  expect(items.map((i) => [text(i).replace(/\.\w+$/, ''), i.getAttribute('aria-disabled')])).toEqual([
    ['Markdown', 'true'],
    ['HTML', 'true'],
    ['PDF', 'true'],
  ])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => !$('.menu-item'))
  // Revise asks first, then a writer would start
  button('.example-report .wu-bar', 'Revise')!.click()
  ;(await until(() => button('.wu-revise', 'Revise'))).click()
  await until(() => toasts().includes("Could not ask for the report. This is the tour's example data. Claude does this in your own workspace."))
  expect(network).toEqual([])
})

test('the Comments sidebar lists the checks; Ask for comments needs Claude; nothing is kept in the browser', async () => {
  frame.place({ x: 0, y: 0, width: 800, height: 800 }, { x: 812, y: 0, width: 388, height: 800 })
  await until(() => $$('.example-side .lside-section[data-section="comments"] .lside-row').length === 3)
  // each check with its open comments on the report
  expect($$('.example-side .lside-row .lside-name').map(text)).toEqual(['Heads up1', 'Explainers1', 'Judgment calls0'])
  ;(await until(() => button('.example-side', 'Ask for comments'))).click()
  const name = await until(() => document.querySelector<HTMLInputElement>('.check-card input[aria-label="Name"]'))
  await type(name, 'Money')
  await type(document.querySelector<HTMLTextAreaElement>('.check-card textarea[aria-label="Prompt"]')!, 'Comment on every price the report gives.')
  ;(await until(() => button('.check-card', 'Run')))!.click()
  await until(() => toasts().includes("Could not ask for comments. This is the tour's example data. Claude does this in your own workspace."))
  expect(network).toEqual([])
  expect(Object.keys(storage).filter((k) => k.includes('fernhill'))).toEqual([])
})
