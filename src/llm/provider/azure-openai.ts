/** Azure OpenAI-backed LLM provider. */

import { AzureOpenAI } from 'openai';

import type { Settings } from '../../config.ts';
import { ConfigurationError } from '../../exceptions.ts';
import { logger } from '../../logger.ts';
import type {
    CompletionRequest,
    ConversationRequest,
    LLMProvider,
} from '../protocol.ts';
import { OpenAIChatConversation } from './openai-chat.ts';

/** LLMProvider implementation backed by Azure OpenAI. */
export class AzureOpenAIProvider implements LLMProvider {
    private readonly client: AzureOpenAI;
    private readonly model: string;

    /**
     * Initialize the Azure OpenAI client from settings.
     *
     * @param settings - Application settings containing Azure OpenAI credentials.
     * @throws {ConfigurationError} If required Azure OpenAI settings are missing.
     */
    constructor(settings: Settings) {
        const {
            AZURE_OPENAI_ENDPOINT: endpoint,
            AZURE_OPENAI_API_KEY: apiKey,
            AZURE_DEPLOYMENT_NAME: deployment,
            AZURE_MODEL_NAME: model,
            OPENAI_API_VERSION: apiVersion,
        } = requireSettings({
            AZURE_OPENAI_ENDPOINT: settings.azureOpenaiEndpoint,
            AZURE_OPENAI_API_KEY: settings.azureOpenaiApiKey,
            AZURE_DEPLOYMENT_NAME: settings.azureDeploymentName,
            AZURE_MODEL_NAME: settings.azureModelName,
            OPENAI_API_VERSION: settings.openaiApiVersion,
        });
        this.client = new AzureOpenAI({ endpoint, deployment, apiKey, apiVersion });
        this.model = model;
        logger.debug(
            `Azure OpenAI client configured (endpoint=${endpoint}, model=${model}, ` +
                `api_version=${apiVersion})`,
        );
    }

    /** Return the model's completion for the given prompt pair. */
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
        return response.choices[0]?.message.content ?? '';
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
 * @throws {ConfigurationError} If any value in `required` is empty.
 */
function requireSettings<K extends string>(
    required: Record<K, string | undefined>,
): Record<K, string> {
    const entries = Object.entries(required) as [K, string | undefined][];
    const missing = entries.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
        throw new ConfigurationError(`Missing required ${missing.join(', ')}`);
    }
    return Object.fromEntries(entries) as Record<K, string>;
}
