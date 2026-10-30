/** Shared application exceptions. */

/** Base exception for all pipeline stage failures. */
export class PipelineError extends Error {
    override name = 'PipelineError';
}

/** Raised when the Structurer cannot produce a valid TestCase. */
export class StructurerError extends PipelineError {
    override name = 'StructurerError';
}

/** Raised when the Playwright MCP server is unreachable or misbehaves. */
export class McpError extends PipelineError {
    override name = 'McpError';
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
