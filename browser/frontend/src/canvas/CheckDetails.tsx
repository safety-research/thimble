// The card check in a card's details (DetailPanel): what the check did last (lib/cardCheck checkLine), the problem it
// found (checkProblem, the same words as the ✕ on the card), the fix it applied with what the card said before and Undo,
// and Check again, or Stop while it runs. A card the check cannot read and never read shows nothing here.
import { useContext } from 'react'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { checkable, checkLine, checkOf, checkProblem } from '../lib/cardCheck'
import type { Cell } from '../lib/types'
import { checkAgain, stopCheck, undoFix } from './checkActions'
import { CanvasContext } from './context'

export function CheckDetails({ cell }: { cell: Cell }) {
  const ctx = useContext(CanvasContext)
  const check = checkOf(cell)
  const canCheck = checkable(cell)
  if (!check && !canCheck) return null
  const running = check?.state === 'running'
  const fix = check?.fix ?? null
  const problem = checkProblem(check)
  const before = fix?.before ?? {}
  return (
    <section className="bdetail-sec bdetail-check" aria-label="Check">
      <span className="bdetail-label">Check</span>
      <span className="bdetail-check-line">{check ? checkLine(check) : 'Not checked'}</span>
      {problem && (
        <span className="bdetail-check-problem">
          <Mark kind="failed" label="problem" />
          <span>{problem}</span>
        </span>
      )}
      {check?.note && <span className="bdetail-check-note">{check.note}.</span>}
      {fix && (
        <div className="bdetail-check-fix">
          <span>{fix.reason ? `Revised: ${fix.reason}` : 'Revised'}</span>
          {(before.title != null || before.takeaway != null) && (
            <div className="bdetail-check-before">
              <span className="bdetail-label">Before</span>
              {before.title != null && <span className="bdetail-check-q">{before.title}</span>}
              {before.takeaway != null && (
                <span className="chat-text">
                  <ChatMarkdown text={before.takeaway || '—'} />
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <div className="bdetail-check-acts">
        {fix && !running && (
          <Button variant="ghost" size="sm" icon="undo" onClick={() => check && void undoFix(ctx, cell, check)}>
            Undo
          </Button>
        )}
        {running ? (
          <Button variant="ghost" size="sm" icon="stop" onClick={() => void stopCheck(ctx, cell)}>
            Stop
          </Button>
        ) : (
          canCheck && (
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => void checkAgain(ctx, cell)}>
              {check ? 'Check again' : 'Check the card'}
            </Button>
          )
        )}
      </div>
    </section>
  )
}
