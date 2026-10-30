/** Tests for src/generator/service. */

import { describe, expect, test } from 'vitest';

import { GeneratorError } from '../../src/exceptions.ts';
import { Generator } from '../../src/generator/service.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import type { TestCase } from '../../src/model/test-case.ts';

const CONSENT = "await page.getByRole('button', { name: 'Consent' }).click();";
const CLICK = "await page.getByRole('link', { name: 'Signup / Login' }).click();";
const ASSERT =
    "await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();";

const TEST_CASE: TestCase = {
    name: 'Login User with Incorrect Credentials',
    modules: [
        {
            url: 'https://automationexercise.com',
            description: 'Home page',
            execution_steps: [
                {
                    step: 'Navigate and open the login page',
                    statements: [
                        { code: CONSENT, reason: '' },
                        { code: CLICK, reason: '' },
                    ],
                },
                { step: 'Observe the page', statements: [] },
                {
                    step: 'Verify the login section is visible',
                    statements: [{ code: ASSERT, reason: '' }],
                },
            ],
        },
    ],
};

/** A well-formed script, as the LLM is asked to write it. */
function script(locale = 'en-US', body?: string): string {
    const steps =
        body ??
        '  // Navigate and open the login page\n' +
            `  ${CONSENT}\n` +
            `  ${CLICK}\n` +
            '\n' +
            '  // Observe the page\n' +
            '  // (no browser interaction required)\n' +
            '\n' +
            '  // Verify the login section is visible\n' +
            `  ${ASSERT}\n`;
    return (
        '/** Login with incorrect credentials. */\n' +
        '\n' +
        "import { expect, test } from '@playwright/test';\n" +
        '\n' +
        `test.use({ locale: '${locale}' });\n` +
        '\n' +
        '/** Log in with a wrong password and see the login section. */\n' +
        "test('Login with incorrect credentials', async ({ page }) => {\n" +
        steps +
        '});\n'
    );
}

test('assembles the validated steps into the LLM script', async () => {
    // The LLM gets every validated piece verbatim and its file is returned.
    // A Markdown fence around the code must not end up in the file.
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
    for (const code of [CONSENT, CLICK, ASSERT]) {
        expect(prompt).toContain(code);
    }
    expect(prompt).toContain('(no statements)');
    expect(prompt).toContain("test.use({ locale: 'pt-PT' });");
});

describe('rejects a script that is not exactly what was validated', () => {
    // What was validated, in order and under its locale, is what ships.
    test.each([
        {
            id: 'dropped-statement',
            reply: script('en-US', `  ${CONSENT}\n  ${ASSERT}\n`),
            match: 'Signup / Login',
        },
        {
            id: 'altered-statement',
            reply: script(
                'en-US',
                `  ${CONSENT}\n` +
                    `  ${CLICK.replace('.click()', '.click({ force: true })')}\n` +
                    `  ${ASSERT}\n`,
            ),
            match: 'altered',
        },
        {
            id: 'reordered-statements',
            reply: script('en-US', `  ${CLICK}\n  ${CONSENT}\n  ${ASSERT}\n`),
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
    const empty: TestCase = {
        name: 'Empty',
        modules: [
            {
                url: 'https://example.com',
                description: 'd',
                execution_steps: [{ step: 'Do nothing', statements: [] }],
            },
        ],
    };

    await expect(new Generator(new MockProvider(script())).run(empty)).rejects.toThrow(
        /no validated statements/,
    );
});
