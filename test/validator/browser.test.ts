/** Tests for src/validator/browser, against a real Chromium on `data:` URLs. */

import { chromium } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { statement, type StepStatement } from '../../src/model/test-case.ts';
import { BrowserLaunchError } from '../../src/runtime/exceptions.ts';
import { BrowserError, ValidationBrowser } from '../../src/validator/browser.ts';

const PAGE =
    'data:text/html,' +
    "<button id='go'>Login</button>" +
    '<p>Your email or password is incorrect!</p>' +
    "<a href='#'>Repeated</a><a href='#'>Repeated</a>";

// A short replay ceiling, so a statement that never holds fails fast.
const CEILING_MS = 1_500;

function goto(url: string): StepStatement {
    return statement(`await page.goto(${JSON.stringify(url)});`);
}

let browser: ValidationBrowser;

/** A live validation browser on the test page, closed after the test. */
beforeEach(async () => {
    browser = await ValidationBrowser.launch({ timeoutMs: CEILING_MS });
    await browser.run([goto(PAGE)]);
});

afterEach(async () => {
    await browser.close();
});

test('replays code verbatim on cumulative state, until a reset', async () => {
    await browser.run([
        statement("await page.getByRole('button', { name: 'Login' }).click();"),
    ]);
    await browser.run([
        statement("await expect(page.getByText('incorrect!')).toBeVisible();"),
    ]);

    await browser.reset();

    await browser.run([statement("await expect(page).toHaveURL('about:blank');")]);
});

describe('code that does not hold on the page fails at the ceiling', () => {
    // Code that runs is not enough: the locator must be unique and true. An
    // action would otherwise wait 30s for its element, an assertion 5s.
    test.each([
        {
            id: 'matches-nothing',
            code: "await page.getByRole('button', { name: 'Nope' }).click();",
        },
        {
            id: 'matches-several',
            code: "await page.getByRole('link', { name: 'Repeated' }).click();",
        },
        {
            id: 'false-assertion',
            code: "await expect(page.getByText('Welcome back')).toBeVisible();",
        },
    ])('$id', async ({ code }) => {
        const started = performance.now();
        const error = await browser.run([statement(code)]).catch((e: unknown) => e);

        expect(performance.now() - started).toBeLessThan(CEILING_MS + 2_000);
        expect(error).toBeInstanceOf(BrowserError);
        expect((error as BrowserError).code).toBe(code);
        expect((error as BrowserError).reason).not.toBe('');
    });
});

test('times each statement, so late content is measured, not failed', async () => {
    // The Validator turns a statement's wait into its timeout, also for what
    // ran before a failure.
    const late =
        'data:text/html,<script>setTimeout(() => {' +
        "const p = document.createElement('p'); p.textContent = 'Late';" +
        'document.body.append(p);}, 500);</script>';
    const error = await browser
        .run([
            goto(late),
            statement("await expect(page.getByText('Late')).toBeVisible();"),
            statement("await expect(page.getByText('Never shown')).toBeVisible();"),
        ])
        .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserError);
    const { durations } = error as BrowserError;
    expect(durations).toHaveLength(2);
    expect(durations[1]).toBeGreaterThanOrEqual(400);
});

test('a Chromium that cannot launch is a BrowserLaunchError with a cause', async () => {
    const cause = new Error('Executable does not exist');
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValueOnce(cause);
    try {
        const error = await ValidationBrowser.launch().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BrowserLaunchError);
        expect((error as Error).message).toContain('Executable does not exist');
        expect((error as Error).cause).toBe(cause);
        expect((error as BrowserLaunchError).code).toBe('BROWSER_LAUNCH_FAILED');
    } finally {
        launch.mockRestore();
    }
});
