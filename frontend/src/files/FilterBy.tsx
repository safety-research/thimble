// The Filter by control of Files' Transcript mode (useFilterBy.ts), before Color by in the mode's top row, as the view kit's
// Filter by (backend/app/viewer_controls.js): thimble's bordered button "Filter by: <choice> ▾", then a toggle per value
// of the choice (a box ticked while its records show, its name and its count, no color: only Color by draws in color)
// on one line, the toggles that do not fit behind "N more", which lists every value. A click turns a value's records off
// or on; Alt-click shows that value alone. The menu lists None, the records' keys and the labels that mark the file, each
// with its values in words; a label that is off turns on when chosen, and its editor opens under the button, as Color
// by's does, so its definition is one click away. A toggle of a label's value says what the value means on hover.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Popover } from '../components/Menu'
import { useTooltip } from '../components/Tooltip'
import type { Concept, SourceKey } from '../lib/types'
import { choiceName, valuesWord } from './ColorBy'
import { choiceId, labelChips, NONE, type ColorChoice, type ColorValue } from './colorChoice'
import { filterKeyValues } from './useFilterBy'
import { openLabelEditor } from './LabelEditor'

interface Props {
  choice: ColorChoice
  keys: readonly SourceKey[]
  /** the labels over files that mark this file, on or off */
  labels: readonly Concept[]
  values: readonly ColorValue[]
  off: readonly string[]
  onChoose: (c: ColorChoice) => void
  onToggle: (value: string, alone: boolean) => void
  /** a label's value counts on this file */
  countsOf: (id: string) => Readonly<Record<string, number>> | undefined
}

export function FilterBy({ choice, keys, labels, values, off, onChoose, onToggle, countsOf }: Props) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const chipsBox = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const moreN = useRef<HTMLSpanElement>(null)
  const [listOpen, setListOpen] = useState(false)
  // the toggles that do not fit the line go behind "N more", the last first (ColorBy's fit)
  const fit = useCallback(() => {
    const box = chipsBox.current
    const btn = more.current
    if (!box || !btn) return
    const chips = box.querySelectorAll<HTMLElement>('.filterby-chip')
    chips.forEach((c) => (c.hidden = false))
    btn.hidden = true
    if (box.scrollWidth <= box.clientWidth + 1) return
    btn.hidden = false
    let hid = 0
    for (let j = chips.length - 1; j >= 0 && box.scrollWidth > box.clientWidth + 1; j--) {
      chips[j].hidden = true
      hid++
      if (moreN.current) moreN.current.textContent = `${hid.toLocaleString()} more`
    }
  }, [])
  useLayoutEffect(fit, [fit, values, off, choice])
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver !== 'function') return
    let frame: number | null = null
    let width = -1
    const ro = new ResizeObserver(() => {
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (el.clientWidth === width) return
        width = el.clientWidth
        fit()
      })
    })
    ro.observe(el.parentElement ?? el)
    return () => {
      ro.disconnect()
      if (frame != null) cancelAnimationFrame(frame)
    }
  }, [fit])
  const chosen = choice.by !== 'off'
  return (
    <div className="filterby" ref={root}>
      <Button ref={trigger} variant="secondary" size="sm" className="colorby-trigger filterby-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="colorby-k">Filter by{chosen ? ':' : ''}</span>
        {chosen && (
          <>
            {' '}
            <b>{choiceName(choice, labels)}</b>
          </>
        )}
        <Icon name="chevron-down" size={12} className="colorby-caret" />
      </Button>
      {chosen && (
        <div className="filterby-chips" role="group" aria-label="Values shown" ref={chipsBox}>
          {values.map((v) => (
            <FilterChip key={v.id} v={v} on={!off.includes(v.id)} onToggle={onToggle} />
          ))}
          <Button ref={more} variant="ghost" size="sm" className="colorby-more filterby-more" aria-haspopup="dialog" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
            <span ref={moreN} />
            <Icon name="chevron-down" size={12} className="colorby-caret" />
          </Button>
        </div>
      )}
      <Popover anchor={more} open={listOpen && chosen} onClose={() => setListOpen(false)} label="Values shown" className="colorby-values">
        <div className="colorby-values-list" role="group" aria-label="Values shown">
          {values.map((v) => (
            <FilterChip key={v.id} v={v} on={!off.includes(v.id)} onToggle={onToggle} />
          ))}
        </div>
      </Popover>
      <Popover anchor={trigger} open={open} onClose={() => setOpen(false)} role="menu" label="Filter by" className="colorby-menu" width={300}>
        <FilterMenu
          choice={choice}
          keys={keys}
          labels={labels}
          countsOf={countsOf}
          onChoose={(c) => {
            setOpen(false)
            onChoose(c)
            // a label chosen: its editor under the button, which the focus goes back to
            const at = trigger.current
            if (c.by === 'label' && at) openLabelEditor({ id: c.id, anchor: at, side: 'below', back: at })
          }}
        />
      </Popover>
    </div>
  )
}

function FilterChip({ v, on, onToggle }: { v: ColorValue; on: boolean; onToggle: (value: string, alone: boolean) => void }) {
  const { props: tip, tip: tipEl } = useTooltip(v.meaning ?? null)
  return (
    <>
      <button type="button" className="filterby-chip" aria-pressed={on} data-value={v.id} onClick={(e: MouseEvent) => onToggle(v.id, e.altKey)} {...(tip as object)}>
        <span className={'filterby-box' + (on ? ' on' : '')}>{on && <Icon name="check" size={9} />}</span>
        <span className="colorby-name">{v.name}</span>
        {v.n != null && <span className="colorby-n">{v.n.toLocaleString()}</span>}
      </button>
      {tipEl}
    </>
  )
}

/** A choice's name with how many values it has, and its values in words on the line under them, with no color. */
function ChoiceBody({ name, mono, values }: { name: string; mono?: boolean; values: readonly string[] }) {
  return (
    <span className="colorby-choice">
      <span className="colorby-choice-top">
        <span className={'menu-item-label' + (mono ? ' mono' : '')}>{name}</span>
        <span className="menu-item-note">{valuesWord(values.length)}</span>
      </span>
      {values.length > 0 && (
        <span className="colorby-preview filterby-words" aria-hidden>
          {values.slice(0, 24).join(' · ')}
        </span>
      )}
    </span>
  )
}

function FilterMenu({ choice, keys, labels, countsOf, onChoose }: { choice: ColorChoice; keys: readonly SourceKey[]; labels: readonly Concept[]; countsOf: Props['countsOf']; onChoose: (c: ColorChoice) => void }) {
  const current = choiceId(choice)
  const item = (c: ColorChoice, body: ReactNode) => {
    const id = choiceId(c)
    return (
      <div key={id} className="colorby-row">
        <button type="button" role="menuitemradio" aria-checked={current === id} className={'menu-item colorby-item' + (current === id ? ' checked' : '')} onClick={() => onChoose(c)}>
          <span className="colorby-tick">{current === id && <Icon name="check" size={12} />}</span>
          {body}
        </button>
      </div>
    )
  }
  return (
    <div className="colorby-list">
      {item({ by: 'off' }, <span className="menu-item-label">None</span>)}
      {keys.length > 0 && (
        <div className="menu-heading" role="presentation">
          Fields
        </div>
      )}
      {keys.map((k) =>
        item(
          { by: 'key', key: k.key },
          <ChoiceBody
            name={k.key}
            mono
            values={filterKeyValues(k)
              .filter((v) => v.id !== NONE)
              .map((v) => v.name)}
          />,
        ),
      )}
      {labels.length > 0 && (
        <div className="menu-heading" role="presentation">
          Labels
        </div>
      )}
      {labels.map((k) =>
        item(
          { by: 'label', id: k.id },
          <ChoiceBody
            name={k.name}
            values={labelChips(k, countsOf(k.id), null)
              .filter((v) => v.id !== NONE)
              .map((v) => v.name)}
          />,
        ),
      )}
    </div>
  )
}
