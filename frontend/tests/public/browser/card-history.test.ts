// A card's History in a real browser with thimble's own stylesheets: the real Canvas (src/canvas/Canvas.tsx) holding a
// plan main changed twice on the analyst's feedback, and the analyst's own edit before them, made before thimble kept
// what edits replaced. The History button among the card's buttons opens the History in the side panel
// (src/canvas/DetailPanel.tsx): each edit, newest first, who made it and what it changed, then the card's making; an
// edit whose version was kept opens the card as it was before it (GET /cells/{id}/versions/{entry}), to read, with the
// parts it changed marked; Back returns to the list, and Restore (POST .../restore) makes the card that version again,
// after which the list shows the analyst's edit at its top. The card's details list the same history. Matt 2026-10-09:
// "we should not keep 'Before' with a strikethrough. maybe cards have a history button?".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const restored: string[] = []
const read: string[] = []

const step = (id: string, text: string, makes: string[], extra: Record<string, unknown> = {}) => ({ id, text, makes, status: 'not started', note: '', details: '', runs: [], time: '', started: null, ended: null, ...extra })
const MADE = [step('s1', 'Mirror pandas into a local GitHub', ['mirror/']), step('s2', 'Pilot: 2 agents per condition', ['pilot/'])]
const NOW = [step('s1', 'Mirror pandas into a local GitHub', ['mirror/']), step('s3', 'Check that every agent builds pandas offline', ['checks/']), step('s2', 'Pilot: 4 agents per condition on 10 PRs', ['pilot/'])]
const EDITS = [
  { by: 'user', ts: '2026-10-09T09:00:00+00:00', fields: ['title'] },
  { by: 'chat:main', ts: '2026-10-09T10:00:00+00:00', id: 'a1b2c3d4', fields: ['payload'] },
  { by: 'chat:main', ts: '2026-10-09T10:05:00+00:00', id: 'e5f6a7b8', fields: ['payload'] },
]
const plan = (steps: unknown[], edited: unknown[]) => ({ id: 'plan1', notebook: 'g', kind: 'plan', title: 'Plan: build the environment and pilot it', takeaway: '', created_by: 'chat:main', created_ts: '2026-10-09T08:00:00+00:00', ts: '2026-10-09T08:00:00+00:00', payload: { steps, follows: null, last_edit: { ts: '', steps: { s3: { new: true }, s2: { changed: ['text'] } } } }, edited })
let CANVAS = { groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }], cells: [plan(NOW, EDITS)] }
const VERSION = { card: 'plan1', before: 'a1b2c3d4', by: 'chat:main', ts: '2026-10-09T10:00:00+00:00', fields: ['payload'], version: { id: 'plan1', notebook: 'g', kind: 'plan', title: 'Plan: build the environment and pilot it', code: null, payload: { steps: MADE, follows: null }, takeaway: '', outputs: [], status: null, text: null } }

beforeAll(async () => {
  const script = await bundle(
    'card-history',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    const v = /^\/api\/ws\/w\/cells\/plan1\/versions\/([0-9a-f]{8})(\/restore)?$/.exec(p)
    if (v && v[2] && req.method() === 'POST') {
      restored.push(v[1])
      // the card made that version again, as the analyst's edit at the top of its history
      const cell = plan(MADE, [...EDITS, { by: 'user', ts: '2026-10-09T10:30:00+00:00', id: 'c0ffee00', fields: ['payload'] }])
      CANVAS = { ...CANVAS, cells: [cell] }
      return json(cell)
    }
    if (v) {
      read.push(v[1])
      return v[1] === 'a1b2c3d4' ? json(VERSION) : json({ ...VERSION, before: v[1], ts: '2026-10-09T10:05:00+00:00', version: { ...VERSION.version, payload: { steps: NOW.slice(0, 2), follows: null } } })
    }
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks' || p === '/api/ws/w/canvas/comments') return json(p.endsWith('comments') ? { comments: [] } : [])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => localStorage.setItem('thimble:w:canvas-open', JSON.stringify(['g'])))
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="plan1"] .plan-step')
  await page.waitForTimeout(400)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The history's rows: each one's words, and the edit it opens, or null. */
const rows = (within: string) =>
  page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(`${sel} .bdetail-hist`)].map((r) => ({ text: (r.textContent ?? '').replace(/^\d\d:\d\d/, '').trim(), entry: r.tagName === 'BUTTON' ? r.dataset.entry ?? null : null })), within)

test("the card's History button opens its history: each edit newest first, who made it and what it changed, then its making", async () => {
  await page.locator('[data-cell="plan1"]').hover()
  const button = page.locator('[data-cell="plan1"] .bcell-history')
  assert.equal(await button.getAttribute('aria-label'), 'History')
  await button.click()
  await page.waitForSelector('.bdetail [data-view="history"]')
  assert.equal(await page.textContent('.bdetail-title'), 'History')
  assert.deepEqual(await rows('[data-view="history"]'), [
    { text: 'edited by mainsteps', entry: 'e5f6a7b8' },
    { text: 'edited by mainsteps', entry: 'a1b2c3d4' },
    // made before thimble kept what edits replaced: listed, but it opens nothing
    { text: 'edited by youquestion', entry: null },
    { text: 'created by main', entry: null },
  ])
})

test('an edit opens the card as it was before it, to read, with the part it changed marked; Back returns to the list', async () => {
  await page.locator('[data-view="history"] .bdetail-hist[data-entry="a1b2c3d4"]').click()
  await page.waitForSelector('[data-view="version"] .plan-step')
  assert.deepEqual(read.at(-1), 'a1b2c3d4')
  const got = await page.evaluate(() => {
    const v = document.querySelector<HTMLElement>('[data-view="version"]')!
    return {
      what: v.querySelector('.bdetail-version-what')?.textContent,
      labels: [...v.querySelectorAll('.bdetail-label')].map((l) => [l.childNodes[0]?.textContent, l.querySelector('.plan-mark')?.textContent ?? null]),
      steps: [...v.querySelectorAll('.plan-step .plan-line')].map((l) => l.textContent),
      anchors: v.querySelectorAll('[data-anchor]').length,
      fields: v.querySelectorAll('textarea, [contenteditable="true"]').length,
      marks: v.querySelectorAll('.plan-step .plan-mark').length,
      restore: v.querySelector('.bdetail-restore')?.textContent,
    }
  })
  assert.ok(got.what?.startsWith('Before main’s edit at '), got.what ?? '')
  assert.deepEqual(got.labels, [['Question', null], ['Steps', 'Changed']])
  assert.deepEqual(got.steps, MADE.map((s) => s.text), 'the steps as they were')
  assert.equal(got.anchors, 0, "the copy's steps are not taken for the card's own")
  assert.equal(got.fields, 0, 'nothing to edit in a version')
  assert.equal(got.marks, 0, "the card's marks of its last edit are not the version's")
  assert.equal(got.restore, 'Restore')
  // the card itself still shows its steps now
  assert.equal(await page.locator('[data-cell="plan1"] .plan-step').count(), 3)
  await page.locator('[data-view="version"] .bdetail-back').click()
  await page.waitForSelector('.bdetail [data-view="history"]')
})

test('Restore makes the card that version again, and the history shows the analyst’s edit at its top', async () => {
  await page.locator('[data-view="history"] .bdetail-hist[data-entry="a1b2c3d4"]').click()
  await page.waitForSelector('[data-view="version"] .plan-step')
  await page.locator('.bdetail-restore').click()
  await page.waitForSelector('.bdetail [data-view="history"]')
  assert.deepEqual(restored, ['a1b2c3d4'])
  await page.waitForFunction(() => document.querySelectorAll('[data-cell="plan1"] .plan-step').length === 2)
  const top = (await rows('[data-view="history"]'))[0]
  assert.deepEqual(top, { text: 'edited by yousteps', entry: 'c0ffee00' })
})

test("the card's details list the same history, whose edits open their versions too", async () => {
  await page.locator('.bdetail-close').click()
  await page.locator('[data-cell="plan1"]').hover()
  await page.locator('[data-cell="plan1"] .bcell-acts [aria-label="Details"]').click()
  await page.waitForSelector('.bdetail-body:not([hidden]) .bdetail-hist')
  assert.equal(await page.textContent('.bdetail-title'), 'Detail')
  const list = await rows('.bdetail-body:not([hidden])')
  assert.deepEqual(list.map((r) => r.entry), ['c0ffee00', 'e5f6a7b8', 'a1b2c3d4', null, null])
  await page.locator('.bdetail-body:not([hidden]) .bdetail-hist[data-entry="e5f6a7b8"]').click()
  await page.waitForSelector('[data-view="version"] .plan-step')
  assert.equal(read.at(-1), 'e5f6a7b8')
  await page.locator('[data-view="version"] .bdetail-back').click()
  await page.waitForSelector('.bdetail-body:not([hidden]) .bdetail-hist')
  assert.equal(await page.textContent('.bdetail-title'), 'Detail', 'Back returns to the details it was opened from')
})
