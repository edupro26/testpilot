import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        // Show a test's logs only when it fails.
        silent: 'passed-only',
        // The validation browser tests drive a real Chromium.
        testTimeout: 30_000,
    },
});
