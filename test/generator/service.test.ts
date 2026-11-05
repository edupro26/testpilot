/** Tests for src/generator/service. */

import { describe, expect, test } from 'vitest';

import { GeneratorError } from '../../src/exceptions.ts';
import { Generator } from '../../src/generator/service.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import {
    statement,
    type StepStatement,
    type TestCase,
} from '../../src/model/test-case.ts';

const CONSENT = "await page.getByRole('button', { name: 'Consent' }).click();";
const CLICK = "await page.getByRole('link', { name: 'Signup / Login' }).click();";
const ASSERT =
    "await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();";
// The assertion as the LLM is asked to write it, with its measured timeout.
const ASSERT_TIMED = ASSERT.replace('()', '({ timeout: 18_000 })');
const ASSERT_MARKED = `${ASSERT}  [timeout: 18_000]`;

/** A one-module test case of `steps`, each a step text and its statements. */
function testCase(...steps: [string, StepStatement[]][]): TestCase {
    return {
        name: 'Login User with Incorrect Credentials',
        modules: [
            {
                url: 'https://automationexercise.com',
                description: 'Home page',
                execution_steps: steps.map(([step, statements]) => ({
                    step,
                    statements,
                })),
            },
        ],
    };
}

const TEST_CASE = testCase(
    ['Navigate and open the login page', [statement(CONSENT), statement(CLICK)]],
    ['Observe the page', []],
    [
        'Verify the login section is visible',
        [{ ...statement(ASSERT), timeout: 18_000 }],
    ],
);

/** The test body for `TEST_CASE`, as the LLM is asked to write it. */
function steps(assert = ASSERT_TIMED, click = CLICK): string {
    return (
        '  // Navigate and open the login page\n' +
        `  ${CONSENT}\n` +
        `  ${click}\n` +
        '\n' +
        '  // Observe the page\n' +
        '  // (no browser interaction required)\n' +
        '\n' +
        '  // Verify the login section is visible\n' +
        `  ${assert}\n`
    );
}

/** A well-formed script, as the LLM is asked to write it. */
function script(locale = 'en-US', body = steps()): string {
    return (
        '/** Login with incorrect credentials. */\n' +
        '\n' +
        "import { expect, test } from '@playwright/test';\n" +
        '\n' +
        `test.use({ locale: '${locale}' });\n` +
        '\n' +
        '/** Log in with a wrong password and see the login section. */\n' +
        "test('Login with incorrect credentials', async ({ page }) => {\n" +
        body +
        '});\n'
    );
}

test('assembles the validated steps into the LLM script', async () => {
    // The LLM gets every validated piece verbatim, an assertion's measured
    // timeout marked beside it, and its file is returned. A Markdown fence
    // around the code must not end up in the file.
    let prompt = '';
    const capture = (_system: string, user: string): string => {
        prompt = user;
        return `\`\`\`typescript\n${script('pt-PT')}\`\`\``;
    };

    const result = await new Generator(new MockProvider(capture), 'pt-PT').run(
        TEST_CASE,
    );

    expect(result).toBe(script('pt-PT'));
    for (const step of TEST_CASE.modules[0]!.execution_steps) {
        expect(prompt).toContain(`STEP: ${step.step}`);
    }
    for (const line of [CONSENT, CLICK, ASSERT_MARKED]) {
        expect(prompt).toContain(line);
    }
    expect(prompt).toContain('(no statements)');
    expect(prompt).toContain("test.use({ locale: 'pt-PT' });");
});

test('fits the test timeout to how long the statements took to replay', async () => {
    // Playwright's default 30s stays when it covers twice the measured run
    // time; past that, the timeout is pinned like the locale and must come back.
    let prompt = '';
    const capture = (_system: string, user: string): string => {
        prompt = user;
        return script();
    };
    await new Generator(new MockProvider(capture)).run(TEST_CASE, 14_000);
    expect(prompt).toMatch(/TIMEOUT SETTING[^\n]*\n[^\n]*\n\(none\)\n/);

    const timed = script('en-US', `  test.setTimeout(80_000);\n\n${steps()}`);
    const slow = new Generator(
        new MockProvider((_system: string, user: string): string => {
            prompt = user;
            return timed;
        }),
    );
    expect(await slow.run(TEST_CASE, 37_000)).toBe(timed);
    expect(prompt).toContain('test.setTimeout(80_000);');

    const dropped = await new Generator(new MockProvider(script()))
        .run(TEST_CASE, 37_000)
        .catch((e: unknown) => e);
    expect(dropped).toBeInstanceOf(GeneratorError);
    expect(String(dropped)).toContain('test.setTimeout(80_000);');
});

test('accepts a measured timeout however the LLM writes it', async () => {
    // Its formatting and place among the options are the LLM's; the value and
    // the rest of the statement are not.
    const exact =
        "await expect(page.getByText('Total')).toHaveText('9€', { exact: true });";
    for (const [code, written] of [
        [ASSERT, ASSERT.replace('()', '({timeout: 18000})')],
        [exact, exact.replace(' })', ', timeout: 18_000 })')],
        [exact, exact.replace('{ exact', '{ timeout: 18_000, exact')],
    ] as const) {
        const timed = testCase(['Check', [{ ...statement(code), timeout: 18_000 }]]);
        const reply = script('en-US', `  // Check\n  ${written}\n`);

        expect(await new Generator(new MockProvider(reply)).run(timed)).toBe(reply);
    }
});

describe('rejects a script that is not exactly what was validated', () => {
    // What was validated, in order, under its locale and with its measured
    // timeouts, is what ships.
    test.each([
        {
            id: 'dropped-statement',
            reply: script('en-US', `  ${CONSENT}\n  ${ASSERT_TIMED}\n`),
            match: 'Signup / Login',
        },
        {
            id: 'altered-statement',
            reply: script(
                'en-US',
                steps(ASSERT_TIMED, CLICK.replace('()', '({ force: true })')),
            ),
            match: 'altered',
        },
        {
            id: 'dropped-timeout',
            reply: script('en-US', steps(ASSERT)),
            match: ASSERT_MARKED,
        },
        {
            id: 'wrong-timeout',
            reply: script('en-US', steps(ASSERT.replace('()', '({ timeout: 5_000 })'))),
            match: ASSERT_MARKED,
        },
        {
            id: 'unmeasured-timeout',
            reply: script(
                'en-US',
                steps(ASSERT_TIMED, CLICK.replace('()', '({ timeout: 9_000 })')),
            ),
            match: 'Signup / Login',
        },
        {
            id: 'reordered-statements',
            reply: script('en-US', `  ${CLICK}\n  ${CONSENT}\n  ${ASSERT_TIMED}\n`),
            match: 'dropped or altered',
        },
        { id: 'changed-locale', reply: script('pt-PT'), match: 'en-US' },
        {
            id: 'does-not-compile',
            reply: `${script()}function broken(: void {\n`,
            match: 'does not compile',
        },
    ])('$id', async ({ reply, match }) => {
        const error = await new Generator(new MockProvider(reply))
            .run(TEST_CASE)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(GeneratorError);
        expect(String(error)).toContain(match);
    });
});

test('rejects a test case with no statements', async () => {
    // An empty script would pass the test runner while testing nothing.
    await expect(
        new Generator(new MockProvider(script())).run(testCase(['Do nothing', []])),
    ).rejects.toThrow(/no validated statements/);
});
