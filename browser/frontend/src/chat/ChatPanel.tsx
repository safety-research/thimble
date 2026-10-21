// The chat column: the thread tree at the top, the transcript of the thread being read, and the composer floating over
// it. Main is the chat with Claude; a thread is a fork of main, main's conversation up to where it branched, then its
// own rows, about the card, record, mark or passage it was asked from. A view's build, which starts only on the
// analyst's Accept, shows its run in a thread of its own, where a message asks for a change to the view. While the chat
// shown runs, the composer's send square is its Stop. A view proposal waits above the composer until the analyst
// answers it (ProposalCard), and a failure shows as a notice with its fix (Notice.tsx).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { RefChip } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { ThreadTree } from '../components/ThreadTree'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { newest, STALE } from '../lib/newest'
import { findProposal, refreshProposals, useProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import { hhmm } from '../lib/time'
import type { ChatMeta, ChatRecord, MainEffort } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { ChatBusy } from './ChatBusy'
import { Composer } from './Composer'
import { mainEffort, mainFast, NEXT_LAUNCH } from './ModelLine'
import { API_ERROR_KIND, apiRetry, branchIndex, foldRecords, withApiErrors, withBranches, type Row } from './model'
import { Divider, Note, ThreadsContext } from './Notes'
import { NoticeStrip } from './Notice'
import { replayHeld } from './pending'
import { ProposalCard } from './ProposalCard'
import { MAIN_RETRY_NOTE, Rows, THREAD_RETRY_NOTE, type ErrorRetry } from './Rows'
import { countMessages, isUnread, markSeen, readSeen, type SeenMap } from './seen'
import { answeredSince, pickItems, threadKind, threadLabels, threadNodes, threadsRunning, type ThreadKind } from './threads'
import { useChat, type ChatState } from './useChat'

const LIST_DEBOUNCE_MS = 300
const ANCHORS_SHOWN = 6

export const STOP_MAIN = 'Stop main'
export const STOP_THREAD = 'Stop the thread'
export const STOP_BUILD = 'Stop the build'

/** What the composer's stop square stops in the chat shown: the chat agent's turn in main or a thread, or a view's
 * build in its thread. */
export type ComposerStop = { kind: 'chat'; chat: string; label: string } | { kind: 'view'; slug: string; label: string }

/** The Stop the composer carries for the chat shown, while what it stops runs; null otherwise. Pure. */
export function composerStopOf(kind: ThreadKind | null, meta: (Pick<ChatMeta, 'id' | 'status'> & { running?: boolean; view?: string | null }) | null): ComposerStop | null {
  if (!meta) return null
  if (kind === 'main') return meta.running ? { kind: 'chat', chat: meta.id, label: STOP_MAIN } : null
  if (kind === 'thread') return meta.running ? { kind: 'chat', chat: meta.id, label: STOP_THREAD } : null
  if (kind === 'dev' && meta.view && meta.status === 'running') return { kind: 'view', slug: meta.view, label: STOP_BUILD }
  return null
}

/** The composer's Stop sent; a failure is a toast. Resolves true when the request went through. */
export function stopRun(ws: string, what: ComposerStop): Promise<boolean> {
  const done = what.kind === 'chat' ? api.interrupt(ws, what.chat) : api.stopViewBuild(ws, what.slug).then(() => void refreshProposals(ws))
  return done.then(
    () => true,
    (e: Error) => (bus.emit('toast', { text: `Could not stop it: ${e.message}`, kind: 'error' }), false),
  )
}

/** How long the stop square stays busy after a Stop went through, at most, should the run not report its end. */
export const STOP_HOLD_MS = 30_000

/** A thread's anchors: the meta's `anchor` split at ',' (a ⌘-drag joins several), empty for main. */
export function threadAnchors(meta: Pick<ChatMeta, 'anchor'> | null | undefined): string[] {
  const a = meta?.anchor?.trim()
  if (!a) return []
  return a
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The Retry of a chat whose turn ended on an API error: the error row when it is the chat's last and the chat is not
 * working, which sends the analyst's last message again; else undefined. Pure but for `ask`. */
export function threadRetry(rows: readonly Row[], running: boolean, ask: () => Promise<unknown>): ErrorRetry | undefined {
  const last = rows.filter((r) => r.kind !== 'notice').at(-1)
  if (running || !last || last.kind !== 'error' || last.errorKind !== API_ERROR_KIND) return undefined
  return { index: last.index, onRetry: ask, note: THREAD_RETRY_NOTE }
}

/** The analyst's last message in a chat's records, for Retry. Pure. */
export function lastAsk(records: readonly ChatRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type === 'user') return r.text
  }
  return null
}

export function ChatPanel({ ws, onCollapse }: { ws: string; onCollapse?: () => void }) {
  const [chats, setChats] = useState<ChatMeta[]>([])
  // the thread shown, kept per workspace so a reload opens the same one
  const currentKey = storageKey(ws, 'thread-current')
  const [current, setCurrent] = useState(() => readStorage<string>(currentKey, 'main') || 'main')
  useEffect(() => {
    writeStorage(currentKey, current)
  }, [currentKey, current])
  const [seen, setSeen] = useState<SeenMap>(() => readSeen(ws))
  const main = useChat(ws, 'main')
  const other = useChat(ws, current === 'main' ? null : current)
  const chat: ChatState = current === 'main' ? main : other
  // a message handed over with `openChat`: state, so an openChat for the chat already shown still sends
  const [pendingSend, setPendingSend] = useState<{ chatId: string; text: string; n: number } | null>(null)
  const sendSeq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  // the tree: collapsed to one row by default
  const treeKey = storageKey(ws, 'threads-collapsed')
  const [treeCollapsed, setTreeCollapsed] = useState(() => readStorage<boolean>(treeKey, true))
  // a kept thread that is gone (deleted, or the workspace archived) falls back to main at the first load of the list
  const restored = useRef(false)
  const fresh = useMemo(() => newest<ChatMeta[]>(), [ws])
  const loadList = useCallback(
    () =>
      fresh(api.chats(ws))
        .then((list) => {
          if (list === STALE) return
          setChats(list)
          if (restored.current) return
          restored.current = true
          setCurrent((cur) => (cur === 'main' || list.some((m) => m.id === cur) ? cur : 'main'))
        })
        .catch(() => undefined),
    [ws, fresh],
  )
  useEffect(() => {
    void loadList()
    let timer: number | null = null
    const off = bus.on('chat', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void loadList(), LIST_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [loadList])

  useEffect(
    () =>
      bus.on('openChat', (e) => {
        if (e.send) setPendingSend({ chatId: e.chatId, text: e.send, n: ++sendSeq.current })
        setCurrent(e.chatId)
        void loadList()
      }),
    [loadList],
  )

  // the handed-over message goes once that chat's own meta is loaded, through the normal streaming path
  useEffect(() => {
    const p = pendingSend
    if (!p || p.chatId !== current || chat.loading || chat.meta == null || chat.meta.id !== current) return
    setPendingSend(null)
    toEnd()
    chat.send(p.text)
  }, [pendingSend, current, chat.loading, chat.meta, chat.send])

  // a deleted chat falls back to main, and so does one the server does not have
  useEffect(() => bus.on('chat', (e) => e.deleted && e.chat === current && setCurrent('main')), [current])
  useEffect(() => {
    if (current !== 'main' && other.error && /no (such )?chat/.test(other.error)) setCurrent('main')
  }, [current, other.error])

  // what asked for the chat while its column was folded (chat/pending.ts), once the listeners above are subscribed
  useEffect(() => {
    replayHeld()
  }, [])

  // the shown chat's records are seen
  const nMessages = countMessages(chat.records)
  useEffect(() => {
    if (chat.loading) return
    setSeen(markSeen(ws, current, nMessages))
  }, [ws, current, nMessages, chat.loading])

  // follow the newest record while the list is near its end; a thread opens at its end
  const nearEnd = useRef(true)
  // a message sent: it and the work that answers it are at the end, so the list goes there and follows them
  const toEnd = () => {
    nearEnd.current = true
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  useEffect(() => {
    nearEnd.current = true
  }, [current])
  useEffect(() => {
    const el = listRef.current
    if (!el || !nearEnd.current) return
    el.scrollTop = el.scrollHeight
  }, [chat.rows, chat.streaming, main.rows, current])
  // the composer floats over the transcript, so the list keeps its height clear at the bottom
  useEffect(() => {
    const foot = footRef.current
    const root = rootRef.current
    if (!foot || !root) return
    const set = () => {
      root.style.setProperty('--composer-h', `${foot.offsetHeight}px`)
      const el = listRef.current
      if (el && nearEnd.current) el.scrollTop = el.scrollHeight
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(foot)
    return () => ro.disconnect()
  }, [])
  // rows that fill in later (a card drawing, a chip learning its name) keep the end in view
  useEffect(() => {
    const el = listRef.current
    const flow = flowRef.current
    if (!el || !flow) return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (nearEnd.current) el.scrollTop = el.scrollHeight
      })
    })
    ro.observe(flow)
    ro.observe(el, { box: 'border-box' })
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [])

  const items = useMemo(
    () =>
      pickItems(
        chats,
        (m) => (m.id === current ? chat.running : !!m.running),
        (m) => (m.id === current ? false : isUnread(seen, m.id, m.n_messages)),
        { current },
      ),
    [chats, current, chat.running, seen],
  )
  const labels = useMemo(() => threadLabels(items), [items])
  const metas = useMemo(() => new Map(chats.map((m) => [m.id, m])), [chats])
  // a thread the analyst left while it answered says so once its answer is in: a toast with its chip
  const threadsWere = useRef<Map<string, boolean> | null>(null)
  const shown = useRef({ current, labels })
  shown.current = { current, labels }
  useEffect(() => {
    const was = threadsWere.current
    threadsWere.current = threadsRunning(chats)
    if (!was) return
    for (const id of answeredSince(was, chats, shown.current.current)) {
      const label = shown.current.labels.get(id) ?? 'thread'
      bus.emit('toast', { text: 'A thread you left has its answer', thread: { id, label } })
    }
  }, [chats])
  const nodes = useMemo(() => threadNodes(items), [items])

  const rename = useCallback(
    async (id: string, name: string) => {
      try {
        await api.updateChat(ws, id, { name })
        await loadList()
      } catch (e) {
        bus.emit('toast', { text: `Could not rename the thread: ${(e as Error).message}`, kind: 'error' })
      }
    },
    [ws, loadList],
  )
  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteChat(ws, id)
        if (id === current) setCurrent('main')
        await loadList()
      } catch (e) {
        bus.emit('toast', { text: `Could not delete the thread: ${(e as Error).message}`, kind: 'error' })
      }
    },
    [ws, current, loadList],
  )

  const mainModel = main.meta?.attached?.model ?? null
  const attached = main.meta?.attached ?? null
  const curMeta = (chat.meta?.id === current ? chat.meta : null) ?? chats.find((m) => m.id === current) ?? null
  const kind: ThreadKind | null = current === 'main' ? 'main' : curMeta ? threadKind(curMeta) : null
  const proposals = useProposals(ws)
  const build = kind === 'dev' && curMeta?.view ? (findProposal(proposals, curMeta.view) ?? null) : null
  const stopWhat = composerStopOf(kind, curMeta ? { ...curMeta, running: chat.running } : null)
  const stopKey = stopWhat ? (stopWhat.kind === 'view' ? `view:${stopWhat.slug}` : `chat:${stopWhat.chat}`) : null
  // the Stop that is under way, by stopKey: from the request until the run ends or STOP_HOLD_MS pass
  const [stopping, setStopping] = useState<string | null>(null)
  useEffect(() => {
    if (stopping && stopping !== stopKey) setStopping(null)
  }, [stopping, stopKey])
  useEffect(() => {
    if (!stopping) return
    const t = window.setTimeout(() => setStopping((s) => (s === stopping ? null : s)), STOP_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [stopping])
  const stopNow = () => {
    if (!stopWhat || !stopKey || stopping === stopKey) return
    const key = stopKey
    setStopping(key)
    void stopRun(ws, stopWhat).then((ok) => ok || setStopping((s) => (s === key ? null : s)))
  }
  const pickEffort = useCallback(
    (e: MainEffort) => {
      track('chat-settings', { target: 'chat:main', detail: { effort: e } })
      api
        .setEffort(ws, e)
        .then(() => {
          main.reload()
          bus.emit('toast', { text: `Effort ${e}: ${NEXT_LAUNCH}.`, kind: 'info' })
        })
        .catch((err: Error) => bus.emit('toast', { text: `Could not set the effort: ${err.message}`, kind: 'error' }))
    },
    [ws, main.reload],
  )
  const pickFast = useCallback(
    (on: boolean) => {
      track('chat-settings', { target: 'chat:main', detail: { fast: on } })
      api
        .setFast(ws, on)
        .then(() => {
          main.reload()
          bus.emit('toast', { text: `Fast mode ${on ? 'on' : 'off'}: ${NEXT_LAUNCH}.`, kind: 'info' })
        })
        .catch((err: Error) => bus.emit('toast', { text: `Could not switch fast mode: ${err.message}`, kind: 'error' }))
    },
    [ws, main.reload],
  )
  const curPath = labels.get(current) ?? current

  const mainRows = useMemo(() => withApiErrors(foldRecords(main.records)), [main.records])
  // the API error that ended main's last turn: its Retry sends the analyst's message again
  const failed = useMemo(() => apiRetry(main.records, new Set()), [main.records])
  const mainRetry = useMemo(() => (failed && !main.running ? { index: failed.index, onRetry: () => {
    toEnd()
    return main.send(failed.text)
  }, note: MAIN_RETRY_NOTE } : undefined), [failed, main.running, main.send])
  // the threads asked from main, as notes where they branched
  const branches = useMemo(
    () => chats.filter((m) => m.kind === 'thread' && (m.parent ?? 'main') === 'main').map((m) => ({ id: m.id, created_at: m.created_at, anchors: threadAnchors(m) })),
    [chats],
  )

  const [sendingView, setSendingView] = useState(false)
  // a send that fails hands its text back to the composer, so nothing typed is lost
  const send = (text: string): Promise<boolean> => {
    toEnd()
    if (kind === 'dev' && curMeta?.view) {
      // a view build's thread: the message is a change to the view, which its builder makes in this thread
      const slug = curMeta.view
      setSendingView(true)
      track('view-build', { target: `view:${slug}`, detail: { change: true } })
      return api
        .messageView(ws, slug, text)
        .then(() => chat.reload())
        .then(() => true)
        .catch((e: Error) => {
          bus.emit('toast', { text: `Could not send it to the view's build. ${e.message}`, kind: 'error' })
          return false
        })
        .finally(() => setSendingView(false))
    }
    return chat.send(text)
  }

  return (
    <ThreadsContext.Provider value={{ labels, metas, main: main.meta }}>
      <section
        ref={rootRef}
        className="chat"
        data-panel="chat"
        data-thread-kind={kind ?? undefined}
        data-chat-current={current}
        aria-label="Chat"
        onPointerDown={(e) => {
          // a press anywhere in the chat outside the tree's card folds the open tree, once the click has landed
          if (treeCollapsed || (e.target as Element).closest?.('.tt')) return
          const fold = () =>
            window.setTimeout(() => {
              writeStorage(treeKey, true)
              setTreeCollapsed(true)
            }, 0)
          window.addEventListener('pointerup', fold, { once: true })
        }}
      >
        <header className="chat-head">
          <ThreadTree
            className="chat-tree"
            nodes={nodes}
            current={current}
            collapsed={treeCollapsed}
            onCollapsedChange={(c) => {
              writeStorage(treeKey, c)
              setTreeCollapsed(c)
            }}
            onPick={(id) => {
              if (id !== current) track('thread-switch', { target: `chat:${id}` })
              setCurrent(id)
            }}
            onRename={rename}
            onDelete={remove}
            aside={onCollapse && <Button variant="icon" size="sm" icon="panel-left" title="Collapse the chat" className="chat-head-collapse" onClick={onCollapse} />}
          />
        </header>
        <div
          className="chat-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget
            nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div className="chat-flow" ref={flowRef}>
            {chat.loading && (
              <div className="chat-empty">
                <Spinner size={14} label="Loading" />
              </div>
            )}
            {chat.error && <div className="chat-error">{chat.error}</div>}
            {!chat.loading && !chat.error && kind === 'main' && <Rows rows={withBranches(mainRows, main.records, branches)} ws={ws} chat="main" streaming={main.running} retry={mainRetry} />}
            {!chat.loading && !chat.error && kind === 'thread' && curMeta && <ThreadView ws={ws} meta={curMeta} chat={chat} main={main} branches={branches} />}
            {!chat.loading && !chat.error && kind === 'dev' && <BuildView ws={ws} chat={chat} name={build?.name ?? curMeta?.title ?? 'the view'} />}
          </div>
        </div>
        <div ref={footRef} className="chat-foot">
          <ProposalCard ws={ws} />
          <NoticeStrip ws={ws} current={current} labels={labels} onOpen={setCurrent} />
          <ChatBusy ws={ws} />
          <Composer
            model={mainModel}
            effort={attached ? mainEffort(attached) : null}
            onEffort={attached ? pickEffort : undefined}
            fast={attached && kind !== 'dev' ? mainFast(attached) : null}
            onFast={pickFast}
            onSend={send}
            sending={kind === 'dev' ? sendingView : chat.streaming}
            placeholder={kind === 'dev' ? `Ask for a change to ${build?.name ?? 'the view'}…` : `Reply in ${curPath}…`}
            disabled={chat.loading || !!chat.error}
            stop={stopWhat ? { label: stopWhat.label, onStop: stopNow, busy: stopping === stopKey } : undefined}
            thread={current}
          />
        </div>
      </section>
    </ThreadsContext.Provider>
  )
}

/** A fork of main: main up to the branch, the line that says when, what it was asked about, then its own rows, and
 * Retry on an API error that ended its last turn. */
export function ThreadView({ ws, meta, chat, main, branches }: { ws: string; meta: ChatMeta; chat: ChatState; main: ChatState; branches: { id: string; created_at: string; anchors: string[] }[] }) {
  const cut = useMemo(() => branchIndex(main.records, meta.created_at), [main.records, meta.created_at])
  const inherited = useMemo(() => {
    const records = main.records.slice(0, cut)
    return withBranches(withApiErrors(foldRecords(records)), records, branches.filter((b) => b.id !== meta.id))
  }, [main.records, cut, branches, meta.id])
  const anchors = threadAnchors(meta)
  const ask = lastAsk(chat.records)
  return (
    <>
      <Rows rows={inherited} ws={ws} chat="main" />
      <Divider text={`branched from main · ${hhmm(meta.created_at)}`} />
      {anchors.length > 0 && (
        <Note
          className="chat-anchor-note"
          data-anchors={anchors.length}
          text="Anchored on"
          chips={
            <>
              {anchors.slice(0, ANCHORS_SHOWN).map((a, i) => (
                <RefChip key={`${a}:${i}`} ref={a} compact workspace={ws} />
              ))}
              {anchors.length > ANCHORS_SHOWN && <Chip kind="value">+{anchors.length - ANCHORS_SHOWN}</Chip>}
            </>
          }
        />
      )}
      <Rows rows={chat.rows} ws={ws} chat={meta.id} streaming={chat.running} retry={ask ? threadRetry(chat.rows, chat.running, () => chat.send(ask)) : undefined} />
    </>
  )
}

/** A view's build: its builder's rows, under a line that names the view. */
function BuildView({ ws, chat, name }: { ws: string; chat: ChatState; name: string }) {
  return (
    <>
      <Note className="chat-origin" text={`Building the view ${name}, as you accepted.`} />
      <Rows rows={chat.rows} ws={ws} chat={chat.meta?.id} streaming={chat.streaming} live={chat.running} />
    </>
  )
}
