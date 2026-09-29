// A session's model line at a composer's foot: the model, the effort as a menu and fast mode as a lightning bolt
// (Opus 5.5 · medium ▾ ⚡). The model is a menu where the UI can change it (a role's, the orientation's on the Start
// card), else text whose tooltip says where it changes (main's through /model in its terminal). The effort menu lists
// low to max, then ultracode where the session takes it. The bolt switches fast mode where the UI can; otherwise it
// shows the state and its tooltip says why. Its tooltip always opens with "Fast mode" (fastTip). A menu names each
// model once, without an id's `[1m]` tag (lib/models).
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { useTooltip } from '../components/Tooltip'
import { hasFastMode, modelLabel, sameModel } from '../lib/models'
import type { Attached, MainEffort } from '../lib/types'

/** The efforts main's and the orientation's menus offer, lowest first, then ultracode (cc_settings.EFFORTS and
 * ultracode), each named by its id. */
export const EFFORT_CHOICES: readonly MainEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

/** Main's effort when neither the line nor the analyst's settings chose one: the launcher's `--effort` then
 * (cc_settings.MAIN_DEFAULT_EFFORT). */
export const MAIN_DEFAULT_EFFORT: MainEffort = 'high'

/** The orientation's effort until the analyst picks one for its role (config.ORIENT_DEFAULT_EFFORT). */
export const ORIENT_DEFAULT_EFFORT: MainEffort = 'ultracode'

/** Main's model's tip: a running session's model changes only by /model in its terminal. */
export const MODEL_TIP = 'Run /model in the Claude Code terminal to change the model'

/** What a change to main's effort or fast mode does: it is kept for main's next launch (backend channel.effort_route). */
export const NEXT_LAUNCH = 'Main runs with it from your next `thimble` launch'

/** Why a model's bolt cannot switch: it has no fast mode. */
export const noFastTip = (model: string): string => `${modelLabel(model)} has no fast mode`

/** An effort as a menu names it; '' is the effort of the session the role runs in. */
export const effortWord = (e: string): string => e || "the session's"

/** The bolt's tooltip: "Fast mode: on" or "Fast mode: off", or where it cannot be switched "Fast mode: " and why. Pure. */
export const fastTip = (on: boolean, why: string | null): string => `Fast mode: ${why ?? (on ? 'on' : 'off')}`

const isChoice = (e: unknown): e is MainEffort => typeof e === 'string' && (EFFORT_CHOICES as readonly string[]).includes(e)

/**
 * Main's effort as its line shows it: the line's choice for this session; else Ultracode while the settings turn it on
 * and replies run at xhigh; else the level main's replies ran at; else the analyst's choice; else the default. Pure.
 */
export function mainEffort(a: Attached | null | undefined): MainEffort {
  if (isChoice(a?.effort_choice)) return a.effort_choice
  const own = isChoice(a?.settings_effort) ? a.settings_effort : null
  const ran = isChoice(a?.effort) ? a.effort : null
  if (own === 'ultracode' && (ran == null || ran === 'xhigh')) return 'ultracode'
  return ran ?? own ?? MAIN_DEFAULT_EFFORT
}

/** Main's fast mode for the line: the line's choice for this session, else whether its replies ran fast. Pure. */
export function mainFast(a: Attached | null | undefined): boolean {
  if (typeof a?.fast_choice === 'boolean') return a.fast_choice
  return a?.fast === true
}

/** Fast mode as a lightning bolt, filled while on. Its tooltip (Button's `title`, fastTip) names fast mode and says
 * whether it is on, or where it cannot be switched (`why`) why; without `why` or `onChange` it still shows the state
 * and stays focusable. `label` is its accessible name, the tooltip its description. */
export function FastBolt({ on, label, why, onChange, className = '' }: {
  on: boolean
  label: string
  why: string | null
  onChange?: (on: boolean) => void
  className?: string
}) {
  const locked = !!why || !onChange
  return (
    <Button
      variant="icon"
      size="sm"
      icon="bolt"
      active={on}
      title={fastTip(on, why)}
      aria-label={label}
      aria-disabled={locked ? 'true' : undefined}
      className={`fast-bolt${locked ? ' fast-bolt-locked' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => !locked && onChange?.(!on)}
    />
  )
}

/** A model that cannot change here: its name, with the tip that says where it changes on hover and on keyboard focus. */
function ModelName({ model, tip }: { model: string; tip?: string }) {
  const { props, tip: label } = useTooltip(tip)
  return (
    <span className="model-line-model" data-model={model} tabIndex={tip ? 0 : undefined} {...props}>
      {modelLabel(model)}
      {label}
    </span>
  )
}

export function ModelLine({ model, modelTip, models, onModel, effort, efforts = EFFORT_CHOICES, onEffort, fast, onFast, label, className = '' }: {
  /** the model the session runs; nothing while it is unknown */
  model?: string | null
  /** where the model changes, in its tooltip, when it cannot change here */
  modelTip?: string
  /** with `onModel`, the model is a menu of these, each once */
  models?: readonly string[]
  onModel?: (model: string) => void
  /** the effort in use; without it the line names only the model */
  effort?: string | null
  efforts?: readonly string[]
  onEffort?: (effort: string) => void
  /** fast mode's state; null while it is unknown, shown off */
  fast?: boolean | null
  /** switches fast mode; without it the bolt shows the state */
  onFast?: (on: boolean) => void
  /** the session the line names, in its controls' accessible names: "main", "the orientation" */
  label: string
  className?: string
}) {
  const withFast = !model || hasFastMode(model)
  const why = withFast ? null : noFastTip(model!)
  const modelItems: MenuItem[] = (models ?? []).map((m) => ({
    id: `model:${m}`,
    label: modelLabel(m),
    note: m,
    checked: sameModel(m, model),
    onSelect: () => !sameModel(m, model) && onModel?.(m),
  }))
  const effortItems: MenuItem[] = efforts.map((e) => ({ id: e || 'session', label: effortWord(e), checked: e === effort, onSelect: () => e !== effort && onEffort?.(e) }))
  return (
    <span className={`model-line${className ? ` ${className}` : ''}`} data-model={model ?? undefined} data-effort={effort ?? undefined} data-fast={effort != null && fast != null ? String(fast) : undefined}>
      {model &&
        (onModel && models ? (
          <Menu
            label={`Model for ${label}`}
            items={modelItems}
            trigger={
              <button type="button" className="model-line-part" aria-label={`Model for ${label}`} data-model={model}>
                {modelLabel(model)}
                <Icon name="chevron-down" size={12} />
              </button>
            }
          />
        ) : (
          <ModelName model={model} tip={modelTip} />
        ))}
      {effort != null && (
        <>
          {model && (
            <span className="model-line-sep" aria-hidden="true">
              ·
            </span>
          )}
          <Menu
            label={`Effort for ${label}`}
            items={effortItems}
            trigger={
              <button type="button" className="model-line-part model-line-effort" aria-label={`Effort for ${label}`} data-effort={effort}>
                {effortWord(effort)}
                <Icon name="chevron-down" size={12} />
              </button>
            }
          />
          <FastBolt on={!!fast && withFast} label={`Fast mode for ${label}`} why={why} onChange={onFast} className="model-line-fast" />
        </>
      )}
    </span>
  )
}
