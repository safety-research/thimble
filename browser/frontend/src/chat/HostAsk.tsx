// The ask before a request to a host the analyst has not allowed (backend host_asks.py), as Claude Code asks in the
// terminal: the command that made the request waits, and so does its agent's turn, until the analyst answers. One small
// row per ask at the end of the transcript of the chat whose agent asked, which is under the command that waits: the
// host, then Allow once, Always allow (kept for the workspace) and Deny. The row goes once the server has the answer
// (the chat's meta no longer lists it); an answer that fails says why, and the row takes clicks again.
import { useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { HostAsk, HostAskChoice } from '../lib/types'

/** The choices, in order, with their words. */
export const HOST_CHOICES: readonly { choice: HostAskChoice; words: string }[] = [
  { choice: 'once', words: 'Allow once' },
  { choice: 'always', words: 'Always allow' },
  { choice: 'deny', words: 'Deny' },
]

/** One ask with its choices. */
export function HostAskRow({ ws, ask }: { ws: string; ask: HostAsk }) {
  const [busy, setBusy] = useState<HostAskChoice | null>(null)
  const choose = (choice: HostAskChoice) => {
    if (busy) return
    setBusy(choice)
    api.answerHostAsk(ws, ask.id, choice).catch((e: Error) => {
      // a command that no longer waits takes its row away with the chat's next read
      if (/^404\b/.test(e.message)) return
      setBusy(null)
      bus.emit('toast', { text: `Could not answer: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' })
    })
  }
  return (
    <div className="chat-host-ask" role="group" aria-label={`Allow a connection to ${ask.host}?`} data-ask={ask.id} data-host={ask.host}>
      <Icon name="globe" size={12} className="chat-host-ask-ico" />
      <span className="chat-host-ask-host">{ask.host}</span>
      <span className="chat-host-ask-acts">
        {HOST_CHOICES.map((c) => (
          <Button
            key={c.choice}
            variant={c.choice === 'once' ? 'primary' : c.choice === 'always' ? 'secondary' : 'ghost'}
            size="sm"
            busy={busy === c.choice}
            disabled={!!busy && busy !== c.choice}
            data-choice={c.choice}
            onClick={() => choose(c.choice)}
          >
            {c.words}
          </Button>
        ))}
      </span>
    </div>
  )
}

/** Every ask that waits on the chat shown. */
export function HostAsks({ ws, asks }: { ws: string; asks: readonly HostAsk[] }) {
  if (!asks.length) return null
  return (
    <div className="chat-msg chat-host-asks">
      {asks.map((a) => (
        <HostAskRow key={a.id} ws={ws} ask={a} />
      ))}
    </div>
  )
}
