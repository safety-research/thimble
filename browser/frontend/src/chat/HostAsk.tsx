// The ask before a request to a host the analyst has not allowed (backend host_asks.py), as Claude Code asks in the
// terminal: the command that made the request waits, and so does its agent's turn, until the analyst answers. One small
// card per ask at the end of the transcript of the chat whose agent asked, which is under the command that waits: what
// Claude said the command does (its description), the host, the command (cut to fit, whole once clicked, as its step
// line opens to it; a tool other than Bash shows its URL), then Allow once, Always allow (kept for the workspace) and
// Deny. An ask whose call is not known shows the host alone. The card goes once the server has the answer (the chat's
// meta no longer lists it); an answer that fails says why, and the card takes clicks again.
import { useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { HostAsk, HostAskChoice } from '../lib/types'
import { toolSummary, underCorpus } from './model'

/** The choices, in order, with their words. */
export const HOST_CHOICES: readonly { choice: HostAskChoice; words: string }[] = [
  { choice: 'once', words: 'Allow once' },
  { choice: 'always', words: 'Always allow' },
  { choice: 'deny', words: 'Deny' },
]

/** What an ask says of the call whose request it is: Claude's own words for what the call does (`what`, a command's
 * description), and its command, or the URL of a tool other than Bash, on one line as the call's step line has it
 * (`line`) and whole (`full`); '' for what the call does not carry. Pure. */
export function askCall(ask: Pick<HostAsk, 'call'>, ws = ''): { what: string; line: string; full: string } {
  const input = ask.call?.input ?? {}
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const bash = ask.call?.tool === 'Bash'
  const full = bash ? underCorpus(text(input.command), ws) : text(input.url)
  return { what: text(input.description).replace(/\s+/g, ' '), line: bash && full ? toolSummary('Bash', input, ws) : full, full }
}

/** One ask with its choices. */
export function HostAskRow({ ws, ask }: { ws: string; ask: HostAsk }) {
  const [busy, setBusy] = useState<HostAskChoice | null>(null)
  const [whole, setWhole] = useState(false)
  const { what, line, full } = askCall(ask, ws)
  const choose = (choice: HostAskChoice) => {
    if (busy) return
    setBusy(choice)
    api.answerHostAsk(ws, ask.id, choice).catch((e: Error) => {
      // a command that no longer waits takes its card away with the chat's next read
      if (/^404\b/.test(e.message)) return
      setBusy(null)
      bus.emit('toast', { text: `Could not answer: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' })
    })
  }
  return (
    <div className="chat-host-ask" role="group" aria-label={`Allow a connection to ${ask.host}?`} data-ask={ask.id} data-host={ask.host}>
      {what && <p className="chat-host-ask-what">{what}</p>}
      <span className="chat-host-ask-where">
        <Icon name="globe" size={12} className="chat-host-ask-ico" />
        <span className="chat-host-ask-host">{ask.host}</span>
      </span>
      {line && (
        <button type="button" className="chat-host-ask-call" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>
          {whole ? full : line}
        </button>
      )}
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
