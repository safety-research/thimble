// Report a problem where something failed: the failure written in, as a button beside it (ReportProblemButton) or a
// call (reportProblem). The bus's `reportProblem` opens the report's preview (shell/ShareReport), where main drafts it.
import { type MouseEvent } from 'react'
import { Button } from '../components/Button'
import { bus } from '../lib/bus'

/** Open Report a problem with what failed written in (shell/ShareReport listens). */
export function reportProblem(description: string, focus: readonly string[] = []): void {
  bus.emit('reportProblem', { description, focus: focus.filter(Boolean) })
}

/** The description a failure writes in: what failed, and its error on the next line when it has one. Pure. */
export function failureText(what: string, error?: string | null): string {
  const why = (error ?? '').trim()
  return why ? `${what}\n${why}` : what
}

/** Report a problem where something failed: text beside the failure, or the bug alone where room is short. */
export function ReportProblemButton({ description, focus, compact = false, className }: { description: string; focus?: readonly string[]; compact?: boolean; className?: string }) {
  const open = (e: MouseEvent) => {
    e.stopPropagation()
    reportProblem(description, focus ?? [])
  }
  return compact ? (
    <Button variant="icon" size="sm" icon="bug" title="Report a problem" aria-label="Report a problem" className={className} onClick={open} data-tel="report-problem-here" />
  ) : (
    <Button size="sm" icon="bug" className={className} onClick={open} data-tel="report-problem-here">
      Report a problem
    </Button>
  )
}

