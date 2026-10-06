// The start gate: until an orientation has been asked for (main's meta `orientation`) or the analyst skips it, the offer
// of an orientation wraps main's composer; it comes back, filled in, when a start did not happen (`restore`). Show
// options opens start_orientation's four switches (Write Orientation deck, Propose views, Critique and revise, the one
// off by default, Generate report). The field's text is the request (the focus) and may stay empty; its model line
// (ModelLine) picks the run's model (a menu of lib/models modelChoices) and effort (Claude Code's levels, none for a
// model that runs with none), which start at Settings' orientation row and apply to this run only. One line under it
// says how it runs: as a subagent of the analyst's Claude Code session, in that session's permission mode. Start is a
// click: the server starts the orientation through thimble's plugin with no turn of main (POST /ws/{c}/start), and the
// answer says whether it started. Start is off, with the reason on that line, while thimble's hooks module is not
// running in main's session (main's meta `module: false`) or main is in plan mode. Skip leaves main to the analyst.
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Switch } from '../components/Switch'
import { api } from '../lib/api'
import { hasEffort, loadSettings, modelChoices, onSettingsChange } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ChatMeta, OrientPass, OrientRun, Settings, StartAnswer, StartBody } from '../lib/types'
import { toastText } from '../shell/Toasts'
import { AGENT_EFFORTS, ModelLine } from './ModelLine'

export const PASSES: { id: OrientPass; label: string }[] = [
  { id: 'final', label: 'Write Orientation deck' },
  { id: 'views', label: 'Propose views' },
  { id: 'critique', label: 'Critique and revise' },
  { id: 'report', label: 'Generate report' },
]

/** The note main keeps once the gate is skipped. */
export const SKIPPED_NOTE = 'Orientation skipped. You can ask Thimble to orient itself later.'

export type Passes = Record<OrientPass, boolean>
/** The switches as the gate opens: every output on, the critique off (backend orientation.DEFAULT_CRITIQUE). */
export const DEFAULT_ON: Passes = { final: true, views: true, critique: false, report: true }

/** The analyst's choices after one is toggled; each switch is on its own. Pure. */
export function togglePass(cur: Passes, id: OrientPass): Passes {
  return { ...cur, [id]: !cur[id] }
}

/** Whether the start gate is open: no orientation was asked for (main's meta `orientation` is null) and none has a
 * thread (`orientChats`), or the latest start did not happen (`refused`), whose gate comes back filled in. What main
 * holds does not close it. Pure. */
export function startGateOpen(orientation: string | null | undefined, orientChats = 0): boolean {
  return orientation === 'refused' || (!orientation && orientChats === 0)
}

/** Whether main's chat shows the gate in place of its composer: main is shown and loaded, the analyst neither skipped
 * nor pressed Start in this tab, and the gate is open. Whether main is running plays no part: Start takes no turn of
 * main. Pure. */
export function startGateShown(s: { main: boolean; skipped: boolean; started: boolean; loading: boolean; error: unknown; orientation: string | null | undefined; orientChats: number }): boolean {
  return s.main && !s.skipped && !s.started && !s.loading && !s.error && startGateOpen(s.orientation, s.orientChats)
}

/** The switches that are on, in the gate's order. */
export const chosenPasses = (on: Passes): OrientPass[] => PASSES.map((p) => p.id).filter((id) => on[id])

/** The body of Start: the request when the analyst wrote one, the four switches, and the run's model and effort (left
 * out when not known yet, so the server takes Settings'); a model that runs with no effort sends none. Pure. */
export function startBody(on: Passes, text: string, values: { model?: string | null; effort?: string | null } = {}): StartBody {
  const request = text.trim()
  const model = values.model || undefined
  const effort = model && !hasEffort(model) ? undefined : values.effort || undefined
  return {
    deck: on.final,
    views: on.views,
    critique: on.critique,
    report: on.report,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(request ? { text: request } : {}),
  }
}

/** The gate's fields filled in from a start that did not happen (orient/run.json): its request, switches, model and
 * effort. */
export interface Restore {
  text: string
  on: Passes
  model?: string | null
  effort?: string | null
}

/** A refused run's record as the gate's fields; null for any other record. Pure. */
export function restoreOf(run: OrientRun | null | undefined): Restore | null {
  if (!run || run.status !== 'refused') return null
  const passes = run.passes ?? []
  return {
    text: run.query ?? '',
    on: { final: passes.includes('final'), views: passes.includes('views'), report: passes.includes('report'), critique: !!run.critique },
    model: run.model ?? null,
    effort: run.effort ?? null,
  }
}

/** Claude Code's permission modes by the names its own mode line shows. */
const MODE_WORDS: Readonly<Record<string, string>> = {
  default: 'default mode',
  acceptEdits: 'accept edits mode',
  auto: 'auto mode',
  bypassPermissions: 'bypass permissions mode',
  dontAsk: "don't ask mode",
}

/** The line under the gate's field: how the orientation runs, from main's reported permission mode. Pure. */
export function modeLine(mode: string | null | undefined): string {
  const words = mode ? MODE_WORDS[mode] : null
  return `Runs as a subagent of your Claude Code session, ${words ? `in ${words}` : 'in its permission mode'}.`
}

/** Why Start is off while main is in plan mode, where a subagent would ask before every card (U20). */
export const PLAN_MODE_LINE = 'Your session is in plan mode, where the orientation would have to ask you before every card. Switch out of plan mode first (shift+tab in your terminal).'

/** What to change so that thimble's hooks module runs, for the reason module_bridge.why_not gives. Pure. */
export function noModuleFix(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes('thimble_no_module')) return 'Unset THIMBLE_NO_MODULE'
  if (r.includes('managed settings') || r.includes('disableallhooks') || r.includes('allowmanagedhooksonly')) return "Ask whoever manages your Claude Code settings to allow plugins' hooks modules"
  if (r.includes('trust')) return 'Trust this folder in Claude Code'
  return 'Run `thimble doctor` to see why'
}

/** Why Start is off without thimble's hooks module in main's session (Q7): the plain line, its reason, and what to
 * change. Pure. */
export function noModuleLine(reason: string | null | undefined): string {
  const why = (reason ?? '').trim() || "Claude Code did not load thimble's hooks module"
  return `thimble's agents can't start in this session: Claude Code's hooks modules are off (${why}). Main, its threads, cards and labels still work. ${noModuleFix(why)}, then run \`thimble -c\`.`
}

/** Why Start is off now, or null: no hooks module in main's session (`module: false`; a meta that does not say leaves
 * Start on, and the server refuses a start that cannot happen), then plan mode. Pure. */
export function startBlocked(main: Pick<ChatMeta, 'module' | 'module_why' | 'attached'> | null | undefined): { kind: 'no-module' | 'plan'; line: string } | null {
  if (main?.module === false) return { kind: 'no-module', line: noModuleLine(main.module_why) }
  if (main?.attached?.permission_mode === 'plan') return { kind: 'plan', line: PLAN_MODE_LINE }
  return null
}

export function StartGate({ ws, main, model: rowModel, effort: rowEffort, restore = null, onStarting, onAnswer, onSkip }: {
  ws: string
  /** main's meta: its permission mode, and whether thimble's hooks module runs in it */
  main?: Pick<ChatMeta, 'module' | 'module_why' | 'attached'> | null
  /** the orientation row's model and effort (settings.models.orient), where the menus open; nothing while not read */
  model?: string | null
  effort?: string | null
  /** a start that did not happen, whose request, switches, model and effort fill the gate */
  restore?: Restore | null
  /** Start was pressed: the request is on its way */
  onStarting?: () => void
  /** what the server answered: started, or why not (the gate then comes back) */
  onAnswer?: (answer: StartAnswer | null, error?: string) => void
  onSkip?: () => void
}) {
  const [on, setOn] = useState<Passes>(restore?.on ?? DEFAULT_ON)
  const [pickedModel, setPickedModel] = useState<string | null>(restore?.model ?? null)
  const [pickedEffort, setPickedEffort] = useState<string | null>(restore?.effort ?? null)
  const model = pickedModel ?? rowModel ?? null
  const effort = model && !hasEffort(model) ? null : pickedEffort ?? rowEffort ?? null
  // the model menu's choices: the models the settings name across roles, then the current ones (lib/models)
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    let alive = true
    const read = () =>
      loadSettings(ws)
        .then((s) => alive && setSettings(s))
        .catch(() => undefined)
    void read()
    const off = onSettingsChange((w) => w === ws && void read())
    return () => {
      alive = false
      off()
    }
  }, [ws])
  const [text, setText] = useState(restore?.text ?? '')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const blocked = startBlocked(main)
  const toggle = (id: OrientPass) => {
    const next = togglePass(on, id)
    track('start-toggle', { target: `orient:${id}`, detail: { on: next[id] } })
    setOn(next)
  }
  const start = async () => {
    if (busy || blocked) return
    setBusy(true)
    setError(null)
    onStarting?.()
    try {
      const answer = await api.start(ws, startBody(on, text, { model, effort }))
      onAnswer?.(answer)
    } catch (e) {
      // the refusal stays beside Start until the next try; it is not also a toast (shell/Toasts)
      const why = toastText((e as Error).message)
      setError(why)
      onAnswer?.(null, why)
    } finally {
      setBusy(false)
    }
  }
  const mode = main?.attached?.permission_mode
  return (
    <div className="chat-gate" data-panel="chat" role="group" aria-label="Start orientation" data-blocked={blocked?.kind}>
      <div className="chat-gate-top">
        <div className="chat-gate-title">Start orientation</div>
        <button
          type="button"
          className={`chat-gate-options-toggle${optionsOpen ? ' open' : ''}`}
          aria-expanded={optionsOpen}
          aria-controls="chat-gate-options"
          onClick={() => {
            track('start-toggle', { target: 'orient:options', detail: { open: !optionsOpen } })
            setOptionsOpen((o) => !o)
          }}
        >
          {optionsOpen ? 'Hide options' : 'Show options'}
          <Icon name="chevron-down" size={14} className="chat-gate-caret" />
        </button>
        {optionsOpen && (
          <div className="chat-gate-options" id="chat-gate-options">
            <div className="chat-gate-rows" role="group" aria-label="Passes">
              {PASSES.map((p) => {
                const labelId = `chat-gate-${p.id}`
                return (
                  <div key={p.id} className={`chat-gate-row${on[p.id] ? ' on' : ''}`} data-pass={p.id}>
                    <Switch checked={on[p.id]} onChange={() => toggle(p.id)} aria-labelledby={labelId} />
                    <span id={labelId} className="chat-gate-label" onClick={() => toggle(p.id)}>
                      {p.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
      <div className="chat-gate-field" onClick={() => taRef.current?.focus()}>
        <TextArea
          ref={taRef}
          bare
          block
          autoGrow
          rows={2}
          maxHeight={160}
          className="chat-gate-text"
          value={text}
          onChange={setText}
          aria-label="Instructions for the orientation"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void start()
            }
          }}
        />
        <div className="chat-gate-meta">
          <span className="composer-model">
            <ModelLine
              model={model}
              models={modelChoices(settings, model)}
              onModel={(m) => {
                track('start-toggle', { target: 'orient:model', detail: { model: m } })
                setPickedModel(m)
              }}
              effort={effort}
              efforts={AGENT_EFFORTS}
              onEffort={(e) => {
                track('start-toggle', { target: 'orient:effort', detail: { effort: e } })
                setPickedEffort(e)
              }}
              noFast
              label="the orientation"
              className="chat-gate-line"
            />
          </span>
        </div>
      </div>
      <p className={`chat-gate-mode${blocked ? ' chat-gate-blocked' : ''}`} data-mode={mode ?? undefined} role={blocked ? 'alert' : undefined}>
        {blocked && <Icon name="warning" size={13} className="chat-gate-warn-ico" />}
        <span>{blocked ? blocked.line : modeLine(mode)}</span>
      </p>
      <div className="chat-gate-foot">
        {error && <span className="chat-gate-error">{error}</span>}
        {onSkip && (
          <Button variant="ghost" className="chat-gate-skip" onClick={onSkip}>
            Skip
          </Button>
        )}
        <Button variant="primary" className="chat-gate-go" busy={busy} disabled={!!blocked} title={blocked ? blocked.line : undefined} onClick={() => void start()}>
          Start
        </Button>
      </div>
    </div>
  )
}
