// Every icon-only control is named in the one tooltip (components/Tooltip.tsx), never the browser's own title: a
// TipButton (an icon <button> drawn with its own class), a Tipped box (around a control that takes no handlers of its
// own) and the report's IconButton show their tip on hover after its delay and on keyboard focus, and it goes with the
// pointer or Escape. The source rule that no icon button carries a native title is in tests/public/design.test.ts.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, src } from './page.ts'

let browser: Browser
let page: Page
const pageErrors: string[] = []

beforeAll(async () => {
  const script = await bundle('tooltips', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { TipButton, Tipped } from '${src('components/Tooltip.tsx')}'`,
    `import { IconButton } from '${src('report/icons.tsx')}'`,
    `const el = document.createElement('div'); document.body.appendChild(el)`,
    `flushSync(() => createRoot(el).render(<div style={{ padding: 40, display: 'flex', gap: 40 }}>`,
    `  <TipButton tip="Close" className="t-close" aria-label="Close notes.md">×</TipButton>`,
    `  <Tipped text="Details"><button type="button" className="t-box" aria-label="Details">!</button></Tipped>`,
    `  <IconButton label="Hide sidebar" className="t-side">▯</IconButton>`,
    `</div>))`,
  ])
  browser = await launch()
  page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The tip's text once the pointer rests on `sel`; then the pointer leaves and the tip must be gone. */
async function tipOnHover(sel: string): Promise<string> {
  await page.mouse.move(1, 1)
  await page.waitForTimeout(600) // past the warm window, so each tip waits its delay afresh
  await page.hover(sel)
  const tip = page.locator('.tip[role=tooltip]')
  await tip.waitFor({ timeout: 2000 })
  const text = await tip.innerText()
  await page.mouse.move(1, 1)
  assert.equal(await page.locator('.tip').count(), 0, 'the tip goes with the pointer')
  return text
}

test('a TipButton, a Tipped box and the report IconButton each name their control in the one tooltip, with no native title', async () => {
  assert.equal(await tipOnHover('.t-close'), 'Close')
  assert.equal(await page.getAttribute('.t-close', 'aria-label'), 'Close notes.md', 'its own aria-label stays')
  assert.equal(await tipOnHover('.t-box'), 'Details')
  assert.equal(await tipOnHover('.t-side'), 'Hide sidebar')
  assert.equal(await page.getAttribute('.t-side', 'aria-label'), 'Hide sidebar', 'the label names it to a screen reader too')
  assert.ok(await page.locator('.t-side').evaluate((b) => b.classList.contains('wu-iconbtn')), 'it keeps the report icon button look')
  for (const sel of ['.t-close', '.t-box', '.t-side']) assert.equal(await page.getAttribute(sel, 'title'), null, `${sel}: no native title`)
  assert.deepEqual(pageErrors, [])
})

test('keyboard focus on the control inside a Tipped box shows its tip, and Escape hides it', async () => {
  await page.mouse.move(1, 1)
  await page.focus('.t-close')
  await page.keyboard.press('Tab')
  const tip = page.locator('.tip[role=tooltip]')
  await tip.waitFor({ timeout: 2000 })
  assert.equal(await tip.innerText(), 'Details')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.tip').count(), 0)
})
