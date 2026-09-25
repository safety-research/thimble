// The card check's part of the canvas's search menu (Controls.tsx): the switch for the automatic check, how many cards
// are being checked (with Stop), then rows that filter the cards by what the check found. The running count comes from
// the board's cards; the switch state and whether the card harness can run come from GET /card-checks.
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Switch } from '../components/Switch'
import { useTooltip } from '../components/Tooltip'
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

/** The switch's words and its tooltip. Pure, exported for its test. */
export function autoTip(auto: boolean | null, down: string): string {
  if (down) return `No card can be drawn here, so no check can finish: ${down}`
  return auto === false ? 'Off: a card is checked when you click the check mark at its bottom right' : "Each new card's graphic, question and takeaway are read and the card is revised in place"
}

/** The card check's part of the search menu: the switch, the running count with Stop, then `rows` (the filter by
 * what the check found). With the check turned off on the server (THIMBLE_CARD_CHECK=0), the rows alone. */
export function CardCheckPart({ cards, open, rows }: { cards: readonly { cell: Cell }[]; open: boolean; rows: ReactNode }) {
  const ctx = useContext(CanvasContext)
  const [state, setState] = useState<{ enabled: boolean; auto: boolean | null; down: string }>({ enabled: true, auto: null, down: '' })
  const [busy, setBusy] = useState(false)
  const n = useMemo(() => runningChecks(cards.map((b) => b.cell)), [cards])

  const read = useCallback(() => {
    if (!ctx.ws) return
    api
      .cardChecks(ctx.ws)
      .then((s) => setState({ enabled: s.enabled, auto: s.enabled ? s.auto : false, down: s.enabled ? s.render_why ?? '' : '' }))
      .catch(() => setState((cur) => ({ ...cur, auto: null })))
  }, [ctx.ws])
  useEffect(() => {
    if (open) read()
  }, [open, read])

  const setOn = async (on: boolean) => {
    setBusy(true)
    track('ui-click', { target: 'ui:card-check-auto', detail: { on } })
    try {
      const s = await api.setCardCheckAuto(ctx.ws, on)
      setState((cur) => ({ ...cur, auto: s.auto }))
      ctx.refresh()
    } catch (e) {
      toast(`Could not turn the card check ${on ? 'on' : 'off'}. ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const stopAll = async () => {
    track('ui-click', { target: 'ui:card-check-stop-all', detail: { n } })
    try {
      await api.stopCardChecks(ctx.ws)
      ctx.refresh()
    } catch (e) {
      toast(`Could not stop the checks. ${(e as Error).message}`)
    }
  }
  const { props: tipProps, tip } = useTooltip(autoTip(state.auto, state.down))

  const head = (
    <div className="menu-heading" role="presentation">
      Card check
    </div>
  )
  if (!state.enabled)
    return rows ? (
      <div className="bfilter-part">
        {head}
        {rows}
      </div>
    ) : null
  return (
    <div className="bfilter-part bfilter-checks">
      {head}
      <label className="bfilter-auto" {...tipProps}>
        <span className="bfilter-auto-text">Check new cards automatically</span>
        <Switch checked={state.auto === true} disabled={state.auto === null || busy || !!state.down} onChange={(on) => void setOn(on)} label="Check new cards automatically" />
        {tip}
      </label>
      {n > 0 && (
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
