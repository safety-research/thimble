// The permission requests waiting for the analyst, as one card pinned above the chat's composer in every chat, read-only:
// Claude Code asks in the terminal, which is always there, and the analyst answers there (thimble 0.9.0 answers no
// permission request from the browser). It holds every session's requests (chat/permissions.ts pendingRequests), oldest
// first and those declined unanswered last, one at a time with paging, whose `1 of 3` counts the requests that still
// wait, or on one declined unanswered those declined unanswered. The card keeps showing the request it shows while
// others arrive, are answered or time out. Its head names the requesting thread (askThread); the body says who asks,
// what the call does, every later call that waits on the same answer (scrolled), and why it asks; its foot says to
// answer in the terminal (TERMINAL_LINE). A long command wraps and scrolls past 96px. A request too long to show whole
// says how much of it shows.
import { useEffect, useState } from 'react'
import { CodeText } from '../components/Code'
import { Icon } from '../components/Icon'
import { TipButton } from '../components/Tooltip'
import type { ChatMeta, PermissionRequest } from '../lib/types'
import { askFields, askWhat, CODE_LANGS } from './Holds'
import { ThreadChip } from './Notes'
import { askedBy, askingAgent, asksTo, askThread, askWhy, type PendingAsk } from './permissions'

/** How long a card that just showed ignores clicks and keys, so a double click never acts on it unread (the proposal
 * card's Accept). */
export const ARM_MS = 500

/** The title of a request declined because nobody answered it in time. */
export const EXPIRED_TITLE = 'Not answered in time'

/** The line a request the card shows only the start of carries: how much shows. */
export function cutLine(p: Pick<PermissionRequest, 'cut' | 'command' | 'input'>): string | null {
  if (!p.cut) return null
  const shown = (p.command || p.input || '').length
  return `Only the first ${shown.toLocaleString('en-US')} of ${p.cut.toLocaleString('en-US')} characters are shown.`
}

/** Where every request is answered: Claude Code's own dialog in the terminal. */
export const TERMINAL_LINE = 'Answer it in your Claude Code terminal.'

export function PermissionCard({ asks, metas, labels }: {
  ws: string
  /** the requests waiting (pendingRequests), the one asked first first */
  asks: readonly PendingAsk[]
  metas: ReadonlyMap<string, ChatMeta>
  labels: ReadonlyMap<string, string>
}) {
  // the request the card shows, and where it stood, for the request that takes its place once it goes
  const [at, setAt] = useState<{ id: string | null; i: number }>({ id: null, i: 0 })
  const shown = asks
  const found = shown.findIndex((a) => a.request.id === at.id)
  const i = found >= 0 ? found : Math.min(at.i, Math.max(0, shown.length - 1))
  const ask = shown[i] ?? null
  const id = ask?.request.id ?? null
  useEffect(() => {
    if (id !== at.id || i !== at.i) setAt({ id, i })
  }, [id, i, at])
  if (!ask) return null
  const p = ask.request
  const who = askedBy(ask, metas, labels)
  const agent = askingAgent(p)
  const what = askWhat(p)
  const fields = askFields(p)
  const expired = !!p.expired
  const alike = shown.filter((a) => !!a.request.expired === expired)
  const also = p.also ?? []
  const cut = cutLine(p)
  const why = askWhy(ask, metas, labels)
  // the agents' own lines already say where they ask (terminalAsksLine)
  const foot = expired || /\bterminal\b/.test(why) ? null : TERMINAL_LINE
  return (
    <div tabIndex={-1} className={`chat-perm chat-perm-terminal${shown.length > 1 ? ' chat-perm-stack' : ''}`} role="alertdialog" aria-label={expired ? EXPIRED_TITLE : 'Permission needed'} data-chat={ask.chat} data-request={p.id} data-count={shown.length} data-expired={expired || undefined} data-terminal>
      <div className="chat-perm-head">
        <Icon name="warning" size={13} className="chat-perm-ico" />
        <span className="chat-perm-title">{expired ? EXPIRED_TITLE : 'Permission needed'}</span>
        <span className="chat-perm-from">
          <span className="chat-perm-from-word">from</span>
          <ThreadChip id={askThread(ask, metas, labels)} />
        </span>
        {shown.length > 1 && (
          <span className="chat-perm-pager">
            {alike.length > 1 && <span className="chat-perm-count">{`${alike.indexOf(ask) + 1} of ${alike.length}`}</span>}
            <TipButton tip="Previous request" className="chat-perm-page" disabled={i === 0} onClick={() => setAt({ id: shown[i - 1].request.id, i: i - 1 })}>
              <Icon name="chevron-left" size={12} />
            </TipButton>
            <TipButton tip="Next request" className="chat-perm-page" disabled={i === shown.length - 1} onClick={() => setAt({ id: shown[i + 1].request.id, i: i + 1 })}>
              <Icon name="chevron-right" size={12} />
            </TipButton>
          </span>
        )}
      </div>
      <div className="chat-perm-body">
        <p className="chat-perm-who">
          <span className="chat-perm-session">{agent ? `${who}'s ${agent.type && !agent.title ? `${agent.type} ` : ''}agent` : who}</span>
          {agent?.title && (agent.chat ? <ThreadChip id={agent.chat} label={agent.title} /> : <span className="chat-perm-agent">{agent.title}</span>)}
          {agent?.title && agent.type && <span className="chat-perm-type">({agent.type})</span>}
          <span>{`${expired ? 'asked' : 'asks'} to ${asksTo(p.tool)}`}</span>
        </p>
        {what && <p className="chat-perm-what">{what}</p>}
        {fields.map((f, k) =>
          f.code ? (
            <pre key={`${f.key}:${k}`} className="chat-perm-code" data-field={f.key}>
              <CodeText text={f.value} lang={CODE_LANGS[f.key] ?? (f.value.startsWith('{') || f.value.startsWith('[') ? 'json' : null)} />
            </pre>
          ) : (
            <p key={`${f.key}:${k}`} className="chat-perm-field" data-field={f.key}>
              {f.key && <span className="chat-perm-key label">{f.key.replace(/_/g, ' ')}</span>}
              <span className="chat-perm-value">{f.value}</span>
            </p>
          ),
        )}
        {cut && (
          <p className="chat-perm-cut" role="note">
            {cut}
          </p>
        )}
        {also.length > 0 && (
          <div className="chat-perm-also" data-count={also.length}>
            <span className="chat-perm-key label">{p.tool === 'WebSearch' ? 'and the searches' : 'and from this site'}</span>
            <ul className="chat-perm-also-list">
              {also.map((a, k) => (
                <li key={k}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="chat-perm-why">{why}</p>
        {foot && (
          <p className="chat-perm-answer-there" role="note">
            {foot}
          </p>
        )}
      </div>
    </div>
  )
}
