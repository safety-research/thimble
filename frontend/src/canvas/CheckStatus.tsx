// The card check's part of the canvas's search menu (Controls.tsx): how many cards are being checked (with Stop all),
// then rows that filter the cards by what the check found. The running count comes from the board's cards; whether the
// check runs on this server comes from GET /card-checks. Whether new cards are checked by themselves is thimble's
// config (`agents.cardCheck.auto`, docs/config.md), not a switch here.
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { checkOf } from '../lib/cardCheck'
import { track } from '../lib/telemetry'
import type { Cell } from '../lib/types'
import { CanvasContext } from './context'

/** How many of the cards a check is running on. Pure, exported for its test. */
export function runningChecks(cells: readonly Pick<Cell, 'check' | 'fixes' | 'takeaway' | 'code' | 'kind'>[]): number {
  return cells.reduce((n, c) => n + (checkOf(c)?.state === 'running' ? 1 : 0), 0)
}

const toast = (text: string) => bus.emit('toast', { text, kind: 'error' })

/** The card check's part of the search menu: the running count with Stop all, then `rows` (the filter by what the
 * check found). With the check turned off on the server (THIMBLE_CARD_CHECK=0), or none running, the rows alone. */
export function CardCheckPart({ cards, open, rows }: { cards: readonly { cell: Cell }[]; open: boolean; rows: ReactNode }) {
  const ctx = useContext(CanvasContext)
  const [enabled, setEnabled] = useState(true)
  const n = useMemo(() => runningChecks(cards.map((b) => b.cell)), [cards])

  const read = useCallback(() => {
    if (!ctx.ws) return
    api
      .cardChecks(ctx.ws)
      .then((s) => setEnabled(s.enabled))
      .catch(() => undefined)
  }, [ctx.ws])
  useEffect(() => {
    if (open) read()
  }, [open, read])

  const stopAll = async () => {
    track('ui-click', { target: 'ui:card-check-stop-all', detail: { n } })
    try {
      await api.stopCardChecks(ctx.ws)
      ctx.refresh()
    } catch (e) {
      toast(`Could not stop the checks. ${(e as Error).message}`)
    }
  }

  const head = (
    <div className="menu-heading" role="presentation">
      Card check
    </div>
  )
  const showRunning = enabled && n > 0
  if (!showRunning && !rows) return null
  return (
    <div className={'bfilter-part' + (showRunning ? ' bfilter-checks' : '')}>
      {head}
      {showRunning && (
        <div className="bfilter-running">
          <span>
            Checking {n} card{n === 1 ? '' : 's'}
          </span>
          <Button variant="ghost" size="sm" icon="stop" onClick={() => void stopAll()}>
            {n === 1 ? 'Stop' : 'Stop all'}
          </Button>
        </div>
      )}
      {rows}
    </div>
  )
}
