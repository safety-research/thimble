// The active label filter as one chip, the same on the canvas, in Files and in the report: the label's name and the
// value, the count of units it keeps, and × at the end; the whole chip clears the filter.
import { Chip } from './Chip'
import { kindIcon } from './RefChip'

export interface FilterChipProps {
  concept: string
  name: string
  value: string
  /** how many units the filter keeps (cards, files, sentences); omitted while unknown */
  count?: number
  onClear: () => void
  className?: string
}

export function FilterChip({ concept, name, value, count, onClear, className }: FilterChipProps) {
  return (
    <Chip kind="value" icon={kindIcon('concept')} active count={count} trailingIcon="x" className={className} onClick={onClear} aria-label={`Clear the filter ${name} ${value}`} data-anchor={`concept:${concept}`} data-anchor-text={`${name} ${value}`} data-concept={concept} data-value={value}>
      {name} · {value}
    </Chip>
  )
}

export default FilterChip
