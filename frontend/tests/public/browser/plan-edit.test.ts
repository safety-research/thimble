// A plan card that main changed with edit_card, drawn by the canvas's own CardFace (canvas/PlanBody.tsx) with thimble's
// stylesheets, in a real browser. Matt 2026-10-09: a plan works like any card, so main replaces its steps with edit_card
// at any time, and a step can carry details that show under it on request, as a comment's do. The card first shows the
// plan as main made it; then the same card is drawn again with the steps an edit gave it: steps 1 and 2 done, step 3
// running, step 4 with details. Its statuses and times change in place, step 4's line has a caret and no details at
// rest, a click on it opens the details under the line, their citation a chip, and a second click folds them.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const MIN = 60_000
const ago = (m: number) => new Date(Date.now() - m * MIN).toISOString()
const step = (id: string, text: string, makes: string[], extra: Record<string, unknown> = {}) => ({ id, text, makes, status: 'not started', note: '', details: '', runs: [], time: '', started: null, ended: null, ...extra })

const MADE = [
  step('s1', 'Mirror pandas, its open PRs and issues into a local GitHub', ['mirror/']),
  step('s2', 'Build the local GitHub: an offline server for the mirror', ['forge/']),
  step('s3', 'Build the message board', ['board/']),
  step('s4', 'Build the agent container: PyPI and conda but no web', ['Dockerfile.agent']),
  step('s5', 'Pilot: 2 agents per condition', ['pilot/']),
]
const DETAILS = 'The image keeps a cache of every meson subproject pandas downloads, filled once while the build may reach the web.\n\n- Agents then build pandas offline from that cache [[card:box1]].\n- A pilot build that still reaches GitHub fails, which shows the cache misses a library.'
const EDITED = [
  { ...MADE[0], status: 'done', started: ago(50), ended: ago(41) },
  { ...MADE[1], status: 'done', started: ago(41), ended: ago(20) },
  { ...MADE[2], status: 'running', started: ago(12) },
  { ...MADE[3], details: DETAILS },
  MADE[4],
]

beforeAll(async () => {
  const script = await bundle(
    'plan-edit',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { CardFace } from '${src('canvas/CardFace.tsx')}'`,
      `import { CanvasContext } from '${src('canvas/context.ts')}'`,
      `const ctx = { ws: 'w', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }`,
      `const el = document.createElement('div'); el.className = 'canvas-card-box'; el.style.width = '700px'; el.style.margin = '16px'; document.body.appendChild(el)`,
      `const root = createRoot(el)`,
      // the same card, drawn again with each payload the canvas reads after an edit
      `window.__t = { draw: (steps) => {`,
      `  const cell = { id: 'p1anedit', notebook: 'nb', kind: 'plan', title: 'Plan: build the offline pandas environment and pilot it', created_by: 'chat:main', ts: '', takeaway: '', payload: { steps, follows: null } }`,
      `  flushSync(() => root.render(<CanvasContext.Provider value={ctx}><CardFace cell={cell} width={660} label={{ concept: null, error: null }} /></CanvasContext.Provider>))`,
      `} }`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = script.replace(/\.js$/, '.css')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 760, height: 1000 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: readFileSync(css) })
    if (p.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const S = (n: number) => `.plan-step[data-n="${n}"]`

/** each step's id, status words and whether it is one line, and whether its details show */
const steps = () =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.plan-step')].map((s) => ({
      id: s.dataset.step,
      status: s.querySelector('.plan-status')?.textContent,
      compact: s.classList.contains('is-compact'),
      details: !!s.querySelector('.plan-details'),
      caret: !!s.querySelector('.plan-caret'),
    })),
  )

test('the plan main made, then the same card after edit_card replaced its steps: statuses and times change in place', async () => {
  await page.evaluate((s) => (window as any).__t.draw(s), MADE)
  const made = await steps()
  assert.deepEqual(made.map((s) => s.status), Array(5).fill('not started'))
  assert.deepEqual(made.map((s) => s.caret), [false, false, false, false, false], 'no step opens before it has more to show')
  await page.evaluate((s) => (window as any).__t.draw(s), EDITED)
  const edited = await steps()
  assert.deepEqual(edited.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5'], 'each row is the same step')
  assert.deepEqual(edited.map((s) => s.status), ['done · 9 m', 'done · 21 m', 'running · 12 m', 'not started', 'not started'])
  assert.deepEqual(edited.map((s) => s.compact), [true, true, false, false, false], 'the done steps fold to one line')
  const running = await page.locator(`${S(3)} .plan-status`).evaluate((el) => getComputedStyle(el).color)
  const accent = await page.evaluate(() => {
    const sw = document.createElement('span')
    sw.style.color = 'var(--accent)'
    document.body.appendChild(sw)
    const c = getComputedStyle(sw).color
    sw.remove()
    return c
  })
  assert.equal(running, accent, 'the running step in the accent')
  assert.equal(await page.locator(`${S(3)} .plan-make`).evaluate((c) => getComputedStyle(c).borderTopStyle), 'solid', 'what the running step makes is solid')
})

test("step 4's details: none at rest, a click on its line opens them under it with their citation as a chip, a second folds them", async () => {
  await page.evaluate((s) => (window as any).__t.draw(s), EDITED)
  const s4 = page.locator(S(4))
  assert.equal(await s4.locator('.plan-details').count(), 0, 'no details at rest')
  assert.ok(await s4.locator('.plan-caret').isVisible(), "the step's caret says it opens")
  assert.equal(await s4.locator('.plan-make').first().textContent(), 'Dockerfile.agent', 'what it makes shows at rest')
  const rest = (await s4.boundingBox())!
  await s4.locator('.plan-toggle').click()
  await page.waitForSelector(`${S(4)} .plan-details`)
  const open = await page.evaluate((sel) => {
    const step = document.querySelector<HTMLElement>(sel)!
    const line = step.querySelector<HTMLElement>('.plan-line')!.getBoundingClientRect()
    const details = step.querySelector<HTMLElement>('.plan-details')!
    const d = details.getBoundingClientRect()
    const card = document.querySelector<HTMLElement>('.canvas-card')!
    return {
      below: d.top >= line.bottom - 1,
      inside: d.right <= card.getBoundingClientRect().right + 1,
      overflow: card.scrollWidth > card.clientWidth + 1,
      text: details.textContent ?? '',
      chips: details.querySelectorAll('.chip, [data-ref]').length,
      bullets: details.querySelectorAll('li').length,
      colour: getComputedStyle(details).color,
    }
  }, S(4))
  assert.ok(open.below && open.inside && !open.overflow, `the details sit under the step's line inside the card ${JSON.stringify(open)}`)
  assert.ok(open.text.startsWith('The image keeps a cache of every meson subproject'), open.text)
  assert.equal(open.bullets, 2, 'its bullets are a list')
  assert.ok(!open.text.includes('[['), 'the citation is no raw markup')
  assert.ok(open.chips >= 1, 'the citation is a chip')
  const grown = (await s4.boundingBox())!
  assert.ok(grown.height > rest.height + 30, `the step grows to hold them ${rest.height} → ${grown.height}`)
  const out = process.env.THIMBLE_PLAN_SHOT
  if (out) writeFileSync(path.resolve(out), await page.screenshot({ fullPage: true }))
  await s4.locator('.plan-toggle').click()
  await page.waitForSelector(`${S(4)} .plan-details`, { state: 'detached' })
  assert.equal(await s4.locator('.plan-make').first().textContent(), 'Dockerfile.agent', 'what it makes still shows')
})
