// What the plugin's hooks module test (plugin/hooks/thimble.test.ts) takes from Claude Code's test kit,
// 'claude-code/testing', as vitest's own, so the frontend's vitest runs that file too (vitest.config.ts maps the kit
// here). The file uses only these three, and builds its own fake engine rather than the kit's.
export { describe, expect, test } from 'vitest'
