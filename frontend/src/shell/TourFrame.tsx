// The tour's frame (lib/tourFrame): thimble's demo workspace in a frame over the whole window, under a banner that says
// it is the tour, on example data, not the analyst's files, with Exit tour. With no demo installed (`ws` null), the
// frame first sets up the tour's example workspace (`setUp`, POST /tour/workspace); until the tour in the frame has
// started, the frame says "Setting up the tour…" in place of the page it loads. The page under it is inert and takes no
// input, so it stays exactly as it was; Esc on the banner closes the frame, as Esc in the tour does. The frame closes
// when the tour in it ends (Done, Skip tour, Esc), on Exit tour, when the page's own session ends, or when the setup
// fails or the tour has not started within START_TIMEOUT_MS (`failed`, which TourHost says). Once it is gone, the
// browser storage of the demo workspace is put back as it was, so the tour leaves no layout behind there either.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../components/Button'
import { hold } from '../lib/telemetry'
import { setTouring } from '../lib/touring'
import { keepWorkspaceStorage, tourEventOf, tourFrameHref } from '../lib/tourFrame'
import { setGuard } from '../tour/freeze'

/** How long the frame waits for the tour in it to start before it closes and says so (ms). */
export const START_TIMEOUT_MS = 30_000

/** What the banner says. */
export const BANNER_NAME = 'Tour'
export const BANNER_TEXT = 'Example data, not your files'
export const BANNER_EXIT = 'Exit tour'
/** What the frame says until the tour in it has started. */
export const SETTING_UP = 'Setting up the tour…'

/** Calls `fn` once the shell's session is gone (SessionGone's card shows). Returns the stop. */
export function onSessionGone(fn: () => void): () => void {
  const shell = document.querySelector<HTMLElement>('.shell')
  if (!shell) return () => undefined
  const watch = new MutationObserver(() => shell.dataset.session === 'gone' && fn())
  watch.observe(shell, { attributes: true, attributeFilter: ['data-session'] })
  return () => watch.disconnect()
}

const stop = (e: Event) => {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

export function TourFrame({ ws, setUp, onClose }: { ws: string | null; setUp: () => Promise<string>; onClose: (failed: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const banner = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  // the workspace the frame shows: `ws`, else the one setUp made
  const [name, setName] = useState(ws)
  // the tour in the frame has started: until then the frame says it is setting up
  const [started, setStarted] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const finish = useRef<(failed: boolean) => void>(() => undefined)

  // with no demo installed, the tour's example workspace first
  useEffect(() => {
    if (name) return
    let alive = true
    setUp().then(
      (made) => alive && setName(made),
      () => alive && finish.current(true),
    )
    return () => {
      alive = false
    }
  }, [name, setUp])

  // the demo workspace's browser storage, put back once the frame is gone (an effect's cleanup runs after its element
  // left the page, so nothing in the frame writes after this)
  useEffect(() => (name ? keepWorkspaceStorage(name) : undefined), [name])

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    hold(true)
    setTouring(true)
    // every other layer of the page is inert while the frame shows, as under the session card (SessionGone)
    const others = [...document.body.children].filter((el) => el !== root.current && !el.hasAttribute('inert'))
    others.forEach((el) => el.setAttribute('inert', ''))
    let started = false
    let done = false
    finish.current = (failed) => {
      if (done) return
      done = true
      closeRef.current(failed)
    }
    const timer = window.setTimeout(() => started || finish.current(true), START_TIMEOUT_MS)
    const onMessage = (e: MessageEvent) => {
      const ev = tourEventOf(e, frame.current?.contentWindow ?? null, window.location.origin)
      if (ev === 'started') {
        started = true
        window.clearTimeout(timer)
        setStarted(true)
        frame.current?.focus()
      } else if (ev === 'end') finish.current(false)
      else if (ev === 'fail') finish.current(true)
    }
    window.addEventListener('message', onMessage)
    // a session that ends closes the frame, so the shell's own card about it can be used
    const stopGone = onSessionGone(() => finish.current(false))
    // the page's own listeners hear nothing while the frame shows: only the banner takes input, and Esc closes the frame
    setGuard((e) => {
      if (!e.isTrusted) return
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
        stop(e)
        finish.current(false)
        return
      }
      if (!(e.target instanceof Node && banner.current?.contains(e.target))) stop(e)
    })
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      stopGone()
      setGuard(null)
      others.forEach((el) => el.removeAttribute('inert'))
      hold(false)
      setTouring(false)
      before?.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div ref={root} className="tour-frame" role="dialog" aria-modal="true" aria-label="thimble tour" data-tour-frame={name ?? ''}>
      <div ref={banner} className="tour-banner">
        <span className="tour-banner-name">{BANNER_NAME}</span>
        <span className="tour-banner-sep" aria-hidden="true">
          ·
        </span>
        <span className="tour-banner-text">{BANNER_TEXT}</span>
        <span className="tour-banner-spacer" />
        <Button variant="secondary" size="sm" className="tour-banner-exit" onClick={() => finish.current(false)}>
          {BANNER_EXIT}
        </Button>
      </div>
      <div className="tour-frame-body">
        {!started && (
          <p className="tour-frame-wait" role="status">
            {SETTING_UP}
          </p>
        )}
        {name && <iframe ref={frame} className="tour-frame-page" data-started={started ? '' : undefined} src={tourFrameHref(name, window.location.pathname)} title="thimble tour on example data" />}
      </div>
    </div>,
    document.body,
  )
}
