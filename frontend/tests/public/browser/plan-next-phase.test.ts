// The next phase's plan and a long comment, in a real browser with thimble's own stylesheets and the real Canvas. The
// frame "Your work" starts collapsed (no frame kept open), holding the finished build plan and a check's comment of
// several sentences on it. The comment shows four lines of its body at rest, with its code spans as code, and all of
// it once a click makes it active; Fit takes the comment in with the cards; and when main adds the run plan that
// follows the build plan (a `cell` record, then GET /canvas again), the frame opens so the run plan shows below it.
// Live check plan-cards: the next plan sat under the finished one in a collapsed frame, long comments stood far below
// their steps, Fit cut them off, and the comments showed their backticks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const step = (id: string, text: string, makes: string[], extra: Record<string, unknown> = {}) => ({ id, text, makes, status: 'not started', note: '', runs: [], time: '', started: null, ended: null, ...extra })
const plan = (id: string, title: string, steps: unknown[], follows: string | null) => ({ id, notebook: 'g', kind: 'plan', title, takeaway: '', created_by: 'chat:main', ts: '2026-10-08T12:00:00+00:00', payload: { steps, follows } })
const BUILD = plan(
  'build1',
  'Plan: build the environment and pilot it',
  [
    step('s1', 'Mirror pandas, its open PRs and issues into a local GitHub', ['mirror/'], { status: 'done', started: ago(90), ended: ago(80) }),
    step('s2', 'Build the agent container: PyPI and conda but no web', ['Dockerfile.agent'], { status: 'done', started: ago(80), ended: ago(70) }),
    step('s3', 'Pilot: 2 agents, one PR each', ['pilot/'], { status: 'done', started: ago(70), ended: ago(60) }),
  ],
  null,
)
const RUN = plan('run1', 'Plan: run the experiment', [step('s1', 'Run the emergent condition: 48 agents, 2 hours', ['runs/emergent/']), step('s2', 'Compare the conditions', ['results/'])], 'build1')
const canvas = { groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }], cells: [BUILD] as unknown[] }
const BODY =
  'Most pandas PRs live on contributors’ forks, so a clone of pandas-dev/pandas has none of their branches. Fetch them as `refs/pull/<n>/head`, or the forge will have PRs with no code behind them. The existing test only covers a PR an agent opened. Block approval from anyone who pushed commits to the PR, since the imported PRs were opened by upstream people and an agent who pushed a fix could approve its own work.'
const COMMENTS = [{ id: 'k1', card: 'build1', step: 's1', n: 1, ref: 'card:build1#step-1', check: 'you-should-know', run: 'r1', author: 'check', tag: 'You should know', title: "Cloning every branch won't get the open PRs' code", body: BODY, text: `You should know: cloning every branch won't get the open PRs' code. ${BODY}`, ts: '', status: 'open' }]
const YSK = { id: 'you-should-know', name: 'You should know', prompt: 'Leave a comment…', colour: 2, shown: true, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {}, covers: ['documents', 'cards'] }

beforeAll(async () => {
  const script = await bundle(
    'plan-next-phase',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { dispatch } from '${src('lib/events.ts')}'`,
      `;(window as any).__dispatch = dispatch`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(canvas)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: COMMENTS })
    if (p === '/api/ws/w/checks') return json([YSK])
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="build1"] [data-anchor="card:build1#step-1"]')
  await page.waitForSelector('[data-canvas-comment="k1"]')
  await page.waitForTimeout(500)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const lines = (sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s)!
    return Math.round(el.offsetHeight / parseFloat(getComputedStyle(el).lineHeight))
  }, sel)

test('a long comment shows four lines of its body at rest, its code spans as code, and all of it when active', async () => {
  assert.equal(await lines('[data-canvas-comment="k1"] .ccm-text'), 4)
  assert.deepEqual(await page.$$eval('[data-canvas-comment="k1"] .ccm-text code', (els) => els.map((e) => e.textContent)), ['refs/pull/<n>/head'])
  assert.ok(!(await page.textContent('[data-canvas-comment="k1"] .ccm-text'))!.includes('`'), 'no backticks show')
  await page.click('[data-canvas-comment="k1"] .ccm-title')
  await page.waitForSelector('[data-canvas-comment="k1"].is-active')
  assert.ok((await lines('[data-canvas-comment="k1"] .ccm-text')) > 4, 'the active comment shows its whole body')
  await page.mouse.click(5, 450) // a click on the bare board lets it go
  await page.waitForSelector('[data-canvas-comment="k1"]:not(.is-active)')
})

test('Fit takes the comment in with the cards', async () => {
  // a viewport the frame alone would fill, so a Fit to the cards alone would leave the comment out of view
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForTimeout(200)
  await page.click('.bctl-fit')
  await page.waitForTimeout(300)
  const got = await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('[data-canvas-comment="k1"]')!.closest('.board-plane')!.parentElement!.getBoundingClientRect()
    const k1 = document.querySelector<HTMLElement>('[data-canvas-comment="k1"]')!.getBoundingClientRect()
    return { vp: vp.toJSON(), k1: k1.toJSON() }
  })
  assert.ok(got.k1.right <= got.vp.right && got.k1.bottom <= got.vp.bottom && got.k1.left >= got.vp.left, `the comment is in view after Fit ${JSON.stringify(got)}`)
  await page.setViewportSize({ width: 1400, height: 900 })
})

test('the run plan main adds after the finished build plan opens the collapsed frame and shows below it', async () => {
  assert.equal(await page.locator('[data-group="g"] .frame-chev.is-open').count(), 0, 'the frame starts collapsed')
  canvas.cells = [BUILD, RUN]
  await page.evaluate(() => (window as unknown as { __dispatch: (e: unknown) => void }).__dispatch({ type: 'cell', notebook: 'g', cell: 'run1', kind: 'note' }))
  await page.waitForSelector('[data-cell="run1"] [data-anchor="card:run1#step-2"]')
  await page.waitForSelector('[data-group="g"] .frame-chev.is-open')
  await page.waitForTimeout(300)
  const [build, run] = await page.evaluate(() => ['build1', 'run1'].map((id) => document.querySelector(`[data-cell="${id}"]`)!.getBoundingClientRect().toJSON()))
  assert.ok(build.bottom <= run.top, `the run plan stands below the build plan: ${build.bottom} vs ${run.top}`)
  const kept = await page.evaluate(() => localStorage.getItem('thimble:w:canvas-open'))
  assert.deepEqual(JSON.parse(kept!), ['g'], 'the frame stays open')
})
