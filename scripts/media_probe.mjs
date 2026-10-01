// scripts/media_probe.mjs: whether the browser scripts/view_shot.mjs drives can play what most screen recordings hold,
// H.264 video and AAC audio in MP4. Prints one line, {"h264": bool, "aac": bool}. The browser is the frontend's
// Playwright Chromium, or the system's at THIMBLE_BROWSER_PATH (backend/app/headless.py plays_recordings).
import { createRequire } from 'node:module'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')

const browser = await chromium.launch({ executablePath: process.env.THIMBLE_BROWSER_PATH || undefined })
try {
  const page = await browser.newPage()
  const out = await page.evaluate(() => ({
    h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '',
    aac: document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '',
  }))
  process.stdout.write(JSON.stringify(out) + '\n')
} finally {
  await browser.close()
}
