// A plan card drawn by the canvas's own CardFace (canvas/PlanBody.tsx) with thimble's stylesheets, in a real browser,
// in each state a plan goes through: every step not started; done steps one line beside a running step with its live
// rows; a step that needs the analyst. Each step's number, text and status share one line, with the status at the
// right in its colour; what a step makes is dashed until it runs; a done step is one line; nothing overflows the card;
// and the card has no takeaway.
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
const step = (id: string, text: string, makes: string[], extra: Record<string, unknown> = {}) => ({ id, text, makes, status: 'not started', note: '', runs: [], time: '', started: null, ended: null, ...extra })

const BUILD = [
  step('s1', 'Mirror pandas, its open PRs and issues into a local GitHub', ['mirror/', 'forge/']),
  step('s2', 'Build the agent container: PyPI and conda but no web, 1 CPU, 3 GB', ['Dockerfile.agent']),
  step('s3', 'Write the prompts for the two conditions', ['prompts/']),
  step('s4', 'Pilot: 2 agents, one PR each', ['pilot/']),
]

const LONG = "Freeze a copy of pandas at one cutoff date, built fresh in the work folder: clone the repo, fetch every open PR's code as refs/pull/*/head (most PR branches live on contributors' forks), and download every open PR and issue from the GitHub API."

/** the plan in each state, by name: its steps */
const STATES: Record<string, unknown[]> = {
  new: BUILD,
  running: [
    { ...BUILD[0], status: 'done', started: ago(70), ended: ago(64), note: 'six repos mirrored' },
    { ...BUILD[1], status: 'done', started: ago(64), ended: ago(45) },
    { ...BUILD[2], status: 'running', started: ago(40), runs: ['Run the emergent condition', 'Run the managed condition'] },
    BUILD[3],
  ],
  // live check plan-cards: a done step's text of several lines ran under its status, and a click on it scrolled the card
  long: [LONG, LONG.replace('Freeze', 'Then freeze'), LONG.replace('Freeze', 'And freeze')].map((t, i) => ({ ...step(`s${i + 1}`, t, ['mirror/pandas.git', 'mirror/prs.jsonl']), status: 'done', started: ago(70), ended: ago(64), note: 'mirrored' })),
  needs: [
    { ...BUILD[0], status: 'done', started: ago(70), ended: ago(64) },
    { ...BUILD[1], status: 'needs you', note: 'Open the web for GitHub, or bake the two libraries into the image?' },
    BUILD[2],
    BUILD[3],
  ],
}

const RUNS = {
  runs: [
    { step: 3, name: 'Run the emergent condition', chat: 'c0ffee01', state: 'running', latest: 'Bash swarmctl status runs/emergent', elapsed: '40 m' },
    { step: 3, name: 'Run the managed condition', chat: 'c0ffee02', state: 'done', latest: '48 agents ran', elapsed: '12 m' },
  ],
}

beforeAll(async () => {
  const script = await bundle(
    'plan-card',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { CardFace } from '${src('canvas/CardFace.tsx')}'`,
      `import { CanvasContext } from '${src('canvas/context.ts')}'`,
      `const ctx = { ws: 'w', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }`,
      `window.__t = { card: (name, steps) => {`,
      `  const el = document.createElement('div'); el.className = 'canvas-card-box'; el.dataset.state = name; el.style.width = '640px'; el.style.margin = '16px'; document.body.appendChild(el)`,
      `  const cell = { id: 'p1an' + name, notebook: 'nb', kind: 'plan', title: 'Plan: build the environment and pilot it', created_by: 'chat:main', ts: '', takeaway: '', payload: { steps, follows: null } }`,
      `  flushSync(() => createRoot(el).render(<CanvasContext.Provider value={ctx}><CardFace cell={cell} width={600} label={{ concept: null, error: null }} /></CanvasContext.Provider>))`,
      `} }`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = script.replace(/\.js$/, '.css')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 720, height: 1400 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: readFileSync(css) })
    if (p.endsWith('/plan-runs')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUNS) })
    if (p.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  for (const [name, steps] of Object.entries(STATES)) await page.evaluate(([n, s]) => (window as any).__t.card(n, s), [name, steps] as const)
  await page.waitForSelector('[data-state="running"] .plan-run-latest')
  // a picture of the three states beside the test's files, for a reader who wants to look (not compared)
  const out = process.env.THIMBLE_PLAN_SHOT
  if (out) writeFileSync(path.resolve(out), await page.screenshot({ fullPage: true }))
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** each step of the card in state `name`: its box, its parts' boxes and their drawn styles */
const stepsOf = (p: Page, name: string) =>
  p.evaluate((name) => {
    const card = document.querySelector<HTMLElement>(`[data-state="${name}"] .canvas-card`)!
    const box = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() : null)
    return {
      card: box(card),
      overflow: card.scrollWidth > card.clientWidth + 1,
      takeaway: !!card.querySelector('.bcell-take'),
      steps: [...card.querySelectorAll<HTMLElement>('.plan-step')].map((s) => ({
        box: box(s),
        n: box(s.querySelector('.plan-n')),
        text: box(s.querySelector('.plan-text')),
        status: box(s.querySelector('.plan-status')),
        statusText: s.querySelector('.plan-status')?.textContent,
        statusColor: getComputedStyle(s.querySelector('.plan-status')!).color,
        chips: [...s.querySelectorAll('.plan-make')].map((c) => getComputedStyle(c).borderTopStyle),
        runs: [...s.querySelectorAll('.plan-run')].map((r) => ({ meta: r.querySelector('.plan-run-meta')?.textContent, latest: r.querySelector('.plan-run-latest')?.textContent, dot: getComputedStyle(r.querySelector('.plan-dot')!).backgroundColor })),
        lineHeight: parseFloat(getComputedStyle(s.querySelector('.plan-text')!).lineHeight),
      })),
      tokens: Object.fromEntries(
        ['--accent', '--status-positive', '--status-warning', '--text-tertiary'].map((v) => {
          const sw = document.createElement('span')
          sw.style.color = `var(${v})`
          card.appendChild(sw)
          const c = getComputedStyle(sw).color
          sw.remove()
          return [v, c]
        }),
      ),
    }
  }, name)

type Steps = Awaited<ReturnType<typeof stepsOf>>

/** the number, the text and the status of every step on one line, the status at the card's right */
function oneLine(got: Steps) {
  for (const [i, s] of got.steps.entries()) {
    assert.ok(s.n && s.text && s.status, `step ${i + 1} has its parts`)
    const line = { top: s.text.top - 2, bottom: s.text.top + s.lineHeight + 2 }
    const onLine = (b: { top: number; bottom: number }) => b.top >= line.top && b.bottom <= line.bottom
    assert.ok(onLine(s.n) && onLine(s.status), `step ${i + 1}'s number, text and status share a line ${JSON.stringify(s)}`)
    assert.ok(s.n.right <= s.text.left && s.text.right <= s.status.left + 1, `number, text, status left to right ${JSON.stringify(s)}`)
    assert.ok(got.card && s.status.right <= got.card.right && got.card.right - s.status.right < 40, `the status sits at the card's right ${JSON.stringify(s)}`)
  }
  assert.equal(got.overflow, false, 'nothing overflows the card')
  assert.equal(got.takeaway, false, 'a plan has no takeaway')
}

test('a new plan: every step not started, in the tertiary, what it makes dashed', async () => {
  const got = await stepsOf(page, 'new')
  oneLine(got)
  assert.deepEqual(got.steps.map((s) => s.statusText), ['not started', 'not started', 'not started', 'not started'])
  for (const s of got.steps) {
    assert.equal(s.statusColor, got.tokens['--text-tertiary'])
    assert.ok(s.chips.length > 0 && s.chips.every((c) => c === 'dashed'), `chips dashed until the step runs ${JSON.stringify(s.chips)}`)
  }
})

test('a running plan: done steps one line in green, the running step in the accent with its chips solid and a live row per run', async () => {
  const got = await stepsOf(page, 'running')
  oneLine(got)
  const [a, b, c, d] = got.steps
  assert.equal(a.statusText, 'done · 6 m')
  assert.equal(b.statusText, 'done · 19 m')
  for (const s of [a, b]) {
    assert.equal(s.statusColor, got.tokens['--status-positive'])
    assert.equal(s.chips.length, 0, 'a done step shows no chips')
    assert.ok(s.box!.height <= s.lineHeight + 12, `a done step is one line ${JSON.stringify(s.box)} at ${s.lineHeight}`)
  }
  assert.equal(c.statusText, 'running · 40 m')
  assert.equal(c.statusColor, got.tokens['--accent'])
  assert.deepEqual(c.chips, ['solid'])
  assert.deepEqual(
    c.runs.map((r) => [r.meta, r.latest]),
    [
      ['running · 40 m', '⎿ Bash swarmctl status runs/emergent'],
      ['done · 12 m', '⎿ 48 agents ran'],
    ],
  )
  assert.equal(c.runs[0].dot, got.tokens['--accent'], "a running run's dot is the accent")
  assert.equal(c.runs[1].dot, got.tokens['--status-positive'], "a done run's dot is green")
  assert.ok(c.box!.height > 3 * c.lineHeight, 'the running step shows its chips and runs under its line')
  assert.equal(d.statusText, 'not started')
})

test('a step that needs the analyst: its status in the warning colour, its question under it', async () => {
  const got = await stepsOf(page, 'needs')
  oneLine(got)
  const s = got.steps[1]
  assert.equal(s.statusText, 'needs you')
  assert.equal(s.statusColor, got.tokens['--status-warning'])
  const note = await page.textContent('[data-state="needs"] .plan-step[data-n="2"] .plan-note')
  assert.equal(note, 'Open the web for GitHub, or bake the two libraries into the image?')
})

test('a click opens a done step and shows its note and what it made', async () => {
  const sel = '[data-state="running"] .plan-step[data-n="1"]'
  const before = (await page.locator(sel).boundingBox())!
  await page.click(`${sel} .plan-toggle`)
  await page.waitForSelector(`${sel} .plan-note`)
  const after = (await page.locator(sel).boundingBox())!
  assert.ok(after.height > before.height + 10, `the opened step grows ${before.height} → ${after.height}`)
  assert.equal(await page.textContent(`${sel} .plan-note`), 'six repos mirrored')
  assert.equal(await page.locator(`${sel} .plan-make`).first().evaluate((c) => getComputedStyle(c).borderTopStyle), 'solid')
  await page.click(`${sel} .plan-toggle`)
  await page.waitForSelector(`${sel} .plan-note`, { state: 'detached' })
})

test("a done step's long text is cut short on its line before its status, and opening it wraps it and moves nothing", async () => {
  const got = await stepsOf(page, 'long')
  oneLine(got)
  for (const s of got.steps) assert.ok(s.box!.height <= s.lineHeight + 12, `a done step is one line ${JSON.stringify(s.box)}`)
  const sel = '[data-state="long"] .plan-step[data-n="2"]'
  const cut = await page.locator(`${sel} .plan-line`).evaluate((el) => el.scrollWidth > el.clientWidth)
  assert.ok(cut, 'the text is cut short, with its whole text in its title')
  assert.ok(await page.locator(`${sel} .plan-caret`).isVisible(), "the step's caret shows")
  await page.click(`${sel} .plan-toggle`)
  await page.waitForSelector(`${sel} .plan-note`)
  const open = await page.evaluate((sel) => {
    const card = document.querySelector<HTMLElement>('[data-state="long"] .canvas-card')!
    const step = document.querySelector<HTMLElement>(sel)!
    const line = step.querySelector<HTMLElement>('.plan-line')!
    const r = (el: Element) => el.getBoundingClientRect()
    return { scrolled: card.scrollLeft, lines: r(line).height / parseFloat(getComputedStyle(line).lineHeight), textRight: r(line).right, statusLeft: r(step.querySelector('.plan-status')!).left, cardRight: r(card).right, statusRight: r(step.querySelector('.plan-status')!).right }
  }, sel)
  assert.equal(open.scrolled, 0, 'a click on the step scrolls no part of the card out of view')
  assert.ok(open.lines >= 2, `the opened step's text wraps ${JSON.stringify(open)}`)
  assert.ok(open.textRight <= open.statusLeft + 1 && open.statusRight <= open.cardRight, `the text stays left of its status ${JSON.stringify(open)}`)
  await page.click(`${sel} .plan-toggle`)
  await page.waitForSelector(`${sel} .plan-note`, { state: 'detached' })
})
