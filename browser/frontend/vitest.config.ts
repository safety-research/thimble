// The public test suite, tests/public: the UI's pure modules under Node, and its components under jsdom where a test
// names that environment in its first line. No test here opens a browser, reaches the network or compares pictures;
// the checks that need a real browser are tests/public/browser, which vitest.browser.config.ts runs.
// Run from frontend/: npm test (or npx vitest for watch mode).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // the terminal plugin's modules the page reads as they are (src/marks: plugin/marks/message.js)
  server: { fs: { allow: ['.', '../../plugin'] } },
  test: {
    include: ['tests/public/**/*.test.{ts,tsx}'],
    exclude: ['tests/public/browser/**', '**/node_modules/**'],
    environment: 'node',
    // Node 25 and later have a localStorage of their own, which holds nothing without --localstorage-file and stands in
    // front of jsdom's: the component tests read and write jsdom's
    execArgv: ['--no-experimental-webstorage'],
    // a component test that waits on React or DOMPurify finishes in well under a second; a hang fails fast
    testTimeout: 10_000,
  },
})
