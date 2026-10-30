/** Extractor service: drive each execution step live and collect its code. */

import type { LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import type { Module, StepStatement } from '../model/test-case.ts';
import { StepAgent } from './agent.ts';
import type { McpConnection } from './mcp/server.ts';
import { describeBrowserContext } from './utils.ts';

/** Options for one `Extractor.runStep`. */
export interface RunStepOptions {
    /**
     * Statements already accepted for earlier steps, used to tell the agent
     * what the browser is already showing.
     */
    history: string[];
    /** Why the previous attempt at this step was rejected. */
    feedback?: string;
    /**
     * The URL a freshly reset MCP browser was sent to, when retrying. Earlier
     * steps' state is then gone from it.
     */
    resetTo?: string;
}

/** Performs a module's steps in a live browser, collecting the code. */
export class Extractor {
    private readonly agent: StepAgent;

    /**
     * Initialize with the collaborators the agent loop needs.
     *
     * @param llm - Provides the tool-calling conversation.
     * @param mcp - The live Playwright MCP connection, shared across the run.
     * @param maxTurns - Cap on assistant turns per step.
     */
    constructor(llm: LLMProvider, mcp: McpConnection, maxTurns = 25) {
        this.agent = new StepAgent(llm, mcp, maxTurns);
    }

    /**
     * Perform one execution step and return its collected statements.
     *
     * @param module - The module the step belongs to.
     * @param index - The step's position within `module.execution_steps`.
     * @param options - Earlier statements, and retry feedback and reset URL.
     * @returns The step's statements, in execution order.
     * @throws {ExtractorError} If the step cannot be completed or the model
     *   reports code MCP never ran.
     */
    runStep(
        module: Module,
        index: number,
        { history, feedback, resetTo }: RunStepOptions,
    ): Promise<StepStatement[]> {
        const step = module.execution_steps[index];
        if (step === undefined) {
            throw new RangeError(`Module ${module.url} has no step ${index}`);
        }
        logger.info(
            `Extracting step ${index + 1}/${module.execution_steps.length} of ${module.url}`,
        );
        return this.agent.run(step.step, {
            context: describeBrowserContext(module, history, resetTo),
            feedback,
        });
    }
}
