// Where the report editor's caret goes after a block is deleted, and where it goes back once the blocks are rebuilt
// from a stored document. Separate from Editor.tsx so tests can run it without BlockNote.
import type { Node as PMNode } from 'prosemirror-model'
import { Selection } from 'prosemirror-state'

/** The position of the block with id `id` in the document (the node whose `id` attribute it is), or null. */
export function blockPos(doc: PMNode, id: string): number | null {
  let at: number | null = null
  doc.descendants((node, pos) => {
    if (at != null) return false
    if (node.attrs?.id === id) {
      at = pos
      return false
    }
    return true
  })
  return at
}

/** The caret after a delete at `pos`: the first text position at or after it, else the last one before it. Always a
 * text caret, since text typed over a node selection replaces the node. Null in a document with no text. */
export function caretNear(doc: PMNode, pos: number): Selection | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  return Selection.findFrom($pos, 1, true) ?? Selection.findFrom($pos, -1, true)
}

/** Where a caret stands, as its block's id and its offset from the block's start. Null outside any block. */
export interface BlockCaret {
  id: string
  offset: number
}

export function caretInBlock(sel: Selection): BlockCaret | null {
  const $from = sel.$from
  for (let d = $from.depth; d > 0; d--) {
    const id = $from.node(d).attrs?.id
    if (typeof id === 'string' && id) return { id, offset: sel.from - $from.before(d) }
  }
  return null
}

/** The caret put back at `caret` in `doc`, clamped to the block's end. Null when the block is gone. */
export function caretBack(doc: PMNode, caret: BlockCaret): Selection | null {
  const at = blockPos(doc, caret.id)
  if (at == null) return null
  const node = doc.nodeAt(at)
  const end = at + (node ? node.nodeSize - 1 : 0)
  return caretNear(doc, Math.min(at + caret.offset, end))
}
