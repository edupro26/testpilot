/** Tests for src/model/test-case. */

import { expect, test } from 'vitest';

import {
    ExecutionStepSchema,
    ModuleSchema,
    StepStatementSchema,
    TestCaseSchema,
} from '../../src/model/test-case.ts';

const CONSENT = "await page.getByRole('button', { name: 'Consent' }).click();";
const CLICK = "await page.getByRole('link', { name: 'Signup / Login' }).click();";

function payload(statements?: { code: string }[]): unknown {
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
    // Structured (no statements) and validated payloads share the model.
    // The validated one is persisted and re-read, so it must round-trip.
    const structured = TestCaseSchema.parse(payload());
    expect(structured.modules[0]?.execution_steps[0]?.statements).toEqual([]);

    const validated = TestCaseSchema.parse(
        payload([{ code: CONSENT }, { code: CLICK }]),
    );
    const statements = validated.modules[0]?.execution_steps[0]?.statements ?? [];
    expect(statements.map((s) => s.code)).toEqual([CONSENT, CLICK]);
    expect(statements[0]?.reason).toBe('');

    expect(TestCaseSchema.parse(JSON.parse(JSON.stringify(validated)))).toEqual(
        validated,
    );
});

test('incomplete parts are rejected', () => {
    // A statement needs code, a step its text, and a module its steps.
    expect(StepStatementSchema.safeParse({ reason: 'r' }).success).toBe(false);
    expect(ExecutionStepSchema.safeParse({ statements: [] }).success).toBe(false);
    expect(
        ModuleSchema.safeParse({ url: 'https://example.com', description: 'd' })
            .success,
    ).toBe(false);
});
