// One comment pattern in the Report's margin and on the canvas, in a real browser with thimble's own stylesheets: the
// real Margin (src/report/Margin.tsx) beside two passages, and the real Canvas (src/canvas/Canvas.tsx) holding a plan card
// in the analyst's frame with a comment on its step 2 (GET /canvas/comments). Each comment is one card
// (src/report/CommentCard.tsx): its header is its check's name in the check's color, the color square matching, with no
// "Claude"; it shows its statement, and its details only once Show more under the statement opens them (by pointer or
// keyboard), their citation a chip, which moves the comment below it down in the margin; on hover its menu shows Ask and
// Know it before ✓, alike on both surfaces; Ask puts the caret in its field, whose
// question opens a thread (POST /chats) anchored to the comment's passage or step with the comment's id and words. With
// no frame kept open in the browser, the analyst's frame, Your work, starts open. Matt 2026-10-09: "it shows a short
// comment, then you expand for details ... and can ask follow ups"; "what does comment menu look like? should be
// analogous to menu in reports"; "instead of the >, use text like 'Show more' or something that's placed below the
// short description".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const threads: Record<string, unknown>[] = []

const step = (id: string, text: string, makes: string[]) => ({ id, text, makes, status: 'not started', note: '', runs: [], time: '', started: null, ended: null })
const PLAN = { id: 'plan1', notebook: 'g', kind: 'plan', title: 'Plan: build the environment and pilot it', takeaway: '', created_by: 'chat:main', ts: '2026-10-08T12:00:00+00:00', payload: { steps: [step('s1', 'Mirror pandas into a local GitHub', ['mirror/']), step('s2', 'Build the agent container: PyPI and conda but no web', ['Dockerfile.agent']), step('s3', 'Pilot: 2 agents, one PR each', ['pilot/'])], follows: null } }
const BOX = { id: 'box1', notebook: 'g', kind: 'note', title: 'What can an agent do in its container?', takeaway: '', created_by: 'model', ts: '2026-10-08T12:00:00+00:00', payload: { text: 'Agents can install from PyPI and conda.' }, text: 'Agents can install from PyPI and conda.' }
const CANVAS = { groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }], cells: [PLAN, BOX] }
const DETAILS = '- The pandas build fetches two of its libraries from GitHub [[2|card:box1]].\n- Bake them into the image, or allow github.com.'
const COMMENTS = [{ id: 'k1', card: 'plan1', step: 's2', n: 2, ref: 'card:plan1#step-2', check: 'you-should-know', run: 'r1', author: 'check', text: 'Blocking the web also blocks GitHub.', details: DETAILS, evidence: 'card:box1', ts: '', status: 'open' }]
const YSK = { id: 'you-should-know', name: 'You should know', prompt: 'Leave a comment…', colour: 2, shown: true, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {}, covers: ['documents', 'cards'] }
const PASSAGE = 'Most saves came in one week of June.'
const PASSAGE2 = 'Half of them were from new accounts.'
const STORED = [{ id: 'c1', sentence_id: 's1', text: 'Most saves came from one bot account.', details: '- The table counts [[612|card:box1]] of 900 saves.\n- Leave the bot out, or say so.', author: 'check', check: 'you-should-know', status: 'open', evidence: 'card:box1' }, { id: 'c2', sentence_id: 's2', text: 'New accounts here means made in June.', details: 'The table dates each account by its first save.', author: 'check', check: 'you-should-know', status: 'open', evidence: '' }]

const R = '#report [data-comment="c1"]'
const C = '[data-canvas-comment="k1"]'

beforeAll(async () => {
  const script = await bundle(
    'comment-pattern',
    [
      `import '${src('styles/index.css')}'`,
      `import { useRef, useState } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { Margin } from '${src('report/Margin.tsx')}'`,
      `import { checkLook, openComments } from '${src('report/checkComments.ts')}'`,
      `const look = checkLook([{ id: 'you-should-know', name: 'You should know', colour: 2 }])`,
      `const comments = openComments(${JSON.stringify(STORED)} as never, [])`,
      `function Report() {`,
      `  const column = useRef<HTMLDivElement>(null)`,
      `  const [active, setActive] = useState<string | null>(null)`,
      `  return (`,
      `    <div style={{ display: 'flex', padding: 24 }}>`,
      `      <div ref={column} style={{ width: 380, paddingTop: 60 }}><p><span data-sid="s1">${PASSAGE}</span> <span data-sid="s2">${PASSAGE2}</span></p></div>`,
      `      <Margin ws="w" slug="report" comments={comments} look={look} active={active} onActivate={setActive} onResolve={async () => {}} draft={null} onDraft={async () => {}} onDraftCancel={() => {}} column={column} textOf={() => '${PASSAGE}'} />`,
      `    </div>`,
      `  )`,
      `}`,
      `createRoot(document.getElementById('report')!).render(<Report />)`,
      `createRoot(document.getElementById('canvas')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: COMMENTS })
    if (p === '/api/ws/w/checks') return json([YSK])
    if (p === '/api/ws/w/chats' && req.method() === 'POST') {
      threads.push(JSON.parse(req.postData() || '{}'))
      return json({ id: `t${threads.length}`, kind: 'thread', title: 'thread' })
    }
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="report" style="position:absolute;left:0;top:0;bottom:0;width:720px;overflow:auto"></div><div id="canvas" style="position:absolute;left:730px;right:0;top:0;bottom:0;display:flex"></div></body></html>',
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => localStorage.clear())
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="plan1"] [data-anchor="card:plan1#step-2"]')
  await page.waitForSelector(C)
  await page.waitForFunction((r) => {
    const el = document.querySelector<HTMLElement>(r)
    return !!el && getComputedStyle(el).visibility !== 'hidden'
  }, R)
  await page.waitForTimeout(500)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const visible = (sel: string) => page.evaluate((s) => {
  const el = document.querySelector<HTMLElement>(s)
  return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
}, sel)

test("Your work starts open on the first load, with nothing kept in the browser", async () => {
  assert.equal(await page.locator('[data-group="g"] .frame-chev.is-open').count(), 1, 'the analyst\'s frame is open')
  const [plan, box] = await page.evaluate(() => ['plan1', 'box1'].map((id) => document.querySelector(`[data-cell="${id}"]`)!.getBoundingClientRect().toJSON()))
  assert.ok(plan.bottom <= box.top, `its second card stands below the first, not under it: ${plan.bottom} vs ${box.top}`)
  assert.deepEqual(JSON.parse((await page.evaluate(() => localStorage.getItem('thimble:w:canvas-open')))!), ['g'])
})

test("each comment shows its check's name in the check's color and its statement, its details folded, on both surfaces", async () => {
  for (const [sel, statement] of [[R, 'Most saves came from one bot account.'], [C, 'Blocking the web also blocks GitHub.']] as const) {
    const got = await page.evaluate((s) => {
      const card = document.querySelector<HTMLElement>(s)!
      return {
        name: card.querySelector('.wu-cm-name')!.textContent,
        color: getComputedStyle(card.querySelector('.wu-cm-name')!).color,
        square: getComputedStyle(card.querySelector('.wu-cm-sq')!).backgroundColor,
        head: card.querySelector('.wu-cm-head')!.textContent,
        statement: card.querySelector('.wu-cm-statement')!.textContent,
        details: !!card.querySelector('.wu-cm-details'),
        text: card.innerText,
      }
    }, sel)
    assert.equal(got.name, 'You should know', sel)
    assert.equal(got.color, got.square, `${sel}: the name takes the square's color`)
    assert.ok(!got.head!.includes('Claude') && !got.head!.includes('Heads up'), `${sel}: ${got.head}`)
    assert.equal(got.statement, statement)
    assert.ok(!got.details && !got.text.includes('Bake them') && !got.text.includes('Leave the bot out'), `${sel}: the details stay folded`)
  }
})

test('the menu is the same on both surfaces: Ask and Know it on hover, before ✓, and Show more under the statement', async () => {
  const menus = []
  for (const sel of [R, C]) {
    assert.equal(await visible(`${sel} .wu-cm-menu`), false, `${sel}: the menu waits for the pointer`)
    await page.locator(sel).hover()
    await page.waitForTimeout(100)
    assert.equal(await visible(`${sel} .wu-cm-menu`), true, `${sel}: hovered, the menu shows`)
    menus.push(
      await page.evaluate((s) => {
        const card = document.querySelector<HTMLElement>(s)!
        const box = (q: string) => card.querySelector(q)!.getBoundingClientRect()
        const look = (q: string) => {
          const cs = getComputedStyle(card.querySelector(q)!)
          return [cs.fontSize, cs.fontWeight, cs.color, cs.height, cs.paddingLeft, cs.borderRadius].join(' ')
        }
        const cs = getComputedStyle(card)
        return {
          buttons: [...card.querySelectorAll('.wu-cm-head button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label')),
          act: look('.wu-cm-ask'),
          know: look('.wu-cm-know'),
          done: look('.wu-cm-resolve'),
          more: look('.wu-cm-more'),
          moreText: card.querySelector('.wu-cm-more')!.textContent,
          card: [cs.paddingTop, cs.paddingLeft, cs.borderRadius, cs.fontSize, cs.backgroundColor].join(' '),
          order: box('.wu-cm-know').right <= box('.wu-cm-resolve').left + 1,
          // Show more stands under the statement, at its left
          below: box('.wu-cm-more').top >= box('.wu-cm-statement').bottom - 1 && Math.abs(box('.wu-cm-more').left - box('.wu-cm-statement').left) <= 4,
          inside: box('.wu-cm-menu').left >= box('.wu-cm-head').left && box('.wu-cm-resolve').right <= card.getBoundingClientRect().right,
        }
      }, sel),
    )
    await page.mouse.move(5, 5)
  }
  assert.deepEqual(menus[0].buttons, ['Ask', 'Know it', 'Done'])
  assert.equal(menus[0].moreText, 'Show more')
  assert.deepEqual(menus[1], menus[0], 'the canvas menu looks as the Report menu does')
  assert.ok(menus[0].order && menus[0].below && menus[0].inside, JSON.stringify(menus[0]))
})

test('Show more opens the details, their citation a chip, and Show less under them folds them again, on both surfaces', async () => {
  for (const [sel, words] of [[R, 'Leave the bot out'], [C, 'Bake them into the image']] as const) {
    await page.locator(sel).hover()
    await page.locator(`${sel} .wu-cm-more`).click()
    await page.waitForSelector(`${sel} .wu-cm-details`)
    const got = await page.evaluate((s) => {
      const d = document.querySelector<HTMLElement>(`${s} .wu-cm-details`)!
      const more = document.querySelector<HTMLElement>(`${s} .wu-cm-more`)!
      return { text: d.innerText, items: d.querySelectorAll('li').length, chips: [...d.querySelectorAll<HTMLElement>('.refchip')].map((c) => c.dataset.ref), field: !!document.querySelector(`${s} .wu-cm-reply`), less: more.textContent, under: more.getBoundingClientRect().top >= d.getBoundingClientRect().bottom - 1 }
    }, sel)
    assert.ok(got.text.includes(words) && got.items === 2, `${sel}: ${got.text}`)
    assert.deepEqual(got.chips, ['card:box1'])
    assert.equal(got.field, false, `${sel}: Show more opens the details alone`)
    assert.ok(got.less === 'Show less' && got.under, `${sel}: Show less under the details ${JSON.stringify(got)}`)
    await page.locator(`${sel} .wu-cm-more`).click()
    await page.waitForFunction((s) => !document.querySelector(`${s} .wu-cm-details`), sel)
    await page.mouse.move(5, 5)
  }
})

test('the keyboard opens and folds the details: Tab to Show more, then Enter', async () => {
  for (const sel of [R, C]) {
    await page.locator(`${sel} .wu-cm-more`).focus()
    assert.ok(await page.evaluate((s) => document.activeElement === document.querySelector(`${s} .wu-cm-more`), sel), `${sel}: Show more takes the focus`)
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${sel} .wu-cm-details`)
    assert.equal(await page.textContent(`${sel} .wu-cm-more`), 'Show less')
    await page.keyboard.press('Enter')
    await page.waitForFunction((s) => !document.querySelector(`${s} .wu-cm-details`), sel)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  }
})

test("in the Report, a comment's Show more opening its details moves the comment below it down, and folding them moves it back", async () => {
  const c2 = '#report [data-comment="c2"]'
  const top = (s: string) => page.evaluate((q) => document.querySelector(q)!.getBoundingClientRect().top, s)
  const was = await top(c2)
  await page.locator(R).hover()
  // nothing but the details' own height may move the comment below
  await page.locator(`${R} .wu-cm-more`).click()
  await page.waitForSelector(`${R} .wu-cm-details`)
  // the margin places its cards on the next frame and slides them there (report.css .wu-cm transition), so the test
  // waits until they stand still, up to 3 s, before it measures
  const settled = () => page.waitForFunction(([a, b]) => [a, b].every((q) => !document.querySelector(q)!.getAnimations().length), [R, c2], { timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(300)
  await settled()
  const [r, b] = await page.evaluate((qs) => qs.map((q) => document.querySelector(q)!.getBoundingClientRect().toJSON()), [R, c2])
  assert.ok(b.top >= r.bottom, `c2 below c1's open details: ${b.top} vs ${r.bottom}`)
  await page.locator(`${R} .wu-cm-more`).click()
  await page.waitForFunction((s) => !document.querySelector(`${s} .wu-cm-details`), R)
  await page.waitForTimeout(300)
  await settled()
  assert.ok(Math.abs((await top(c2)) - was) <= 1, 'c2 back in its place')
  await page.mouse.move(5, 5)
})

test("Ask puts the caret in the comment's field, and the question opens a thread anchored to the comment, on both surfaces", async () => {
  const cases = [
    { sel: R, id: 'c1', anchor: 'report:report#s1', surface: 'report', who: `${PASSAGE}\n\nThe comment c1 of the check “You should know”: Most saves came from one bot account.` },
    { sel: C, id: 'k1', anchor: 'card:plan1#step-2', surface: 'canvas', who: 'Plan: build the environment and pilot it\n\nThe comment k1 of the check “You should know” (on step 2): Blocking the web also blocks GitHub.' },
  ]
  for (const [i, { sel, id, anchor, surface, who }] of cases.entries()) {
    await page.locator(sel).hover()
    await page.locator(`${sel} .wu-cm-ask`).click()
    await page.waitForSelector(`${sel}.wu-cm-active .wu-cm-reply textarea`)
    assert.ok(await page.evaluate((s) => document.activeElement === document.querySelector(`${s} .wu-cm-reply textarea`), sel), `${sel}: the caret is in the field`)
    await page.keyboard.type('Which one?')
    await page.keyboard.press('Enter')
    for (let k = 0; k < 50 && threads.length <= i; k++) await page.waitForTimeout(50)
    assert.equal(threads.length, i + 1, `${sel}: one thread`)
    const t = threads[i] as { anchor: string; anchor_text: string; surface: string; element: string; text: string; comment: string }
    assert.deepEqual([t.anchor, t.surface, t.element, t.text, t.comment], [anchor, surface, 'comment', 'Which one?', id], 'the thread names its comment, whose line the anchor line shows')
    assert.ok(t.anchor_text.startsWith(who), `${sel}: ${t.anchor_text}`)
    assert.ok(t.anchor_text.includes('Bake them') || t.anchor_text.includes('Leave the bot out'), 'the thread knows the details too')
    await page.mouse.click(5, 900)
  }
})
