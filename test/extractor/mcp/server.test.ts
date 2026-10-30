/** Tests for src/extractor/mcp: collecting, the allowlists and the client. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { emitted } from '../fakes.ts';

const CLICK = "await page.getByRole('button', { name: 'Consent' }).click();";

/** A fake MCP server offering `tools`, each reporting `CLICK` as its code. */
function fakeServer(tools: readonly string[], created: string[] = []): ServerFactory {
    return async () => {
        created.push('server');
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
        'browser_wait_for',
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

    test('reset starts a fresh server', async () => {
        const created: string[] = [];
        await using mcp = await PlaywrightMCP.connect(
            fakeServer(ALLOWED_TOOLS, created),
        );

        await mcp.reset();

        expect(created).toHaveLength(2);
        expect((await mcp.callTool('browser_click', {})).code).toEqual([CLICK]);
    });

    test('the real Playwright MCP offers every allowlisted tool', async () => {
        // Offline: the session launches its browser but never visits a site.
        await using mcp = await PlaywrightMCP.connect(playwrightServer('en-US'));

        expect(mcp.listTools().map((tool) => tool.name)).toEqual(ALLOWED_TOOLS);
    });
});
