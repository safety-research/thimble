// What a label labels, in the Files pane (src/files/LabelsPane.tsx, LabelCard.tsx, labels.ts): the Labels pane lists
// the labels over files with their on/off square, a trial over files only while it is on, and the labels over canvas
// cards and report sentences with their scope's glyph in place of the square; + opens a new label's card, Label from
// prompt at its top (LabelPrompt.tsx), where a description becomes a label the labels model drafted and the row creates
// and runs, and the definition by hand under it; a new label's card chooses what it labels (Over: Files, Cards,
// Sentences), and a label over cards has no marks and no files, so it is created with unit `cell` and run over the
// canvas. The Files pane is mounted whole in a headless Chromium page against routed API answers.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const sent: any[] = []

const C = (name: any, color: any, highlight: any) => ({ name, color, highlight })
const label = (id: any, name: any, unit: any, color: any, extra = {}) => ({ id, name, description: 'd', unit, marks: unit === 'record' ? 'record' : null, kind: 'prompt', spec: '', labels: ['match', 'no match'], classes: [C('match', color, true), C('no match', 0, false)], created_by: 'user', ts: `2026-09-25T10:0${color}:00Z`, shown: false, glob: unit === 'record' ? '*.jsonl' : '', ...extra })
const concepts = new Map([
  ['k1', label('k1', 'web link', 'record', 1, { shown: true })],
  ['k2', label('k2', 'plots in Orientation', 'cell', 2)],
  ['k3', label('k3', 'hidden trial', 'record', 3, { trial: true })],
  ['k4', label('k4', 'shown trial', 'record', 4, { trial: true, shown: true })],
  ['k5', label('k5', 'hedged', 'span', 5)],
])
// what the labels model defines for "records with a web link" (backend concepts.draft_of), under a name a label has
const DRAFT = { name: 'web link', over: 'files', marks: 'span', glob: 'a.jsonl', kind: 'regex', text: '(?i)https?://', values: ['link', 'no match'] }
const LISTING = { path: '', files: [{ path: 'a.jsonl', kind: 'jsonl', size_bytes: 10 }], folders: [], n_files: 1 }

beforeAll(async () => {
  script = await bundle('labels-over', [
      `import { createRoot } from 'react-dom/client'`,
      `import { FilesTab } from '${src('files/FilesTab.tsx')}'`,
      `const el = document.createElement('div')`,
      `el.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:760px;display:flex;flex-direction:column'`,
      `document.body.appendChild(el)`,
      `createRoot(el).render(<FilesTab ws="mini" active />)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (body: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (req.method() === 'POST' && url.pathname === '/api/ws/mini/concepts') {
      const body = JSON.parse(req.postData())
      sent.push({ method: 'POST', path: url.pathname, body })
      const k = label('k9', body.name, body.unit ?? 'record', 6, body)
      concepts.set('k9', k)
      return json(k)
    }
    if (req.method() === 'POST' && url.pathname === '/api/ws/mini/concepts/draft') {
      const body = JSON.parse(req.postData())
      sent.push({ method: 'POST', path: url.pathname, body })
      if (/capacity/.test(body.text)) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"detail":"the labels model gave no label (rate_limited)"}' })
      return json(DRAFT)
    }
    if (req.method() === 'POST' && /\/apply$/.test(url.pathname)) {
      sent.push({ method: 'POST', path: url.pathname, body: JSON.parse(req.postData() || '{}') })
      return json({ status: 'running', run_id: 'r1', started: '2026-09-25T10:10:00Z', done: 0, total: 14 })
    }
    const put = url.pathname.match(/^\/api\/ws\/mini\/concepts\/(\w+)$/)
    if (req.method() === 'PUT' && put) {
      const body = JSON.parse(req.postData())
      sent.push({ method: 'PUT', path: url.pathname, body })
      concepts.set(put[1], { ...concepts.get(put[1]), ...body })
      return json(concepts.get(put[1]))
    }
    if (req.method() !== 'GET' && url.pathname.startsWith('/api/')) return json({ ok: true })
    if (url.pathname === '/api/ws/mini/concepts') return json([...concepts.values()])
    if (url.pathname.startsWith('/api/ws/mini/concepts/')) return json(concepts.get(url.pathname.split('/').pop()!) ?? {})
    if (url.pathname === '/api/ws/mini/labels/presence') return json([])
    if (url.pathname === '/api/ws/mini/labels/glob') return json({ files: ['a.jsonl'], total: 1 })
    if (url.pathname === '/api/ws/mini/views') return json([])
    if (url.pathname === '/api/ws/mini/views/proposals') return json([])
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

const rows = () =>
  page.locator('.files-side .files-label').evaluateAll((els: any) =>
    els.map((el: any) => {
      const square = el.querySelector('.files-label-box')
      return [el.querySelector('.files-label-name').textContent, square ? 'square' : el.querySelector('.files-label-over') ? 'glyph' : 'none']
    }),
  )
const overOptions = () => page.locator('.label-card [aria-label="Over"] .seg-opt').evaluateAll((bs: any) => bs.map((b: any) => [b.textContent, b.getAttribute('aria-checked'), b.disabled]))
const keys = () => page.locator('.label-card .label-card-key').allTextContents()

test('the Labels pane lists the labels over files, then the labels over cards and sentences with their glyph; a trial only while it is on', async () => {
  assert.deepEqual(await rows(), [
    ['web link', 'square'],
    ['shown trial', 'square'],
    ['plots in Orientation', 'glyph'],
    ['hedged', 'glyph'],
  ])
  const [glyph, colour] = await page.locator('.files-label', { hasText: 'plots in Orientation' }).locator('.files-label-over').evaluate((el: any) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--label-2)'
    document.body.appendChild(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return [getComputedStyle(el).color, want]
  })
  assert.equal(glyph, colour, 'the glyph takes the label colour')
})

test('+ opens a new label\'s card: Label from prompt with the accent arrow on top, the definition by hand under it, no suggestions', async () => {
  sent.length = 0
  await page.getByRole('button', { name: 'New label', exact: true }).click()
  await page.waitForSelector('.label-card')
  const lead = page.locator('.label-card > .label-card-lead')
  assert.equal(await lead.locator('.label-prompt').count(), 1, 'Label from prompt is the card\'s top row')
  assert.equal(await page.locator('.label-card > :first-child').evaluate((el: any) => el.classList.contains('label-card-lead')), true)
  assert.deepEqual(await keys(), ['Over', 'Marks', 'Applies to', 'Classifier', 'Model', 'Classes'], 'the definition by hand shows at once')
  assert.equal(await page.getByRole('button', { name: 'Define by hand', exact: true }).count(), 0)
  assert.equal(await page.locator('.label-ask, .label-ask-idea, .files-label-idea').count(), 0)
  assert.equal(await lead.getByRole('button', { name: 'Close', exact: true }).count(), 1, 'the card\'s × sits in the top row')
  assert.equal(await page.locator('.label-card-head').getByRole('button', { name: 'Close', exact: true }).count(), 0)
  const field = page.getByRole('textbox', { name: 'Label from prompt', exact: true })
  assert.equal(await field.getAttribute('placeholder'), 'Label from prompt…')
  assert.equal(await field.evaluate((el: any) => el === document.activeElement), true, 'the field takes the keyboard')
  // the arrow is in the accent while the field is empty, and a filled accent button once there is a description
  const [arrow, accent] = await page.locator('.label-prompt-send').evaluate((el: any) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--text-accent)'
    document.body.appendChild(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return [getComputedStyle(el).color, want]
  })
  assert.equal(arrow, accent)
  assert.equal(sent.length, 0, 'nothing is asked of the labels model until the analyst describes a label')
  await field.fill('records with a web link')
  sent.length = 0
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const [draft, create, apply] = sent
  assert.deepEqual(draft, { method: 'POST', path: '/api/ws/mini/concepts/draft', body: { text: 'records with a web link', paths: ['a.jsonl'] } })
  assert.equal(create.body.name, 'web link 2', 'a name no label has')
  assert.deepEqual([create.body.unit, create.body.marks, create.body.glob, create.body.kind, create.body.spec, create.body.shown], ['record', 'span', 'a.jsonl', 'regex', '(?i)https?://', true])
  assert.deepEqual(create.body.classes.map((c: any) => [c.name, c.highlight, c.color === 0]), [['link', true, false], ['no match', false, true]])
  assert.deepEqual(apply, { method: 'POST', path: '/api/ws/mini/concepts/k9/apply', body: {} })
  assert.equal(await page.locator('.label-card').count(), 0, 'the card closes once the run starts')
  concepts.delete('k9')
})

test('a description the labels model could not define fills the card under it as a prompt label', async () => {
  await page.getByRole('button', { name: 'New label', exact: true }).click()
  await page.waitForSelector('.label-card')
  await page.getByRole('textbox', { name: 'Label from prompt', exact: true }).fill('posts written at capacity')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => (document.querySelector('.label-card [aria-label="Prompt"]') as HTMLTextAreaElement | null)?.value === 'posts written at capacity')
  assert.equal(await page.locator('.label-card').getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), 'posts written at capacity')
  assert.equal(await page.locator('.label-card [aria-label="Classifier"] .seg-opt[aria-checked="true"]').innerText(), 'Prompt')
  await page.locator('.label-card').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.label-card').count(), 0)
})

test('a new label chooses what it labels; over cards it has no marks or files, and is created with unit cell and run', async () => {
  await page.getByRole('button', { name: 'New label', exact: true }).click()
  await page.waitForSelector('.label-card')
  assert.deepEqual(await overOptions(), [
    ['Files', 'true', false],
    ['Cards', 'false', false],
    ['Sentences', 'false', false],
  ])
  assert.deepEqual(await keys(), ['Over', 'Marks', 'Applies to', 'Classifier', 'Model', 'Classes'])
  await page.locator('.label-card [aria-label="Over"] .seg-opt', { hasText: 'Cards' }).click()
  assert.deepEqual(await keys(), ['Over', 'Classifier', 'Model', 'Classes'], 'no marks and no files for a label over cards')
  await page.locator('.label-card').getByRole('textbox', { name: 'Name', exact: true }).fill('tables in Orientation')
  await page.locator('.label-card').getByRole('textbox', { name: 'Prompt', exact: true }).fill('The card is a table in the Orientation deck.')
  sent.length = 0
  await page.locator('.label-card').getByRole('button', { name: 'Run', exact: true }).click()
  await page.waitForTimeout(300)
  assert.equal(sent.length, 2, JSON.stringify(sent))
  const [create, apply] = sent
  assert.equal(create.body.unit, 'cell')
  assert.equal(create.body.shown, false)
  assert.equal('marks' in create.body || 'glob' in create.body, false)
  assert.equal(create.body.description, 'The card is a table in the Orientation deck.')
  assert.deepEqual(apply, { method: 'POST', path: '/api/ws/mini/concepts/k9/apply', body: {} })
  assert.equal(await page.locator('.label-card').count(), 0, 'the card closes once the run starts')
})

test('a label over cards opens its edit card with Over fixed to Cards, since its rows are of cards', async () => {
  await page.getByRole('button', { name: 'Edit plots in Orientation', exact: true }).click()
  await page.waitForSelector('.label-card')
  assert.deepEqual(await overOptions(), [
    ['Files', 'false', true],
    ['Cards', 'true', false],
    ['Sentences', 'false', true],
  ])
  assert.deepEqual(await keys(), ['Over', 'Classifier', 'Model', 'Classes'])
  sent.length = 0
  await page.locator('.label-card').getByRole('button', { name: 'Re-run', exact: true }).click()
  await page.waitForTimeout(300)
  const [put, apply] = sent
  assert.equal(put.method, 'PUT')
  assert.equal('marks' in put.body || 'glob' in put.body, false, 'the server refuses marks on a label over cards')
  assert.deepEqual(apply, { method: 'POST', path: '/api/ws/mini/concepts/k2/apply', body: {} })
  assert.deepEqual(pageErrors, [])
})
