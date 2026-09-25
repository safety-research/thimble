// The top bar's Report a problem dialog (src/shell/ProblemReport.tsx under TopBar.tsx) in a real browser: the whole top
// bar mounted against routed API answers, with the toasts, the tab's problem log (lib/problemLog) and a failure's
// ReportProblemButton beside it. The bug button sits after Redo and opens the form; Prepare bundle posts what the
// analyst chose, with the tab's picture when the browser gives one (getDisplayMedia is stubbed: refused, then a
// canvas's stream, one frame taken while the dialog is hidden); the dialog then shows where the zip is, Copy path and
// Show in folder when the server can, the maintainer's handle as a link and Open a GitHub issue, which opens the
// prefilled new-issue link in a new tab (window.open is stubbed to record it); Done leaves a fresh form; and a toast
// that names a failure opens the same dialog with what failed written in. What the dialog sends and shows for a failure's own button, and the sentence's links,
// are tests/public/problem-report.test.tsx under jsdom.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { LOGS_NOTE } from '../../../src/shell/ProblemReport.tsx'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, context: any, page: any
const pageErrors: any[] = []
const posted: any[] = []
let answer: any = null

const PATH = '/home/tester/Downloads/thimble-feedback-20260925-021500.zip'
const INSTRUCTIONS = 'Attach the zip to a GitHub issue only if you are happy to share it publicly; otherwise reach @maintainer on GitHub for private logs.'
const ISSUE_URL = 'https://github.com/example/thimble/issues/new?title=The%20chart%20is%20blank.&body=The%20chart%20is%20blank.%0A%0A-%20thimble%3A%20release%201.0'
const REPORT = (over: object = {}): any => ({
  path: PATH,
  name: 'thimble-feedback-20260925-021500.zip',
  bytes: 188_416,
  size: '184 KB',
  files: ['contents.txt', 'description.txt', 'versions.txt', 'doctor.txt'],
  can_reveal: false,
  contact: '@maintainer',
  contact_url: 'https://github.com/maintainer',
  instructions: INSTRUCTIONS,
  issue_url: ISSUE_URL,
  ...over,
})

beforeAll(async () => {
  // the top bar, for the page
  script = await bundle('problem-report', [
      `import { createRoot } from 'react-dom/client'`,
      `import { TopBar } from '${src('shell/TopBar.tsx')}'`,
      `import { Toasts } from '${src('shell/Toasts.tsx')}'`,
      `import { ReportProblemButton } from '${src('shell/ProblemReport.tsx')}'`,
      `import { installProblemLog } from '${src('lib/problemLog.ts')}'`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `installProblemLog()`,
      `window.__bus = bus`,
      `const el = document.createElement('div')`,
      `el.style.cssText = 'position:absolute;left:0;top:0;width:1280px'`,
      `document.body.appendChild(el)`,
      `createRoot(el).render(<><TopBar ws="mini" tabs={[{ value: 'files', label: 'Files', state: 'focus' }, { value: 'canvas', label: 'Canvas', state: 'hidden' }]} onTab={() => {}} onTabDrag={() => {}} /><div className="failure" style={{ position: 'absolute', top: 400, left: 40 }}>Orientation failed: Claude Code exited 1. <ReportProblemButton description={'The orientation failed.\\nClaude Code exited 1'} focus={['orient1']} /></div><Toasts /></>)`,
  ])
  browser = await launch()
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // localhost, as the app is served, so the page is a secure context with the clipboard and screen capture
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5999' })
  page = await context.newPage()
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://localhost:5999/**', (route: any) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (body: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (req.method() === 'POST' && (url.pathname === '/api/ws/mini/feedback' || url.pathname === '/api/feedback/reveal')) {
      posted.push({ path: url.pathname, body: JSON.parse(req.postData()) })
      if (url.pathname === '/api/feedback/reveal') return json({ ok: true })
      return answer.status === 201 ? json(answer.body, 201) : json({ detail: answer.detail }, answer.status)
    }
    if (url.pathname === '/api/corpora') return json([{ name: 'mini', path: '/home/tester/mini' }])
    if (url.pathname === '/api/ws/mini/undo') return json({ undo: null, redo: null })
    if (url.pathname.startsWith('/api/')) return json({ detail: 'no' }, 404)
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://localhost:5999/?ws=mini')
  await addStyles(page, ['tokens', 'base', 'components', 'shell'])
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.shell-tools')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const bug = () => page.locator('.shell-tools').getByRole('button', { name: 'Report a problem', exact: true })
const dialog = () => page.locator('.problem-pop')
const open = async () => {
  await bug().click()
  await page.waitForSelector('.problem-pop .problem[data-state="form"]')
}

test('the bug button sits after Redo in the top bar, is named in the tooltip, and opens the form', async () => {
  const names = await page.locator('.shell-tools button').evaluateAll((bs: any) => bs.map((b: any) => b.getAttribute('aria-label')))
  assert.deepEqual(names.slice(0, 3), ['Undo', 'Redo', 'Report a problem'], 'no layout menu before Undo')
  assert.equal(names.includes('Feedback'), false, 'the eyedropper is gone')
  await bug().hover()
  await page.waitForSelector('[role="tooltip"]', { timeout: 2000 })
  assert.equal((await page.locator('[role="tooltip"]').textContent()).trim(), 'Report a problem')
  await open()
  assert.equal(await dialog().getByLabel('What went wrong?').count(), 1)
  const shot = dialog().getByRole('checkbox', { name: 'Include a screenshot of this tab' })
  const logs = dialog().getByRole('checkbox', { name: 'Include logs' })
  assert.equal(await shot.isChecked(), false)
  assert.equal(await logs.isChecked(), true, 'the logs are on by default')
  assert.equal((await dialog().locator('.problem-note').textContent()).trim(), LOGS_NOTE)
  assert.equal(await dialog().locator('textarea').getAttribute('placeholder'), null, 'no placeholder')
  const [b, d] = await Promise.all([bug().boundingBox(), dialog().boundingBox()])
  assert.ok(d.y >= b.y + b.height, 'the dialog hangs under the top bar')
  assert.ok(d.x + d.width <= 1280, 'inside the window')
})

test('a refused screenshot is said once the bundle is ready; the bundle\'s path, Download, Copy path, the handle and Open a GitHub issue show', async () => {
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError'))
    ;(window as any).__opened = []
    window.open = ((...args: unknown[]) => ((window as any).__opened.push(args), null)) as typeof window.open
  })
  posted.length = 0
  answer = { status: 201, body: { ...REPORT(), screenshot_missing: true } }
  await dialog().getByLabel('What went wrong?').fill('The chart is blank.')
  await dialog().getByRole('checkbox', { name: 'Include a screenshot of this tab' }).check()
  await dialog().getByRole('button', { name: 'Prepare bundle', exact: true }).click()
  await page.waitForSelector('.problem-pop .problem[data-state="done"]')
  assert.equal(posted.length, 1)
  const body = posted[0].body
  assert.deepEqual({ ...body, user_agent: typeof body.user_agent }, { description: 'The chart is blank.', screenshot: null, screenshot_asked: true, logs: true, user_agent: 'string', browser: [], focus: [] })
  assert.match(body.user_agent, /Chrom/)
  assert.equal((await dialog().locator('.problem-ready').textContent()).trim(), '✓Bundle ready, 184 KB')
  assert.equal((await dialog().locator('.problem-path').textContent()).trim(), PATH)
  assert.equal((await dialog().locator('.problem-note').textContent()).trim(), 'The screenshot was not captured, so the bundle has none.')
  assert.equal(await dialog().getByRole('button', { name: 'Download' }).count(), 1, 'the zip through the browser')
  assert.equal(await dialog().getByRole('button', { name: 'Show in folder' }).count(), 0, 'no Show in folder where the server cannot')
  assert.equal((await dialog().locator('.problem-send').textContent()).trim(), INSTRUCTIONS)
  const links = await dialog().locator('.problem-send a').evaluateAll((as: any) => as.map((a: any) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]))
  assert.deepEqual(links, [['@maintainer', 'https://github.com/maintainer', '_blank']])
  const foot = await dialog().locator('.problem-foot button').evaluateAll((bs: any) => bs.map((b: any) => [b.textContent, b.className.includes('btn-primary')]))
  assert.deepEqual(foot, [['Done', false], ['Open a GitHub issue', true]])
  const [issue, pop] = await Promise.all([dialog().getByRole('button', { name: 'Open a GitHub issue' }).boundingBox(), dialog().boundingBox()])
  assert.ok(issue.x + issue.width <= pop.x + pop.width, 'the button fits the dialog')
  await dialog().getByRole('button', { name: 'Open a GitHub issue' }).click()
  assert.deepEqual(await page.evaluate(() => (window as any).__opened), [[ISSUE_URL, '_blank', 'noopener,noreferrer']])
  assert.equal(await dialog().locator('.problem[data-state="done"]').count(), 1, 'the dialog stays open, with the zip')
  await dialog().getByRole('button', { name: 'Copy path' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.problem-actions button')].some((b: any) => b.textContent === 'Copied'))
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), PATH)
  assert.equal(await dialog().getByRole('status').count(), 1)
})

test('Done closes the dialog, and it opens again on a fresh form', async () => {
  await dialog().getByRole('button', { name: 'Done', exact: true }).click()
  await page.waitForTimeout(100)
  assert.equal(await dialog().count(), 0)
  await open()
  assert.equal(await dialog().getByLabel('What went wrong?').inputValue(), '')
  assert.equal(await dialog().getByRole('checkbox', { name: 'Include a screenshot of this tab' }).isChecked(), false)
})

test('an allowed capture sends one frame of the tab, taken while the dialog is hidden; logs off; Show in folder asks the server', async () => {
  await page.evaluate(() => {
    (window as any).__hiddenDuringCapture = null
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 40
      const g = c.getContext('2d')!
      const stream = c.captureStream(30)
      const paint = () => {
        g.fillStyle = '#5135ff'
        g.fillRect(0, 0, 64, 40)
      }
      paint()
      const t = setInterval(paint, 20)
      stream.getTracks()[0].addEventListener('ended', () => clearInterval(t))
      setTimeout(() => {
        const pop = (document.querySelector('.problem-pop') as any)
        ;(window as any).__hiddenDuringCapture = !!pop && getComputedStyle(pop).opacity === '0'
      }, 150)
      return stream
    }
  })
  posted.length = 0
  answer = { status: 201, body: REPORT({ can_reveal: true }) }
  await dialog().getByLabel('What went wrong?').fill('Blank again')
  await dialog().getByRole('checkbox', { name: 'Include a screenshot of this tab' }).check()
  await dialog().getByRole('checkbox', { name: 'Include logs' }).uncheck()
  await dialog().getByRole('button', { name: 'Prepare bundle', exact: true }).click()
  await page.waitForSelector('.problem-pop .problem[data-state="done"]')
  const body = posted[0].body
  assert.equal(body.logs, false)
  assert.deepEqual(body.browser, [], "without the logs the tab's errors stay out too")
  assert.match(body.screenshot, /^data:image\/png;base64,iVBOR/)
  assert.equal(await page.evaluate(() => (window as any).__hiddenDuringCapture), true, 'the dialog is hidden while the frame is taken')
  assert.equal(await page.evaluate(() => getComputedStyle((document.querySelector('.problem-pop') as any)).opacity), '1', 'and shows again after')
  await dialog().getByRole('button', { name: 'Show in folder' }).click()
  await page.waitForTimeout(150)
  assert.deepEqual(posted.slice(1), [{ path: '/api/feedback/reveal', body: { path: PATH } }])
  await dialog().getByRole('button', { name: 'Done', exact: true }).click()
})

test('a toast that names a failure offers Report a problem, which opens the dialog with it written in', async () => {
  await page.evaluate(() => (window as any).__bus.emit('toast', { text: 'The report was not written.', kind: 'error', report: { description: 'The writer of report failed.\nexit 1', focus: ['writer1'] } }))
  const toast = page.locator('.shell-toast', { hasText: 'The report was not written.' })
  await toast.waitFor()
  await toast.getByRole('button', { name: 'Report a problem' }).click()
  await page.waitForSelector('.problem-pop .problem[data-state="form"]')
  assert.equal(await dialog().getByLabel('What went wrong?').inputValue(), 'The writer of report failed.\nexit 1')
  assert.equal(await toast.count(), 1, 'the button does not dismiss the toast')
  posted.length = 0
  answer = { status: 201, body: REPORT() }
  await dialog().getByRole('button', { name: 'Prepare bundle', exact: true }).click()
  await page.waitForSelector('.problem-pop .problem[data-state="done"]')
  assert.deepEqual(posted[0].body.focus, ['writer1'])
  await dialog().getByRole('button', { name: 'Done', exact: true }).click()
  assert.deepEqual(pageErrors, [])
})
