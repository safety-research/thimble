// The reader's two tracks (src/files/Tracks.tsx ReaderTracks) with the app's stylesheets in headless Chromium, light
// and dark: the overview's frame is exactly as wide as its track; on the zoomed track the records past what the reader
// shows fade and those it shows are full, framed; hovering the overview shows the records at that point beside the
// tracks, without scrolling, and a marker says its label's name and value; a press on the overview scrubs the reader.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'tracks',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ReaderTracks } from '${src('files/Tracks.tsx')}'`,
      `const w = window as any`,
      `w.__seeks = []`,
      `w.__asked = []`,
      `const root = createRoot(document.getElementById('root')!)`,
      `const at = Array.from({ length: 100 }, (_, i) => (i < 50 ? 0 : 1))`,
      `const records = Array.from({ length: 20 }, (_, i) => ({ line: 100 + i, top: i * 100, bottom: i * 100 + 90, color: i % 2 ? 'var(--label-2)' : 'var(--label-1)', marks: [i === 9 ? 'var(--label-3)' : null], title: 'v' }))`,
      `const markers = [{ id: 'k', name: 'edit purpose', valued: true, total: 1000, ticks: [{ from: 400, to: 420, colour: 'var(--label-3)', value: 'posts links' }] }]`,
      `const preview = (line) => { w.__asked.push(line); return Promise.resolve([{ line, who: 'AgentRelent', when: '2026-06-18 20:15', text: 'SEC county variants for pretty lines', color: 'var(--label-1)' }]) }`,
      `flushSync(() => root.render(<div style={{ height: 600, display: 'flex', justifyContent: 'flex-end' }}><ReaderTracks total={1000} view={{ top: 0.5, height: 0.1, seen: [] }} paint={{ kind: 'bins', at, colors: ['var(--label-1)', 'var(--label-2)'], faded: [false, true] }} markers={markers} zoom={{ from: 0, to: 2000, viewTop: 800, viewBottom: 1200, records }} onJump={() => {}} onSeek={(f, held) => w.__seeks.push([f, held])} onWheel={() => {}} onLine={() => {}} onMark={() => {}} preview={preview} /></div>))`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' },
      conditions: ['style'],
    },
  )
  const dir = path.dirname(script)
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 640 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
      })
    const file = path.join(dir, p)
    if (existsSync(file))
      return route.fulfill({
        status: 200,
        contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: readFileSync(file),
      })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('.track-over')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

for (const theme of ['light', 'dark']) {
  test(`the frame is as wide as the overview, and the zoomed track fades past what the reader shows, in the ${theme} theme`, async () => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-paper', t === 'dark' ? 'dark' : 'warm'), theme)
    const got = await page.evaluate(() => {
      const over = document.querySelector('.track-over')!.getBoundingClientRect()
      const frame = document.querySelector('.track-frame-over')!.getBoundingClientRect()
      const faded = getComputedStyle(document.querySelector('.track-zoom-faded')!).opacity
      const shown = document.querySelector('.track-zoom-shown')!.getBoundingClientRect()
      const zoom = document.querySelector('.track-zoom')!.getBoundingClientRect()
      const full = [...document.querySelectorAll('.track-zoom-shown [data-line]')].map((e) => Number((e as HTMLElement).dataset.line))
      const border = getComputedStyle(document.querySelector('.track-frame-over')!).borderTopColor
      return {
        overW: over.width,
        frameW: frame.width,
        frameL: frame.left - over.left,
        faded,
        shownTop: shown.top - zoom.top,
        shownH: shown.height,
        zoomH: zoom.height,
        full,
        border,
      }
    })
    assert.equal(got.frameW, got.overW)
    assert.equal(got.frameL, 0)
    assert.ok(Math.abs(Number(got.faded) - 0.28) < 0.01, `faded at ${got.faded}`)
    // the reader shows 800 to 1200 of the 2000 px the zoomed track spans: the middle fifth, full
    assert.ok(Math.abs(got.shownTop - got.zoomH * 0.4) <= 1 && Math.abs(got.shownH - got.zoomH * 0.2) <= 1, JSON.stringify(got))
    assert.ok(got.full.includes(108) && got.full.includes(111), `full records ${got.full}`)
    assert.notEqual(got.border, 'rgba(0, 0, 0, 0)')
  })
}

test('hovering the overview shows the records at that point, and a marker its label', async () => {
  const over = (await page.locator('.track-over').boundingBox())!
  await page.mouse.move(over.x + over.width - 3, over.y + over.height * 0.3)
  await page.mouse.move(over.x + over.width - 2, over.y + over.height * 0.3 + 1)
  await page.waitForSelector('.track-preview .track-preview-text')
  const text = await page.locator('.track-preview').innerText()
  assert.match(text, /AgentRelent/)
  assert.match(text, /SEC county variants/)
  const asked = await page.evaluate(() => (window as any).__asked as number[])
  assert.ok(
    asked.every((l) => l >= 290 && l <= 310),
    `asked ${asked}`,
  )
  // the marker lane at the overview's left: the tick over lines 400 to 420
  await page.mouse.move(over.x + 1.5, over.y + over.height * 0.41)
  await page.waitForSelector('.reader-ruler-tip')
  assert.equal(await page.locator('.reader-ruler-tip').innerText(), 'edit purpose: posts links')
  assert.equal(await page.locator('.track-preview').count(), 0)
})

test('a press on the overview sends the frame there and scrubs the reader', async () => {
  const over = (await page.locator('.track-over').boundingBox())!
  await page.mouse.move(over.x + over.width - 3, over.y + over.height * 0.8)
  await page.mouse.down()
  await page.mouse.move(over.x + over.width - 3, over.y + over.height * 0.85, {
    steps: 4,
  })
  await page.mouse.up()
  const seeks = await page.evaluate(() => (window as any).__seeks as [number, boolean][])
  assert.ok(seeks.length >= 2 && seeks[0][1] === true && seeks[seeks.length - 1][1] === false, JSON.stringify(seeks))
  assert.ok(seeks[seeks.length - 1][0] > seeks[0][0])
})
