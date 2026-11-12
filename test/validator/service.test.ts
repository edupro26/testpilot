/** Tests for src/validator/service. */

import { expect, test } from 'vitest';

import { MockProvider } from '../../src/llm/provider/mock.ts';
import {
    type ExecutionStep,
    statement,
    type StepStatement,
    type TestCase,
} from '../../src/model/test-case.ts';
import { ValidatorError } from '../../src/runtime/exceptions.ts';
import { BrowserError, type ReplayBrowser } from '../../src/validator/browser.ts';
import { Validator } from '../../src/validator/service.ts';

const STEP = 'Verify the error message is visible';
const STATEMENT = statement(
    "await expect(page.getByText('incorrect!')).toBeVisible();",
);
const GOTO = statement("await page.goto('https://example.com/login');");
const CLICK = statement("await page.getByRole('button', { name: 'Login' }).click();");

/** The agent's page, as the judge is shown it. */
const PAGE = {
    url: (): string => 'https://example.com/login',
    title: async (): Promise<string> => 'Login',
};

/** Stands in for the validation browser: scripted timings, or a failure. */
class FakeBrowser implements ReplayBrowser {
    /** Every reset, and the code of every run, in order. */
    readonly calls: ('reset' | string[])[] = [];
    private readonly durations: number[];
    private readonly failure: BrowserError | undefined;

    constructor({
        durations = [],
        failure,
    }: { durations?: number[]; failure?: BrowserError } = {}) {
        this.durations = durations;
        this.failure = failure;
    }

    async run(statements: StepStatement[]): Promise<number[]> {
        this.calls.push(statements.map((s) => s.code));
        if (this.failure !== undefined) {
            throw this.failure;
        }
        return statements.map((_, index) => this.durations[index] ?? 0);
    }

    async reset(): Promise<void> {
        this.calls.push('reset');
    }
}

function testCase(...modules: ExecutionStep[][]): TestCase {
    return {
        name: 'Login',
        modules: modules.map((steps, index) => ({
            url: `https://example.com/${index}`,
            description: `module ${index}`,
            execution_steps: steps,
        })),
    };
}

function verdict(isValid: boolean, reason = '', reasons: string[] = []): string {
    return JSON.stringify({ is_valid: isValid, reason, statement_reasons: reasons });
}

/** Every statement's timeout, in run order. */
function timeouts(validated: TestCase): (number | undefined)[] {
    return validated.modules.flatMap((module) =>
        module.execution_steps.flatMap((step) => step.statements.map((s) => s.timeout)),
    );
}

test('assigns measured timeouts to late assertions only', async () => {
    // The whole script replays once, back to back, as it will run. An
    // assertion that needed more than Playwright's 5s default gets twice what
    // it took, in whole seconds; actions never get one, however long they took.
    // A larger timeout from an earlier round stays: the page can be that slow.
    const late = statement("await expect(page.getByText('Produtos')).toBeVisible();");
    const quick = statement("await expect(page.getByText('Móvel')).toBeVisible();");
    const close = statement("await expect(page.getByText('Aderir')).toBeVisible();");
    const slower = { ...STATEMENT, timeout: 20_000 };
    const browser = new FakeBrowser({
        durations: [12_000, 9_000, 2_000, 2_600, 9_000],
    });
    const validator = new Validator(new MockProvider(''), browser);

    const result = await validator.validate(
        testCase([
            { step: 'Open the products', statements: [CLICK] },
            { step: 'See them', statements: [late] },
            { step: 'See the options', statements: [quick, close] },
            { step: STEP, statements: [slower] },
        ]),
    );

    expect(result.ok).toBe(true);
    expect(timeouts(result.testCase)).toEqual([
        undefined,
        18_000,
        undefined,
        6_000,
        20_000,
    ]);
    expect(browser.calls).toEqual([
        'reset',
        [CLICK.code, late.code, quick.code, close.code, slower.code],
    ]);
});

test('a failure names its step and the statements of that step that ran first', async () => {
    // Positions in the whole script map back to steps past an empty step;
    // what ran before the failure is still measured.
    const late = statement("await expect(page.getByText('Morada')).toBeVisible();");
    const confirm = statement(
        "await page.getByRole('button', { name: 'Confirmar' }).click();",
    );
    const failure = new BrowserError(
        confirm.code,
        'Timeout 30000ms exceeded',
        [100, 9_000],
    );
    const validator = new Validator(new MockProvider(''), new FakeBrowser({ failure }));

    const result = await validator.validate(
        testCase(
            [
                { step: 'Open the page', statements: [GOTO] },
                { step: 'Observe the page', statements: [] },
                { step: 'Confirm the address', statements: [late, confirm] },
            ],
            [{ step: STEP, statements: [STATEMENT] }],
        ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
        return;
    }
    expect(result.failure.ref).toEqual({ module: 0, step: 2 });
    expect(result.failure.feedback).toContain(confirm.code);
    expect(result.failure.feedback).toContain('Timeout 30000ms exceeded');
    expect(result.failure.feedback).toContain(
        `ran first, without error:\n${late.code}`,
    );
    expect(result.failure.feedback).not.toContain(GOTO.code);
    expect(timeouts(result.testCase)).toEqual([
        undefined,
        18_000,
        undefined,
        undefined,
    ]);
});

test("judges whether the code tests the right thing, on the agent's page", async () => {
    // Running proves the code works; only the judge can say it is the right
    // code. Reasons are matched to statements by position; being
    // informational, a miscount falls back to the step's reason.
    let prompt = '';
    const capture = (_system: string, user: string): string => {
        prompt = user;
        return verdict(true, 'ok', ['asserts the error']);
    };
    const agentPage = {
        url: (): string => 'https://example.com/agent',
        title: async (): Promise<string> => 'Agent',
    };

    let result = await new Validator(
        new MockProvider(capture),
        new FakeBrowser(),
    ).judge(STEP, [STATEMENT], agentPage);

    expect(result.isValid).toBe(true);
    expect(result.statements).toEqual([{ ...STATEMENT, reason: 'asserts the error' }]);
    expect(prompt).toContain(STEP);
    expect(prompt).toContain(`1. ${STATEMENT.code}`);
    expect(prompt).toContain('https://example.com/agent');

    const miscounted = new MockProvider(
        verdict(true, 'does what the step asks', ['a', 'b']),
    );
    result = await new Validator(miscounted, new FakeBrowser()).judge(
        STEP,
        [STATEMENT],
        PAGE,
    );

    expect(result.statements.map((s) => s.reason)).toEqual(['does what the step asks']);

    const judge = new MockProvider(
        verdict(false, 'asserts a heading, not the error message'),
    );
    result = await new Validator(judge, new FakeBrowser()).judge(
        STEP,
        [STATEMENT],
        PAGE,
    );

    expect(result.isValid).toBe(false);
    expect(result.feedback).toContain('heading');
    expect(result.statements).toEqual([]);
});

test('no statements replay trivially', async () => {
    // Some steps genuinely need no browser interaction.
    const browser = new FakeBrowser();
    const validator = new Validator(new MockProvider('never called'), browser);

    const result = await validator.validate(
        testCase([{ step: 'Observe the page', statements: [] }]),
    );

    expect(result).toMatchObject({ ok: true, runTimeMs: 0 });
    expect(browser.calls).toEqual([]);
});

test('a step with no statements is still judged', async () => {
    // Only the judge can tell a step that needs nothing from a verification
    // whose check went missing.
    let prompt = '';
    const judge = new MockProvider((_system, user) => {
        prompt = user;
        return verdict(false, 'the step asks to verify a message; nothing checks it');
    });

    const result = await new Validator(judge, new FakeBrowser()).judge(STEP, [], PAGE);

    expect(result.isValid).toBe(false);
    expect(prompt).toContain('(no statements)');
});

test('errors on an unusable verdict', async () => {
    // A malformed or wrongly shaped verdict must fail loudly, not pass silently.
    const notJson = new Validator(new MockProvider('certainly!'), new FakeBrowser());
    await expect(notJson.judge(STEP, [STATEMENT], PAGE)).rejects.toThrow(
        ValidatorError,
    );
    await expect(notJson.judge(STEP, [STATEMENT], PAGE)).rejects.toThrow(
        /not valid JSON/,
    );

    const wrongShape = new Validator(
        new MockProvider(JSON.stringify({ ok: true })),
        new FakeBrowser(),
    );
    await expect(wrongShape.judge(STEP, [STATEMENT], PAGE)).rejects.toThrow(
        /did not match/,
    );
    await expect(wrongShape.judge(STEP, [STATEMENT], PAGE)).rejects.toMatchObject({
        code: 'LLM_RESPONSE_INVALID',
    });
});
