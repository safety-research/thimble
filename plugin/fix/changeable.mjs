// changeable.mjs: which of the person's fixes more words can change, in one place. The hooks module reads it
// (request.ts), and so does the browser's server (browser/backend/app/fixes.py), which reads the list as the JSON it is,
// so it stays on one line, in double quotes. Pure: no `$`, no Node.

/** The states of the fixes the person has whose number takes more words, `/thimble-fix N <words>`, as a round of fix N
 *  (the kernel's round_): any in the list, at work or not, a request with no code, and a fix an update set aside
 *  (pending), whose next round starts in a new copy. Claude reads these fixes beside the person's /thimble-fix. */
export const CHANGEABLE = ["on", "off", "ready", "working", "failed", "redo", "pending", "request"]
