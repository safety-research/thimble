// protected.mjs: the files no fix may change, by what each one is, as the hooks module has them. The kernel refuses a
// change to one when the fixer ends (engine/kernel/fixes.py PROTECTED_KINDS); the hooks module refuses the fixer's write
// of one when it makes it (fixer.ts fixerCall), so that the fixer learns it before its round ends. The kernel's tests
// hold the two lists equal: they read this one as the JSON it is, so it stays in double quotes, with no comma after a
// last item. Pure: no `$`, no Node.

/** The files a fix may not change: the way back, which turns fixes off and undoes them, and the scan a shared fix goes
 *  through. A * stands for any characters, a / among them. */
export const PROTECTED_KINDS = {
  "the fix flow": ["plugin/engine/kernel/fixes.py", "plugin/engine/kernel/share.py", "plugin/fix/*", "plugin/prompts/fixer.md",
    "browser/backend/app/dev.py", "browser/backend/app/fixes.py", "browser/frontend/src/chat/FixStrip.tsx",
    "browser/frontend/src/chat/fix.ts"],
  "the privacy scan": ["plugin/engine/kernel/privacy.py"]
}
