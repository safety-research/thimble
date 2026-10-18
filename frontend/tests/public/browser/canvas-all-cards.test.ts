// Every card of the workspace is on the canvas at Fit, drawn by the real Canvas in a real browser with no frame kept open
// or shut in this browser: a group main made under the analyst's frame and a thread's group beside one of its cards,
// three cards each (bug hunt L3: every frame but Your work started collapsed, so a group said 3 and drew 1, and the
// others stayed out until a chip opened the frame). A frame the analyst collapses stays collapsed after a reload.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
let script = ''
let css = ''

const TS = '2026-10-10T12:00:00+00:00'
const group = (id: string, title: string, parent: string | null, extra: object = {}) => ({ id, title, parent, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const note = (id: string, notebook: string, n: number, by = 'model') => ({ id, notebook, kind: 'note', title: `Which kettle boiled ${n} times?`, takeaway: `Kettle ${n} boiled ${n + 3} times.`, created_by: by, ts: TS, payload: { text: `Kettle ${n} boiled on ${n + 1} mornings.` }, text: `Kettle ${n} boiled on ${n + 1} mornings.` })

const GROUPS = [
  group('work', 'Your work', null, { created_by: 'user' }),
  group('who', 'Who boils the kettles', 'work'),
  group('thr', 'main/Why did kettle 2 boil twice?', 'who', { anchor: 'k1', chat: 'thr' }),
  group('deck', 'Orientation', null, { role: 'exploration' }),
]
const CELLS = [
  note('k1', 'who', 1),
  note('k2', 'who', 2),
  note('k3', 'who', 3),
  note('t1', 'thr', 4, 'chat:thr'),
  note('t2', 'thr', 5, 'chat:thr'),
  note('t3', 'thr', 6, 'chat:thr'),
  note('o1', 'deck', 7, 'orient'),
  note('o2', 'deck', 8, 'orient'),
]
const CANVAS = { groups: GROUPS, cells: CELLS }

async function open(): Promise<void> {
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="k1"]')
  await page.waitForTimeout(300)
  await page.click('.bctl-fit')
  await page.waitForTimeout(200)
}

/** The cards drawn whole in the window, which the canvas fills, by id. */
const inView = (): Promise<string[]> =>
  page.evaluate(
    (ids) =>
      ids.filter((id) => {
        const r = document.querySelector(`[data-cell="${id}"]`)?.getBoundingClientRect()
        return !!r && r.width > 0 && r.x >= -0.5 && r.y >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5
      }),
    CELLS.map((c) => c.id),
  )

beforeAll(async () => {
  script = await bundle(
    'canvas-all-cards',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1260, height: 950 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test('Fit shows every card of every frame, also after a reload', async () => {
  await open()
  assert.deepEqual(await inView(), CELLS.map((c) => c.id))
  await open()
  assert.deepEqual(await inView(), CELLS.map((c) => c.id))
})

test('a frame the analyst collapses draws its first card and stays collapsed after a reload', async () => {
  await open()
  await page.click('[data-group="who"] > .frame-title')
  await page.waitForTimeout(600)
  await open()
  const shown = await inView()
  assert.ok(shown.includes('k1'), 'the collapsed frame draws its first card')
  assert.ok(!shown.includes('k2') && !shown.includes('k3'), 'the collapsed frame draws only its first card')
  assert.ok(shown.includes('o1') && shown.includes('o2'), 'the other frames stay open')
})
