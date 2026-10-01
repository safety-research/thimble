#!/usr/bin/env node
// The UI half of the release's end-to-end test (scripts/e2e_release.sh runs it in the throwaway environment, with the
// server and the stand-in session already up). It walks the UI in headless Chromium at 1440x900, takes a screenshot of
// each step once Hanken Grotesk has loaded, runs the extension commands between UI checks, and appends one JSON line per
// step to $THIMBLE_E2E_RESULTS: {step, title, status, detail, shots, pending?}.
//   status: pass | fail | skip. A step with `pending` waits for work that is not merged yet; report.py reports its failure
//   as expected.
// Environment: THIMBLE_E2E_CLONE (the installed tree), THIMBLE_E2E_CORPUS (the corpus copy), THIMBLE_E2E_WS (what
// workspace.py printed), THIMBLE_E2E_SHOTS, THIMBLE_E2E_RESULTS, THIMBLE_E2E_FIXTURE (the fixture extension's folder).
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, relative } from 'node:path'

const env = process.env
const CLONE = env.THIMBLE_E2E_CLONE
const CORPUS = env.THIMBLE_E2E_CORPUS
const WS = JSON.parse(env.THIMBLE_E2E_WS || '{}')
const SHOTS = env.THIMBLE_E2E_SHOTS
const RESULTS = env.THIMBLE_E2E_RESULTS
const FIXTURE = env.THIMBLE_E2E_FIXTURE
const OUT = join(SHOTS, '..')
const require = createRequire(join(CLONE, 'frontend', 'package.json'))
const { chromium } = require('playwright')

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]
const EXT = 'e2e-fixture'
const EXT_REPORT = 'E2E note'
const VIEW = { slug: 'record-counts', name: 'Record counts' }
const ACTION_MS = 10_000
const STEP_MS = 120_000
// steps that wait for work not merged yet, and what they wait for
const PENDING = {
  welcome: 'the first-launch welcome',
  tour: 'the product tour',
  'transcript-anywhere': 'transcripts for any transcript-like file',
  pdf: 'PDF as a File browser mode',
  'views-bar': 'worked examples and the PDF viewer kept out of the views',
  'view-contract': 'the view contract (residue list, derived count, labels)',
  'local-views': 'generated views as the workspace\'s local extension',
  'ext-cli-off': 'thimble extension on/off',
  'ext-cli-on': 'thimble extension on/off',
  'ext-orient-offer': 'the offer to run an extension\'s orientation instructions',
}

let shotN = 0
const fontMisses = []
const fontFailures = []

function record(step, title, status, detail, shots = []) {
  const line = { step, title, status, detail, shots }
  if (PENDING[step]) line.pending = PENDING[step]
  appendFileSync(RESULTS, JSON.stringify(line) + '\n')
  console.log(`${step}: ${status}${detail ? ` (${detail})` : ''}`)
}

class StepError extends Error {
  constructor(message, shots = []) {
    super(message)
    this.shots = shots
  }
}

/** Run one step: its function returns {detail, shots} or throws; a step never stops the walk. */
async function step(name, title, fn) {
  let timer
  try {
    const res = await Promise.race([
      fn(),
      new Promise((_, rej) => (timer = setTimeout(() => rej(new StepError(`no result in ${STEP_MS / 1000} s`)), STEP_MS))),
    ])
    record(name, title, res?.skip ? 'skip' : 'pass', res?.detail ?? '', res?.shots ?? [])
    return true
  } catch (e) {
    const msg = String(e?.message || e).split('\n')[0]
    record(name, title, 'fail', msg, e?.shots ?? [])
    return false
  } finally {
    clearTimeout(timer)
  }
}

function check(ok, message) {
  if (!ok) throw new StepError(message)
}

/** A screenshot of the viewport once the fonts are ready; a shot taken without Hanken Grotesk is listed for the fonts
 * step. Returns its path relative to the report. */
async function shot(page, name) {
  const fonts = await page
    .evaluate(async () => {
      await document.fonts.ready
      return document.fonts.check('16px "Hanken Grotesk"')
    })
    .catch(() => false)
  if (!fonts) fontMisses.push(name)
  const file = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  return relative(OUT, file)
}

/** Run `thimble <args>` in the corpus copy: {status, out}. */
function thimble(...args) {
  const r = spawnSync('thimble', args, { cwd: CORPUS, env, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}

async function settle(page, ms = 400) {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
  await page.waitForTimeout(ms)
}

async function sessionGone(page) {
  return (await page.getByText('No Claude Code session connected').count()) > 0
}

async function openSettings(page) {
  if (!(await page.locator('.settings-pop').count())) await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('.settings-pop').waitFor({ timeout: ACTION_MS })
  await page.locator('.settings-loading').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
  return page.locator('.settings-pop')
}

async function closeSettings(page) {
  if (await page.locator('.settings-pop').count()) {
    const cancel = page.locator('.settings-pop').getByRole('button', { name: 'Cancel', exact: true })
    if (await cancel.count()) await cancel.click()
    else await page.keyboard.press('Escape')
    await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
  }
}

async function showFiles(page) {
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.getByRole('radio', { name: 'File browser', exact: true }).first().click()
  await page.locator('[role=tree]').first().waitFor({ timeout: ACTION_MS })
}

/** Open a corpus file in the File browser, expanding its folders. */
async function openFile(page, path) {
  await showFiles(page)
  const parts = path.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = page.locator('[role=tree] .files-dir', { has: page.locator('.files-name', { hasText: new RegExp(`^${esc(parts[i])}$`) }) }).first()
    await dir.waitFor({ timeout: ACTION_MS })
    if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click()
  }
  const row = page.locator(`[role=tree] [data-anchor="${path}"]`)
  await row.waitFor({ timeout: ACTION_MS })
  await row.click()
  await settle(page)
}

async function modes(page) {
  return page.locator('[role=radiogroup][aria-label="Mode"] [role=radio]').allInnerTexts()
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The entries of Report's + New menu, the menu closed again. */
async function newMenu(page) {
  await page.getByRole('tab', { name: 'Report', exact: true }).click()
  const btn = page.getByRole('button', { name: 'New', exact: true }).first()
  await btn.waitFor({ timeout: ACTION_MS })
  await btn.click()
  const menu = page.getByRole('menu').last()
  await menu.waitFor({ timeout: ACTION_MS })
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim().split('\n')[0])
  return { items, close: () => page.keyboard.press('Escape') }
}

/** The fixture extension's row in Settings > Extensions: {present, on, active}. */
async function extRow(page) {
  const pop = await openSettings(page)
  const row = pop.locator(`[data-extension="${EXT}"]`)
  if (!(await row.count())) return { present: false }
  const sw = row.locator('[role=switch]').first()
  const on = (await sw.getAttribute('aria-checked')) === 'true'
  return { present: true, on, active: (await row.getAttribute('data-active')) === 'true', row, sw }
}

/** Whether the UI shows the fixture extension as `want` (on or off) in Settings and in + New, within `ms`, reloading
 * the page once when the live page has not followed. Returns what it saw. */
async function followsExtension(page, want, ms = 15_000) {
  const seen = async () => {
    const r = await extRow(page)
    await closeSettings(page)
    const m = await newMenu(page)
    await m.close()
    const listed = m.items.includes(EXT_REPORT)
    return { row: r.present, on: r.present && r.on, listed }
  }
  const ok = (s) => (want ? s.row && s.on && s.listed : !s.listed && (!s.row || !s.on))
  const until = Date.now() + ms
  let s = await seen()
  while (!ok(s) && Date.now() < until) {
    await page.waitForTimeout(1_000)
    s = await seen()
  }
  if (ok(s)) return { ok: true, how: 'live', s }
  await page.reload()
  await waitShell(page)
  s = await seen()
  return { ok: ok(s), how: 'after a reload', s }
}

async function waitShell(page) {
  await page.getByRole('tab', { name: 'Files', exact: true }).waitFor({ timeout: 30_000 })
  await settle(page, 800)
}

/** Measured layout at each size: no sideways scroll, and each selector's box inside the viewport. */
async function measure(page, selectors) {
  const lines = []
  let bad = []
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.waitForTimeout(400)
    const m = await page.evaluate((sels) => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const doc = document.scrollingElement || document.documentElement
      const out = { sideways: doc.scrollWidth > vw, boxes: {} }
      for (const s of sels) {
        const el = document.querySelector(s)
        if (!el) {
          out.boxes[s] = null
          continue
        }
        const r = el.getBoundingClientRect()
        out.boxes[s] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5 && r.width > 0 && r.height > 0 }
      }
      return out
    }, selectors)
    const tag = `${size.width}x${size.height}`
    if (m.sideways) bad.push(`${tag}: the page scrolls sideways`)
    for (const [s, b] of Object.entries(m.boxes)) {
      if (!b) bad.push(`${tag}: ${s} not found`)
      else if (!b.inside) bad.push(`${tag}: ${s} at ${b.x},${b.y} ${b.w}x${b.h} leaves the viewport`)
    }
    lines.push(`${tag}: ${Object.values(m.boxes).filter((b) => b?.inside).length}/${selectors.length} inside`)
  }
  await page.setViewportSize(SIZES[0])
  await page.waitForTimeout(300)
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : lines.join(', ') }
}

function corpusFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) corpusFiles(p, base, out)
    else out.push(relative(base, p))
  }
  return out
}

/** The tour's visible step: its text and buttons, or null when no tour shows. */
async function tourState(page) {
  return page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const buttons = [...document.querySelectorAll('button')].filter(vis)
    const names = buttons.map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
    const next = names.find((n) => /^(next|continue|got it)\b/i.test(n))
    const done = names.find((n) => /^(done|finish|end tour|start exploring|close tour|let'?s go)\b/i.test(n))
    if (!next && !done) return null
    const box = buttons[names.indexOf(next || done)].closest('[role=dialog], [class*=tour], [data-tour]') || document.body
    return { next: next || null, done: done || null, text: (box.innerText || '').trim().slice(0, 160) }
  })
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: SIZES[0] })
  const page = await context.newPage()
  page.setDefaultTimeout(ACTION_MS)
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  page.on('response', (r) => {
    if (/\.woff2?(\?|$)/.test(r.url()) && r.status() !== 200 && r.status() !== 304) fontFailures.push(`${r.status()} ${r.url()}`)
  })
  const files = corpusFiles(CORPUS)

  try {
    await step('first-load', 'The UI opens on the workspace', async () => {
      check(WS.url, 'workspace.py printed no URL')
      await page.goto(WS.url)
      await waitShell(page)
      await page.waitForTimeout(2_000)
      const s = await shot(page, 'first-load')
      check(!(await sessionGone(page)), 'the page shows "No Claude Code session connected"')
      check((await page.getByRole('tab', { name: 'Report', exact: true }).count()) > 0, 'no Report tab')
      return { detail: `${WS.name} at ${WS.url.split('#')[0]}`, shots: [s] }
    })

    await step('welcome', 'The first-launch welcome asks about the tour, and Skip goes straight to the workbench', async () => {
      const ask = page.getByText(/would you like a product tour/i).first()
      const shown = await ask.waitFor({ timeout: 5_000 }).then(() => true, () => false)
      const shots = [await shot(page, 'welcome')]
      if (!shown) throw new StepError('no welcome asking "Would you like a product tour?" on the first launch', shots)
      const skip = page.getByRole('button', { name: /^(skip|no thanks|not now)/i }).first()
      await skip.click()
      await ask.waitFor({ state: 'detached', timeout: ACTION_MS })
      shots.push(await shot(page, 'welcome-skipped'))
      await page.reload()
      await waitShell(page)
      await page.waitForTimeout(1_500)
      check(!(await page.getByText(/would you like a product tour/i).count()), 'the welcome shows again after a reload')
      return { detail: 'skipped, and not shown again after a reload', shots }
    })

    await step('tour', 'Settings > Take the tour walks every step to its end', async () => {
      const pop = await openSettings(page)
      const take = pop.getByRole('button', { name: /take the tour/i }).first()
      if (!(await take.count())) {
        const s = await shot(page, 'tour-missing')
        await closeSettings(page)
        throw new StepError('no "Take the tour" in Settings', [s])
      }
      await take.click()
      await page.waitForTimeout(1_000)
      const shots = []
      const texts = []
      let stuck = 0
      for (let i = 0; i < 30; i++) {
        const st = await tourState(page)
        if (!st) break
        if (texts.at(-1) !== st.text) {
          shots.push(await shot(page, `tour-${String(texts.length + 1).padStart(2, '0')}`))
          texts.push(st.text)
          stuck = 0
        }
        const target = st.next || st.done
        const btn = page.getByRole('button', { name: target, exact: true }).last()
        if (await btn.isEnabled().catch(() => false)) {
          await btn.click()
        } else {
          // a gated step: Start, or a ⌘-click anywhere, unlocks its Next
          const start = page.getByRole('button', { name: /^start$/i }).last()
          if (await start.isVisible().catch(() => false)) await start.click().catch(() => undefined)
          else {
            await page.keyboard.down('Meta')
            await page.mouse.click(SIZES[0].width / 2, SIZES[0].height / 2)
            await page.keyboard.up('Meta')
          }
          if (++stuck > 4) throw new StepError(`stuck at step ${texts.length}: "${st.text}"`, shots)
        }
        await page.waitForTimeout(700)
        if (st.done && !st.next) {
          if (!(await tourState(page))) break
        }
      }
      check(!(await tourState(page)), `the tour did not end after ${texts.length} steps`)
      check(texts.length >= 3, `only ${texts.length} tour steps showed`)
      return { detail: `${texts.length} steps, ended`, shots }
    })

    await step('file-browser', 'The File browser lists the corpus and opens a file', async () => {
      await closeSettings(page)
      await showFiles(page)
      const rows = await page.locator('[role=tree] [role=treeitem]').count()
      check(rows > 0, 'the tree shows no rows')
      const md = files.find((f) => /^readme\.md$/i.test(f)) || files.find((f) => f.endsWith('.md')) || files[0]
      await openFile(page, md)
      const tab = page.getByRole('tab', { name: basename(md), exact: true })
      check((await tab.count()) > 0, `no tab for ${md} after opening it`)
      const s = await shot(page, 'file-browser')
      return { detail: `${rows} rows in the tree; opened ${md}`, shots: [s] }
    })

    await step('transcript', 'A transcript file opens in Transcript mode', async () => {
      const jsonl = files.find((f) => /agent-01\.jsonl$/.test(f)) || files.find((f) => f.endsWith('.jsonl'))
      check(jsonl, 'the corpus has no .jsonl file')
      await openFile(page, jsonl)
      const m = await modes(page)
      check(m.includes('Transcript'), `${jsonl} offers ${m.join(', ') || 'no modes'}, not Transcript`)
      const t = page.locator('[role=radiogroup][aria-label="Mode"] [role=radio]', { hasText: /^Transcript$/ })
      if ((await t.getAttribute('aria-checked')) !== 'true') await t.click()
      await settle(page)
      const s = await shot(page, 'transcript')
      check((await t.getAttribute('aria-checked')) === 'true', 'Transcript is not the active mode')
      return { detail: `${jsonl}: modes ${m.join(', ')}`, shots: [s] }
    })

    await step('transcript-anywhere', 'Chat logs outside runs/ (Markdown, CSV) are offered as transcripts', async () => {
      const shots = []
      const got = []
      for (const f of ['chatlogs/support-chat.md', 'exports/chat-export.csv']) {
        if (!existsSync(join(CORPUS, f))) throw new StepError(`${f} is missing from the corpus copy`)
        await openFile(page, f)
        const m = await modes(page)
        shots.push(await shot(page, `transcript-${basename(f).replace(/\W+/g, '-')}`))
        got.push(`${f}: ${m.join(', ') || 'no modes'}`)
      }
      const missing = got.filter((g) => !/Transcript/.test(g))
      if (missing.length) throw new StepError(`no Transcript mode for ${missing.join('; ')}`, shots)
      return { detail: got.join('; '), shots }
    })

    await step('pdf', 'A PDF shows as the PDF itself in the File browser', async () => {
      const f = 'docs/e2e-sample.pdf'
      await openFile(page, f)
      await page.waitForTimeout(1_500)
      const sel = 'embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"], embed[src*=".pdf"], object[data*=".pdf"], .pdfViewer, canvas[data-page-number], [data-pdf]'
      let found = 0
      for (const fr of page.frames()) found += await fr.locator(sel).count().catch(() => 0)
      const m = await modes(page)
      const s = await shot(page, 'pdf')
      if (!found) throw new StepError(`${f} shows no PDF element (modes: ${m.join(', ') || 'none'})`, [s])
      return { detail: `${found} PDF element(s); modes ${m.join(', ') || 'none'}`, shots: [s] }
    })

    await step('views-bar', 'The views bar holds only the File browser and the workspace\'s own views', async () => {
      await showFiles(page)
      const bar = (await page.locator('[data-anchor^="view:"]').allInnerTexts()).map((t) => t.trim())
      const s = await shot(page, 'views-bar')
      const others = bar.filter((t) => t && t !== VIEW.name)
      if (others.length) throw new StepError(`views that are not the workspace's: ${others.join(', ')}`, [s])
      return { detail: `views: ${bar.join(', ') || 'none'}`, shots: [s] }
    })

    await step('view', 'The fixture view opens and draws a row per file it reads', async () => {
      check(WS.view?.ok, `the fixture view was not saved: ${WS.view?.error || 'unknown'}`)
      await page.getByRole('tab', { name: 'Files', exact: true }).click()
      const tab = page.locator(`[data-anchor="view:${VIEW.slug}"]`).first()
      await tab.waitFor({ timeout: ACTION_MS })
      await tab.click()
      const want = files.filter((f) => f.endsWith('.jsonl')).length
      let rows = 0
      const until = Date.now() + 30_000
      while (Date.now() < until) {
        rows = 0
        for (const fr of page.frames()) if (fr !== page.mainFrame()) rows += await fr.locator('tr[data-anchor]').count().catch(() => 0)
        if (rows >= want) break
        await page.waitForTimeout(500)
      }
      const s = await shot(page, 'view')
      if (rows !== want) throw new StepError(`the view drew ${rows} rows for ${want} JSONL files`, [s])
      return { detail: `${rows} rows, one per JSONL file`, shots: [s] }
    })

    await step('view-contract', 'The view lists what it could not read, counts its derived fields, and shows labels', async () => {
      const pane = page.locator('.view-pane').first()
      await pane.waitFor({ timeout: ACTION_MS })
      const head = pane.locator('.view-pane-head').first()
      let headText = await head.innerText().catch(() => '')
      const shots = []
      const problems = []
      if (!headText.includes('broken.jsonl')) {
        for (const b of await head.locator('button[aria-expanded]').all()) {
          const t = (await b.innerText()).trim()
          if (!/not|could|unread|missing|problem|skipped|residue/i.test(t)) continue
          await b.click()
          await page.waitForTimeout(400)
          const listed = await page.locator('.view-pane-list').allInnerTexts()
          shots.push(await shot(page, 'view-residue'))
          await page.keyboard.press('Escape')
          if (listed.some((x) => x.includes('broken.jsonl'))) headText += ' broken.jsonl'
        }
      }
      if (!headText.includes('broken.jsonl')) problems.push('exports/broken.jsonl, whose lines are not all JSON, is not listed')
      if (!/\b\d+\s+derived\b/i.test(headText)) problems.push('no count of derived fields in the header')
      let marks = 0
      for (const fr of page.frames()) if (fr !== page.mainFrame()) marks += await fr.locator('[data-derived]').count().catch(() => 0)
      if (marks) problems.push(`${marks} derived marks on the view's cells`)
      if (!/label/i.test(await pane.innerText())) problems.push('no labels in the view\'s UI')
      shots.unshift(await shot(page, 'view-contract'))
      if (problems.length) throw new StepError(problems.join('; '), shots)
      return { detail: 'residue listed, derived fields counted, labels shown', shots }
    })

    await step('settings-extensions', 'Settings > Extensions lists the extensions, and the popover fits on screen', async () => {
      const pop = await openSettings(page)
      const group = pop.getByRole('group', { name: 'Extensions' })
      await group.waitFor({ timeout: ACTION_MS })
      const names = await pop.locator('[data-extension]').evaluateAll((els) => els.map((e) => e.getAttribute('data-extension')))
      const s = await shot(page, 'settings-extensions')
      check(names.includes('video'), `video is not listed (${names.join(', ')})`)
      const fit = await measure(page, ['.settings-pop', '.settings-pop .settings-foot'])
      check(fit.ok, fit.detail)
      await closeSettings(page)
      return { detail: `${names.join(', ')}; ${fit.detail}`, shots: [s] }
    })

    await step('local-views', 'The fixture view is the workspace\'s local extension in Settings > Extensions', async () => {
      const dir = join(CLONE, 'workspaces', WS.name, 'extension', 'views', VIEW.slug)
      const onDisk = existsSync(join(dir, 'view.json'))
      const pop = await openSettings(page)
      const text = await pop.innerText()
      const s = await shot(page, 'local-views')
      await closeSettings(page)
      const problems = []
      if (!onDisk) problems.push(`no workspaces/${WS.name}/extension/views/${VIEW.slug}/view.json`)
      if (!text.includes(VIEW.name)) problems.push(`Settings > Extensions does not list "${VIEW.name}"`)
      if (problems.length) throw new StepError(problems.join('; '), [s])
      return { detail: 'on disk and listed', shots: [s] }
    })

    await step('layout', 'The File browser fits at 1440x900 and 1920x1080 (measured)', async () => {
      await showFiles(page)
      const fit = await measure(page, ['[role=tablist]', '[role=tree]', '[aria-label="Settings"]'])
      check(fit.ok, fit.detail)
      return { detail: fit.detail }
    })

    let added = false
    await step('ext-add', '`thimble extension add` adds the fixture extension, on, and the UI shows it', async () => {
      const r = thimble('extension', 'add', FIXTURE, '--yes')
      check(r.status === 0, `exit ${r.status}: ${r.out.slice(0, 300)}`)
      const l = thimble('extension', 'list')
      check(l.out.includes(EXT), `thimble extension list does not name ${EXT}: ${l.out.slice(0, 300)}`)
      added = true
      const f = await followsExtension(page, true)
      const shots = []
      await extRow(page)
      shots.push(await shot(page, 'ext-added-settings'))
      await closeSettings(page)
      const m = await newMenu(page)
      shots.push(await shot(page, 'ext-added-new-menu'))
      await m.close()
      if (!f.ok) throw new StepError(`the UI did not follow: ${JSON.stringify(f.s)}`, shots)
      return { detail: `added; Settings switch on and "${EXT_REPORT}" in + New (${f.how})`, shots }
    })

    const cli = (verb) => {
      const words = verb === 'off' ? ['off', 'disable'] : ['on', 'enable']
      let last
      for (const w of words) {
        last = thimble('extension', w, EXT)
        if (last.status === 0) return { word: w, ...last }
      }
      return { word: words.join('/'), ...last }
    }

    await step('ext-cli-off', '`thimble extension off` switches it off, and the UI follows', async () => {
      check(added, 'the extension was not added')
      const r = cli('off')
      check(r.status === 0, `thimble extension ${r.word} ${EXT}: exit ${r.status}: ${r.out.slice(0, 200)}`)
      const f = await followsExtension(page, false)
      const s = await shot(page, 'ext-cli-off')
      if (!f.ok) throw new StepError(`the UI did not follow: ${JSON.stringify(f.s)}`, [s])
      return { detail: `thimble extension ${r.word}: off in Settings, gone from + New (${f.how})`, shots: [s] }
    })

    await step('ext-cli-on', '`thimble extension on` switches it back on, and the UI follows', async () => {
      check(added, 'the extension was not added')
      const r = cli('on')
      check(r.status === 0, `thimble extension ${r.word} ${EXT}: exit ${r.status}: ${r.out.slice(0, 200)}`)
      const f = await followsExtension(page, true)
      const s = await shot(page, 'ext-cli-on')
      if (!f.ok) throw new StepError(`the UI did not follow: ${JSON.stringify(f.s)}`, [s])
      return { detail: `thimble extension ${r.word}: on in Settings, back in + New (${f.how})`, shots: [s] }
    })

    await step('ext-ui-off', 'Its switch in Settings turns it off for the workspace, and + New follows', async () => {
      check(added, 'the extension was not added')
      const r = await extRow(page)
      check(r.present, 'no row for the extension in Settings')
      if (r.on) await r.sw.click()
      await page.locator('.settings-pop').getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
      const f = await followsExtension(page, false)
      const s = await shot(page, 'ext-ui-off')
      if (!f.ok) throw new StepError(`the UI did not follow: ${JSON.stringify(f.s)}`, [s])
      return { detail: `off in Settings, gone from + New (${f.how})`, shots: [s] }
    })

    let offered = null
    await step('ext-ui-on', 'Its switch turns it back on, and + New follows', async () => {
      check(added, 'the extension was not added')
      const r = await extRow(page)
      check(r.present, 'no row for the extension in Settings')
      if (!r.on) await r.sw.click()
      await page.locator('.settings-pop').getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
      offered = await page
        .getByText(/orientation/i)
        .filter({ hasText: /\b(run|rerun|start)\b/i })
        .first()
        .waitFor({ timeout: 5_000 })
        .then(() => true, () => false)
      const s0 = await shot(page, 'ext-ui-on-offer')
      const f = await followsExtension(page, true)
      const s = await shot(page, 'ext-ui-on')
      if (!f.ok) throw new StepError(`the UI did not follow: ${JSON.stringify(f.s)}`, [s0, s])
      return { detail: `on in Settings, back in + New (${f.how})`, shots: [s0, s] }
    })

    await step('ext-orient-offer', 'Switching on an extension with orientation instructions offers to run them', async () => {
      check(offered !== null, 'the extension was not switched on from Settings')
      check(offered, 'no offer to run its orientation instructions after it was switched on')
      return { detail: 'offered' }
    })

    await step('fonts', 'Every screenshot rendered in Hanken Grotesk', async () => {
      check(fontFailures.length === 0, `font requests failed: ${fontFailures.slice(0, 3).join(', ')}`)
      check(fontMisses.length === 0, `Hanken Grotesk not loaded for: ${fontMisses.join(', ')}`)
      return { detail: `${shotN} screenshots, fonts loaded in each` }
    })

    await step('console', 'No uncaught error in the page', async () => {
      const real = consoleErrors.filter((e) => !/Failed to load resource/.test(e))
      check(real.length === 0, `${real.length} errors, first: ${real[0]?.slice(0, 200)}`)
      return { detail: `${consoleErrors.length} console errors, none uncaught` }
    })
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  record('ui', 'The UI walk ran to its end', 'fail', String(e?.message || e).split('\n')[0])
  process.exit(1)
})
