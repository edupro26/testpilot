/** Tests for src/extractor/agent. */

import { describe, expect, test } from 'vitest';

import { StepAgent, type StepResult } from '../../src/extractor/agent.ts';
import { McpResult } from '../../src/extractor/mcp/server.ts';
import type { ToolUseResponse } from '../../src/llm/protocol.ts';
import { MockProvider, toolTurn } from '../../src/llm/provider/mock.ts';
import { statement, type StepStatement } from '../../src/model/test-case.ts';
import { ExtractorError } from '../../src/runtime/exceptions.ts';
import { emitted, FakeMCP } from './fakes.ts';

const CLICK = "await page.getByRole('link', { name: 'Signup / Login' }).click();";
const CONSENT = "await page.getByRole('button', { name: 'Consent' }).click();";
const EVALUATE = "await page.evaluate('() => document.title');";

/** Build a step_done turn reporting `codes` as the step's statements. */
function done(...codes: string[]): ToolUseResponse {
    return toolTurn(
        'step_done',
        { statements: codes.map((code) => ({ code })) },
        'done',
    );
}

/** Returns the given results in call order, whatever the tool. */
class SequencedMCP extends FakeMCP {
    private readonly sequence: McpResult[];

    constructor(...results: McpResult[]) {
        super();
        this.sequence = results;
    }

    override async callTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<McpResult> {
        this.calls.push([name, args]);
        const result = this.sequence.shift();
        if (result === undefined) {
            throw new Error('no more scripted results');
        }
        return result;
    }
}

test('drives the browser, recovers and collects what MCP ran', async () => {
    // The overlay case, on a retry, with a non-collectable tool in the mix.
    // A failed click, a dismissal, then a successful retry: both successful
    // actions are collected. An exploration tool stays callable even though its
    // code can never become a statement, and the retry feedback reaches the model.
    const mcp = new SequencedMCP(
        new McpResult(false, emitted(EVALUATE)),
        new McpResult(true, '### Error\noverlay intercepts pointer'),
        new McpResult(false, emitted(CONSENT)),
        new McpResult(false, emitted(CLICK)),
    );
    const llm = new MockProvider('', [
        toolTurn('browser_evaluate', { function: '() => document.title' }),
        toolTurn('browser_click', { element: 'link', target: 'e1' }),
        toolTurn('browser_click', { element: 'consent', target: 'e2' }),
        toolTurn('browser_click', { element: 'link', target: 'e1' }),
        done(CONSENT, CLICK),
    ]);

    const { statements } = await new StepAgent(llm, mcp).run('Click Signup / Login', {
        context: 'fresh',
        feedback: 'clicked the wrong link',
    });

    expect(statements.map((s) => s.code)).toEqual([CONSENT, CLICK]);
    expect(mcp.calls.map(([name]) => name)).toEqual([
        'browser_evaluate',
        'browser_click',
        'browser_click',
        'browser_click',
    ]);
    const conversation = llm.conversations[0]!;
    expect(conversation.userPrompt).toContain('clicked the wrong link');
    const tools = new Set(conversation.tools.map((tool) => tool.name));
    expect(tools).toContain('step_done');
    expect(tools).toContain('browser_verify_element_visible');
    expect(tools).not.toContain('browser_run_code_unsafe');
});

test('a call to a tool it was not given goes back to the agent', async () => {
    // A made-up or withheld tool is answered with an error the model can act
    // on, rather than ending the run, and never reaches MCP.
    const mcp = new SequencedMCP(new McpResult(false, emitted(CLICK)));
    const llm = new MockProvider('', [
        toolTurn('browser_close', {}),
        toolTurn('browser_click', { element: 'link', target: 'e1' }),
        done(CLICK),
    ]);

    const { statements } = await new StepAgent(llm, mcp).run('Click Signup / Login', {
        context: 'fresh',
    });

    expect(statements.map((s) => s.code)).toEqual([CLICK]);
    expect(mcp.calls.map(([name]) => name)).toEqual(['browser_click']);
    const [reply] = llm.conversations[0]!.sent[1]!;
    expect(reply).toMatchObject({ id: 'call-1', isError: true });
    expect(reply?.content).toContain('browser_close');
});

test('a rejected report goes back to the agent, until its repairs run out', async () => {
    // The agent fixes the step on its still-live page, in the same
    // conversation. Past its repairs, the step is handed back rejected, to be
    // re-extracted from a restored browser instead.
    const llm = new MockProvider('', [
        toolTurn('browser_click', {}),
        done(CLICK),
        done(CLICK),
        done(CLICK),
    ]);
    const mcp = new FakeMCP({ browser_click: new McpResult(false, emitted(CLICK)) });
    let checks = 0;
    const check = async (statements: StepStatement[]): Promise<StepResult> => {
        checks++;
        return { statements, rejection: 'clicks the wrong link' };
    };

    const result = await new StepAgent(llm, mcp).run('Click Signup / Login', {
        context: 'x',
        check,
    });

    expect(result).toEqual({
        statements: [statement(CLICK)],
        rejection: 'clicks the wrong link',
    });
    expect(checks).toBe(3);
    const repair = llm.conversations[0]!.sent[2]![0]!;
    expect(repair.isError).toBe(true);
    expect(repair.content).toContain('clicks the wrong link');
});

test('a reported wait is left out of the script', async () => {
    // The pipeline measures the script's timing itself, so a wait the agent
    // reports is dropped, not fatal. A report of nothing but waits goes back
    // before the judge sees it: it would pass as needing no interaction.
    const verify = "await expect(page.getByText('Produtos WOO')).toBeVisible();";
    const wait =
        'await page.getByText("Produtos WOO").first().waitFor({ state: \'visible\' });';
    const mcp = new SequencedMCP(
        new McpResult(false, emitted(wait)),
        new McpResult(false, emitted(verify)),
    );
    const llm = new MockProvider('', [
        toolTurn('browser_wait_for', { text: 'Produtos WOO', time: 30 }),
        done(wait),
        toolTurn('browser_verify_text_visible', { text: 'Produtos WOO' }),
        done(wait, verify),
    ]);
    const checked: string[][] = [];
    const check = async (statements: StepStatement[]): Promise<StepResult> => {
        checked.push(statements.map((s) => s.code));
        return { statements: statements.map((s) => ({ ...s, reason: 'shows it' })) };
    };

    const result = await new StepAgent(llm, mcp).run('Verify Produtos WOO', {
        context: 'x',
        check,
    });

    expect(result).toEqual({
        statements: [{ ...statement(verify), reason: 'shows it' }],
    });
    expect(checked).toEqual([[verify]]);
    const repair = llm.conversations[0]!.sent[2]![0]!;
    expect(repair.isError).toBe(true);
    expect(repair.content).toContain('browser_verify_');
});

describe('rejects a statement not emitted verbatim by a collectable tool', () => {
    // The verbatim rule is enforced in code, not merely prompted.
    test.each([
        {
            id: 'never-ran',
            tool: 'browser_click',
            ran: CLICK,
            reported: 'await page.evaluate("fetch(\'/admin\')");',
            match: 'no collectable',
            code: 'STEP_REPORT_INVALID',
        },
        {
            id: 'edited',
            tool: 'browser_click',
            ran: CLICK,
            reported: "await page.getByRole('link', { name: 'Signup' }).click();",
            match: 'no collectable',
            code: 'STEP_REPORT_INVALID',
        },
        {
            id: 'widened-truncated-locator',
            tool: 'browser_verify_text_visible',
            ran: "await expect(page.getByText('Your email or password is')).toBeVisible();",
            reported:
                "await expect(page.getByText('Your email or password is incorrect!'))" +
                '.toBeVisible();',
            match: 'no collectable',
            code: 'STEP_REPORT_INVALID',
        },
        {
            id: 'non-collectable',
            tool: 'browser_evaluate',
            ran: EVALUATE,
            reported: EVALUATE,
            match: 'no collectable',
            code: 'STEP_REPORT_INVALID',
        },
        {
            id: 'does-not-parse',
            tool: 'browser_click',
            ran: 'await page.evaluate(() => {',
            reported: 'await page.evaluate(() => {',
            match: 'does not parse',
            code: 'INTERNAL_ERROR',
        },
    ])('$id', async ({ tool, ran, reported, match, code }) => {
        const mcp = new FakeMCP({ [tool]: new McpResult(false, emitted(ran)) });
        const llm = new MockProvider('', [toolTurn(tool, {}), done(reported)]);

        const error = await new StepAgent(llm, mcp)
            .run('Do the step', { context: 'fresh' })
            .catch((e: unknown) => e);
        expect(String(error)).toMatch(new RegExp(match));
        expect((error as ExtractorError).code).toBe(code);
    });
});

test('the loop ends only through step_done', async () => {
    // step_done may report nothing; never reporting it is an error.
    const idle = new MockProvider('', [done()]);
    expect(
        await new StepAgent(idle, new FakeMCP()).run('Look', { context: 'x' }),
    ).toEqual({ statements: [] });

    const looping = new MockProvider(
        '',
        Array.from({ length: 10 }, (_, i) =>
            toolTurn('browser_find', { text: 'x' }, `c${i}`),
        ),
    );
    const spent = await new StepAgent(looping, new FakeMCP(), 3)
        .run('Click something', { context: 'x' })
        .catch((e: unknown) => e);
    expect(String(spent)).toMatch(/did not complete within/);
    expect((spent as ExtractorError).code).toBe('STEP_OUT_OF_TURNS');

    const chatty = new MockProvider('', [
        { text: 'I am not sure how to proceed', toolCalls: [] },
    ]);
    const error = await new StepAgent(chatty, new FakeMCP())
        .run('Click something', { context: 'x' })
        .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractorError);
    expect(String(error)).toMatch(/stopped without calling/);
    expect((error as ExtractorError).code).toBe('STEP_ABANDONED');
});
