// @vitest-environment jsdom
// A card's Export, in its hover row (src/canvas/CardExport.tsx): the files of the card's figure, listed when the menu
// opens, each saved under the name the server gives it; a file this machine cannot make stays in the menu, disabled,
// with the server's reason, and an export that fails says why in a toast.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

type Listed = { id: string; name: string; ext: string; ok: boolean; why?: string }
const FILES: Listed[] = [
  { id: 'png', name: 'PNG', ext: 'png', ok: true },
  { id: 'webp', name: 'WebP', ext: 'webp', ok: true },
  { id: 'pdf', name: 'PDF', ext: 'pdf', ok: true },
  { id: 'svg', name: 'SVG', ext: 'svg', ok: true },
]
const WHY = 'Needs a browser: the headless Chromium is not installed'

let asked: string[] = []
let listed: Listed[] = FILES
let saved: string[] = []
let toasts: string[] = []
let offToast = () => {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const made = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }

beforeEach(() => {
  asked = []
  saved = []
  toasts = []
  listed = FILES
  offToast = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    asked.push(u)
    if (u.endsWith('/ws/ws/cards/c1/figure')) return json({ files: listed })
    if (u.endsWith('/figure/svg')) return new Response('<svg/>', { status: 200, headers: { 'x-export-name': 'which-model-scores-best.svg' } })
    if (u.endsWith('/figure/pdf')) return json({ detail: WHY }, 409)
    return json({})
  })
  URL.createObjectURL = () => 'blob:made-up'
  URL.revokeObjectURL = () => undefined
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download)
  })
})
afterEach(() => {
  offToast()
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  URL.createObjectURL = made.create
  URL.revokeObjectURL = made.revoke
})

const ctx = { ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }
const noop = () => undefined
const cell = { id: 'c1', kind: 'note', title: 'Which model scores best?', created_by: 'model', ts: '2026-11-10T00:00:00Z', payload: { text: 'alpha' }, status: 'ok' } as Cell

async function card() {
  await mount(
    <CanvasContext.Provider value={ctx}>
      <CellCard
        cell={cell} x={0} y={0} w={420} h={null} selected alone collapsed={false} deck={false} dragging={false} detailOpen={false} editing={null} z={1}
        register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop} onAction={noop} onEdit={noop}
      />
    </CanvasContext.Provider>,
  )
  await settle()
}
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click())
  await settle()
}
const items = () => [...document.body.querySelectorAll<HTMLElement>('.menu-item')]
/** What `ok` gives once it gives something, within `ms`. */
async function until<T>(ok: () => T, ms = 2000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    const got = ok()
    if (got) return got as NonNullable<T>
    if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms in vain`)
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  }
}

test("the card's Export lists its figure's files when it opens, and saves the one picked under the server's name", async () => {
  await card()
  await click(q('.bcell-acts [aria-label="Export"]'))
  expect(asked.filter((u) => u.endsWith('/figure'))).toHaveLength(1)
  expect(items().map((b) => [b.querySelector('.menu-item-label')?.textContent, b.querySelector('.menu-item-note')?.textContent])).toEqual([
    ['PNG', '.png'],
    ['WebP', '.webp'],
    ['PDF', '.pdf'],
    ['SVG', '.svg'],
  ])
  await click(q('.menu-item[data-item="svg"]'))
  await until(() => saved.length || toasts.length)
  expect(toasts).toEqual([])
  expect(asked.some((u) => u.endsWith('/ws/ws/cards/c1/figure/svg'))).toBe(true)
  expect(saved).toEqual(['which-model-scores-best.svg'])
  // an export that fails says why
  await click(q('.bcell-acts [aria-label="Export"]'))
  await click(q('.menu-item[data-item="pdf"]'))
  await until(() => toasts.length)
  expect(toasts).toEqual([`Could not export PDF. ${WHY}`])
  expect(saved).toHaveLength(1)
})

test('a file this machine cannot make stays in the menu, disabled, with the reason as its tip', async () => {
  listed = FILES.map((f) => ({ ...f, ok: false, why: WHY }))
  await card()
  await click(q('.bcell-acts [aria-label="Export"]'))
  const pdf = q('.menu-item[data-item="pdf"]')!
  expect(pdf.getAttribute('aria-disabled')).toBe('true')
  await act(async () => pdf.focus())
  expect(q('[role="tooltip"]')?.textContent).toBe(WHY)
  await click(pdf)
  expect(asked.some((u) => u.endsWith('/figure/pdf'))).toBe(false)
})
