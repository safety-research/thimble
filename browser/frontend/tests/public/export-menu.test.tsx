// @vitest-environment jsdom
// The report's Export (src/report/ExportMenu.tsx): the formats the server offers, Claude artifact among them noted by
// what it gives, a link. Claude artifact asks the server to have main publish the report (POST …/export/artifact) and
// says it is exporting until main's turn ends (the stream's `export` record): the artifact's link then comes in a toast,
// and when nothing was published the artifact page downloads in its place, as it does at once when the server can
// publish nothing here.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import { ExportMenu } from '../../src/report/ExportMenu.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const FORMATS = [
  { id: 'markdown', name: 'Markdown', ext: 'md', ok: true },
  { id: 'html', name: 'HTML', ext: 'html', ok: true },
  { id: 'pdf', name: 'PDF', ext: 'pdf', ok: true },
  { id: 'artifact', name: 'Claude artifact', ext: 'html', note: 'link', ok: true },
]
const LINK = 'https://claude.ai/code/artifact/5f3a1c2e-7b4d-4c8a-9e21-0d6b7f8a9c10'
const PAGE = 'Test-runs-per-agent.artifact.html'

let asked: string[] = []
let saved: string[] = []
let toasts: { text: string; link?: { href: string; label: string }; kind?: string }[] = []
let publishing = true
let offToast = () => {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const made = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }

beforeEach(() => {
  asked = []
  saved = []
  toasts = []
  publishing = true
  offToast = bus.on('toast', (t) => void toasts.push(t))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    asked.push(`${init?.method ?? 'GET'} ${u.replace(/^.*\/types\//, '')}`)
    if (u.endsWith('/report/exports')) return json({ formats: FORMATS })
    if (u.endsWith('/export/artifact') && init?.method === 'POST') return json({ publishing })
    if (u.endsWith('/export/artifact')) return new Response('<title>Test runs</title>', { status: 200, headers: { 'x-export-name': PAGE } })
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

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel)
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
async function exportArtifact() {
  await mount(<ExportMenu ws="ws" slug="report" page={false} />)
  await click(q('.wu-export'))
  await click(q('.menu-item[data-item="artifact"]'))
  await until(() => asked.includes('POST report/export/artifact'))
}
const ended = (status: string, link?: string) => act(async () => dispatch({ type: 'export', doc: 'report', format: 'artifact', status, ...(link ? { link } : {}) }))

test('Export lists Claude artifact, noted as a link, after the files', async () => {
  await mount(<ExportMenu ws="ws" slug="report" page={false} />)
  await click(q('.wu-export'))
  expect(items().map((b) => [b.querySelector('.menu-item-label')?.textContent, b.querySelector('.menu-item-note')?.textContent])).toEqual([
    ['Markdown', '.md'],
    ['HTML', '.html'],
    ['PDF', '.pdf'],
    ['Claude artifact', 'link'],
  ])
})

test("Claude artifact says it is exporting until main's turn ends, and the artifact's link comes in a toast", async () => {
  await exportArtifact()
  expect(q('.wu-export')?.textContent).toBe('Exporting Claude artifact')
  // a record of another document, or one replayed from the history, ends nothing
  await act(async () => dispatch({ type: 'export', doc: 'story', format: 'artifact', status: 'published', link: LINK }))
  await act(async () => dispatch({ type: 'export', doc: 'report', format: 'artifact', status: 'published', link: LINK }, true))
  await settle()
  expect(q('.wu-export')?.textContent).toBe('Exporting Claude artifact')
  await ended('published', LINK)
  await until(() => toasts.length)
  // the toast says the artifact is private and promises no sharing: the person's claude.ai settings decide it
  expect(toasts).toEqual([{ text: 'Published as a private Claude artifact', link: { href: LINK, label: LINK.slice('https://'.length) } }])
  expect(saved).toEqual([])
  expect(q('.wu-export')?.textContent).toBe('Export')
})

test('when main publishes nothing, the artifact page downloads in its place', async () => {
  await exportArtifact()
  await ended('failed')
  await until(() => saved.length)
  expect(saved).toEqual([PAGE])
  expect(asked.at(-1)).toBe('GET report/export/artifact')
  expect(toasts).toEqual([])
})

test('where the server can publish nothing, the artifact page downloads at once', async () => {
  publishing = false
  await exportArtifact()
  await until(() => saved.length)
  expect(saved).toEqual([PAGE])
  expect(toasts).toEqual([])
  expect(q('.wu-export')?.textContent).toBe('Export')
})
