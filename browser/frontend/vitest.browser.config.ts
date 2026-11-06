// The browser checks, tests/public/browser: real components in Playwright's headless Chromium, for what only a
// browser's layout or sandbox shows (a sandboxed output cannot reach the page or draw over it, and the screenshot
// tool's token goes to the page's own API alone). Each page is answered by its test, on a made-up origin or a server
// on the loopback, so nothing leaves the machine.
// Run from frontend/: npm run test:browser, once `npx playwright install chromium-headless-shell` has installed the
// Chromium.
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
