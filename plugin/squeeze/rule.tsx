// rule.tsx: the Client module that draws a catch-up's rule (ui.ts names it by this file): one ▎ per row of the region
// the catch-up gives it, which spans the catch-up's whole height, so the rule ends where the catch-up ends whatever its
// text and cards lay out to. Claude Code calls it again when the region's height changes.
//
//   props: {color}: the rule's color, thimble's
import type { ClientModule, ClientSurface } from 'claude-code'

const Rule: ClientModule<{ color?: string }> = (props: { color?: string }, surface: ClientSurface) =>
  surface.elements.Text({ ...(props.color ? { color: props.color } : {}), children: Array.from({ length: Math.max(1, surface.rows) }, () => '▎').join('\n') })

export default Rule
