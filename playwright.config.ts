import { defineConfig } from '@playwright/test';

/**
 * Runs the generated test scripts. The pipeline writes them to `output/testpilot/`:
 * that is `scriptsDir` in this repo's `.testpilot/config.json`.
 *
 * The browser is a plain Chromium context, as in the MCP and validation
 * browsers; each script pins its own locale with `test.use`.
 *
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
    testDir: './output',
    testMatch: '**/*.spec.ts',
    forbidOnly: !!process.env.CI,
    // Progress in the terminal, plus an HTML report in playwright-report/ for
    // `npx playwright show-report`.
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
