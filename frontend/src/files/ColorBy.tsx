// The Color by control of Files' Transcript mode (colorChoice.ts): thimble's bordered button "Color by: <choice> ▾", then
// a chip per value of the choice (a square swatch of its color, its name and its count, in thimble's small bordered box)
// that turns its records off and on; Alt-click keeps that value alone. The menu lists Off, the records' keys and the
// labels that mark the file, each with how many values it has and, on a second line, its values as chips (cut off with
// … where they do not fit); a label that is off turns on when chosen. Choosing a label also opens its editor in a
// popover under the button (LabelEditor), and Escape there gives the focus back to the button. A chip of a label's value
// says what the value means on hover, where the label's definition says it. A click on a chip's swatch opens the palette
// of thimble's twelve label colors (ValuePalette): the one picked recolors the value on the records, the chips and the
// tracks; a label's value keeps it as the label's color (Files and every view), a key's value per file, and Reset colors
// gives the key's values their own colors back.
import { useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Popover } from '../components/Menu'
import { useTooltip } from '../components/Tooltip'
import type { Concept, SourceKey } from '../lib/types'
import { choiceId, keyChips, labelChips, NONE, pickedChips, type ColorChoice, type ColorValue } from './colorChoice'
import { openLabelEditor } from './LabelEditor'
import { mainColour } from './labels'
import { ValuePalette } from './ValuePalette'

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
  /** give a value one of the palette's colors, 1 to LABEL_COLOURS; no palette without it */
  onColor?: (value: string, color: number) => void
  /** give the choice's values their own colors back; no Reset colors without it */
  onResetColors?: () => void
  /** the colors picked for a choice's values, by its id (choiceId), which the menu's previews show */
  pickedOf?: (id: string) => Readonly<Record<string, number>> | undefined
}

export function choiceName(c: ColorChoice, labels: readonly Concept[]): string {
  if (c.by === 'off') return 'Off'
  if (c.by === 'key') return c.key
  return labels.find((k) => k.id === c.id)?.name ?? 'label'
}

export function ColorBy({ choice, keys, labels, values, off, onChoose, onToggle, countsOf, onColor, onResetColors, pickedOf }: Props) {
  const trigger = useRef<HTMLButtonElement>(null)
  const paletteAt = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [painting, setPainting] = useState<string | null>(null)
  const painted = painting != null ? values.find((v) => v.id === painting) : undefined
  return (
    <div className="colorby">
      <Button ref={trigger} variant="secondary" size="sm" className="colorby-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="colorby-k">Color by:</span> <b>{choiceName(choice, labels)}</b>
        <Icon name="chevron-down" size={12} className="colorby-caret" />
      </Button>
      {choice.by !== 'off' && (
        <div className="colorby-chips" role="group" aria-label="Values">
          {values.map((v) => (
            <ValueChip
              key={v.id}
              v={v}
              on={!off.includes(v.id)}
              onToggle={onToggle}
              quiet={painting != null}
              onPalette={
                onColor && v.color
                  ? (el) => {
                      paletteAt.current = el
                      setPainting((p) => (p === v.id ? null : v.id))
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
      <Popover anchor={trigger} open={open} onClose={() => setOpen(false)} role="menu" label="Color by" className="colorby-menu" width={300}>
        <ColorMenu
          choice={choice}
          keys={keys}
          labels={labels}
          countsOf={countsOf}
          pickedOf={pickedOf}
          onChoose={(c) => {
            setOpen(false)
            onChoose(c)
            // a label chosen: its editor under the button, which the focus goes back to
            const at = trigger.current
            if (c.by === 'label' && at) openLabelEditor({ id: c.id, anchor: at, side: 'below', back: at })
          }}
        />
      </Popover>
      {onColor && (
        <Popover
          anchor={paletteAt}
          open={!!painted}
          onClose={(how) => {
            setPainting(null)
            if (how === 'escape') paletteAt.current?.focus()
          }}
          label={painted ? `Color of ${painted.name}` : 'Color'}
          className="colorby-palette"
        >
          {painted && (
            <ValuePalette
              value={painted}
              onPick={(n) => {
                setPainting(null)
                onColor(painted.id, n)
              }}
              onReset={
                onResetColors
                  ? () => {
                      setPainting(null)
                      onResetColors()
                    }
                  : undefined
              }
            />
          )}
        </Popover>
      )}
    </div>
  )
}

function ValueChip({ v, on, onToggle, onPalette, quiet }: { v: ColorValue; on: boolean; onToggle: (value: string, alone: boolean) => void; onPalette?: (chip: HTMLElement) => void; quiet?: boolean }) {
  // no meaning beside the chip while the palette is open over it
  const { props: tip, tip: tipEl } = useTooltip(quiet ? null : (v.meaning ?? null))
  return (
    <>
      <button
        type="button"
        className="colorby-chip"
        aria-pressed={on}
        data-value={v.id}
        style={v.color ? ({ '--c': v.color } as CSSProperties) : undefined}
        onClick={(e: MouseEvent) => {
          // the swatch: the palette, to pick the value's color
          if (onPalette && (e.target as HTMLElement).closest?.('[data-palette]')) return onPalette(e.currentTarget as HTMLElement)
          onToggle(v.id, e.altKey)
        }}
        {...(tip as object)}
      >
        <span className="colorby-sw" {...(onPalette ? { 'data-palette': '', title: `Color of ${v.name}` } : {})} />
        <span className="colorby-name">{v.name}</span>
        {v.n != null && <span className="colorby-n">{v.n.toLocaleString()}</span>}
      </button>
      {tipEl}
    </>
  )
}

/** "1 value", "12 values" */
export const valuesWord = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'value' : 'values'}`

/** A choice's values in the menu, on one line under its name: each a chip's square swatch and name, cut off with … */
function ChipPreview({ values }: { values: readonly ColorValue[] }) {
  return (
    <span className="colorby-preview" aria-hidden>
      {values.map((v) => (
        <span key={v.id} className="colorby-preview-chip" style={v.color ? ({ '--c': v.color } as CSSProperties) : undefined}>
          <span className="colorby-sw" />
          {v.name}
        </span>
      ))}
    </span>
  )
}

/** A choice's name with how many values it has, and its values as chips on the line under them. */
function ChoiceBody({ name, mono, count, values, swatch }: { name: string; mono?: boolean; count: number; values: readonly ColorValue[]; swatch?: string }) {
  return (
    <span className="colorby-choice">
      <span className="colorby-choice-top">
        {swatch && <span className="colorby-sw" style={{ '--c': swatch } as CSSProperties} />}
        <span className={'menu-item-label' + (mono ? ' mono' : '')}>{name}</span>
        <span className="menu-item-note">{valuesWord(count)}</span>
      </span>
      {values.length > 0 && <ChipPreview values={values} />}
    </span>
  )
}

function ColorMenu({ choice, keys, labels, countsOf, pickedOf, onChoose }: { choice: ColorChoice; keys: readonly SourceKey[]; labels: readonly Concept[]; countsOf: Props['countsOf']; pickedOf?: Props['pickedOf']; onChoose: (c: ColorChoice) => void }) {
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
      {item({ by: 'off' }, <span className="menu-item-label">Off</span>)}
      {keys.length > 0 && (
        <div className="menu-heading" role="presentation">
          Keys
        </div>
      )}
      {keys.map((k) =>
        item({ by: 'key', key: k.key }, <ChoiceBody name={k.key} mono count={k.values.length + k.more.values} values={pickedChips(keyChips(k), pickedOf?.(choiceId({ by: 'key', key: k.key }))).filter((v) => v.id !== NONE)} />),
      )}
      {labels.length > 0 && (
        <div className="menu-heading" role="presentation">
          Labels
        </div>
      )}
      {labels.map((k) => item({ by: 'label', id: k.id }, <LabelBody label={k} counts={countsOf(k.id)} />))}
    </div>
  )
}

/** A label's row in the menu: its color, its name, how many values it colors by and those values as chips. */
function LabelBody({ label: k, counts }: { label: Concept; counts?: Readonly<Record<string, number>> }) {
  const lit = labelChips(k, counts, null).filter((v) => v.id !== NONE)
  return <ChoiceBody name={k.name} swatch={mainColour(k)} count={lit.length} values={lit} />
}
