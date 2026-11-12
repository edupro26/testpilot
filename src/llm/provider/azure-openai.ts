/** Azure OpenAI-backed LLM provider. */

import { AzureOpenAI } from 'openai';

import type { Settings } from '../../config.ts';
import { logger } from '../../logger.ts';
import { MissingSettingsError, PipelineError } from '../../runtime/exceptions.ts';
import type {
    CompletionRequest,
    ConversationRequest,
    LLMProvider,
} from '../protocol.ts';
import { cutReason, OpenAIChatConversation } from './openai-chat.ts';

// How long one request may take: a whole script from a reasoning model takes
// minutes, but an endpoint that never answers should not hold a run for the
// SDK's default of 10 minutes.
const REQUEST_TIMEOUT_MS = 300_000;

/** LLMProvider implementation backed by Azure OpenAI. */
export class AzureOpenAIProvider implements LLMProvider {
    private readonly client: AzureOpenAI;
    private readonly model: string;

    /**
     * Initialize the Azure OpenAI client from settings.
     *
     * @param settings - Application settings containing Azure OpenAI credentials.
     * @throws {MissingSettingsError} If required Azure OpenAI settings are missing.
     */
    constructor(settings: Settings) {
        const {
            TESTPILOT_AZURE_OPENAI_ENDPOINT: endpoint,
            TESTPILOT_AZURE_OPENAI_API_KEY: apiKey,
            TESTPILOT_AZURE_DEPLOYMENT_NAME: deployment,
            TESTPILOT_AZURE_MODEL_NAME: model,
            TESTPILOT_OPENAI_API_VERSION: apiVersion,
        } = requireSettings({
            TESTPILOT_AZURE_OPENAI_ENDPOINT: settings.azureOpenaiEndpoint,
            TESTPILOT_AZURE_OPENAI_API_KEY: settings.azureOpenaiApiKey,
            TESTPILOT_AZURE_DEPLOYMENT_NAME: settings.azureDeploymentName,
            TESTPILOT_AZURE_MODEL_NAME: settings.azureModelName,
            TESTPILOT_OPENAI_API_VERSION: settings.openaiApiVersion,
        });
        this.client = new AzureOpenAI({
            endpoint,
            deployment,
            apiKey,
            apiVersion,
            // Left out, it is read from OPENAI_BASE_URL, which the SDK refuses
            // alongside an endpoint.
            baseURL: null,
            // RetryingLLMProvider retries transient errors; the SDK's own
            // retries would multiply its attempts.
            maxRetries: 0,
            timeout: REQUEST_TIMEOUT_MS,
        });
        this.model = model;
        logger.debug(
            `Azure OpenAI client configured (endpoint=${endpoint}, model=${model}, ` +
                `api_version=${apiVersion})`,
        );
    }

    /**
     * Return the model's completion for the given prompt pair.
     *
     * @throws {PipelineError} With code LLM_RESPONSE_INVALID, if the model
     *   refused, or the reply was filtered or cut off: what came back is not
     *   the answer asked for.
     */
    async complete({
        systemPrompt,
        userPrompt,
        jsonMode = false,
    }: CompletionRequest): Promise<string> {
        logger.info(
            `Requesting completion from Azure OpenAI (model=${this.model}, ` +
                `json_mode=${jsonMode})`,
        );
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        });
        const choice = response.choices[0];
        const refusal = choice?.message.refusal;
        const unusable = refusal
            ? `refused: ${refusal}`
            : cutReason(choice?.finish_reason);
        if (unusable !== undefined) {
            throw new PipelineError(`The LLM's reply cannot be used: ${unusable}`, {
                code: 'LLM_RESPONSE_INVALID',
            });
        }
        return choice?.message.content ?? '';
    }

    /** Open a tool-calling conversation against Azure OpenAI. */
    startConversation(request: ConversationRequest): OpenAIChatConversation {
        logger.info(
            `Starting Azure OpenAI tool conversation (model=${this.model}, ` +
                `${request.tools.length} tool(s))`,
        );
        return new OpenAIChatConversation(this.client, this.model, request);
    }
}

/**
 * Return `required` with every value present, failing if any is missing.
 *
 * @param required - Mapping of env var name to its resolved value.
 * @returns The same mapping, narrowed to strings.
 * @throws {MissingSettingsError} If any value in `required` is empty.
 */
function requireSettings<K extends string>(
    required: Record<K, string | undefined>,
): Record<K, string> {
    const entries = Object.entries(required) as [K, string | undefined][];
    const missing = entries.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
        throw new MissingSettingsError(`Missing required ${missing.join(', ')}`);
    }
    return Object.fromEntries(entries) as Record<K, string>;
}
