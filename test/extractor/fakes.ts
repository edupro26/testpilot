/** Offline test doubles for the Playwright MCP connection. */

import { ALLOWED_TOOLS } from '../../src/extractor/mcp/constants.ts';
import {
    type McpConnection,
    McpResult,
    type McpTool,
} from '../../src/extractor/mcp/server.ts';

/**
 * Build a successful MCP result body reporting `lines` as the code it ran.
 *
 * @param lines - The code lines, as TypeScript codegen reports them.
 * @returns The tool result's text content.
 */
export function emitted(...lines: string[]): string {
    return (
        `### Ran Playwright code\n\`\`\`js\n${lines.join('\n')}\n\`\`\`\n` +
        '### Page\n- Page URL: /'
    );
}

/** Stands in for `PlaywrightMCP`, replaying scripted tool results. */
export class FakeMCP implements McpConnection {
    readonly calls: [string, Record<string, unknown>][] = [];
    private readonly results: Record<string, McpResult>;

    /**
     * Initialize with a per-tool-name result map.
     *
     * @param results - Result returned for each tool name. A tool with no entry
     *   returns an empty successful result.
     */
    constructor(results: Record<string, McpResult> = {}) {
        this.results = results;
    }

    /**
     * Return a stub definition for every allowlisted tool.
     *
     * @returns One definition per tool in `ALLOWED_TOOLS`, with an empty schema.
     */
    listTools(): McpTool[] {
        return ALLOWED_TOOLS.map((name) => ({
            name,
            description: `${name} description`,
            inputSchema: {},
        }));
    }

    /**
     * Record the call and return its scripted result.
     *
     * @param name - The tool to call.
     * @param args - The call's arguments.
     * @returns The result scripted for `name`; an empty success if none is.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
        this.calls.push([name, args]);
        return this.results[name] ?? new McpResult(false, '### Result\nDone');
    }
}
