// Cards that open a cited record themselves (canvas/TypeCard): a click on a chip in such a card's text asks the card
// first, and the chip goes to the ref as usual only when the card does not show that record. A card drawn twice, on the
// canvas and at full size, is asked in the place registered last.
const openers = new Map<string, ((ref: string) => boolean)[]>()

/** Register the card `card`'s opener until the returned function is called. */
export function onCiteClick(card: string, open: (ref: string) => boolean): () => void {
  openers.set(card, [...(openers.get(card) ?? []), open])
  return () => {
    const rest = (openers.get(card) ?? []).filter((f) => f !== open)
    if (rest.length) openers.set(card, rest)
    else openers.delete(card)
  }
}

/** Whether the card `card` opened the record `ref` names. */
export function openCited(card: string, ref: string): boolean {
  return openers.get(card)?.at(-1)?.(ref) ?? false
}
