// The product tour's place in the shell. Each dashboard this install opens (backend tour.py, in thimble's own home),
// once the shell is drawn with its session attached, shows a welcome that asks whether to take the tour, and says that
// the tour uses example data, until the person answers one (Take the tour, Skip or Esc), whatever the answer: that
// answer is recorded, so a welcome no one answered, on a page opened before the person's own, leaves the offer to the
// next page, and a welcome this page shows goes once the person answers the offer in another page (watchAnswer).
// Settings' Take the tour (the bus's `tour`) runs it again at any time. The tour itself (../tour) loads only then. While
// it runs, telemetry records nothing and the chat shows no view proposal (lib/touring). When it closes, the focused pane
// shows the surface it showed before; a session that ends while it runs closes it.
import { useEffect } from 'react'
import { api } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { hold } from '../lib/telemetry'
import { refFromUrl } from '../lib/teleport'
import { setTouring } from '../lib/touring'
import type { Tour } from '../tour/engine'

/** How often a welcome that waits for its answer asks whether the person answered the offer in another page. */
export const ANSWER_CHECK_MS = 2000

/** The chat column is open, not folded. */
const chatOn = () => !!document.querySelector('.chat[data-panel="chat"]')
/** The shell is drawn, a Claude Code session is attached, and the chat, when its column is open, shows its foot. */
const ready = () => {
  const shell = document.querySelector<HTMLElement>('.shell')
  return !!shell && shell.dataset.session !== 'gone' && (shell.dataset.chat !== 'open' || !!document.querySelector('.chat[data-panel="chat"] .chat-foot'))
}
const focusedTab = (): Tab | null => {
  const t = document.querySelector<HTMLElement>('.shell-tabs .tab.active')?.dataset.tab
  return t === 'files' || t === 'canvas' || t === 'report' ? t : null
}
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))
/** Whether the person answered the offer, in this page or another (backend tour.py); false while that cannot be read. */
const answered = () => api.tour().then(({ seen }) => seen, () => false)

/** The welcome of `tour` goes once the person answers the offer in another page: asked every ANSWER_CHECK_MS, and when
 * this page comes back into view, while the welcome waits for its answer. Returns the stop. */
function watchAnswer(tour: Tour): () => void {
  let on = true
  const check = () =>
    void answered().then((seen) => {
      if (seen && on && tour.state().welcome) tour.end()
    })
  const shown = () => document.visibilityState === 'visible' && check()
  const timer = window.setInterval(check, ANSWER_CHECK_MS)
  document.addEventListener('visibilitychange', shown)
  window.addEventListener('focus', check)
  return () => {
    on = false
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', shown)
    window.removeEventListener('focus', check)
  }
}

export function TourHost() {
  useEffect(() => {
    let alive = true
    let running = false
    let unwatch = () => {}
    const launch = async (welcome: boolean) => {
      if (running) return
      running = true
      try {
        if (welcome) {
          while (alive && !ready()) await sleep(250)
          await document.fonts?.ready.catch(() => undefined)
          await sleep(900)
          while (alive && !ready()) await sleep(250)
          // the person may have answered the offer in another page while this one got ready
          if (!alive || (await answered())) return void (running = false)
        }
        const { runTour } = await import('../tour/run')
        if (!alive) return void (running = false)
        const before = focusedTab()
        // a session that ends while the tour runs closes it, so the shell's own card about it can be used
        const shell = document.querySelector<HTMLElement>('.shell')
        const watch = new MutationObserver(() => shell?.dataset.session === 'gone' && tour.end())
        hold(true)
        setTouring(true)
        const tour = runTour({
          welcome,
          chat: chatOn(),
          showTab: (tab) => bus.emit('showTab', { tab, from: null }),
          onAnswer: welcome
            ? () => {
                unwatch()
                void api.tourSeen().catch(() => undefined)
              }
            : undefined,
          onEnd: () => {
            running = false
            unwatch()
            watch.disconnect()
            if (before && focusedTab() !== before) bus.emit('showTab', { tab: before, from: null })
            hold(false)
            setTouring(false)
          },
        })
        if (shell) watch.observe(shell, { attributes: true, attributeFilter: ['data-session'] })
        if (welcome && tour.running()) unwatch = watchAnswer(tour)
      } catch (e) {
        running = false
        hold(false)
        setTouring(false)
        console.warn('tour', e)
      }
    }
    // the page the screenshot tool opens at a card (`?ref=`, lib/teleport refFromUrl) is not the analyst's: it offers no
    // welcome, which would stand over the card in the picture
    api
      .tour()
      .then(({ seen }) => {
        if (!seen && alive && !refFromUrl()) void launch(true)
      })
      .catch(() => undefined)
    const off = bus.on('tour', () => void launch(false))
    return () => {
      alive = false
      unwatch()
      off()
    }
  }, [])
  return null
}
