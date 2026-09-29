// A running session's permission mode on its card, changeable for that session: the three modes (PERMISSION_OPTIONS),
// less those the analyst's Claude Code settings turn off, as a small segmented track. Manual and Bypass switch at once
// (the session runs in Claude Code's manual mode in both, and in Bypass thimble grants every request). A switch into or
// out of Auto restarts the session in the new mode at its next pause, with its work kept; until then a line says it
// waits. A background session cannot make that switch (backend agent_session.BG_AUTO_LINE), so on its track the modes
// across it are unavailable: dimmed, their tooltip says why, and a click saves the mode to the session's agent's row
// in the settings (modes.AGENTS; a chat recorded before its meta named the row gives it by its role, agentOf), where
// that agent's next new session starts in it, and a toast says so; a continuation of this session keeps its mode. In
// Bypass, the first sentence of Claude Code's own warning stays under the switcher.
import { useEffect, useState } from 'react'
import { Segmented, type SegmentedOption } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { invalidateSettings, loadSettings } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ChatMeta, ModeAgent, OrientPermissions } from '../lib/types'
import { BYPASS_WARNING, PERMISSION_OPTIONS } from './StartGate'

const LABELS: Record<OrientPermissions, string> = { manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }
/** Each agent's row (modes.AGENTS) as a sentence names whose next new session a saved mode governs. */
const NEXT_OF: Record<ModeAgent, string> = { orient: "the orientation's", writer: "the writers'", critic: "the critic's", checks: "the checks'", dev: "the dev agent's" }

type SwitchMeta = Pick<ChatMeta, 'permission_mode' | 'mode_switch' | 'background' | 'mode_agent'> & Partial<Pick<ChatMeta, 'role'>>
/** The agent row of a chat whose meta names none, by the chat's role (backend orientation.ROLE, write_session.ROLE,
 * checks.ROLE). */
const ROLE_AGENT: Partial<Record<string, ModeAgent>> = { orient: 'orient', writer: 'writer', check: 'checks' }

/** The session's agent's row of the permission modes: its meta's, else its role's; undefined when neither names one.
 * Pure. */
export function agentOf(meta: SwitchMeta): ModeAgent | undefined {
  return meta.mode_agent ?? (meta.role ? ROLE_AGENT[meta.role] : undefined)
}

/** The switcher's options: the three modes less those turned off (`off`), each a background session cannot switch
 * to from `mode` unavailable with the reason and what a click does instead as its tooltip. Pure. */
export function modeOptions(meta: SwitchMeta, mode: OrientPermissions, off: readonly string[]): SegmentedOption<OrientPermissions>[] {
  return PERMISSION_OPTIONS.filter((o) => !off.includes(o.value)).map((o) => {
    if (!meta.background || (o.value === 'auto') === (mode === 'auto')) return o
    const across = mode === 'auto' ? 'out of Auto' : 'into Auto'
    const agent = agentOf(meta)
    const then = agent ? ` Click to start ${NEXT_OF[agent]} next new session in ${LABELS[o.value]} instead.` : ` It keeps ${LABELS[mode]} until it ends.`
    return { ...o, unavailable: true, title: `A background session can't switch ${across} while it runs.${then}` }
  })
}

/** The mode the switcher raises: the one a pending switch goes to, else the one the session runs in; null when the
 * session has no mode of its own. Pure. */
export function shownMode(meta: Pick<ChatMeta, 'permission_mode' | 'mode_switch'> | null | undefined): OrientPermissions | null {
  return meta?.mode_switch ?? meta?.permission_mode ?? null
}

/** The first sentence of Claude Code's Bypass warning, which the card keeps while the session runs in Bypass. */
export const BYPASS_LINE = BYPASS_WARNING.slice(0, BYPASS_WARNING.indexOf('. ') + 1)

export function ModeSwitch({ ws, chat, meta }: { ws: string; chat: string; meta: SwitchMeta }) {
  // the analyst's pick, shown until the chat's meta, read again on the stream, says what the server made of it
  const [picked, setPicked] = useState<OrientPermissions | null>(null)
  useEffect(() => setPicked(null), [meta.permission_mode, meta.mode_switch])
  const [off, setOff] = useState<readonly string[]>([])
  useEffect(() => {
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setOff(s.disabled_modes ?? []))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  const mode = picked ?? shownMode(meta)
  if (!mode) return null
  const options = modeOptions(meta, mode, off)
  const pick = (v: OrientPermissions) => {
    if (options.find((o) => o.value === v)?.unavailable) return saveForNext(v)
    track('ui-click', { target: `chat:${chat}`, detail: { action: 'permission-mode', mode: v } })
    setPicked(v)
    api.setSessionMode(ws, chat, v).catch((e: Error) => {
      setPicked(null)
      bus.emit('toast', { text: `Could not switch to ${LABELS[v]}: ${e.message}`, kind: 'error' })
    })
  }
  // a mode this session cannot switch to: its agent's row, for that agent's next new session (modes.mode_for); with no
  // row, the tooltip's words as a toast, so a click never does nothing
  const saveForNext = (v: OrientPermissions) => {
    const agent = agentOf(meta)
    if (!agent) return bus.emit('toast', { text: options.find((o) => o.value === v)?.title ?? '' })
    track('ui-click', { target: `chat:${chat}`, detail: { action: 'permission-mode-next', mode: v, agent } })
    api
      .putSettings(ws, { permission_modes: { [agent]: v } })
      .then(() => {
        invalidateSettings(ws)
        bus.emit('toast', { text: `${LABELS[v]} saved for ${NEXT_OF[agent]} next new session. This one keeps ${LABELS[mode]} while it runs.` })
      })
      .catch((e: Error) => bus.emit('toast', { text: `Could not save ${LABELS[v]}: ${e.message}`, kind: 'error' }))
  }
  const switching = meta.mode_switch && meta.mode_switch !== meta.permission_mode ? meta.mode_switch : null
  return (
    <div className="chat-perms" data-mode={mode}>
      <div className="chat-perms-row">
        <span className="chat-perms-label">Permissions</span>
        <Segmented size="sm" track label="This session's permission mode" options={options} value={mode} onChange={pick} />
      </div>
      {switching ? (
        <p className="chat-perms-note" role="status">
          Switching to {LABELS[switching]} at the next pause, keeping the work so far.
        </p>
      ) : mode === 'bypass' ? (
        <p className="chat-perms-warn" role="alert">
          <Icon name="warning" size={13} className="chat-perms-warn-ico" />
          <span>{BYPASS_LINE}</span>
        </p>
      ) : null}
    </div>
  )
}
