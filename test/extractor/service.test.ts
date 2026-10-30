/** Tests for src/extractor/service. */

import { expect, test } from 'vitest';

import { McpResult } from '../../src/extractor/mcp/server.ts';
import { Extractor } from '../../src/extractor/service.ts';
import { MockProvider, toolTurn } from '../../src/llm/provider/mock.ts';
import type { Module } from '../../src/model/test-case.ts';
import { emitted, FakeMCP } from './fakes.ts';

const CLICK = "await page.getByRole('link', { name: 'Signup / Login' }).click();";

const MODULE: Module = {
    url: 'https://automationexercise.com/login',
    description: 'Login page',
    execution_steps: [
        { step: 'Click Signup / Login', statements: [] },
        { step: 'Verify the login section is visible', statements: [] },
    ],
};

/** Run one step against a fake that clicks; return the agent's prompt. */
async function runStep(
    index: number,
    history: string[],
    resetTo?: string,
): Promise<string> {
    const mcp = new FakeMCP({ browser_click: new McpResult(false, emitted(CLICK)) });
    const llm = new MockProvider('', [
        toolTurn('browser_click', { element: 'link', target: 'e1' }),
        toolTurn('step_done', { statements: [{ code: CLICK }] }, 'c2'),
    ]);

    const statements = await new Extractor(llm, mcp).runStep(MODULE, index, {
        history,
        ...(resetTo === undefined ? {} : { resetTo }),
    });

    expect(statements.map((s) => s.code)).toEqual([CLICK]);
    return llm.conversations[0]!.userPrompt;
}

test('each step is briefed on its text and the browser state', async () => {
    // The agent drives one step and must know what the browser already shows.
    // The first step starts on a blank page; a later step continues from live
    // state; a retry after a reset only keeps the URL, so setup must be redone.
    const first = await runStep(0, []);
    expect(first).toContain('Click Signup / Login');
    expect(first).toContain('blank page');
    expect(first).toContain(MODULE.url);

    const later = await runStep(1, [CLICK]);
    expect(later).toContain('Verify the login section is visible');
    expect(later).toContain(CLICK);
    expect(later).toContain('Do not repeat');

    const retry = await runStep(1, [CLICK], 'https://example.com/x');
    expect(retry).toContain('fresh session');
    expect(retry).toContain('https://example.com/x');
    expect(retry).toContain(CLICK);
    expect(retry).toContain('WITHOUT reporting');
    expect(retry).not.toContain('Do not repeat');
});
