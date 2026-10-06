// The Claude Code session behind the workspace, as the whole page shows it. While no session is attached to main, the
// shell is greyed out and inert under a scrim and one card (portaled to the body, with every other body layer inert
// too) that gives the command to reconnect. thimble's agents are subagents of that session, so they stopped with it:
// the card names them, and says that a message continues the orientation once the session is back
// (stoppedAgentsLine). A code ticket's session goes on without main, so the permission card with its requests shows
// under the card, where it can be answered. It goes when a session attaches, and is not shown while
// the stream is down. A session that takes main over from another terminal is followed at once, with a toast. A
// workspace `thimble demo` installed from a pre-cache is read without a session until the first attaches, so the card
// waits for that session's end there (chat/Precached offers the attach command in the orientation's thread).
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ThreadsContext } from '../chat/Notes'
import { PermissionCard } from '../chat/PermissionCard'
import { pendingRequests } from '../chat/permissions'
import { precachedMark } from '../chat/Precached'
import { pickItems, threadLabels } from '../chat/threads'
import { useChatMetas } from '../chat/waiting'
import { Button } from '../components/Button'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { ChatMeta, CorpusInfo, SessionEnded } from '../lib/types'
import { shortPath, shownPath } from '../lib/workspace'
import { copyText } from './ProblemReport'

/** How long main is without a session before the card shows: a takeover writes the old session's end and the new
 * one's attach in sequence, and a launch attaches as its tab opens. */
export const GONE_AFTER_MS = 1500
const RELOAD_DEBOUNCE_MS = 150

export const TAKEOVER_TEXT = 'This tab now follows the session in another terminal.'

/** What the card says: the session that ended (none when no session was ever attached here) and the folder to run
 * thimble in. */
export interface Gone {
  ended: SessionEnded | null
  folder: string | null
}

const SHELL_SAFE = /^[A-Za-z0-9_./@%+,:=-]+$/

/** A folder as a shell takes it after `cd`: the home folder as ~, and the rest in single quotes when it holds a
 * character a shell would split on or expand. Pure. */
export function shellFolder(path: string): string {
  const short = shortPath(path)
  const home = short === '~' || short.startsWith('~/')
  const rest = home ? short.slice(2) : short
  const quoted = SHELL_SAFE.test(rest) ? rest : `'${rest.replace(/'/g, `'\\''`)}'`
  return home ? (rest ? `~/${quoted}` : '~') : quoted
}

/** The command that reconnects from a terminal: `thimble --continue` in the folder of the session that ended
 * (`resume`), else a new `thimble` in the workspace's folder. Pure. */
export function reconnectCommand(folder: string | null, resume: boolean): string {
  const run = resume ? 'thimble --continue' : 'thimble'
  return folder ? `cd ${shellFolder(folder)} && ${run}` : run
}

/** The command with a break opportunity after each slash, so that a long folder wraps between its parts. */
function Wrapped({ text }: { text: string }) {
  const parts = text.split('/')
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </>
  )
}

/** The agents of thimble's that main's quit stopped (route `subagent`, stopped by `quit`), as the card names them: the
 * orientation, the writer of a document, a check; '' when none. Pure. */
export function stoppedAgentsLine(metas: Iterable<ChatMeta>): string {
  const names: string[] = []
  let orient = false
  for (const m of metas) {
    if (m.route !== 'subagent' || m.status !== 'stopped' || m.stopped_by !== 'quit') continue
    const name = m.role === 'orient' ? 'the orientation' : m.role === 'writer' ? (m.doc ? `the writer of the ${m.doc}` : 'a writer') : m.role === 'check' ? (m.title ? `the ${m.title} check` : 'a check') : m.title || 'an agent'
    if (m.role === 'orient') orient = true
    if (!names.includes(name)) names.push(name)
  }
  if (!names.length) return ''
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  return `thimble's agents stopped with it: ${list}.${orient ? ' Once it is back, send the orientation a message to continue it.' : ''}`
}

/** Whether main's meta, once loaded, has no session attached while the stream is up; in a pre-cached workspace, only
 * once a session attached and ended. Pure. */
export function isGone(main: ChatMeta | null | undefined, streamUp: boolean, precached = false): boolean {
  return !!main && !main.attached && streamUp && !(precached && !main.ended)
}

/** Whether main's session is `session`, which took main from `after` in another terminal, while this tab followed
 * that one (`was`). Pure. */
export function tookOver(was: string | null, session: string | null, after: string | null): boolean {
  return !!was && !!session && session !== was && after === was
}

/** The card's state while it shows, else null; toasts when main moves to a session in another terminal. */
export function useSessionGone(ws: string): Gone | null {
  const [main, setMain] = useState<ChatMeta | null>(null)
  const [up, setUp] = useState(true)
  const [due, setDue] = useState(false)
  const [corpus, setCorpus] = useState<CorpusInfo | null>(null)
  const [precached, setPrecached] = useState(false)
  const followed = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const load = () =>
      api
        .chats(ws)
        .then((list) => {
          if (!alive) return
          setMain(list.find((m) => m.kind === 'main') ?? null)
          setPrecached(!!precachedMark(list))
        })
        .catch(() => undefined)
    void load()
    api
      .corpora()
      .then((cs) => alive && setCorpus(cs.find((c) => c.name === ws) ?? null))
      .catch(() => undefined)
    const offs = [
      bus.on('chat', (e) => {
        if (e.chat !== 'main') return
        if (timer != null) window.clearTimeout(timer)
        timer = window.setTimeout(() => void load(), RELOAD_DEBOUNCE_MS)
      }),
      bus.on('wsStream', (e) => {
        setUp(e.connected)
        if (e.connected) void load()
      }),
    ]
    return () => {
      alive = false
      offs.forEach((off) => off())
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws])
  const gone = isGone(main, up, precached)
  useEffect(() => {
    setDue(false)
    if (!gone) return
    const t = window.setTimeout(() => setDue(true), GONE_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [gone])
  const session = main?.attached?.session ?? null
  const after = main?.attached?.after ?? null
  useEffect(() => {
    if (!session) return
    if (tookOver(followed.current, session, after)) bus.emit('toast', { text: TAKEOVER_TEXT })
    followed.current = session
  }, [session, after])
  if (!gone || !due) return null
  const ended = main?.ended ?? null
  // Claude Code records the folder with its symlinks resolved; the analyst's own path to it is the corpus's `shown`
  const folder = ended?.cwd && ended.cwd !== corpus?.path ? ended.cwd : shownPath(corpus) ?? ended?.cwd ?? null
  return { ended, folder }
}

/** The requests of the sessions that go on without main (a code ticket's), as the chat panel's card lists them, and
 * every chat's meta. */
function useAsks(ws: string) {
  const metas = useChatMetas(ws)
  return useMemo(() => {
    const byId = new Map(metas.map((m) => [m.id, m]))
    const asks = pendingRequests(metas.find((m) => m.kind === 'main'), metas)
    const labels = threadLabels(pickItems(metas, (m) => !!m.running, () => false))
    return { asks, metas: byId, labels }
  }, [metas])
}

export function SessionGone({ gone, ws }: { gone: Gone; ws: string }) {
  const [copied, setCopied] = useState(false)
  const scrim = useRef<HTMLDivElement>(null)
  const { asks, metas, labels } = useAsks(ws)
  const stopped = stoppedAgentsLine(metas.values())
  useEffect(() => {
    const others = [...document.body.children].filter((el) => el !== scrim.current && !el.hasAttribute('inert'))
    others.forEach((el) => el.setAttribute('inert', ''))
    return () => others.forEach((el) => el.removeAttribute('inert'))
  }, [])
  const resume = !!gone.ended
  const command = reconnectCommand(gone.folder, resume)
  const copy = async () => {
    if (!(await copyText(command))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return createPortal(
    <div ref={scrim} className="shell-gone" role="alertdialog" aria-modal="true" aria-labelledby="shell-gone-title" aria-describedby="shell-gone-text">
      <div className="shell-gone-card overlay">
        <h2 id="shell-gone-title" className="shell-gone-title">
          {resume ? 'Claude Code session disconnected' : 'No Claude Code session connected'}
        </h2>
        <p id="shell-gone-text" className="shell-gone-text">
          To {resume ? 'reconnect' : 'connect'}, run this in a terminal:
        </p>
        <div className="shell-gone-command">
          <code>
            <Wrapped text={command} />
          </code>
          <Button variant="secondary" size="sm" onClick={() => void copy()} autoFocus>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {stopped && <p className="shell-gone-text shell-gone-agents">{stopped}</p>}
      </div>
      {asks.length > 0 && (
        <div className="shell-gone-asks">
          <ThreadsContext.Provider value={{ labels, metas }}>
            <PermissionCard ws={ws} asks={asks} metas={metas} labels={labels} />
          </ThreadsContext.Provider>
        </div>
      )}
    </div>,
    document.body,
  )
}
