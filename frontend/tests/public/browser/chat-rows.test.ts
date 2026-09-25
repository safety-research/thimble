// The chat drawn by its real components in a page (chat-entry.tsx): the rows of a session as they fold, the start
// gate, the composer and its effort menu, a retry after the API was at capacity, the thread tree with its filter, raw
// calls as chip lines, code in the syntax colours, and a failed orientation's Report a problem. What jsdom can show of
// the same rows (a permission request, one chip for a card made and edited) is tests/public/render.test.tsx.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { bundle, cleanup, FRONTEND, launch, src } from './page.ts'


/** The app's stylesheets as one sheet, in index.css's order, with their imports left out. */
const appStyles = () =>
  readFileSync(path.join(FRONTEND, 'src', 'styles', 'index.css'), 'utf8')
    .split('\n')
    .map((l: any) => /@import '\.\/(.+?)'/.exec(l)?.[1])
    .filter(Boolean)
    .map((f: any) => readFileSync(path.join(FRONTEND, 'src', 'styles', f), 'utf8').replace(/^@import.*$/gm, ''))
    .join('\n')

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const consoleErrors: any[] = [] // React's development warnings (a repeated key) arrive as console errors
const posted: any[] = [] // the bodies of POST /api/ws/mini/events, as the start gate sends them

const AGENT = {
  meta: { id: 'ag1', kind: 'agent', role: 'subagent', title: 'count the files', created_at: '2026-09-22T10:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'running', result: null, ts_end: null, running: true },
  events: [
    // the mirror copies the subagent's transcript: its brief first, then its steps and its text
    { type: 'user', ts: '2026-09-22T10:00:00Z', text: 'The whole corpus, what it is and what happened in it.', by: 'terminal' },
    { type: 'tool_use', ts: '2026-09-22T10:00:01Z', id: 'a1', name: 'Glob', input: { pattern: 'agents/*.jsonl' } },
    { type: 'tool_result', ts: '2026-09-22T10:00:02Z', id: 'a1', summary: '3 files' },
    { type: 'tool_use', ts: '2026-09-22T10:00:03Z', id: 'a2', name: 'mcp__thimble__add_cell', input: { kind: 'plot', question: 'Messages per agent' } },
    { type: 'text', delta: 'Drawing the first card.' },
  ],
}

// a finished orientation: its cards in its deck, where a call that names no group puts them, one added naming the deck
// and one moved there by an edit that names it; a view proposed, a label applied
// an orientation whose session failed before it did anything
const ORIENT_FAILED = {
  meta: { id: 'orf', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-22T11:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'failed', result: 'Not logged in · Please run /login', ts_end: '2026-09-22T11:00:02Z', session: '11111111-1111-4111-8111-111111111111' },
  events: [{ type: 'user', ts: '2026-09-22T11:00:00Z', text: 'The whole corpus.', by: 'terminal' }, { type: 'error', ts: '2026-09-22T11:00:02Z', message: 'Not logged in · Please run /login', kind: 'failed' }],
}
const ORIENT = {
  meta: { id: 'or1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-22T10:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'done', result: 'summary', ts_end: '2026-09-22T10:06:00Z' },
  events: [
    { type: 'user', ts: '2026-09-22T10:00:00Z', text: 'The whole corpus.', by: 'terminal' },
    { type: 'tool_use', ts: '2026-09-22T10:01:00Z', id: 'o1', name: 'mcp__plugin_thimble_thimble__add_cell', input: { question: 'Files' } },
    { type: 'tool_result', ts: '2026-09-22T10:01:10Z', id: 'o1', summary: 'cell:aaaa1111\nok', cell_id: 'aaaa1111' },
    { type: 'tool_use', ts: '2026-09-22T10:02:00Z', id: 'o2', name: 'mcp__plugin_thimble_thimble__add_cell', input: { question: 'Rows' } },
    { type: 'tool_result', ts: '2026-09-22T10:02:10Z', id: 'o2', summary: 'cell:bbbb2222\nok' },
    { type: 'tool_use', ts: '2026-09-22T10:03:00Z', id: 'o3', name: 'mcp__plugin_thimble_thimble__add_cell', input: { question: 'The burst', group: 'Orientation' } },
    { type: 'tool_result', ts: '2026-09-22T10:03:10Z', id: 'o3', summary: 'cell:cccc3333\nok', cell_id: 'cccc3333' },
    { type: 'tool_use', ts: '2026-09-22T10:03:20Z', id: 'o6', name: 'mcp__plugin_thimble_thimble__edit_card', input: { card: 'bbbb2222', group: 'Orientation' } },
    { type: 'tool_result', ts: '2026-09-22T10:03:30Z', id: 'o6', summary: "card:bbbb2222\n\nmoved to the group 'Orientation'" },
    { type: 'tool_use', ts: '2026-09-22T10:04:00Z', id: 'o4', name: 'mcp__plugin_thimble_thimble__propose_view', input: { name: 'Message board' } },
    { type: 'tool_result', ts: '2026-09-22T10:04:10Z', id: 'o4', summary: 'proposed view Message board' },
    { type: 'tool_use', ts: '2026-09-22T10:05:00Z', id: 'o5', name: 'mcp__plugin_thimble_thimble__apply_label', input: { name: 'questions' } },
    { type: 'tool_result', ts: '2026-09-22T10:05:10Z', id: 'o5', summary: 'applied' },
    { type: 'text', delta: 'summary' },
    { type: 'done', ts: '2026-09-22T10:06:00Z', result: 'summary' },
  ],
}

beforeAll(async () => {
  // the harness plus the composer and the thread tree, mounted with what is handed over from here
  script = await bundle('chat-rows', [
      `import '${FRONTEND}/tests/public/browser/chat-entry.tsx'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { Composer } from '${src('chat/Composer.tsx')}'`,
      `import { pickItems, threadNodes } from '${src('chat/threads.ts')}'`,
      `import { ThreadTree } from '${src('components/ThreadTree.tsx')}'`,
      `const mountOne = (id, node) => { const el = document.createElement('div'); el.id = id; document.body.appendChild(el); flushSync(() => createRoot(el).render(node)); return id }`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `bus.on('reportProblem', (p) => { window.__thimble.reported = p })`,
      `window.__thimble.mountComposer = (model, effort, fast = null) => mountOne('composer-' + Date.now(), <Composer model={model} effort={effort} onEffort={effort === undefined ? undefined : (e) => { window.__thimble.effort = e }} fast={fast} onFast={(on) => { window.__thimble.fast = on }} onSend={() => {}} sending={false} />)`,
      `import { StartGate } from '${src('chat/StartGate.tsx')}'`,
      `import { Holds, retryLine, retryText } from '${src('chat/Holds.tsx')}'`,
      `import { failedApiLine, failedLine } from '${src('chat/AgentCard.tsx')}'`,
      `window.__thimble.mountHolds = (alert, permissions) => mountOne('holds-' + Date.now(), <Holds alert={alert} permissions={permissions} onAnswer={(id, allow) => { window.__thimble.answered = [id, allow]; return Promise.resolve() }} onRetry={() => { window.__thimble.retried = (window.__thimble.retried ?? 0) + 1; return Promise.resolve() }} />)`,
      `window.__thimble.retryText = retryText`,
      `window.__thimble.retryLine = retryLine`,
      `window.__thimble.failedLine = failedLine`,
      `window.__thimble.failedApiLine = failedApiLine`,
      `window.__thimble.mountTree = (chats, current, collapsed) => { const items = pickItems(chats, (m) => !!m.running, (m) => !!m.unread, { current, waiting: new Set(chats.filter((m) => m.waiting).map((m) => m.id)) }); return mountOne('tree-' + Date.now(), <header className="chat-head"><ThreadTree nodes={threadNodes(items)} current={current} collapsed={collapsed} onCollapsedChange={() => {}} onPick={() => {}} onRename={(id, name) => { window.__thimble.renamed = [id, name] }} onDelete={(id) => { window.__thimble.deleted = id }} /></header>) }`,
      `import { CodeArea } from '${src('components/Code.tsx')}'`,
      `window.__thimble.mountCodeArea = (value) => mountOne('code-area-' + Date.now(), <CodeArea lang="python" mono block value={value} onChange={() => {}} aria-label="Code" />)`,
  ])
  browser = await launch()
  page = await browser.newPage()
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  page.on('console', (msg: any) => msg.type() === 'error' && consoleErrors.push(msg.text()))
  // the page lives on a fake origin so a relative /api fetch resolves; the task row reads its agent chat through it
  await page.route('http://thimble.test/**', (route: any) => {
    const url = route.request().url()
    if (/\/api\/ws\/mini\/chats\/ag1$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AGENT) })
    if (/\/api\/ws\/mini\/chats\/or1$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORIENT) })
    if (/\/api\/ws\/mini\/chats\/orf$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORIENT_FAILED) })
    if (/\/api\/ws\/mini\/events$/.test(url) && route.request().method() === 'POST') {
      posted.push(JSON.parse(route.request().postData() || '{}'))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e1', kind: 'start', delivered: 1 }) })
    }
    if (/\/api\/ws\/mini\/views\/proposals$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROPOSALS) })
    if (/\/api\/ws\/mini\/cells\/names$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abcd1234', notebook: 'nb1', title: 'Agents per run' }]) })
    if (/\/api\//.test(url)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"no"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=mini')
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The menu item that holds the focus, waited for up to a second: a Menu moves the focus a frame after it opens. */
async function focusedItem() {
  let item = null
  for (let i = 0; i < 50 && !item; i++) {
    item = await page.evaluate(() => document.activeElement?.getAttribute('data-item') ?? null)
    if (!item) await new Promise((r: any) => setTimeout(r, 20))
  }
  return item
}

// the two proposals main's chips name, as the dev agent's builds left them: one building, one failed
const PROPOSALS = [
  { slug: 'message-board', name: 'Message board', why: 'w', claims: ['board.jsonl'], arrangement: 'a', proposed_by: 'terminal', status: 'building', ts: 't1', chat: 'vb1' },
  { slug: 'editor-graph', name: 'Editor graph', why: 'w', claims: ['changelog.jsonl'], arrangement: 'a', proposed_by: 'terminal', status: 'failed', ts: 't2', chat: 'vb2',
    error: 'bad changelog.jsonl#L1: resolve() answered None' },
]

const LOG = [
  { type: 'user', ts: '2026-09-22T10:00:00Z', text: 'How many agents? See [[agents/agent-01.jsonl#L3]]', by: 'terminal' },
  { type: 'text', delta: 'There are **three** agents [[3|cell:abcd1234#agents/total]].\n\n- a\n- b' },
  { type: 'tool_use', ts: '2026-09-22T10:00:01Z', id: 't1', name: 'mcp__thimble__add_cell', input: { kind: 'table', question: 'Agents per run', code: 'print(1)' } },
  { type: 'tool_use', ts: '2026-09-22T10:00:02Z', id: 's1', name: 'Read', input: { file_path: '/data/mini/agents/agent-01.jsonl' }, parent_tool_use_id: 't1' },
  { type: 'tool_result', ts: '2026-09-22T10:00:03Z', id: 's1', summary: 'ok', parent_tool_use_id: 't1' },
  { type: 'tool_result', ts: '2026-09-22T10:00:04Z', id: 't1', summary: 'cell:abcd1234\nnotebook:nb1\n3 rows', cell_id: 'abcd1234', notebook: 'nb1' },
  { type: 'done', ts: '2026-09-22T10:00:06Z', session_id: 'sess', cells: ['abcd1234'] },
  { type: 'chip', ts: '2026-09-22T10:01:00Z', kind: 'artifact', text: "the orientation's cards", ref: 'group:deck1' },
  { type: 'agent', ts: '2026-09-22T10:01:01Z', chat: 'ag1', role: 'subagent', title: 'count the files' },
  { type: 'agent', ts: '2026-09-22T10:01:02Z', chat: 'or1', role: 'orient', title: 'Orientation' },
  { type: 'chip', ts: '2026-09-22T10:01:03Z', kind: 'view', text: 'Message board', ref: 'view:message-board', status: 'queued' },
  { type: 'chip', ts: '2026-09-22T10:01:04Z', kind: 'view', text: 'Editor graph', ref: 'view:editor-graph', status: 'queued' },
  { type: 'agent', ts: '2026-09-22T10:01:05Z', chat: 'dev1', role: 'dev', title: 'ticket #1: Group the board by round' },
  { type: 'chip', ts: '2026-09-22T10:01:05Z', kind: 'ticket', text: 'ticket #1: Group the board by round', ref: 'ticket:t1', chat: 'dev1', status: 'started' },
  { type: 'chip', ts: '2026-09-22T10:01:06Z', kind: 'ticket', text: 'ticket #1 applied', ref: 'ticket:t1', chat: 'dev1', status: 'applied' },
  { type: 'agent', ts: '2026-09-22T10:01:07Z', chat: 'wr1', role: 'writer', title: 'Write report' },
  { type: 'chip', ts: '2026-09-22T10:01:08Z', kind: 'artifact', text: 'edited a passage', ref: 'report:slides#s2', status: 'done' },
  { type: 'chip', ts: '2026-09-22T10:06:00Z', kind: 'artifact', text: "the orientation's cards", ref: 'group:deck1', chat: 'or1' },
  { type: 'error', ts: '2026-09-22T10:02:00Z', message: 'stopped', kind: 'interrupted' },
  { type: 'user', ts: '2026-09-22T10:03:00Z', text: 'And per run?', by: 'browser', event: 'e1' },
  { type: 'user', ts: '2026-09-22T10:04:00Z', text: 'Which run is longest?', by: 'browser', event: 'e2' },
]

const MAIN = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: '2026-09-22T10:00:00Z', parent: null, anchor: null, anchor_text: null, model: 'claude-opus-5', effort: 'medium', group: null }

const LABELS = { or1: 'orient', dev1: 'dev/group-the-board-by', wr1: 'write-report' }

test('the rows: the analyst\'s message as an accent tile, markdown with a value chip, a tool-call card with its steps and the card it made, notes with their chips, a subagent card, the orientation\'s end, a stopped note', async () => {
  const id = await page.evaluate(([log, labels]: any) => (window as any).__thimble.mountRows(log, 'mini', false, labels), [LOG, LABELS])
  const root = page.locator(`#${id}`)
  assert.equal(await root.locator('.chat-user .chat-message.msg-user').count(), 3, 'every message of the analyst is the accent tile')
  const first = root.locator('.chat-user .chat-message').first()
  assert.match(await first.innerText(), /How many agents\?/)
  assert.equal(await first.getAttribute('data-by'), 'terminal', 'a terminal prompt says where it was typed')
  assert.equal(await root.locator('.chat-user .refchip').count(), 1, 'a [[ref]] in the analyst text is a chip')
  const browser = root.locator('.chat-message[data-by="browser"]')
  assert.equal(await browser.count(), 2)
  assert.match(await browser.first().innerText(), /And per run\?/)
  assert.equal(await browser.locator('.chip').count(), 0, 'no clock or other chip on a browser message')
  assert.equal(await root.locator('.chat-note [data-by]').count(), 0, 'no note for a browser message')
  assert.equal(await root.locator('.chat-text strong').innerText(), 'three', 'markdown renders')
  assert.equal(await root.locator('.chat-text li').count(), 2)
  const valueChip = root.locator('.chat-text .refchip-value')
  assert.equal(await valueChip.count(), 1)
  assert.equal(await valueChip.innerText(), '3', 'a value ref shows its value')
  assert.equal(await valueChip.locator('.refchip-cite, svg').count(), 0, 'the number itself is the link: no box or glyph after it')
  assert.equal(await valueChip.getAttribute('data-ref'), 'cell:abcd1234#agents/total')
  assert.equal(await valueChip.getAttribute('data-anchor'), 'cell:abcd1234#agents/total', 'a chip in chat prose is a ⌘ anchor')
  assert.equal(await valueChip.evaluate((el: any) => el.classList.contains('refchip-citation')), true, 'a ref in the reply is a citation, which the links toggle hides')
  assert.equal(await root.locator('.chat-user .refchip').getAttribute('data-anchor'), 'agents/agent-01.jsonl#L3')
  // the tool-call card: tonal, named for the kind of work, folded; the card it made is a chip under the head
  const tool = root.locator('.chat-tool.toolcard[data-tool="add_card"]')
  assert.equal(await tool.count(), 1, 'a call by the name the tool had before 2026-09-23 reads as add_card')
  assert.equal(await tool.locator('.chat-tool-name').innerText(), 'Cards')
  assert.equal(await tool.locator('.toolcard-meta').innerText(), '1 step · 3s', 'the steps and how long they took')
  assert.equal(await tool.getAttribute('data-state'), 'done')
  assert.equal(await tool.locator('.toolcard-end .mark-verified').getAttribute('aria-label'), 'done', '✓ at the right edge, named for assistive tech')
  assert.equal(await tool.locator('.toolcard-chips .refchip[data-ref="card:abcd1234"]').count(), 1, 'the card it made, as a chip')
  assert.equal(await tool.locator('.toolcard-steps').count(), 0, 'folded')
  await tool.locator('.toolcard-head').click()
  assert.deepEqual(await tool.locator('.toolcard-step-text').allInnerTexts(), ['add_card · Agents per run', 'Read · agents/agent-01.jsonl'], 'the call, then the calls its subagent made')
  assert.equal(await tool.locator('.chat-tool-fields .chat-tool-field-code').count(), 1, 'the call\'s code the meta does not print')
  assert.equal(await tool.locator('.chat-tool-result').count(), 0, 'a call that made a card shows no result text; its chip is the result')
  assert.equal(await tool.evaluate((el: any) => !el.classList.contains('card')), true, 'the tool-call card is tonal, not the white Card frame')
  // the chip note: a chip that goes where the act landed, with no time and no tooltip; a canvas group's is a view's
  // chip with the group glyph
  const chip = root.locator('.chat-chip-row[data-chip="artifact"] .chat-chip[data-ref="group:deck1"]')
  assert.equal(await chip.count(), 1, 'the orientation chip that names no chat stays a chip note')
  assert.match(await chip.innerText(), /orientation's cards/)
  assert.equal(await chip.getAttribute('title'), null, 'a chip with readable text carries no tooltip')
  assert.equal(await root.locator('.chat-note time').count(), 0, 'a note carries no clock')
  const link = chip.locator('button.chat-chip-link.group-chip')
  assert.equal(await link.count(), 1, 'the chip is the way there; no separate open Button')
  assert.equal(await root.locator('.chat-chip-row .btn').count(), 0)
  assert.equal(await link.getAttribute('title'), null, 'the chip link names itself; no tooltip')
  assert.equal(await link.locator('.view-tab-ico.icon-group').count(), 1, "a group's chip wears the group glyph")
  // a document saved is "revised" (or "wrote"), then the document's chip by its name alone: a view's chip with the
  // document glyph
  const save = root.locator('.chat-doc-save:has(.chat-chip[data-ref="report:slides#s2"])')
  assert.equal(await save.getAttribute('data-verb'), 'revised')
  const doc = save.locator('button.chat-chip-link.doc-chip')
  assert.equal(await doc.innerText(), 'Slides')
  assert.equal(await doc.evaluate((el: any) => el.classList.contains('view-tab')), true, "drawn as a view's chip")
  assert.equal(await doc.locator('.icon-report').count(), 1, 'with the document glyph')
  assert.equal(await doc.evaluate((el: any) => el.classList.contains('chip')), false, 'not the accent chip of a citation')
  // two views proposed in a row are one note with a view chip each
  const views = root.locator('.chat-views-note')
  assert.equal(await views.count(), 1)
  assert.equal(await views.locator('.chat-note-text').innerText(), 'Views proposed')
  assert.deepEqual(await views.locator('.view-tab').allInnerTexts(), ['Message board', 'Editor graph'], "each is the view's tab, as the views bar draws it")
  assert.equal(await views.locator('.view-tab .icon-view').count(), 2, 'each wears the view glyph')
  assert.equal(await views.locator('.chip-tone-accent').count(), 0, 'not the accent chip of a citation')
  // each chip follows its proposal's build: a spinner while it builds, ✕ with the error and Retry when it failed
  await views.locator('.view-chip[data-status="failed"]').waitFor({ timeout: 5000 })
  assert.equal(await views.locator('.view-chip[data-status="building"] .spinner').count(), 1)
  const failed = views.locator('.view-chip[data-status="failed"]')
  await failed.locator('.view-chip-why').hover()
  assert.equal(await page.locator('[role="tooltip"]').innerText(), 'bad changelog.jsonl#L1: resolve() answered None', 'the error in the one tooltip')
  await page.mouse.move(0, 0)
  assert.equal(await failed.locator('.btn.view-chip-retry').innerText(), 'Retry')
  assert.equal(await failed.getByRole('button', { name: 'Report a problem' }).count(), 1, 'and the bug that reports it')
  // a chip is the bar's option for a view that is not picked, the same while the view builds (views-bar.test.tsx
  // checks the two share the accent chip's colours)
  assert.deepEqual(await views.locator('.view-tab').evaluateAll((els: any[]) => els.map((el) => el.className)), ['view-tab view-chip-chip', 'view-tab view-chip-chip'], 'one look, built or not')
  // the orientation and a dev ticket started: a note with the thread's chip, which names the thread
  const orient = root.locator('.chat-agent-note[data-chat="or1"]')
  assert.equal(await orient.locator('.chat-note-text').innerText(), 'Orientation started in')
  assert.equal(await orient.locator('.chat-thread-chip').innerText(), 'orient')
  assert.equal(await orient.locator('.chat-thread-chip .icon-thread').count(), 1)
  // a writer runs in a session of its own too, so main notes where it runs
  const writer = root.locator('.chat-agent-note[data-chat="wr1"]')
  assert.equal(await writer.locator('.chat-note-text').innerText(), 'Writing started in')
  assert.equal(await writer.locator('.chat-thread-chip').innerText(), 'write-report')
  const dev = root.locator('.chat-agent-note[data-chat="dev1"]')
  assert.equal(await dev.locator('.chat-note-text').innerText(), 'Dev ticket started')
  assert.equal(await dev.locator('.chat-thread-chip').innerText(), 'dev/group-the-board-by')
  const tickets = root.locator('.chat-chip-row[data-chip="ticket"]')
  assert.equal(await tickets.count(), 1, 'the ticket\'s start is its thread\'s note; only its apply is a chip note')
  assert.equal(await tickets.locator('.chat-note-text').innerText(), 'Dev ticket applied')
  assert.equal(await tickets.locator('.chat-thread-chip').innerText(), 'dev/group-the-board-by')
  // the orientation's end: what it left for review, counted, then its card with a section per surface
  const landing = root.locator('.chat-landing[data-chat="or1"]')
  await landing.locator('.chat-task[data-status="done"]').waitFor({ timeout: 5000 })
  await landing.locator('.chat-landing-count').first().waitFor({ timeout: 5000 })
  // the cards for review are the deck's, the label's card among them, as the canvas counts it
  assert.equal(await landing.locator('.chat-landing-line').innerText(), 'Orientation has finished. Thimble has 1 view, 4 cards and 1 label for you to review.')
  assert.deepEqual(await landing.locator('.chat-landing-count').allInnerTexts(), ['1 view', '4 cards', '1 label'], 'the counts in ink')
  const card = landing.locator('.chat-task')
  assert.equal(await card.locator('.chat-task-title').innerText(), 'Orientation')
  assert.equal(await card.locator('.toolcard-meta').innerText(), '6 min', 'how long it took; its steps are its subagents, and it ran none')
  assert.deepEqual(await card.locator('.toolcard-section-label').allInnerTexts(), ['Views', 'Canvas', 'Labels'], 'a section per surface the work landed on')
  // a card whose call names no group is in the deck, where the server put it, and the label's card with it
  // the group's chip names it, with the count's unit
  const group = card.locator('.toolcard-section[data-section="canvas"] .group-chip')
  assert.equal(await group.innerText(), 'Orientation · 4 cards', 'the cards by the group they landed in, the unit named')
  // a label is its row in the Labels pane: the colour's square and the name
  const label = card.locator('.toolcard-section[data-section="labels"] .label-chip')
  assert.equal(await label.innerText(), 'questions')
  assert.equal(await label.locator('.label-chip-box').count(), 1)
  // names in words (a canvas group, a label) are set in the body face, as the view's tab is; nothing says "ready"
  assert.deepEqual(await card.locator('.toolcard-section .surface-chip, .toolcard-section[data-section="canvas"] .view-tab').evaluateAll((els: any[]) => els.map((el) => el.className)), ['view-tab group-chip', 'surface-chip label-chip'], 'the group as a view\'s chip and the label chip, each in the sans (render.test.tsx reads the rule)')
  assert.equal(await card.locator('.toolcard-section .chip').count(), 0, 'none is the accent chip of a citation')
  assert.equal(await card.locator('.view-chip-word').count(), 0, 'a finished view needs no word after it')
  assert.doesNotMatch(await card.locator('.toolcard-section[data-section="views"]').innerText(), /ready/)
  assert.equal(await card.locator('.toolcard-section-head.toolcard-section-act').count(), 3, 'each section\'s name goes to its surface')
  // the stopped reply: a note, the ✕ mark and one word
  const stopped = root.locator('.chat-stopped.chat-row')
  assert.equal(await stopped.locator('.chat-row-word').innerText(), 'stopped')
  assert.equal(await stopped.locator('.chat-row-mark-stopped').getAttribute('aria-label'), 'stopped', 'the mark is named for assistive tech')
  assert.equal(await root.locator('.chat-note [title], .toolcard-end [title]').count(), 0, 'the marks carry no native tooltip')
  assert.equal(await root.locator('.chat-stopped .chat-row-caret').count(), 0, 'nothing to open on a stopped reply')
  // a subagent is a call chip, reading its agent chat live
  const task = root.locator('.chat-task.chat-agent[data-chat="ag1"]')
  await task.locator('.chat-agent-meta:has-text("2 steps")').waitFor({ timeout: 5000 })
  assert.equal(await task.locator('.chat-agent-chip.chat-callchip').count(), 1, 'the call chip the folded calls wear')
  assert.equal(await task.locator('.chat-agent-name').innerText(), 'count the files')
  assert.equal(await task.getAttribute('data-status'), 'running')
  assert.equal(await task.locator('.chat-agent-head > .spinner').count(), 1, 'a running agent shows the spinner after its chip')
  await task.locator('.chat-agent-chip').click()
  assert.deepEqual(await task.locator('.toolcard-step-text').allInnerTexts(), ['Listed files · agents/*.jsonl', 'Added card · Messages per agent'], 'it opens to the agent\'s calls as steps, in plain words')
  assert.equal(await task.locator('.chat-agent-body').innerText().then((t: string) => /whole corpus/.test(t)), false, 'not the brief: its thread keeps that')
  assert.deepEqual(await task.locator('.toolcard-step').evaluateAll((els: any) => els.map((el: any) => el.className.replace('toolcard-step ', ''))), ['toolcard-step-done', 'toolcard-step-running'])
  assert.equal(await task.locator('.toolcard-step-running .spinner').count(), 1, 'the running step turns the spinner, not a retry glyph')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('a turn Claude\'s safety check stopped: two calls, then quiet notes that send the analyst to the terminal, never silence or a tile', async () => {
  // what session.py writes when the safety check stops a turn: the calls, the stop, the model-switch dialog held open,
  // the Esc
  const log = [
    { type: 'user', ts: '2026-09-23T03:34:24Z', text: 'What does the `index` field mean?', by: 'browser', event: 'e1' },
    { type: 'tool_use', ts: '2026-09-23T03:34:26Z', id: 'q1', name: 'mcp__plugin_thimble_thimble__read_ref', input: { ref: 'cell:6cd8525f' } },
    { type: 'tool_result', ts: '2026-09-23T03:34:26Z', id: 'q1', summary: '$ read_ref ref="cell:6cd8525f"' },
    { type: 'tool_use', ts: '2026-09-23T03:34:27Z', id: 'q2', name: 'Bash', input: { command: 'python3 -c "..."' } },
    { type: 'tool_result', ts: '2026-09-23T03:34:28Z', id: 'q2', summary: 'first index 82' },
    { type: 'chip', ts: '2026-09-23T03:34:31Z', kind: 'session', text: "Claude's safety check stopped a response, and the session is trying it once more" },
    { type: 'chip', ts: '2026-09-23T03:34:34Z', kind: 'session', text: "The session is waiting for you in the terminal: Claude's safety check stopped this turn" },
    { type: 'chip', ts: '2026-09-23T03:43:45Z', kind: 'session', text: "The session stopped: Claude's safety check ended this turn" },
    { type: 'done', ts: '2026-09-23T03:43:45Z', session_id: 'sess' },
  ]
  const id = await page.evaluate((l: any) => (window as any).__thimble.mountRows(l, 'mini', false, {}), log)
  const root = page.locator(`#${id}`)
  assert.equal(await root.locator('.chat-user').count(), 1, 'the question is the one tile')
  assert.equal(await root.locator('.chat-tool.toolcard').count() >= 1, true, 'the calls before the stop stay cards')
  const notes = root.locator('.chat-note[data-chip="session"]')
  assert.deepEqual(await notes.locator('.chat-note-text').allInnerTexts(), [log[5].text, log[6].text, log[7].text], 'one quiet note each, in order')
  assert.equal(await notes.locator('.refchip, .spinner').count(), 0, 'words only: nothing to open, nothing pending')
  const last = await root.locator('.chat-row, .chat-msg').last().getAttribute('data-chip')
  assert.equal(last, 'session', 'the turn ends on the note that sends the analyst to the terminal')
  assert.deepEqual(pageErrors, [])
})

test('the start gate: the offer wraps the composer, its options collapsed behind Show options, four switch rows each on its own, the effort menu with ultracode at the field\'s foot, Start and Skip outside the field', async () => {
  const id = await page.evaluate(() => (window as any).__thimble.mountStart('mini'))
  const root = page.locator(`#${id}`)
  const row = (pass: any) => root.locator(`.chat-gate-row[data-pass="${pass}"]`)
  const sw = (pass: any) => row(pass).locator('[role=switch]')
  assert.equal(await root.locator('.chat-gate-title').innerText(), 'Start orientation')
  // the options are collapsed by default behind Show options in the accent, the chevron after the words and no summary of
  // the choices, and a click opens them
  const toggle = root.locator('.chat-gate-options-toggle')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await root.locator('.chat-gate-row').count(), 0, 'no switch shows until the row is opened')
  assert.equal(await root.locator('.chat-gate-perms').count(), 0)
  assert.equal(await toggle.innerText(), 'Show options')
  const sheet = await page.addStyleTag({ content: appStyles() })
  await page.waitForTimeout(400) // the colour transitions from the unstyled ink
  const [ink, accent, chevronLast] = await toggle.evaluate((el: any) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--text-accent)'
    el.parentElement.appendChild(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return [getComputedStyle(el).color, want, el.lastElementChild?.classList.contains('chat-gate-caret')]
  })
  await sheet.evaluate((el: any) => el.remove())
  assert.equal(ink, accent, 'Show options is in the accent')
  assert.notEqual(accent, 'rgb(0, 0, 0)', 'the accent token resolved')
  assert.equal(chevronLast, true, 'the chevron comes after the words')
  const tall = () => root.locator('.chat-gate-top').evaluate((el: any) => el.scrollHeight)
  const closed = await tall()
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  const opened = await tall()
  assert.ok(opened > closed + 60, `opened, the switches and the mode follow the row (${closed} -> ${opened} px)`)
  // ultracode is an effort level, not a switch; the switches are the passes, each of which can be turned off
  assert.deepEqual(await root.locator('.chat-gate-label').allInnerTexts(), ['Write Orientation deck', 'Propose views', 'Critique and revise', 'Generate report'])
  assert.equal(await root.locator('.chat-gate-row [role=switch].switch').count(), 4, 'each pass is the shared Switch')
  assert.equal(await root.locator('.chat-gate-row .switch.on').count(), 4, 'every pass starts on')
  const field = root.locator('.chat-gate-field')
  assert.equal(await field.locator('textarea').getAttribute('placeholder'), null, 'the instructions field is empty, with no placeholder')
  // the orientation's model line: the role's model, its effort as a menu (written in lower case, ultracode too) and fast
  // mode's bolt beside it
  assert.equal(await field.locator('.model-line-model').innerText(), 'Opus 5', "the orientation's model")
  assert.equal(await field.locator('.model-line-model').evaluate((el: any) => el.tagName.toLowerCase()), 'span', 'the model is no menu here')
  assert.equal(await field.locator('button.model-line-effort').innerText(), 'ultracode', 'the effort is a menu, ultracode by default')
  assert.equal(await field.locator('.model-line .fast-bolt').count(), 1, 'fast mode is the bolt beside the effort')
  assert.equal(await field.locator('.btn:not(.fast-bolt)').count(), 0, 'Start and Skip sit outside the field')
  assert.deepEqual(await root.locator('.chat-gate-foot .btn').allInnerTexts(), ['Skip', 'Start'])
  assert.equal(await root.locator('.chat-gate-go.btn-primary').count(), 1)
  assert.equal(await root.locator('.chat-gate [title]').count(), 0, 'no tooltip anywhere on the gate')
  await sw('final').click()
  assert.equal(await sw('final').getAttribute('aria-checked'), 'false')
  for (const pass of ['views', 'critique', 'report']) {
    assert.equal(await sw(pass).getAttribute('aria-checked'), 'true', `${pass} stays on without Final`)
    assert.equal(await sw(pass).isDisabled(), false, `and ${pass} can still be changed`)
  }
  // Start sends the session the `start` event through the one event path; the choices ride as its attributes
  for (const pass of ['views', 'critique', 'report']) await sw(pass).click()
  assert.equal(await root.locator('.chat-gate-row .switch.on').count(), 0)
  assert.equal(await root.locator('.chat-gate-go').isDisabled(), false, 'every switch off still starts an orientation in Scratch')
  await sw('final').click()
  // the model's tip shows on hover only, saying where the orientation's model changes
  assert.equal(await page.locator('.tip').count(), 0, 'no tip until the model is hovered')
  await field.locator('.model-line-model').hover()
  assert.equal(await page.locator('.tip[role=tooltip]').innerText(), "Change the orientation's model in Settings")
  await root.locator('.chat-gate-title').hover()
  assert.equal(await page.locator('.tip').count(), 0, 'the tip goes with the pointer')
  await field.locator('.model-line-effort').click()
  assert.deepEqual(await page.locator('.popover .menu-item .menu-item-label').allInnerTexts(), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], 'the efforts alone, lowest first, then ultracode, the highest')
  assert.equal(await page.locator('.popover .menu-item.checked').innerText(), 'ultracode')
  assert.equal(await focusedItem(), 'ultracode', 'the focus opens on the effort in use')
  assert.equal(await page.locator('.tip').count(), 0, 'no tip shows as the menu opens')
  await page.locator('.popover .menu-item[data-item="high"]').click()
  assert.equal(await field.locator('.model-line-effort').innerText(), 'high')
  await root.locator('.chat-gate-go').click()
  for (let i = 0; i < 50 && !posted.length; i++) await new Promise((r: any) => setTimeout(r, 20))
  assert.deepEqual(posted.shift(), { kind: 'start', payload: { final_notebook: true, propose_views: false, generate_report: false, critique: false, ultracode: false, effort: 'high', permissions: 'manual' } }, 'the switches, the effort and the permission mode, as the gate says (Manual with no mode of the analyst\'s known)')
  const again = page.locator(`#${await page.evaluate(() => (window as any).__thimble.mountStart('mini'))}`)
  await again.locator('.chat-gate-text').fill('  Focus on the March 3 burst ')
  await again.locator('.chat-gate-text').press('Enter')
  for (let i = 0; i < 50 && !posted.length; i++) await new Promise((r: any) => setTimeout(r, 20))
  assert.deepEqual(posted.shift(), { kind: 'start', payload: { final_notebook: true, propose_views: true, generate_report: true, critique: true, ultracode: true, effort: 'xhigh', text: 'Focus on the March 3 burst', permissions: 'manual' } }, 'the defaults, ultracode at its level, and the instructions as the event\'s text; Enter starts')
  await again.locator('.chat-gate-skip').click()
  assert.equal(await page.evaluate(() => (window as any).__thimble.skipped), 1, 'Skip hands main back')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('the composer names the session\'s model and has no Stop', async () => {
  const cOn = page.locator(`#${await page.evaluate((m: any) => (window as any).__thimble.mountComposer(m), 'claude-opus-5')}`)
  assert.equal(await cOn.locator('.composer-send').count(), 1, 'the composer sends')
  assert.equal(await cOn.locator('.composer-model').count(), 1, 'the session\'s model line')
  assert.equal(await cOn.locator('.model-line-model').innerText(), 'Opus 5', 'the model, named')
  assert.equal(await cOn.locator('.model-line-part').count(), 0, 'no menu: /model in the terminal changes the model')
  assert.equal(await cOn.locator('.composer-stop').count(), 0, 'no Stop: the browser cannot interrupt the session')
  const cOff = page.locator(`#${await page.evaluate((m: any) => (window as any).__thimble.mountComposer(m), null)}`)
  assert.equal(await cOff.locator('.composer-model').count(), 0, 'no chip before the mirror has read a reply')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('the composer\'s model line for main and its threads: the model with its tip on hover, the efforts as a menu, fast mode as a bolt that shows its state where it cannot switch', async () => {
  const c = page.locator(`#${await page.evaluate(() => (window as any).__thimble.mountComposer('claude-opus-5', 'medium'))}`)
  assert.equal(await c.locator('.composer-model').count(), 1, 'one line')
  assert.equal(await c.locator('.model-line-model').innerText(), 'Opus 5')
  assert.equal(await c.locator('button.model-line-effort').innerText(), 'medium')
  // the model's tip shows on hover only
  assert.equal(await page.locator('.tip').count(), 0, 'no tip until the model is hovered or focused')
  await c.locator('.model-line-model').hover()
  const tip = page.locator('.tip[role=tooltip]')
  assert.equal(await tip.innerText(), 'Run /model in the Claude Code terminal to change the model', 'the tip on hover, and no other text')
  assert.equal(await c.locator('.model-line-model').getAttribute('aria-describedby'), await tip.getAttribute('id'), 'the model names its tip')
  await c.locator('textarea').hover()
  assert.equal(await page.locator('.tip').count(), 0, 'the tip goes with the pointer')
  await c.locator('button.model-line-effort').click()
  assert.deepEqual(await page.locator('.popover .menu-item .menu-item-label').allInnerTexts(), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], 'the efforts alone, then ultracode')
  assert.equal(await page.locator('.popover .menu-item.checked').innerText(), 'medium', 'the effort in use is checked')
  assert.equal(await focusedItem(), 'medium', 'the menu opens with the focus on the effort in use, so the arrows work at once')
  assert.equal(await page.locator('.tip').count(), 0, 'no tip shows as the menu opens')
  await page.locator('.popover .menu-item[data-item="ultracode"]').click()
  assert.equal(await page.evaluate(() => (window as any).__thimble.effort), 'ultracode')
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('model-line-effort')), true, 'the focus goes back to the effort, not to the page')
  assert.equal(await page.locator('.popover').count(), 0)
  assert.equal(await c.locator('.composer-model [title], .composer-model[title]').count(), 0, 'no browser title on the line')
  // a session launched without fast mode: the bolt shows it off, and its tip says where it turns on
  const off = c.locator('.fast-bolt')
  assert.equal(await off.getAttribute('aria-pressed'), 'false')
  assert.equal(await off.getAttribute('aria-disabled'), 'true', 'a session launched without fast mode cannot turn it on from here')
  await off.hover()
  assert.equal(await tip.innerText(), 'Run /fast in the Claude Code terminal to turn on fast mode')
  await page.evaluate(() => { (window as any).__thimble.fast = undefined })
  await off.click({ force: true })
  assert.equal(await page.evaluate(() => (window as any).__thimble.fast), undefined, 'the click does nothing')
  // fast mode, where the session can switch it: the bolt filled while on, a click turns it off
  const f = page.locator(`#${await page.evaluate(() => (window as any).__thimble.mountComposer('claude-opus-5', 'high', true))}`)
  const on = f.locator('.fast-bolt')
  assert.equal(await on.getAttribute('aria-pressed'), 'true', 'the bolt while fast mode is on')
  assert.equal(await on.getAttribute('aria-disabled'), null, 'a switch while the session runs fast')
  await on.click()
  assert.equal(await page.evaluate(() => (window as any).__thimble.fast), false, 'a click turns it off')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test("a session waiting to retry after the API was at capacity is the API error's card: why, a countdown and Retry now; a failure says why", async () => {
  // agent_session's retry alert, so an API at capacity does not cost a session its work
  const until = new Date(Date.now() + 60_000).toISOString()
  const alert = { kind: 'retry', text: "Anthropic's API is overloaded; retrying in 60 s.", reason: "Anthropic's API is overloaded", until, attempt: 2 }
  const h = page.locator(`#${await page.evaluate((a: any) => (window as any).__thimble.mountHolds(a, []), alert)}`)
  const hold = h.locator('.chat-apierr[data-waits]')
  assert.equal(await hold.locator('.chat-apierr-what').innerText(), "Anthropic's API is overloaded", 'what happened')
  assert.match(await hold.locator('.chat-apierr-retrying').innerText(), /^thimble retries in (59|60) s, keeping the work so far\.$/, 'and when thimble retries')
  assert.equal(await hold.getAttribute('role'), 'status', 'a wait the analyst need not act on is a status, not an alert')
  await hold.locator('.chat-apierr-retry').click()
  assert.equal(await page.evaluate(() => (window as any).__thimble.retried), 1)
  const at = Date.parse('2026-09-24T21:14:00Z')
  const line = (secs: any) => page.evaluate(([a, n]: any) => (window as any).__thimble.retryLine(a, n), [{ ...alert, until: new Date(at + secs * 1000).toISOString() }, at])
  assert.equal(await line(45), 'thimble retries in 45 s, keeping the work so far.')
  assert.equal(await line(300), 'thimble retries in 5 min, keeping the work so far.')
  assert.equal(await line(-3), 'thimble retries now, keeping the work so far.')
  const text = (secs: any) => page.evaluate(([a, n]: any) => (window as any).__thimble.retryText(a, n), [{ ...alert, until: new Date(at + secs * 1000).toISOString() }, at])
  assert.equal(await text(45), "Anthropic's API is overloaded; retrying in 45 s.")
  assert.equal(await text(300), "Anthropic's API is overloaded; retrying in 5 min.")
  assert.equal(await text(-3), "Anthropic's API is overloaded; retrying now.")
  assert.equal(await page.evaluate((a: any) => (window as any).__thimble.retryText(a, 0), { kind: 'retry', text: 'Retrying.' }), 'Retrying.', 'no time named: its own text')
  // the landing line of a failed orientation carries the error's own text on one line, never a failure without a
  // reason; an API error is the API error's card under the line instead, as every API error is
  const repeated = 'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.'
  assert.equal(await page.evaluate((r: any) => (window as any).__thimble.failedLine(r), repeated), 'Orientation failed.')
  assert.equal(await page.evaluate((r: any) => (window as any).__thimble.failedApiLine(r), repeated), repeated)
  assert.equal(await page.evaluate(() => (window as any).__thimble.failedApiLine('exit 1')), null)
  assert.equal(await page.evaluate(() => (window as any).__thimble.failedLine('exit 1\n')), 'Orientation failed: exit 1.')
  assert.equal(await page.evaluate(() => (window as any).__thimble.failedLine(null)), 'Orientation failed.')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('the thread tree: one row collapsed, main and its threads open, a ⌘-born thread on the guide line, the state at the right edge', async () => {
  const chats = [
    { ...MAIN, n_messages: 4 },
    { ...MAIN, id: 't1', kind: 'thread', role: 'thread', title: 'why-the-spike', created_at: '2026-09-22T10:10:00Z', parent: 'main', anchor: 'cell:abcd1234', running: true, n_messages: 1 },
    { ...MAIN, id: 't2', kind: 'thread', role: 'thread', title: 'refund policy', created_at: '2026-09-22T10:20:00Z', parent: 'main', anchor: 'report:report#s1', unread: true, n_messages: 2 },
    { ...MAIN, id: 't3', kind: 'thread', role: 'thread', title: 'loose', created_at: '2026-09-22T10:30:00Z', parent: 'main', anchor: 'card:x', n_messages: 2 },
    { ...MAIN, id: 't4', kind: 'thread', role: 'thread', title: 'deeper', created_at: '2026-09-22T10:40:00Z', parent: 't1', anchor: 'cell:abcd1234', n_messages: 2, waiting: true },
    { ...MAIN, id: 't5', kind: 'thread', role: 'thread', title: 'never-asked', created_at: '2026-09-22T10:50:00Z', parent: 'main', anchor: 'card:y', n_messages: 0 },
  ]
  const shut = page.locator(`#${await page.evaluate(([c, cur]: any) => (window as any).__thimble.mountTree(c, cur, true), [chats, 'main'])}`)
  const summary = shut.locator('.tt-summary')
  assert.equal(await summary.locator('.tt-name').innerText(), 'main', 'collapsed, the card names the current thread')
  assert.equal(await summary.locator('.tt-active').innerText(), '1', 'how many threads run, by the spinner')
  assert.equal(await summary.locator('.tt-active .spinner').count(), 1)
  assert.equal(await summary.locator('.tt-attn-unread').innerText(), '1', 'how many hold an unread reply, by the dot')
  assert.equal(await summary.locator('.tt-attn-waiting').innerText(), 'waiting', 'and that a prompt waits for the analyst')
  const root = page.locator(`#${await page.evaluate(([c, cur]: any) => (window as any).__thimble.mountTree(c, cur, false), [chats, 'main'])}`)
  const rows = () => root.locator('.tt-list > .tt-row').evaluateAll((els: any) => els.map((el: any) => [el.getAttribute('data-thread'), el.classList.contains('tt-child') ? el.style.getPropertyValue('--depth') : '0']))
  assert.deepEqual(await rows(), [['main', '0'], ['t1', '1'], ['t4', '2'], ['t3', '1'], ['t2', '1']], 'every thread, the most recent first, a ⌘-born one on its parent\'s guide line; the empty one is not listed')
  const row = (id: any) => root.locator(`.tt-row[data-thread="${id}"]`)
  assert.equal(await row('main').getAttribute('aria-selected'), 'true', 'the current thread is selected')
  assert.equal(await row('main').evaluate((el: any) => el.classList.contains('current')), true)
  assert.equal(await row('main').locator('.tt-more').count(), 0, 'main has no actions: it cannot be renamed or deleted')
  assert.equal(await row('t1').locator('.tt-end .spinner').count(), 1, 'running: the spinner')
  assert.equal(await row('t2').locator('.tt-end .dot').count(), 1, 'unread: the dot')
  assert.equal(await row('t4').locator('.tt-end .tt-waiting').count(), 1, 'a prompt waits: the warning dot')
  assert.equal(await row('t3').locator('.tt-end .spinner, .tt-end .dot, .tt-end .tt-meta').count(), 0, 'nothing to say, nothing at the edge')
  assert.equal(await root.locator('.tt-row [title]').count(), 0, 'no tooltip on a row')
  assert.equal(await root.locator('.tt-filter').count(), 0, 'a short list has no search field')
  // drawn as the Files tree: a row's ancestors' guide lines, a chevron where rows hang under a row, which folds them
  assert.equal(await row('t4').locator('.tt-guide').count(), 2, 'one guide line per level above the row')
  assert.equal(await row('main').locator('.tt-guide').count(), 0)
  assert.equal(await row('t1').locator('.tt-caret-on .icon-chevron-right').count(), 1, 'a row with rows under it has a chevron')
  assert.equal(await row('t3').locator('.tt-caret-on').count(), 0, 'a row with none has a blank first column')
  assert.equal(await row('t1').getAttribute('aria-expanded'), 'true')
  await row('t1').locator('.tt-caret').click()
  assert.deepEqual((await rows()).map((r: any) => r[0]), ['main', 't1', 't3', 't2'], 'the chevron folds the rows under it')
  assert.equal(await row('t1').getAttribute('aria-expanded'), 'false')
  assert.equal(await row('t1').locator('.tt-end .tt-waiting').count(), 1, 'a folded row shows that a prompt waits in a row it hides')
  await row('t1').locator('.tt-caret').click()
  assert.equal((await rows()).length, 5, 'and unfolds them')
  // the row menu: Rename edits the name in place, Enter saves and Escape cancels; Delete asks once more in place
  await row('t2').hover()
  await row('t2').locator('.tt-more').click()
  const menu = page.locator('.tt-menu')
  await menu.waitFor({ timeout: 3000 })
  assert.deepEqual(await menu.locator('.menu-item-label').allInnerTexts(), ['Rename', 'Delete…'])
  await menu.locator('.menu-item.danger').click()
  assert.equal(await menu.locator('.menu-item.danger').innerText(), 'Delete — sure?', 'delete asks once more in place')
  assert.equal(await page.evaluate(() => (window as any).__thimble.deleted ?? null), null, 'nothing is deleted before the second press')
  await menu.locator('.menu-item.danger').click()
  assert.equal(await page.evaluate(() => (window as any).__thimble.deleted), 't2', 'the second press deletes it')
  await row('t2').hover()
  await row('t2').locator('.tt-more').click()
  await menu.waitFor({ timeout: 3000 })
  await menu.locator('.menu-item', { hasText: 'Rename' }).click()
  const edit = root.locator('input.tt-rename')
  assert.equal(await edit.inputValue(), 'refund policy', 'Rename opens the name in place')
  await edit.fill('refunds by region')
  await edit.press('Enter')
  assert.deepEqual(await page.evaluate(() => (window as any).__thimble.renamed), ['t2', 'refunds by region'], 'Enter saves')
  assert.equal(await root.locator('input.tt-rename').count(), 0)
  await row('t3').locator('.tt-name').dblclick()
  await root.locator('input.tt-rename').fill('never saved')
  await root.locator('input.tt-rename').press('Escape')
  assert.equal(await root.locator('input.tt-rename').count(), 0, 'Escape cancels')
  assert.deepEqual(await page.evaluate(() => (window as any).__thimble.renamed), ['t2', 'refunds by region'], 'and saves nothing')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('the thread tree with the orientation and a dev ticket: the orientation at the top level, the finished ticket under main with its time', async () => {
  const chats = [
    { ...MAIN },
    { ...MAIN, id: 't1', kind: 'thread', role: 'thread', title: 'why-the-spike', created_at: '2026-09-22T10:10:00Z', parent: 'main', anchor: 'cell:abcd1234', n_messages: 2 },
    { ...MAIN, id: 'or1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-09-22T10:05:00Z', parent: 'main', status: 'running' },
    { ...MAIN, id: 'dev1', kind: 'agent', role: 'dev', title: 'ticket #1: Group the board by round, newest first', created_at: '2026-09-22T10:20:00Z', parent: 'main', status: 'done', last_ts: '2026-09-22T10:30:00Z' },
    { ...MAIN, id: 'w1', kind: 'agent', role: 'subagent', title: 'write report', created_at: '2026-09-22T10:25:00Z', parent: 'main', status: 'running' },
    { ...MAIN, id: 'v1', kind: 'agent', role: 'dev', view: 'run-clock', title: 'view: Run clock', created_at: '2026-09-22T10:26:00Z', parent: 'main', status: 'failed' },
    { ...MAIN, id: 't2', kind: 'thread', role: 'thread', title: 'the-summary', created_at: '2026-09-22T10:40:00Z', parent: 'or1', anchor: 'chat:or1#3', n_messages: 2 },
  ]
  const shut = page.locator(`#${await page.evaluate(([c, cur]: any) => (window as any).__thimble.mountTree(c, cur, true), [chats, 't1'])}`)
  assert.equal(await shut.locator('.tt-summary .tt-name').innerText(), 'main/why-the-spike', 'collapsed, the card names the current thread in full')
  const root = page.locator(`#${await page.evaluate(([c, cur]: any) => (window as any).__thimble.mountTree(c, cur, false), [chats, 'main'])}`)
  const order = await root.locator('.tt-list > .tt-row[data-thread]').evaluateAll((els: any) => els.map((el: any) => [el.getAttribute('data-thread'), el.querySelector('.tt-name').textContent]))
  assert.deepEqual(order, [['main', 'main'], ['dev1', 'group-the-board-by'], ['t1', 'why-the-spike'], ['or1', 'orient'], ['t2', 'the-summary']], 'main with its ticket and thread, the most recent first, then the orientation with the thread asked from it; another subagent and the failed view build are no threads')
  assert.equal(await root.locator('.tt-row[data-thread="or1"] .tt-end .spinner').count(), 1, 'the running orientation spins')
  const dev = root.locator('.tt-row[data-thread="dev1"]')
  const at = new Date('2026-09-22T10:30:00Z')
  assert.equal(await dev.locator('.tt-meta').first().innerText(), `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, 'the finished ticket with the time it ended')
  await root.locator('.tt-row[data-thread="or1"]').hover()
  await root.locator('.tt-row[data-thread="or1"] .tt-more').click()
  const menu = page.locator('.tt-menu')
  await menu.waitFor({ timeout: 3000 })
  assert.deepEqual(await menu.locator('.menu-item-label').allInnerTexts(), ['Rename', 'Delete…'], 'the orientation renames and deletes as a thread does')
  await page.keyboard.press('Escape')
  await root.locator('.tt-row[data-thread="dev1"] .tt-name').dblclick()
  assert.equal(await root.locator('input.tt-rename').inputValue(), 'group-the-board-by', 'a ticket renames in place from the name its row shows')
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('a long thread tree lists every thread and offers a search field at its foot, filled as the current row is', async () => {
  const chats: any[] = [{ ...MAIN }]
  for (let i = 1; i <= 10; i++) chats.push({ ...MAIN, id: `t${i}`, kind: 'thread', role: 'thread', title: i === 7 ? 'the-march-spike' : `thread-${i}`, created_at: `2026-09-22T10:${String(i).padStart(2, '0')}:00Z`, last_ts: `2026-09-22T10:${String(i).padStart(2, '0')}:00Z`, parent: 'main', anchor: 'card:x', n_messages: 2 })
  const sheet = await page.addStyleTag({ content: appStyles() })
  const root = page.locator(`#${await page.evaluate(([c, cur]: any) => (window as any).__thimble.mountTree(c, cur, false), [chats, 'main'])}`)
  const ids = () => root.locator('.tt-list > .tt-row[data-thread]').evaluateAll((els: any) => els.map((el: any) => el.getAttribute('data-thread')))
  assert.deepEqual(await ids(), ['main', 't10', 't9', 't8', 't7', 't6', 't5', 't4', 't3', 't2', 't1'], 'main, then all its threads, the most recent first')
  const field = root.locator('.tt-filter-input')
  assert.equal(await field.getAttribute('aria-label'), 'Search threads')
  assert.equal(await field.getAttribute('placeholder'), null, 'named for assistive tech alone, no placeholder')
  const fill = await root.locator('.tt-row.current').evaluate((el: any) => getComputedStyle(el).backgroundColor)
  const foot = await root.locator('.tt-filter').evaluate((el: any) => [getComputedStyle(el).backgroundImage, getComputedStyle(el).backgroundColor])
  assert.ok(foot[0].startsWith(`linear-gradient(${fill}, ${fill})`), 'the search field has the current row\'s fill')
  assert.match(foot[1], /^rgb\(/, 'over an opaque paper, so no row shows through it')
  await field.fill('march')
  const found = await root.locator('.tt-list > .tt-row[data-thread]').evaluateAll((els: any) => els.map((el: any) => [el.getAttribute('data-thread'), el.querySelector('.tt-name').textContent]))
  assert.deepEqual(found, [['t7', 'main/the-march-spike']], 'a thread by its full name')
  await field.press('Escape')
  assert.equal(await field.inputValue(), '')
  assert.equal((await ids()).length, 11)
  await sheet.evaluate((el: any) => el.remove())
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('raw calls are chip lines as Claude Code prints them, only an agent is a card, and two messages in a row are two rows', async () => {
  // a raw Read, Grep or Bash is a chip line, not a card as a subagent is, and two messages in a row are two rows, each
  // opening with its dot, so a new message reads apart from a new paragraph
  const log = [
    { type: 'user', ts: '2026-09-22T10:00:00Z', text: 'What is in there?', by: 'terminal' },
    { type: 'text', delta: 'Looking at the files.', by: 'terminal' },
    { type: 'text', delta: 'First the agents.\n\nThen the board.', by: 'terminal' },
    { type: 'tool_use', ts: '2026-09-22T10:00:01Z', id: 'r1', name: 'Read', input: { file_path: '/data/mini/agents/agent-01.jsonl', limit: 20 } },
    { type: 'tool_result', ts: '2026-09-22T10:00:02Z', id: 'r1', summary: '{"role": "user"}' },
    { type: 'tool_use', ts: '2026-09-22T10:00:03Z', id: 'g1', name: 'Grep', input: { pattern: 'refund', path: '/data/mini/agents' } },
    { type: 'tool_result', ts: '2026-09-22T10:00:04Z', id: 'g1', summary: 'No matches found', is_error: true },
    { type: 'tool_use', ts: '2026-09-22T10:00:05Z', id: 'b1', name: 'Bash', input: { command: 'wc -l agents/*.jsonl', description: 'Count lines' } },
  ]
  // the app's own stylesheets for this test, so the spacing and the inks are the ones the chat draws
  const sheet = await page.addStyleTag({ content: appStyles() })
  const root = page.locator(`#${await page.evaluate((l: any) => (window as any).__thimble.mountRows(l, 'mini', true), log)}`)
  await root.evaluate((el: any) => el.classList.add('chat-flow')) // the transcript's own column, as ChatPanel lays the rows out
  // the three calls in a row fold into one tonal chip, which opens on their lines
  const run = root.locator('.chat-calls .chat-callrun')
  assert.equal(await run.count(), 1, 'the three calls in a row are one chip')
  assert.deepEqual(await run.locator('.chat-callrun-name').allInnerTexts(), ['Read', 'Grep', 'Bash'], 'each tool by its name')
  assert.deepEqual(await run.locator('.chat-callrun-n').allInnerTexts(), ['1', '1', '1'], 'with how many calls it made')
  assert.equal(await run.locator('.chat-callrun-head .spinner').count(), 1, 'a call of the run still runs')
  assert.equal(await run.locator('.chat-callrun-failed-text').innerText(), '1 failed', 'the failed call counted in words')
  assert.equal(await root.locator('.chat-call').count(), 0, 'folded, no line shows')
  await run.locator('.chat-callrun-chip').click()
  assert.equal(await run.locator('.chat-callrun-chip').getAttribute('aria-expanded'), 'true')
  const calls = run.locator('.chat-call')
  assert.equal(await calls.count(), 3, 'open, one line per call')
  assert.equal(await root.locator('.toolcard').count(), 0, 'no tool card for a raw call')
  assert.deepEqual(await root.locator('.chat-call-chip').allInnerTexts(), ['Read agents/agent-01.jsonl', 'Grep refund in agents', 'Bash wc -l agents/*.jsonl'])
  assert.equal(await calls.nth(0).locator('.chat-call-state .chat-call-dot').count(), 1, 'a call done: the dot before its tool, as Claude Code prints a tool line')
  assert.equal(await calls.nth(1).locator('.chat-call-state .mark-failed').count(), 1, 'a failed call is marked where the dot stands')
  assert.equal(await calls.nth(2).locator('.chat-call-state .spinner').count(), 1, 'the call still running has the spinner there')
  // a call is a line with no box, where a citation is the accent chip of its target's glyph
  const callBox = await calls.nth(0).locator('.chat-call-chip').evaluate((el: any) => ({ edge: getComputedStyle(el).borderTopWidth, bg: getComputedStyle(el).backgroundColor }))
  assert.deepEqual(callBox, { edge: '0px', bg: 'rgba(0, 0, 0, 0)' }, 'a call line has no edge and no fill')
  const cited = page.locator(`#${await page.evaluate(() => (window as any).__thimble.mountRows([{ type: 'text', delta: 'The first record [[agents/agent-01.jsonl#L3]].', by: 'terminal' }], 'mini'))} .chat-text .refchip`)
  assert.equal(await cited.evaluate((el: any) => getComputedStyle(el).borderTopWidth), '1px', 'a citation is a chip with its edge')
  assert.equal(await cited.locator('svg.icon-file').count(), 1, "a record's citation wears the file's glyph")
  assert.equal(await cited.innerText(), '', 'and no name')
  assert.equal(await cited.getAttribute('aria-label'), 'agent-01.jsonl L3', 'its name, the extension kept, for the hover and assistive tech')
  await calls.nth(0).locator('.chat-call-chip').click()
  assert.equal(await calls.nth(0).getAttribute('class'), 'chat-call open')
  assert.match(await calls.nth(0).locator('.chat-call-body').innerText(), /limit[\s\S]*20[\s\S]*"role": "user"/i, 'open, its other input and what came back')
  assert.equal(await calls.nth(0).locator('.chat-tool-result').evaluate((el: any) => getComputedStyle(el).fontFamily.includes('Geist Mono')), true, 'the output in mono')
  const replies = root.locator('.chat-assistant')
  assert.equal(await replies.count(), 2, 'two messages are two rows')
  assert.equal(await replies.nth(1).locator('p').count(), 2, 'the paragraphs of one message stay in it')
  const gap = await replies.nth(1).evaluate((el: any) => {
    const prev = el.previousElementSibling.getBoundingClientRect()
    const ps = el.querySelectorAll('p')
    return { between: el.getBoundingClientRect().top - prev.bottom, para: ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom, line: parseFloat(getComputedStyle(ps[0]).lineHeight), rule: getComputedStyle(el, '::before').height, dot: getComputedStyle(el, '::after').width }
  })
  assert.ok(Math.abs(gap.para - gap.line) < 1, `paragraphs one line apart: ${gap.para}px, a line ${gap.line}px`)
  assert.ok(gap.between > gap.para, `messages ${gap.between}px apart, paragraphs ${gap.para}px`)
  assert.equal(gap.rule, '1px', 'a hairline between two messages')
  assert.equal(gap.dot, '6px', 'each message opens with the dot')
  assert.equal(await root.locator('.chat-text').first().evaluate((el: any) => getComputedStyle(el).color), 'rgb(0, 0, 0)', 'a reply is in the primary ink, black on Warm')
  await sheet.evaluate((el: any) => el.remove())
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

// Code is coloured wherever it shows, as the file reader colours it
// (components/Code.tsx), and keeps its text exactly.
const CODE = 'import json\nprint(len([1, 2]))'

test('code in the chat takes the syntax colours: a fenced block in a reply, and the code a call ran', async () => {
  const log = [
    { type: 'user', ts: '2026-09-22T10:00:00Z', text: 'Count them', by: 'terminal' },
    { type: 'text', delta: 'Like this:\n\n```python\n' + CODE + '\n```\n' },
    { type: 'tool_use', ts: '2026-09-22T10:00:01Z', id: 'c1', name: 'mcp__thimble__add_cell', input: { kind: 'code', question: 'How many?', code: CODE } },
    { type: 'tool_result', ts: '2026-09-22T10:00:02Z', id: 'c1', summary: 'ok' },
    { type: 'done', ts: '2026-09-22T10:00:03Z', session_id: 'sess' },
  ]
  const root = page.locator(`#${await page.evaluate((l: any) => (window as any).__thimble.mountRows(l, 'mini'), log)}`)
  const fence = root.locator('.chat-text pre code')
  await fence.locator('.tok-keyword').first().waitFor({ timeout: 5000 })
  assert.equal(await fence.innerText(), CODE, 'the fenced block keeps its text')
  assert.ok((await fence.locator('.tok-keyword').allInnerTexts()).includes('import'), 'and colours its keywords')
  assert.deepEqual(await fence.locator('.tok-number').allInnerTexts(), ['1', '2'], 'and its numbers')
  await root.locator('.toolcard-head').click()
  const ran = root.locator('.chat-tool-field-code .chat-tool-pre')
  await ran.locator('.tok-keyword').first().waitFor({ timeout: 5000 })
  assert.equal(await ran.innerText(), CODE, 'the code the call ran keeps its text, coloured as Python')
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test('a field for code: the coloured copy under the field holds the same text, and the field keeps the input', async () => {
  const root = page.locator(`#${await page.evaluate((v: any) => (window as any).__thimble.mountCodeArea(v), CODE)}`)
  const under = root.locator('pre.code-area-under')
  await under.locator('.tok-keyword').first().waitFor({ timeout: 5000 })
  assert.equal(await under.getAttribute('aria-hidden'), 'true', 'the copy is hidden from assistive tech')
  assert.equal((await under.textContent()).replace(/\n$/, ''), CODE, 'the copy holds the text, a last line break aside')
  const field = root.locator('textarea.code-area-field')
  assert.equal(await field.inputValue(), CODE)
  assert.equal(await field.getAttribute('aria-label'), 'Code', 'the field is the one control')
  assert.equal(await under.getAttribute('class'), 'field field-area field-mono field-block code-area-under', "the copy takes the field's classes, so the same rules draw its box")
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})

test("a failed orientation offers Report a problem on its line and its card, with the error written in and its chat", async () => {
  const log = [{ type: 'chip', ts: '2026-09-22T11:00:03Z', kind: 'artifact', text: "the orientation's cards", ref: 'group:deck2', chat: 'orf' }]
  const root = page.locator(`#${await page.evaluate((l: any) => (window as any).__thimble.mountRows(l, 'mini', false, {}), log)}`)
  const landing = root.locator('.chat-landing[data-chat="orf"]')
  await landing.locator('.chat-task[data-status="failed"]').waitFor({ timeout: 5000 })
  assert.equal(await landing.locator('.chat-landing-line').innerText(), 'Orientation failed: Not logged in · Please run /login.Report a problem')
  const onCard = landing.locator('.chat-task').getByRole('button', { name: 'Report a problem' })
  assert.equal(await onCard.count(), 1, 'the failed card offers it among its controls')
  await onCard.click()
  assert.deepEqual(await page.evaluate(() => (window as any).__thimble.reported), { description: 'The orientation failed.\nNot logged in · Please run /login', focus: ['orf'] })
  await page.evaluate(() => { (window as any).__thimble.reported = null })
  await landing.locator('.chat-landing-line').getByRole('button', { name: 'Report a problem' }).click()
  assert.deepEqual(await page.evaluate(() => (window as any).__thimble.reported), { description: 'The orientation failed.\nNot logged in · Please run /login', focus: ['orf'] })
  await page.evaluate(() => (window as any).__thimble.unmountAll())
  assert.deepEqual(pageErrors, [])
})
