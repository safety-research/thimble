// command.mjs: the words that list /thimble-fix, in one place. The hooks module registers the command with them
// (register.ts), and the browser's chat lists the command with its description (browser/frontend/src/chat/commands.ts).
// Pure: no `$`, no Node.

/** What the command does, beside its name in a list of commands. */
export const FIX_DESCRIPTION = 'Change thimble for yourself: say what should work differently.'

/** What the person types after the command's name, as Claude Code's list shows it. */
export const FIX_ARGUMENT_HINT = '[what should work differently]'
