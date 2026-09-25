// The story's editor (PUT …/story): the sections as pages the scroll snaps to, each a column of blocks with its card
// beside it. The first section opens with the story's title. A block is text, a list, a headline, a quote, a callout, a
// divider, a card among the text or a picture of a card. A click makes a text block a field (a double click on a
// commented sentence): Enter splits it, Backspace in an empty block removes it, `/` in an empty block opens the
// block-type menu (and Section, which starts a new section there), and ⌘⇧↑/⌘⇧↓ move it. ⌘ held while typing tints the
// block, and ⌘↵ sends its text to main (lib/agentKey): the block waits as a card block until main's card fills it, or
// goes once main's turn ends without one. Hovered blocks and sections show their actions, which are also drag handles;
// cards drop from the sidebar onto the text or a section's card slot. Edits save after SAVE_DEBOUNCE_MS, on blur and on
// unmount.
import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react'
import { Button, Segmented, type SegmentedOption } from '../components/Button'
import { Icon, type IconName } from '../components/Icon'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { addAgentZone, askMain, tintElement, whenMainIdle } from '../lib/agentKey'
import { docsApi, reportApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import type { Cell, StoryCardSide, StoryDoc, WriteupFigure, WriteupParagraph } from '../lib/types'
import { CARD_MIME, usedCells } from './cards'
import type { CheckLook, DocComment, Flag } from './checkComments'
import { SAVE_DEBOUNCE_MS, whenShown, type DocFilter } from './Editor'
import { EvidencePop, useEvidence } from './Evidence'
import { FigurePicker, FigureView } from './FigureBlock'
import { readableText, sentenceStands } from './model'
import { useCanvas } from './ReportPage'
import { Sidebar, type SidebarProps } from './Sidebar'
import { CardImage, ReadBlock, sentencesOf, StepFigure } from './Story'
import {
  editSections,
  findBlock,
  insertBlock,
  isFigureType,
  moveBlock,
  moveSection,
  newBlock,
  newSection,
  removeBlock,
  retype,
  splitSection,
  stepBlock,
  storyBody,
  storyCells,
  TEXT_TYPES,
  updateBlock,
  type StoryBlock,
  type StoryBlockType,
  type StoryFigure,
  type StorySection,
} from './storyModel'

/** A new id in the server's alphabet, eight hex digits (report_types.BLOCK_ID_RE), so none reads as a paragraph's `p`. */
const mint = (): string => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
/** the drags' data types: a block, a section or a section's card dragged in the editor carries its id under it */
const BLOCK_MIME = 'application/x-thimble-story-block'
const SECTION_MIME = 'application/x-thimble-story-section'
const MAIN_MIME = 'application/x-thimble-story-card'
const TITLE_ID = 'title'

/** The kinds of block, as the `/` menu offers them, each with its glyph. */
const KINDS: { type: StoryBlockType; label: string; icon: IconName }[] = [
  { type: 'text', label: 'Text', icon: 'letter' },
  { type: 'headline', label: 'Headline', icon: 'heading' },
  { type: 'bullets', label: 'List', icon: 'lines' },
  { type: 'card', label: 'Card', icon: 'cell' },
  { type: 'quote', label: 'Quote', icon: 'reply' },
  { type: 'divider', label: 'Divider', icon: 'minus' },
  { type: 'image', label: 'Card image', icon: 'image' },
]
/** The `/` menu's last item, after the kinds: a new section from the block on. */
const SECTION_ITEM = { label: 'Section', icon: 'card-right' as IconName }

/** Where a section's card stands, as its bar offers it: a glyph each, named in its tooltip. */
const SIDE_OPTIONS: SegmentedOption<StoryCardSide>[] = [
  { value: 'right', icon: 'card-right', title: 'Card on the right' },
  { value: 'left', icon: 'card-left', title: 'Card on the left' },
  { value: 'full', icon: 'card-full', title: 'Card full width' },
  { value: 'none', icon: 'card-none', title: 'No card' },
]

export interface StoryEditorHandle {
  /** a card double-clicked in the sidebar: the card of the section last worked in when it has none, else a card block
   * at that section's end */
  insertCard: (cellId: string) => void
}

export interface StoryEditorProps {
  ws: string
  slug: string
  /** the written story, or its frame before a write (`frame`) */
  doc: StoryDoc
  /** the tab's token on the editor's saves */
  client: string
  onSaved: (doc: StoryDoc) => void
  /** the document's open comments, the checks that are on, how their checks are drawn, and the comment the Checks
   * pane picked */
  comments: readonly DocComment[]
  on: ReadonlySet<string>
  look: CheckLook
  picked: DocComment | null
  filter: DocFilter | null
  ref?: Ref<StoryEditorHandle>
}

interface EditState {
  title: string
  sections: StorySection[]
}

const derive = (doc: StoryDoc): EditState => ({ title: doc.title ?? '', sections: editSections(doc, mint) })

/** The editor's state over the stored story and its saves: a change is saved after SAVE_DEBOUNCE_MS; a story from
 * outside replaces the state while nothing typed is pending, and this tab's own save leaves the state as typed. */
function useStoryEdit(ws: string, slug: string, doc: StoryDoc, client: string, onSaved: (doc: StoryDoc) => void) {
  const [state, setState] = useState<EditState>(() => derive(doc))
  const current = useRef(state)
  const dirty = useRef(false)
  const timer = useRef<number | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const queued = useRef(false)
  const own = useRef<StoryDoc | null>(null)

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    if (inflight.current) {
      queued.current = true
      return
    }
    dirty.current = false
    const body = storyBody(current.current.title, current.current.sections, client)
    const p = (async () => {
      try {
        const saved = await docsApi.putStory(ws, slug, body)
        track('report-frame-edit', { target: `report:${slug}`, detail: { story: true, sections: body.sections.length } })
        own.current = saved
        onSaved(saved)
      } catch (e) {
        dirty.current = true
        bus.emit('toast', { text: `Could not save the ${slug}. ${(e as Error).message}`, kind: 'error' })
      } finally {
        inflight.current = null
        if (queued.current) {
          queued.current = false
          void flush()
        }
      }
    })()
    inflight.current = p
    await p
  }, [ws, slug, client, onSaved])

  const change = useCallback(
    (next: (s: EditState) => EditState) => {
      current.current = next(current.current)
      setState(current.current)
      dirty.current = true
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  // what is typed since the last save goes to the server first, so a block made since then exists there under its id
  const saveNow = useCallback(async () => {
    if (inflight.current) await inflight.current.catch(() => undefined)
    await flush()
    if (inflight.current) await inflight.current.catch(() => undefined)
  }, [flush])

  const seen = useRef(doc)
  useEffect(() => {
    if (doc === seen.current) return
    seen.current = doc
    if (doc === own.current || dirty.current || inflight.current) return
    current.current = derive(doc)
    setState(current.current)
  }, [doc])

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      if (dirty.current) void flush()
    },
    [flush],
  )
  const adopt = useCallback((saved: StoryDoc) => {
    own.current = saved
    onSaved(saved)
  }, [onSaved])
  return { state, change, flush, saveNow, adopt }
}

/** Where the caret goes when a block becomes a field: its start, its end, or an offset. */
type Caret = 'start' | 'end' | number

interface EdCtx {
  ws: string
  slug: string
  sections: readonly StorySection[]
  /** the sections the stored story holds, whose headlines take a chat and a lock */
  secIds: ReadonlySet<string>
  flags: ReadonlyMap<string, Flag>
  sets: DocFilter['sets'] | null
  paras: ReadonlyMap<string, WriteupParagraph>
  figs: ReadonlyMap<string, WriteupFigure>
  locked: ReadonlySet<string>
  editing: { id: string; caret: Caret } | null
  edit: (id: string | null, caret?: Caret) => void
  setSections: (fn: (s: StorySection[]) => StorySection[]) => void
  toggleLock: (id: string, locked: boolean) => void
  chat: (el: HTMLElement | null) => void
  focusSection: (s: number) => void
  captionOf: (cellId: string, main?: boolean) => string
  flush: () => void
  drag: (e: DragEvent, kind: 'block' | 'section' | 'main', id: string) => void
  /** `/`'s Section: the section splits at the block, which goes */
  splitAt: (id: string) => void
  /** ⌘↵ in text block `id`: `text` goes to main as a request made there */
  ask: (id: string, text: string) => void
}
const Ctx = createContext<EdCtx | null>(null)
const useEd = (): EdCtx => useContext(Ctx)!

/** A drop's place: a gap in a section's blocks (its index and the line's top in the section's text column), a
 * section's card slot, or a gap between sections. */
type DropAt = { kind: 'block'; s: number; at: number; top: number } | { kind: 'slot'; s: number } | { kind: 'section'; at: number; top: number }

export function StoryEditor({ ws, slug, doc, client, onSaved, comments, on, look, picked, filter, ref }: StoryEditorProps) {
  const ed = useStoryEdit(ws, slug, doc, client, onSaved)
  const { title, sections } = ed.state
  const root = useRef<HTMLDivElement | null>(null)
  const ev = useEvidence(comments, on, look, picked)
  const { cells } = useCanvas(ws)
  const [editing, setEditing] = useState<{ id: string; caret: Caret } | null>(null)
  const lastSection = useRef(0)

  const paras = useMemo(() => new Map((doc.sections ?? []).flatMap((s) => (s.paragraphs ?? []).map((p) => [p.id, p] as const))), [doc])
  const figs = useMemo(() => new Map((doc.sections ?? []).flatMap((s) => (s.figures ?? []).map((f) => [f.id, f] as const))), [doc])

  // the analyst's locks, shown at once and reverted if the lock fails; clicks are sent in order so a second click
  // undoes the first rather than racing it
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const stored = useMemo(() => {
    const out = new Set<string>()
    if (doc.title_locked) out.add(TITLE_ID)
    for (const s of doc.sections ?? []) {
      if (s.locked) out.add(s.id)
      for (const p of s.paragraphs ?? []) if (p.locked) out.add(p.id)
      for (const f of s.figures ?? []) if (f.locked) out.add(f.id)
    }
    return out
  }, [doc])
  const locked = useMemo(() => {
    const out = new Set(stored)
    for (const [id, on] of pending) {
      if (on) out.add(id)
      else out.delete(id)
    }
    return out
  }, [stored, pending])
  const lockQueue = useRef<Promise<void>>(Promise.resolve())
  const toggleLock = useCallback(
    (id: string, next: boolean) => {
      setPending((m) => new Map(m).set(id, next))
      const run = async () => {
        try {
          await ed.saveNow()
          const saved = (await reportApi.lock(ws, slug, id, { locked: next, client })) as unknown as StoryDoc
          ed.adopt(saved)
        } catch (e) {
          bus.emit('toast', { text: `Could not ${next ? 'lock' : 'unlock'} the block. ${(e as Error).message}`, kind: 'error' })
        } finally {
          setPending((m) => {
            if (m.get(id) !== next) return m
            const out = new Map(m)
            out.delete(id)
            return out
          })
        }
      }
      lockQueue.current = lockQueue.current.then(run)
    },
    [ed, ws, slug, client],
  )

  // the chat about a block, a heading or a card: the box a ⌘-click on it opens, once the story is saved so the server
  // holds what it anchors on
  const chat = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return
      void ed.saveNow().then(() => {
        if (el.isConnected) bus.emit('askAbout', { el })
      })
    },
    [ed],
  )

  const setSections = useCallback((fn: (s: StorySection[]) => StorySection[]) => ed.change((st) => ({ ...st, sections: fn(st.sections) })), [ed])
  // a card placed as a section's card is captioned with its question, one among the blocks with its takeaway, as the
  // report's figures are
  const captionOf = useCallback(
    (cellId: string, main = false) => {
      const c = cells.find((x: Cell) => x.id === cellId.replace(/^(?:card|cell):/, ''))
      return readableText((main ? c?.title : c?.takeaway || c?.title) || '')
    },
    [cells],
  )

  // ⌘↵ in a text block sends its text to main and turns the block into an unsaved card block that main's card fills,
  // or that goes when main's turn ends without one. The story is saved first so the passage the request follows
  // exists on the server; a request that does not land puts the block back
  const asks = useRef(new Map<string, string>())
  const idle = useRef(new Map<string, () => void>())
  useEffect(() => () => idle.current.forEach((cancel) => cancel()), [])
  const captionRef = useRef(captionOf)
  captionRef.current = captionOf
  useEffect(
    () =>
      bus.on('cardRequest', ({ request, card }) => {
        const id = asks.current.get(request)
        if (!id) return
        asks.current.delete(request)
        const cell = `card:${card}`
        setSections((secs) => (findBlock(secs, id) ? updateBlock(secs, id, { cell, caption: captionRef.current(cell), asked: undefined }) : secs))
      }),
    [setSections],
  )
  const ask = async (id: string, text: string) => {
    const at = findBlock(sections, id)
    if (!at) return
    const sec = sections[at.s]
    const original = sec.blocks[at.b]
    const above = sec.blocks
      .slice(0, at.b)
      .reverse()
      .find((b) => TEXT_TYPES.includes(b.type) && b.text.trim())
    const after = above ? `report:${slug}#p${above.id}` : `report:${slug}#${sec.id}`
    setEditing(null)
    setSections((secs) => updateBlock(secs, id, { type: 'card', text: '', cell: '', caption: '', asked: text }))
    try {
      await ed.saveNow()
      const request = await askMain(ws, text, { doc: slug, after })
      asks.current.set(request, id)
      track('ui-click', { target: `report:${slug}`, detail: { action: 'ask', request } })
      idle.current.set(
        id,
        whenMainIdle(ws, () => {
          idle.current.delete(id)
          asks.current.delete(request)
          setSections((secs) => {
            const b = findBlock(secs, id)
            return b && !secs[b.s].blocks[b.b].cell ? removeBlock(secs, id) : secs
          })
        }),
      )
    } catch (e) {
      setSections((secs) => updateBlock(secs, id, { ...original, asked: undefined }))
      bus.emit('toast', { text: `Could not send the request. ${(e as Error).message}`, kind: 'error' })
    }
  }

  // a card from the sidebar: the card of the section last worked in when it has none, else a card block at its end
  const insertCard = useCallback(
    (cellId: string) => {
      const s = Math.min(lastSection.current, sections.length - 1)
      const cell = `card:${cellId}`
      setSections((secs) => {
        const sec = secs[s]
        if (!sec) return secs
        if (!sec.main && sec.side !== 'none') return secs.map((x, k) => (k === s ? { ...x, main: { id: mint(), cell, caption: captionOf(cell, true) } } : x))
        return insertBlock(secs, s, sec.blocks.length, { ...newBlock(mint, 'card'), cell, caption: captionOf(cell) })
      })
      track('ui-click', { target: `card:${cellId}`, detail: { action: 'story-card', slug } })
    },
    [sections.length, setSections, captionOf, slug],
  )
  useImperativeHandle(ref, () => ({ insertCard }), [insertCard])

  // a comment picked in the Checks pane: its block scrolls into view
  useEffect(() => {
    if (!picked) return
    const el = root.current?.querySelector<HTMLElement>(`[data-sid="${CSS.escape(picked.sid)}"]`) ?? root.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(picked.sid)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [picked])

  // an empty story opens with the caret in its title (in a hidden tab, once the tab is shown)
  useEffect(() => {
    const empty = !title.trim() && sections.length === 1 && !sections[0].heading.trim() && sections[0].blocks.every((b) => !b.text.trim() && !b.cell)
    if (!empty) return
    return whenShown(root.current, () => setEditing({ id: TITLE_ID, caret: 'end' }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- drag and drop: a block, a section, a section's card, or a card from the sidebar
  const dragging = useRef<{ kind: 'block' | 'section' | 'main'; id: string } | null>(null)
  const [drop, setDrop] = useState<DropAt | null>(null)
  // while something is dragged over the editor, the empty card slots show, so a card can be dropped on one
  const [carrying, setCarrying] = useState(false)
  const drag = useCallback((e: DragEvent, kind: 'block' | 'section' | 'main', id: string) => {
    dragging.current = { kind, id }
    e.dataTransfer.setData(kind === 'block' ? BLOCK_MIME : kind === 'section' ? SECTION_MIME : MAIN_MIME, id)
    e.dataTransfer.effectAllowed = 'move'
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(kind === 'section' ? '.wu-se-sec' : kind === 'main' ? '.wu-se-card' : '.wu-se-block')
    if (row) e.dataTransfer.setDragImage(row, 16, 16)
    setEditing(null)
    track('ui-click', { target: `report:${slug}`, detail: { action: `story-${kind}-move` } })
  }, [slug])
  useEffect(() => {
    const clear = () => {
      dragging.current = null
      setDrop(null)
      setCarrying(false)
    }
    document.addEventListener('dragend', clear)
    return () => document.removeEventListener('dragend', clear)
  }, [])
  const kindOf = (e: DragEvent): 'block' | 'section' | 'main' | 'card' | null => {
    const types = Array.from(e.dataTransfer.types)
    if (types.includes(SECTION_MIME)) return 'section'
    if (types.includes(BLOCK_MIME)) return 'block'
    if (types.includes(MAIN_MIME)) return 'main'
    if (types.includes(CARD_MIME)) return 'card'
    return null
  }
  const dropAt = (e: DragEvent): DropAt | null => {
    const kind = kindOf(e)
    if (!kind) return null
    const target = e.target as Element
    if (kind === 'section') {
      const secs = Array.from(root.current?.querySelectorAll<HTMLElement>('.wu-se-sec') ?? [])
      const col = root.current?.querySelector<HTMLElement>('.wu-se-col')
      if (!secs.length || !col) return null
      const base = col.getBoundingClientRect().top
      let at = secs.length
      for (let i = 0; i < secs.length; i++) {
        const r = secs[i].getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) {
          at = i
          break
        }
      }
      const edge = at < secs.length ? secs[at].getBoundingClientRect().top : secs[secs.length - 1].getBoundingClientRect().bottom
      return { kind: 'section', at, top: edge - base }
    }
    const blockDragged = dragging.current?.kind === 'block' ? findBlock(sections, dragging.current.id) : null
    const figureDragged = kind === 'card' || kind === 'main' || (blockDragged != null && isFigureType(sections[blockDragged.s].blocks[blockDragged.b].type))
    const slot = target.closest<HTMLElement>('.wu-se-card')
    if (slot && figureDragged) {
      const s = Number(slot.closest<HTMLElement>('.wu-se-sec')?.dataset.index)
      return Number.isFinite(s) ? { kind: 'slot', s } : null
    }
    const text = target.closest<HTMLElement>('.wu-se-text')
    if (!text) return null
    const s = Number(text.closest<HTMLElement>('.wu-se-sec')?.dataset.index)
    if (!Number.isFinite(s)) return null
    const rows = Array.from(text.querySelectorAll<HTMLElement>(':scope > .wu-se-block'))
    const base = text.getBoundingClientRect().top
    let at = rows.length
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) {
        at = i
        break
      }
    }
    const head = text.querySelector<HTMLElement>(':scope > .wu-se-head')
    const edge = at < rows.length ? rows[at].getBoundingClientRect().top - 4 : rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom + 4 : (head?.getBoundingClientRect().bottom ?? base) + 4
    return { kind: 'block', s, at, top: edge - base }
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!carrying) setCarrying(true)
    const next = dropAt(e)
    if (!next) {
      if (drop) setDrop(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = kindOf(e) === 'card' ? 'copy' : 'move'
    if (JSON.stringify(next) !== JSON.stringify(drop)) setDrop(next)
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const r = root.current?.getBoundingClientRect()
    if (r && e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return
    setDrop(null)
    setCarrying(false)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const at = dropAt(e)
    const kind = kindOf(e)
    setDrop(null)
    setCarrying(false)
    const dragged = dragging.current
    dragging.current = null
    if (!at || !kind) return
    e.preventDefault()
    if (kind === 'section' && at.kind === 'section') {
      const from = sections.findIndex((s) => s.id === e.dataTransfer.getData(SECTION_MIME))
      if (from >= 0) setSections((secs) => moveSection(secs, from, at.at))
      return
    }
    if (kind === 'card') {
      const cell = `card:${e.dataTransfer.getData(CARD_MIME)}`
      if (at.kind === 'slot') setSections((secs) => secs.map((x, k) => (k === at.s ? { ...x, main: { id: mint(), cell, caption: captionOf(cell, true) }, side: x.side === 'none' ? 'right' : x.side } : x)))
      else if (at.kind === 'block') setSections((secs) => insertBlock(secs, at.s, at.at, { ...newBlock(mint, 'card'), cell, caption: captionOf(cell) }))
      lastSection.current = at.kind === 'section' ? lastSection.current : at.s
      return
    }
    if (kind === 'block' && dragged) {
      if (at.kind === 'block') setSections((secs) => moveBlock(secs, dragged.id, at.s, at.at))
      else if (at.kind === 'slot')
        setSections((secs) => {
          const from = findBlock(secs, dragged.id)
          if (!from) return secs
          const b = secs[from.s].blocks[from.b]
          const old = secs[at.s].main
          let out = removeBlock(secs, b.id)
          // the card the slot held takes the dragged block's place among the text
          if (old) out = insertBlock(out, from.s, from.b, { id: old.id, type: 'card', text: '', cell: old.cell, caption: old.caption })
          return out.map((x, k) => (k === at.s ? { ...x, main: { id: b.id, cell: b.cell ?? '', caption: b.caption ?? '' }, side: x.side === 'none' ? 'right' : x.side } : x))
        })
      return
    }
    if (kind === 'main' && dragged) {
      setSections((secs) => {
        const from = secs.findIndex((x) => x.main?.id === dragged.id)
        if (from < 0) return secs
        const main = secs[from].main!
        if (at.kind === 'slot') {
          if (at.s === from) return secs
          const theirs = secs[at.s].main
          return secs.map((x, k) => (k === at.s ? { ...x, main, side: x.side === 'none' ? 'right' : x.side } : k === from ? { ...x, main: theirs } : x))
        }
        if (at.kind !== 'block') return secs
        const out = secs.map((x, k) => (k === from ? { ...x, main: null } : x))
        return insertBlock(out, at.s, at.at, { id: main.id, type: 'card', text: '', cell: main.cell, caption: main.caption })
      })
    }
  }

  // `/`'s Section on block `id`: the section splits there, and the new section's headline takes the caret
  const splitAt = (id: string) => {
    const split = splitSection(sections, id, mint)
    if (!split) return
    setSections(() => split.sections)
    setEditing({ id: `head:${split.section}`, caret: 'start' })
    track('ui-click', { target: `report:${slug}`, detail: { action: 'story-section-add' } })
  }
  const secIds = useMemo(() => new Set((doc.sections ?? []).map((s) => s.id)), [doc])
  const ctx: EdCtx = {
    ws,
    slug,
    sections,
    secIds,
    flags: ev.flags,
    sets: filter?.sets ?? null,
    paras,
    figs,
    locked,
    editing,
    edit: (id, caret = 'end') => setEditing(id ? { id, caret } : null),
    setSections,
    toggleLock,
    chat,
    focusSection: (s) => {
      lastSection.current = s
    },
    captionOf,
    flush: () => void ed.flush(),
    drag,
    splitAt,
    ask: (id, text) => void ask(id, text),
  }
  const removeSection = (s: number) => {
    setSections((secs) => {
      const rest = secs.filter((_, k) => k !== s)
      return rest.length ? rest : [newSection(mint)]
    })
    track('ui-click', { target: `report:${slug}`, detail: { action: 'story-section-delete' } })
  }
  const lede = !sections[0]?.heading.trim()
  const titleField = (
    <HeadRow
      id={TITLE_ID}
      className="wu-se-title"
      label="Title"
      value={title}
      anchor={`report:${slug}`}
      locked={locked.has(TITLE_ID)}
      onChange={(v) => ed.change((st) => ({ ...st, title: v.replace(/\n/g, ' ') }))}
      onEnter={() => {
        const first = sections[0]
        if (!first) return
        if (lede) {
          const b = first.blocks[0]
          if (b && TEXT_TYPES.includes(b.type)) setEditing({ id: b.id, caret: 'start' })
          else {
            const nb = newBlock(mint)
            setSections((secs) => insertBlock(secs, 0, 0, nb))
            setEditing({ id: nb.id, caret: 'start' })
          }
        } else setEditing({ id: `head:${first.id}`, caret: 'end' })
      }}
    />
  )
  return (
    <Ctx.Provider value={ctx}>
      <div className={`wu-story-ed${carrying ? ' wu-se-carrying' : ''}`} ref={root} data-story={slug} onMouseOver={ev.onOver} onMouseLeave={ev.onLeave} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="wu-se-col">
          {sections.map((sec, s) => (
            <SectionView key={sec.id} section={sec} index={s} title={s === 0 ? titleField : null} lede={s === 0 && lede} drop={drop && drop.kind !== 'section' && drop.s === s ? drop : null} onRemove={() => removeSection(s)} />
          ))}
          {drop?.kind === 'section' && <div className="wu-dropline wu-se-secline" style={{ top: drop.top }} />}
        </div>
        <EvidencePop comments={ev.hovered} look={look} />
      </div>
    </Ctx.Provider>
  )
}

// ---------------------------------------------------------------------------------------------------- a section

interface SectionViewProps {
  section: StorySection
  index: number
  /** the story's title, at the top of the first section */
  title: ReactNode
  /** the title stands as the section's headline, which it has none of */
  lede: boolean
  drop: DropAt | null
  onRemove: () => void
}

/** A section: its bar (where its card stands, delete, and a drag that moves it), its headline and blocks, and its card
 * slot. */
function SectionView({ section, index, title, lede, drop, onRemove }: SectionViewProps) {
  const x = useEd()
  const set = (patch: Partial<StorySection>) => x.setSections((secs) => secs.map((s) => (s.id === section.id ? { ...s, ...patch } : s)))
  const sets = x.sets
  const dim = !!sets && section.blocks.some((b) => x.paras.has(b.id)) && !section.blocks.some((b) => (x.paras.get(b.id)?.sentences ?? []).some((s) => sentenceStands(sets, s.id)))
  return (
    <section
      className={`wu-se-sec wu-se-${section.side}${dim ? ' wu-dim' : ''}`}
      data-section={section.id}
      data-index={index}
      onFocusCapture={() => x.focusSection(index)}
      onMouseDown={() => x.focusSection(index)}
    >
      <div className="wu-se-bar" draggable onDragStart={(e) => x.drag(e, 'section', section.id)}>
        <Segmented size="sm" label="Card" value={section.side} onChange={(v) => set({ side: v })} options={SIDE_OPTIONS} />
        <Button variant="icon" size="sm" icon="trash" title="Delete section" className="wu-acts-delete" onClick={onRemove} />
      </div>
      <div className="wu-se-text">
        {title}
        {!lede && (
          <HeadRow
            id={`head:${section.id}`}
            lockId={section.id}
            className="wu-se-heading"
            label="Headline"
            value={section.heading}
            anchor={`report:${x.slug}#${section.id}`}
            locked={x.locked.has(section.id)}
            onChange={(v) => set({ heading: v.replace(/\n/g, ' ') })}
            onEnter={() => {
              const b = section.blocks[0]
              if (b && TEXT_TYPES.includes(b.type) && !b.text.trim()) x.edit(b.id, 'start')
              else {
                const nb = newBlock(mint)
                x.setSections((secs) => insertBlock(secs, index, 0, nb))
                x.edit(nb.id, 'start')
              }
            }}
          />
        )}
        {section.blocks.map((b) => (
          <BlockRow key={b.id} block={b} s={index} />
        ))}
        {drop?.kind === 'block' && <div className="wu-dropline wu-se-line" style={{ top: drop.top }} />}
      </div>
      {section.side !== 'none' && <CardSlot section={section} index={index} target={drop?.kind === 'slot'} />}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------- a block

/** One block: what it shows (a field while it is being typed in) and its actions at its right. */
function BlockRow({ block, s }: { block: StoryBlock; s: number }) {
  const x = useEd()
  const el = useRef<HTMLDivElement | null>(null)
  const stored = x.paras.get(block.id)
  const storedFig = x.figs.get(block.id)
  const isStored = isFigureType(block.type) ? !!storedFig : !!stored
  const locked = x.locked.has(block.id)
  const sentences = TEXT_TYPES.includes(block.type) ? sentencesOf(block, stored) : []
  const dim = !!x.sets && sentences.length > 0 && !!stored && !sentences.some((t) => sentenceStands(x.sets, t.id))
  const anchor = isFigureType(block.type) ? block.cell || undefined : `report:${x.slug}#p${block.id}`
  const editing = x.editing?.id === block.id
  let body: ReactNode
  if (isFigureType(block.type)) body = <FigureBlockBody block={block} />
  else if (block.type === 'divider') body = <hr className="wu-sb-rule" />
  else if (editing) body = <BlockField block={block} caret={x.editing!.caret} />
  else
    body = (
      <div
        className={`wu-se-read${block.text.trim() ? '' : ' wu-se-empty'}`}
        role="textbox"
        aria-label={KINDS.find((k) => k.type === block.type)?.label ?? 'Text'}
        tabIndex={0}
        onClick={(e) => {
          if ((e.target as Element).closest('a, button, .refchip')) return
          // a selection made in the block is the analyst's to comment on, and a click on a tinted sentence holds its
          // evidence card, so neither opens the field; a double click or Enter does
          const sel = document.getSelection()
          if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return
          if ((e.target as Element).closest('[data-cids]')) return
          x.edit(block.id, 'end')
        }}
        onDoubleClick={() => x.edit(block.id, 'end')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            x.edit(block.id, 'end')
          }
        }}
      >
        <ReadBlock ws={x.ws} slug={x.slug} block={block} sentences={sentences} flags={x.flags} />
      </div>
    )
  return (
    <div ref={el} className={`wu-se-block wu-se-b-${block.type}${locked ? ' wu-locked' : ''}${dim ? ' wu-dim' : ''}`} data-block={block.id} data-anchor={isStored ? anchor : undefined}>
      <div className="wu-se-body">{body}</div>
      <Acts
        chat={isStored ? () => x.chat(el.current?.querySelector<HTMLElement>('[data-anchor]') ?? el.current) : undefined}
        remove={() => {
          x.setSections((secs) => removeBlock(secs, block.id))
          track('ui-click', { target: `report:${x.slug}#p${block.id}`, detail: { action: 'block-delete' } })
        }}
        lock={isStored ? { on: locked, toggle: () => x.toggleLock(block.id, !locked) } : undefined}
        onDragStart={(e) => x.drag(e, 'block', block.id)}
      />
    </div>
  )
}

/** A block's actions (chat, delete, the lock) side by side in a gutter; a drag on them moves the block. */
function Acts({ chat, remove, lock, onDragStart }: { chat?: () => void; remove?: () => void; lock?: { on: boolean; toggle: () => void }; onDragStart?: (e: DragEvent) => void }) {
  return (
    <div className="wu-acts wu-se-acts" draggable={!!onDragStart} onDragStart={onDragStart}>
      {chat && <Button variant="icon" size="sm" icon="chat" title="Chat about this block" onClick={chat} />}
      {remove && <Button variant="icon" size="sm" icon="trash" title="Delete" className="wu-acts-delete" onClick={remove} />}
      {lock && (
        <Button
          variant="icon"
          size="sm"
          icon={lock.on ? 'lock' : 'unlock'}
          title={lock.on ? 'Locked: no model changes this block' : 'Lock so no model changes this block'}
          aria-label={lock.on ? 'Locked' : 'Lock'}
          active={lock.on}
          className="wu-acts-lock"
          onClick={lock.toggle}
        />
      )}
    </div>
  )
}

/** The field of a text block being typed in, in the type of its kind, with the keys that start, remove, retype and move
 * blocks; a quote's speaker under it. */
function BlockField({ block, caret }: { block: StoryBlock; caret: Caret }) {
  const x = useEd()
  const field = useRef<HTMLTextAreaElement | null>(null)
  // ⌘↵ sends the block's text to main (lib/agentKey), while no `/` menu is open in it
  const box = useRef<HTMLDivElement | null>(null)
  const now = useRef({ block, x, slash: false })
  useEffect(() => {
    const root = box.current
    if (!root) return
    return addAgentZone(root, () => {
      const { block: b, x: ed, slash: open } = now.current
      const text = b.text.trim()
      if (!text || open) return null
      return { tint: tintElement(() => box.current), send: () => ed.ask(b.id, text) }
    })
  }, [])
  const [slash, setSlash] = useState<{ query: string; active: number } | null>(null)
  now.current = { block, x, slash: !!slash }
  useLayoutEffect(() => {
    const t = field.current
    if (!t) return
    t.style.height = '0px'
    t.style.height = `${t.scrollHeight}px`
  }, [block.text])
  useEffect(() => {
    const t = field.current
    if (!t) return
    t.focus()
    const at = caret === 'start' ? 0 : caret === 'end' ? t.value.length : Math.min(caret, t.value.length)
    t.setSelectionRange(at, at)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const matches = (label: string) => !slash || label.toLowerCase().startsWith(slash.query.toLowerCase())
  const items: { type: StoryBlockType | 'section'; label: string; icon: IconName }[] = [...KINDS.filter((k) => matches(k.label)), ...(matches(SECTION_ITEM.label) ? [{ type: 'section' as const, ...SECTION_ITEM }] : [])]
  const pick = (type: StoryBlockType | 'section') => {
    setSlash(null)
    if (type === 'section') return x.splitAt(block.id)
    x.setSections((secs) => updateBlock(secs, block.id, retype({ ...block, text: '' }, type)))
    if (TEXT_TYPES.includes(type)) window.requestAnimationFrame(() => field.current?.focus())
    else x.edit(null)
  }
  const set = (text: string) => x.setSections((secs) => updateBlock(secs, block.id, { text }))
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget
    if (slash) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = Math.max(1, items.length)
        setSlash({ ...slash, active: (slash.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const k = items[slash.active]
        if (k) pick(k.type)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlash(null)
        return
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      x.setSections((secs) => stepBlock(secs, block.id, e.key === 'ArrowUp' ? -1 : 1))
      window.requestAnimationFrame(() => field.current?.focus())
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      x.edit(null)
      return
    }
    const start = t.selectionStart
    const end = t.selectionEnd
    if (e.key === 'Enter' && !e.shiftKey) {
      if (block.type === 'bullets') {
        // Enter on an empty last item ends the list and starts text under it; anywhere else it starts a new item
        const lines = t.value.slice(0, start).split('\n')
        const line = lines[lines.length - 1]
        if (line.trim() || start < t.value.length) return
        e.preventDefault()
        const nb = newBlock(mint)
        x.setSections((secs) => {
          const at = findBlock(secs, block.id)
          const kept = updateBlock(secs, block.id, { text: t.value.replace(/\n+$/, '') })
          return at ? insertBlock(kept, at.s, at.b + 1, nb) : kept
        })
        x.edit(nb.id, 'start')
        return
      }
      e.preventDefault()
      const before = t.value.slice(0, start).replace(/\s+$/, '')
      const after = t.value.slice(end).replace(/^\s+/, '')
      const nb = newBlock(mint, 'text', after)
      x.setSections((secs) => {
        const at = findBlock(secs, block.id)
        const kept = updateBlock(secs, block.id, { text: before })
        return at ? insertBlock(kept, at.s, at.b + 1, nb) : kept
      })
      x.edit(nb.id, 'start')
      return
    }
    if (e.key === 'Backspace' && start === 0 && end === 0) {
      const at = findBlock(x.sections, block.id)
      const prev = at && at.b > 0 ? x.sections[at.s].blocks[at.b - 1] : null
      if (!t.value.trim()) {
        e.preventDefault()
        x.setSections((secs) => removeBlock(secs, block.id))
        x.edit(prev && TEXT_TYPES.includes(prev.type) ? prev.id : null, 'end')
      } else if (prev && prev.type === 'text' && block.type === 'text') {
        // a text block run into the text block above it, the caret where they meet
        e.preventDefault()
        const joined = prev.text.replace(/\s+$/, '')
        x.setSections((secs) => updateBlock(removeBlock(secs, block.id), prev.id, { text: joined ? `${joined} ${t.value.trim()}` : t.value.trim() }))
        x.edit(prev.id, joined ? joined.length + 1 : 0)
      }
    }
  }
  return (
    <div
      ref={box}
      className="wu-se-editing"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        if (x.editing?.id === block.id) x.edit(null)
        x.flush()
      }}
    >
      <textarea
        ref={field}
        className={`wu-se-field wu-se-field-${block.type}`}
        aria-label={KINDS.find((k) => k.type === block.type)?.label ?? 'Text'}
        value={block.text}
        rows={1}
        spellCheck
        onChange={(e) => {
          const v = e.target.value
          set(v)
          // `/` typed into an empty block opens the menu of block types; what follows it narrows the menu
          if ((block.type === 'text' || block.type === 'bullets') && v.startsWith('/') && !v.includes(' ') && !v.includes('\n')) setSlash({ query: v.slice(1), active: 0 })
          else if (slash) setSlash(null)
        }}
        onKeyDown={onKey}
      />
      {block.type === 'quote' && <SpeakerField block={block} />}
      <Popover anchor={field} open={!!slash && items.length > 0} onClose={() => setSlash(null)} role="menu" label="Block types" className="wu-se-slash">
        <div className="menu">
          {items.map((k, i) => (
            <button key={k.type} type="button" role="menuitem" className={`menu-item${slash?.active === i ? ' wu-se-slash-on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(k.type)}>
              <Icon name={k.icon} size={14} className="menu-ico" />
              <span className="menu-item-label">{k.label}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  )
}

/** A quote's speaker, a plain field under the quote while it is typed in. */
function SpeakerField({ block }: { block: StoryBlock }) {
  const x = useEd()
  return <TextField className="wu-se-who" label="Speaker" value={block.speaker ?? ''} onChange={(v) => x.setSections((secs) => updateBlock(secs, block.id, { speaker: v.replace(/\n/g, ' ') }))} onBlur={() => undefined} />
}

/** A card block or a picture of a card: the card, or before one is picked the picker over the canvas's cards. */
function FigureBlockBody({ block }: { block: StoryBlock }) {
  const x = useEd()
  if (!block.cell && block.asked)
    return (
      <div className="wu-prompt wu-prompt-card wu-prompt-busy wu-prompt-sent" aria-label="Sent to main">
        <Icon name="cell-add" size={14} className="wu-prompt-glyph" />
        <span className="wu-prompt-field">{block.asked}</span>
        <Spinner label="working" />
      </div>
    )
  if (!block.cell)
    return (
      <div className="wu-fig wu-fig-pick">
        <FigurePicker ws={x.ws} onPick={(c) => x.setSections((secs) => updateBlock(secs, block.id, { cell: `card:${c.id}`, caption: readableText(c.takeaway || c.title || '') }))} onClose={() => x.setSections((secs) => removeBlock(secs, block.id))} />
      </div>
    )
  if (block.type === 'card') return <FigureView ws={x.ws} figure={{ id: block.id, cell: block.cell, caption: block.caption ?? '' }} />
  return (
    <div className="wu-se-imageblock">
      <CardImage ws={x.ws} block={{ ...block, caption: '' }} />
      <TextField className="wu-sb-image-cap" label="Caption" value={block.caption ?? ''} onChange={(v) => x.setSections((secs) => updateBlock(secs, block.id, { caption: v.replace(/\n/g, ' ') }))} onBlur={x.flush} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- headlines and the card slot

interface HeadRowProps {
  /** the field's id among the editor's fields (`title`, or `head:<section>`) */
  id: string
  /** the id its lock and its chat anchor on: the section's for a headline; the title's by default */
  lockId?: string
  className: string
  label: string
  value: string
  anchor: string
  locked: boolean
  onChange: (v: string) => void
  onEnter: () => void
}

/** The story's title or a section's headline: a field as tall as its text, an empty cell until it has text, with its
 * actions (chat, the lock) at its right. */
function HeadRow({ id, lockId = TITLE_ID, className, label, value, anchor, locked, onChange, onEnter }: HeadRowProps) {
  const x = useEd()
  const row = useRef<HTMLDivElement | null>(null)
  const focus = x.editing?.id === id
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!focus || !field.current) return
    field.current.focus()
    const at = x.editing!.caret === 'start' ? 0 : field.current.value.length
    field.current.setSelectionRange(at, at)
  }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps
  const stored = lockId === TITLE_ID || x.secIds.has(lockId)
  return (
    <div ref={row} className={`wu-se-head${locked ? ' wu-locked' : ''}`} data-anchor={anchor} data-anchor-text={value}>
      <div className="wu-se-body">
        <TextField
          fieldRef={field}
          className={className}
          label={label}
          value={value}
          onChange={onChange}
          onBlur={() => {
            if (x.editing?.id === id) x.edit(null)
            x.flush()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnter()
            }
          }}
        />
      </div>
      <Acts chat={value.trim() && stored ? () => x.chat(row.current) : undefined} lock={value.trim() && stored ? { on: locked, toggle: () => x.toggleLock(lockId, !locked) } : undefined} />
    </div>
  )
}

/** A section's card slot: its card with its caption and actions, or an empty cell that takes a dropped card or opens
 * the picker on a click. */
function CardSlot({ section, index, target }: { section: StorySection; index: number; target: boolean }) {
  const x = useEd()
  const [picking, setPicking] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const set = (main: StoryFigure | null) => x.setSections((secs) => secs.map((s, k) => (k === index ? { ...s, main } : s)))
  const main = section.main
  const fresh = !section.heading.trim() && section.blocks.every((b) => !b.text.trim() && !b.cell)
  if (!main?.cell)
    return (
      <div ref={box} className={`wu-se-card wu-se-card-empty${fresh ? ' wu-se-card-new' : ''}${target ? ' wu-cell-target' : ''}`}>
        <button type="button" className="wu-cell-pick" aria-label="Pick a card" onClick={() => setPicking(true)} />
        <Popover anchor={box} open={picking} onClose={() => setPicking(false)} label="Cards" width={320} className="wu-slot-picker">
          <FigurePicker
            ws={x.ws}
            onPick={(c: Cell) => {
              setPicking(false)
              set({ id: mint(), cell: `card:${c.id}`, caption: readableText(c.title || '') })
            }}
            onClose={() => setPicking(false)}
          />
        </Popover>
      </div>
    )
  const locked = x.locked.has(main.id)
  const stored = x.figs.get(main.id)
  const isStored = !!stored
  // the step the writer gave the section's card, while the card is still the one it was given for
  const step = stored?.cell === main.cell ? { highlight: stored.highlight, callout: stored.callout } : {}
  return (
    <div ref={box} className={`wu-se-card${target ? ' wu-cell-target' : ''}${locked ? ' wu-locked' : ''}`} data-anchor={main.cell} data-anchor-text={main.caption}>
      <div className="wu-se-card-in">
        <TextField className="wu-story-cap" label="Caption" value={main.caption} onChange={(v) => set({ ...main, caption: v.replace(/\n/g, ' ') })} onBlur={x.flush} />
        <StepFigure ws={x.ws} figure={{ id: main.id, cell: main.cell, caption: main.caption, ...step }} />
        <button type="button" className="wu-fig-from" onClick={() => teleport(main.cell)}>
          from canvas
        </button>
      </div>
      <Acts
        chat={isStored ? () => x.chat(box.current) : undefined}
        remove={() => set(null)}
        lock={isStored ? { on: locked, toggle: () => x.toggleLock(main.id, !locked) } : undefined}
        onDragStart={(e) => x.drag(e, 'main', main.id)}
      />
    </div>
  )
}

/** A textarea made as tall as its text. */
function fitHeight(t: HTMLTextAreaElement): void {
  t.style.height = '0px'
  t.style.height = `${t.scrollHeight}px`
}

/** A plain field as tall as its text, also when its column narrows or widens, drawn as an empty cell until it has
 * text. */
function TextField({ className, label, value, onChange, onBlur, onKeyDown, fieldRef }: { className: string; label: string; value: string; onChange: (v: string) => void; onBlur: () => void; onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void; fieldRef?: Ref<HTMLTextAreaElement> }) {
  const el = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    if (el.current) fitHeight(el.current)
  }, [value])
  useEffect(() => {
    const t = el.current
    if (!t) return
    let width = t.clientWidth
    const ro = new ResizeObserver(() => {
      if (t.clientWidth === width) return
      width = t.clientWidth
      fitHeight(t)
    })
    ro.observe(t)
    return () => ro.disconnect()
  }, [])
  return (
    <textarea
      ref={(node) => {
        el.current = node
        if (typeof fieldRef === 'function') fieldRef(node)
        else if (fieldRef) (fieldRef as { current: HTMLTextAreaElement | null }).current = node
      }}
      className={`wu-tpl ${className}${value.trim() ? '' : ' wu-tpl-empty'}`}
      value={value}
      rows={1}
      aria-label={label}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
    />
  )
}

/** The story's sidebar: the canvas's cards to drag into a section or double-click into the last section worked in,
 * then the Checks pane. */
export function StorySidebar({ ws, doc, slug, onInsert, onHide, over, checks, comments }: Omit<SidebarProps, 'cells' | 'groups' | 'used' | 'doc'> & { doc: StoryDoc | null; slug: string }) {
  const { cells, groups } = useCanvas(ws)
  const used = useMemo(() => usedCells(storyCells(doc)), [doc])
  return <Sidebar ws={ws} cells={cells} groups={groups} used={used} onInsert={onInsert} onHide={onHide} over={over} doc={slug} checks={checks} comments={comments} />
}
