// A folded run of calls in a real browser, with thimble's own stylesheets: the chip of a run (src/chat/Rows.tsx CallRun)
// names each tool and its count on one line, and in a chat too narrow for every name, such as a run of Claude Code's own
// tools with long names (live QA 2: a call of a tool thimble does not know is a raw call), the names end in … inside
// the chip and its chevron stays in view, rather than running past the chat's edge.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'call-run-chip',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ThreadView } from '${src('chat/ChatPanel.tsx')}'`,
      `import { foldRecords } from '${src('chat/model.ts')}'`,
      `import type { ChatMeta, ChatRecord } from '${src('lib/types.ts')}'`,
      `import type { ChatState } from '${src('chat/useChat.ts')}'`,
      `const call = (id: string, name: string, input: object): ChatRecord[] => [{ type: 'tool_use', id, name, input }, { type: 'tool_result', id, summary: 'ok' }]`,
      `const records: ChatRecord[] = [`,
      `  { type: 'user', text: 'Check the busiest accounts again.' },`,
      `  ...call('u1', 'Bash', { command: 'wc -l revisions.jsonl' }),`,
      `  ...call('u2', 'TodoWrite', { todos: [] }),`,
      `  ...call('u3', 'CronCreate', { cron: '*/5 * * * *' }),`,
      `  ...call('u4', 'mcp__claude-in-chrome__navigate', { url: 'https://example.org/' }),`,
      `  { type: 'text', delta: 'Done.', reply: true, by: 'terminal' },`,
      `  { type: 'done', result: null },`,
      `]`,
      `const meta: ChatMeta = { id: 't1', kind: 'thread', role: 'thread', title: 'accounts', created_at: '2026-10-10T11:20:00+00:00', parent: 'main', anchor: null, anchor_text: 'Accounts', model: null, effort: null, group: null }`,
      `const chat = (m: ChatMeta, rs: ChatRecord[]): ChatState => ({ meta: m, records: rs, rows: foldRecords(rs), loading: false, error: null, streaming: false, running: false, send: async () => true, interrupt: async () => {}, reload: async () => {} })`,
      `const main = chat({ ...meta, id: 'main', kind: 'main', role: 'main' }, [])`,
      `const view = (id: string, width: number) => <div id={id} className="chat-scroll" style={{ width }}><ThreadView ws="w" meta={meta} chat={chat(meta, records)} main={main} skip={new Set()} branches={[]} detached={false} /></div>`,
      `createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex', gap: 24, padding: 16 }}>{view('narrow', 300)}{view('wide', 640)}</div>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 600 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('#narrow .chat-callrun-chip')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The run chip in `where`: its box, its names' and its chevron's, the chat's, and whether its names are cut. */
const measure = (where: string) =>
  page.evaluate((w) => {
    const box = (e: Element | null) => (e ? (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(e.getBoundingClientRect()) : null)
    const chip = document.querySelector(`${w} .chat-callrun-chip`)!
    const names = chip.querySelector('.chat-callrun-tools') as HTMLElement
    return { chat: box(document.querySelector(w)), chip: box(chip), names: box(names), caret: box(chip.querySelector('.chat-callchip-caret')), cut: names.scrollWidth > names.clientWidth, text: names.textContent }
  }, where)

/** How many pixels between the end of the names' box and the chevron differ from the chip's fill: the ink of names
 * drawn past their box, toward and over the chevron. */
async function inkBeforeCaret(m: Awaited<ReturnType<typeof measure>>): Promise<number> {
  const x = Math.ceil(m.names!.right) + 1
  const png = await page.screenshot({ clip: { x, y: m.chip!.top + 2, width: Math.max(1, Math.floor(m.caret!.left) - x), height: m.chip!.bottom - m.chip!.top - 4 } })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 40) n++
    return n
  }, png.toString('base64'))
}

test("a run chip's names end in … inside the chip in a narrow chat, its chevron clear of them, and show whole in a wide one", async () => {
  const narrow = await measure('#narrow')
  assert.equal(narrow.text, 'Bash1·TodoWrite1·CronCreate1·navigate1', 'the chip names the four tools')
  assert.ok(narrow.chip!.right <= narrow.chat!.right + 0.5, `the chip ends inside the chat ${JSON.stringify(narrow)}`)
  assert.ok(narrow.caret!.right <= narrow.chip!.right + 0.5 && narrow.names!.right <= narrow.caret!.left, `the chevron is in the chip, after the names ${JSON.stringify(narrow)}`)
  assert.ok(narrow.cut, 'the names are cut where they do not fit')
  assert.equal(await inkBeforeCaret(narrow), 0, 'nothing of the names is drawn past their box, over the chevron')
  const wide = await measure('#wide')
  assert.ok(!wide.cut && wide.caret!.right <= wide.chip!.right + 0.5, `a wide chat shows every name ${JSON.stringify(wide)}`)
})
