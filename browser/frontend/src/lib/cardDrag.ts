// A card dragged to the report: the drag carries the card's id under CARD_MIME, which the report's editor takes as a
// figure, and its ref as plain text for any other drop target. The report's sidebar and a card's chip in the chat set it.
import type { DragEvent } from 'react'

/** The drag's data type: a card dragged to the report carries its id under it. */
export const CARD_MIME = 'application/x-thimble-card'

/** Start a drag of the card `cellId`. */
export function dragCard(e: DragEvent, cellId: string): void {
  e.dataTransfer.setData(CARD_MIME, cellId)
  e.dataTransfer.setData('text/plain', `card:${cellId}`)
  e.dataTransfer.effectAllowed = 'copy'
}
