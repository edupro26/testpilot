/** Tests for src/model/test-case. */

import { expect, test } from 'vitest';

import {
    ExecutionStepSchema,
    ModuleSchema,
    statement,
    StepStatementSchema,
    TestCaseSchema,
} from '../../src/model/test-case.ts';

const CLICK = "await page.getByRole('link', { name: 'Signup / Login' }).click();";
const ASSERT = "await expect(page.getByText('Login to your account')).toBeVisible();";

function payload(statements?: object[]): unknown {
    const step: Record<string, unknown> = { step: 'Click Signup / Login' };
    if (statements !== undefined) {
        step.statements = statements;
    }
    return {
        name: 'Login User with Incorrect Credentials',
        modules: [
            {
                url: 'https://automationexercise.com/login',
                description: 'Reach the login page',
                execution_steps: [step],
            },
        ],
    };
}

test('one schema carries the test case through every stage', () => {
    // Structured (no statements) and validated payloads share the model; the
    // validated one is persisted and re-read, so it must round-trip. A
    // statement is typed by its code, and an assertion may carry a timeout:
    // absent, it is no key at all rather than null.
    const structured = TestCaseSchema.parse(payload());
    expect(structured.modules[0]?.execution_steps[0]?.statements).toEqual([]);

    expect(statement(CLICK)).toEqual({ code: CLICK, reason: '', type: 'action' });
    const validated = TestCaseSchema.parse(
        payload([statement(CLICK), { ...statement(ASSERT), timeout: 18_000 }]),
    );
    const persisted = JSON.stringify(validated);
    expect(TestCaseSchema.parse(JSON.parse(persisted))).toEqual(validated);
    expect(validated.modules[0]?.execution_steps[0]?.statements[1]).toEqual({
        code: ASSERT,
        reason: '',
        type: 'assertion',
        timeout: 18_000,
    });
    expect(persisted.match(/"timeout"/g)).toHaveLength(1);
});

test('incomplete or inconsistent parts are rejected', () => {
    // A statement needs code, a step its text, and a module its steps; only
    // an assertion takes a timeout, as actions wait without one.
    expect(StepStatementSchema.safeParse({ reason: 'r' }).success).toBe(false);
    expect(
        StepStatementSchema.safeParse({ ...statement(CLICK), timeout: 9000 }).success,
    ).toBe(false);
    expect(ExecutionStepSchema.safeParse({ statements: [] }).success).toBe(false);
    expect(
        ModuleSchema.safeParse({ url: 'https://example.com', description: 'd' })
            .success,
    ).toBe(false);
});
