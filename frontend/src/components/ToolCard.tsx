// The tool-call card: what the agent did, as one tonal card. The head is the chevron, an optional icon, the name, the
// meta in mono and, at the right edge, the spinner (and a Stop button after it with `stop`) or ✓ once done. The chevron opens the
// lead, the steps and any body the caller hands over. Under the head, always shown: the chips of what it made, and a
// section row per surface the work landed on.
import { useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { Chip } from './Chip'
import { Icon, type IconName } from './Icon'
import { Mark } from './Marks'
import { Spinner } from './Spinner'

export type ToolState = 'running' | 'done' | 'failed' | 'stopped'
export type StepState = 'done' | 'running' | 'pending' | 'failed' | 'skipped'

export interface ToolStep {
  key?: string
  text: ReactNode
  state?: StepState
  /** opens what the step is, such as the transcript of the agent it ran: the step's text becomes the control */
  onOpen?: () => void
}

export interface ToolSection {
  key: string
  icon?: IconName
  label: ReactNode
  /** mono, after the label: 2 cells */
  count?: ReactNode
  /** accent chips of what landed there */
  chips?: ReactNode
  /** go to the surface where it landed: the section's name becomes the control */
  onOpen?: () => void
}

export interface ToolCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onToggle'> {
  icon?: IconName
  title: ReactNode
  meta?: ReactNode
  /** the right edge: the spinner, ✓, or ✕ for failed and stopped; null shows nothing */
  state?: ToolState | null
  /** behind the chevron, before the steps: what the card was asked, such as the brief main gave a subagent */
  lead?: ReactNode
  steps?: readonly ToolStep[]
  /** more behind the chevron, after the steps: a call's input and result, a subagent's own records */
  body?: ReactNode
  /** always shown under the head: the chips of what the call made */
  chips?: ReactNode
  sections?: readonly ToolSection[]
  /** while it runs, the right edge shows the spinner and after it a small ghost Stop button (the stop square), which
   * turns busy, ignoring clicks, while `busy` says the stop request is in flight */
  stop?: { onStop: () => void; busy?: boolean; className?: string }
  /** controlled open state; without it the card keeps its own, starting at `defaultOpen` */
  open?: boolean
  defaultOpen?: boolean
  onToggle?: (open: boolean) => void
}

const STEP_GLYPH: Record<Exclude<StepState, 'running'>, string> = { done: '✓', pending: '·', failed: '✕', skipped: '–' }

/** A step's state before its text: the spinner while it runs, as the card's head turns one, else its glyph. */
export function StepGlyph({ state }: { state: StepState }) {
  return (
    <span className="toolcard-glyph" aria-hidden="true">
      {state === 'running' ? <Spinner size={10} /> : STEP_GLYPH[state]}
    </span>
  )
}

export function ToolCard({ icon, title, meta, state = null, lead, steps, body, chips, sections, stop, open: openProp, defaultOpen = false, onToggle, className, ...rest }: ToolCardProps) {
  const [own, setOwn] = useState(defaultOpen)
  const open = openProp ?? own
  const expandable = lead != null || (steps?.length ?? 0) > 0 || body != null
  const toggle = () => {
    if (!expandable) return
    const next = !open
    if (openProp == null) setOwn(next)
    onToggle?.(next)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }
  const cls = ['toolcard', open && expandable ? 'open' : '', state ? `toolcard-${state}` : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={cls} data-state={state ?? undefined} {...rest}>
      <div className={`toolcard-head${expandable ? ' toolcard-head-act' : ''}${stop && state === 'running' ? ' toolcard-head-stop' : ''}`} role={expandable ? 'button' : undefined} tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined} onClick={toggle} onKeyDown={expandable ? onKey : undefined}>
        <span className="toolcard-caret" aria-hidden="true">
          {expandable && <Icon name="chevron-right" size={10} strokeWidth={2.7} />}
        </span>
        {icon && <Icon name={icon} size={12} className="toolcard-ico" />}
        <span className="toolcard-title">{title}</span>
        {meta != null && meta !== '' && <span className="toolcard-meta">{meta}</span>}
        <span className="toolcard-end">
          {state === 'running' &&
            (stop ? (
              <>
                {!stop.busy && <Spinner size={10} label="running" />}
                <Button
                  variant="ghost"
                  size="sm"
                  icon="stop"
                  className={`toolcard-stop${stop.className ? ` ${stop.className}` : ''}`}
                  busy={stop.busy}
                  onClick={(e) => (e.stopPropagation(), stop.onStop())}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  Stop
                </Button>
              </>
            ) : (
              <Spinner size={10} label="running" />
            ))}
          {state === 'done' && <Mark kind="verified" label="done" className="toolcard-mark" />}
          {(state === 'failed' || state === 'stopped') && <Mark kind="failed" label={state} className="toolcard-mark" />}
        </span>
      </div>
      {open && expandable && lead != null && <div className="toolcard-lead">{lead}</div>}
      {open && expandable && steps && steps.length > 0 && (
        <ol className="toolcard-steps">
          {steps.map((s, i) => {
            const st = s.state ?? 'done'
            return (
              <li key={s.key ?? i} className={`toolcard-step toolcard-step-${st}`}>
                <StepGlyph state={st} />
                {s.onOpen ? (
                  <button type="button" className="toolcard-step-text toolcard-step-open" onClick={s.onOpen}>
                    {s.text}
                  </button>
                ) : (
                  <span className="toolcard-step-text">{s.text}</span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {open && expandable && body != null && <div className="toolcard-body">{body}</div>}
      {chips != null && chips !== false && <div className="toolcard-chips">{chips}</div>}
      {sections?.map((s) => (
        <div key={s.key} className="toolcard-section" data-section={s.key}>
          {s.onOpen ? (
            <button type="button" className="toolcard-section-head toolcard-section-act" onClick={s.onOpen}>
              {s.icon && <Icon name={s.icon} size={12} className="toolcard-section-ico" />}
              <span className="toolcard-section-label">{s.label}</span>
              {s.count != null && <span className="toolcard-section-count">{s.count}</span>}
            </button>
          ) : (
            <span className="toolcard-section-head">
              {s.icon && <Icon name={s.icon} size={12} className="toolcard-section-ico" />}
              <span className="toolcard-section-label">{s.label}</span>
              {s.count != null && <span className="toolcard-section-count">{s.count}</span>}
            </span>
          )}
          {s.chips != null && <span className="toolcard-section-chips">{s.chips}</span>}
        </div>
      ))}
    </div>
  )
}

/** The chips under a card's head: the first `max`, then a +N chip that shows the rest. */
export function ChipRun({ children, max = 6 }: { children: readonly ReactNode[]; max?: number }) {
  const [all, setAll] = useState(false)
  const shown = all || children.length <= max + 1 ? children : children.slice(0, max)
  const rest = children.length - shown.length
  return (
    <>
      {shown}
      {rest > 0 && (
        <Chip kind="value" className="toolcard-more" onClick={(e) => (e.stopPropagation(), setAll(true))}>
          +{rest}
        </Chip>
      )}
    </>
  )
}

export default ToolCard
