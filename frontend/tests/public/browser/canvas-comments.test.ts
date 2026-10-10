// The comments beside the cards in a real browser, with thimble's own stylesheets: the real Canvas (src/canvas/Canvas.tsx)
// holding a plan card and a table card in the analyst's frame, its comments read from GET /canvas/comments
// (src/canvas/CommentLayer.tsx) and its checks from GET /checks. Each comment sits right of the frame, the one on a step
// level with that step's row (`[data-anchor="card:<id>#step-<n>"]`, as a plan card draws its steps) and the others level
// with their card's top, none overlapping, even when a comment's Show more opens its details, each its check's name and
// its statement. As in the Report, each commented step's text or card's question is highlighted in its check's color and
// no line joins a comment to its card; hovering a comment darkens its highlight, with no underline, and brings the
// comment to the front with a little more shadow, where it stays; opening it also moves it level with its step, the
// comment above it moving up. Matt 2026-10-09: "comment lines look off here"; "what about highlights, just like in the
// report?"; "we don't need an underline in addition to darkened highlight … and we don't need the line connecting it to
// the comment if it's foregrounded (e.g., slightly more shadow?) and moves up". ✓ (Done) resolves one through POST
// /canvas/comments/{id}/resolve and it
// goes; Know it does the same with `how: known`. Comments in the top bar lists the check that covers the cards, with its count
// of open comments, and its square turns it off and on, which hides and shows its comments and their highlights.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const resolved: { id: string; how: string }[] = []
const patched: { id: string; shown: boolean }[] = []

const cell = (id: string, title: string, text: string) => ({ id, notebook: 'g', kind: 'note', title, takeaway: '', created_by: 'model', ts: '2026-10-08T12:00:00+00:00', payload: { text }, text })
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [
    cell('plan1', 'Plan: build the environment and pilot it', 'Five steps; nothing runs until you say go.\n\nMirror\n\nContainer\n\nPrompts\n\nHarness\n\nPilot'),
    cell('box1', 'What can an agent do in its container?', 'Agents can install from PyPI and conda but cannot browse the web.'),
  ],
}
const note = (id: string, card: string, n: number | null, text: string, details: string) => ({ id, card, step: n == null ? null : `s${n}`, n, ref: n == null ? `card:${card}` : `card:${card}#step-${n}`, check: 'you-should-know', run: 'r1', author: 'check', text, details, ts: '', status: 'open' })
let COMMENTS = [
  note('k1', 'plan1', 4, 'Blocking the web also blocks GitHub.', 'The pandas build downloads two of its libraries from GitHub, not PyPI. Unless they are baked into the image, the pilot will fail.'),
  note('k2', 'plan1', null, 'The pilot only tests the emergent prompt.', ["The manager agent's prompt runs for the first time in the full run.", ...['assigns', 'reassigns', 'reviews', 'merges', 'reverts', 'waits', 'retries', 'stops'].map((w) => `- How the manager ${w} work is never tried in the pilot, so the full run is the first time anyone sees it.`)].join('\n')),
  note('k3', 'box1', null, 'Each agent builds pandas from source on 1 CPU.', 'A build takes about a minute; 48 agents at once can slow the machine.'),
]
const run = { run: 'r1', status: 'done', chat: '', started: '', covered: [], seen: [], comments: 3, summary: '' }
let YSK = { id: 'you-should-know', name: 'You should know', prompt: 'Leave a comment…', colour: 2, shown: true, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: { '@canvas': run }, covers: ['documents', 'cards'] }
const UNVERIFIED = { ...YSK, id: 'unverified', name: 'Unverified', colour: 5, shown: false, runs: {}, covers: ['documents'] }

beforeAll(async () => {
  const script = await bundle(
    'canvas-comments',
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
  // the comments answer once the test says so, after it has drawn the plan's step rows into the card
  let release: () => void = () => {}
  const ready = new Promise<void>((r) => (release = r))
  await page.exposeFunction('releaseComments', () => release())
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') {
      await ready
      return json({ comments: COMMENTS })
    }
    const res = /^\/api\/ws\/w\/canvas\/comments\/([^/]+)\/resolve$/.exec(p)
    if (res) {
      resolved.push({ id: res[1], how: JSON.parse(req.postData() || '{}').how })
      COMMENTS = COMMENTS.filter((c) => c.id !== res[1])
      return json({ comments: COMMENTS })
    }
    if (p === '/api/ws/w/checks') return json([UNVERIFIED, YSK])
    if (p === '/api/ws/w/checks/you-should-know' && req.method() === 'PATCH') {
      const shown = JSON.parse(req.postData() || '{}').shown
      patched.push({ id: 'you-should-know', shown })
      YSK = { ...YSK, shown }
      return json(YSK)
    }
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  // the frame open, as the analyst leaves it once they open it (a collapsed frame draws its first card alone)
  await page.evaluate(() => localStorage.setItem('thimble:w:canvas-open', JSON.stringify(['g'])))
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="plan1"]')
  // the plan's step rows, drawn as a plan card draws them: a row per step carrying its anchor
  await page.evaluate(() => {
    const body = document.querySelector('[data-cell="plan1"] .bcell-body')!
    const list = document.createElement('div')
    for (let n = 1; n <= 5; n++) {
      const row = document.createElement('div')
      row.setAttribute('data-step', String(n))
      row.setAttribute('data-anchor', `card:plan1#step-${n}`)
      row.style.cssText = 'height:46px;border-top:1px solid #ddd'
      row.textContent = `${n} step`
      list.appendChild(row)
    }
    body.appendChild(list)
  })
  await page.evaluate(() => (window as unknown as { releaseComments: () => void }).releaseComments())
  await page.waitForSelector('[data-canvas-comment="k3"]')
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
const shown = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-canvas-comment]')].filter((e) => getComputedStyle(e).visibility !== 'hidden').map((e) => e.dataset.canvasComment))

test('each comment sits right of the frame, level with its step row or its card, and none overlap', async () => {
  const frame = (await box('[data-group="g"]'))!
  const step4 = (await box('[data-anchor="card:plan1#step-4"]'))!
  const plan = (await box('[data-cell="plan1"]'))!
  const k1 = (await box('[data-canvas-comment="k1"]'))!
  const k2 = (await box('[data-canvas-comment="k2"]'))!
  const k3 = (await box('[data-canvas-comment="k3"]'))!
  const scale = await page.evaluate(() => {
    const plane = document.querySelector<HTMLElement>('.board-plane')!
    return new DOMMatrix(getComputedStyle(plane).transform).a
  })
  for (const [name, b] of [['k1', k1], ['k2', k2], ['k3', k3]] as const) assert.ok(b.left >= frame.right + 10 * scale && b.left <= frame.right + 26 * scale, `${name} beside the frame: ${b.left} vs ${frame.right}`)
  // the comment on step 4 stands at its row, 4 plane px above it; the comment on the card at the card's top
  assert.ok(Math.abs(k1.top - (step4.top - 4 * scale)) <= 6, `k1 at step 4's row: ${k1.top} vs ${step4.top}`)
  assert.ok(Math.abs(k2.top - (plan.top + 14 * scale)) <= 6 || k2.top >= k1.bottom, `k2 at the plan's top or below k1: ${k2.top}`)
  const all = [k1, k2, k3].sort((a, b) => a.top - b.top)
  for (let i = 1; i < all.length; i++) assert.ok(all[i].top >= all[i - 1].bottom, `no overlap: ${JSON.stringify(all)}`)
  // no line runs to any comment
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ccm-lines, .board svg path[data-line]').length), 0)
  // a comment's header is its check's name alone, and it shows its statement; its details wait for its Show more
  const head = await page.textContent('[data-canvas-comment="k1"] .wu-cm-head')
  assert.ok(head!.includes('You should know') && !head!.includes('Claude') && !head!.includes('Heads up'), head!)
  assert.equal(await page.textContent('[data-canvas-comment="k1"] .wu-cm-statement'), 'Blocking the web also blocks GitHub.')
  assert.ok(!(await page.textContent('[data-canvas-comment="k1"]'))!.includes('baked into the image'), 'the details stay folded')
})

/** Any line drawn to a comment (none), each comment's place, stacking and shadow, and the highlights: each highlighted
 * element's anchor (its step's row, or the card's question), whether it is the strong one, and its color and underline. */
const drawn = () =>
  page.evaluate(() => {
    const lines = document.querySelectorAll('.ccm-lines, svg path[data-line]').length
    const cards = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-canvas-comment]')].map((el) => {
        const cs = getComputedStyle(el)
        return [el.dataset.canvasComment!, { top: el.getBoundingClientRect().top, z: Number(cs.zIndex) || 0, shadow: cs.boxShadow }]
      }),
    )
    const flags = [...document.querySelectorAll<HTMLElement>('.wu-flag')].map((el) => ({
      anchor: el.closest<HTMLElement>('[data-anchor]')?.dataset.anchor ?? '',
      active: el.classList.contains('wu-flag-active'),
      bg: getComputedStyle(el).backgroundColor,
      underline: getComputedStyle(el).boxShadow,
      flag: el.style.getPropertyValue('--flag'),
    }))
    return { lines, cards, flags }
  })
const clear = (c: string) => c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c)
const REST = [
  { anchor: 'card:plan1', active: false },
  { anchor: 'card:plan1#step-4', active: false },
  { anchor: 'card:box1', active: false },
]
const flagsOf = (d: Awaited<ReturnType<typeof drawn>>) => d.flags.map((f) => ({ anchor: f.anchor, active: f.active }))

test("at rest, each commented step and card is highlighted in its check's color, as the Report highlights a passage, with no line", async () => {
  await page.mouse.move(5, 5)
  await page.waitForTimeout(150)
  const got = await drawn()
  assert.equal(got.lines, 0, 'no line at rest')
  assert.deepEqual(flagsOf(got), REST)
  for (const f of got.flags) assert.ok(!clear(f.bg) && f.underline === 'none', `a quiet highlight: ${JSON.stringify(f)}`)
  // the same tint as a commented passage in the Report: the check's color at 16%
  const report = await page.evaluate((flag) => {
    const el = document.createElement('span')
    el.className = 'wu-s wu-flag'
    el.style.setProperty('--flag', flag)
    document.body.appendChild(el)
    const bg = getComputedStyle(el).backgroundColor
    el.remove()
    return bg
  }, got.flags[1].flag)
  assert.ok(got.flags[1].flag && got.flags.every((f) => f.flag === got.flags[1].flag), `each in the check's color ${JSON.stringify(got.flags)}`)
  assert.equal(got.flags[1].bg, report, "the step's highlight is the Report's")
  // the comments at rest share one stacking and one shadow
  const cards = Object.values(got.cards)
  assert.ok(cards.every((c) => c.z === cards[0].z && c.shadow === cards[0].shadow), JSON.stringify(got.cards))
})

test('hovering a comment darkens its highlight with no underline and brings it to the front with more shadow, where it stays', async () => {
  await page.mouse.move(5, 5)
  await page.waitForTimeout(150)
  const rest = await drawn()
  await page.locator('[data-canvas-comment="k1"]').hover()
  await page.waitForTimeout(250)
  const got = await drawn()
  assert.equal(got.lines, 0, 'no line to the hovered comment')
  assert.deepEqual(flagsOf(got), REST.map((f) => ({ ...f, active: f.anchor === 'card:plan1#step-4' })), "step 4's highlight alone is the strong one")
  const step = got.flags[1]
  assert.ok(step.bg !== rest.flags[1].bg && step.underline === 'none', `darker, and not underlined: ${JSON.stringify([rest.flags[1], step])}`)
  const [k1, k2, k3] = ['k1', 'k2', 'k3'].map((id) => got.cards[id])
  assert.ok(k1.z > k2.z && k1.z > k3.z, `in front of the others: ${JSON.stringify(got.cards)}`)
  assert.ok(k1.shadow !== rest.cards.k1.shadow && k2.shadow === rest.cards.k2.shadow, `with more shadow: ${JSON.stringify([rest.cards.k1, k1])}`)
  assert.ok(Math.abs(k1.top - rest.cards.k1.top) <= 1, 'a hovered comment does not move from under the pointer')
  // the pointer gone, the highlights are quiet again and the comment goes back among the others
  await page.mouse.move(5, 5)
  await page.waitForTimeout(250)
  const after = await drawn()
  assert.deepEqual(flagsOf(after), REST)
  assert.equal(after.cards.k1.z, rest.cards.k1.z)
  // a comment on the whole card darkens the card's question
  await page.locator('[data-canvas-comment="k3"]').hover()
  await page.waitForTimeout(150)
  const card = await drawn()
  assert.equal(card.lines, 0)
  assert.deepEqual(flagsOf(card), REST.map((f) => ({ ...f, active: f.anchor === 'card:box1' })))
  await page.mouse.move(5, 5)
  await page.waitForTimeout(150)
})

test('an open comment stands level with its step in front, the comment above it moving up, until it is let go', async () => {
  const at = async () => {
    const step4 = (await box('[data-anchor="card:plan1#step-4"]'))!
    const k1 = (await box('[data-canvas-comment="k1"]'))!
    const k2 = (await box('[data-canvas-comment="k2"]'))!
    return { step4, k1, k2 }
  }
  const s = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector<HTMLElement>('.board-plane')!).transform).a)
  // the comment on the plan opens its details, which push the comment on step 4 down below its row
  await page.locator('[data-canvas-comment="k2"]').hover()
  await page.locator('[data-canvas-comment="k2"] .wu-cm-more').click()
  await page.waitForSelector('[data-canvas-comment="k2"] .wu-cm-details')
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
  const pushed = await at()
  assert.ok(pushed.k1.top > pushed.step4.top + 20, `k1 pushed below step 4: ${JSON.stringify(pushed)}`)
  // opening k1 moves it up to its row, and k2 moves up above it
  await page.locator('[data-canvas-comment="k1"] .wu-cm-statement').click()
  await page.waitForSelector('[data-canvas-comment="k1"].wu-cm-active')
  await page.mouse.move(5, 5)
  await page.waitForTimeout(500)
  const open = await at()
  assert.ok(Math.abs(open.k1.top - (open.step4.top - 4 * s)) <= 6, `k1 level with step 4: ${JSON.stringify(open)}`)
  assert.ok(open.k2.bottom <= open.k1.top + 1 && open.k2.top < pushed.k2.top - 20, `k2 moved up above it: ${JSON.stringify({ pushed, open })}`)
  const got = await drawn()
  assert.equal(got.lines, 0)
  assert.deepEqual(got.flags.filter((f) => f.active).map((f) => f.anchor), ['card:plan1#step-4'])
  assert.ok(got.cards.k1.z > got.cards.k2.z && got.cards.k1.z > got.cards.k3.z, 'in front while open')
  // hovering another comment darkens that one's place alone, and the open one stays where it stands
  await page.locator('[data-canvas-comment="k3"]').hover()
  await page.waitForTimeout(250)
  const other = await drawn()
  assert.deepEqual(other.flags.filter((f) => f.active).map((f) => f.anchor), ['card:box1'])
  assert.ok(Math.abs(other.cards.k1.top - got.cards.k1.top) <= 1)
  // let go, it goes back below the comment above it
  await page.mouse.move(5, 5)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForFunction(() => !document.querySelector('.wu-cm-active'))
  await page.waitForTimeout(500)
  const done = await drawn()
  assert.deepEqual(flagsOf(done), REST)
  const back = await at()
  assert.ok(Math.abs(back.k1.top - pushed.k1.top) <= 2 && Math.abs(back.k2.top - pushed.k2.top) <= 2, `back in the stack: ${JSON.stringify({ pushed, back })}`)
  await page.locator('[data-canvas-comment="k2"]').hover()
  await page.locator('[data-canvas-comment="k2"] .wu-cm-more').click()
  await page.waitForFunction(() => !document.querySelector('[data-canvas-comment="k2"] .wu-cm-details'))
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
})

test("a comment's Show more opening its details moves the comments below it down, and folding them moves them back", async () => {
  const tops = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-canvas-comment]')].map((e) => [e.dataset.canvasComment!, e.getBoundingClientRect().top])))
  const before = await tops()
  assert.ok(before.k2 < before.k1, 'the comment on the plan stands above the one on its step 4')
  const sel = '[data-canvas-comment="k2"]'
  await page.locator(sel).hover()
  // nothing but the details' own height may move the others
  await page.locator(`${sel} .wu-cm-more`).click()
  await page.waitForSelector(`${sel} .wu-cm-details`)
  await page.waitForTimeout(300)
  const open = (await Promise.all(['k1', 'k2', 'k3'].map((id) => box(`[data-canvas-comment="${id}"]`)))).map((b) => b!)
  assert.ok(open[0].top > before.k1 + 1, `k1 moved down: ${open[0].top} vs ${before.k1}; ${JSON.stringify(open)}`)
  const all = [...open].sort((x, y) => x.top - y.top)
  for (let i = 1; i < all.length; i++) assert.ok(all[i].top >= all[i - 1].bottom, `no overlap with the details open: ${JSON.stringify(all)}`)
  await page.locator(`${sel} .wu-cm-more`).click()
  await page.waitForFunction((s) => !document.querySelector(`${s} .wu-cm-details`), sel)
  await page.waitForTimeout(300)
  const after = await tops()
  for (const id of Object.keys(before)) assert.ok(Math.abs(after[id] - before[id]) <= 1, `${id} back in its place: ${after[id]} vs ${before[id]}`)
  await page.mouse.move(5, 5)
})

test('Comments in the top bar lists the check over the cards with its count, and its square turns it off and on', async () => {
  await page.locator('.bctl-comments').click()
  await page.waitForSelector('.popover.bcomments')
  const rows = await page.evaluate(() => [...document.querySelectorAll('.popover.bcomments .wu-check')].map((r) => ({ id: (r as HTMLElement).dataset.check, name: r.querySelector('.wu-check-name')?.textContent, count: r.querySelector('.wu-count')?.textContent, on: r.querySelector('[role="switch"]')?.getAttribute('aria-checked') })))
  assert.deepEqual(rows, [{ id: 'you-should-know', name: 'You should know', count: '3', on: 'true' }], 'Unverified covers the documents alone')
  await page.locator('.popover.bcomments [data-check="you-should-know"] [role="switch"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-comment]').length === 0)
  assert.deepEqual(patched, [{ id: 'you-should-know', shown: false }])
  assert.equal(await page.locator('.wu-flag').count(), 0, 'its highlights go with its comments')
  await page.locator('.popover.bcomments [data-check="you-should-know"] [role="switch"]').click()
  await page.waitForSelector('[data-canvas-comment="k1"]')
  assert.deepEqual(patched.at(-1), { id: 'you-should-know', shown: true })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.popover.bcomments'))
  await page.waitForTimeout(400)
  assert.deepEqual((await shown()).sort(), ['k1', 'k2', 'k3'])
  assert.deepEqual(flagsOf(await drawn()), REST, 'and come back with them')
})

test('✓ resolves a comment, which goes, and Know it resolves one as known', async () => {
  await page.locator('[data-canvas-comment="k2"]').hover()
  await page.locator('[data-canvas-comment="k2"] .wu-cm-resolve').click()
  await page.waitForFunction(() => !document.querySelector('[data-canvas-comment="k2"]'))
  assert.deepEqual(resolved, [{ id: 'k2', how: 'done' }])
  await page.locator('[data-canvas-comment="k3"]').hover()
  await page.locator('[data-canvas-comment="k3"] .wu-cm-know').click()
  await page.waitForFunction(() => !document.querySelector('[data-canvas-comment="k3"]'))
  assert.deepEqual(resolved.at(-1), { id: 'k3', how: 'known' })
  await page.waitForTimeout(400)
  assert.deepEqual(await shown(), ['k1'])
  const step4 = (await box('[data-anchor="card:plan1#step-4"]'))!
  const k1 = (await box('[data-canvas-comment="k1"]'))!
  assert.ok(k1.top <= step4.top, 'the comment left still stands at its row')
})
