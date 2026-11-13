/**
 * Playwright MCP client: runs the server in-process and talks to it in memory.
 *
 * There is no separate server to start: each session creates its own server
 * and browser, and connects to the server over an in-memory transport.
 */

import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createConnection } from '@playwright/mcp';
import type { BrowserContext, Page } from '@playwright/test';

import { CONFIG_DIR, findProjectRoot } from '../../config.ts';
import { logger } from '../../logger.ts';
import type { StepStatement } from '../../model/test-case.ts';
import { errorMessage, McpError } from '../../runtime/exceptions.ts';
import { launchChromium, runStatements } from '../../validator/browser.ts';
import {
    ALLOWED_TOOLS,
    CALL_TIMEOUT_MS,
    CODE_BLOCK,
    CONNECT_TIMEOUT_MS,
} from './constants.ts';

/** Playwright MCP's configuration, as `createConnection` takes it. */
export type McpConfig = NonNullable<Parameters<typeof createConnection>[0]>;

/**
 * The server side of a session, typed structurally: `@playwright/mcp` builds
 * on the SDK's CommonJS build, this module on its ESM build.
 */
export interface McpServer {
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    /** The browser context the server drives, when the pipeline owns it. */
    readonly context?: BrowserContext;
}

/** Creates a fresh, unconnected MCP server; called once per session. */
export type ServerFactory = () => Promise<McpServer>;

/** A tool offered by the MCP server, in the provider-neutral shape. */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/** What the agent loop needs from an MCP connection. */
export interface McpConnection {
    /** The allowlisted tools, in the provider-neutral shape. */
    listTools(): McpTool[];
    /** Invoke an allowlisted tool and wait for its result. */
    callTool(name: string, args: Record<string, unknown>): Promise<McpResult>;
}

/** The outcome of one MCP tool call. */
export class McpResult {
    readonly isError: boolean;
    readonly content: string;

    /**
     * Wrap a flattened tool result.
     *
     * @param isError - Whether the tool reported a failure.
     * @param content - The result's text content.
     */
    constructor(isError: boolean, content: string) {
        this.isError = isError;
        this.content = content;
    }

    /**
     * The Playwright statements this call ran; empty for a failed call.
     *
     * Comment lines (`// Press Tab`) are narration, not statements.
     */
    get code(): string[] {
        const match = CODE_BLOCK.exec(this.content);
        if (match?.[1] === undefined) {
            return [];
        }
        return match[1].split('\n').filter((line) => {
            const trimmed = line.trim();
            return trimmed !== '' && !trimmed.startsWith('//');
        });
    }
}

/**
 * The Playwright MCP configuration the pipeline relies on.
 *
 * The browser itself is not configured here: `playwrightServer` hands each
 * session a context of its own.
 *
 * @param root - The project root; Playwright MCP's own output (page snapshots,
 *   console logs) goes to `.testpilot/.playwright-mcp` under it, wherever the
 *   command runs from.
 * @returns The server configuration.
 */
export function mcpConfig(root: string): McpConfig {
    return {
        // Use the context the session is given rather than open another one.
        browser: { isolated: false },
        // Adds the browser_verify_* assertion tools.
        capabilities: ['testing'],
        // Every tool result reports the TypeScript it ran: the code we collect.
        codegen: 'typescript',
        // Absolute: Playwright MCP resolves a relative one against the working
        // directory, which may be a project subfolder.
        outputDir: path.join(root, CONFIG_DIR, '.playwright-mcp'),
    };
}

/**
 * The factory for the real, in-process Playwright MCP server.
 *
 * Each session gets a freshly launched browser, so it starts with an empty
 * profile: consent banners reappear every run, and the retry reset forgets
 * the failed attempt. The browser is owned here, not by Playwright MCP,
 * whose server leaves a browser it launched running when it closes.
 *
 * @param locale - The browser locale (`Accept-Language`); the same one is used
 *   by the validation browser and pinned into the generated script.
 * @param options - `headed` opens the browser in a window, to watch the agent;
 *   headless by default. `root` is the project root (see `mcpConfig`); the
 *   nearest folder with a `package.json` by default.
 * @returns A factory creating one server per session.
 */
export function playwrightServer(
    locale: string,
    options: { headed?: boolean; root?: string } = {},
): ServerFactory {
    const config = mcpConfig(options.root ?? findProjectRoot());
    return async () => {
        const browser = await launchChromium(options.headed !== true);
        try {
            const context = await browser.newContext({ locale });
            const server = await createConnection(config, () =>
                Promise.resolve(context),
            );
            return {
                // Playwright MCP adopts the context's pages as its tabs, so a
                // page the pipeline drives is the agent's page too.
                context,
                connect: (transport) => server.connect(transport),
                close: async () => {
                    try {
                        await server.close();
                    } finally {
                        await browser.close();
                    }
                },
            };
        } catch (error) {
            await browser.close();
            throw error;
        }
    };
}

interface Session {
    client: Client;
    server: McpServer;
}

/** Client for an in-process Playwright MCP server. */
export class PlaywrightMCP implements McpConnection, AsyncDisposable {
    readonly tools: McpTool[];
    private readonly createServer: ServerFactory;
    private session: Session | undefined;

    private constructor(
        createServer: ServerFactory,
        session: Session,
        tools: McpTool[],
    ) {
        this.createServer = createServer;
        this.session = session;
        this.tools = tools;
    }

    /**
     * Start a Playwright MCP server and connect to it.
     *
     * @param createServer - Creates the server; `playwrightServer()` in
     *   production, a fake in tests.
     * @returns The connected client.
     * @throws {McpError} If the server cannot be started, or does not offer
     *   every tool in `ALLOWED_TOOLS`.
     */
    static async connect(createServer: ServerFactory): Promise<PlaywrightMCP> {
        logger.info('Starting Playwright MCP');
        const session = await openSession(createServer);
        let tools: McpTool[];
        try {
            tools = await resolveTools(session.client);
        } catch (error) {
            await closeSession(session);
            throw error;
        }
        logger.info(`Connected to Playwright MCP (${tools.length} tool(s) available)`);
        return new PlaywrightMCP(createServer, session, tools);
    }

    /**
     * Return the allowlisted tools, resolved at connection time.
     *
     * @returns The tools, in allowlist order.
     */
    listTools(): McpTool[] {
        return this.tools;
    }

    /**
     * Invoke an allowlisted MCP tool and wait for its result.
     *
     * @param name - The tool to call.
     * @param args - The call's arguments.
     * @returns The call's outcome, including any Playwright code it ran.
     * @throws {McpError} If `name` is not allowlisted, or the call fails at
     *   the transport level.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
        if (!ALLOWED_TOOLS.includes(name)) {
            throw new McpError(`Tool ${JSON.stringify(name)} is not allowlisted`, {
                code: 'BROWSER_AGENT_FAILED',
            });
        }
        if (this.session === undefined) {
            throw new McpError('MCP session is not connected', {
                code: 'BROWSER_AGENT_FAILED',
            });
        }
        logger.debug(`MCP call ${name} ${JSON.stringify(args)}`);

        let raw: Awaited<ReturnType<Client['callTool']>>;
        try {
            raw = await this.session.client.callTool(
                { name, arguments: args },
                undefined,
                {
                    timeout: CALL_TIMEOUT_MS,
                },
            );
        } catch (error) {
            throw new McpError(
                `MCP call ${JSON.stringify(name)} failed: ${errorMessage(error)}`,
                { code: 'BROWSER_AGENT_FAILED', cause: error },
            );
        }

        const blocks = (Array.isArray(raw.content) ? raw.content : []) as {
            type: string;
            text?: string;
        }[];
        const content = blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n');
        const result = new McpResult(raw.isError === true, content);
        logger.debug(
            `MCP result (is_error=${result.isError}, ${result.content.length} chars)`,
        );
        return result;
    }

    /**
     * Reconnect to a fresh server, discarding all browser state.
     *
     * The server is `isolated`, so the new session gets a fresh profile that
     * has forgotten the failed attempt, cookies included.
     *
     * @throws {McpError} If the new server cannot be started.
     */
    async reset(): Promise<void> {
        logger.info('Resetting the Playwright MCP session');
        await this.close();
        try {
            this.session = await openSession(this.createServer);
        } catch (error) {
            throw new McpError(
                `Could not reconnect to Playwright MCP: ${errorMessage(error)}`,
                { code: 'BROWSER_AGENT_FAILED', cause: error },
            );
        }
    }

    /**
     * The agent's page: the tab Playwright MCP has selected, opened if there
     * is none. A popup is a newer page, but not the agent's until it selects it.
     *
     * @returns The selected tab's page; the newest page, or a new one, if no tab
     *   is marked selected.
     * @throws {McpError} If the session's server exposes no browser context.
     */
    async page(): Promise<Page> {
        const context = this.session?.server.context;
        if (context === undefined) {
            throw new McpError(
                'The MCP session exposes no browser context to run statements on',
                { code: 'BROWSER_AGENT_FAILED' },
            );
        }
        const pages = context.pages();
        if (pages.length > 1) {
            // MCP lists its tabs in the context's page order, marking the
            // selected one "- 1: (current) [title](url)".
            const tabs = await this.callTool('browser_tabs', { action: 'list' });
            const current = /^- (\d+): \(current\)/m.exec(tabs.content)?.[1];
            const selected = pages[Number(current)];
            if (selected !== undefined) {
                return selected;
            }
        }
        return pages.at(-1) ?? (await context.newPage());
    }

    /**
     * Run accepted statements on the agent's page, as the replay does, to
     * restore the state a step starts from.
     *
     * @param statements - The statements to run, in order.
     * @returns How long each statement took, in ms.
     * @throws {BrowserError} If a statement fails on the page.
     */
    async run(statements: StepStatement[]): Promise<number[]> {
        return runStatements(await this.page(), statements);
    }

    /** Shut the session and its browser down. */
    async close(): Promise<void> {
        if (this.session === undefined) {
            return;
        }
        const session = this.session;
        this.session = undefined;
        await closeSession(session);
        logger.info('Disconnected from Playwright MCP');
    }

    /** Close the connection when leaving an `await using` block. */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

/**
 * Create a server and connect a client to it in memory.
 *
 * A session that fails to connect is closed, server and browser included,
 * before the error is thrown: nothing else holds it to close it later.
 *
 * @throws {McpError} If either side fails to start.
 */
async function openSession(createServer: ServerFactory): Promise<Session> {
    let session: Session | undefined;
    try {
        const server = await createServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        session = {
            client: new Client({ name: 'testpilot', version: '0.1.0' }),
            server,
        };
        await server.connect(serverTransport);
        await session.client.connect(clientTransport, { timeout: CONNECT_TIMEOUT_MS });
        return session;
    } catch (error) {
        if (session !== undefined) {
            // The connection's failure is the error to report, not the close's.
            await closeSession(session).catch((closeError: unknown) => {
                logger.warning(
                    `Could not close the failed Playwright MCP session: ` +
                        errorMessage(closeError),
                );
            });
        }
        throw new McpError(`Could not start Playwright MCP: ${errorMessage(error)}`, {
            code: 'BROWSER_AGENT_FAILED',
            cause: error,
        });
    }
}

/** Close the client, then the server and its browser, even if the client fails to. */
async function closeSession({ client, server }: Session): Promise<void> {
    try {
        await client.close();
    } finally {
        await server.close();
    }
}

/**
 * Return the allowlisted tools, failing loudly if any is missing.
 *
 * The tool surface moves with each Playwright release, so this turns an
 * upstream rename into a named error rather than a quietly degraded agent.
 *
 * @throws {McpError} If the tools cannot be listed, or the server does not
 *   offer every allowlisted tool.
 */
async function resolveTools(client: Client): Promise<McpTool[]> {
    let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
    try {
        ({ tools } = await client.listTools(undefined, {
            timeout: CONNECT_TIMEOUT_MS,
        }));
    } catch (error) {
        throw new McpError(
            `Could not list Playwright MCP's tools: ${errorMessage(error)}`,
            { code: 'BROWSER_AGENT_FAILED', cause: error },
        );
    }
    const offered = new Map(tools.map((tool) => [tool.name, tool]));
    const missing = ALLOWED_TOOLS.filter((name) => !offered.has(name));
    if (missing.length > 0) {
        throw new McpError(
            `Playwright MCP is missing expected tool(s): ${missing.join(', ')}. ` +
                'Was the installed @playwright/mcp upgraded, or the testing ' +
                'capability dropped from its config? It offered: ' +
                [...offered.keys()].sort().join(', '),
            { code: 'BROWSER_AGENT_FAILED' },
        );
    }
    return ALLOWED_TOOLS.map((name) => {
        const tool = offered.get(name);
        return {
            name,
            description: tool?.description ?? '',
            inputSchema: tool?.inputSchema ?? {},
        };
    });
}
