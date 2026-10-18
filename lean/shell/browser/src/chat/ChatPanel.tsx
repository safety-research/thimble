// ChatPanel.tsx: 0.9's chat column on lean's records. At the top the thread tree (› main, and each side thread: one
// asked from a cite or explain card, or a card's thread); below it the current thread's conversation; at the foot
// the composer, whose words go to the terminal session (main) or to the side thread. Main's rows are the session's
// message records (thimble/messages/<session>/); a thread's are its file (thimble/threads/<session>/<id>.json).
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ComposerFrame } from '@09/components/Composer'
import { Spinner } from '@09/components/Spinner'
import { ThreadTree, type ThreadNode } from '@09/components/ThreadTree'
import { UserMessage } from '@09/components/Message'
import { Message } from './Message'
import { CitedText } from '../lib/marks'
import { ask, pushCite } from '../lib/actions'
import { hhmm } from '../lib/api'
import { cardThread, getState, setState, useStore, type Row, type Thread } from '../lib/store'

const aboutOf = (t: Thread) => {
  const sc = t.scope || {}
  if (sc.mark && !sc.object) return String(sc.mark.term || sc.mark.label || sc.mark.ref || 'a mark')
  return String(t.title || sc.label || sc.region || sc.object || t.id)
}
/** A thread's name in the tree: a card's thread by the card, a mark's by its first question (cut), else what it is about. */
export const threadName = (t: Thread) => {
  if (t.scope?.object) return t.title || t.scope.object
  const q = t.turns.find((x) => x.role === 'user')?.text?.split('\n')[0]?.trim()
  return q ? (q.length > 44 ? q.slice(0, 43) + '…' : q) : aboutOf(t)
}

export function ChatPanel() {
  const rows = useStore((s) => s.rows)
  const threads = useStore((s) => s.threads)
  const current = useStore((s) => s.thread)
  const card = useStore((s) => s.card)
  const objects = useStore((s) => s.objects)
  const loaded = useStore((s) => s.loaded)
  const problem = useStore((s) => s.problem)
  const sent = useStore((s) => s.sent)
  const [collapsed, setCollapsed] = useState(true)
  const [draft, setDraft] = useState('')

  // the card's thread while its detail is open: its file once there is one, else a thread to start
  const cardInfo = card ? objects.find((o) => o.id === card.id) : null
  const ownThread = card ? cardThread(threads, card.id) : null
  const pseudo = card && !ownThread ? `card:${card.id}` : null
  useEffect(() => {
    if (card) setState({ thread: ownThread ? ownThread.id : `card:${card.id}` })
  }, [card?.id, ownThread?.id])

  // a question asked from a cite or explain card: its side thread, once the terminal session has started it
  const pending = useStore((s) => s.pendingThread)
  useEffect(() => {
    if (!pending) return
    const t = threads.find((x) => {
      const m = x.scope?.mark
      return !!m && [m.ref, m.gloss, m.term, m.label].includes(pending.ref) && (!pending.row || !x.scope?.row || x.scope.row === pending.row)
    })
    if (t) setState({ thread: t.id, pendingThread: null })
    else if (Date.now() - pending.at > 120000) setState({ pendingThread: null })
  }, [threads, pending])

  const working = useMemo(() => isWorking(rows), [rows])
  const nodes: ThreadNode[] = useMemo(() => {
    const list: ThreadNode[] = [{ id: 'main', name: 'main', parent: null, fixed: true, running: working }]
    for (const t of threads) {
      const name = threadName(t)
      const running = t.status === 'running' || t.status === 'asking'
      list.push({ id: t.id, name, path: `main/${name}`, parent: 'main', running, ended: running ? undefined : t.status === 'failed' ? 'failed' : t.turns.some((x) => x.role === 'assistant') ? 'done' : undefined, time: running ? undefined : hhmm(t.updated || t.at) })
    }
    if (pseudo) {
      const name = cardInfo?.title || card!.id
      list.push({ id: pseudo, name, path: `main/${name}`, parent: 'main' })
    }
    return list
  }, [threads, working, pseudo, cardInfo?.title])

  const thread = current === 'main' || current.startsWith('card:') ? null : threads.find((t) => t.id === current) ?? null
  const isMain = current === 'main' || (!thread && !current.startsWith('card:'))
  const curPath = isMain ? 'main' : nodes.find((n) => n.id === current)?.path ?? 'main'

  const list = useRef<HTMLDivElement>(null)
  const near = useRef(true)
  useLayoutEffect(() => {
    const el = list.current
    if (el && near.current) el.scrollTop = el.scrollHeight
  })

  const send = async () => {
    const text = draft
    let scope = {}
    if (thread) scope = { ...(thread.scope || {}), thread: thread.id }
    else if (current.startsWith('card:') && card) scope = { object: card.id, ...(card.v != null ? { v: card.v } : {}), ...(card.region ? { region: card.region } : {}), label: cardInfo?.title }
    setDraft('')
    near.current = true
    if (!(await ask(text, scope))) setDraft(text)
  }

  return (
    <section className="chat" data-panel="chat" data-chat-current={current} aria-label="Chat">
      <header className="chat-head">
        <ThreadTree
          className="chat-tree"
          nodes={nodes}
          current={isMain ? 'main' : current}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onPick={(id) => {
            setState({ thread: id })
            if (id === 'main' && getState().card) setState({ card: null })
          }}
        />
      </header>
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="chat-flow">
          {!loaded && (
            <div className="chat-empty">
              <Spinner size={14} label="Loading" />
            </div>
          )}
          {problem && <div className="chat-error">{problem}</div>}
          {loaded && isMain && <MainRows rows={rows} working={working} />}
          {loaded && thread && <ThreadRows thread={thread} />}
          {loaded && !isMain && !thread && card && <CardThreadStart title={cardInfo?.title || card.id} />}
        </div>
      </div>
      <div className="chat-foot">
        {sent && (
          <div className="chat-foot-cards">
            <div className={`chat-row chat-note lean-sent${sent.error ? ' is-error' : ''}`} role="status">
              <span className="chat-note-text">{sent.text}</span>
            </div>
          </div>
        )}
        <ComposerFrame
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          placeholder={`Reply in ${curPath}…`}
          model={<span className="lean-composer-to">{isMain ? 'to the terminal session' : 'a side thread · main does not see it'}</span>}
          rows={2}
          data-anchor="ui:composer"
        />
      </div>
    </section>
  )
}

/** Claude works on a prompt with no final answer yet. */
function isWorking(rows: Row[]): boolean {
  const last = rows[rows.length - 1]
  if (!last) return false
  if (last.kind === 'user') return true
  return !!last.record && last.record.final === false
}

function MainRows({ rows, working }: { rows: Row[]; working: boolean }) {
  const asks = useStore((s) => s.asks)
  const flash = useStore((s) => s.flashRow)
  useEffect(() => {
    if (!flash) return
    const el = document.querySelector(`.chat [data-row="${CSS.escape(flash)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('lean-flash')
    setState({ flashRow: null })
    window.setTimeout(() => el.classList.remove('lean-flash'), 2400)
  }, [flash, rows.length])
  if (!rows.length)
    return (
      <div className="chat-empty lean-chat-empty">
        <p>No messages yet. Each prompt and each of Claude's answers in the terminal session shows here.</p>
      </div>
    )
  return (
    <>
      {rows.map((r) => {
        if (r.kind === 'user') {
          const fromHere = asks.some((a) => a.text.trim() === String(r.text || '').trim())
          return (
            <div key={r.row} className="chat-msg chat-user" data-row={r.row}>
              {fromHere && (
                <div className="chat-row chat-note chat-origin chat-by">
                  <span className="chat-note-text">From the browser</span>
                </div>
              )}
              <UserMessage className="chat-message">{r.text}</UserMessage>
            </div>
          )
        }
        if (!r.record) return null
        return <Message key={r.row} row={r} />
      })}
      {working && (
        <div className="chat-msg chat-working-row lean-working" aria-label="working">
          <Spinner label="working" />
          <span>Claude is working in the terminal</span>
        </div>
      )}
    </>
  )
}

/** A side thread: where it was asked from, then its turns. */
function ThreadRows({ thread }: { thread: Thread }) {
  const sc = thread.scope || {}
  const about = sc.mark && !sc.object ? `${sc.mark.kind === 'gloss' ? 'the term' : 'the citation'} “${aboutOf(thread)}”` : sc.object ? `the card “${thread.title || sc.object}”${sc.label && sc.label !== thread.title ? ` · ${sc.label}` : ''}` : aboutOf(thread)
  const running = thread.status === 'running' || thread.status === 'asking'
  return (
    <>
      <div className="chat-row chat-note chat-origin">
        <span className="chat-note-text">Started from main, about {about}. Main does not see this thread.</span>
      </div>
      {thread.turns.map((t, i) =>
        t.role === 'user' ? (
          <div key={i} className="chat-msg chat-user">
            <UserMessage className="chat-message">{t.text}</UserMessage>
            {t.about && (
              <div className="chat-row chat-note lean-about">
                <span className="chat-note-text">about {t.about}</span>
              </div>
            )}
          </div>
        ) : (
          <Fragment key={i}>
            {t.calls?.length ? (
              <div className="chat-msg chat-calls">
                {t.calls.slice(0, 6).map((c, k) => {
                  const [tool, ...rest] = /^(Read|Grep|Glob|Write|Edit|WebFetch)\b/.test(c) ? c.split(' ') : ['Bash', ...c.split(' ')]
                  return (
                    <div key={k} className="chat-call" data-state="done">
                      <span className="chat-call-head">
                        <span className="chat-call-state">
                          <span className="chat-call-dot" />
                        </span>
                        <span className="chat-call-chip">
                          <span className="chat-call-tool">{tool}</span> <span className="chat-call-target">{rest.join(' ')}</span>
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
            {t.text && (
              <div className="chat-msg chat-assistant">
                <div className="chat-text">
                  <CitedText text={t.text} onCite={(ref, label) => pushCite({ kind: 'cite', ref, label })} />
                </div>
              </div>
            )}
          </Fragment>
        ),
      )}
      {running && (
        <div className="chat-msg chat-working-row lean-working" aria-label="working">
          <Spinner label="working" />
          <span>the thread is answering</span>
        </div>
      )}
      {thread.status === 'failed' && thread.error && <div className="chat-error">{thread.error}</div>}
    </>
  )
}

function CardThreadStart({ title }: { title: string }) {
  return (
    <div className="chat-row chat-note chat-origin">
      <span className="chat-note-text">The thread of the card “{title}”. Ask about the card or a part you select; the answer comes here, and main does not see it.</span>
    </div>
  )
}
