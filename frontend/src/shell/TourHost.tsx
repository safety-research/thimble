// The product tour's place in the shell. The tour never lays its examples over the analyst's own files: it runs in
// thimble's read-only demo workspace, in a frame over the whole window under a banner that says it is example data, and
// when it ends the analyst's page is exactly as it was (lib/tourFrame, TourFrame).
//
// On the analyst's page: the first time this install's dashboard opens (backend tour.py, in thimble's own home), once
// the shell is drawn with its session attached, or on a demo page (lib/demo), a welcome asks whether to take the tour.
// On a demo page it first says that the page holds example data; elsewhere it says that the tour uses example data. The
// offer is recorded as it shows, whatever the answer. Settings' Take the tour (the bus's `tour`) opens the frame at
// once. The tour runs on this workspace when it is a demo page, else on an installed demo dataset or worked example
// (tourWorkspace); with none installed, the frame first sets up the tour's example workspace from a sample every
// install ships (POST /tour/workspace), which a second tour reuses. A frame whose tour did not start, or whose setup
// failed, gets a card that says so. While a card or the frame shows, telemetry records nothing and the chat
// shows no view proposal (lib/touring); a session that ends meanwhile closes them, so the shell's own card about it can
// be used.
//
// In the tour's frame (`?tour=frame`), a demo page whatever its session (SessionGone): the tour from its first step once
// the shell is drawn, which tells the page around it when it started and when it ended. The tour itself (../tour)
// loads only when it runs.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { isDemo } from '../lib/demo'
import { hold } from '../lib/telemetry'
import { refFromUrl } from '../lib/teleport'
import { setTouring } from '../lib/touring'
import { inTourFrame, sendTourEvent, tourWorkspace } from '../lib/tourFrame'
import type { WorkspaceRow } from '../lib/types'
import { onSessionGone, TourFrame } from './TourFrame'

/** The chat column is open, not folded. */
const chatOn = () => !!document.querySelector('.chat[data-panel="chat"]')
/** The shell is drawn, a Claude Code session is attached (or it is a demo page, `data-session` static), and the chat,
 * when its column is open, shows its foot. */
const ready = () => {
  const shell = document.querySelector<HTMLElement>('.shell')
  return !!shell && shell.dataset.session !== 'gone' && (shell.dataset.chat !== 'open' || !!document.querySelector('.chat[data-panel="chat"] .chat-foot'))
}
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

type CardState = 'offer' | 'failed'
/** The tour's example workspace, set up on the spot when no demo is installed (backend tour.py): its name. */
const setUp = () => api.tourWorkspace().then((r) => r.name)

export function TourHost({ ws }: { ws: string }) {
  // the tour's frame while it shows, on its demo workspace (null: none installed, so the frame sets one up)
  const [frame, setFrame] = useState<{ ws: string | null } | null>(null)
  // a card, or the frame, shows or is about to
  const busy = useRef(false)
  const showCard = useRef<(state: CardState, onBegin?: () => void) => Promise<void>>(async () => undefined)

  useEffect(() => (inTourFrame() ? runFramed() : undefined), [])

  useEffect(() => {
    if (inTourFrame()) return
    let alive = true
    // the engine's card on this page (../tour/run offerTour): the welcome, or why the tour can't run
    const card = async (state: CardState, onBegin?: () => void) => {
      const { offerTour } = await import('../tour/run')
      if (!alive) return void (busy.current = false)
      hold(true)
      setTouring(true)
      let began = false
      let stopWatch = (): void => undefined
      const tour = offerTour({
        state,
        demo: isDemo(),
        onBegin:
          onBegin &&
          (() => {
            began = true
            onBegin()
          }),
        onEnd: () => {
          stopWatch()
          hold(false)
          setTouring(false)
          if (!began) busy.current = false
        },
      })
      stopWatch = onSessionGone(() => tour.end())
    }
    showCard.current = card
    const launch = async (welcome: boolean) => {
      if (busy.current) return
      busy.current = true
      try {
        if (welcome) {
          while (alive && !ready()) await sleep(250)
          await document.fonts?.ready.catch(() => undefined)
          await sleep(900)
          while (alive && !ready()) await sleep(250)
          if (!alive) return void (busy.current = false)
          api.tourSeen().catch(() => undefined)
        }
        const rows = await api.workspaces().catch((): WorkspaceRow[] => [])
        if (!alive) return void (busy.current = false)
        const target = tourWorkspace(rows, ws, isDemo())
        if (welcome) await card('offer', () => setFrame({ ws: target }))
        else setFrame({ ws: target })
      } catch (e) {
        busy.current = false
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
  }, [ws])

  if (!frame) return null
  return (
    <TourFrame
      ws={frame.ws}
      setUp={setUp}
      onClose={(failed) => {
        setFrame(null)
        if (failed) void showCard.current('failed')
        else busy.current = false
      }}
    />
  )
}

/** In the tour's frame: the tour from its first step once the shell is drawn, in a demo page's words. It tells the page
 * around the frame when it started, and when it ended or failed. Returns the stop. */
function runFramed(): () => void {
  let alive = true
  const parent = window.parent
  void (async () => {
    try {
      while (alive && !ready()) await sleep(250)
      await document.fonts?.ready.catch(() => undefined)
      await sleep(300)
      while (alive && !ready()) await sleep(250)
      const { runTour } = await import('../tour/run')
      if (!alive) return
      hold(true)
      setTouring(true)
      // the page around the frame removes it once the tour ends, and puts the demo workspace's stored layout back
      runTour({
        chat: chatOn(),
        showTab: (tab) => bus.emit('showTab', { tab, from: null }),
        onEnd: () => {
          hold(false)
          setTouring(false)
          sendTourEvent(parent, 'end')
        },
      })
      sendTourEvent(parent, 'started')
    } catch (e) {
      console.warn('tour', e)
      sendTourEvent(parent, 'fail')
    }
  })()
  return () => {
    alive = false
  }
}
