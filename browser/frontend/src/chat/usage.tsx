// The quiet line under a finished reply: the model it ran on and the tokens its turn used (the turn's `done` record,
// backend agent.Usage), such as "Opus 5.5 · 4.1k in · 102k cached · 2.8k out". Its tooltip gives the exact counts.
import { useTooltip } from '../components/Tooltip'
import { modelLabel } from '../lib/models'
import type { TurnUsage } from '../lib/types'

/** A token count in a few characters: 940, 2.8k, 102k, 1.2M. Pure. */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** The line: the model, the input not read from the cache, the input read from it, and the output. Pure. */
export function usageLine(u: { model?: string } & TurnUsage): string {
  const fresh = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  return [
    u.model ? modelLabel(u.model) : null,
    fresh ? `${tokens(fresh)} in` : null,
    u.cache_read_input_tokens ? `${tokens(u.cache_read_input_tokens)} cached` : null,
    `${tokens(u.output_tokens || 0)} out`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The exact counts, one per line, for the tooltip. Pure. */
export function usageTip(u: { model?: string } & TurnUsage): string {
  const n = (x: number) => (x || 0).toLocaleString('en-US')
  return [
    u.model ? `${modelLabel(u.model)} (${u.model})` : null,
    `${n(u.requests)} request${u.requests === 1 ? '' : 's'} to Claude`,
    `${n(u.input_tokens)} input tokens`,
    `${n(u.cache_creation_input_tokens)} input tokens written to the cache`,
    `${n(u.cache_read_input_tokens)} input tokens read from the cache`,
    `${n(u.output_tokens)} output tokens`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function UsageLine({ usage }: { usage: { model?: string } & TurnUsage }) {
  const { props, tip } = useTooltip(usageTip(usage), 'tip-lines', 'start')
  return (
    <>
      <span className="chat-usage" tabIndex={0} data-usage="" {...props}>
        {usageLine(usage)}
      </span>
      {tip}
    </>
  )
}
