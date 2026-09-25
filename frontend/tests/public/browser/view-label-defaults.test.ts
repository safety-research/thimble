// A view's labels by default (src/files/FilesTab.tsx useViewDefaults, LabelsPane.tsx, LabelPrompt.tsx): the first time
// a view opens while no label that marks its files is on, the orientation's labels over those files are turned on,
// once; the view's Labels pane lists the labels that mark its files first; beside a view whose files no label marks,
// the pane suggests nothing, and a label described in Label from prompt applies to the files the view claims. The Files
// pane is mounted whole in a headless Chromium page against routed API answers; the labels and views are invented.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const sent: any[] = []

const C = (name: any, color: any, highlight: any) => ({ name, color, highlight })
const label = (id: string, name: string, color: number, by: string, ts: string) => ({ id, name, description: '', unit: 'record', marks: 'record', kind: 'regex', spec: 'x', labels: [name, 'no match'], classes: [C(name, color, true), C('no match', 0, false)], created_by: by, ts, shown: false, glob: '*.jsonl' })
const concepts = new Map([
  ['u1', label('u1', 'mine on posts', 1, 'user', '2026-09-24T09:00:00Z')],
  ['o2', label('o2', 'orient on events', 2, 'chat:or1', '2026-09-24T09:30:00Z')],
  ['o1', label('o1', 'orient on posts', 3, 'chat:or1', '2026-09-24T10:00:00Z')],
])
// where each label left rows (GET /labels/presence): the posts file for u1 and o1, the events file for o2
const PRESENCE = [
  { concept_id: 'u1', paths: { 'posts.jsonl': { 'mine on posts': 4 } } },
  { concept_id: 'o1', paths: { 'posts.jsonl': { 'orient on posts': 9 } } },
  { concept_id: 'o2', paths: { 'logs/events.jsonl': { 'orient on events': 2 } } },
]
const view = (slug: string, name: string, claims: string[], first: string) => ({ slug, origin: 'workspace', name, why: '', claims, accepts: [], declares: [], default: false, libs: [], built: '2026-09-24T10:00:00Z', ok: true, forms: [], first_file: first })
const VIEWS = [view('board', 'Board', ['posts.jsonl'], 'posts.jsonl'), view('clock', 'Clock', ['runs/*/clock.jsonl'], 'runs/r1/clock.jsonl')]
const LISTING = { path: '', files: [{ path: 'posts.jsonl', kind: 'jsonl', size_bytes: 10 }], folders: [], n_files: 1 }
const DRAFT = { name: 'late ticks', over: 'files', marks: 'record', glob: 'runs/*/clock.jsonl', kind: 'code', text: 'def label(u):\n    return ("late" if u.get("late") else "on time", 1.0)', values: ['late', 'on time'] }

beforeAll(async () => {
  script = await bundle('view-label-defaults', [
    `import { createRoot } from 'react-dom/client'`,
    `import { FilesTab } from '${src('files/FilesTab.tsx')}'`,
    `const el = document.createElement('div')`,
    `el.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:700px;display:flex;flex-direction:column'`,
    `document.body.appendChild(el)`,
    `createRoot(el).render(<FilesTab ws="mini" active />)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (body: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    const body = req.postData() ? JSON.parse(req.postData()) : null
    // what the pane sends about labels (the telemetry's posts left out)
    if (req.method() !== 'GET' && url.pathname.startsWith('/api/ws/mini/concepts')) sent.push({ method: req.method(), path: url.pathname, body })
    const put = url.pathname.match(/^\/api\/ws\/mini\/concepts\/(\w+)$/)
    if (req.method() === 'PUT' && put) {
      concepts.set(put[1], { ...concepts.get(put[1])!, ...body })
      return json(concepts.get(put[1]))
    }
    if (req.method() === 'POST' && url.pathname === '/api/ws/mini/concepts/draft') return json(DRAFT)
    if (req.method() === 'POST' && url.pathname === '/api/ws/mini/concepts') {
      const k = { ...label('k9', body.name, 4, 'user', '2026-09-24T11:00:00Z'), ...body }
      concepts.set('k9', k)
      return json(k)
    }
    if (req.method() === 'POST' && /\/apply$/.test(url.pathname)) return json({ status: 'running', run_id: 'r1', started: '2026-09-24T11:00:00Z', done: 0, total: 5 })
    if (req.method() !== 'GET' && url.pathname.startsWith('/api/')) return json({ ok: true })
    if (url.pathname === '/api/ws/mini/concepts') return json([...concepts.values()])
    if (url.pathname.startsWith('/api/ws/mini/concepts/')) return json(concepts.get(url.pathname.split('/').pop()!) ?? {})
    if (url.pathname === '/api/ws/mini/labels/presence') return json(PRESENCE)
    if (url.pathname === '/api/ws/mini/chats') return json([{ id: 'main', kind: 'main', role: 'main', title: 'main' }, { id: 'or1', kind: 'agent', role: 'orient', title: 'orient' }])
    if (url.pathname === '/api/ws/mini/views') return json(VIEWS)
    if (url.pathname === '/api/ws/mini/views/proposals') return json([])
    if (/^\/api\/ws\/mini\/views\/\w+\/frame$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><p>view</p></body></html>' })
    if (url.pathname === '/api/corpora/mini/sources') return json(LISTING)
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"no"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=mini')
  await addStyles(page, ['tokens', 'base', 'components', 'shell', 'files'])
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.files-label')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const listed = () => page.locator('.files-side-labels .files-label-toggle').evaluateAll((bs: any) => bs.map((b: any) => [b.textContent, b.getAttribute('aria-pressed')]))
const pick = async (name: string) => {
  await page.locator('.files-views .seg-opt', { hasText: name }).click()
  await page.waitForTimeout(400)
}

test("a view opened the first time turns on the orientation's labels over its files, once, and lists its own labels first", async () => {
  sent.length = 0
  await pick('Board')
  await page.waitForSelector('.files-side-labels')
  assert.deepEqual(sent, [{ method: 'PUT', path: '/api/ws/mini/concepts/o1', body: { shown: true } }], "only the orientation's label over the view's file")
  assert.deepEqual(await listed(), [['mine on posts', 'false'], ['orient on posts', 'true'], ['orient on events', 'false']], "the view's labels first")
  // off by the analyst, and the view opened again: the default does not come back
  await page.locator('.files-side-labels .files-label-toggle', { hasText: 'orient on posts' }).click()
  await page.waitForTimeout(250)
  await pick('File browser')
  sent.length = 0
  await pick('Board')
  assert.deepEqual(sent, [], 'the default applies the first time only')
})

test('beside a view whose files no label marks, the pane suggests nothing, and Label from prompt applies to the files the view claims', async () => {
  sent.length = 0
  await pick('Clock')
  // no label is on now, so the view's sidebar starts hidden until the analyst shows it
  const show = page.locator('.view-pane-head').getByRole('button', { name: 'Show labels', exact: true })
  await show.waitFor()
  await show.click()
  await page.waitForSelector('.files-side-labels .files-label')
  await page.waitForTimeout(300)
  assert.equal(await page.locator('.files-label-idea').count(), 0)
  assert.ok(!sent.some((s) => /\/concepts\/suggest$/.test(s.path)), 'the labels model is asked nothing')
  await page.locator('.files-side-labels').getByRole('button', { name: 'New label', exact: true }).click()
  await page.getByRole('textbox', { name: 'Label from prompt', exact: true }).fill('late ticks')
  sent.length = 0
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const [draft, create, apply] = sent
  assert.deepEqual(draft, { method: 'POST', path: '/api/ws/mini/concepts/draft', body: { text: 'late ticks', paths: ['runs/*/clock.jsonl'] } })
  assert.deepEqual([create.body.kind, create.body.glob, create.body.unit, create.body.shown], ['code', 'runs/*/clock.jsonl', 'record', true])
  assert.equal(apply.path, '/api/ws/mini/concepts/k9/apply')
  assert.deepEqual(pageErrors, [])
})
