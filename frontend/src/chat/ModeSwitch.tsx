// A running session's permission mode on its card, changeable for that session: the three modes (PERMISSION_OPTIONS),
// less those the analyst's Claude Code settings turn off, as a small segmented track. Manual and Bypass switch at once (the session runs in Claude Code's manual mode in both, and
// in Bypass thimble grants every request). A switch into or out of Auto restarts the session in the new mode at its
// next pause, with its work kept; until then a line says it waits. In Bypass, the first sentence of Claude Code's own
// warning stays under the switcher.
import { useEffect, useState } from 'react'
import { Segmented } from '../components/Button'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { loadSettings } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ChatMeta, OrientPermissions } from '../lib/types'
import { BYPASS_WARNING, PERMISSION_OPTIONS } from './StartGate'

const LABELS: Record<OrientPermissions, string> = { manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }

/** The mode the switcher raises: the one a pending switch goes to, else the one the session runs in; null when the
 * session has no mode of its own. Pure. */
export function shownMode(meta: Pick<ChatMeta, 'permission_mode' | 'mode_switch'> | null | undefined): OrientPermissions | null {
  return meta?.mode_switch ?? meta?.permission_mode ?? null
}

/** The first sentence of Claude Code's Bypass warning, which the card keeps while the session runs in Bypass. */
export const BYPASS_LINE = BYPASS_WARNING.slice(0, BYPASS_WARNING.indexOf('. ') + 1)

export function ModeSwitch({ ws, chat, meta }: { ws: string; chat: string; meta: Pick<ChatMeta, 'permission_mode' | 'mode_switch'> }) {
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
  const pick = (v: OrientPermissions) => {
    track('ui-click', { target: `chat:${chat}`, detail: { action: 'permission-mode', mode: v } })
    setPicked(v)
    api.setSessionMode(ws, chat, v).catch((e: Error) => {
      setPicked(null)
      bus.emit('toast', { text: `Could not switch to ${LABELS[v]}: ${e.message}`, kind: 'error' })
    })
  }
  const switching = meta.mode_switch && meta.mode_switch !== meta.permission_mode ? meta.mode_switch : null
  return (
    <div className="chat-perms" data-mode={mode}>
      <div className="chat-perms-row">
        <span className="chat-perms-label">Permissions</span>
        <Segmented size="sm" track label="This session's permission mode" options={PERMISSION_OPTIONS.filter((o) => !off.includes(o.value))} value={mode} onChange={pick} />
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
