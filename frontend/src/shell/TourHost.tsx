// The product tour's place in the shell. The first time this install's dashboard opens (backend tour.py, in thimble's
// own home), once the shell is drawn with its session attached, a welcome asks whether to take the tour; the offer is
// recorded as it shows, whatever the answer. Settings' Take the tour (the bus's `tour`) runs it again at any time. The
// tour itself (../tour) loads only then. While it runs, telemetry records nothing and main's chat draws no Start gate
// (lib/touring). When it closes, the focused pane shows the surface it showed before; a session that ends while it runs
// closes it.
import { useEffect } from 'react'
import { api } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { hold } from '../lib/telemetry'
import { refFromUrl } from '../lib/teleport'
import { setTouring } from '../lib/touring'

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

export function TourHost() {
  useEffect(() => {
    let alive = true
    let running = false
    const launch = async (welcome: boolean) => {
      if (running) return
      running = true
      try {
        if (welcome) {
          while (alive && !ready()) await sleep(250)
          await document.fonts?.ready.catch(() => undefined)
          await sleep(900)
          while (alive && !ready()) await sleep(250)
          if (!alive) return void (running = false)
          api.tourSeen().catch(() => undefined)
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
          onEnd: () => {
            running = false
            watch.disconnect()
            if (before && focusedTab() !== before) bus.emit('showTab', { tab: before, from: null })
            hold(false)
            setTouring(false)
          },
        })
        if (shell) watch.observe(shell, { attributes: true, attributeFilter: ['data-session'] })
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
      off()
    }
  }, [])
  return null
}
