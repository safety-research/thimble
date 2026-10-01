// The product tour's place in the shell. The first time this install's dashboard opens (backend tour.py, in thimble's
// own home), once the shell is drawn with its session attached, a welcome asks whether to take the tour; the offer is
// recorded as it shows, whatever the answer. Settings' Take the tour (the bus's `tour`) runs it again at any time. The
// tour itself (../tour) loads only then. When it closes, the focused pane shows the surface it showed before.
import { useEffect } from 'react'
import { api } from '../lib/api'
import { bus, type Tab } from '../lib/bus'

const chatOn = () => !!document.querySelector('.chat[data-panel="chat"]')
/** The shell is drawn, a Claude Code session is attached, and the chat, when it is on, shows its foot. */
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
        runTour({
          welcome,
          chat: chatOn(),
          showTab: (tab) => bus.emit('showTab', { tab, from: null }),
          onEnd: () => {
            running = false
            if (before && focusedTab() !== before) bus.emit('showTab', { tab: before, from: null })
          },
        })
      } catch (e) {
        running = false
        console.warn('tour', e)
      }
    }
    api
      .tour()
      .then(({ seen }) => {
        if (!seen && alive) void launch(true)
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
