// The report checks in the sidebar (src/report/Checks.tsx), mounted with the report page (ReportPage.tsx) against
// routed API answers that do what the checks routes of backend/app/checks.py do:
// the rows from GET /checks, the built-ins first and every one off; a check turned on through PATCH alone, the server
// running it where it has passages not seen; the spinner the stream's `check` records raise, which opens the run's
// chat once it has one and goes when the run ends; a row's count, – before the check has a result on the document and
// left out while it runs; a check's card beside the pane, its prompt edited in place; a new check from a name and a
// prompt; and
// the margin showing a check's comments only while it is on, the analyst's always.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const sent: any[] = [] // [method, path, body] of every write the page makes
const reads = { checks: 0 }

const run = (extra = {}) => ({ run: 'r1', status: 'done', chat: 'k1', started: '', ended: '', covered: [], seen: [], comments: 1, summary: 'done', ...extra })
const CHECKS = () => [
  { id: 'unverified', name: 'Unverified', prompt: 'Comment on each claim nothing shows.', colour: 5, shown: false, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {} },
  { id: 'verified', name: 'Verified', prompt: 'Comment on each claim a card shows.', colour: 3, shown: false, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: { report: run() } },
  { id: 'judgment', name: 'Judgment calls', prompt: 'Comment on each call the analysis makes.', colour: 1, shown: false, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {} },
]
const state: { checks: any[] } = { checks: CHECKS() }
/** What the server does when a check comes on, is made, or takes a new prompt while on: a run on the report, unless the
 * check has a done run there for its version (checks.refresh, which covers what it has not seen). */
function serverRuns(c: any, fresh: any) {
  if (!c.shown) return
  const was = c.runs?.report
  if (!fresh && was?.status === 'done') return
  c.runs = { ...c.runs, report: run({ run: `r-${c.id}`, status: 'running', chat: '', comments: 0, summary: '' }) }
}

const sentence = (id: string, text: string, extra: object = {}) => ({ id, text, refs: [], tags: [], ...extra })
const DOC = {
  title: 'Refunds',
  frame: false,
  generation: 3,
  sections: [
    {
      id: 'h1',
      heading: 'Findings',
      paragraphs: [
        { id: 'p1', sentences: [sentence('x1', 'Refunds rose in March.'), sentence('x2', 'Half of them came from one store.', { tags: ['unverified'], tag_notes: { unverified: 'no card counts stores' } })] },
        { id: 'p2', sentences: [sentence('x3', 'The rise follows the new policy.')] },
      ],
      figures: [],
    },
  ],
  comments: [
    { id: 'c1', sentence_id: 'x1', text: 'The March card shows it.', author: 'check', check: 'verified', run: 'r1', status: 'open', ts: '' },
    { id: 'c2', sentence_id: 'x3', text: 'A reading of the timing, not a count.', author: 'check', check: 'judgment', run: 'r0', status: 'open', ts: '' },
    { id: 'c3', sentence_id: 'x3', text: 'Ask the store manager.', author: 'analyst', status: 'open', ts: '' },
  ],
}


beforeAll(async () => {
  script = await bundle('report-checks', [
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ReportPage } from '${src('report/ReportPage.tsx')}'`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `import { dispatch } from '${src('lib/events.ts')}'`,
      `window.__bus = bus`,
      `window.__dispatch = dispatch`,
      `window.__opened = []`,
      `bus.on('openChat', (e) => window.__opened.push(e.chatId))`,
      `let roots = []`,
      `window.__mount = (doc) => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:760px;display:flex'; document.body.appendChild(el); const root = createRoot(el); roots.push([root, el]); flushSync(() => root.render(<ReportPage ws="w" slug="report" doc={doc} filter={null} client="t" onSaved={() => {}} />)) }`,
      `window.__unmount = () => { for (const [r, el] of roots) { r.unmount(); el.remove() } roots = [] }`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const method = req.method()
    const json = (body: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const body = req.postData() ? JSON.parse(req.postData()) : null
    if (method !== 'GET' && p.startsWith('/api/')) sent.push([method, p, body])
    if (p === '/api/ws/w/checks' && method === 'GET') {
      reads.checks++
      return json(state.checks)
    }
    if (p === '/api/ws/w/checks' && method === 'POST') {
      if (state.checks.some((c: any) => c.name === body.name)) return json({ detail: 'name taken' }, 409)
      const made = { id: 'budget', name: body.name, prompt: body.prompt, colour: 2, shown: true, builtin: false, created_by: 'analyst', ts: '', version: 1, runs: {} }
      serverRuns(made, true)
      state.checks.push(made)
      return json(made, 201)
    }
    let m = /^\/api\/ws\/w\/checks\/([^/]+)$/.exec(p)
    if (m && method === 'PATCH') {
      const c = state.checks.find((x: any) => x.id === decodeURIComponent(m[1]))
      Object.assign(c, body)
      if (body.prompt != null) c.version++
      serverRuns(c, body.prompt != null)
      return json(c)
    }
    if (p === '/api/ws/w/canvas') return json({ cells: [], groups: [] })
    if (p.startsWith('/api/')) return json({ detail: 'no' }, 404)
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=w')
  await addStyles(page, ['tokens', 'base', 'components', 'spinner', 'refchip', 'report'])
  await page.addScriptTag({ path: script })
  await page.evaluate((doc: any) => (window as any).__mount(doc), DOC)
  await page.waitForSelector('.wu-check[data-check="judgment"]')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const row = (id: any) => page.locator(`.wu-check[data-check="${id}"]`)
const toggle = (id: any) => row(id).locator('.wu-check-toggle')
const margin = () => page.locator('.wu-rail .wu-cm').allInnerTexts()
const writes = (method: any, p: any) => sent.filter(([m, q]: any) => m === method && q === p)
const settle = () => page.waitForTimeout(350)
/** The stream's record for a run, as checks._stream sends it. */
const stream = (id: any, status: any, chat = '') => page.evaluate((r: any) => (window as any).__dispatch(r), { type: 'check', id, doc: 'report', status, run: `r-${id}`, chat })


test('the rows are the server\'s checks, the built-ins first, every one off, each with its colour and count', async () => {
  assert.deepEqual(await page.locator('.wu-check-name').allInnerTexts(), ['Unverified', 'Verified', 'Judgment calls'])
  assert.deepEqual(await page.locator('.wu-check-toggle').evaluateAll((els: any) => els.map((e: any) => e.getAttribute('aria-checked'))), ['false', 'false', 'false'])
  assert.deepEqual(await page.locator('.wu-check .wu-count').allInnerTexts(), ['1', '1', '1'], 'Unverified counts the citation check\'s tag')
  const sq = await row('unverified').locator('.wu-check-sq').evaluate((e: any) => e.getAttribute('style'))
  assert.match(sq, /var\(--label-5\)/, 'Unverified is drawn in the palette\'s red')
  assert.match(sq, /background: transparent/, 'an empty square while off')
  const texts = await margin()
  assert.equal(texts.length, 1, 'every check off: the analyst\'s own comment alone')
  assert.match(texts[0], /Ask the store manager/)
})

test('turning on a check that has a run for its version sends PATCH alone; its comments come into the margin', async () => {
  await toggle('verified').click()
  await settle()
  assert.deepEqual(writes('PATCH', '/api/ws/w/checks/verified').map((w: any) => w[2]), [{ shown: true }])
  assert.equal(await row('verified').locator('.wu-check-run').count(), 0, 'its done run on the report is current, so nothing runs')
  assert.equal(await toggle('verified').getAttribute('aria-checked'), 'true')
  const sq = await row('verified').locator('.wu-check-sq').evaluate((e: any) => e.getAttribute('style'))
  assert.match(sq, /background: var\(--label-3\)/, 'filled in its colour while on')
  const texts = await margin()
  assert.equal(texts.length, 2)
  assert.ok(texts.some((t: any) => /Verified/.test(t) && /The March card shows it/.test(t)), 'the card names its check')
})

test('a check with no run on the report runs on the server once on; its spinner opens the run and goes when it ends', async () => {
  await toggle('unverified').click()
  await settle()
  assert.deepEqual(writes('PATCH', '/api/ws/w/checks/unverified').map((w: any) => w[2]), [{ shown: true }], 'PATCH alone: the pane starts no run')
  const spin = row('unverified').locator('.wu-check-run')
  assert.equal(await spin.count(), 1, 'a spinner from the run the answer carries')
  assert.equal(await spin.locator('.spinner').count(), 1)
  assert.equal(await spin.getAttribute('aria-label'), 'Unverified waits for a free session', 'waiting for a free session, the run has no chat to open')
  await spin.click({ force: true })
  assert.deepEqual(await page.evaluate(() => (window as any).__opened), [], 'so a click opens nothing')
  // queued until the report's writer ends (backend checks.py, while a writer runs): the tip says so
  state.checks[0].runs.report.waiting = 'writer'
  await stream('unverified', 'running')
  await settle()
  assert.equal(await spin.getAttribute('aria-label'), 'Unverified runs once the writer has finished')
  delete state.checks[0].runs.report.waiting
  // the session starts: the stream names its chat
  state.checks[0].runs.report.chat = 'k-unverified'
  await stream('unverified', 'running', 'k-unverified')
  await settle()
  assert.equal(await spin.getAttribute('aria-label'), 'Unverified is running: open its run')
  await spin.click()
  assert.deepEqual(await page.evaluate(() => (window as any).__opened), ['k-unverified'], 'the spinner opens the run\'s chat')
  assert.ok((await margin()).some((t: any) => /no card counts stores/.test(t)), 'the tag shows under Unverified while its run goes on')
  // the stream says the run ended: the spinner goes at once and the list is read again
  const before = reads.checks
  state.checks[0].runs.report = run({ run: 'r-unverified', status: 'done', chat: 'k-unverified' })
  await stream('unverified', 'done', 'k-unverified')
  await settle()
  assert.equal(await row('unverified').locator('.wu-check-run').count(), 0)
  assert.ok(reads.checks > before, 'the list read again for what the run changed')
})

test('a check turned off sends PATCH and takes its comments out of the margin; the analyst\'s stay', async () => {
  await toggle('unverified').click()
  await settle()
  assert.deepEqual(writes('PATCH', '/api/ws/w/checks/unverified').map((w: any) => w[2]), [{ shown: true }, { shown: false }])
  const texts = await margin()
  assert.ok(!texts.some((t: any) => /no card counts stores/.test(t)))
  assert.ok(texts.some((t: any) => /Ask the store manager/.test(t)))
})

test('⋯ opens a check\'s card beside the pane: its run, its prompt, edited in place, and its count of comments; Re-run saves a new prompt, which runs a check that is on again', async () => {
  await row('verified').locator('.wu-check-more').click()
  const card = page.locator('.check-card')
  assert.equal(await card.getAttribute('aria-label'), 'Edit Verified')
  assert.equal(await card.locator('.label-sheet-name').innerText(), 'Verified', 'the head names the check, as a label\'s card does')
  assert.match(await card.locator('.wu-check-runline-text').innerText(), /^Ran/, 'its last run on the report')
  const field = card.getByRole('textbox', { name: 'Verified prompt' })
  assert.equal(await field.inputValue(), 'Comment on each claim a card shows.')
  assert.equal(await card.locator('.label-card-classes-head .label-card-hl').innerText(), '1', 'how many comments it left, not their texts')
  assert.equal(await card.getByText('Refunds rose in March.').count(), 0)
  const off = page.locator('.wu-check[data-check="judgment"] .wu-check-more')
  await off.click()
  assert.equal(await card.getByRole('button', { name: 'Save' }).isDisabled(), true, 'a check that is off: Save, once the prompt differs')
  await off.click()
  assert.equal(await card.count(), 0, 'its ⋯ again closes the card')
  await row('verified').locator('.wu-check-more').click()
  await field.fill('Comment on each claim a card shows, naming the card.')
  await card.getByRole('button', { name: 'Re-run' }).click()
  await settle()
  assert.deepEqual(writes('PATCH', '/api/ws/w/checks/verified').at(-1)[2], { prompt: 'Comment on each claim a card shows, naming the card.' })
  assert.equal(await row('verified').locator('.wu-check-run .spinner').count(), 1, 'it is on, so the server reads the report again with the new prompt')
  assert.equal(await card.count(), 0, 'saved: the card closes')
})

test('the head\'s + makes a new check from a name and a prompt: a name taken waits, the new check comes on and runs', async () => {
  await page.getByRole('button', { name: 'New check' }).click()
  const form = page.locator('.check-card')
  assert.equal(await form.getAttribute('aria-label'), 'New check')
  await form.getByRole('textbox', { name: 'Name' }).fill('Verified')
  await form.getByRole('textbox', { name: 'Prompt' }).fill('Comment on each example whose evidence comes from budget.xlsx.')
  assert.equal(await form.getByRole('button', { name: 'Run' }).isDisabled(), true, 'the name is taken')
  await form.getByRole('textbox', { name: 'Name' }).fill('Depends on budget.xlsx')
  await form.getByRole('textbox', { name: 'Prompt' }).press('Control+Enter')
  await settle()
  assert.deepEqual(writes('POST', '/api/ws/w/checks').map((w: any) => w[2]), [{ name: 'Depends on budget.xlsx', prompt: 'Comment on each example whose evidence comes from budget.xlsx.' }])
  assert.equal(await page.locator('.check-card').count(), 0, 'the card closes')
  assert.deepEqual(await page.locator('.wu-check-name').allInnerTexts(), ['Unverified', 'Verified', 'Judgment calls', 'Depends on budget.xlsx'], 'the new check last')
  assert.equal(await toggle('budget').getAttribute('aria-checked'), 'true', 'the server turned it on')
  assert.equal(await row('budget').locator('.wu-check-run .spinner').count(), 1, 'and runs it')
  assert.equal(await row('budget').locator('.wu-count').count(), 0, 'the spinner alone, no count, while it runs')
})

test('a check main made with run_check comes into the pane, on, from the stream\'s record of its run', async () => {
  state.checks.push({ id: 'refunds', name: 'Refund reasons', prompt: 'Comment on each refund reason.', colour: 4, shown: true, builtin: false, created_by: 'main', ts: '', version: 1, runs: { report: run({ run: 'r-refunds', status: 'running', chat: 'k-refunds' }) } })
  await stream('refunds', 'running', 'k-refunds')
  await settle()
  assert.equal(await toggle('refunds').getAttribute('aria-checked'), 'true')
  assert.equal(await row('refunds').locator('.wu-check-run .spinner').count(), 1)
})

test('a check with no result on the report shows – and no count; turned on, the spinner alone; once done, its count, 0 too', async () => {
  state.checks.push({ id: 'dates', name: 'Dates', prompt: 'Comment on each date.', colour: 6, shown: false, builtin: false, created_by: 'analyst', ts: '', version: 1, runs: {} })
  await page.evaluate(() => (window as any).__bus.emit('wsStream', { connected: true }))
  await settle()
  assert.deepEqual(await row('dates').locator('.wu-count').allInnerTexts(), ['–'], 'not run: a dash, not 0')
  assert.equal(await row('dates').locator('.wu-count-none').count(), 1)
  await toggle('dates').click()
  await settle()
  assert.equal(await row('dates').locator('.wu-check-run .spinner').count(), 1)
  assert.equal(await row('dates').locator('.wu-count').count(), 0, 'running: the spinner alone')
  state.checks.find((c: any) => c.id === 'dates').runs.report = run({ run: 'r-dates', status: 'done', chat: 'k-dates', comments: 0 })
  await stream('dates', 'done', 'k-dates')
  await settle()
  assert.equal(await row('dates').locator('.wu-check-run').count(), 0)
  assert.deepEqual(await row('dates').locator('.wu-count').allInnerTexts(), ['0'], 'a finished run with no comments counts 0')
  await toggle('dates').click()
  await settle()
})

test('a click puts the caret where it lands, on a tinted passage too, whether it opens a comment card or closes one', async () => {
  // The sentence the DOM's caret is in, after the click has settled:
  const caretIn = () => page.evaluate(() => {
    const s = window.getSelection()
    const n = s && s.rangeCount ? s.anchorNode : null
    const el: any = n && (n.nodeType === 3 ? n.parentElement : n)
    return el?.closest?.('[data-sid]')?.getAttribute('data-sid') ?? null
  })
  const clickIn = async (sid: any) => {
    const at = await page.evaluate((id: any) => {
      const r = (document.querySelector(`.bn-editor [data-sid="${id}"]`) as any).getClientRects()[0]
      return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }
    }, sid)
    await page.mouse.click(at.x, at.y)
    await settle()
  }
  assert.ok(await page.locator('.bn-editor [data-sid="x1"][data-cids]').count(), 'x1 carries the Verified tint')
  assert.equal(await page.locator('.bn-editor [data-sid="x2"][data-cids]').count(), 0, 'x2 has no tint while Unverified is off')
  await clickIn('x2')
  assert.equal(await caretIn(), 'x2', 'a plain sentence')
  await clickIn('x1')
  assert.equal(await caretIn(), 'x1', 'a tinted sentence, whose card the click opens')
  await clickIn('x2')
  assert.equal(await caretIn(), 'x2', 'a plain sentence again, the click closing the open card')
  await clickIn('x3')
  assert.equal(await caretIn(), 'x3', 'the analyst\'s own comment tints too')
})

test('a check\'s comment on a whole paragraph tints the whole paragraph, the spaces between its sentences too', async () => {
  // add_comment keeps a paragraph's comment on its first sentence and marks it `paragraph`
  // (backend checks.tool_add_comment).
  const doc = { ...DOC, comments: [{ id: 'c8', sentence_id: 'x1', paragraph: true, text: 'Both come from the March card.', author: 'check', check: 'verified', run: 'r1', status: 'open', ts: '' }] }
  await page.evaluate((d: any) => { (window as any).__unmount(); (window as any).__mount(d) }, doc)
  await page.waitForSelector('.bn-editor [data-sid="x1"][data-cids]')
  const cids = (sid: any) => page.locator(`.bn-editor [data-sid="${sid}"]`).evaluate((e: any) => e.getAttribute('data-cids'))
  assert.equal(await cids('x1'), 'c8')
  assert.equal(await cids('x2'), 'c8', 'the paragraph\'s second sentence carries the comment too')
  assert.equal(await cids('x3'), null, 'the next paragraph does not')
  const covered = await page.evaluate(() => {
    const block = (document.querySelector('.bn-editor [data-anchor="report:report#pp1"]') as any)
    return { text: block.textContent, tinted: [...block.querySelectorAll('.wu-flag')].map((e: any) => e.textContent).join('') }
  })
  assert.equal(covered.tinted, covered.text, 'every character of the paragraph is under the tint')
})

test('the UI never starts a run itself, and nothing threw', () => {
  assert.deepEqual(sent.filter(([m, p]: any) => m === 'POST' && /\/runs$/.test(p)), [])
  assert.deepEqual(pageErrors, [])
})
