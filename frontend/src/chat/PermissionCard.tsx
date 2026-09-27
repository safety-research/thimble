// The permission requests waiting for the analyst, as one card pinned above the chat's composer in every chat. It holds
// every session's requests (chat/permissions.ts pendingRequests), oldest first and those denied unanswered last, one at
// a time with `1 of 3` paging. Its head names the requesting thread (askThread); the body says who asks, what the call
// does, the later calls that wait on the same answer, and why it asks, then Allow, Allow and don't ask again (where
// Claude Code offers a rule, or for a web call its site or web search in the workspace) and Deny. A request denied
// unanswered says so, with Dismiss. When auto mode cannot decide in a session, an orientation's request offers the
// switch to Manual or Bypass. An answer hides the request at once. A long command wraps and scrolls past 96px.
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { CodeText } from '../components/Code'
import { Icon } from '../components/Icon'
import { TipButton } from '../components/Tooltip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ChatMeta } from '../lib/types'
import { askFields, askWhat, CODE_LANGS } from './Holds'
import { BYPASS_LINE } from './ModeSwitch'
import { ThreadChip } from './Notes'
import { askedBy, askingAgent, asksTo, askThread, askWhy, classifierDown, modeChat, type PendingAsk } from './permissions'

/** How many of a request's later calls the card lists before it counts the rest. */
const ALSO_SHOWN = 5

/** Send the analyst's answer to the session that asked: main's prompt through the shim, any other session's through
 * its chat (backend agent_session.permission_route). */
function answer(ws: string, ask: PendingAsk, allow: boolean, always: boolean): Promise<unknown> {
  return ask.chat === 'main' ? api.answerPermission(ws, ask.request.id, allow) : api.answerSessionPermission(ws, ask.chat, ask.request.id, allow, always)
}

export function PermissionCard({ ws, asks, metas, labels }: {
  ws: string
  /** the requests waiting (pendingRequests), the one asked first first */
  asks: readonly PendingAsk[]
  metas: ReadonlyMap<string, ChatMeta>
  labels: ReadonlyMap<string, string>
}) {
  // answered here and not yet gone from the session's meta
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState(0)
  // the sessions whose mode the card has switched, which no longer offer the switch
  const [switched, setSwitched] = useState<ReadonlySet<string>>(new Set())
  const shown = useMemo(() => asks.filter((a) => !answered.has(a.request.id)), [asks, answered])
  const i = Math.min(at, Math.max(0, shown.length - 1))
  const ask = shown[i] ?? null
  // an answered request is forgotten once its session no longer lists it
  useEffect(() => {
    if (!answered.size) return
    const live = new Set(asks.map((a) => a.request.id))
    if ([...answered].some((id) => !live.has(id))) setAnswered((cur) => new Set([...cur].filter((id) => live.has(id))))
  }, [asks, answered])
  if (!ask) return null
  const p = ask.request
  const who = askedBy(ask, metas, labels)
  const agent = askingAgent(p)
  const what = askWhat(p)
  const fields = askFields(p)
  const expired = !!p.expired
  const also = p.also ?? []
  // auto mode that cannot decide in this session asks about every call: the orientation's mode can switch from here
  const switchChat = classifierDown(p) ? modeChat(ask, metas) : null
  const switchTo = (mode: 'manual' | 'bypass') => {
    if (!switchChat) return
    const chat = switchChat
    setBusy(true)
    track('ui-click', { target: `chat:${chat}`, detail: { action: 'permission-mode', mode, from: 'permission-card' } })
    api
      .setSessionMode(ws, chat, mode)
      .then(() => setSwitched((cur) => new Set([...cur, chat])))
      .catch((e: Error) => bus.emit('toast', { text: `Could not switch to ${mode === 'manual' ? 'Manual' : 'Bypass'}: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  const reply = (allow: boolean, always = false) => {
    setBusy(true)
    track('ui-click', { target: `chat:${ask.chat}`, detail: { action: 'permission', tool: p.tool, allow, always } })
    answer(ws, ask, allow, always)
      .then(() => setAnswered((cur) => new Set([...cur, p.id])))
      .catch((e: Error) => bus.emit('toast', { text: `Could not answer: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="chat-perm" role="alertdialog" aria-label={expired ? 'Denied unanswered' : 'Permission needed'} data-chat={ask.chat} data-request={p.id} data-count={shown.length} data-expired={expired || undefined}>
      <div className="chat-perm-head">
        <Icon name="warning" size={13} className="chat-perm-ico" />
        <span className="chat-perm-title">{expired ? 'Denied unanswered' : 'Permission needed'}</span>
        <span className="chat-perm-from">
          <span className="chat-perm-from-word">from</span>
          <ThreadChip id={askThread(ask)} />
        </span>
        {shown.length > 1 && (
          <span className="chat-perm-pager">
            <span className="chat-perm-count">{`${i + 1} of ${shown.length}`}</span>
            <TipButton tip="Previous request" className="chat-perm-page" disabled={i === 0} onClick={() => setAt(i - 1)}>
              <Icon name="chevron-left" size={12} />
            </TipButton>
            <TipButton tip="Next request" className="chat-perm-page" disabled={i === shown.length - 1} onClick={() => setAt(i + 1)}>
              <Icon name="chevron-right" size={12} />
            </TipButton>
          </span>
        )}
      </div>
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
      {also.length > 0 && (
        <div className="chat-perm-also" data-count={also.length}>
          <span className="chat-perm-key label">{p.tool === 'WebSearch' ? 'and the searches' : 'and from this site'}</span>
          <ul className="chat-perm-also-list">
            {also.slice(0, ALSO_SHOWN).map((a, k) => (
              <li key={k}>{a}</li>
            ))}
            {also.length > ALSO_SHOWN && <li className="chat-perm-also-more">{`${also.length - ALSO_SHOWN} more`}</li>}
          </ul>
        </div>
      )}
      <p className="chat-perm-why">{askWhy(ask, metas)}</p>
      {switchChat && !switched.has(switchChat) && (
        <div className="chat-perm-switch" data-chat={switchChat}>
          <Button variant="secondary" size="sm" className="chat-perm-manual" disabled={busy} onClick={() => switchTo('manual')}>
            Switch to Manual
          </Button>
          <Button variant="secondary" size="sm" className="chat-perm-bypass" title={BYPASS_LINE} disabled={busy} onClick={() => switchTo('bypass')}>
            Switch to Bypass
          </Button>
        </div>
      )}
      {expired ? (
        <div className="chat-perm-acts">
          <Button variant="secondary" size="sm" className="chat-perm-dismiss" disabled={busy} onClick={() => reply(false)}>
            Dismiss
          </Button>
        </div>
      ) : (
        <div className="chat-perm-acts">
          <Button variant="primary" size="sm" className="chat-perm-allow" disabled={busy} onClick={() => reply(true)}>
            Allow
          </Button>
          {p.keep ? (
            <Button variant="secondary" size="sm" className="chat-perm-always" data-keep={p.keep} disabled={busy} onClick={() => reply(true, true)}>
              Allow and don't ask again for {p.keep === 'web search' ? 'web search' : <span className="chat-perm-rule">{p.keep}</span>} in this workspace
            </Button>
          ) : (
            p.always && (
              <Button variant="secondary" size="sm" className="chat-perm-always" disabled={busy} onClick={() => reply(true, true)}>
                Allow and don't ask again for <span className="chat-perm-rule">{p.always}</span>
              </Button>
            )
          )}
          <Button variant="ghost" size="sm" className="chat-perm-deny" disabled={busy} onClick={() => reply(false)}>
            Deny
          </Button>
        </div>
      )}
    </div>
  )
}
