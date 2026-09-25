// The Report tab while a writer runs (src/report/ReportTab.tsx), against routed API answers: the primary action reads
// Writing, never Revise, until the writer's session ends, and says nothing of a permission prompt the writer waits on,
// which is on the permission card above the chat's composer (tests/public/browser/orientation-thread.test.ts).
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []

const T = (s: any) => `2026-09-24T10:00:${String(s).padStart(2, '0')}Z`
const chat = (id: string, extra: object = {}): any => ({ id, kind: 'agent', role: 'step', title: id, created_at: T(0), parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'running', ...extra })
const ask = (id: any, since: any) => ({ id, tool: 'Glob', what: '/elsewhere', since })


// what the routes answer, changed by the tests
const state = { writer: chat('w1', { role: 'writer', title: 'Write report', doc: 'report', permissions: [ask('p1', T(5))] }) }

beforeAll(async () => {
  script = await bundle('waiting', [
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ReportTab } from '${src('report/ReportTab.tsx')}'`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `window.__bus = bus`,
      `window.__mount = () => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column'; document.body.appendChild(el); flushSync(() => createRoot(el).render(<ReportTab ws="mini" active={false} />)) }`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/ws/mini/chats') return json([{ ...chat('main'), kind: 'main', role: 'main', parent: null }, ...(state.writer ? [state.writer] : [])])
    if (p === '/api/ws/mini/investigations/main/types') return json({ report: { exists: true, renderer: 'document', name: 'Report' } })
    if (p === '/api/ws/mini/investigations/main/types/report') return json({ title: 'Refunds', frame: false, generation: 1, sections: [] })
    if (p === '/api/ws/mini/filters') return json({})
    if (p.startsWith('/api/')) return json({ detail: 'no' }, 404)
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=mini')
  await addStyles(page, ['tokens', 'base', 'components', 'spinner', 'report'])
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test('while a writer of the document runs, the Report tab reads Writing, never Revise, and no "waiting for you" while it asks', async () => {
  await page.evaluate(() => (window as any).__mount())
  const primary = page.locator('.wu-bar .btn-primary')
  await page.waitForFunction(() => document.querySelector('.wu-bar .btn-primary')?.textContent?.trim() === 'Writing', null, { timeout: 5000 })
  assert.equal((await primary.innerText()).trim(), 'Writing', 'the report is written, yet its writer runs')
  assert.doesNotMatch(await page.locator('.wu-bar').innerText(), /waiting for you/, 'the prompt is on the permission card, not here')
  // its prompt answered, it writes on: Writing
  state.writer = { ...state.writer, permissions: [] }
  await page.evaluate(() => (window as any).__bus.emit('chat', { chat: 'w1' }))
  await page.waitForTimeout(400)
  assert.equal((await primary.innerText()).trim(), 'Writing')
  // it ended: the written report reads Revise
  state.writer = { ...state.writer, status: 'done' }
  await page.evaluate(() => (window as any).__bus.emit('chat', { chat: 'w1' }))
  await page.waitForTimeout(400)
  assert.equal((await primary.innerText()).trim(), 'Revise')
  assert.deepEqual(pageErrors, [])
})
