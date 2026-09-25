// The browser checks, tests/public/browser: real components in Playwright's headless Chromium, for what only a
// browser's layout, sandbox or drawing shows (a sidebar never squeezes the text beside it, nothing jumps when a reply
// streams or a comment arrives, the card check draws the card the canvas draws, a sandboxed output cannot reach the
// page). Each page is answered by its test on a made-up origin, so no port is opened and nothing leaves the machine.
// Run from frontend/: npm run test:browser. scripts/check.sh browser skips them, saying so, where no Chromium is
// installed; `npx playwright install chromium-headless-shell` installs it.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/public/browser/**/*.test.ts'],
    environment: 'node',
    // a file bundles its page and starts a browser once; a layout check waits on real timers
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
