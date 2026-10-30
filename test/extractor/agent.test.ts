/** Tests for src/extractor/agent. */

import { describe, expect, test } from 'vitest';

import { ExtractorError } from '../../src/exceptions.ts';
import { StepAgent } from '../../src/extractor/agent.ts';
import { McpResult } from '../../src/extractor/mcp/server.ts';
import type { ToolUseResponse } from '../../src/llm/protocol.ts';
import { MockProvider, toolTurn } from '../../src/llm/provider/mock.ts';
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

    const statements = await new StepAgent(llm, mcp).run('Click Signup / Login', {
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

describe('rejects a statement not emitted verbatim by a collectable tool', () => {
    // The verbatim rule is enforced in code, not merely prompted.
    test.each([
        {
            id: 'never-ran',
            tool: 'browser_click',
            ran: CLICK,
            reported: 'await page.evaluate("fetch(\'/admin\')");',
            match: 'no collectable',
        },
        {
            id: 'edited',
            tool: 'browser_click',
            ran: CLICK,
            reported: "await page.getByRole('link', { name: 'Signup' }).click();",
            match: 'no collectable',
        },
        {
            id: 'widened-truncated-locator',
            tool: 'browser_verify_text_visible',
            ran: "await expect(page.getByText('Your email or password is')).toBeVisible();",
            reported:
                "await expect(page.getByText('Your email or password is incorrect!'))" +
                '.toBeVisible();',
            match: 'no collectable',
        },
        {
            id: 'non-collectable',
            tool: 'browser_evaluate',
            ran: EVALUATE,
            reported: EVALUATE,
            match: 'no collectable',
        },
        {
            id: 'does-not-parse',
            tool: 'browser_click',
            ran: 'await page.evaluate(() => {',
            reported: 'await page.evaluate(() => {',
            match: 'does not parse',
        },
    ])('$id', async ({ tool, ran, reported, match }) => {
        const mcp = new FakeMCP({ [tool]: new McpResult(false, emitted(ran)) });
        const llm = new MockProvider('', [toolTurn(tool, {}), done(reported)]);

        await expect(
            new StepAgent(llm, mcp).run('Do the step', { context: 'fresh' }),
        ).rejects.toThrow(new RegExp(match));
    });
});

test('the loop ends only through step_done', async () => {
    // step_done may report nothing; never reporting it is an error.
    const idle = new MockProvider('', [done()]);
    expect(
        await new StepAgent(idle, new FakeMCP()).run('Look', { context: 'x' }),
    ).toEqual([]);

    const looping = new MockProvider(
        '',
        Array.from({ length: 10 }, (_, i) =>
            toolTurn('browser_find', { text: 'x' }, `c${i}`),
        ),
    );
    await expect(
        new StepAgent(looping, new FakeMCP(), 3).run('Click something', {
            context: 'x',
        }),
    ).rejects.toThrow(/did not complete within/);

    const chatty = new MockProvider('', [
        { text: 'I am not sure how to proceed', toolCalls: [] },
    ]);
    const error = await new StepAgent(chatty, new FakeMCP())
        .run('Click something', { context: 'x' })
        .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractorError);
    expect(String(error)).toMatch(/stopped without calling/);
});
