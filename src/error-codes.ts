/**
 * The stable error codes of `testpilot generate`.
 *
 * Every failure a run can end in has one code (`UPPER_SNAKE_CASE`), a fixed
 * exit code and a hint: what to do about it. `generate --json` reports the code
 * and hint as `error.code` and `error.hint`; without `--json` the final error
 * line starts with the code and the hint follows on its own line.
 *
 * Exit code `2` is a setup problem, for the developer to fix; `1` is a test
 * case that failed to generate, which may be worth another try or a reworded
 * step.
 */

/** What a code means for the process and for whoever reads the failure. */
export interface ErrorCodeInfo {
    /** The process exit status: `2` for a setup problem, `1` for a failed run. */
    exitCode: 1 | 2;
    /** One or two sentences saying what to do; static text. */
    hint: string;
}

/** Every error code, with its exit code and hint. */
export const ERROR_CODES = {
    INPUT_NOT_FOUND: {
        exitCode: 2,
        hint:
            'Check the path of the markdown file: it must exist, relative to the ' +
            'directory testpilot runs in.',
    },
    CONFIG_INVALID: {
        exitCode: 2,
        hint:
            'The message names the setting and where its value came from (a flag, ' +
            'the environment, a .env file or config.json); fix it there. `testpilot ' +
            'config list` shows every effective setting.',
    },
    API_KEY_IN_CONFIG: {
        exitCode: 2,
        hint:
            'Remove the API key from config.json: the key is only read from the ' +
            'environment. The developer runs `testpilot config set-azure-openai ' +
            '--prompt-api-key` in their own terminal to store it; never type or ' +
            'paste the key on their behalf.',
    },
    LLM_SETTINGS_MISSING: {
        exitCode: 2,
        hint:
            'Run `testpilot config set-azure-openai` with the missing values ' +
            '(`testpilot config list` shows which are unset). If the API key is ' +
            'missing, the developer runs `testpilot config set-azure-openai ' +
            '--prompt-api-key` in their own terminal.',
    },
    LLM_AUTH_FAILED: {
        exitCode: 2,
        hint:
            'The LLM service refused the API key: it is wrong, expired or has no ' +
            'access to the deployment. The developer re-enters it by running ' +
            '`testpilot config set-azure-openai --prompt-api-key` in their own ' +
            'terminal.',
    },
    LLM_NOT_FOUND: {
        exitCode: 2,
        hint:
            'The LLM service does not know the endpoint, deployment or API version. ' +
            'Check the endpoint, deployment name and API version with `testpilot ' +
            'config list`.',
    },
    BROWSER_LAUNCH_FAILED: {
        exitCode: 2,
        hint:
            'Chromium could not be launched, usually because it is not installed. ' +
            'Run `testpilot doctor`: it prints the install command.',
    },
    LOG_DIR_FAILED: {
        exitCode: 2,
        hint:
            'The log folder could not be created. Check the permissions on ' +
            '.testpilot/logs/ and the free disk space.',
    },
    LLM_UNREACHABLE: {
        exitCode: 1,
        hint:
            'The LLM service could not be reached. Check the endpoint with ' +
            '`testpilot config list` and the network connection, then try again.',
    },
    LLM_RATE_LIMITED: {
        exitCode: 1,
        hint:
            'The LLM service is rate limiting the requests, and the retries did not ' +
            'get through. Wait a minute or two and try again.',
    },
    LLM_REQUEST_FAILED: {
        exitCode: 1,
        hint:
            'The LLM service rejected or failed the request; the message carries ' +
            'its reason. If it looks transient, try again.',
    },
    LLM_RESPONSE_INVALID: {
        exitCode: 1,
        hint:
            'The LLM answered with something that is not the expected JSON. This is ' +
            'usually a one-off: try again.',
    },
    BROWSER_AGENT_FAILED: {
        exitCode: 1,
        hint:
            'The browser agent (Playwright MCP) failed to start, to run a tool or ' +
            'to reconnect. Try again; if it repeats, the run log has the MCP error.',
    },
    STEP_OUT_OF_TURNS: {
        exitCode: 1,
        hint:
            'The agent did not finish the step within the turn limit. Split the ' +
            'step into smaller ones, or raise the limit with `--max-turns` (or ' +
            '`maxTurns` in config.json).',
    },
    STEP_ABANDONED: {
        exitCode: 1,
        hint:
            'The agent stopped without finishing the step; the message has its last ' +
            'words, which usually say why. Check the step against the page, and ' +
            'reword it if it is ambiguous.',
    },
    STEP_REPORT_INVALID: {
        exitCode: 1,
        hint:
            'The agent reported the step wrongly: a malformed report, or a ' +
            'statement it never ran. This is usually a one-off: try again.',
    },
    STEP_VALIDATION_FAILED: {
        exitCode: 1,
        hint:
            'The step still failed validation after the run spent its retries; the ' +
            'message has the last failure. Make the step more specific, or check ' +
            'that the page behaves as the step says.',
    },
    NO_STATEMENTS: {
        exitCode: 1,
        hint:
            'No step produced any statement, so there is nothing to assemble into a ' +
            'script. Check that the steps describe actions or checks on the page.',
    },
    SCRIPT_ASSEMBLY_FAILED: {
        exitCode: 1,
        hint:
            'The generated script does not compile, or dropped or altered validated ' +
            'code. This is usually a one-off, so try again; the validated test case ' +
            'JSON was written to `.testpilot/tests/`.',
    },
    INTERNAL_ERROR: {
        exitCode: 1,
        hint:
            'No specific code matched this failure. If the message names a ' +
            'file-system problem (a permission, a full disk), fix that; otherwise ' +
            'it is likely a testpilot bug: report it with the run log.',
    },
} as const satisfies Record<string, ErrorCodeInfo>;

/** The name of an error code, e.g. `STEP_OUT_OF_TURNS`. */
export type ErrorCode = keyof typeof ERROR_CODES;
