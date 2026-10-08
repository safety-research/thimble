// Hand back to main in a real browser, with thimble's own stylesheets: the real thread view (src/chat/ChatPanel.tsx
// ThreadView) of a side thread whose run ended with an answer shows `Hand back to main` under the answer, and one whose
// fork still runs shows none. A press posts the hand-back (backend threads.hand_back, which sends main the thread's
// question and answer as the analyst's message), and the line then says it was handed back, with no button. What the
// line says in each state is tests/public/hand-back.test.tsx.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const posted: string[] = []

beforeAll(async () => {
  const script = await bundle(
    'hand-back',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ThreadView } from '${src('chat/ChatPanel.tsx')}'`,
      `import { foldRecords } from '${src('chat/model.ts')}'`,
      `import type { ChatMeta, ChatRecord } from '${src('lib/types.ts')}'`,
      `import type { ChatState } from '${src('chat/useChat.ts')}'`,
      `const answered: ChatRecord[] = [`,
      `  { type: 'user', text: 'Why is Agent 3 so high?' },`,
      `  { type: 'text', delta: 'Agent 3 ran [[31|card:abc123#runs/agent-3]] of the [[40|card:abc123#runs/all]] runs, most of them retries after a timeout.', reply: true, by: 'terminal' },`,
      `  { type: 'done', result: null },`,
      `]`,
      `const working: ChatRecord[] = [{ type: 'user', text: 'And Agent 4?' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'wc -l runs.jsonl' } }]`,
      `const meta = (id: string, hand: ChatMeta['hand_back']): ChatMeta => ({ id, kind: 'thread', role: 'thread', title: 'runs-per-agent', created_at: '2026-10-07T10:00:00+00:00', parent: 'main', anchor: null, anchor_text: 'Runs per agent', model: null, effort: null, group: null, hand_back: hand })`,
      `const chat = (m: ChatMeta, records: ChatRecord[], running: boolean): ChatState => ({ meta: m, records, rows: foldRecords(records), loading: false, error: null, streaming: false, running, send: async () => true, interrupt: async () => {}, reload: async () => {} })`,
      `const main = chat(meta('main', ''), [], false)`,
      `function View({ id, hand, records, running }: { id: string; hand: ChatMeta['hand_back']; records: ChatRecord[]; running: boolean }) {`,
      `  const m = meta(id, hand)`,
      `  return <ThreadView ws="w" meta={m} chat={chat(m, records, running)} main={main} skip={new Set()} branches={[]} detached={false} />`,
      `}`,
      `createRoot(document.getElementById('root')!).render(`,
      `  <div style={{ display: 'flex', gap: 24, padding: 16 }}>`,
      `    <div id="finished" className="chat-scroll" style={{ width: 460 }}><View id="t1" hand="offer" records={answered} running={false} /></div>`,
      // a fork still at work: no hand-back, whatever an older read of its meta said
      `    <div id="running" className="chat-scroll" style={{ width: 460 }}><View id="t2" hand="offer" records={working} running /></div>`,
      `  </div>,`,
      `)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (req.method() === 'POST' && p.startsWith('/api/') && !p.endsWith('/telemetry')) {
      posted.push(p)
      return json({ thread: 't1', event: 'e1', text: 'From thread "Why is Agent 3 so high?": Agent 3 ran …', hand_back: 'handed' })
    }
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('#finished .chat-hand-back')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const buttons = (where: string) => page.evaluate((w) => [...document.querySelectorAll(`${w} button`)].map((b) => b.textContent?.trim() ?? ''), where)

test('a finished thread offers Hand back to main and a running one does not; a press posts the hand-back once, then says it was handed back', async () => {
  assert.ok((await buttons('#finished')).includes('Hand back to main'), 'the finished thread offers it')
  assert.ok(!(await buttons('#running')).includes('Hand back to main'), 'the running thread does not')
  assert.equal(await page.locator('#running .chat-hand-back').count(), 0)
  const shown = await page.evaluate(() => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('#finished button')].find((x) => x.textContent?.trim() === 'Hand back to main')!
    const r = b.getBoundingClientRect()
    return { w: r.width, h: r.height, visible: getComputedStyle(b).visibility !== 'hidden' && getComputedStyle(b).display !== 'none' }
  })
  assert.ok(shown.visible && shown.w > 40 && shown.h > 10, `the button is drawn ${JSON.stringify(shown)}`)
  await page.locator('#finished button', { hasText: 'Hand back to main' }).click()
  await page.waitForSelector('#finished .chat-hand-back[data-state="handed"]')
  assert.deepEqual(posted, ['/api/ws/w/chats/t1/hand-back'])
  assert.ok(!(await buttons('#finished')).includes('Hand back to main'), 'not offered again for that answer')
  assert.match(await page.locator('#finished .chat-hand-back').innerText(), /Handed back to main/)
})
