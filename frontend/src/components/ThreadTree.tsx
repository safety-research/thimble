// The thread tree: every thread in one card at the top of the chat column. Collapsed it is one row: the current
// thread's full name and, when something happens elsewhere, how many run, how many hold an unread reply, and "waiting"
// while a prompt waits. Open, it is drawn like the Files tree (files/Tree): rows by depth with guide lines and
// chevrons that fold their children; a folded row shows the state of the rows it hides. A row's right edge is its
// state (progress, spinner, waiting dot, unread dot, or a finished agent's result and end time) and ⋯ on hover for
// Rename and Delete. With many threads a search field at the card's foot filters the rows. Picking a row shows that
// thread's conversation; picking main also folds the tree.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Mark } from './Marks'
import { Popover } from './Menu'
import { Spinner } from './Spinner'
import { useTooltip } from './Tooltip'

export interface ThreadNode {
  id: string
  /** the row's text: main, orient, why-the-spike */
  name: string
  /** the full name the collapsed card shows: main/why-the-spike, dev/group-board-by-round; `name` when absent */
  path?: string
  /** the thread this one was asked from; null (or a thread not listed) at the top level */
  parent: string | null
  running?: boolean
  /** mono, before the state: steps done of the whole (3/8) */
  progress?: string
  /** a reply the analyst has not read */
  unread?: boolean
  /** a permission prompt of its session or its fork waits for the analyst */
  waiting?: boolean
  /** mono at the row's right edge: when an agent's run ended (13:40) */
  time?: string
  /** how an agent's run ended: the green check for done, ✕ for a failed or stopped run */
  ended?: 'done' | 'failed'
  /** main: no rename, no delete */
  fixed?: boolean
}

export interface ThreadTreeProps {
  nodes: readonly ThreadNode[]
  current: string
  onPick: (id: string) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onRename?: (id: string, name: string) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
  /** controls that belong to the chat column rather than to a thread (collapse the column), at the right end of the
   * card's first row */
  aside?: ReactNode
  className?: string
}

/** A typed name as the thread keeps it: one line, trimmed, never empty. Pure. */
export function cleanName(raw: string, fallback: string): string {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, 120)
  return t || fallback
}

/** One row of the open tree: a thread at its depth, and whether rows hang under it. */
export type TreeRow = { type: 'node'; node: ThreadNode; depth: number; kids: boolean }

/** The threads the open list shows before it offers the search field. */
export const FILTER_MIN = 8

/** Each listed thread's children, in the order of `nodes`, under the key null for the top level. A thread whose parent
 * is not listed stands at the top level. Pure. */
function childrenOf(nodes: readonly ThreadNode[]): Map<string | null, ThreadNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kids = new Map<string | null, ThreadNode[]>()
  for (const n of nodes) {
    const p = n.parent && n.parent !== n.id && byId.has(n.parent) ? n.parent : null
    kids.set(p, [...(kids.get(p) ?? []), n])
  }
  return kids
}

/** The rows the open tree shows, in order, with their depth: each top-level row, then the rows under it depth first,
 * each row's children in the order of `nodes`; the rows under a thread in `folded` are left out. Pure. */
export function treeRows(nodes: readonly ThreadNode[], folded: ReadonlySet<string> = new Set()): TreeRow[] {
  const kids = childrenOf(nodes)
  const out: TreeRow[] = []
  const seen = new Set<string>()
  const walk = (n: ThreadNode, depth: number) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const under = (kids.get(n.id) ?? []).filter((k) => !seen.has(k.id))
    out.push({ type: 'node', node: n, depth, kids: under.length > 0 })
    if (folded.has(n.id)) {
      // the folded rows count as seen, so a cycle does not list them at the top level
      const hide = (k: ThreadNode) => {
        if (seen.has(k.id)) return
        seen.add(k.id)
        for (const g of kids.get(k.id) ?? []) hide(g)
      }
      under.forEach(hide)
      return
    }
    for (const k of under) walk(k, depth + 1)
  }
  for (const t of kids.get(null) ?? []) walk(t, 0)
  // a cycle of parents leaves its members unvisited; they are still threads the analyst can open
  for (const n of nodes) if (!seen.has(n.id)) walk(n, 0)
  return out
}

/** The threads above `id`, nearest first; empty for a top-level thread or one not listed. Pure. */
export function ancestorsOf(nodes: readonly ThreadNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: string[] = []
  let p = byId.get(id)?.parent
  while (p && byId.has(p) && !out.includes(p) && p !== id) {
    out.push(p)
    p = byId.get(p)?.parent
  }
  return out
}

/** What the rows under `id` hold, for a folded row to show: whether any runs, has a reply the analyst has not read (the
 * current one is being read), or has a prompt waiting. Pure. */
export function hiddenState(nodes: readonly ThreadNode[], id: string, current: string): { running: boolean; unread: boolean; waiting: boolean } {
  const kids = childrenOf(nodes)
  const acc = { running: false, unread: false, waiting: false }
  const seen = new Set<string>([id])
  const visit = (n: ThreadNode) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    acc.running ||= !!n.running
    acc.unread ||= !!n.unread && n.id !== current
    acc.waiting ||= !!n.waiting
    for (const k of kids.get(n.id) ?? []) visit(k)
  }
  for (const k of kids.get(id) ?? []) visit(k)
  return acc
}

/** The rows whose full name or name holds `query`, case aside, each at the top level. Pure. */
export function filterRows(nodes: readonly ThreadNode[], query: string): TreeRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return nodes.filter((n) => `${n.path ?? ''} ${n.name}`.toLowerCase().includes(q)).map((node) => ({ type: 'node' as const, node, depth: 0, kids: false }))
}

/** px: the guide line under the middle of a depth-0 row's chevron, and the step per level (files/Tree's INDENT) */
const GUIDE_X = 10
const INDENT = 14

/** What wants attention elsewhere: the threads that run, those holding a reply the analyst has not read (the current
 * one is being read), and those a prompt waits on. Pure. */
export function attention(nodes: readonly ThreadNode[], current: string): { running: number; unread: number; waiting: number } {
  const others = nodes.filter((n) => n.id !== current)
  return {
    running: others.filter((n) => n.running).length,
    unread: others.filter((n) => n.unread).length,
    waiting: nodes.filter((n) => n.waiting).length,
  }
}

/** How many threads want attention: running, or holding a reply the analyst has not read (the current one is being
 * read). Pure. */
export const activeCount = (nodes: readonly ThreadNode[], current: string): number => nodes.filter((n) => n.running || (n.unread && n.id !== current)).length

export function ThreadTree({ nodes, current, onPick, collapsed, onCollapsedChange, onRename, onDelete, aside, className }: ThreadTreeProps) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const editingId = editing?.id
  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  // the rows above the current thread unfold, so the current row is always in the open list
  const above = ancestorsOf(nodes, current).join(' ')
  useEffect(() => {
    if (!above) return
    const ids = above.split(' ')
    setFolded((f) => (ids.some((id) => f.has(id)) ? new Set([...f].filter((id) => !ids.includes(id))) : f))
  }, [above])

  const cur = nodes.find((n) => n.id === current)
  const att = attention(nodes, current)
  const filtering = query.trim() !== ''
  const rows = filtering ? filterRows(nodes, query) : treeRows(nodes, folded)
  const toggleFold = (id: string) =>
    setFolded((f) => {
      const next = new Set(f)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const commit = () => {
    if (!editing) return
    const n = nodes.find((x) => x.id === editing.id)
    const name = cleanName(editing.draft, n?.name ?? editing.id)
    setEditing(null)
    if (n && name !== n.name) void onRename?.(n.id, name)
  }
  const closeMenu = () => {
    setMenu(null)
    setConfirming(null)
  }
  const pickKeys = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick(id)
    }
  }
  const hasActions = (n: ThreadNode) => !n.fixed && !!(onRename || onDelete)
  const canRename = (n: ThreadNode) => !n.fixed && !!onRename

  const row = (r: TreeRow, opts: { card?: boolean; aside?: boolean; full?: boolean } = {}): ReactNode => {
    const { node: n, depth } = r
    const isCur = n.id === current
    const isEditing = editing?.id === n.id
    // the first row's chevron folds the card; any other row's folds the rows under it
    const chevron = opts.card || r.kids
    const open = opts.card || !folded.has(n.id)
    const hidden = r.kids && !open ? hiddenState(nodes, n.id, current) : null
    const cls = ['tt-row', isCur ? 'current' : '', depth > 0 ? 'tt-child' : '', menu?.id === n.id ? 'tt-menu-open' : ''].filter(Boolean).join(' ')
    return (
      <div
        key={n.id}
        className={cls}
        style={{ '--depth': depth } as React.CSSProperties}
        role="option"
        aria-selected={isCur}
        aria-expanded={r.kids ? open : undefined}
        tabIndex={0}
        data-thread={n.id}
        data-parent={n.parent ?? undefined}
        onClick={() => {
          if (isEditing) return
          onPick(n.id)
          // main is where the analyst goes back to: picking it folds the open tree
          if (n.fixed && !collapsed) onCollapsedChange(true)
        }}
        onKeyDown={(e) => !isEditing && pickKeys(e, n.id)}
      >
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="tt-guide" style={{ left: GUIDE_X + i * INDENT }} />
        ))}
        <span
          className={`tt-caret${chevron ? ' tt-caret-on' : ''}${chevron && open ? ' tt-caret-open' : ''}`}
          aria-hidden={!chevron}
          // a press on the chevron leaves the focus where it was, so the row's ⋯ does not show for it
          onMouseDown={chevron ? (e) => e.preventDefault() : undefined}
          onClick={
            chevron
              ? (e) => {
                  e.stopPropagation()
                  if (opts.card) onCollapsedChange(true)
                  else toggleFold(n.id)
                }
              : undefined
          }
        >
          {chevron && <Icon name="chevron-right" size={13} />}
        </span>
        {isEditing ? (
          <input
            ref={inputRef}
            className="tt-rename"
            value={editing.draft}
            aria-label="Thread name"
            onChange={(e) => setEditing({ id: n.id, draft: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(null)
              }
            }}
          />
        ) : (
          <span
            className="tt-name"
            onDoubleClick={(e) => {
              if (!canRename(n)) return
              e.stopPropagation()
              setEditing({ id: n.id, draft: n.name })
            }}
          >
            {opts.full ? (n.path ?? n.name) : n.name}
          </span>
        )}
        <span className="tt-end">
          {n.progress && <span className="tt-meta">{n.progress}</span>}
          {n.time && n.ended && <span className="tt-meta">{n.time}</span>}
          {(n.running || hidden?.running) && <Spinner size={10} label="running" />}
          {!n.running && n.ended === 'done' && <Mark kind="verified" label="done" className="tt-mark" />}
          {!n.running && n.ended === 'failed' && <Mark kind="failed" label="failed" className="tt-mark" />}
          {(n.waiting || hidden?.waiting) && <span className="dot tt-dot tt-waiting" role="img" aria-label="Waiting for you" />}
          {((n.unread && !isCur) || hidden?.unread) && <span className="dot tt-dot" role="img" aria-label="Unread" />}
          {hasActions(n) && (
            <MoreButton
              label={`${n.name}: actions`}
              open={menu?.id === n.id}
              onOpen={(el) => {
                setConfirming(null)
                setMenu((m) => (m?.id === n.id ? null : { id: n.id, el }))
              }}
            />
          )}
          {opts.aside && aside != null && (
            <span className="tt-aside" onClick={(e) => e.stopPropagation()}>
              {aside}
            </span>
          )}
        </span>
      </div>
    )
  }

  const menuNode = menu ? nodes.find((n) => n.id === menu.id) : null
  return (
    <div className={`tt${collapsed ? ' tt-collapsed' : ''}${className ? ` ${className}` : ''}`} data-panel="threads">
      {collapsed ? (
        <div className="tt-row tt-summary" role="button" tabIndex={0} aria-expanded={false} aria-label="Show threads" onClick={() => onCollapsedChange(false)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onCollapsedChange(false))}>
          <span className="tt-caret tt-caret-on" aria-hidden="true">
            <Icon name="chevron-right" size={13} />
          </span>
          <span className="tt-name">{cur?.path ?? cur?.name ?? current}</span>
          <span className="tt-end">
            {att.waiting > 0 && (
              <span className="tt-attn tt-attn-waiting" data-waiting={att.waiting}>
                <span className="dot tt-dot tt-waiting" aria-hidden="true" />
                waiting
              </span>
            )}
            {att.running > 0 && (
              <span className="tt-active" data-active={att.running} aria-label={`${att.running} running`}>
                <Spinner size={10} />
                {att.running}
              </span>
            )}
            {att.unread > 0 && (
              <span className="tt-attn tt-attn-unread" data-unread={att.unread} aria-label={`${att.unread} unread`}>
                <span className="dot tt-dot" aria-hidden="true" />
                {att.unread}
              </span>
            )}
            {aside != null && (
              <span className="tt-aside" onClick={(e) => e.stopPropagation()}>
                {aside}
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="tt-list" role="listbox" aria-label="Threads">
          {rows.map((r, i) => row(r, { card: i === 0 && !filtering, aside: i === 0 && !filtering, full: filtering }))}
          {(nodes.length > FILTER_MIN || filtering) && (
            <div className="tt-filter">
              <Icon name="search" size={13} />
              <input
                className="tt-filter-input"
                value={query}
                aria-label="Search threads"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape') setQuery('')
                }}
              />
            </div>
          )}
        </div>
      )}
      <Popover anchor={menu?.el ?? null} open={!!menu && !!menuNode} onClose={closeMenu} align="end" role="menu" label="Thread actions" className="tt-menu">
        {menuNode && (
          <div className="menu">
            {canRename(menuNode) && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  closeMenu()
                  setEditing({ id: menuNode.id, draft: menuNode.name })
                }}
              >
                <span className="menu-item-label">Rename</span>
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                role="menuitem"
                className="menu-item danger"
                onClick={() => {
                  if (confirming !== menuNode.id) return setConfirming(menuNode.id)
                  closeMenu()
                  void onDelete(menuNode.id)
                }}
              >
                <span className="menu-item-label">{confirming === menuNode.id ? 'Delete — sure?' : 'Delete…'}</span>
              </button>
            )}
          </div>
        )}
      </Popover>
    </div>
  )
}

/** A row's ⋯: the menu of its actions, named in the tooltip as every icon-only control is. */
function MoreButton({ label, open, onOpen }: { label: string; open: boolean; onOpen: (el: HTMLElement) => void }) {
  const { props, tip } = useTooltip('Thread actions')
  return (
    <>
      <button
        type="button"
        className="tt-more"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        {...props}
        onClick={(e) => {
          e.stopPropagation()
          onOpen(e.currentTarget)
        }}
      >
        <Icon name="more-horizontal" size={14} />
      </button>
      {tip}
    </>
  )
}

export default ThreadTree
