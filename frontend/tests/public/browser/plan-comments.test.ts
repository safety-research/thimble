// Plan cards and the comments beside them, in a real browser with thimble's own stylesheets: the real Canvas holding a
// finished build plan and the run plan that follows it, each drawn by PlanBody, and a check's comment on step 2 of the
// run plan (GET /canvas/comments). The comment sits right of the frame, level with step 2's row; it stays level with
// that row when step 1's live rows arrive above it (GET /cards/{id}/plan-runs) and push the row down inside a card whose
// height is set; ✓ resolves it through POST /canvas/comments/{id}/resolve and it no longer shows.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const resolved: { id: string; how: string }[] = []

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const step = (id: string, text: string, makes: string[], extra: Record<string, unknown> = {}) => ({ id, text, makes, status: 'not started', note: '', runs: [], time: '', started: null, ended: null, ...extra })
const plan = (id: string, title: string, steps: unknown[], follows: string | null, height: number | null = null) => ({ id, notebook: 'g', kind: 'plan', title, takeaway: '', created_by: 'chat:main', ts: '2026-10-08T12:00:00+00:00', height, payload: { steps, follows } })
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [
    plan(
      'build1',
      'Plan: build the environment and pilot it',
      [
        step('s1', 'Build the agent container: PyPI and conda but no web', ['Dockerfile.agent'], { status: 'done', started: ago(90), ended: ago(70) }),
        step('s2', 'Pilot: 2 agents, one PR each', ['pilot/'], { status: 'done', started: ago(70), ended: ago(60) }),
      ],
      null,
    ),
    plan(
      'run1',
      'Plan: run the experiment',
      [
        step('s1', 'Run the emergent condition: 48 agents, 2 hours', ['runs/emergent/'], { status: 'running', started: ago(40), runs: ['Run the emergent condition'] }),
        step('s2', 'Run the managed condition: 48 agents and a manager, 2 hours', ['runs/managed/']),
        step('s3', 'Compare the conditions: PRs merged, reverts, reviews', ['results/']),
      ],
      'build1',
      // a height the analyst set, so the card's box keeps its size and only the rows inside it move
      420,
    ),
  ],
}
let COMMENTS = [
  {
    id: 'k1',
    card: 'run1',
    step: 's2',
    n: 2,
    ref: 'card:run1#step-2',
    check: 'you-should-know',
    run: 'r1',
    author: 'check',
    tag: 'Heads up',
    title: "Only the versions on pandas' main branch are in the image",
    body: 'PR branches that pin other versions of fast_float or xsimd will still fail to build.',
    text: "Heads up: only the versions on pandas' main branch are in the image. PR branches that pin other versions of fast_float or xsimd will still fail to build.",
    ts: '',
    status: 'open',
  },
]
const RUNS = { runs: [{ step: 1, name: 'Run the emergent condition', chat: 'c0ffee01', state: 'running', latest: 'agent-07 waiting 12 min for a review of #131', elapsed: '40 m' }] }
const YSK = { id: 'you-should-know', name: 'You should know', prompt: 'Leave a comment…', colour: 2, shown: true, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: { '@canvas': { run: 'r1', status: 'done', chat: '', started: '', covered: [], seen: [], comments: 1, summary: '' } }, covers: ['documents', 'cards'] }

beforeAll(async () => {
  const script = await bundle(
    'plan-comments',
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
  // the run plan's live rows answer once the test says so, after it has measured where the comment stands
  let release: () => void = () => {}
  const ready = new Promise<void>((r) => (release = r))
  await page.exposeFunction('releaseRuns', () => release())
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: COMMENTS })
    const res = /^\/api\/ws\/w\/canvas\/comments\/([^/]+)\/resolve$/.exec(p)
    if (res) {
      resolved.push({ id: res[1], how: JSON.parse(req.postData() || '{}').how })
      COMMENTS = COMMENTS.filter((c) => c.id !== res[1])
      return json({ comments: COMMENTS })
    }
    if (p === '/api/ws/w/cards/run1/plan-runs') {
      await ready
      return json(RUNS)
    }
    if (p === '/api/ws/w/checks') return json([YSK])
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => localStorage.setItem('thimble:w:canvas-open', JSON.stringify(['g'])))
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="run1"] [data-anchor="card:run1#step-2"]')
  await page.waitForSelector('[data-canvas-comment="k1"]')
  await page.waitForTimeout(600)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

type Box = { left: number; top: number; right: number; bottom: number }
const box = (sel: string): Promise<Box | null> =>
  page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s)
    if (!el || getComputedStyle(el).visibility === 'hidden') return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }, sel)
const scale = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector<HTMLElement>('.board-plane')!).transform).a)

/** the comment's top against step 2's row: the comment stands COMMENT_STEP_LIFT (4 plane px) above the row */
async function levelWithStep2(why: string) {
  const s = await scale()
  const row = (await box('[data-anchor="card:run1#step-2"]'))!
  const k1 = (await box('[data-canvas-comment="k1"]'))!
  assert.ok(Math.abs(k1.top - (row.top - 4 * s)) <= 6, `${why}: the comment at ${k1.top}, step 2's row at ${row.top}`)
  return { row, k1 }
}

test('the comment on step 2 sits beside the frame, level with step 2, and stays there when live rows push it down', async () => {
  // the run plan follows the finished build plan in the same frame; the finished plan's steps are one line each
  const build = (await box('[data-cell="build1"]'))!
  const run = (await box('[data-cell="run1"]'))!
  assert.ok(build.bottom <= run.top, `the run plan stands below the build plan: ${build.bottom} vs ${run.top}`)
  assert.equal(await page.locator('[data-cell="build1"] .plan-step.is-compact').count(), 2)
  assert.equal(await page.locator('[data-cell="build1"] .bcell-take, [data-cell="run1"] .bcell-take').count(), 0, 'a plan has no takeaway')
  const frame = (await box('[data-group="g"]'))!
  const s = await scale()
  const before = await levelWithStep2('before the live rows')
  assert.ok(before.k1.left >= frame.right + 10 * s && before.k1.left <= frame.right + 26 * s, `beside the frame: ${before.k1.left} vs ${frame.right}`)
  const text = await page.evaluate(() => document.querySelector('[data-canvas-comment="k1"]')!.textContent)
  assert.ok(text!.includes('Heads up') && text!.includes("Only the versions on pandas' main branch are in the image"), text!)
  // step 1's live row arrives and pushes step 2 down; the comment moves with it
  await page.evaluate(() => (window as unknown as { releaseRuns: () => void }).releaseRuns())
  await page.waitForSelector('[data-cell="run1"] .plan-run-latest')
  await page.waitForTimeout(400)
  const after = await levelWithStep2('after the live rows')
  assert.ok(after.row.top > before.row.top + 8, `the live row pushed step 2 down: ${before.row.top} -> ${after.row.top}`)
})

test('✓ resolves the comment on step 2, which no longer shows', async () => {
  await page.locator('[data-canvas-comment="k1"]').hover()
  await page.locator('[data-canvas-comment="k1"] .ccm-done').click()
  await page.waitForFunction(() => !document.querySelector('[data-canvas-comment="k1"]'))
  assert.deepEqual(resolved, [{ id: 'k1', how: 'done' }])
  // a later read of the comments (the stream's next record) does not bring it back
  await page.waitForTimeout(400)
  assert.equal(await page.locator('[data-canvas-comment]').count(), 0)
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ccm-lines path').length), 0)
})
