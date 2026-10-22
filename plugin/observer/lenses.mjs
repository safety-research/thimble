// lenses.mjs: the lenses of the observer's look, in the order their fragments stand in its prompt. Pure: each lens
// says its prompt fragment (`feature`, a text of prompts/registry.mjs), the switch it belongs to (`option`,
// settings/features.mjs), its part of the reply's skeleton, how it reads its part of the reply (`read`, `raw`), its
// digest of what thimble already gave (`digest`, from the state the features' seams give: explain/seam.ts
// explainState, claims/seam.ts claimsState) and its rules this time (`when`). What a lens gives is placed by its
// feature's seam (observer.ts calls explainMerge and claimsMerge by name). A new kind of observation is a lens here and
// its fragment in the registry.
import claims from '../claims/lens.mjs'
import { explain, heads } from '../explain/lens.mjs'

export const LENSES = [explain, heads, claims]
