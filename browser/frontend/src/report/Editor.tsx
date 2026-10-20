// The report's block editor: BlockNote with the report's schema, the slash menu, a toolbar of text styles, thimble's
// actions beside a hovered block (kind, ask, delete), prompts (a request to Claude placed in the report), the marks'
// tints and the filter as decorations, cards dropped from the sidebar or the chat as figure blocks, and one debounced
// save of the whole document to PUT …/blocks. Loaded on demand, so BlockNote and Mantine stay out of the main chunk.
import '@blocknote/mantine/style.css'
import { createExtension, filterSuggestionItems, insertOrUpdateBlockForSlashMenu, SideMenuExtension, type BlockNoteEditor } from '@blocknote/core'
import { en } from '@blocknote/core/locales'
import { BlockNoteView } from '@blocknote/mantine'
import {
  BasicTextStyleButton,
  CreateLinkButton,
  FormattingToolbar,
  FormattingToolbarController,
  SideMenuController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor,
  useCreateBlockNote,
  useEditorChange,
  useExtension,
  useExtensionState,
  type DefaultReactSuggestionItem,
} from '@blocknote/react'
import { Plugin, TextSelection } from 'prosemirror-state'
import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type Ref } from 'react'
import { Button } from '../components/Button'
import { Icon, type IconName } from '../components/Icon'
import { Menu } from '../components/Menu'
import { api, reportApi } from '../lib/api'
import { bus } from '../lib/bus'
import { pointKeyHeld } from '../lib/platform'
import { track } from '../lib/telemetry'
import { useTheme } from '../lib/theme'
import type { Writeup } from '../lib/types'
import { blockPos, caretBack, caretInBlock, caretNear } from './caret'
import { CARD_MIME } from './cards'
import { ReportContext, type ReportCtx } from './context'
import { marksExtension, refreshMarks, type Flag, type MarksCtx, type TermMark } from './decorations'
import { mergeUnsaved } from './merge'
import { actsTop, anchorAbove, anchorFor, BLOCK_KINDS, blockOfKind, blocksFromDoc, dropSlot, editorBlocksFromWire, kindOf, origTexts, PROMPT_TYPE, lastChanged, readableOf, sameWire, TITLE_ID, wireFromEditor, type BlockKind, type DocBlocks, type EditorBlockLike, type InlinePart, type ReportFilterSets } from './model'
import { schema, type ReportPartialBlock } from './schema'

export const SAVE_DEBOUNCE_MS = 800
/** a write streaming in stops keeping its growing block in view for this long after the analyst scrolls */
const FOLLOW_AFTER_SCROLL_MS = 4000

/** Run `fn` once `el` is laid out: on the next frame when it is, else once the hidden tab that holds it is shown (the
 * element's box grows from nothing). Returns the cancel. */
export function whenShown(el: Element | null, fn: () => void): () => void {
  if (!el) return () => undefined
  let raf = 0
  if (el.getClientRects().length > 0) {
    raf = window.requestAnimationFrame(fn)
    return () => window.cancelAnimationFrame(raf)
  }
  const ro = new ResizeObserver(() => {
    if (el.getClientRects().length === 0) return
    ro.disconnect()
    raf = window.requestAnimationFrame(fn)
  })
  ro.observe(el)
  return () => {
    ro.disconnect()
    window.cancelAnimationFrame(raf)
  }
}

/** The toolbar's entries with their tooltips (the names of icon-only buttons) and no shortcut under them. */
const TOOLBAR = Object.fromEntries(Object.entries(en.formatting_toolbar).map(([k, v]) => [k, 'secondary_tooltip' in v ? { ...v, secondary_tooltip: '' } : v])) as typeof en.formatting_toolbar

/** The dictionary with no placeholders and no shortcut hints, and the slash items in plain words. */
const DICTIONARY = {
  ...en,
  placeholders: Object.fromEntries(Object.keys(en.placeholders).map((k) => [k, ''])),
  formatting_toolbar: TOOLBAR,
  link_toolbar: { ...en.link_toolbar, form: { title_placeholder: '', url_placeholder: '' } },
  slash_menu: {
    ...en.slash_menu,
    heading_2: { ...en.slash_menu.heading_2, title: 'Heading', subtext: '', group: 'Blocks' },
    heading_3: { ...en.slash_menu.heading_3, title: 'Subheading', subtext: '', group: 'Blocks' },
    paragraph: { ...en.slash_menu.paragraph, title: 'Text', subtext: '', group: 'Blocks' },
    bullet_list: { ...en.slash_menu.bullet_list, title: 'Bullets', subtext: '', group: 'Blocks' },
    numbered_list: { ...en.slash_menu.numbered_list, title: 'Numbers', subtext: '', group: 'Blocks' },
    quote: { ...en.slash_menu.quote, title: 'Quote', subtext: '', group: 'Blocks' },
  },
}
/** the default slash items the document can store */
const KEEP = new Set(['Heading', 'Subheading', 'Text', 'Bullets', 'Numbers', 'Quote'])

/** Each kind of text block, named and drawn as the slash menu's items and the kind's menu name and draw them. */
const KINDS: Record<BlockKind, { label: string; icon: IconName }> = {
  text: { label: 'Text', icon: 'letter' },
  heading: { label: 'Heading', icon: 'heading' },
  subheading: { label: 'Subheading', icon: 'subheading' },
  bullets: { label: 'Bullets', icon: 'bullets' },
  numbers: { label: 'Numbers', icon: 'numbers' },
  quote: { label: 'Quote', icon: 'cite' },
}

export interface DocFilter {
  concept: string
  name: string
  value: string
  sets: ReportFilterSets
}

/** What the page around the editor can ask of it: a card placed as a figure at the end of the document. */
export interface EditorHandle {
  insertCard: (cellId: string) => void
}

export interface ReportEditorProps {
  ws: string
  slug: string
  doc: Writeup
  /** the tint of every marked passage */
  flags: ReadonlyMap<string, Flag>
  /** the lenses' marks, highlighted on their words */
  marks?: readonly TermMark[]
  filter: DocFilter | null
  /** this tab's token, echoed in the `edited` event */
  client: string
  /** the stored document after a save landed */
  onSaved: (doc: Writeup) => void
  /** the cells the blocks show as figures, after every change */
  onFigures?: (cells: string[]) => void
  /** the caption a card dropped from the sidebar starts with: its takeaway, else its question */
  captionOf?: (cellId: string) => string
  ref?: Ref<EditorHandle>
}

type AnyEditor = BlockNoteEditor<any, any, any>

const textOfBlock = (block: { type: string; props?: unknown; content?: unknown }): string => {
  const props = (block.props ?? {}) as { caption?: string }
  return block.type === 'figure' ? String(props.caption ?? '') : readableOf(block.content as InlinePart[] | undefined)
}

const hasContent = (block: { type: string; props?: unknown; content?: unknown }): boolean => block.type === 'figure' || !!textOfBlock(block)

/** Whether the editor holds nothing yet: no title, and no block with text or a figure. */
const isEmptyDoc = (blocks: readonly EditorBlockLike[]): boolean => blocks.every((b) => !hasContent(b) && !b.children?.length)

/** Ask about the block at the cursor through the ⌘-click box (`chat`). From an empty block (the slash line) the box is
 * about the nearest block above that has content, and the empty block is removed; with none there is nothing to ask. */
function askAbout(editor: AnyEditor, chat: (blockId: string) => void): void {
  const at = editor.getTextCursorPosition().block
  let block: typeof at | undefined = at
  if (!hasContent(at)) {
    block = editor.getPrevBlock(at.id)
    while (block && !hasContent(block)) block = editor.getPrevBlock(block.id)
  }
  if (!hasContent(at) && block && editor.document.length > 1) editor.removeBlocks([at.id])
  if (block) chat(block.id)
}

/** The slash menu's Turn into items for the block at the cursor: one for each other kind, when the block is text with
 * something in it besides the slash's query (an empty line takes the kinds' own items, which turn it). */
function turnItems(editor: AnyEditor, turn: (blockId: string, kind: BlockKind) => void): DefaultReactSuggestionItem[] {
  const at = editor.getTextCursorPosition().block
  const kind = kindOf(at)
  if (!kind || !textOfBlock(at).replace(/\/\S*$/, '').trim()) return []
  return BLOCK_KINDS.filter((k) => k !== kind).map((k) => ({
    title: `Turn into ${KINDS[k].label.toLowerCase()}`,
    group: 'Turn into',
    aliases: ['turn', 'convert', KINDS[k].label.toLowerCase()],
    icon: <Icon name={KINDS[k].icon} size={14} />,
    onItemClick: () => turn(at.id, k),
  }))
}

function slashItems(editor: AnyEditor, ws: string, slug: string, chat: (blockId: string) => void, turn: (blockId: string, kind: BlockKind) => void): DefaultReactSuggestionItem[] {
  // no shortcut badges: a gesture hint is helper text
  const defaults = getDefaultReactSlashMenuItems(editor)
    .filter((it) => KEEP.has(it.title))
    .map((it) => ({ ...it, badge: undefined }))
  return [
    ...defaults,
    ...turnItems(editor, turn),
    {
      title: 'Figure',
      group: 'Report',
      aliases: ['fig', 'chart', 'table'],
      icon: <Icon name="cell" size={14} />,
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: 'figure', props: { cell: '', caption: '' } } as never)
      },
    },
    {
      title: 'Ask Claude here',
      group: 'Report',
      aliases: ['prompt', 'request', 'write', 'draw', 'make', 'plot', 'claude'],
      icon: <Icon name="prompt" size={14} />,
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: PROMPT_TYPE } as never)
      },
    },
    {
      title: 'Ask about this block',
      group: 'Report',
      aliases: ['ask', 'thread', 'thimble', 'chat'],
      icon: <Icon name="chat" size={14} />,
      onItemClick: () => askAbout(editor, chat),
    },
  ]
}

/** The figure blocks' cells, in document order. */
function figureCells(blocks: readonly EditorBlockLike[]): string[] {
  const out: string[] = []
  const walk = (list: readonly EditorBlockLike[]) => {
    for (const b of list) {
      if (b.type === 'figure' && b.props?.cell) out.push(String(b.props.cell))
      if (b.children?.length) walk(b.children)
    }
  }
  walk(blocks)
  return out
}

/** What the hovered block's actions reach in the editor: the chat about a block, and its change of kind. */
interface ActsCtx {
  slug: string
  chat: (blockId: string) => void
  turn: (blockId: string, kind: BlockKind) => void
}
const ActsContext = createContext<ActsCtx | null>(null)

/** A block the document stores, so a thread can anchor on it: the title, a heading, a figure on a card, or text that
 * is not empty (an empty line and a prompt are never saved). */
const stored = (block: { type: string; props?: unknown; content?: unknown }): boolean =>
  block.type === 'figure' ? !!(block.props as { cell?: string } | undefined)?.cell : block.type !== PROMPT_TYPE && !!textOfBlock(block)

/** The space (px) between the text's right edge and the hovered block's actions, which clears the dashed outline an
 * empty cell draws 5px outside its text (report.css). report.css keeps the gutter at the right as wide as the actions
 * (`--wu-gutter-r`) and draws a locked block's lock at rest where the actions' lock stands (`--wu-acts-gap`, the same
 * 12). */
const ACTS_GAP = 12

/** The content element of a block (`.bn-block`): its direct child, or inside the wrapper a React block (a figure, a
 * prompt) is drawn in. */
const contentOf = (block: Element): HTMLElement | null => block.querySelector<HTMLElement>(':scope > .bn-block-content, :scope > .react-renderer > .bn-block-content')

/** A block's first line on screen: a line of text (its box's top and its line height), a figure's head row, or the top
 * of any other block's content; and the right edge of the block's content, where the text column ends. */
function firstLine(block: Element): { top: number; height: number; right: number } | null {
  const content = contentOf(block)
  if (!content) return null
  const right = content.getBoundingClientRect().right
  const text = content.querySelector<HTMLElement>(':scope > .bn-inline-content')
  if (text) {
    const lh = parseFloat(getComputedStyle(text).lineHeight)
    const r = text.getBoundingClientRect()
    return { top: r.top, height: Number.isFinite(lh) ? lh : r.height, right }
  }
  const head = content.querySelector<HTMLElement>('.wu-fig-head')
  const r = (head ?? content).getBoundingClientRect()
  return { top: r.top, height: head ? r.height : Math.min(r.height, 24), right }
}

/** The top of the pane the page scrolls in (the nearest ancestor that scrolls), in viewport coordinates. */
function paneTop(el: Element): number {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p.getBoundingClientRect().top
  }
  return 0
}

/** The actions stand in the gutter at the right of the hovered block, centred on its first line, or at the pane's top
 * while that line is scrolled above it (model.ts actsTop). BlockNote places its side menu at the block's left with
 * offsets for its own type sizes, so the placement and the offset are the report's. */
const ACTS_FLOATING = {
  useFloatingOptions: {
    placement: 'right-start' as const,
    middleware: [
      {
        name: 'wuFirstLine',
        fn: ({ x, y, rects, elements }: { x: number; y: number; rects: { floating: { height: number } }; elements: { reference: unknown } }) => {
          const el = (elements.reference as { contextElement?: Element }).contextElement
          const line = el ? firstLine(el) : null
          if (!el || !line) return { x: x + ACTS_GAP, y }
          const box = el.getBoundingClientRect()
          const top = actsTop(line, rects.floating.height, box.bottom, paneTop(el) + ACTS_GAP)
          return { x: x + line.right - box.right + ACTS_GAP, y: y + top - box.top }
        },
      },
    ],
  },
}

/** The hovered block's actions in the gutter at the right of its first line: its kind menu, then ask and delete.
 * BlockNote's side menu carries them, so they follow the pointer's block. The title has no kind and no delete; a figure
 * and a prompt have no kind; an unstored block has no ask. A drag on the actions moves the block (⌘⇧↑ and ⌘⇧↓ from the keyboard); a figure
 * also moves by its question line (FigureBlock figureDrag). */
function BlockActions() {
  const editor = useBlockNoteEditor() as AnyEditor
  const sideMenu = useExtension(SideMenuExtension)
  const ctx = useContext(ActsContext)
  const block = useExtensionState(SideMenuExtension, { selector: (s) => s?.block })
  if (!ctx || !block) return null
  const kept = stored(block)
  const title = block.id === TITLE_ID
  // a figure carries its own controls inside its frame (FigureBlock), and moves by its question line
  if ((title && !kept) || block.type === 'figure') return null
  const kind = kindOf(block)
  return (
    <div
      className="wu-acts"
      draggable={!title}
      onDragStart={(e) => {
        sideMenu.blockDragStart(e, block)
        track('ui-click', { target: anchorFor(ctx.slug, { id: block.id, type: block.type }), detail: { action: 'block-move' } })
      }}
      onDragEnd={sideMenu.blockDragEnd}
    >
      {kind && (
        <Menu
          label="Turn into"
          className="wu-acts-kind"
          onOpenChange={(open) => (open ? sideMenu.freezeMenu() : sideMenu.unfreezeMenu())}
          trigger={<Button variant="icon" size="sm" icon={KINDS[kind].icon} title="Turn into" tipAlign="start" />}
          items={BLOCK_KINDS.map((k) => ({ id: k, label: KINDS[k].label, icon: KINDS[k].icon, checked: k === kind, onSelect: () => ctx.turn(block.id, k) }))}
        />
      )}
      {kept && <Button variant="icon" size="sm" icon="chat" title="Ask about this block" tipAlign="start" onClick={() => ctx.chat(block.id)} />}
      {!title && (
        <Button
          variant="icon"
          size="sm"
          tipAlign="start"
          icon="trash"
          title="Delete"
          className="wu-acts-delete"
          onClick={() => {
            const view = editor.prosemirrorView
            const at = view ? blockPos(view.state.doc, block.id) : null
            editor.removeBlocks([block.id])
            // the editor takes the focus back, with the caret where the block stood, so a ⌘Z pressed next runs the
            // editor's own undo and brings the block back. With the focus left on this button, ⌘Z would go to the top
            // bar's undo, which before the debounced save lands reverts the step before the delete (a lock) instead
            if (view && at != null) {
              const sel = caretNear(view.state.doc, at)
              if (sel) view.dispatch(view.state.tr.setSelection(sel))
              view.focus()
            }
            track('ui-click', { target: anchorFor(ctx.slug, { id: block.id, type: block.type }), detail: { action: 'block-delete' } })
          }}
        />
      )}
    </div>
  )
}

/** A press with the ⌘ pointer's key held (pointer/CmdPointer.tsx) is left to the pointer and the browser. ProseMirror
 * reads ⌘ with a click (Ctrl off a Mac) as its select-node modifier: it would select the whole block on a ⌘-click and,
 * on the next ⌘-press inside that block, drag it, where a ⌘-drag selects text. */
const pointerPressExtension = () =>
  createExtension({
    key: 'thimblePointerPress' as const,
    prosemirrorPlugins: [new Plugin({ props: { handleDOMEvents: { mousedown: (_view, e) => e.button === 0 && pointKeyHeld(e) } } })],
  })

export function ReportEditor({ ws, slug, doc, flags, marks, filter, client, onSaved, onFigures, captionOf, ref }: ReportEditorProps) {
  const { resolved } = useTheme()
  const docRef = useRef<Writeup | null>(doc)
  const ctx = useRef<MarksCtx>({ slug, doc, flags, marks, filter: filter?.sets ?? null })
  const initial = useMemo(() => editorBlocksFromWire(blocksFromDoc(doc)) as ReportPartialBlock[], []) // eslint-disable-line react-hooks/exhaustive-deps
  // the line where a moved block lands is drawn by report.css as the card's drop line is (`.wu-dropline`), not in
  // BlockNote's pale blue bar, so both drags show one mark and neither reads as Notion's
  const editor = useCreateBlockNote({ schema, initialContent: initial, dictionary: DICTIONARY as typeof en, extensions: [marksExtension(ctx.current), pointerPressExtension()], trailingBlock: true, dropCursor: { color: false, width: 3 }, domAttributes: { editor: { spellcheck: 'false' } } }, [])

  const lastSaved = useRef<DocBlocks>(blocksFromDoc(doc))
  const orig = useRef<Map<string, string>>(origTexts(lastSaved.current))
  const own = useRef<Writeup | null>(null)
  const dirty = useRef(false)
  const muted = useRef(false)
  const timer = useRef<number | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const queued = useRef(false)
  const flush = useCallback(async () => {
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
    const wire = wireFromEditor(editor.document as EditorBlockLike[], orig.current)
    if (sameWire(wire, lastSaved.current)) return
    const p = (async () => {
      try {
        const saved = await reportApi.putBlocks(ws, slug, { ...wire, client })
        lastSaved.current = wire
        const stored = blocksFromDoc(saved)
        for (const [id, text] of origTexts(stored)) orig.current.set(id, text)
        own.current = saved
        docRef.current = saved
        track('report-frame-edit', { target: `report:${slug}`, detail: { blocks: wire.blocks.length } })
        onSaved(saved)
      } catch (e) {
        dirty.current = true
        bus.emit('toast', { text: `Could not save the report. ${(e as Error).message}`, kind: 'error' })
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
  }, [editor, ws, slug, client, onSaved])

  const schedule = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }, [flush])

  // a prompt block's Enter: the document is saved first, then the request goes to Claude in the chat (POST /write) with
  // the words of the passage above it, so Claude answers it there (a figure or a paragraph after it, or the passage
  // changed); the prompt block, which is never saved, gives way, and the stream's `report` events bring the change back
  const submitPrompt = useCallback(
    async (blockId: string, request: string) => {
      const blocks = editor.document as EditorBlockLike[]
      const above = anchorAbove(blocks, blockId)
      const find = (list: readonly EditorBlockLike[]): EditorBlockLike | undefined => {
        for (const b of list) {
          const hit = b.id === above ? b : find((b.children ?? []) as EditorBlockLike[])
          if (hit) return hit
        }
        return undefined
      }
      const block = above ? find(blocks) : undefined
      const afterText = block ? textOfBlock(block) : ''
      if (inflight.current) await inflight.current.catch(() => undefined)
      await flush()
      const got = await api.write(ws, slug, { text: request, ...(afterText ? { after_text: afterText } : {}) })
      if (got.kind === 'busy') throw new Error(got.reason || 'Claude is still answering in the chat')
      track('ui-click', { target: 'ui:report-prompt', detail: { placed: !!afterText } })
      muted.current = true
      try {
        if (editor.document.some((b) => b.id === blockId)) editor.removeBlocks([blockId])
      } finally {
        muted.current = false
      }
    },
    [editor, flush, ws, slug],
  )
  const reportCtx = useMemo<ReportCtx>(() => ({ ws, slug, docRef, submitPrompt }), [ws, slug, submitPrompt])

  // a block turned into another kind from its type menu or the slash menu: the block keeps its id and its text
  const turnInto = useCallback(
    (blockId: string, kind: BlockKind) => {
      const block = editor.getBlock(blockId)
      if (!block || kindOf(block) === kind) return
      editor.updateBlock(blockId, blockOfKind(kind) as never)
      editor.setTextCursorPosition(blockId, 'end')
      editor.focus()
      track('ui-click', { target: anchorFor(slug, { id: blockId, type: block.type }), detail: { action: 'block-kind', kind } })
    },
    [editor, slug],
  )

  // what is typed since the last save goes to the server first, so a block made since then exists there under the
  // editor's id
  const saveNow = useCallback(async () => {
    if (inflight.current) await inflight.current.catch(() => undefined)
    await flush()
    if (inflight.current) await inflight.current.catch(() => undefined)
  }, [flush])

  const zone = useRef<HTMLDivElement | null>(null)
  const scrolledAt = useRef(0)

  // the chat about a block, on the block's anchor. A block typed since the last save has no anchor yet, so the document
    // is saved first and the marks rebuilt from it
  const chatAbout = useCallback(
    async (blockId: string) => {
      const anchorOf = (): HTMLElement | null => {
        const block = zone.current?.querySelector(`.bn-block-outer[data-id="${CSS.escape(blockId)}"] > .bn-block`)
        const content = block ? contentOf(block) : null
        if (!content) return null
        return content.hasAttribute('data-anchor') ? content : content.querySelector<HTMLElement>('[data-anchor]')
      }
      let el = anchorOf()
      if (!el) {
        await saveNow()
        const kept = docRef.current
        if (kept) {
          ctx.current.doc = kept
          refreshMarks(editor)
        }
        el = anchorOf()
      }
      if (el) bus.emit('askAbout', { el })
    },
    [editor, saveNow],
  )
  const actsCtx = useMemo<ActsCtx>(() => ({ slug, chat: (id) => void chatAbout(id), turn: turnInto }), [slug, chatAbout, turnInto])

  // an empty report is one empty block after the title, drawn as an empty cell (report.css `.wu-zone-empty`) until
  // something is written
  const [empty, setEmpty] = useState(() => isEmptyDoc(initial as EditorBlockLike[]))
  const figuresCb = useRef(onFigures)
  figuresCb.current = onFigures
  useEditorChange(() => {
    setEmpty(isEmptyDoc(editor.document as EditorBlockLike[]))
    figuresCb.current?.(figureCells(editor.document as EditorBlockLike[]))
    if (muted.current) return
    dirty.current = true
    schedule()
  }, editor)
  useEffect(() => {
    figuresCb.current?.(figureCells(editor.document as EditorBlockLike[]))
  }, [editor])

  // an empty report opens with the caret in its one block, ready to type in (in a hidden tab, once the tab is shown)
  useEffect(() => {
    if (!isEmptyDoc(editor.document as EditorBlockLike[])) return
    return whenShown(zone.current, () => {
      if (!editor.prosemirrorView || !isEmptyDoc(editor.document as EditorBlockLike[])) return
      if (!editor.document.some((b) => b.id !== TITLE_ID)) editor.insertBlocks([{ type: 'paragraph' }], TITLE_ID, 'after')
      const first = editor.document.find((b) => b.id !== TITLE_ID)
      if (!first) return
      editor.setTextCursorPosition(first, 'start')
      editor.focus()
    })
  }, [editor])

  // the blocks rebuilt from a stored document, outside the editor's undo history, so ⌘Z undoes only what the analyst
    // typed, never a writer's or thread's change (the top bar's Undo reverts those). The caret stays in its block
  const showStored = useCallback(
    (wire: DocBlocks) => {
      const view = editor.prosemirrorView
      const caret = view && view.hasFocus() ? caretInBlock(view.state.selection) : null
      muted.current = true
      try {
        editor.transact((tr) => {
          tr.setMeta('addToHistory', false)
          editor.replaceBlocks(editor.document, editorBlocksFromWire(wire) as ReportPartialBlock[])
        })
      } finally {
        muted.current = false
      }
      const back = caret && view ? caretBack(view.state.doc, caret) : null
      if (back && view) view.dispatch(view.state.tr.setSelection(back))
    },
    [editor],
  )
  const scheduleRef = useRef(schedule)
  scheduleRef.current = schedule

  // a document from outside (a write, a thread's rewrite, the verifier, another tab). With nothing pending here the
  // editor shows it. With edits not saved yet (typed, or a save on its way) it is merged in (merge.ts): the analyst's
  // changed blocks stay theirs and every other block takes the stored text, so the save that follows keeps the other
  // writer's changes and who made them rather than putting back the text the editor held
  useEffect(() => {
    docRef.current = doc
    if (doc === own.current) return
    const wire = blocksFromDoc(doc)
    const current = wireFromEditor(editor.document as EditorBlockLike[], orig.current)
    // Claude's write as it streams in: shown as it grows, its growing block kept in view unless the analyst scrolls,
    // and never saved from here; the saved document that ends it comes through the paths below
    if (doc.drafting) {
      if (sameWire(wire, current)) return
      const grows = lastChanged(current, wire)
      showStored(wire)
      if (grows && Date.now() - scrolledAt.current > FOLLOW_AFTER_SCROLL_MS) {
        zone.current?.querySelector(`[data-id="${CSS.escape(grows)}"]`)?.scrollIntoView({ block: 'nearest' })
      }
      return
    }
    if (!dirty.current && !inflight.current) {
      if (!sameWire(wire, current)) showStored(wire)
      lastSaved.current = wire
      orig.current = origTexts(wire)
      return
    }
    const merged = mergeUnsaved(wire, lastSaved.current, current)
    if (!sameWire(merged, current)) showStored(merged)
    lastSaved.current = wire
    orig.current = new Map([...orig.current, ...origTexts(wire)])
    dirty.current = true
    scheduleRef.current()
  }, [doc, editor, showStored])

  useEffect(() => {
    ctx.current.doc = doc
    ctx.current.flags = flags
    ctx.current.filter = filter?.sets ?? null
    ctx.current.slug = slug
    ctx.current.marks = marks
    refreshMarks(editor)
  }, [doc, flags, marks, filter, slug, editor])

  // a card from the sidebar: a figure block before the block `before` names, else after the document's last block
  // that says something (the trailing empty line stays last)
  const insertCard = useCallback(
    (cellId: string, before: string | null = null) => {
      const figure = { type: 'figure', props: { cell: `card:${cellId}`, caption: captionOf?.(cellId) ?? '' } } as never
      const blocks = editor.document
      if (before && before !== TITLE_ID && blocks.some((b) => b.id === before)) {
        editor.insertBlocks([figure], before, 'before')
      } else {
        const last = [...blocks].reverse().find((b) => b.type !== 'paragraph' || readableOf(b.content as InlinePart[] | undefined)) ?? blocks[0]
        editor.insertBlocks([figure], last.id, 'after')
      }
      track('ui-click', { target: `cell:${cellId}`, detail: { action: 'report-card' } })
    },
    [editor, captionOf],
  )
  useImperativeHandle(ref, () => ({ insertCard: (cellId: string) => insertCard(cellId) }), [insertCard])

  // the page's top-level blocks, their viewport tops and bottoms in order
  const topBlocks = (): { id: string; top: number; bottom: number }[] => {
    const root = zone.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('.bn-block-group[data-node-type="blockGroup"] > .bn-block-outer'))
      .filter((el) => !el.parentElement?.closest('.bn-block-outer'))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.getAttribute('data-id') ?? '', top: r.top, bottom: r.bottom }
      })
  }

  // the drop line: where a card dragged over the page goes, as the top of the block it would stand before (or the
  // bottom of the last), relative to the zone
  const [line, setLine] = useState<{ top: number; before: string | null } | null>(null)
  const slotAt = (y: number): { top: number; before: string | null } | null => {
    const root = zone.current
    if (!root) return null
    const slot = dropSlot(topBlocks(), y, TITLE_ID)
    if (!slot) return null
    return { top: slot.at - root.getBoundingClientRect().top, before: slot.before }
  }
  const isCard = (e: ReactDragEvent) => Array.from(e.dataTransfer.types).includes(CARD_MIME)
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!isCard(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    const next = slotAt(e.clientY)
    if (next?.top !== line?.top || next?.before !== line?.before) setLine(next)
  }
  // a dragleave fires for every child the pointer crosses, with no related target in Chromium: the line goes only once
  // the pointer is outside the zone
  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!isCard(e)) return
    const r = zone.current?.getBoundingClientRect()
    if (r && e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return
    setLine(null)
  }
  useEffect(() => {
    const clear = () => setLine(null)
    document.addEventListener('dragend', clear)
    return () => document.removeEventListener('dragend', clear)
  }, [])
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!isCard(e)) return
    e.preventDefault()
    e.stopPropagation()
    const cellId = e.dataTransfer.getData(CARD_MIME)
    const slot = slotAt(e.clientY)
    setLine(null)
    if (cellId) insertCard(cellId, slot?.before ?? null)
  }

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      if (dirty.current) void flush()
    },
    [flush],
  )

  const items = useCallback(async (query: string) => filterSuggestionItems(slashItems(editor, ws, slug, (id) => void chatAbout(id), turnInto), query), [editor, ws, slug, chatAbout, turnInto])

  // while anything is dragged (a block by its actions or a figure by its question line, a card from the sidebar), the
  // page takes the drag over a figure's frame too (report.css `.wu-zone[data-dragging]`, an attribute React leaves
  // alone): a frame's page, such as a custom card's, would otherwise take the drag events, so no drop line shows over it
  // and a drop there does nothing
  useEffect(() => {
    const on = () => zone.current?.setAttribute('data-dragging', '')
    const off = () => zone.current?.removeAttribute('data-dragging')
    document.addEventListener('dragstart', on, true)
    document.addEventListener('dragend', off, true)
    document.addEventListener('drop', off, true)
    return () => {
      document.removeEventListener('dragstart', on, true)
      document.removeEventListener('dragend', off, true)
      document.removeEventListener('drop', off, true)
    }
  }, [])

  // after a drop from the actions' drag, ProseMirror leaves the editor blurred with the node selection standing, so
  // the selection collapses to the drop point and the editor takes focus, with the dropped block's start as a fallback
  // once the drag ends. Whether the drop is the editor's is read as the event starts, since by the time it bubbles
  // here the target has left the document
  useEffect(() => {
    let dropped = false
    let ours = false
    const onDropStart = (e: DragEvent) => {
      const view = editor.prosemirrorView
      ours = !!view && !!e.dataTransfer?.types.includes('blocknote/html') && e.target instanceof Node && view.dom.contains(e.target)
    }
    const onDrop = (e: DragEvent) => {
      const view = editor.prosemirrorView
      if (!view || !ours) return
      ours = false
      dropped = true
      // nothing stands before the title: a block dropped above it goes right after it, where the stored document puts
      // it (the first section's opening), and the cursor goes to its start
      const top = editor.document.findIndex((b) => b.id === TITLE_ID)
      if (top > 0) {
        const moved = editor.document.slice(0, top)
        editor.removeBlocks(moved.map((b) => b.id))
        editor.insertBlocks(moved as never, TITLE_ID, 'after')
        editor.setTextCursorPosition(moved[0].id, 'start')
      } else {
        try {
          const pos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
          if (pos != null) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
        } catch {
          /* a drop point outside the document: the dragend fallback still places the cursor */
        }
      }
      view.focus()
    }
    const onDragEnd = () => {
      if (!dropped) return
      dropped = false
      window.setTimeout(() => {
        const view = editor.prosemirrorView
        if (!view) return
        try {
          const block = editor.getTextCursorPosition().block
          editor.setTextCursorPosition(block, 'start')
        } catch {
          /* the selection may sit outside a block: the focus alone still clears the drag state */
        }
        editor.focus()
        view.dom.classList.remove('ProseMirror-hideselection')
      }, 0)
    }
    // a click outside a standing selection collapses it at once: otherwise a decoration change before the next
    // selectionchange makes ProseMirror write the old selection back over the caret. A click inside is left alone so
    // it can be dragged; a ⌘-press inside collapses it too, to start a new selection
    const onMouseDown = (e: MouseEvent) => {
      const view = editor.prosemirrorView
      if (!view || e.button !== 0 || e.shiftKey || !(e.target instanceof Node) || !view.dom.contains(e.target)) return
      if (e.target instanceof Element && e.target.closest('[contenteditable="false"]')) return
      const sel = view.state.selection
      const pos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
      if (pos == null || (!pointKeyHeld(e) && pos >= sel.from && pos <= sel.to)) return
      try {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
      } catch {
        /* a point the document cannot resolve: the browser's own caret placement stands */
      }
    }
    document.addEventListener('drop', onDropStart, true)
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragend', onDragEnd)
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('drop', onDropStart, true)
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('dragend', onDragEnd)
      document.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [editor])

  return (
    <ReportContext.Provider value={reportCtx}>
      <div
        className={['wu-zone', empty ? 'wu-zone-empty' : ''].filter(Boolean).join(' ')}
        ref={zone}
        onWheelCapture={() => (scrolledAt.current = Date.now())}
        onTouchMoveCapture={() => (scrolledAt.current = Date.now())}
        onDragOverCapture={onDragOver}
        onDragLeaveCapture={onDragLeave}
        onDropCapture={onDrop}
      >
        {line && <div className="wu-dropline" style={{ top: line.top }} />}
        <BlockNoteView
          editor={editor}
          editable={!doc.drafting}
          theme={resolved}
          className="wu-editor"
          slashMenu={false}
          formattingToolbar={false}
          sideMenu={false}
          filePanel={false}
          tableHandles={false}
          emojiPicker={false}
          onBlur={() => void flush()}
        >
          <SuggestionMenuController triggerCharacter="/" getItems={items} />
          <FormattingToolbarController
            formattingToolbar={() => (
              <FormattingToolbar>
                <BasicTextStyleButton basicTextStyle="bold" key="bold" />
                <BasicTextStyleButton basicTextStyle="italic" key="italic" />
                <BasicTextStyleButton basicTextStyle="code" key="code" />
                <CreateLinkButton key="link" />
              </FormattingToolbar>
            )}
          />
          <ActsContext.Provider value={actsCtx}>
            <SideMenuController floatingUIOptions={ACTS_FLOATING} sideMenu={BlockActions} />
          </ActsContext.Provider>
        </BlockNoteView>
      </div>
    </ReportContext.Provider>
  )
}
