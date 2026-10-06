// What the analyst can do with a card's check, from its details (CheckDetails) and the hover of its ✕ (CardFace): run
// it again, stop it, and undo the fix it applied. Each refreshes the board, and a failure is the click's toast.
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { CardCheck } from '../lib/cardCheck'
import { track } from '../lib/telemetry'
import type { Cell } from '../lib/types'

type Ctx = { ws: string; refresh: () => void }

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })

/** Undo: put the card back as it was before the check changed it. */
export async function undoFix(ctx: Ctx, cell: Cell, check: CardCheck): Promise<void> {
  if (!check.fix) return
  track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'undo-fix', fix: check.fix.id } })
  try {
    await api.undoCardFix(ctx.ws, cell.id, check.fix.id)
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}

/** Run the check again on the card as it stands, or for the first time. */
export async function checkAgain(ctx: Ctx, cell: Cell): Promise<void> {
  track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'check-again' } })
  try {
    await api.checkCardAgain(ctx.ws, cell.id)
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}

/** Stop a running check; the card stays as it is. */
export async function stopCheck(ctx: Ctx, cell: Cell): Promise<void> {
  track('ui-click', { target: `cell:${cell.id}`, detail: { action: 'stop-check' } })
  try {
    await api.stopCardCheck(ctx.ws, cell.id)
    ctx.refresh()
  } catch (e) {
    fail(e)
  }
}
