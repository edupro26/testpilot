/** Shared application exceptions. */

import type { ErrorCode } from '../error-codes.ts';

/** Base exception for all pipeline stage failures. */
export class PipelineError extends Error {
    override name = 'PipelineError';

    /** The stable code of this failure; see `ERROR_CODES`. */
    readonly code: ErrorCode;

    /**
     * Initialize with the failure's code.
     *
     * @param message - What went wrong.
     * @param options - The `code` of the failure, and its `cause` if any.
     */
    constructor(message: string, options: ErrorOptions & { code: ErrorCode }) {
        super(message, options);
        this.code = options.code;
    }
}

/** Raised when the Structurer cannot produce a valid TestCase. */
export class StructurerError extends PipelineError {
    override name = 'StructurerError';
}

/** Raised when the Playwright MCP server is unreachable or misbehaves. */
export class McpError extends PipelineError {
    override name = 'McpError';
}

/** Raised when Chromium cannot be launched, e.g. it is not installed. */
export class BrowserLaunchError extends PipelineError {
    override name = 'BrowserLaunchError';
}

/** Raised when the Extractor cannot produce a valid Module. */
export class ExtractorError extends PipelineError {
    override name = 'ExtractorError';
}

/** Raised when the Validator cannot produce a valid ValidationResult. */
export class ValidatorError extends PipelineError {
    override name = 'ValidatorError';
}

/** Raised when the Generator cannot produce a valid test script. */
export class GeneratorError extends PipelineError {
    override name = 'GeneratorError';
}

/** Raised when required application configuration is missing or invalid. */
export class ConfigurationError extends Error {
    override name = 'ConfigurationError';

    /** Where the offending value came from, e.g. `.env.local`; if known. */
    readonly source: string | undefined;

    constructor(message: string, options?: ErrorOptions & { source?: string }) {
        super(message, options);
        this.source = options?.source;
    }
}

/** Raised when `config.json` holds an API key, which is only read from the environment. */
export class ApiKeyInConfigError extends ConfigurationError {
    override name = 'ApiKeyInConfigError';
}

/** Raised when a required Azure OpenAI setting is not set. */
export class MissingSettingsError extends ConfigurationError {
    override name = 'MissingSettingsError';
}

/**
 * The message of `error`, or its string form if it is not an `Error`.
 *
 * @param error - Anything caught in a `catch` clause.
 * @returns A one-line description, for wrapping into another error.
 */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
