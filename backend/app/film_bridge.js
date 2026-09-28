// The frame half of a video's film (video.film_document puts it first in the film's page; the page half is
// frontend/src/report/Video.tsx, and scripts/view_shot.mjs plays the page for the writer's frames). The film runs in a
// sandboxed iframe that reaches no host, so it hears the time to draw through postMessage calls:
//   ready              frame to page: the film's window.ready settled (or never came), so it can be drawn
//   seek {t}           page to frame: draw the frame at t seconds with the film's window.seek(t)
//   open {open: {t}}   page to frame: the same, as the headless shots send it
//   error {message}    frame to page: a script error, or a film without window.ready or window.seek
;(() => {
  const READY_WAIT_MS = 8000
  const FONTS_WAIT_MS = 2000
  const up = (msg) => parent.postMessage(msg, '*')
  const text = (x) => String(x && x.message ? x.message : x).slice(0, 400)
  const fail = (x) => up({ type: 'thimble:error', message: text(x) })
  addEventListener('error', (e) => fail(e.error || e.message))
  addEventListener('unhandledrejection', (e) => fail(e.reason))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const within = (p, ms) => Promise.race([p, sleep(Math.max(0, ms)).then(() => 'late')])
  let settled = null
  let latest = null
  const whenReady = () =>
    settled ||
    (settled = (async () => {
      const t0 = Date.now()
      while (!window.ready && Date.now() - t0 < READY_WAIT_MS) await sleep(50)
      if (!window.ready) fail('the film sets no window.ready')
      else {
        const got = await within(Promise.resolve(window.ready).then(() => 'ok', (e) => (fail(e), 'failed')), READY_WAIT_MS - (Date.now() - t0))
        if (got === 'late') fail(`window.ready did not settle within ${READY_WAIT_MS / 1000} s`)
      }
      await within(document.fonts.ready, FONTS_WAIT_MS)
      if (typeof window.seek !== 'function') fail('the film sets no window.seek function')
    })())
  const draw = (t) => {
    const x = Number(t)
    if (!Number.isFinite(x) || typeof window.seek !== 'function') return
    try {
      window.seek(x)
    } catch (e) {
      fail(e)
    }
  }
  addEventListener('message', async (e) => {
    if (e.source !== parent) return
    const d = e.data || {}
    const t = d.type === 'thimble:seek' ? d.t : d.type === 'thimble:open' && d.open ? d.open.t : undefined
    if (t === undefined) return
    // the film draws the latest time it was sent, once it is ready or has had its time to be
    latest = t
    await whenReady()
    if (latest !== null) draw(latest)
    latest = null
  })
  addEventListener('load', async () => {
    await whenReady()
    up({ type: 'thimble:ready' })
  })
})()
