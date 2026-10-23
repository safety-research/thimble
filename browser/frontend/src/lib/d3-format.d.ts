// d3-format ships no types of its own; this is the part lib/dataFrame uses. A table card's numbers are formatted with
// d3-format in the formats the backend chose (backend/app/frames.py, view.formats), so the card shows each value as the
// citation check reads it.
declare module 'd3-format' {
  export function format(specifier: string): (n: number | { valueOf(): number }) => string
}
