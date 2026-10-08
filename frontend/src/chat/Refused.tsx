// A start of one of thimble's agents that did not happen, as one card wherever the agent would have shown: the
// orientation's in main, a writer's on its document, a view build's on its chip, a check's on its row. It names the
// agent, says why on one line in the words of whoever refused (Claude Code's auto mode, main's own reply, Claude Code's
// subagent limit, thimble's own check, or no hooks module), shows the request in full (the text the agent would get,
// its role, model and effort) since main may have written it, and offers the kind's buttons (refusalActions): Start it
// (a click through thimble's plugin: the analyst's own approval, which auto mode does not judge), Edit request, Try
// again and Dismiss. Every button is a click, which the server takes only with the analyst's cookie (403 otherwise).
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { modelLabel } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ChatMeta, Refusal, RefusalKind, StartAnswer, SubagentRequest } from '../lib/types'
import { useChatMetas } from './waiting'

/** The buttons a refused start offers, by its kind (plan section 2, "A start that does not happen"). */
export type RefusedAction = 'start-it' | 'edit' | 'try-again' | 'dismiss'

/** The kind's buttons: Start it and Edit request for a typed start auto mode refused or main did not make; Try again
 * at Claude Code's subagent limit and for a click thimble's module did not answer in time; Dismiss always. Never Try
 * again on an auto-mode refusal, whose text tells main not to pursue it again. Pure. */
export function refusalActions(kind: RefusalKind | null | undefined, expired = false): RefusedAction[] {
  if (kind === 'auto-mode' || kind === 'no-call') return ['start-it', 'edit', 'dismiss']
  if (kind === 'limit') return ['try-again', 'dismiss']
  if (kind === 'no-module' && expired) return ['try-again', 'dismiss']
  return ['dismiss']
}

/** The cap Claude Code's limit text names: "You can run 2 subagents at once", "2 spawns are running at once", "at most
 * 20 concurrent subagents"; null when it names none. Pure. */
export function limitOf(reason: string | null | undefined): number | null {
  const m = /\b(\d+)\s+(?:concurrent\s+)?(?:subagents|spawns)\b/i.exec(reason ?? '')
  return m ? Number(m[1]) : null
}

/** Whether a slot is free again after a start Claude Code refused at its subagent limit, as the chats count it: fewer
 * subagents of main run than the cap its text names, or, with no cap named, one ended after the refusal (`at`). Try
 * again waits for it (plan section 2: "enabled once the mirror counts a free slot"; live check L19). Pure. */
export function slotFree(metas: readonly Pick<ChatMeta, 'kind' | 'status' | 'ts_end'>[], reason: string | null | undefined, at: string | null | undefined): boolean {
  const running = metas.filter((m) => m.kind === 'agent' && m.status === 'running').length
  const cap = limitOf(reason)
  if (cap != null) return running < cap
  const since = at ? Date.parse(at) : NaN
  return Number.isNaN(since) || metas.some((m) => m.kind === 'agent' && !!m.ts_end && Date.parse(m.ts_end) > since)
}

/** Try again's tooltip while it waits for a free slot. */
export const WAIT_SLOT_LINE = 'Try again is offered once one of the running subagents ends.'

/** What the card's head says: the agent named, and that it did not start. Pure. */
export const refusedTitle = (what: string): string => `${what.charAt(0).toUpperCase()}${what.slice(1)} didn't start`

/** The first two lines of main's reply, as the no-call line quotes it. Pure. */
export function firstLines(text: string, n = 2): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' ')
}

/** The text when thimble's module held the long poll and did not answer a click in time. */
export const NO_ANSWER_LINE = "Your Claude Code session's thimble module did not answer."

/** The line that says why, by kind, with the reason as Claude Code or thimble gave it. Pure. */
export function refusalLine(r: Pick<Refusal, 'kind' | 'reason' | 'expired'>): string {
  const reason = (r.reason ?? '').trim()
  const dot = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`)
  switch (r.kind) {
    case 'auto-mode':
      return `Claude Code's auto mode refused main's call to start it${reason ? `: ${dot(reason)}` : '.'}`
    case 'no-call':
      return `Your Claude Code session did not start it.${reason ? ` It said: ${dot(firstLines(reason))}` : ''}`
    case 'limit': {
      const n = /\b(\d+)\b/.exec(reason)?.[1]
      return n
        ? `Claude Code runs at most ${n} subagents at once in this session, and that many are running (thread forks and the subagents of running agents, the orientation's own and its critic, count too). Start it again when some finish, or raise \`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS\` and restart.`
        : dot(reason || 'Claude Code runs as many subagents as it allows at once in this session')
    }
    case 'no-module':
      return r.expired ? NO_ANSWER_LINE : dot(reason || "thimble's agents can't start in this session: Claude Code's hooks modules are off")
    default:
      return dot(reason || 'It was refused')
  }
}

/** The line an auto-mode refusal adds: where the terminal approves it. */
export const PERMISSIONS_LINE = 'Or approve it in your terminal: /permissions → Recently denied.'

/** A role's name as the request's line names it. */
const ROLE_WORDS: Readonly<Record<string, string>> = {
  orientation: 'thimble:orientation',
  writer: 'thimble:writer',
  critic: 'thimble:critic',
  'view-builder': 'thimble:view-builder',
  'view-reviewer': 'thimble:view-reviewer',
  check: 'thimble:check',
}

/** The request's line: its type, then its model and effort. Pure. */
export function requestLine(r: Pick<SubagentRequest, 'role' | 'input' | 'values'>): string {
  const type = r.input?.subagent_type || (r.role ? ROLE_WORDS[r.role] ?? `thimble:${r.role}` : '')
  const model = r.values?.model ? modelLabel(r.values.model) : ''
  const values = [model, r.values?.effort ?? ''].filter(Boolean).join(' · ')
  return [type, values].filter(Boolean).join(' · ')
}

/** What a Start it or Try again answered, as a toast when it did not start; true when it started. */
function answered(what: string, a: StartAnswer): boolean {
  if (a.agentId || a.program) return true
  bus.emit('toast', { text: `${refusedTitle(what)}: ${refusalLine({ kind: a.kind ?? 'error', reason: a.reason ?? '', expired: a.expired })}`, kind: 'error' })
  return false
}

export function RefusedCard({ ws, what, refusal, text, onDismiss, onEdit, onStarted, className = '' }: {
  ws: string
  /** the agent, as the head names it: "the orientation", "the report's writer", "the view Posts" */
  what: string
  refusal: Refusal
  /** the request as the analyst or main wrote it, when the record keeps it apart from the full task */
  text?: string | null
  onDismiss?: () => void
  /** Edit request: the start's own form, filled in (the Start gate) */
  onEdit?: () => void
  onStarted?: (a: StartAnswer) => void
  className?: string
}) {
  const rid = refusal.request ?? null
  const [req, setReq] = useState<SubagentRequest | null>(null)
  const [busy, setBusy] = useState<RefusedAction | null>(null)
  const actions = refusalActions(refusal.kind, !!refusal.expired).filter((a) => (a === 'edit' ? !!onEdit : a === 'dismiss' ? !!onDismiss : !!rid))
  // at Claude Code's subagent limit, Try again waits until the chats count a free slot
  const limited = refusal.kind === 'limit'
  const metas = useChatMetas(ws, limited)
  const free = !limited || slotFree(metas, refusal.reason, refusal.at)
  useEffect(() => {
    setReq(null)
    if (!rid) return
    let alive = true
    api
      .subagentRequest(ws, rid)
      .then((r) => alive && setReq(r))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, rid])
  const act = (a: RefusedAction) => {
    if (a === 'dismiss') return onDismiss?.()
    if (a === 'edit') return onEdit?.()
    if (!rid) return
    setBusy(a)
    track('ui-click', { target: `request:${rid}`, detail: { action: a, kind: refusal.kind } })
    ;(a === 'start-it' ? api.startIt(ws, rid) : api.again(ws, rid))
      .then((ans) => answered(what, ans) && onStarted?.(ans))
      .catch((e: Error) => bus.emit('toast', { text: `Could not start it: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const prompt = req?.input?.prompt?.trim() ?? ''
  const line = req ? requestLine(req) : ''
  return (
    <div className={`chat-msg chat-refused${className ? ` ${className}` : ''}`} role="status" data-kind={refusal.kind} data-request={rid ?? undefined}>
      <div className="chat-refused-head">
        <Icon name="warning" size={13} className="chat-refused-ico" />
        <span className="chat-refused-title">{refusedTitle(what)}</span>
      </div>
      <p className="chat-refused-why">{refusalLine(refusal)}</p>
      {refusal.kind === 'auto-mode' && <p className="chat-refused-note">{PERMISSIONS_LINE}</p>}
      {(text || prompt || line) && (
        <details className="chat-refused-request" open={actions.includes('start-it')}>
          <summary>
            <span className="label">request</span>
            {text && <span className="chat-refused-text">{text}</span>}
          </summary>
          {line && <p className="chat-refused-line">{line}</p>}
          {prompt ? <pre className="chat-refused-prompt">{prompt}</pre> : rid && !req ? <Spinner size={10} label="Reading the request" /> : null}
        </details>
      )}
      {actions.length > 0 && (
        <div className="chat-refused-acts">
          {actions.map((a) =>
            a === 'start-it' ? (
              <Button key={a} variant="primary" size="sm" className="chat-refused-start" busy={busy === a} disabled={!!busy} onClick={() => act(a)}>
                Start it
              </Button>
            ) : a === 'try-again' ? (
              <Button key={a} variant="secondary" size="sm" className="chat-refused-again" busy={busy === a} disabled={!!busy || !free} title={free ? undefined : WAIT_SLOT_LINE} onClick={() => act(a)}>
                Try again
              </Button>
            ) : a === 'edit' ? (
              <Button key={a} variant="secondary" size="sm" className="chat-refused-edit" disabled={!!busy} onClick={() => act(a)}>
                Edit request
              </Button>
            ) : (
              <Button key={a} variant="ghost" size="sm" className="chat-refused-dismiss" disabled={!!busy} onClick={() => act(a)}>
                Dismiss
              </Button>
            ),
          )}
        </div>
      )}
    </div>
  )
}
