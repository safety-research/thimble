// The start gate: until an orientation has been asked for (main's meta `orientation`) or the analyst skips it, the offer
// of an orientation wraps main's composer. Show options opens the orientation's switches (Write Orientation deck,
// Propose views, Critique and revise, Generate report) and its permission mode (manual, auto, bypass; Claude Code's own
// warning shows under Bypass). The field's text is the orientation's instructions and may stay empty; its model line
// (ModelLine) edits the orientation role's settings. Start sends the analyst's session the `start` event with the
// instructions as its text and the choices as attributes (prompts/main.md); Skip leaves main to the analyst.
import { useEffect, useRef, useState } from 'react'
import { Button, Segmented, type SegmentedOption } from '../components/Button'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Switch } from '../components/Switch'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { MainEffort, OrientPass, OrientPermissions, StartBody } from '../lib/types'
import { EFFORT_CHOICES, ModelLine, ORIENT_DEFAULT_EFFORT, ORIENT_MODEL_TIP } from './ModelLine'

export const PASSES: { id: OrientPass; label: string }[] = [
  { id: 'final', label: 'Write Orientation deck' },
  { id: 'views', label: 'Propose views' },
  { id: 'critique', label: 'Critique and revise' },
  { id: 'report', label: 'Generate report' },
]

/** The level Ultracode runs at, sent as the `start` event's `effort` beside `ultracode` (cc_settings.ULTRACODE_EFFORT). */
export const ULTRACODE_LEVEL = 'xhigh'

/** The note main keeps once the gate is skipped. */
export const SKIPPED_NOTE = 'Orientation skipped. You can ask Thimble to orient itself later.'

export type Passes = Record<OrientPass, boolean>
export const ALL_ON: Passes = { final: true, views: true, critique: true, report: true }

/** The analyst's choices after one is toggled; each switch is on its own. Pure. */
export function togglePass(cur: Passes, id: OrientPass): Passes {
  return { ...cur, [id]: !cur[id] }
}

/** Whether the start gate is open: no orientation was asked for (main's meta `orientation` is null) and none has a
 * thread (`orientChats`). What main holds does not close it. Pure. */
export function startGateOpen(orientation: string | null | undefined, orientChats = 0): boolean {
  return !orientation && orientChats === 0
}

/** Whether main's chat shows the gate in place of its composer: main is shown and loaded, the analyst neither skipped
 * nor pressed Start in this tab, and the gate is open. Whether main is running plays no part: a Start pressed while
 * main works is queued like any browser event. Pure. */
export function startGateShown(s: { main: boolean; skipped: boolean; started: boolean; loading: boolean; error: unknown; orientation: string | null | undefined; orientChats: number }): boolean {
  return s.main && !s.skipped && !s.started && !s.loading && !s.error && startGateOpen(s.orientation, s.orientChats)
}

/** The switches that are on, in the gate's order. */
export const chosenPasses = (on: Passes): OrientPass[] => PASSES.map((p) => p.id).filter((id) => on[id])

/** The body of the `start` event: start_orientation's three switches, the session's settings (the critique, the
 * effort, Ultracode as `ultracode` at its level, and the permission mode), and the instructions when the analyst wrote
 * any. Pure. */
export function startBody(on: Passes, instructions: string, effort: MainEffort = ORIENT_DEFAULT_EFFORT, permissions?: OrientPermissions | null): StartBody {
  const text = instructions.trim()
  const ultracode = effort === 'ultracode'
  return {
    final_notebook: on.final,
    propose_views: on.views,
    generate_report: on.report,
    critique: on.critique,
    ultracode,
    effort: effort === 'ultracode' ? ULTRACODE_LEVEL : effort,
    ...(text ? { text } : {}),
    ...(permissions ? { permissions } : {}),
  }
}

/** The mode the switcher opens on for the analyst's own Claude Code permission mode for the folder: Auto for auto,
 * Bypass for bypassPermissions, Manual for any other (acceptEdits, plan and dontAsk are not offered) or none known,
 * as cc_settings.orient_mode_default. Pure. */
export const permissionChoice = (mode: string | null | undefined): OrientPermissions =>
  mode === 'auto' ? 'auto' : mode === 'bypassPermissions' ? 'bypass' : 'manual'

/** Claude Code's modes by the names its own switcher shows (cc_settings.ORIENT_MODES). Manual and Bypass both run in
 * Claude Code's manual mode (thimble grants every request in Bypass), so the card can switch between them live. */
export const PERMISSION_OPTIONS: SegmentedOption<OrientPermissions>[] = [
  { value: 'manual', label: 'Manual', icon: 'pause' },
  { value: 'auto', label: 'Auto', icon: 'run' },
  { value: 'bypass', label: 'Bypass', icon: 'exclaim' },
]

/** The warning Claude Code shows before a session runs in Bypass Permissions mode, its first two sentences. */
export const BYPASS_WARNING =
  'In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands. ' +
  'This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.'

export function StartGate({ ws, model, defaultEffort = ORIENT_DEFAULT_EFFORT, fast = null, onEffort, onFast, permissionMode = null, onStarted, onSkip }: {
  ws: string
  /** the orientation role's model (settings.models.orient); nothing while it is not read yet */
  model?: string | null
  /** the orientation role's effort, where the menu opens (ModelLine.ORIENT_DEFAULT_EFFORT while it is not read yet) */
  defaultEffort?: MainEffort
  /** the orientation role's fast mode; null while it is not read yet */
  fast?: boolean | null
  /** saves an effort picked here to the orientation's role */
  onEffort?: (e: MainEffort) => void
  /** switches the orientation role's fast mode */
  onFast?: (on: boolean) => void
  /** the analyst's own Claude Code permission mode for the folder (main's `attached.permission_mode`), where the
   * switcher opens */
  permissionMode?: string | null
  onStarted?: () => void
  onSkip?: () => void
}) {
  const [on, setOn] = useState<Passes>(ALL_ON)
  const [picked, setPicked] = useState<MainEffort | null>(null)
  const effort = picked ?? defaultEffort
  // the role's effort changed (a pick saved from here, or the settings popover): the line shows the role's
  useEffect(() => setPicked(null), [defaultEffort])
  const [pickedMode, setPickedMode] = useState<OrientPermissions | null>(null)
  const mode = pickedMode ?? permissionChoice(permissionMode)
  const [text, setText] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const toggle = (id: OrientPass) => {
    const next = togglePass(on, id)
    track('start-toggle', { target: `orient:${id}`, detail: { on: next[id] } })
    setOn(next)
  }
  const pickEffort = (e: MainEffort) => {
    track('start-toggle', { target: 'orient:effort', detail: { effort: e } })
    setPicked(e)
    onEffort?.(e)
  }
  const start = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.start(ws, startBody(on, text, effort, mode))
      onStarted?.()
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      bus.emit('toast', { text: `Could not start. ${msg}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="chat-gate" data-panel="chat" role="group" aria-label="Start orientation">
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
            <div className="chat-gate-perms" data-choice={mode}>
              <span className="chat-gate-perms-label" id="chat-gate-perms">
                Permissions
              </span>
              <Segmented
                size="sm"
                track
                block
                label="The orientation's permission mode"
                options={PERMISSION_OPTIONS}
                value={mode}
                onChange={(v) => {
                  track('start-toggle', { target: 'orient:permissions', detail: { permissions: v } })
                  setPickedMode(v)
                }}
              />
            </div>
          </div>
        )}
        {mode === 'bypass' && (
          <p className="chat-gate-warn" role="alert">
            <Icon name="warning" size={13} className="chat-gate-warn-ico" />
            <span>{BYPASS_WARNING}</span>
          </p>
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
            <ModelLine model={model} modelTip={ORIENT_MODEL_TIP} effort={effort} efforts={EFFORT_CHOICES} onEffort={(e) => pickEffort(e as MainEffort)} fast={fast} onFast={onFast} label="the orientation" className="chat-gate-line" />
          </span>
        </div>
      </div>
      <div className="chat-gate-foot">
        {error && <span className="chat-gate-error">{error}</span>}
        {onSkip && (
          <Button variant="ghost" className="chat-gate-skip" onClick={onSkip}>
            Skip
          </Button>
        )}
        <Button variant="primary" className="chat-gate-go" busy={busy} onClick={() => void start()}>
          Start
        </Button>
      </div>
    </div>
  )
}
