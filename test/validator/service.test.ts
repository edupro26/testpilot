/** Tests for src/validator/service. */

import { expect, test } from 'vitest';

import { ValidatorError } from '../../src/exceptions.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import type { StepStatement } from '../../src/model/test-case.ts';
import { BrowserError, type ReplayBrowser } from '../../src/validator/browser.ts';
import { Validator } from '../../src/validator/service.ts';

const STEP = 'Verify the error message is visible';
const STATEMENT: StepStatement = {
    code: "await expect(page.getByText('incorrect!')).toBeVisible();",
    reason: '',
};

/** Stands in for the validation browser. */
class FakeBrowser implements ReplayBrowser {
    readonly replayed: StepStatement[][] = [];
    readonly page = {
        url: (): string => 'https://example.com/login',
        title: async (): Promise<string> => 'Login',
    };
    private readonly failure: BrowserError | undefined;

    constructor(failure?: BrowserError) {
        this.failure = failure;
    }

    async run(statements: StepStatement[]): Promise<void> {
        this.replayed.push(statements);
        if (this.failure !== undefined) {
            throw this.failure;
        }
    }
}

function verdict(isValid: boolean, reason = '', reasons: string[] = []): string {
    return JSON.stringify({ is_valid: isValid, reason, statement_reasons: reasons });
}

test('accepts proven code that tests the right thing', async () => {
    // The happy path: the code replays, and the judge sees step and code.
    // Reasons are matched to statements by position; being informational, a
    // miscount falls back to the step's reason rather than failing it.
    const click: StepStatement = {
        code: "await page.getByRole('button', { name: 'Login' }).click();",
        reason: '',
    };
    const browser = new FakeBrowser();
    let prompt = '';
    const capture = (_system: string, user: string): string => {
        prompt = user;
        return verdict(true, 'ok', ['clicks Login', 'asserts the error']);
    };

    let result = await new Validator(new MockProvider(capture), browser).run(STEP, [
        click,
        STATEMENT,
    ]);

    expect(result.isValid).toBe(true);
    expect(browser.replayed).toEqual([[click, STATEMENT]]);
    expect(result.statements.map((s) => s.code)).toEqual([click.code, STATEMENT.code]);
    expect(result.statements.map((s) => s.reason)).toEqual([
        'clicks Login',
        'asserts the error',
    ]);
    expect(prompt).toContain(STEP);
    expect(prompt).toContain(`1. ${click.code}`);
    expect(prompt).toContain(`2. ${STATEMENT.code}`);

    const miscounted = new MockProvider(
        verdict(true, 'does what the step asks', ['a', 'b']),
    );
    result = await new Validator(miscounted, new FakeBrowser()).run(STEP, [STATEMENT]);

    expect(result.isValid).toBe(true);
    expect(result.statements.map((s) => s.reason)).toEqual(['does what the step asks']);
});

test('rejects code that fails replay or tests the wrong thing', async () => {
    // Replay proves the code runs; only the judge can say it is the right code.
    // A replay failure short-circuits the judge: no semantic opinion, no tokens.
    const failure = new BrowserError(STATEMENT.code, 'Timeout 5000ms exceeded');
    const neverAsked = new MockProvider(verdict(true, 'should never be consulted'));

    let result = await new Validator(neverAsked, new FakeBrowser(failure)).run(STEP, [
        STATEMENT,
    ]);

    expect(result.isValid).toBe(false);
    expect(result.feedback).toContain('Timeout 5000ms exceeded');
    expect(result.feedback).toContain(STATEMENT.code);

    const judge = new MockProvider(
        verdict(false, 'asserts a heading, not the error message'),
    );
    result = await new Validator(judge, new FakeBrowser()).run(STEP, [STATEMENT]);

    expect(result.isValid).toBe(false);
    expect(result.feedback).toContain('heading');
    expect(result.statements).toEqual([]);
});

test('a step with no statements is trivially valid', async () => {
    // Some steps genuinely need no browser interaction.
    const browser = new FakeBrowser();

    const result = await new Validator(new MockProvider('never called'), browser).run(
        STEP,
        [],
    );

    expect(result.isValid).toBe(true);
    expect(browser.replayed).toEqual([]);
});

test('errors on an unusable verdict', async () => {
    // A malformed or wrongly shaped verdict must fail loudly, not pass silently.
    const notJson = new Validator(new MockProvider('certainly!'), new FakeBrowser());
    await expect(notJson.run(STEP, [STATEMENT])).rejects.toThrow(ValidatorError);
    await expect(notJson.run(STEP, [STATEMENT])).rejects.toThrow(/not valid JSON/);

    const wrongShape = new Validator(
        new MockProvider(JSON.stringify({ ok: true })),
        new FakeBrowser(),
    );
    await expect(wrongShape.run(STEP, [STATEMENT])).rejects.toThrow(/did not match/);
});
