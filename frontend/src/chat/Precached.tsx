// A workspace `thimble demo` installed from a pre-cache (backend precached.py): its orientation ran in advance, on the
// same files. From the outputs alone (the pre-caches in demos/) its Claude Code session was not kept: while no session
// is attached, the orientation's thread opens with a card that says this is a frozen demo session and gives the command
// that starts a live one in the dataset's folder, with a Copy button, and nothing else. From a full export the session
// was kept (the mark's `kept`) and a message in its thread continues it: the card says the orientation ran in advance and,
// while no session is attached, offers an "Attach a fresh session" button that shows what a fresh session is, the
// command with a Copy button, and how to continue it later. Once a session is attached the card says so. The same
// steps stand in for the composer while no session was ever attached, since nothing would read a message sent from it;
// while a frozen demo session's card is on screen that bar is hidden, so its title, sentence and command show once, and
// once the card scrolls away the bar gives the sentence and the command again.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import type { ChatMeta, PrecachedMark } from '../lib/types'
import { copyText } from '../shell/ProblemReport'
import { reconnectCommand } from '../shell/SessionGone'

export const PRECACHED_TITLE = 'This orientation ran in advance'
export const FROZEN_TITLE = 'This is a frozen demo session'
export const FROZEN_TEXT = 'To start a live session from scratch with this dataset, run'
export const ATTACH_LABEL = 'Attach a fresh session'
export const ATTACH_EXPLAINER =
  'A fresh Claude Code session starts with these cards and the report as its context, so it can explain them, check them against the files or start a new orientation. Run this in a terminal (claude must be logged in):'
export const REATTACH_NOTE = 'in that folder continues the same session later.'
export const NO_SESSION_TEXT = 'No Claude Code session is attached, so nothing reads a message yet.'

/** The pre-cache's mark, from the orientation's meta that carries one; null in a workspace not installed from a
 * pre-cache. Pure. */
export function precachedMark(metas: readonly ChatMeta[]): PrecachedMark | null {
  const m = metas.find((x) => x.precached && x.role === 'orient')
  return m?.precached ? { ...m.precached, orientation: m.precached.orientation ?? m.id } : null
}

/** Whether the attach steps stand in for the composer: in a pre-cached workspace no session was ever attached to, where
 * the composer would send to main or a side thread (threads.composerTarget `here` or `main`), which nothing reads yet.
 * A later orientation's thread or a view's build still takes messages. Pure. */
export function attachInstead(mark: PrecachedMark | null, neverAttached: boolean, to: string): boolean {
  return !!mark && neverAttached && (to === 'here' || to === 'main')
}

/** Whether the pre-cached orientation takes a message: its session came with a full export. Pure. */
export function takesFollowUps(mark: PrecachedMark | null): boolean {
  return !!mark?.kept
}

/** Whether the card says this is a frozen demo session: the pre-cache's session was not kept and no session is
 * attached. Pure. */
export function isFrozen(mark: PrecachedMark, attached: boolean): boolean {
  return !takesFollowUps(mark) && !attached
}

/** What the card says of the run: when, on what model, and what was kept. Pure. */
export function precachedText(mark: PrecachedMark): string {
  const ran = mark.ran ?? mark.created
  const when = ran ? ` on ${ran.slice(0, 10)}` : ''
  const model = mark.model ? ` with ${mark.model.replace('[1m]', '')}` : ''
  const session = takesFollowUps(mark)
    ? 'Its Claude Code session came with them, so a message here continues it.'
    : 'Its Claude Code session is not, so it takes no follow-ups.'
  return `It ran${when}${model}, on these same files, before thimble was installed here. Its cards, labels, views and report are here. ${session}`
}

/** The command that attaches a fresh session: `thimble` in the folder the pre-cache was installed for. Pure. */
export function attachCommand(mark: PrecachedMark): string {
  return reconnectCommand(mark.folder ?? null, false)
}

/** The command in a code box with its Copy button. */
function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!(await copyText(command))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="precached-command">
      <code>{command}</code>
      <Button variant="secondary" size="sm" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/** The explainer, the command with its Copy button, and how to continue later. */
export function AttachSteps({ mark }: { mark: PrecachedMark }) {
  return (
    <div className="precached-steps">
      <p className="precached-text">{ATTACH_EXPLAINER}</p>
      <Command command={attachCommand(mark)} />
      <p className="precached-note">
        <code>thimble -c</code> {REATTACH_NOTE}
      </p>
    </div>
  )
}

/** A frozen demo session's one sentence and the command with its Copy button. */
export function FrozenSteps({ mark }: { mark: PrecachedMark }) {
  return (
    <div className="precached-steps">
      <p className="precached-text">{FROZEN_TEXT}</p>
      <Command command={attachCommand(mark)} />
    </div>
  )
}

/** The button that shows the steps, and the steps once it is pressed. */
function Attach({ mark, open: initial = false }: { mark: PrecachedMark; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  return (
    <>
      {!open && (
        <div className="precached-actions">
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            {ATTACH_LABEL}
          </Button>
        </div>
      )}
      {open && <AttachSteps mark={mark} />}
    </>
  )
}

// The frozen demo session's cards mounted now, which the bar under them watches (frozenCards, useFrozenCardShown)
const frozen = new Set<HTMLElement>()
const frozenListeners = new Set<() => void>()
let frozenVersion = 0
function frozenChanged() {
  frozenVersion++
  for (const fn of frozenListeners) fn()
}
/** The ref of a frozen demo session's card: kept while it is mounted. */
function frozenRef(el: HTMLElement | null) {
  if (!el) return
  frozen.add(el)
  frozenChanged()
  return () => {
    frozen.delete(el)
    frozenChanged()
  }
}
const subscribeFrozen = (fn: () => void) => {
  frozenListeners.add(fn)
  return () => void frozenListeners.delete(fn)
}

/** Whether a frozen demo session's card is on screen (any part of it in the viewport), while `watch`: an
 * IntersectionObserver on the cards mounted; without one, whether a card is mounted. */
export function useFrozenCardShown(watch: boolean): boolean {
  const version = useSyncExternalStore(subscribeFrozen, () => frozenVersion, () => frozenVersion)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const els = [...frozen]
    if (!watch || els.length === 0) {
      setShown(false)
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return
    }
    const seen = new Map<Element, boolean>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target, e.isIntersecting)
      setShown([...seen.values()].some(Boolean))
    })
    for (const el of els) io.observe(el)
    return () => io.disconnect()
  }, [watch, version])
  return watch && shown
}

/** The card at the top of a pre-cached orientation's thread: a frozen demo session's, else the attach button while no
 * session is attached. */
export function PrecachedCard({ mark, attached }: { mark: PrecachedMark; attached: boolean }) {
  if (isFrozen(mark, attached)) {
    return (
      <Card ref={frozenRef} className="precached-card chat-row" head={FROZEN_TITLE} flat data-precached={mark.dataset ?? ''}>
        <FrozenSteps mark={mark} />
      </Card>
    )
  }
  return (
    <Card className="precached-card chat-row" head={PRECACHED_TITLE} flat data-precached={mark.dataset ?? ''}>
      <p className="precached-text">{precachedText(mark)}</p>
      {attached ? <p className="precached-note">A Claude Code session is attached. It started from these cards and the report.</p> : <Attach mark={mark} />}
    </Card>
  )
}

/** In place of the composer while no session was ever attached to a pre-cached workspace: a frozen demo session's
 * sentence and command, hidden while the card above (`card`, the orientation's thread is the one shown) is on screen
 * and gives them, so they show once; else the attach button. */
export function AttachBar({ mark, card = false }: { mark: PrecachedMark; card?: boolean }) {
  const frozenMark = isFrozen(mark, false)
  const cardShown = useFrozenCardShown(frozenMark && card)
  if (frozenMark) {
    return (
      <div className="precached-bar" data-precached-bar="" hidden={cardShown}>
        <FrozenSteps mark={mark} />
      </div>
    )
  }
  return (
    <div className="precached-bar" data-precached-bar="">
      <p className="precached-note">{NO_SESSION_TEXT}</p>
      <Attach mark={mark} />
    </div>
  )
}
