// The top bar's Manual-mode chip: while main's session runs in Claude Code's Manual mode, as main's hooks report it
// (main's meta's `attached.manual`, backend session.note_mode), a small chip says "Manual mode". Its tooltip, and its
// sheet on a click, say how to switch to auto mode, or who turned auto mode off: the words main's terminal shows once
// (backend modes.MANUAL_LINES), with "in your terminal" for shift+tab. The first time this browser sees a session of
// the workspace in Manual mode, the sheet opens by itself, once. Its × hides the chip for this workspace in this
// browser. It goes by itself when main reports another mode.
import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Popover } from '../components/Menu'
import { TipButton, useTooltip } from '../components/Tooltip'
import type { Attached, ManualHint } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'

export const MANUAL_CHIP = 'Manual mode'
/** The command that starts main in auto mode, set in code in the sheet. */
export const AUTO_COMMAND = 'thimble --permission-mode auto'
const LEAD = "Claude Code is in Manual mode, so it asks you before most commands that main or thimble's agents run."
/** What the tooltip and the sheet say, by Attached.manual. */
export const MANUAL_TEXT: Readonly<Record<ManualHint, string>> = {
  switch: `${LEAD} For fewer prompts, press shift+tab in your terminal to switch to auto mode, or start with ${AUTO_COMMAND}.`,
  org: `${LEAD} Your organization turned auto mode off.`,
  settings: `${LEAD} Your Claude Code settings turn auto mode off (disableAutoMode).`,
}
export const HIDE_TIP = 'Hide for this workspace'
/** Browser storage, per workspace: the chip hidden by its ×, and the last session whose sheet opened by itself. */
export const HIDDEN_KEY = 'manual-chip-hidden'
export const TOLD_KEY = 'manual-chip-told'

/** The chip's hint for main's session, or null when there is none to show. Pure. */
export function manualHint(attached: Pick<Attached, 'manual'> | null | undefined): ManualHint | null {
  const hint = attached?.manual
  return hint && hint in MANUAL_TEXT ? hint : null
}

export function ManualChip({ ws, attached }: { ws: string; attached: Pick<Attached, 'session' | 'manual'> | null | undefined }) {
  const hint = manualHint(attached)
  const session = attached?.session ?? ''
  const [hidden, setHidden] = useState(() => readStorage<boolean>(storageKey(ws, HIDDEN_KEY), false) === true)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  useEffect(() => setHidden(readStorage<boolean>(storageKey(ws, HIDDEN_KEY), false) === true), [ws])
  // the one notice: the first time this browser sees this session in Manual mode, the sheet opens by itself
  useEffect(() => {
    if (!hint || hidden || !session || !anchor) return
    if (readStorage<string | null>(storageKey(ws, TOLD_KEY), null) === session) return
    writeStorage(storageKey(ws, TOLD_KEY), session)
    setOpen(true)
  }, [ws, session, hint, hidden, anchor])
  const { props, tip } = useTooltip(hint && !open ? MANUAL_TEXT[hint] : null, 'tip-lines')
  if (!hint || hidden) return null
  const [before, after] = hint === 'switch' ? MANUAL_TEXT.switch.split(AUTO_COMMAND) : [MANUAL_TEXT[hint], undefined]
  return (
    <span className="chip chip-status chip-tone-warning chip-sans manual-chip" data-manual={hint}>
      <button
        ref={setAnchor}
        type="button"
        className="manual-chip-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-tel="manual-chip"
        {...props}
      >
        <Icon name="warning" size={12} className="chip-ico" />
        <span className="chip-text">{MANUAL_CHIP}</span>
      </button>
      {tip}
      <TipButton
        tip={HIDE_TIP}
        className="manual-chip-hide"
        onClick={() => {
          writeStorage(storageKey(ws, HIDDEN_KEY), true)
          setOpen(false)
          setHidden(true)
        }}
        data-tel="manual-chip-hide"
      >
        <Icon name="x" size={10} />
      </TipButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" label={MANUAL_CHIP} className="manual-sheet" width={320}>
        <p className="manual-sheet-text">
          {before}
          {after !== undefined && (
            <>
              <code>{AUTO_COMMAND}</code>
              {after}
            </>
          )}
        </p>
      </Popover>
    </span>
  )
}
