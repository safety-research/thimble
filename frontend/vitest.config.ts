// The public test suite, tests/public: the UI's pure modules under Node, and its components under jsdom where a test
// names that environment in its first line. No test here opens a browser, reaches the network or compares pictures;
// the checks that need a real browser are tests/public/browser, which vitest.browser.config.ts runs.
// Run from frontend/: npm test (or npx vitest for watch mode).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    // and the plugin's hooks module (plugin/hooks/thimble.ts), against a fake Claude Code engine
    include: ['tests/public/**/*.test.{ts,tsx}', '../plugin/hooks/*.test.ts'],
    exclude: ['tests/public/browser/**', '**/node_modules/**'],
    environment: 'node',
    // a component test that waits on React or DOMPurify finishes in well under a second; a hang fails fast
    testTimeout: 10_000,
  },
})
