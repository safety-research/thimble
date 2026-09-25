// The page with no Claude Code session attached (src/shell/SessionGone.tsx) in a real browser, laid out by the app's
// stylesheets: a stand-in dashboard wired to the hook as the shell is, main's meta answered by the check. With no
// session the dashboard is greyed out, still there to read, and takes no click or focus; the card sits in the middle of
// the window, whole at the reference frame and at a phone's width, with Copy focused; when a session attaches the card
// goes and the dashboard answers again. What the card says and when it shows is tests/public/session-gone.test.tsx.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { bundle, cleanup, launch, open, src, type Opened } from './page.ts'

let browser: any
let script: string
let main: any = { attached: null, ended: { session: 's1', cwd: '/home/tester/harbor', at: '2026-09-25T11:00:00Z' } }

beforeAll(async () => {
  script = await bundle('session-gone', [
    `import { createRoot } from 'react-dom/client'`,
    `import { SessionGone, useSessionGone } from '${src('shell/SessionGone.tsx')}'`,
    `import { bus } from '${src('lib/bus.ts')}'`,
    `window.__bus = bus`,
    `window.__clicks = 0`,
    `function Page() {`,
    `  const gone = useSessionGone('harbor')`,
    `  return (`,
    `    <div className="shell" data-session={gone ? 'gone' : undefined} inert={!!gone}>`,
    `      <p className="dash-text">Seven agents stalled on the March 3 burst.</p>`,
    `      <button className="dash-button" onClick={() => { window.__clicks += 1 }}>Open card</button>`,
    `      {gone && <SessionGone gone={gone} />}`,
    `    </div>`,
    `  )`,
    `}`,
    `const el = document.createElement('div')`,
    `el.style.cssText = 'height:100vh'`,
    `document.body.appendChild(el)`,
    `createRoot(el).render(<Page />)`,
  ])
  browser = await launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const api = (_req: any, url: URL) => {
  if (url.pathname === '/api/ws/harbor/chats') return { json: [{ id: 'main', kind: 'main', ...main }] }
  if (url.pathname === '/api/corpora') return { json: [{ name: 'harbor', path: '/home/tester/harbor' }] }
  return undefined
}

async function page(width: number, height: number): Promise<Opened> {
  const o = await open(browser, { script, styles: ['tokens', 'base', 'components', 'shell'], ws: 'harbor', api, context: { viewport: { width, height } } })
  await o.page.waitForSelector('.shell-gone', { timeout: 5000 })
  return o
}

test('no session: the dashboard greyed out and inert under the card in the middle of the window', async () => {
  main = { attached: null, ended: { session: 's1', cwd: '/home/tester/harbor', at: '2026-09-25T11:00:00Z' } }
  const o = await page(1280, 800)
  const { page: p } = o
  const look = await p.evaluate(() => ({
    filter: getComputedStyle(document.querySelector('.shell')!).filter,
    scrim: getComputedStyle(document.querySelector('.shell-gone')!).backgroundColor,
  }))
  assert.equal(look.filter, 'grayscale(1)')
  assert.notEqual(look.scrim, 'rgba(0, 0, 0, 0)', 'a scrim covers the window')
  assert.ok(await p.locator('.dash-text').isVisible(), 'the dashboard stays on screen to read')
  const card = await p.locator('.shell-gone-card').boundingBox()
  assert.ok(card, 'the card is laid out')
  assert.ok(Math.abs(card.x + card.width / 2 - 640) <= 1 && Math.abs(card.y + card.height / 2 - 400) <= 1, `the card is centred (${JSON.stringify(card)})`)
  assert.equal(await p.locator('.shell-gone-title').innerText(), 'Claude Code session disconnected')
  assert.equal(await p.locator('.shell-gone-command code').innerText(), 'cd ~/harbor && thimble --continue')
  assert.equal(await p.evaluate(() => document.activeElement?.textContent), 'Copy', 'Copy has the focus')
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.shell-gone-card')!).backgroundColor.startsWith('rgba')), false, 'the card is opaque')
  // a click where the dashboard's button is lands on the card's layer, and the inert button takes neither click nor focus
  await p.mouse.click(40, 60)
  await p.evaluate(() => (document.querySelector('.dash-button') as HTMLButtonElement).focus())
  assert.equal(await p.evaluate(() => (window as any).__clicks), 0, 'the dashboard takes no click')
  assert.notEqual(await p.evaluate(() => document.activeElement?.className), 'dash-button', 'nor the focus')
  // a session attaches: the card goes and the dashboard answers again
  main = { attached: { session: 's1', cwd: '/home/tester/harbor', since: '2026-09-25T11:01:00Z' }, ended: null }
  await p.evaluate(() => (window as any).__bus.emit('chat', { chat: 'main' }))
  await p.waitForSelector('.shell-gone', { state: 'detached', timeout: 3000 })
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.shell')!).filter), 'none')
  await p.locator('.dash-button').click()
  assert.equal(await p.evaluate(() => (window as any).__clicks), 1)
  assert.deepEqual(o.errors, [])
  await o.close()
})

test('at a phone\'s width the card fits inside the window with a 16px gutter', async () => {
  main = { attached: null, ended: { session: 's1', cwd: '/home/tester/data/demo/a folder with a long name/harbor', at: '' } }
  const o = await page(390, 760)
  const card = await o.page.locator('.shell-gone-card').boundingBox()
  assert.ok(card && card.x >= 16 && card.x + card.width <= 390 - 16 + 0.5, `inside the gutter (${JSON.stringify(card)})`)
  assert.equal(await o.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll')
  const code = await o.page.locator('.shell-gone-command code').boundingBox()
  assert.ok(code && code.x + code.width <= card!.x + card!.width, 'the command wraps inside the card')
  assert.deepEqual(o.errors, [])
  await o.close()
})
