/** Tests for src/extractor/mcp: collecting, the allowlists and the client. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserContext } from '@playwright/test';
import { describe, expect, test } from 'vitest';

import { McpError } from '../../../src/exceptions.ts';
import {
    ALLOWED_TOOLS,
    COLLECTABLE_TOOLS,
} from '../../../src/extractor/mcp/constants.ts';
import {
    McpResult,
    PlaywrightMCP,
    playwrightServer,
    type ServerFactory,
} from '../../../src/extractor/mcp/server.ts';
import { statement } from '../../../src/model/test-case.ts';
import { emitted } from '../fakes.ts';

const CLICK = "await page.getByRole('button', { name: 'Consent' }).click();";

/** A fake MCP server offering `tools`, each reporting `CLICK` as its code. */
function fakeServer(tools: readonly string[]): ServerFactory {
    return async () => {
        const server = new McpServer({ name: 'fake', version: '0' });
        for (const name of tools) {
            server.registerTool(name, { description: `${name} description` }, () => ({
                content: [{ type: 'text', text: emitted(CLICK) }],
                isError: name === 'browser_hover',
            }));
        }
        return server;
    };
}

test('only the reported Playwright code of a successful call is collected', () => {
    // The emitted block is the only source of truth for a statement.
    // browser_fill_form reports one line per field; a narrating comment is not a
    // statement; a failure or a findings-only result (browser_find,
    // browser_snapshot) collects nothing.
    const fill = "await page.getByLabel('Email').fill('a@b.c');";
    const tab = "await page.keyboard.press('Tab');";

    expect(new McpResult(false, emitted(fill, CLICK)).code).toEqual([fill, CLICK]);
    expect(new McpResult(false, emitted('// Press Tab', tab)).code).toEqual([tab]);
    expect(new McpResult(true, '### Error\noverlay intercepts').code).toEqual([]);
    expect(new McpResult(false, '### Result\nFound 2 matches').code).toEqual([]);
});

test('the tool allowlists', () => {
    // Only unusable tools are withheld; only standalone test lines are collected.
    // Exploration tools still drive and inspect the browser, so the agent keeps
    // them -- their code just never becomes a statement.
    expect(ALLOWED_TOOLS).not.toContain('browser_run_code_unsafe');
    expect(ALLOWED_TOOLS).not.toContain('browser_close');
    for (const name of COLLECTABLE_TOOLS) {
        expect(ALLOWED_TOOLS).toContain(name);
    }

    for (const name of [
        'browser_evaluate',
        'browser_snapshot',
        'browser_find',
        'browser_resize',
        'browser_file_upload',
        // Waits in the agent's own browser; the script's timing is measured.
        'browser_wait_for',
    ]) {
        expect(ALLOWED_TOOLS).toContain(name);
        expect(COLLECTABLE_TOOLS.has(name)).toBe(false);
    }

    for (const name of [
        'browser_navigate',
        'browser_navigate_back',
        'browser_click',
        'browser_hover',
        'browser_type',
        'browser_press_key',
        'browser_fill_form',
        'browser_select_option',
        'browser_verify_element_visible',
        'browser_verify_text_visible',
        'browser_verify_value',
        'browser_verify_list_visible',
    ]) {
        expect(COLLECTABLE_TOOLS.has(name)).toBe(true);
    }
});

describe('PlaywrightMCP', () => {
    test('exposes only the allowlisted tools and flattens their results', async () => {
        await using mcp = await PlaywrightMCP.connect(
            fakeServer([...ALLOWED_TOOLS, 'browser_run_code_unsafe', 'browser_close']),
        );

        expect(mcp.listTools().map((tool) => tool.name)).toEqual(ALLOWED_TOOLS);

        const result = await mcp.callTool('browser_click', { target: 'e1' });
        expect(result.isError).toBe(false);
        expect(result.code).toEqual([CLICK]);
        expect((await mcp.callTool('browser_hover', {})).isError).toBe(true);

        await expect(mcp.callTool('browser_run_code_unsafe', {})).rejects.toThrow(
            /not allowlisted/,
        );
    });

    test('a server missing an allowlisted tool fails with a named error', async () => {
        // The tool surface moves with each Playwright release.
        const error = await PlaywrightMCP.connect(
            fakeServer(ALLOWED_TOOLS.filter((name) => name !== 'browser_verify_value')),
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(McpError);
        expect(String(error)).toMatch(
            /missing expected tool\(s\): browser_verify_value/,
        );
    });

    test("runs statements on the session's newest page, a new session's after a reset", async () => {
        // The pipeline restores the agent's browser by running accepted code on
        // the page the agent works on: the newest (a link may open a tab), and
        // after a reset that of a fresh server.
        const contexts: FakeContext[] = [];
        await using mcp = await PlaywrightMCP.connect(fakeServerWithContext(contexts));
        const goto = statement("await page.goto('https://example.com');");

        expect(await mcp.run([goto])).toHaveLength(1);
        const tab = await contexts[0]!.newPage();
        expect(await mcp.page()).toBe(tab);
        await mcp.reset();
        await mcp.run([goto]);

        expect((await mcp.callTool('browser_click', {})).code).toEqual([CLICK]);
        expect(contexts.map((context) => context.visited)).toEqual([
            ['https://example.com'],
            ['https://example.com'],
        ]);

        await using plain = await PlaywrightMCP.connect(fakeServer(ALLOWED_TOOLS));
        await expect(plain.run([goto])).rejects.toThrow(McpError);
    });

    test('the real Playwright MCP offers every allowlisted tool, on the pipeline page', async () => {
        // Offline, on a data: page. What the pipeline runs on the page must be
        // what the agent then sees: Playwright MCP adopts the page as its tab.
        await using mcp = await PlaywrightMCP.connect(playwrightServer('en-US'));
        const page = 'data:text/html,<h1>Restored by the pipeline</h1>';

        expect(mcp.listTools().map((tool) => tool.name)).toEqual(ALLOWED_TOOLS);

        await mcp.run([statement(`await page.goto(${JSON.stringify(page)});`)]);
        const snapshot = await mcp.callTool('browser_snapshot', {});

        expect(snapshot.isError).toBe(false);
        expect(snapshot.content).toContain('Restored by the pipeline');
    });
});

/** A stand-in browser context, recording where its pages navigated. */
interface FakeContext {
    readonly visited: string[];
    pages(): object[];
    newPage(): Promise<object>;
}

/** A fake MCP server offering every tool, each with a fresh fake context. */
function fakeServerWithContext(contexts: FakeContext[]): ServerFactory {
    const plain = fakeServer(ALLOWED_TOOLS);
    return async () => {
        const visited: string[] = [];
        const pages: object[] = [];
        const context: FakeContext = {
            visited,
            pages: () => pages,
            newPage: async () => {
                const page = {
                    setDefaultTimeout: (): void => undefined,
                    goto: async (url: string): Promise<void> => {
                        visited.push(url);
                    },
                };
                pages.push(page);
                return page;
            },
        };
        contexts.push(context);
        return Object.assign(await plain(), {
            context: context as unknown as BrowserContext,
        });
    };
}
