// register.ts: labels in the session. A `label` line of the change feed starts the model's reads of a --prompt label
// beside the session (core/feed.ts calls labels.ts labelFromFeed). The labels pane is labels/pane.tsx (core/pane.ts
// kind `labels`). The labels lane adds the person's checks here.
import type { Register } from 'claude-code'

export const registerLabels: Register = () => {}
