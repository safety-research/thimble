// A fix of the person's thimble in a real browser, with thimble's own stylesheets and the real chat column
// (src/chat/ChatPanel.tsx): the fixer is main's subagent, which runs in the background in a thread of its own that the
// tree lists by the fix's name; main's chat shows the person's message as they typed it, then the fixer's card by the
// fix's name, with a link to its thread and its steps folded in it. Before, main showed a chip named by the fork's
// description (`fix 3: 2 can you…`, the `N <words>` form read as the words of a new fix), and no message. The page's
// every request is answered here.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script = ''
let css = ''

const T = '2026-10-23T21:00:00+00:00'
const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: '2026-10-23T20:50:00+00:00', parent: null, status: 'idle' }
const steps = [
  { type: 'user', ts: T, text: 'can you create a video report type for me?', by: 'browser' },
  { type: 'tool_use', ts: T, id: 's1', name: 'Read', input: { file_path: '/home/someone/.thimble/fixes/work/3/CLAUDE.md' } },
  { type: 'tool_result', ts: T, id: 's1', summary: 'ok' },
  { type: 'tool_use', ts: T, id: 's2', name: 'Bash', input: { command: 'ls browser/backend/app', description: 'Look at the repository layout' } },
  { type: 'tool_result', ts: T, id: 's2', summary: 'ok' },
]
const earlier = [
  { type: 'user', ts: '2026-10-23T20:55:00+00:00', text: 'Which week had the most incidents?', by: 'browser' },
  { type: 'text', ts: '2026-10-23T20:55:05+00:00', delta: 'Week 2 had the most incidents.', by: 'terminal' },
  { type: 'done', ts: '2026-10-23T20:55:06+00:00' },
]
/** What the server gave the page: before, the fixer as main's subagent; now, the fix's own chat. */
const PAGES = {
  before: {
    chats: [main, { id: 'f3', kind: 'agent', role: 'subagent', title: 'fix 3: 2 can you create a video report type for me?', created_at: T, parent: 'main', status: 'running' }],
    main: [...earlier, { type: 'agent', ts: T, chat: 'f3', role: 'subagent', title: 'fix 3: 2 can you create a video report type for me?', by: 'terminal' }],
    fixer: steps.slice(1),
  },
  after: {
    chats: [main, { id: 'f2', kind: 'agent', role: 'fixer', title: 'changing Video report type', created_at: T, parent: 'main', status: 'running', fix: 2 }],
    main: [...earlier,
      { type: 'user', ts: T, text: '/thimble-fix 2 can you create a video report type for me?', by: 'browser' },
      { type: 'agent', ts: T, chat: 'f2', role: 'fixer', title: 'changing Video report type', by: 'browser' }],
    fixer: steps,
  },
}
const FIXES = { problem: '', fixes: [{ id: 2, title: 'Video report type', state: 'working', phase: 'fixing', kind: null, said: null, words: 'can you create a video report type for me?', change: true, tests: null, error: null, created: Date.now() / 1000 - 40, at: 1 }] }

/** The requests the chat column reads as lists. */
const LISTS = /\/(proposals|notices|labels|label-asks|asks|tickets|comments)$/

async function open(which: keyof typeof PAGES): Promise<Page> {
  const data = PAGES[which]
  const page = await browser.newPage({ viewport: { width: 560, height: 640 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/chats') return json(data.chats)
    if (p === '/api/ws/w/chats/main') return json({ meta: main, events: data.main })
    const chat = /^\/api\/ws\/w\/chats\/(\w+)$/.exec(p)
    if (chat) return json({ meta: data.chats.find((m) => m.id === chat[1]) ?? main, events: data.fixer })
    if (p === '/api/fixes') return json(which === 'after' ? FIXES : { problem: '', fixes: [] })
    if (LISTS.test(p)) return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.chat-flow .chat-agent', { timeout: 8000 }).catch(async (e) => {
    throw new Error(`${e}\n${errors.join('\n')}\n${(await page.evaluate(() => document.body.innerHTML)).slice(0, 3000)}`)
  })
  await page.waitForTimeout(300)
  return page
}

beforeAll(async () => {
  script = await bundle(
    'fix-tray',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ChatPanel } from '${src('chat/ChatPanel.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<div style={{ width: 560, height: '100vh', display: 'flex', flexDirection: 'column' }}><ChatPanel ws="w" /></div>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test("the fix is a thread of its own in the tree, by its name; main's chat shows the message as typed and the fixer's card, its steps folded", async () => {
  const shots = process.env.THIMBLE_FIX_SHOT
  for (const which of ['before', 'after'] as const) {
    const page = await open(which)
    if (shots) {
      // the tree open, then main's chat as it shows (a picture for a reader, not compared)
      await page.locator('.chat-tree').first().click({ position: { x: 20, y: 12 } }).catch(() => undefined)
      await page.waitForTimeout(200)
      writeFileSync(path.resolve(shots, `${which}.png`), await page.screenshot())
    }
    const got = await page.evaluate(() => ({
      tree: [...document.querySelectorAll('.chat-tree [data-id], .chat-tree [data-thread]')].map((e) => e.textContent?.trim()),
      users: [...document.querySelectorAll('.chat-flow .chat-user')].map((e) => e.textContent?.trim()),
      agentChips: document.querySelectorAll('.chat-flow .chat-agent').length,
      name: document.querySelector('.chat-flow .chat-agent[data-role="fixer"] .chat-agent-name')?.textContent?.trim() ?? null,
      thread: document.querySelector('.chat-flow .chat-agent[data-role="fixer"] .chat-thread-chip')?.getAttribute('data-thread') ?? null,
      text: document.querySelector('.chat-flow')?.textContent ?? '',
    }))
    if (which === 'after') {
      assert.ok(got.users.some((u) => u?.includes('/thimble-fix 2 can you create a video report type for me?')), JSON.stringify(got.users))
      assert.equal(got.agentChips, 1, "the fixer's card in main")
      assert.equal(got.name, 'changing Video report type')
      assert.equal(got.thread, 'f2')
      assert.ok(!got.text.includes('CLAUDE.md') && !got.text.includes('Look at the repository layout'), "the fixer's steps folded in its card")
    } else {
      assert.equal(got.agentChips, 1, 'before: the fixer was a chip in main')
    }
    await page.close()
  }
})
