// A workspace `thimble demo` installed from a pre-cache (backend precached.py): its orientation ran in advance, on the
// same files. From the outputs alone its Claude Code session was not kept; from a full export it was (the mark's `kept`),
// and a message in its thread continues it. The orientation's thread opens with a card that says which, and,
// while no session is attached, an "Attach a fresh session" button that shows what a fresh session is, the command that
// attaches one in a terminal with a Copy button, and how to continue it later. The same steps stand in for the
// composer while no session was ever attached, since nothing would read a message sent from it.
import { useState } from 'react'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import type { ChatMeta, PrecachedMark } from '../lib/types'
import { copyText } from '../shell/ProblemReport'
import { reconnectCommand } from '../shell/SessionGone'

export const PRECACHED_TITLE = 'This orientation ran in advance'
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

/** The explainer, the command with its Copy button, and how to continue later. */
export function AttachSteps({ mark }: { mark: PrecachedMark }) {
  const [copied, setCopied] = useState(false)
  const command = attachCommand(mark)
  const copy = async () => {
    if (!(await copyText(command))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="precached-steps">
      <p className="precached-text">{ATTACH_EXPLAINER}</p>
      <div className="precached-command">
        <code>{command}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="precached-note">
        <code>thimble -c</code> {REATTACH_NOTE}
      </p>
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

/** The card at the top of a pre-cached orientation's thread; the attach button while no session is attached. */
export function PrecachedCard({ mark, attached }: { mark: PrecachedMark; attached: boolean }) {
  return (
    <Card className="precached-card chat-row" head={PRECACHED_TITLE} flat data-precached={mark.dataset ?? ''}>
      <p className="precached-text">{precachedText(mark)}</p>
      {attached ? <p className="precached-note">A Claude Code session is attached. It started from these cards and the report.</p> : <Attach mark={mark} />}
    </Card>
  )
}

/** In place of the composer while no session was ever attached to a pre-cached workspace. */
export function AttachBar({ mark }: { mark: PrecachedMark }) {
  return (
    <div className="precached-bar" data-precached-bar="">
      <p className="precached-note">{NO_SESSION_TEXT}</p>
      <Attach mark={mark} />
    </div>
  )
}
