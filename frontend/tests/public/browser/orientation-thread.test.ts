// The orientation as a thread, mounted whole against routed API answers: the chat panel (src/chat/ChatPanel.tsx) with the orientation's thread, where every call is a chip line
// with its `call:` ref that opens on its whole output; a call citation that previews its lines and opens its call; the
// thread's composer, which sends a follow-up to the orientation; the one permission card above the composer while a
// prompt of the orientation, a writer or a critique is open, naming the thread it comes from; Stop on a writer's card; a
// follow-up's card in main with what it changed and Undo; the Start panel's mode switcher and the running orientation's,
// on its card; and the canvas
// (src/canvas/Canvas.tsx), which draws no scratch work and says so when a citation's card is not on it.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const posted: any[] = [] // [path, body] of every POST the page makes

const T = (m: any) => `2026-09-24T10:${String(m).padStart(2, '0')}:00Z`
const meta = (id: string, extra: object = {}): any => ({ id, kind: 'agent', role: 'orient', title: 'Orientation', created_at: T(0), parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'done', result: null, ts_end: T(20), ...extra })
const MAIN_META = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T(0), parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null, attached: { session: 's', cwd: '/data/mini', since: T(0) } }
const LONG = Array.from({ length: 450 }, (_: any, i: any) => `row ${i + 1}`).join('\n')

// the orientation's session: its brief, a search that printed three lines, a card it added, a step it started, its last
// message, then a follow-up main sent, which revised the card and added one
const OR1 = [
  { type: 'user', ts: T(0), text: 'Start the orientation.', by: 'terminal' },
  { type: 'tool_use', ts: T(1), id: 'u1', name: 'Bash', input: { command: 'grep -c refund /data/mini/tickets/*.jsonl', description: 'Count refunds' }, n: 1 },
  { type: 'tool_result', ts: T(1), id: 'u1', summary: 'a.jsonl:3\nb.jsonl:7\nc.jsonl:0' },
  { type: 'tool_use', ts: T(2), id: 'u2', name: 'mcp__plugin_thimble_thimble__add_card', input: { question: 'Refunds per file' }, n: 2 },
  { type: 'tool_result', ts: T(2), id: 'u2', summary: 'card:aaaa1111\nok', cell_id: 'aaaa1111' },
  { type: 'tool_use', ts: T(3), id: 'u3', name: 'Agent', input: { description: 'Read the tickets' }, n: 5 },
  { type: 'agent', ts: T(3), chat: 's1', role: 'step', title: 'Read the tickets' },
  { type: 'tool_result', ts: T(4), id: 'u3', summary: 'The tickets are complaints.' },
  { type: 'tool_use', ts: T(5), id: 'u6', name: 'Read', input: { file_path: '/data/mini/long.txt' }, n: 6 },
  { type: 'tool_result', ts: T(5), id: 'u6', summary: 'row 1\nrow 2' },
  { type: 'text', delta: 'The deck is in place.', by: 'terminal' },
  { type: 'done', ts: T(6), result: 'The deck is in place.' },
  { type: 'user', ts: T(10), text: 'Look at the March spike.', by: 'main', run: 1 },
  { type: 'tool_use', ts: T(11), id: 'u7', name: 'mcp__plugin_thimble_thimble__edit_card', input: { card: 'card:aaaa1111', width: 600 }, n: 7 },
  { type: 'tool_result', ts: T(11), id: 'u7', summary: 'card:aaaa1111\nok' },
  { type: 'tool_use', ts: T(12), id: 'u8', name: 'mcp__plugin_thimble_thimble__add_card', input: { question: 'Refunds in March' }, n: 8 },
  { type: 'tool_result', ts: T(12), id: 'u8', summary: 'card:bbbb2222\nok', cell_id: 'bbbb2222' },
  { type: 'text', delta: 'March holds half the refunds.', by: 'terminal' },
  { type: 'done', ts: T(13), result: 'March holds half the refunds.' },
]
const S1 = [
  { type: 'user', ts: T(3), text: 'Read the tickets.' },
  { type: 'tool_use', ts: T(3), id: 'u4', name: 'Read', input: { file_path: '/data/mini/tickets/a.jsonl' } },
  { type: 'tool_result', ts: T(4), id: 'u4', summary: '{"id": 1}' },
]
const MAIN = [
  { type: 'agent', ts: T(0), chat: 'or1', role: 'orient', title: 'Orientation' },
  { type: 'user', ts: T(8), text: 'How many refunds?', by: 'browser' },
  { type: 'text', delta: 'There are [[7|call:or1/1#L2]] in b.jsonl, from the search [[call:or1/1]]; the step read [[call:or1/4]].', by: 'terminal' },
  { type: 'agent', ts: T(10), chat: 'or1', role: 'orient', title: 'Orientation', run: 1 },
]
const CALLS: Record<string, any> = {
  1: { ref: 'call:or1/1', n: 1, id: 'u1', chat: 'or1', name: 'Bash', input: OR1[1].input, result: 'a.jsonl:3\nb.jsonl:7\nc.jsonl:0\n', is_error: false },
  4: { ref: 'call:or1/4', n: 4, id: 'u4', chat: 's1', name: 'Read', input: S1[1].input, result: '{"id": 1}', is_error: false },
  6: { ref: 'call:or1/6', n: 6, id: 'u6', chat: 'or1', name: 'Read', input: OR1[8].input, result: LONG, is_error: false },
}
// what the routes answer, changed by the tests
const state: any = { or1: meta('or1', { followups: [{ run: 1, status: 'done', started: T(10), ended: T(13), added: 1, revised: 1, deleted: 0, views: 0 }] }), undoRun: 'or1/1', w1: null, cr1: null }
// a writer's session (w1, role writer) and the orientation's critique (cr1, a step of or1 that is a session of its own),
// listed only while a test sets them; the writer's log is its brief, then enough calls that its thread opens scrolled
// well below the card at its top
const W1 = [
  { type: 'user', ts: T(15), text: 'Write the report.', by: 'terminal' },
  ...Array.from({ length: 40 }, (_: any, i: any) => [
    { type: 'tool_use', ts: T(15), id: `w${i}`, name: 'Read', input: { file_path: `/data/mini/tickets/t${i}.jsonl` } },
    { type: 'tool_result', ts: T(15), id: `w${i}`, summary: 'ok' },
  ]).flat(),
]
const writerMeta = (extra: object = {}): any => ({ ...meta('w1'), role: 'writer', title: 'Write report', doc: 'report', created_at: T(15), status: 'running', ts_end: null, brief: 'Write `report:report`.', ...extra })
const critiqueMeta = (extra: object = {}): any => ({ ...meta('cr1'), role: 'step', title: 'critique', parent: 'or1', created_at: T(16), status: 'running', ts_end: null, session: 'c-sid', ...extra })
const listed = () => [MAIN_META, state.or1, { ...meta('s1'), role: 'step', title: 'Read the tickets', parent: 'or1' }, ...(state.w1 ? [state.w1] : []), ...(state.cr1 ? [state.cr1] : []), ...(state.vb ? [state.vb] : []), ...(state.ticket ? [devMeta('d1'), ...(state.ticket.chat === 'd2' ? [devMeta('d2')] : [])] : [])]
// a dev ticket (listed only while a test sets state.ticket): its agent chat d1, and d2, the chat a Retry opens
const devMeta = (id: string): any => ({ ...meta(id), role: 'dev', title: 'ticket #1: Wider cards', ticket: 'ab12cd34', created_at: T(17), status: id === 'd1' ? 'failed' : 'running', ts_end: id === 'd1' ? T(18) : null })
// the roles' models as GET /settings resolves them
const SETTINGS = { models: { orient: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false }, dev: { model: 'claude-opus-5-5', effort: 'high', fast: false } } }
// a view build's chat (listed only while a test sets state.vb): a dev chat with the view's slug on its meta
const viewBuildMeta = (): any => ({ ...meta('vb1'), role: 'dev', title: 'view: Page timeline', view: 'page-timeline', created_at: T(19), status: 'done', ts_end: T(20) })
const D1 = [{ type: 'text', ts: T(17), delta: '\n· worktree ready on dev/ab12cd34\n' }, { type: 'error', ts: T(18), message: 'gates failed after 3 attempts', kind: 'failed' }]

beforeAll(async () => {
  script = await bundle('orientation-thread', [
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ChatPanel } from '${src('chat/ChatPanel.tsx')}'`,
      `import { StartGate } from '${src('chat/StartGate.tsx')}'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `window.__bus = bus`,
      `let roots = []`,
      `const host = (w, h) => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;left:0;top:0;width:' + w + 'px;height:' + h + 'px;display:flex;flex-direction:column'; document.body.appendChild(el); const root = createRoot(el); roots.push([root, el]); return root }`,
      // each mount is a fresh page on main: the thread a page keeps showing across reloads is forgotten
      `window.__mountChat = () => { localStorage.removeItem('thimble:mini:thread-current'); const r = host(380, 900); flushSync(() => r.render(<ChatPanel ws="mini" />)) }`,
      `window.__mountStart = (mode) => { const r = host(380, 600); flushSync(() => r.render(<StartGate ws="mini" model="claude-opus-5-5" permissionMode={mode} />)) }`,
      `window.__mountCanvas = () => { localStorage.setItem('thimble:old:canvas-view', JSON.stringify({ x: 0, y: 40, scale: 0.8 })); const r = host(1000, 900); flushSync(() => r.render(<Canvas ws="old" active />)) }`,
      `window.__unmount = () => { for (const [r, el] of roots) { r.unmount(); el.remove() } roots = [] }`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    const json = (body: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (req.method() === 'PUT' && p === '/api/ws/mini/settings') {
      posted.push([p, JSON.parse(req.postData() || '{}')])
      return json(SETTINGS)
    }
    if (req.method() === 'POST' && p.startsWith('/api/')) {
      posted.push([p, JSON.parse(req.postData() || '{}')])
      if (p === '/api/ws/mini/orientation/message') return json({ status: 'queued', chat: 'or1', queued: 1 })
      if (p === '/api/ws/mini/undo') return json({ undo: null, redo: "the orientation's follow-up", applied: 'x' })
      if (p.endsWith('/interrupt')) return json({ stopped: true })
      if (p === '/api/dev/tickets/ab12cd34/retry' && state.ticket) {
        state.ticket = { ...state.ticket, status: 'queued', error: null, chat: 'd2' }
        return json(state.ticket, 202)
      }
      return json({ ok: true })
    }
    if (p === '/api/ws/mini/settings') return json(SETTINGS)
    if (p === '/api/ws/mini/chats/vb1' && state.vb) return json({ meta: state.vb, events: [{ type: 'text', ts: T(19), delta: '\n· the session writes the view\n' }] })
    if (p === '/api/dev/tickets/ab12cd34' && state.ticket) return json(state.ticket)
    if (/^\/api\/ws\/mini\/chats\/d[12]$/.test(p) && state.ticket) return json({ meta: devMeta(p.slice(-2)), events: p.endsWith('d1') ? D1 : [] })
    if (p === '/api/ws/mini/chats') return json(listed())
    if (p === '/api/ws/mini/chats/main') return json({ meta: MAIN_META, events: state.w1 ? [...MAIN, { type: 'agent', ts: T(15), chat: 'w1', role: 'writer', title: 'Write report' }] : MAIN })
    if (p === '/api/ws/mini/chats/w1' && state.w1) return json({ meta: state.w1, events: W1 })
    if (p === '/api/ws/mini/chats/cr1' && state.cr1) return json({ meta: state.cr1, events: [{ type: 'user', ts: T(16), text: 'Review the orientation.' }] })
    if (p === '/api/ws/mini/chats/or1') return json({ meta: state.or1, events: state.cr1 ? [...OR1, { type: 'agent', ts: T(16), chat: 'cr1', role: 'step', title: 'critique' }] : OR1 })
    if (p === '/api/ws/mini/chats/s1') return json({ meta: { ...meta('s1'), role: 'step', title: 'Read the tickets', parent: 'or1' }, events: S1 })
    let m = /^\/api\/ws\/mini\/calls\/or1\/(\d+)$/.exec(p)
    if (m) return CALLS[m[1]] ? json(CALLS[m[1]]) : json({ detail: 'no call' }, 404)
    if (p === '/api/ws/mini/calls/or1') return json([{ n: 4, id: 'u4', chat: 's1', name: 'Read', line: 'Read tickets/a.jsonl', done: true, is_error: false }])
    if (p === '/api/ws/mini/undo') return json({ undo: "the orientation's follow-up", redo: null, undo_run: state.undoRun })
    if (p === '/api/ws/mini/cells/names') return json([{ id: 'aaaa1111', notebook: 'deck', title: 'Refunds per file' }])
    if (p === '/api/ws/old/canvas') return json(OLD)
    if (/\/api\/ws\/\w+\/(filters)$/.test(p)) return json({})
    if (/\/api\/ws\/\w+\/concepts$/.test(p)) return json([])
    if (p.startsWith('/api/')) return json({ detail: 'no' }, 404)
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=mini')
  await addStyles(page, ['tokens', 'base', 'components', 'outputs', 'chat', 'refchip', 'canvas'])
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const openChat = async (id: any) => {
  await page.evaluate((c: any) => (window as any).__bus.emit('openChat', { chatId: c }), id)
  await page.waitForTimeout(400)
}
const remount = async () => {
  await page.evaluate(() => (window as any).__unmount())
  await page.evaluate(() => (window as any).__mountChat())
  await page.waitForTimeout(500)
}
const call = (ref: any) => page.locator(`.chat-call[data-anchor="${ref}"]`)

test('the orientation\'s thread: every call a chip line of its own with its ref, its step where it started, a follow-up\'s message', async () => {
  await remount()
  await openChat('or1')
  await page.locator('.chat-callrun').first().waitFor({ timeout: 5000 })
  // calls in a row fold into one chip, whatever their tools, which names each tool and its count
  const runs = page.locator('.chat-flow .chat-callrun')
  assert.deepEqual(
    await runs.evaluateAll((els: any) => els.map((e: any) => [...e.querySelectorAll('.chat-callrun-tool')].map((t: any) => `${t.querySelector('.chat-callrun-name').textContent} ${t.querySelector('.chat-callrun-n').textContent}`).join(' · '))),
    ['Bash 1 · add_card 1 · Agent 1', 'edit_card 1 · add_card 1'],
    "the search, the card and the Agent call; the follow-up's two card calls",
  )
  assert.equal(await runs.locator('.chat-callrun-head .refchip, .chat-callrun-head .chip:not(.chat-callrun-chip):not(.chat-callrun-failed)').count(), 0, 'what a run made shows on its lines, not beside the fold')
  assert.deepEqual(await page.locator('.chat-flow .chat-call').evaluateAll((els: any) => els.map((e: any) => e.dataset.tool)), ['Read'], 'a call alone stays a line')
  for (const chip of await runs.locator('.chat-callrun-chip').all()) await chip.click()
  // the orientation's scratch work is its thread: every tool call is a chip line to open or cite
  assert.deepEqual(
    await page.locator('.chat-flow .chat-call').evaluateAll((els: any) => els.map((e: any) => [e.dataset.tool, e.dataset.anchor])),
    [['Bash', 'call:or1/1'], ['add_card', 'call:or1/2'], ['Agent', 'call:or1/5'], ['Read', 'call:or1/6'], ['edit_card', 'call:or1/7'], ['add_card', 'call:or1/8']],
    'one line per call, thimble\'s own calls and the Agent call among them, each anchored at its ref',
  )
  assert.equal(await call('call:or1/1').locator('.chat-call-chip').innerText(), 'Bash grep -c refund tickets/*.jsonl', 'the chip line, the corpus folder left off')
  assert.equal(await call('call:or1/1').getAttribute('data-anchor-text'), 'Bash grep -c refund tickets/*.jsonl')
  assert.equal(await call('call:or1/2').locator('.refchip[data-ref="card:aaaa1111"]').count(), 1, 'a thimble call\'s card follows its chip line')
  assert.equal(await call('call:or1/7').locator('.chat-call-target').count(), 0, 'a call whose target is a card names no id')
  assert.equal(await call('call:or1/7').locator('.refchip[data-ref="card:aaaa1111"]').count(), 1, 'the card follows as its chip')
  assert.equal(await page.locator('.chat-flow .chat-task[data-chat="s1"]').count(), 1, 'the step it started is its card, where it was started')
  assert.equal(await page.locator('.chat-flow > .chat-user').count(), 1, 'the brief is the card\'s lead, not a tile')
  const follow = page.locator('.chat-flow > .chat-user')
  assert.equal(await follow.locator('.chat-message').innerText(), 'Look at the March spike.')
  assert.equal(await follow.locator('.chat-origin .chat-thread-chip').innerText(), 'main', 'main\'s message says it came from main')
  assert.equal(await page.locator('.chat-call-chip[draggable="true"]').count(), 6, 'a call drags as its citation')
})

test('a call opens on its whole output from the store, each line numbered and anchored, a long one behind Show all', async () => {
  await call('call:or1/1').locator('.chat-call-chip').click()
  await call('call:or1/1').locator('.chat-call-line').first().waitFor({ timeout: 5000 })
  assert.deepEqual(await call('call:or1/1').locator('.chat-call-line').evaluateAll((els: any) => els.map((e: any) => [e.dataset.anchor, e.querySelector('.chat-call-ln').textContent, e.querySelector('.chat-call-lt').textContent])), [
    ['call:or1/1#L1', '1', 'a.jsonl:3'],
    ['call:or1/1#L2', '2', 'b.jsonl:7'],
    ['call:or1/1#L3', '3', 'c.jsonl:0'],
  ], 'the lines as the ref numbers them, a newline that ends the output opening none')
  assert.match(await call('call:or1/1').locator('.chat-tool-fields').innerText(), /Count refunds/, 'its other input first')
  await call('call:or1/6').locator('.chat-call-chip').click()
  await call('call:or1/6').locator('.chat-call-more').waitFor({ timeout: 5000 })
  assert.equal(await call('call:or1/6').locator('.chat-call-line').count(), 400)
  assert.equal(await call('call:or1/6').locator('.chat-call-more').innerText(), 'Show all 450 lines')
  await call('call:or1/6').locator('.chat-call-more').click()
  assert.equal(await call('call:or1/6').locator('.chat-call-line').count(), 450)
  // a call the store does not have shows what the log kept
  await call('call:or1/2').locator('.chat-call-chip').click()
  await call('call:or1/2').locator('.chat-call-body').waitFor({ timeout: 5000 })
  await page.waitForTimeout(300)
  assert.equal(await call('call:or1/2').locator('.chat-call-line').count(), 0)
  assert.equal(await call('call:or1/2').locator('.chat-call-loading').count(), 0, 'no spinner once the store answered it has none')
})

test('a call citation reads like its chip line, previews its cited lines with the value marked, and opens the call', async () => {
  await remount()
  const text = page.locator('.chat-flow .chat-assistant .chat-text').first()
  await text.waitFor({ timeout: 5000 })
  const chip = text.locator('.refchip[data-ref="call:or1/1"]')
  await page.waitForFunction(() => document.querySelector('.refchip[data-ref="call:or1/1"]')?.getAttribute('aria-label')?.includes('Bash'), null, { timeout: 5000 })
  assert.equal(await chip.getAttribute('aria-label'), 'Bash grep -c refund tickets/*.jsonl', 'a citation in a reply is the call\'s glyph, named like its line in the thread')
  assert.equal(await chip.locator('svg.icon-terminal').count(), 1)
  const value = text.locator('.refchip-value[data-ref="call:or1/1#L2"]')
  await value.hover()
  const pop = page.locator('.refchip-pop')
  await pop.locator('.refchip-lines').waitFor({ timeout: 5000 })
  assert.deepEqual(await pop.locator('.refchip-line').allInnerTexts(), ['a.jsonl:3', 'b.jsonl:7', 'c.jsonl:0'], 'the cited line with the lines around it')
  assert.equal(await pop.locator('.refchip-line .hl').innerText(), '7', 'the cited value highlighted in its line (the one span highlight)')
  await page.mouse.move(1300, 850)
  await page.waitForTimeout(300)
  await value.click()
  await call('call:or1/1').locator('.chat-call-line.cite-cell').waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.chat[data-thread-kind="orient"]').count(), 1, 'the orientation\'s thread opens')
  assert.deepEqual(await call('call:or1/1').locator('.chat-call-line.cite-cell').evaluateAll((els: any) => els.map((e: any) => e.dataset.line)), ['2'], 'the call open, the cited line marked')
  // a step's call opens that step's thread, which the store names
  await openChat('main')
  await page.mouse.move(1300, 850)
  await page.waitForTimeout(400)
  await page.locator('.refchip[data-ref="call:or1/4"]').first().click()
  await call('call:or1/4').locator('.chat-call-line').first().waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.chat[data-thread-kind="step"]').count(), 1)
  assert.equal(await call('call:or1/4').locator('.chat-call-chip').innerText(), 'Read tickets/a.jsonl', 'numbered from the index where its record has no number')
})

test('the latest orientation\'s thread sends what the analyst types to the orientation, and shows what waits in its queue', async () => {
  await remount()
  await openChat('or1')
  const box = page.locator('.chat-foot textarea')
  assert.equal(await box.getAttribute('placeholder'), 'Reply in orient…')
  posted.length = 0
  await box.fill('And the weekends?')
  await box.press('Enter')
  await page.waitForTimeout(400)
  assert.deepEqual(posted.filter(([p]: any) => !p.endsWith('/telemetry')), [['/api/ws/mini/orientation/message', { text: 'And the weekends?' }]], 'the one server function main\'s tool calls too')
  assert.equal(await page.locator('.chat[data-thread-kind="orient"]').count(), 1, 'the thread stays open')
  assert.deepEqual(await page.locator('.chat-pending .chat-message').allInnerTexts(), ['And the weekends?'], 'shown until the log or the queue holds it')
  // queued while a run goes on (the chat's meta), with a line that says it waits
  state.or1 = { ...state.or1, status: 'running', queued: [{ text: 'And the weekends?', by: 'browser', ts: T(14) }] }
  await remount()
  await openChat('or1')
  await page.locator('.chat-pending[data-queued]').waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.chat-pending').count(), 1, 'once, as the queue holds it')
  assert.equal(await page.locator('.chat-pending-note').innerText(), 'Waits for the current run to end')
  state.or1 = { ...state.or1, status: 'done', queued: [] }
})

test("every thread's composer names where it sends and has a model menu: the orientation's role in its thread, a view build's goes to that build", async () => {
  await remount()
  await openChat('or1')
  const line = page.locator('.chat-foot .role-line[data-role="orient"]')
  await line.waitFor({ timeout: 5000 })
  assert.deepEqual((await line.locator('.model-line-part').allInnerTexts()).map((t: string) => t.trim()), ['Opus 5.5', 'xhigh'], "the orientation's model and effort, from the settings, each a menu")
  assert.equal(await line.locator('.fast-bolt').count(), 1, 'fast mode is the bolt beside the effort')
  await line.locator('.model-line-part').first().click()
  const sonnet = page.locator('[role="menu"] [data-item="model:claude-sonnet-5"]')
  await sonnet.waitFor({ timeout: 5000 })
  posted.length = 0
  await sonnet.click()
  await poll(() => posted.some(([p, b]: any) => p === '/api/ws/mini/settings' && b.models?.orient?.model === 'claude-sonnet-5'))
  // a view build's thread: the composer names the build, and what is typed goes to it as a change, not to main
  state.vb = viewBuildMeta()
  await remount()
  await openChat('vb1')
  const box = page.locator('.chat-foot textarea')
  await page.waitForFunction(() => document.querySelector('.chat-foot textarea')?.getAttribute('placeholder') === 'Reply in dev/view-page-timeline…', null, { timeout: 5000 })
  assert.equal(await page.locator('.chat-foot .role-line[data-role="dev"]').count(), 1, "the dev agent's model line")
  posted.length = 0
  await box.fill('Put the newest pages first')
  await box.press('Enter')
  await poll(() => posted.some(([p, b]: any) => p === '/api/ws/mini/views/proposals/page-timeline/message' && b.text === 'Put the newest pages first'))
  assert.equal(posted.some(([p]: any) => p === '/api/ws/mini/events'), false, 'nothing goes to main')
  assert.equal(await page.locator('.chat[data-thread-kind="dev"]').count(), 1, 'the thread stays open')
  state.vb = null
})

/** Resolves once `check()` holds, polled for up to 5 s. */
const poll = async (check: any) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((r: any) => setTimeout(r, 50))
  }
  throw new Error('timed out')
}

test('a permission prompt of the orientation waits on one bold card right above the composer, in main and in its thread, and says who asks and why', async () => {
  const command = 'curl https://example.com/' + 'a-long-path/'.repeat(12)
  state.or1 = { ...state.or1, status: 'running', permission_mode: 'manual', permissions: [{ id: 'p1', tool: 'Bash', what: 'Fetch the page', command, input: JSON.stringify({ command }), since: T(19), agent_id: 'a1', agent_type: 'workflow-subagent', agent_title: 'Audit: audit:batch2-alpha-issues-and-merges', agent_chat: 's1' }] }
  await remount()
  const card = page.locator('.chat-foot .chat-perm')
  await card.waitFor({ timeout: 5000 })
  assert.equal(await card.locator('.chat-perm-title').innerText(), 'Permission needed')
  assert.match(await card.locator('.chat-perm-who').innerText(), /^The orientation's agent\s*Audit: audit:batch2-alpha-issues-and-merges\s*\(workflow-subagent\)\s*asks to run a command$/)
  assert.equal(await card.locator('.chat-perm-what').innerText(), 'Fetch the page')
  assert.equal(await card.locator('.chat-perm-why').innerText(), 'It runs in Manual, which asks before each call.')
  assert.match(await card.locator('.chat-perm-from').innerText(), /^from\s+orient$/, 'it names the thread the request comes from')
  // pinned above the composer and the strip, clear of them so its edge never meets the composer's corners, and inside
  // the chat's column however long its command and its agent's name
  const box = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    return { card: r('.chat-perm'), strip: r('.chat-foot .chat-strip'), composer: r('.chat-foot .chat-composer'), chat: r('.chat') }
  })
  assert.ok(box.card.bottom <= box.strip.top && box.card.bottom >= box.strip.top - 10, `the card stands just above the strip (${box.card.bottom} vs ${box.strip.top})`)
  assert.ok(box.strip.bottom > box.composer.top, 'the strip still rides behind the composer')
  assert.ok(box.card.left >= box.chat.left && box.card.right <= box.chat.right, `the card stays inside the chat (${box.card.left}–${box.card.right} in ${box.chat.left}–${box.chat.right})`)
  const overflow = await card.evaluate((el: any) => [...el.querySelectorAll('*')].filter((c: any) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5).map((c: any) => c.className))
  assert.deepEqual(overflow, [], 'nothing in it spills past its edge')
  // nothing says "waiting for you" anywhere in the chat: the card is the one place
  assert.doesNotMatch(await page.locator('.chat').innerText(), /waiting for you/)
  assert.equal(await page.locator('.chat-strip .spinner').count(), 0, 'a still dot where the strip\'s spinner turned')
  // the same card in the orientation's thread, with nothing about the prompt on the orientation's card in the stream
  await openChat('or1')
  await card.waitFor({ timeout: 5000 })
  assert.match(await card.locator('.chat-perm-from').innerText(), /^from\s+orient$/)
  assert.equal(await page.locator('.chat-flow .chat-task[data-role="orient"] .chat-perm, .chat-flow .chat-hold[data-kind="permission"]').count(), 0)
  posted.length = 0
  await card.locator('.chat-perm-allow').click()
  await poll(() => posted.some(([p, b]: any) => p === '/api/ws/mini/chats/or1/permission' && b.id === 'p1' && b.allow === true))
  state.or1 = { ...state.or1, status: 'done', permissions: [] }
  await remount()
  assert.equal(await page.locator('.chat-perm').count(), 0)
  assert.equal(await page.locator('.chat-strip').count(), 0)
})

test('while the orientation waits to retry after the API was at capacity, the Orienting strip and its card say so, with Retry now', async () => {
  // backend agent_session's retry, so an API at capacity does not end the orientation
  const until = new Date(Date.now() + 90_000).toISOString()
  state.or1 = { ...state.or1, status: 'running', pid: null, alert: { kind: 'retry', text: "Anthropic's API is overloaded; retrying in 90 s.", reason: "Anthropic's API is overloaded", until, attempt: 1 } }
  await remount()
  const strip = page.locator('.chat-strip[data-retry]')
  await strip.waitFor({ timeout: 5000 })
  assert.equal(await strip.locator('.chat-strip-title').innerText(), 'Orienting')
  assert.match(await strip.locator('.chat-strip-retry-text').innerText(), /^Anthropic's API is overloaded; retrying in (89|90) s\.$/)
  assert.equal(await strip.locator('.spinner').count(), 0, 'a still dot where the spinner turned')
  const before = posted.length
  await strip.locator('.chat-strip-retry').click()
  await poll(() => posted.length > before)
  assert.deepEqual(posted.at(-1)[0], '/api/ws/mini/chats/or1/retry')
  // the orientation's card carries the same status and its own Retry now
  await page.locator('.chat-agent-note[data-chat="or1"] .chat-thread-chip').first().click()
  const hold = page.locator('.chat-flow > .chat-task[data-role="orient"] .chat-apierr[data-waits]').first()
  await hold.waitFor({ timeout: 5000 })
  assert.equal(await hold.locator('.chat-apierr-what').innerText(), "Anthropic's API is overloaded")
  assert.match(await hold.locator('.chat-apierr-retrying').innerText(), /^thimble retries in \d+ s, keeping the work so far\.$/)
  await hold.locator('.chat-apierr-retry').click()
  await poll(() => posted.at(-1)[0] === '/api/ws/mini/chats/or1/retry' && posted.length > before + 1)
  state.or1 = { ...state.or1, status: 'done', pid: 1, alert: null }
  await remount()
  assert.equal(await page.locator('.chat-strip').count(), 0)
})

test('the running orientation\'s card shows its permission mode, switches it, warns while it runs in Bypass and says when a switch waits for a pause', async () => {
  // the mode can be changed from the orientation's thread while it runs (backend agent_session.set_mode)
  state.or1 = { ...state.or1, status: 'running', permission_mode: 'manual', mode_switch: null }
  await remount()
  await openChat('or1')
  const perms = page.locator('.chat-flow > .chat-task[data-role="orient"] .chat-perms').first()
  await perms.waitFor({ timeout: 5000 })
  assert.deepEqual(await perms.locator('.seg-opt').allInnerTexts(), ['Manual', 'Auto', 'Bypass'])
  assert.equal(await perms.locator('.seg-opt.active').innerText(), 'Manual')
  assert.equal(await perms.locator('.chat-perms-warn').count(), 0)
  const before = posted.length
  await perms.locator('.seg-opt', { hasText: 'Bypass' }).click()
  await poll(() => posted.length > before)
  assert.deepEqual(posted.at(-1), ['/api/ws/mini/chats/or1/permission-mode', { mode: 'bypass' }])
  assert.equal(await perms.locator('.seg-opt.active').innerText(), 'Bypass', 'the pick shows at once')
  state.or1 = { ...state.or1, permission_mode: 'bypass' }
  await remount()
  await openChat('or1')
  await perms.waitFor({ timeout: 5000 })
  assert.match(await perms.locator('.chat-perms-warn').innerText(), /^In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands\.$/)
  state.or1 = { ...state.or1, permission_mode: 'manual', mode_switch: 'auto' }
  await remount()
  await openChat('or1')
  await perms.waitFor({ timeout: 5000 })
  assert.equal(await perms.locator('.seg-opt.active').innerText(), 'Auto', 'the mode it goes to')
  assert.equal(await perms.locator('.chat-perms-note').innerText(), 'Switching to Auto at the next pause, keeping the work so far.')
  state.or1 = { ...state.or1, status: 'done', permission_mode: 'auto', mode_switch: null }
  await remount()
  await openChat('or1')
  assert.equal(await page.locator('.chat-perms').count(), 0, 'only while it runs')
})

test('Stop pressed on a writer\'s card right after picking its thread from the open tree reaches the server', async () => {
  // the tree must not fold at the press and move the thread out from under the pointer
  state.w1 = writerMeta()
  await remount()
  await page.locator('.tt-summary').click()
  await page.locator('.tt-row:not(.tt-summary)', { hasText: 'write-report' }).click()
  const stop = page.locator('.chat-flow > .chat-task[data-chat="w1"] .chat-task-stop')
  await stop.waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.tt-list').count(), 1, 'the tree is still open over the thread')
  posted.length = 0
  await stop.click()
  await poll(() => posted.some(([p]: any) => p === '/api/ws/mini/chats/w1/interrupt'))
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.tt-list').count(), 0, 'and the press folded it once its click had landed')
  state.w1 = null
})

test('a failed dev ticket\'s thread says why and offers Retry and Discard; Retry follows the ticket into its new chat', async () => {
  state.ticket = { id: 'ab12cd34', n: 1, workspace: 'mini', title: 'Wider cards', body: 'make the cards wider', source: 'analyst', status: 'failed', error: 'gates failed after 3 attempts', chat: 'd1' }
  await remount()
  await openChat('d1')
  const line = page.locator('.chat-ticket-status[data-status="failed"]')
  await line.waitFor({ timeout: 5000 })
  assert.equal((await line.locator('.chat-ticket-why').textContent()).trim(), 'Gates failed after 3 attempts')
  assert.deepEqual(await line.locator('.chat-ticket-act').allTextContents(), ['Retry', 'Discard'])
  posted.length = 0
  await line.locator('.chat-ticket-act', { hasText: 'Retry' }).click()
  await poll(() => posted.some(([p]: any) => p === '/api/dev/tickets/ab12cd34/retry'))
  // the retried ticket runs in d2, where the queued line offers Discard
  const queued = page.locator('.chat-ticket-status[data-status="queued"]')
  await queued.waitFor({ timeout: 5000 })
  assert.equal((await queued.locator('.chat-note-text').textContent()).trim(), 'Queued behind another ticket')
  // a ticket event of the stream fetches the ticket again: it runs, and the line offers Stop
  state.ticket = { ...state.ticket, status: 'running' }
  await page.evaluate(() => (window as any).__bus.emit('ticket', { id: 'ab12cd34', n: 1, status: 'running' }))
  const running = page.locator('.chat-ticket-status[data-status="running"]')
  await running.waitFor({ timeout: 5000 })
  posted.length = 0
  await running.locator('.chat-ticket-act', { hasText: 'Stop' }).click()
  await poll(() => posted.some(([p]: any) => p === '/api/dev/tickets/ab12cd34/stop'))
  assert.deepEqual(pageErrors, [])
  state.ticket = null
})

test("a writer's permission prompt and a critique's wait on the same card, paged, each saying who asks and the thread it comes from", async () => {
  // a critique's chat is a step of the orientation, so its prompt has no thread of its own to show in
  state.or1 = { ...state.or1, status: 'running' }
  state.w1 = writerMeta({ permissions: [{ id: 'pw', tool: 'Glob', what: '/home/analyst/notes', input: '{"pattern": "*.md"}', since: T(17) }] })
  state.cr1 = critiqueMeta({ permissions: [{ id: 'pc', tool: 'Glob', what: '/work/report_*.md', input: '{"pattern": "report_*.md"}', since: T(18) }] })
  await remount()
  const card = page.locator('.chat-foot .chat-perm')
  await card.waitFor({ timeout: 5000 })
  assert.equal(await card.locator('.chat-perm-count').innerText(), '1 of 2', 'both requests on one card, the one asked first first')
  assert.match(await card.locator('.chat-perm-who').innerText(), /^The report writer\s*asks to search for files$/)
  assert.match(await card.locator('.chat-perm-why').innerText(), /denied after a minute/)
  await card.locator('[aria-label="Next request"]').click()
  assert.match(await card.locator('.chat-perm-who').innerText(), /^The orientation's critique\s*asks to search for files$/)
  assert.equal(await card.getAttribute('data-request'), 'pc')
  assert.equal(await card.locator('.chat-perm-from .chat-thread-chip').getAttribute('data-thread'), 'cr1', "the critique's own thread")
  posted.length = 0
  await card.locator('.chat-perm-deny').click()
  await poll(() => posted.some(([p, b]: any) => p === '/api/ws/mini/chats/cr1/permission' && b.id === 'pc' && b.allow === false))
  await page.waitForFunction(() => document.querySelector('.chat-perm')?.getAttribute('data-request') === 'pw', null, { timeout: 5000 })
  assert.equal(await card.locator('.chat-perm-count').count(), 0, "the writer's request takes the card's place, alone")
  await card.locator('.chat-perm-allow').click()
  await poll(() => posted.some(([p, b]: any) => p === '/api/ws/mini/chats/w1/permission' && b.id === 'pw' && b.allow === true))
  state.or1 = { ...state.or1, status: 'done' }
  state.w1 = null
  state.cr1 = null
  await remount()
  assert.equal(await page.locator('.chat-perm').count(), 0, 'gone once nothing waits')
})

test('a follow-up in main is the orientation\'s card for that run: the message as its lead, what it changed, and Undo', async () => {
  await remount()
  const card = page.locator('.chat-task[data-run="1"]')
  await card.waitFor({ timeout: 5000 })
  // the counts, as in "revised 2 cards, added 1", are the server's, from the run's undo steps
  await card.locator('.toolcard-meta:has-text("revised")').waitFor({ timeout: 5000 })
  assert.equal(await card.locator('.toolcard-meta').innerText(), 'revised 1 card, added 1')
  assert.equal(await card.getAttribute('data-status'), 'done')
  await card.locator('.toolcard-head').click()
  assert.equal(await card.locator('.toolcard-lead').innerText(), 'Look at the March spike.')
  await card.locator('.chat-task-undo').waitFor({ timeout: 5000 })
  posted.length = 0
  await card.locator('.chat-task-undo').click()
  await page.waitForTimeout(300)
  assert.deepEqual(posted.map(([p]: any) => p).filter((p: any) => !p.endsWith('/telemetry')), ['/api/ws/mini/undo'], 'one undo reverts the whole follow-up')
  // the first run's card is the note in main, its landing its own run alone
  assert.equal(await page.locator('.chat-agent-note[data-chat="or1"]').count(), 1)
  state.undoRun = 'or1/2'
  await remount()
  await page.locator('.chat-task[data-run="1"] .toolcard-meta:has-text("revised")').waitFor({ timeout: 5000 })
  await page.waitForTimeout(300)
  assert.equal(await page.locator('.chat-task[data-run="1"] .chat-task-undo').count(), 0, 'no Undo once the step an undo would revert is someone else\'s')
})

test('the Start panel\'s mode switcher opens on the analyst\'s own mode, always sends the mode it shows, and warns for Bypass', async () => {
  await page.evaluate(() => (window as any).__unmount())
  await page.evaluate(() => (window as any).__mountStart('auto'))
  await page.locator('.chat-gate-options-toggle').click()
  const perms = page.locator('.chat-gate-perms')
  assert.deepEqual(await perms.locator('.seg-opt').allInnerTexts(), ['Manual', 'Auto', 'Bypass'])
  assert.deepEqual(await perms.locator('.seg-opt svg').evaluateAll((els: any) => els.map((e: any) => e.getAttribute('class').split(' ')[1])), ['icon-pause', 'icon-run', 'icon-exclaim'])
  assert.equal(await perms.locator('.seg-opt.active').innerText(), 'Auto', 'the analyst\'s auto mode')
  assert.equal(await page.locator('.chat-gate-warn').count(), 0)
  posted.length = 0
  await page.locator('.chat-gate-go').click()
  await page.waitForTimeout(300)
  assert.equal(posted.find(([p]: any) => p === '/api/ws/mini/events')[1].payload.permissions, 'auto', 'untouched, the mode shown is sent')
  await perms.locator('.seg-opt', { hasText: 'Bypass' }).click()
  assert.match(await page.locator('.chat-gate-warn').innerText(), /will not ask for your approval before running potentially dangerous commands/)
  posted.length = 0
  await page.locator('.chat-gate-go').click()
  await page.waitForTimeout(300)
  assert.equal(posted.find(([p]: any) => p === '/api/ws/mini/events')[1].payload.permissions, 'bypass')
  await perms.locator('.seg-opt', { hasText: 'Manual' }).click()
  assert.equal(await page.locator('.chat-gate-warn').count(), 0, 'the warning goes with Bypass')
  await page.evaluate(() => (window as any).__unmount())
  await page.evaluate(() => (window as any).__mountStart(null))
  await page.locator('.chat-gate-options-toggle').click()
  assert.equal(await page.locator('.chat-gate-perms .seg-opt.active').innerText(), 'Manual', 'with no mode known, Manual')
  await page.evaluate(() => (window as any).__unmount())
  await page.evaluate(() => (window as any).__mountStart('bypassPermissions'))
  assert.equal(await page.locator('.chat-gate-warn').count(), 1, 'an analyst whose own mode is bypass sees the warning with the options still collapsed')
  await page.locator('.chat-gate-options-toggle').click()
  assert.equal(await page.locator('.chat-gate-perms .seg-opt.active').innerText(), 'Bypass')
  assert.equal(await page.locator('.chat-gate-warn').count(), 1, 'an analyst whose own mode is bypass sees the warning too')
})

// an older workspace as the canvas route serves it (backend notebook.canvas): its orientation Scratch and the group
// inside it are left out, while their cards' refs still resolve for a citation
const g = (id: any, extra = {}) => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', n_cells: 0, pos: null, order: null, ...extra })
const c = (id: any, notebook: any) => ({ id, notebook, kind: 'note', title: `Question ${id}`, created_by: 'user', ts: T(0), payload: { text: `Text of ${id}` }, text: `Text of ${id}`, takeaway: '' })
const OLD = {
  groups: [g('deck', { title: 'Orientation', role: 'exploration' }), g('mine', { title: 'Your work' })],
  cells: [c('d1', 'deck'), c('d2', 'deck'), c('y1', 'mine')],
  hidden: ['s1', 's2', 't1'],
}

test('the canvas: no scratch work on it; a citation of a scratch card opens the deck, and of a card gone says it is not on the canvas', async () => {
  await page.evaluate(() => (window as any).__unmount())
  await page.evaluate(() => (window as any).__mountCanvas())
  await page.waitForSelector('.frame')
  await page.waitForTimeout(300)
  const frames = await page.evaluate(() => [...document.querySelectorAll('.frame')].map((f: any) => [f.dataset.group, f.querySelector('.frame-count')?.textContent]))
  assert.deepEqual(Object.fromEntries(frames), { deck: '2', mine: '1' }, 'no Orientation scratch frame')
  const kids = (sel: string) => page.locator(sel).evaluateAll((els: any) => els.map((e: any) => e.className))
  assert.deepEqual(await kids('.bctl-top > *'), ['bctl-bar bctl-add'], 'Card and Group at the top right')
  assert.deepEqual(await kids('.bctl-nav > *'), ['bctl-bar bctl-zoom', 'bctl-map'], 'no Scratch button: the search, zoom and Fit over the minimap')
  assert.equal(await page.locator('.board-status').innerText(), '3 cards · 2 groups')
  await page.evaluate(() => {
    (window as any).__toasts = []
    ;(window as any).__bus.on('toast', (t: any) => (window as any).__toasts.push(t.text))
  })
  await page.evaluate(() => (window as any).__bus.emit('openRef', { ref: 'card:s2' }))
  await page.waitForFunction(() => (window as any).__toasts.length > 0, null, { timeout: 2000 })
  assert.deepEqual(await page.evaluate(() => (window as any).__toasts), ['This card is scratch work of an older orientation, which is not on the canvas.'])
  await page.waitForTimeout(400)
  const deckTop = await page.evaluate(() => {
    const vp = (document.querySelector('.board-stage') as any).getBoundingClientRect()
    const f = (document.querySelector('.frame[data-group="deck"]') as any).getBoundingClientRect()
    return f.top - vp.top
  })
  assert.ok(deckTop > 0 && deckTop < 120, `the deck opens from its top (${deckTop})`)
  await page.evaluate(() => (window as any).__bus.emit('openRef', { ref: 'card:gone' }))
  await page.waitForFunction(() => (window as any).__toasts.length > 1, null, { timeout: 8000 })
  assert.equal(await page.evaluate(() => (window as any).__toasts[1]), 'This card is not on the canvas.')
  assert.deepEqual(pageErrors, [])
})
