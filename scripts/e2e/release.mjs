#!/usr/bin/env node
// The UI half of the release's end-to-end test (scripts/e2e_release.sh runs it in the throwaway environment, with the
// server and the stand-in session already up). It walks the UI in headless Chromium at 1440x900, takes a screenshot of
// each step once Hanken Grotesk has loaded, runs the extension commands between UI checks, and appends one JSON line per
// step to $THIMBLE_E2E_RESULTS: {step, title, status, detail, shots, pending?}.
//   status: pass | fail | skip. A step with `pending` waits for work that is not merged yet; report.py reports its failure
//   as expected.
// Environment: THIMBLE_E2E_TREE (the tree thimble runs from), THIMBLE_E2E_CORPUS (the corpus copy), THIMBLE_E2E_WS (what
// workspace.py printed), THIMBLE_E2E_SHOTS, THIMBLE_E2E_RESULTS, THIMBLE_E2E_FIXTURE (the fixture extension's folder).
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'

const env = process.env
const TREE = env.THIMBLE_E2E_TREE
const CORPUS = env.THIMBLE_E2E_CORPUS
const WS = JSON.parse(env.THIMBLE_E2E_WS || '{}')
const SHOTS = env.THIMBLE_E2E_SHOTS
const RESULTS = env.THIMBLE_E2E_RESULTS
const FIXTURE = env.THIMBLE_E2E_FIXTURE
const OUT = join(SHOTS, '..')
const require = createRequire(join(TREE, 'frontend', 'package.json'))
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
  'local-views': 'generated views as the workspace\'s local extension',
  'ext-cli-off': 'thimble extension on/off',
  'ext-cli-on': 'thimble extension on/off',
  'ext-orient-offer': 'the offer to run an extension\'s orientation instructions',
  'ext-live': '+ New refreshing its report types when an extension is switched (it loads them once per page)',
  'view-derived': 'the view contract (derived fields as a count in the header)',
  'view-labels': 'the view contract (labels in every view\'s UI)',
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

/** End a tour or welcome a failed step left open, which would freeze the page under every later step. */
async function dismissTour(page) {
  for (let i = 0; i < 3; i++) {
    const st = await tourState(page).catch(() => null)
    if (!st) return
    const act = ['skip', 'done', 'back'].find((a) => st.acts.includes(a))
    if (act === 'back' || !act) await page.keyboard.press('Escape')
    else await page.locator(`.tour-pop [data-tour="${act}"]`).first().click({ timeout: 3_000 }).catch(() => undefined)
    await page.waitForTimeout(500)
  }
}

let currentPage = null

/** Run one step: its function returns {detail, shots} or throws; a step never stops the walk. */
async function step(name, title, fn) {
  let timer
  if (currentPage && name !== 'welcome' && name !== 'tour') await dismissTour(currentPage)
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
  await page.waitForTimeout(300)
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

// each switch of the fixture extension, and the parts of the UI that showed it only after a reload
const lagged = []

/** Whether the UI shows the fixture extension as `want` (on or off) in Settings and in + New: within `ms` on the live
 * page, else after one reload, which is noted in `lagged` for the ext-live step. */
async function followsExtension(page, want, what, ms = 10_000) {
  const seen = async () => {
    const r = await extRow(page)
    await closeSettings(page)
    const m = await newMenu(page)
    await m.close()
    return { settings: r.present && r.on === want, menu: m.items.includes(EXT_REPORT) === want }
  }
  const until = Date.now() + ms
  let s = await seen()
  while (!(s.settings && s.menu) && Date.now() < until) {
    await page.waitForTimeout(1_000)
    s = await seen()
  }
  if (s.settings && s.menu) return { ok: true, how: 'live' }
  const stale = [!s.settings && 'Settings', !s.menu && '+ New'].filter(Boolean)
  await page.reload()
  await waitShell(page)
  s = await seen()
  const ok = s.settings && s.menu
  if (ok) lagged.push(`${what}: ${stale.join(' and ')}`)
  const still = [!s.settings && 'Settings', !s.menu && '+ New'].filter(Boolean)
  return { ok, how: ok ? `${stale.join(' and ')} only after a reload` : `${still.join(' and ')} still wrong after a reload` }
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

/** The tour's popover: its title and count, the actions it offers (data-tour: next, back, skip, done, begin) and its
 * first cutout; null when no tour shows. */
async function tourState(page) {
  return page.evaluate(() => {
    const pop = document.querySelector('.tour-pop, [role=dialog][aria-label*="tour" i]')
    if (!pop || !pop.getClientRects().length) return null
    const acts = [...pop.querySelectorAll('button')].map((b) => b.dataset.tour || (b.innerText || '').trim().toLowerCase())
    const title = (pop.querySelector('.tour-title')?.textContent || '').trim()
    const count = (pop.querySelector('.tour-count')?.textContent || '').trim()
    const hole = [...document.querySelectorAll('.tour-root mask rect')].find((r) => r.getAttribute('fill') === '#000')
    const b = hole?.getBoundingClientRect()
    return { acts, title, count, text: (pop.innerText || '').trim().slice(0, 160), welcome: pop.classList.contains('tour-welcome'),
             hole: b && b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null }
  })
}

/** Unlock a gated step: press a Start inside the tour's example, else ⌘-click (Ctrl-click off macOS) the step's cutout. */
async function unlockStep(page, st) {
  const start = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tour-ex button, .tour-root button')].find((x) => x.textContent?.trim() === 'Start')
    const r = b?.getBoundingClientRect()
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })
  if (start) {
    await page.mouse.click(start.x, start.y)
    return 'Start'
  }
  const at = st.hole || { x: SIZES[0].width / 2, y: SIZES[0].height / 2 }
  await page.mouse.move(at.x - 10, at.y)
  await page.keyboard.down('ControlOrMeta')
  await page.mouse.move(at.x, at.y, { steps: 3 })
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(250)
  await page.keyboard.up('ControlOrMeta')
  return '⌘-click'
}

async function main() {
  // the full Chromium shows a PDF in a page when headless; the headless shell install.sh fetches does not
  let browser = await chromium.launch({ channel: 'chromium' }).catch(() => null)
  const browserName = browser ? `Chromium ${browser.version()}` : 'the headless shell'
  if (!browser) browser = await chromium.launch()
  const context = await browser.newContext({ viewport: SIZES[0] })
  const page = await context.newPage()
  currentPage = page
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
      return { detail: `${WS.name} at ${WS.url.split('#')[0]}, in ${browserName}`, shots: [s] }
    })

    await step('welcome', 'The first-launch welcome asks about the tour, and Skip goes straight to the workbench', async () => {
      const ask = page.getByText(/would you like a product tour/i).first()
      const shown = await ask.waitFor({ timeout: 8_000 }).then(() => true, () => false)
      const shots = [await shot(page, 'welcome')]
      if (!shown) throw new StepError('no welcome asking "Would you like a product tour?" on the first launch', shots)
      const own = page.locator('.tour-pop [data-tour="skip"]')
      const skip = (await own.count()) ? own.first() : page.getByRole('dialog').getByRole('button', { name: /^(skip|no thanks|not now)/i }).first()
      const label = (await skip.innerText()).trim()
      await skip.click()
      await ask.waitFor({ state: 'detached', timeout: ACTION_MS })
      shots.push(await shot(page, 'welcome-skipped'))
      await page.reload()
      await waitShell(page)
      await page.waitForTimeout(2_000)
      check(!(await page.getByText(/would you like a product tour/i).count()), 'the welcome shows again after a reload')
      return { detail: `"${label}", and not shown again after a reload`, shots }
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
      await page.waitForTimeout(1_200)
      let st = await tourState(page)
      if (st?.welcome) {
        await page.locator('.tour-pop [data-tour="begin"]').click()
        await page.waitForTimeout(800)
      }
      const shots = []
      const seen = []
      const unlocked = []
      let stuck = 0
      for (let i = 0; i < 60; i++) {
        st = await tourState(page)
        if (!st) break
        const key = `${st.count} ${st.title}`
        if (seen.at(-1) !== key) {
          seen.push(key)
          shots.push(await shot(page, `tour-${String(seen.length).padStart(2, '0')}`))
          stuck = 0
        }
        const act = st.acts.includes('next') ? 'next' : st.acts.includes('done') ? 'done' : null
        if (act) {
          const own = page.locator(`.tour-pop [data-tour="${act}"]`)
          await ((await own.count()) ? own.first() : page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${act}$`, 'i') }).first()).click()
          if (act === 'done') {
            await page.waitForTimeout(800)
            break
          }
        } else {
          if (++stuck > 4) throw new StepError(`stuck at step ${st.count} "${st.title}": no Next after ${unlocked.at(-1) || 'waiting'}`, shots)
          unlocked.push(`${st.count}: ${await unlockStep(page, st)}`)
        }
        await page.waitForTimeout(800)
      }
      check(!(await tourState(page)), `the tour still shows after ${seen.length} steps`)
      check(seen.length >= 3, `only ${seen.length} tour steps showed`)
      const total = seen.at(-1)?.match(/of (\d+)/)?.[1]
      return { detail: `${seen.length} steps${total ? ` of ${total}` : ''}, Done ends it${unlocked.length ? `; unlocked ${unlocked.join(', ')}` : ''}`, shots }
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

    await step('labels', 'A regex label is listed in Files and marks the records it matched in the transcript', async () => {
      check(WS.label?.ok, `the label was not applied: ${WS.label?.error || 'unknown'}`)
      const jsonl = files.find((f) => /agent-01\.jsonl$/.test(f)) || files.find((f) => f.endsWith('.jsonl'))
      await openFile(page, jsonl)
      const listed = await page.getByText(WS.label.name, { exact: true }).count()
      let marks = 0
      const until = Date.now() + 15_000
      while (Date.now() < until) {
        marks = await page.locator('.reader-gutter-cell.is-lit, .reader-span[data-concept]').count()
        if (marks) break
        await page.waitForTimeout(500)
      }
      const s = await shot(page, 'labels')
      if (!listed) throw new StepError(`"${WS.label.name}" is not listed in Files`, [s])
      if (!marks) throw new StepError(`no label marks on the records of ${jsonl}`, [s])
      return { detail: `"${WS.label.name}" listed, ${marks} marks in ${jsonl}; counts ${JSON.stringify(WS.label.counts ?? {})}`, shots: [s] }
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
      await page.waitForTimeout(2_500)
      const sel = 'iframe[src*="pdf"], embed[type="application/pdf"], object[type="application/pdf"], embed[src*=".pdf"], object[data*=".pdf"]'
      let src = null
      for (const fr of page.frames()) {
        const el = fr.locator(sel).first()
        if (await el.count().catch(() => 0)) {
          src = (await el.getAttribute('src')) || (await el.getAttribute('data'))
          break
        }
      }
      const inPage = await page.evaluate(() => navigator.pdfViewerEnabled !== false)
      const m = await modes(page)
      const s = await shot(page, 'pdf')
      if (!src) {
        const open = page.getByRole('button', { name: /open the pdf/i })
        if (inPage || !(await open.count())) throw new StepError(`${f} shows no PDF (modes: ${m.join(', ') || 'none'})`, [s])
        const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: ACTION_MS }), open.click()])
        src = popup.url()
        await popup.close()
      }
      const url = new URL(src, page.url()).href.split('#')[0]
      const r = await page.request.get(url)
      const type = r.headers()['content-type'] || ''
      const body = await r.body()
      check(r.status() === 200 && /application\/pdf/.test(type) && body.subarray(0, 5).toString() === '%PDF-', `${url} answers ${r.status()} ${type}`)
      return { detail: `${inPage ? 'shown in the page' : 'this browser shows no PDF in a page, so the step checks the file\'s route'}: ${new URL(url).pathname} answers application/pdf; modes ${m.join(', ') || 'none'}`, shots: [s] }
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

    await step('view-residue', 'The view lists the file it could not read in full', async () => {
      const head = page.locator('.view-pane .view-pane-head').first()
      await head.waitFor({ timeout: ACTION_MS })
      const shots = []
      let listed = (await page.locator('.view-pane').first().innerText()).includes('broken.jsonl')
      let control = ''
      if (!listed) {
        for (const b of await head.locator('button[aria-expanded]').all()) {
          const t = (await b.innerText()).trim()
          if (!/not|could|unread|missing|problem|skipped|residue/i.test(t)) continue
          control = t
          await b.click()
          await page.waitForTimeout(400)
          const lists = [await page.locator('.view-pane').first().innerText(), ...(await page.locator('.view-pane-list').allInnerTexts())]
          listed = lists.some((x) => x.includes('broken.jsonl'))
          shots.push(await shot(page, 'view-residue'))
          if (await page.locator('.view-pane-list').count()) await page.keyboard.press('Escape')
          else await b.click()
          if (listed) break
        }
      }
      if (!listed) throw new StepError('exports/broken.jsonl, whose lines are not all JSON, is not listed in the view\'s header', shots)
      return { detail: control ? `"${control}" lists exports/broken.jsonl` : 'the header names exports/broken.jsonl', shots }
    })

    await step('view-derived', 'The view counts its derived fields in its header, with no marks on its cells', async () => {
      const head = await page.locator('.view-pane .view-pane-head').first().innerText()
      let marks = 0
      for (const fr of page.frames()) if (fr !== page.mainFrame()) marks += await fr.locator('[data-derived]').count().catch(() => 0)
      const problems = []
      if (!/derived[^\n]*?\b\d+\s+fields?\b|\b\d+\s+derived\b/i.test(head)) problems.push(`no count of derived fields in the header ("${head.replace(/\s+/g, ' ').trim()}")`)
      if (marks) problems.push(`${marks} derived marks on the view's cells`)
      const s = await shot(page, 'view-derived')
      if (problems.length) throw new StepError(problems.join('; '), [s])
      return { detail: head.match(/derived data[^\n]*|\d+\s+derived[^\n]*/i)?.[0] ?? '', shots: [s] }
    })

    await step('view-labels', 'Labels are part of the view\'s UI', async () => {
      const pane = page.locator('.view-pane').first()
      const text = await pane.innerText()
      const counted = /\b\d+\s+labels?\b/i.test(await pane.locator('.view-pane-head').first().innerText())
      const named = text.includes(WS.label?.name || 'Mentions forge')
      let marks = 0
      for (const fr of page.frames()) if (fr !== page.mainFrame()) marks += await fr.locator('[data-thimble-label]').count().catch(() => 0)
      const s = await shot(page, 'view-labels')
      if (!counted && !named && !marks) throw new StepError(`the view shows neither the label "${WS.label?.name}" nor a count or mark of labels`, [s])
      const got = [counted && 'its head counts the labels it shows', named && 'the label is named in the view pane', marks && `${marks} label marks in the view`]
      return { detail: got.filter(Boolean).join('; '), shots: [s] }
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
      const dir = join(WS.dir, 'extension', 'views', VIEW.slug)
      const onDisk = existsSync(join(dir, 'view.json'))
      const pop = await openSettings(page)
      const text = await pop.innerText()
      const s = await shot(page, 'local-views')
      const problems = []
      if (!onDisk) problems.push(`no workspaces/${WS.name}/extension/views/${VIEW.slug}/view.json`)
      if (!text.includes(VIEW.name)) problems.push(`Settings > Extensions does not list "${VIEW.name}"`)
      else if (!(await pop.locator('[data-local]').count().catch(() => 0)) && !/this workspace/i.test(text)) problems.push('no row for the workspace\'s own views')
      await closeSettings(page)
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
      const f = await followsExtension(page, true, 'add')
      const shots = []
      await extRow(page)
      shots.push(await shot(page, 'ext-added-settings'))
      await closeSettings(page)
      const m = await newMenu(page)
      shots.push(await shot(page, 'ext-added-new-menu'))
      await m.close()
      if (!f.ok) throw new StepError(`the UI did not follow: ${f.how}`, shots)
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
      const f = await followsExtension(page, false, 'off from the CLI')
      const s = await shot(page, 'ext-cli-off')
      if (!f.ok) throw new StepError(`the UI did not follow: ${f.how}`, [s])
      return { detail: `thimble extension ${r.word}: off in Settings, gone from + New (${f.how})`, shots: [s] }
    })

    await step('ext-cli-on', '`thimble extension on` switches it back on, and the UI follows', async () => {
      check(added, 'the extension was not added')
      const r = cli('on')
      check(r.status === 0, `thimble extension ${r.word} ${EXT}: exit ${r.status}: ${r.out.slice(0, 200)}`)
      const f = await followsExtension(page, true, 'on from the CLI')
      const s = await shot(page, 'ext-cli-on')
      if (!f.ok) throw new StepError(`the UI did not follow: ${f.how}`, [s])
      return { detail: `thimble extension ${r.word}: on in Settings, back in + New (${f.how})`, shots: [s] }
    })

    await step('ext-ui-off', 'Its switch in Settings turns it off for the workspace, and + New follows', async () => {
      check(added, 'the extension was not added')
      const r = await extRow(page)
      check(r.present, 'no row for the extension in Settings')
      if (r.on) await r.sw.click()
      await page.locator('.settings-pop').getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
      const f = await followsExtension(page, false, 'off in Settings')
      const s = await shot(page, 'ext-ui-off')
      if (!f.ok) throw new StepError(`the UI did not follow: ${f.how}`, [s])
      return { detail: `off in Settings, gone from + New (${f.how})`, shots: [s] }
    })

    await step('ext-ui-on', 'Its switch turns it back on, and + New follows', async () => {
      check(added, 'the extension was not added')
      const r = await extRow(page)
      check(r.present, 'no row for the extension in Settings')
      if (!r.on) await r.sw.click()
      await page.locator('.settings-pop').getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
      const f = await followsExtension(page, true, 'on in Settings')
      const s = await shot(page, 'ext-ui-on')
      if (!f.ok) throw new StepError(`the UI did not follow: ${f.how}`, [s])
      return { detail: `on in Settings, back in + New (${f.how})`, shots: [s] }
    })

    await step('ext-orient-offer', 'Switching on an extension with orientation instructions offers to run them', async () => {
      check(added, 'the extension was not added')
      // the offer is due only where an orientation ran; with no model here, a run record stands in for one
      const run = join(WS.dir, 'orient', 'run.json')
      const planted = !existsSync(run)
      if (planted) {
        mkdirSync(dirname(run), { recursive: true })
        writeFileSync(run, JSON.stringify({ session: 'e2e-standin', chats: { orient: 'e2e-standin' } }))
      }
      try {
        let r = await extRow(page)
        if (r.on) {
          await r.sw.click()
          await page.locator('.settings-pop').getByRole('button', { name: 'Save', exact: true }).click()
          await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
          await page.waitForTimeout(800)
          r = await extRow(page)
        }
        await r.sw.click()
        const row = page.locator(`.settings-pop [data-extension="${EXT}"]`)
        const shown = await row.getByText(/orientation now/i).first().waitFor({ timeout: 5_000 }).then(() => true, () => false)
        const s = await shot(page, 'ext-orient-offer')
        const not = row.getByRole('button', { name: /^not now$/i })
        if (await not.count()) await not.click()
        await page.locator('.settings-pop').getByRole('button', { name: 'Save', exact: true }).click()
        await page.locator('.settings-pop').waitFor({ state: 'detached', timeout: ACTION_MS }).catch(() => undefined)
        if (!shown) throw new StepError('switching it on in Settings offered no run of its orientation instructions', [s])
        return { detail: `Settings asks whether to run its orientation now; answered Not now${planted ? ' (a run record stood in for an orientation)' : ''}`, shots: [s] }
      } finally {
        if (planted) rmSync(run, { force: true })
      }
    })

    await step('ext-live', 'Settings and + New follow every switch of the extension without a reload', async () => {
      check(added, 'the extension was not added')
      check(lagged.length === 0, `shown only after a reload: ${lagged.join('; ')}`)
      return { detail: 'every switch shown on the live page' }
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
