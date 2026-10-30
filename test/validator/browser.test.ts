/** Tests for src/validator/browser, against a real Chromium on `data:` URLs. */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { BrowserError, ValidationBrowser } from '../../src/validator/browser.ts';

const PAGE =
    'data:text/html,' +
    "<button id='go'>Login</button>" +
    '<p>Your email or password is incorrect!</p>' +
    "<a href='#'>Repeated</a><a href='#'>Repeated</a>";

let browser: ValidationBrowser;

/** A live validation browser on the test page, closed after the test. */
beforeEach(async () => {
    browser = await ValidationBrowser.launch();
    await browser.run([
        { code: `await page.goto(${JSON.stringify(PAGE)});`, reason: '' },
    ]);
});

afterEach(async () => {
    await browser.close();
});

test('replays code verbatim on cumulative state', async () => {
    // Each run builds on the state earlier runs left; reset discards it all.
    await browser.run([
        {
            code: "await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();",
            reason: '',
        },
        {
            code: "await page.getByRole('button', { name: 'Login' }).click();",
            reason: '',
        },
    ]);
    await browser.run([
        {
            code: "await expect(page.getByText('incorrect!')).toBeVisible();",
            reason: '',
        },
    ]);

    await browser.reset();

    expect(browser.page.url()).toBe('about:blank');
});

describe('code that does not hold on the page fails', () => {
    // Code that runs is not enough: the locator must be unique and true.
    test.each([
        {
            id: 'matches-nothing',
            code: "await page.getByRole('button', { name: 'Nope' }).click({ timeout: 1500 });",
        },
        {
            id: 'matches-several',
            code: "await page.getByRole('link', { name: 'Repeated' }).click({ timeout: 1500 });",
        },
        {
            id: 'false-assertion',
            code:
                "await expect(page.getByText('Welcome back'))" +
                '.toBeVisible({ timeout: 1500 });',
        },
    ])('$id', async ({ code }) => {
        const error = await browser
            .run([{ code, reason: '' }])
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BrowserError);
        expect((error as BrowserError).code).toBe(code);
        expect((error as BrowserError).reason).not.toBe('');
    });
});
