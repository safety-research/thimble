// What the editor shows over the stored document while its own changes are in flight. The editor saves the whole
// document, so a stored version arriving meanwhile (a writer's revision, another tab's save) is merged into the
// editor first, keeping what the analyst changed since the last save; otherwise the next save would overwrite the
// other writer's blocks. Pure.
import type { ReportBlock } from '../lib/types'
import type { DocBlocks } from './model'

const same = (a: ReportBlock | undefined, b: ReportBlock | undefined): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The document to show when `stored` arrives while the editor holds `mine`, both derived from `base`. Stored blocks in
 * order, except blocks the analyst changed keep their version, blocks they deleted stay deleted unless the stored side
 * changed them, and blocks they added go after the block they follow. The title is theirs when they changed it.
 */
export function mergeUnsaved(stored: DocBlocks, base: DocBlocks, mine: DocBlocks): DocBlocks {
  const baseById = new Map(base.blocks.map((b) => [b.id, b]))
  const mineById = new Map(mine.blocks.map((b) => [b.id, b]))
  const storedIds = new Set(stored.blocks.map((b) => b.id))
  const changedByMe = (id: string) => mineById.has(id) && !same(mineById.get(id), baseById.get(id))
  const out: ReportBlock[] = []
  for (const b of stored.blocks) {
    const deletedByMe = baseById.has(b.id) && !mineById.has(b.id)
    if (deletedByMe && same(b, baseById.get(b.id))) continue
    out.push(changedByMe(b.id) ? mineById.get(b.id)! : b)
  }
  // the analyst's blocks the stored version does not hold: new ones, and ones they changed where it deleted them
  mine.blocks.forEach((b, i) => {
    if (storedIds.has(b.id) || !changedByMe(b.id)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === mine.blocks[j].id)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, b)
  })
  return { title: mine.title !== base.title ? mine.title : stored.title, blocks: out }
}

/** The blocks shown locked: the stored document's locks, with each lock the analyst set or cleared that the server has
 * not answered yet (`pending`, block id to locked) shown as clicked, so a click on a slow server shows at once. */
export function locksShown(stored: ReadonlySet<string>, pending: ReadonlyMap<string, boolean>): Set<string> {
  const out = new Set(stored)
  for (const [id, on] of pending) {
    if (on) out.add(id)
    else out.delete(id)
  }
  return out
}
