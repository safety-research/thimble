// The permission requests waiting for the analyst, as one card pinned above the chat's composer in every chat. It holds
// every session's requests (chat/permissions.ts pendingRequests), oldest first and those declined unanswered last, one
// at a time with paging, whose `1 of 3` counts the requests that still wait, or on one declined unanswered those
// declined unanswered. The card keeps showing the request it shows while others arrive, are answered or time out. Its
// head names the requesting thread (askThread); the body says who asks, what the call does, every later call that
// waits on the same answer (scrolled), and why it asks, then Allow, Always allow (where Claude Code offers a rule for
// the session, or for a web call its site or web search in the workspace; the scope in its tooltip) and Deny, in one
// row. A request declined unanswered says so, with Dismiss, and Dismiss all when several were. When auto mode's
// classifier could not judge a call, the request of a session that is not a background one offers the switch to
// Manual, and to Bypass unless the analyst's Claude Code settings turn it off. An answer takes its request off the card
// at once and the next request can be answered while it is sent; one that fails puts its request back, and one whose
// request had already ended leaves it off. A request that just took the card's place ignores clicks and keys for
// ARM_MS, so a double click never answers the next request unread. Allow covers only the later calls the card listed.
// A long command wraps and scrolls past 96px. A request too long to show whole says how much of it shows and offers no
// "don't ask again".
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { CodeText } from '../components/Code'
import { Icon } from '../components/Icon'
import { TipButton, Tipped } from '../components/Tooltip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { loadSettings } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ChatMeta, PermissionRequest } from '../lib/types'
import { askFields, askWhat, CODE_LANGS } from './Holds'
import { BYPASS_LINE } from './ModeSwitch'
import { ThreadChip } from './Notes'
import { askedBy, askingAgent, asksTo, askThread, askWhy, classifierDown, modeChat, type PendingAsk } from './permissions'

/** A request's "don't ask again" choice: the button's label, and its tooltip saying what it keeps and where. */
function alwaysChoice(p: PermissionRequest): { label: string; tip: string } | null {
  if (p.keep) return { label: `Always allow ${p.keep}`, tip: `Allow, and don't ask again for ${p.keep === 'web search' ? 'web searches' : p.keep} in this workspace` }
  if (p.always) return { label: `Always allow ${p.always}`, tip: `Allow, and don't ask again for ${p.always} for the rest of this session` }
  return null
}

/** The line a request the card shows only the start of carries: how much shows, and that Allow approves all of it. */
export function cutLine(p: Pick<PermissionRequest, 'cut' | 'command' | 'input'>): string | null {
  if (!p.cut) return null
  const shown = (p.command || p.input || '').length
  return `Only the first ${shown.toLocaleString('en-US')} of ${p.cut.toLocaleString('en-US')} characters are shown. Allow approves all of it.`
}

/** Send the analyst's answer to the session that asked: main's prompt through the shim, any other session's through
 * its chat with how many of the later calls the card listed (backend agent_session.permission_route). */
function answer(ws: string, ask: PendingAsk, allow: boolean, always: boolean): Promise<unknown> {
  const shown = ask.request.also?.length ?? 0
  return ask.chat === 'main' ? api.answerPermission(ws, ask.request.id, allow) : api.answerSessionPermission(ws, ask.chat, ask.request.id, allow, always, shown)
}

/** How long a request that just took the card's place ignores clicks and keys. */
export const ARM_MS = 500
/** How long an answer is on its way before the card says it is still being sent. */
export const SLOW_MS = 1000

export const ENDED_TEXT = 'That request had already ended.'
export const SENDING_TEXT = 'Sending your answer…'
export const DECLINED_TITLE = 'Declined because nobody answered'

/** A set with `id` added or taken out. Pure. */
const plus = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...set, id])
const minus = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...set].filter((x) => x !== id))

export function PermissionCard({ ws, asks, metas, labels }: {
  ws: string
  /** the requests waiting (pendingRequests), the one asked first first */
  asks: readonly PendingAsk[]
  metas: ReadonlyMap<string, ChatMeta>
  labels: ReadonlyMap<string, string>
}) {
  // answered here and not yet gone from the session's meta
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  // answers on their way, whose requests the card no longer shows
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const [slow, setSlow] = useState(false)
  // the request the card shows, and where it stood, for the request that takes its place once it goes
  const [at, setAt] = useState<{ id: string | null; i: number }>({ id: null, i: 0 })
  // the request whose buttons take clicks (ARM_MS after it took the card's place)
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // the requests whose answer was sent, read in the same event as the click, so one request is never answered twice
  const sent = useRef(new Set<string>())
  // the sessions whose mode the card has switched, which no longer offer the switch
  const [switched, setSwitched] = useState<ReadonlySet<string>>(new Set())
  // the modes the analyst's Claude Code settings turn off
  const [off, setOff] = useState<readonly string[]>([])
  useEffect(() => {
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setOff(s.disabled_modes ?? []))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  const shown = useMemo(() => asks.filter((a) => !answered.has(a.request.id) && !sending.has(a.request.id)), [asks, answered, sending])
  const found = shown.findIndex((a) => a.request.id === at.id)
  const i = found >= 0 ? found : Math.min(at.i, Math.max(0, shown.length - 1))
  const ask = shown[i] ?? null
  const id = ask?.request.id ?? null
  useEffect(() => {
    if (id !== at.id || i !== at.i) setAt({ id, i })
  }, [id, i, at])
  useEffect(() => {
    if (!id) return
    const timer = window.setTimeout(() => setArmed(id), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [id])
  const ready = id != null && armed === id
  useEffect(() => {
    if (!sending.size) {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS)
    return () => window.clearTimeout(timer)
  }, [sending.size])
  // an answered request is forgotten once its session no longer lists it
  useEffect(() => {
    if (!answered.size) return
    const live = new Set(asks.map((a) => a.request.id))
    if (![...answered].some((x) => !live.has(x))) return
    for (const x of [...sent.current]) if (!live.has(x) && answered.has(x)) sent.current.delete(x)
    setAnswered((cur) => new Set([...cur].filter((x) => live.has(x))))
  }, [asks, answered])
  if (!ask) {
    return slow ? (
      <div className="chat-perm chat-perm-sending" role="status">
        {SENDING_TEXT}
      </div>
    ) : null
  }
  const p = ask.request
  const who = askedBy(ask, metas, labels)
  const agent = askingAgent(p)
  const what = askWhat(p)
  const fields = askFields(p)
  const expired = !!p.expired
  const alike = shown.filter((a) => !!a.request.expired === expired)
  const also = p.also ?? []
  const cut = cutLine(p)
  const always = cut ? null : alwaysChoice(p)
  // while auto mode's classifier gives no verdict, the session's mode can switch from here
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
  // the answer to one request: off the card at once, back on it if the answer could not be sent, and off for good when
  // the request had already ended
  const send = (a: PendingAsk, allow: boolean, always = false) => {
    const rid = a.request.id
    if (sent.current.has(rid)) return
    sent.current.add(rid)
    setSending((cur) => plus(cur, rid))
    track('ui-click', { target: `chat:${a.chat}`, detail: { action: 'permission', tool: a.request.tool, allow, always } })
    answer(ws, a, allow, always)
      .then(() => setAnswered((cur) => plus(cur, rid)))
      .catch((e: Error) => {
        if (/^404\b/.test(e.message)) {
          setAnswered((cur) => plus(cur, rid))
          if (!a.request.expired) bus.emit('toast', { text: ENDED_TEXT })
          return
        }
        sent.current.delete(rid)
        setAt({ id: rid, i: 0 })
        bus.emit('toast', { text: `Could not answer: ${e.message}`, kind: 'error' })
      })
      .finally(() => setSending((cur) => minus(cur, rid)))
  }
  const reply = (allow: boolean, always = false) => {
    if (!ready) return
    // focus stays on the card, where Tab reaches the next request's buttons, rather than on a button that leaves
    if (root.current?.contains(document.activeElement)) root.current.focus({ preventScroll: true })
    send(ask, allow, always)
  }
  const dismissAll = () => {
    if (!ready) return
    if (root.current?.contains(document.activeElement)) root.current.focus({ preventScroll: true })
    for (const a of alike) send(a, false)
  }
  const gate = { 'aria-disabled': !ready || undefined }
  return (
    <div ref={root} tabIndex={-1} className={`chat-perm${shown.length > 1 ? ' chat-perm-stack' : ''}`} role="alertdialog" aria-label={expired ? DECLINED_TITLE : 'Permission needed'} data-chat={ask.chat} data-request={p.id} data-count={shown.length} data-expired={expired || undefined} data-armed={ready || undefined}>
      <div className="chat-perm-head">
        <Icon name="warning" size={13} className="chat-perm-ico" />
        <span className="chat-perm-title">{expired ? DECLINED_TITLE : 'Permission needed'}</span>
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
        <p className="chat-perm-why">{askWhy(ask, metas)}</p>
        {switchChat && !switched.has(switchChat) && (
          <div className="chat-perm-switch" data-chat={switchChat}>
            <Button variant="secondary" size="sm" className="chat-perm-manual" disabled={busy} onClick={() => switchTo('manual')}>
              Switch to Manual
            </Button>
            {!off.includes('bypass') && (
              <Button variant="secondary" size="sm" className="chat-perm-bypass" title={BYPASS_LINE} disabled={busy} onClick={() => switchTo('bypass')}>
                Switch to Bypass
              </Button>
            )}
          </div>
        )}
      </div>
      {expired ? (
        <div className="chat-perm-acts">
          <Button variant="secondary" size="sm" className="chat-perm-dismiss" {...gate} onClick={() => reply(false)}>
            Dismiss
          </Button>
          {alike.length > 1 && (
            <Button variant="ghost" size="sm" className="chat-perm-dismiss-all" {...gate} onClick={dismissAll}>
              Dismiss all
            </Button>
          )}
        </div>
      ) : (
        <div className="chat-perm-acts">
          <Button variant="primary" size="sm" className="chat-perm-allow" {...gate} onClick={() => reply(true)}>
            Allow
          </Button>
          {always && (
            <Tipped text={always.tip} className="chat-perm-always-tip">
              <Button variant="secondary" size="sm" className="chat-perm-always" data-keep={p.keep} {...gate} onClick={() => reply(true, true)}>
                {always.label}
              </Button>
            </Tipped>
          )}
          <Button variant="ghost" size="sm" className="chat-perm-deny" {...gate} onClick={() => reply(false)}>
            Deny
          </Button>
        </div>
      )}
      {slow && (
        <p className="chat-perm-sent" role="status">
          {SENDING_TEXT}
        </p>
      )}
    </div>
  )
}
